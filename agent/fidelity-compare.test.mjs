import test from 'node:test'
import assert from 'node:assert/strict'
import { compare, match, normText } from './fidelity/compare.mjs'

const d = (text, y, style = {}, extra = {}) => ({
  nodeId: `n${y}`,
  text,
  x: 24,
  y,
  w: 300,
  h: style.lineHeight ?? 20,
  section: { id: 's', name: 'Hero' },
  style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: 20, letterSpacing: 0, textAlign: 'LEFT', color: '#1d1d1f', ...style },
  ...extra,
})
const b = (text, y, style = {}, extra = {}) => ({
  text,
  x: 24,
  y,
  w: 300,
  h: style.lineHeight ?? 20,
  selector: 'p.lead',
  style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: 20, letterSpacing: 0, textAlign: 'start', color: 'rgb(29, 29, 31)', ...style },
  ...extra,
})

test('identical text in identical style is clean', () => {
  const r = compare([d('Open an account', 100)], [b('Open an account', 100)])
  assert.deepEqual(r.findings, [])
  assert.equal(r.stats.matched, 1)
})

test('text is joined case-, quote- and space-insensitively', () => {
  assert.equal(normText('It’s  FREE — really'), "it's free - really")
  assert.equal(match([d('GET STARTED', 0)], [b('Get started', 0)]).pairs.length, 1)
})

test('a style difference names the property and both values', () => {
  const r = compare([d('Title', 0, { fontSize: 40, fontWeight: 600, lineHeight: 48 })], [b('Title', 0, { fontSize: 36, fontWeight: 700, lineHeight: 48 })])
  const style = r.findings.find((f) => f.kind === 'style')
  assert.deepEqual(style.props.map((p) => [p.property, p.figma, p.build]), [['font-size', 40, 36], ['font-weight', 600, 700]])
  assert.equal(style.selector, 'p.lead')
})

test('colour compares by value, not by spelling', () => {
  assert.deepEqual(compare([d('x1', 0, { color: '#ffffff' })], [b('x1', 0, { color: 'rgb(255, 255, 255)' })]).findings, [])
  const f = compare([d('x1', 0, { color: '#ffffff' })], [b('x1', 0, { color: 'rgba(255, 255, 255, 0.6)' })]).findings[0]
  assert.equal(f.props[0].property, 'color')
  assert.equal(f.props[0].build, '#ffffff99')
})

test('a mixed-style layer is not judged on its first run\'s weight or colour', () => {
  const r = compare([d('Pay 0% fees', 0, { fontWeight: 700 }, { mixed: true })], [b('Pay 0% fees', 0, { fontWeight: 400 })])
  assert.deepEqual(r.findings, [])
})

test('one section too tall is ONE shift, not a finding for every text below it', () => {
  const design = [d('A heading', 0), d('B text', 100), d('C text', 200), d('D text', 300), d('E text', 400)]
  const build = [b('A heading', 0), b('B text', 100), b('C text', 240), b('D text', 340), b('E text', 440)]
  const shifts = compare(design, build).findings.filter((f) => f.kind === 'shift')
  assert.equal(shifts.length, 1)
  assert.equal(shifts[0].delta, 40)
  assert.equal(shifts[0].text, 'C text')
  assert.equal(shifts[0].after.text, 'B text')
})

test('a repeated label pairs with its own occurrence, by drift', () => {
  const design = [d('Card one', 0), d('Learn more', 50), d('Card two', 500), d('Learn more', 550)]
  const build = [b('Card one', 10), b('Learn more', 60), b('Card two', 510), b('Learn more', 560)]
  const r = compare(design, build)
  assert.equal(r.stats.matched, 4)
  assert.equal(r.findings.filter((f) => f.kind === 'shift').length, 1) // the constant 10px, once, at the top
})

test('text the page does not have is reported missing', () => {
  const r = compare([d('Old headline', 0), d('Body', 50)], [b('Body', 50)])
  assert.deepEqual(r.findings.filter((f) => f.kind === 'missing').map((f) => f.text), ['Old headline'])
})

test('a joined paragraph still matches, but says nothing about placement', () => {
  const r = compare([d('Send money abroad', 0)], [b('Send money abroad today', 0, {}, { x: 80 })])
  assert.equal(r.stats.matched, 1)
  assert.equal(r.findings.filter((f) => f.kind === 'position').length, 0)
})

test('centred text is placed by its centre, and a different wrap is reported', () => {
  const design = [d('Centred', 0, { textAlign: 'CENTER', lineHeight: 20 }, { x: 100, w: 200, h: 40 })]
  const same = [b('Centred', 0, { textAlign: 'center' }, { x: 150, w: 100, h: 40 })]
  assert.equal(compare(design, same).findings.length, 0)
  const wrapped = [b('Centred', 0, { textAlign: 'center' }, { x: 150, w: 100, h: 60 })]
  const wrap = compare(design, wrapped).findings.find((f) => f.kind === 'wrap')
  assert.deepEqual([wrap.figmaLines, wrap.buildLines], [2, 3])
})

test('a short label is only looked for near where it should be', () => {
  // The header's "Open account" must not pair with the footer's, 9,000px down.
  const design = [d('Main heading here', 0), d('Open account', 20), d('Footer columns', 9000)]
  const build = [b('Main heading here', 0), b('Footer columns', 9000), b('Open account', 9050)]
  const r = compare(design, build)
  assert.deepEqual(r.findings.filter((f) => f.kind === 'missing').map((f) => f.text), ['Open account'])
  assert.equal(r.findings.filter((f) => f.kind === 'shift').length, 0)
})

test('an anchor that crosses the others is dropped, not believed', () => {
  // "Totally unique" appears once on each side but far out of order: a coincidence, not a drift.
  const design = [d('First heading', 0), d('Totally unique', 100), d('Second heading', 200), d('Third heading', 300)]
  const build = [b('First heading', 0), b('Second heading', 200), b('Third heading', 300), b('Totally unique', 5000)]
  const shifts = compare(design, build).findings.filter((f) => f.kind === 'shift')
  assert.equal(shifts.length, 0)
})

test('two layers joined into one paragraph both match it', () => {
  const r = compare([d('10,586', 0, {}, { x: 0 }), d('happy companies', 0, {}, { x: 80 }), d('Headline anchor', 100)], [b('10,586 happy companies', 0), b('Headline anchor', 100)])
  assert.equal(r.stats.matched, 3)
  assert.equal(r.findings.filter((f) => f.kind === 'missing').length, 0)
})

test('design text that lands on a picture is reported as drawn into it', () => {
  const media = [{ x: 0, y: 380, w: 600, h: 400, selector: 'picture.hero-card' }]
  const r = compare([d('Headline anchor', 0), d('+9,823.20 EUR', 500, {}, { x: 100 })], [b('Headline anchor', 0)], {}, media)
  const f = r.findings.find((x) => x.kind === 'raster')
  assert.equal(f.text, '+9,823.20 EUR')
  assert.equal(f.selector, 'picture.hero-card')
})

test('text inside a scaled-down illustration is not judged on style', () => {
  const r = compare([d('US Dollar', 0, { fontSize: 12.947697639465332, lineHeight: 14.8 })], [b('US Dollar', 0, { fontSize: 16, lineHeight: 24 }, { h: 15 })])
  assert.equal(r.findings.filter((f) => f.kind === 'style').length, 0)
})

test('tiles stitch into one picture at their offsets, and the PNG round-trips', async () => {
  const { decodePng, encodePng, stitch } = await import('./fidelity/png.mjs')
  const solid = (w, h, rgba) => encodePng({ width: w, height: h, data: Buffer.alloc(w * h * 4).map((_, i) => rgba[i % 4]) })
  const out = decodePng(stitch([{ y: 0, png: solid(2, 3, [255, 0, 0, 255]) }, { y: 2, png: solid(2, 3, [0, 0, 255, 255]) }], 2, 5))
  assert.deepEqual([out.width, out.height], [2, 5])
  const px = (y) => [...out.data.subarray(y * 8, y * 8 + 4)]
  assert.deepEqual(px(0), [255, 0, 0, 255])
  assert.deepEqual(px(1), [255, 0, 0, 255])
  assert.deepEqual(px(2), [0, 0, 255, 255]) // the later tile wins where they overlap
  assert.deepEqual(px(4), [0, 0, 255, 255])
})

test('a short label found inside a longer paragraph is not judged by that paragraph\'s style', () => {
  const r = compare(
    [d('Headline anchor', 0), d('Logo', 100, { fontSize: 14, fontWeight: 500, lineHeight: 20 })],
    [b('Headline anchor', 0), b('Easily input your business information and upload your logo for a branded look.', 100)]
  )
  assert.equal(r.findings.filter((f) => f.kind === 'style').length, 0)
})
