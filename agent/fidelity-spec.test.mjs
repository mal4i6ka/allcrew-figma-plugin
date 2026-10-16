import test from 'node:test'
import assert from 'node:assert/strict'
import { sectionLine, specFromBridge, specFromRest, specSection } from './fidelity/spec.mjs'

const rest = (style, extra = {}) => ({
  styles: { text: 'S:1' },
  fills: [{ type: 'SOLID', color: { r: 129 / 255, g: 129 / 255, b: 129 / 255, a: 1 } }],
  boundVariables: { fontFamily: {}, fontSize: {}, lineHeight: {}, fontWeight: {}, fills: [] },
  style: { fontFamily: 'Onest', fontWeight: 600, fontSize: 26, lineHeightPx: 32, letterSpacing: -0.52, ...style },
  ...extra,
})

test('REST: the text style is named from the response map, tracking becomes em, case is spelled out', () => {
  const spec = specFromRest(rest({ textCase: 'UPPER' }), { 'S:1': { name: 'Header/H4' } })
  assert.equal(spec.textStyle, 'Header/H4')
  assert.equal(spec.letterSpacingEm, -0.02)
  assert.equal(spec.textCase, 'UPPERCASE')
  assert.equal(spec.color, '#818181')
  assert.deepEqual(spec.offSystem, [])
})

test('REST: a layer with no text style and nothing bound is called out as off-system', () => {
  const spec = specFromRest(rest({ fontFamily: 'Poppins', letterSpacing: 0 }, { styles: undefined, boundVariables: { fills: [] } }), {})
  assert.equal(spec.textStyle, null)
  assert.equal(spec.letterSpacingEm, 0)
  assert.deepEqual(spec.offSystem, ['no text style', 'typography is not bound to tokens'])
})

test('bridge: token names per property, and the colour mode only when it says something', () => {
  const node = {
    bindings: {
      fills: { token: 'Text/Secondary', collection: 'Variable collection' },
      fontSize: { token: 'font-size/xs', collection: 'Typography' },
    },
    modes: { resolved: [{ collection: 'Typography', mode: 'Mode 1' }, { collection: 'Variable collection', mode: 'Dark' }] },
  }
  assert.deepEqual(specFromBridge(node), { tokens: { color: 'Text/Secondary', fontSize: 'font-size/xs' }, colorMode: 'Dark' })
  node.modes.resolved[1].mode = 'Mode 1'
  assert.equal(specFromBridge(node).colorMode, null)
})

const spec = (textStyle, fontSize, extra = {}) => ({
  textStyle,
  fontFamily: 'Onest',
  fontWeight: 600,
  fontSize,
  lineHeight: fontSize + 6,
  letterSpacing: -0.02 * fontSize,
  letterSpacingEm: -0.02,
  textCase: null,
  color: '#ffffff',
  offSystem: [],
  ...extra,
})
const at = (nodeId, width, text, page = 'Invoice Generator') => ({ nodeId, width, text, page })

test('a style per width becomes one rule, tokens and mode included', () => {
  const specs = {
    a: spec('Header/H5', 21, { tokens: { fontSize: 'font-size/lg', color: 'Text/Primary' }, colorMode: 'Dark' }),
    b: spec('Header/H4', 26, { tokens: { fontSize: 'font-size/xl', color: 'Text/Primary' }, colorMode: 'Dark' }),
  }
  const lines = specSection([at('a', 375, 'Branding'), at('b', 768, 'Branding'), at('b', 1440, 'Branding')], specs, { fileKey: 'K', tokensRead: true }).join('\n')
  assert.match(lines, /\| Header\/H5 \| 375 \| Onest 600 \| 21 \/ 27 \| −0\.02em \(−0\.42px at 21px\) \| #ffffff \(Dark\) \| «Branding» \|/)
  assert.match(lines, /By width: 375px — Header\/H5; 768, 1440px — Header\/H4\./)
  assert.match(lines, /- Header\/H4: `font-size\/xl`, colour `Text\/Primary` \(Dark mode\)/)
})

test('two styles at one width are named with their texts, not folded into a rule', () => {
  const specs = { a: spec('Header/H5', 21), b: spec('Header/H4', 26) }
  const lines = specSection([at('a', 375, 'Branding'), at('b', 375, 'For freelancers')], specs, { fileKey: 'K', tokensRead: true }).join('\n')
  assert.doesNotMatch(lines, /By width/)
  assert.match(lines, /At 375px this selector contains multiple styles: Header\/H5 \(«Branding»\); Header\/H4 \(«For freelancers»\)/)
})

test('off-system layers are listed with a link, and missing tokens are explained rather than omitted', () => {
  const specs = { a: spec(null, 16, { fontFamily: 'Poppins', offSystem: ['no text style'] }) }
  const lines = specSection([at('a', 1440, '£1', 'Business Tariffs')], specs, { fileKey: 'K', tokensRead: false }).join('\n')
  assert.match(lines, /— no style —/)
  assert.match(lines, /«£1» \(Business Tariffs 1440px\): Poppins 16\/22, no text style — https:\/\/www\.figma\.com\/design\/K\/\?node-id=a/)
  assert.match(lines, /Token names and the colour mode were not read/)
})

test('a structure line links the section and tells a section with nothing on the page from changed content', () => {
  const items = [{ text: 'SEPA' }, { text: 'Fedwire' }]
  const section = { id: '4:2', name: 'Fees' }
  assert.match(sectionLine(1440, section, items, 2, 'K'), /1440px «Fees» \(\[design\]\(https:\/\/www\.figma\.com\/design\/K\/\?node-id=4-2\)\): 2 — \*\*none of the section text is present\*\* — «SEPA», «Fedwire»/)
  assert.match(sectionLine(1440, section, items, 9, 'K'), /: 2 — 2 of 9 section texts — /)
  assert.doesNotMatch(sectionLine(1440, section, items, undefined, 'K'), /section/)
})
