/**
 * The generation judge.
 *
 * Three verdicts, three different bugs, and the tests that keep them apart. `dropped` is the
 * generator's; `diverged` is the mapping's; `missing` is THIS CHANNEL'S — a build reached for a
 * property and the channel could not answer. That last bucket is the reason the op exists:
 * "reveal as much of Figma as possible" is an instinct that cannot be prioritised, and `wanted`
 * turns it into a list ordered by a real screen.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { comparableProperties, judge, type BuiltLayer } from './audit.ts'
import type { IrAppearance } from './appearance.ts'
import type { IrNode } from '../targets/django/ir.ts'

/* --------------------------------------------------------------- fixtures */

interface NodeOptions {
  id: string
  name?: string
  appearance?: IrAppearance
  gap?: number
  padding?: { top: number; right: number; bottom: number; left: number }
  width?: number
  characters?: string
  children?: IrNode[]
}

function node(options: NodeOptions): IrNode {
  const flex = options.gap !== undefined || options.padding !== undefined
  return {
    type: options.characters !== undefined ? 'text' : 'container',
    id: options.id,
    name: options.name ?? options.id,
    position: { x: 0, y: 0 },
    sizing: {
      width: options.width === undefined ? { mode: 'hug' } : { mode: 'fixed', value: options.width },
      height: { mode: 'hug' },
    },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    ...(flex
      ? {
          layout: {
            kind: 'flex',
            direction: 'row',
            wrap: false,
            gap: options.gap ?? 0,
            justifyContent: 'flex-start',
            alignItems: 'flex-start',
            padding: options.padding ?? { top: 0, right: 0, bottom: 0, left: 0 },
          },
        }
      : { layout: { kind: 'absolute' } }),
    component: null,
    children: options.children ?? [],
    ...(options.characters !== undefined ? { characters: options.characters } : {}),
    ...(options.appearance ? { appearance: options.appearance } : {}),
  } as unknown as IrNode
}

const paint = (color: string, bound?: string) => ({
  type: 'SOLID',
  index: 0,
  color,
  bound: bound ?? null,
})

const built = (nodeId: string, properties: Record<string, string | number | null>): BuiltLayer => ({
  nodeId,
  properties,
})

/* ---------------------------------------------------------------- matching */

test('a build that named the TOKEN matches — and that is the better answer, not an equivalent one', () => {
  const tree = node({ id: '1:1', appearance: { fills: [paint('#112233', 'colors/text/primary')] } })
  const report = judge(tree, [built('1:1', { fill: 'colors/text/primary' })])
  assert.equal(report.counts.matched, 1)
  assert.deepEqual(report.findings, [])
})

test('a build that used the literal matches too, whatever the hex casing', () => {
  const tree = node({ id: '1:1', appearance: { fills: [paint('#112233', 'colors/text/primary')] } })
  assert.equal(judge(tree, [built('1:1', { fill: '#112233' })]).counts.matched, 1)
  assert.equal(judge(tree, [built('1:1', { fill: '112233ff' })]).counts.matched, 1)
})

test('a rounded length still matches — Figma stores floats and generators round', () => {
  const tree = node({ id: '1:1', gap: 15.999999 })
  assert.equal(judge(tree, [built('1:1', { gap: 16 })]).counts.matched, 1)
})

test('a length with a unit suffix matches the number underneath it', () => {
  const tree = node({ id: '1:1', gap: 16 })
  assert.equal(judge(tree, [built('1:1', { gap: '16dp' })]).counts.matched, 1)
  assert.equal(judge(tree, [built('1:1', { gap: '16.0pt' })]).counts.matched, 1)
})

/* ---------------------------------------------------------------- dropped */

test('a design value the build emitted nothing for is DROPPED, not missing', () => {
  const tree = node({ id: '1:1', appearance: { fills: [paint('#FF0000', 'colors/danger')] } })
  const report = judge(tree, [built('1:1', { fill: null })])
  assert.equal(report.counts.dropped, 1)
  assert.equal(report.findings[0].verdict, 'dropped')
  // The design side is reported so the fix is obvious; the built side is absent because there
  // was nothing built.
  assert.equal(report.findings[0].design?.token, 'colors/danger')
  assert.equal(report.findings[0].built, undefined)
  // `dropped` is the generator's bug, so it must NOT land in the channel's wanted list.
  assert.deepEqual(report.wanted, [])
})

/* --------------------------------------------------------------- diverged */

test('a disagreement on the value is DIVERGED and shows both sides', () => {
  const tree = node({ id: '1:1', name: 'Card', appearance: { radius: { value: 8 } } })
  const report = judge(tree, [built('1:1', { radius: 12 })])
  assert.equal(report.counts.diverged, 1)
  const finding = report.findings[0]
  assert.equal(finding.verdict, 'diverged')
  assert.equal(finding.name, 'Card')
  assert.equal(finding.design?.value, 8)
  assert.equal(finding.built, 12)
})

test('a 2x artboard does NOT make every length diverge', () => {
  /* The whole reason the unit profile feeds this: on a 750px iPhone artboard every honest pt
   * value is half the Figma number. Without the scale the judge would report a perfect build as
   * wrong in every single length, which is worse than no judge at all. */
  const tree = node({ id: '1:1', gap: 32, appearance: { radius: { value: 16 } } })
  const honest = judge(tree, [built('1:1', { gap: 16, radius: 8 })], { scale: 2 })
  assert.equal(honest.counts.matched, 2)
  assert.equal(honest.counts.diverged, 0)
  assert.equal(honest.scale, 2)

  // And a build that DID emit the raw Figma numbers on a 2× artboard is correctly caught.
  const doubled = judge(tree, [built('1:1', { gap: 32, radius: 16 })], { scale: 2 })
  assert.equal(doubled.counts.diverged, 2)
  assert.match(doubled.findings[0].note ?? '', /the artboard is 2×/)
})

test('a token name that is not this token is a divergence, not a match', () => {
  const tree = node({ id: '1:1', appearance: { fills: [paint('#112233', 'colors/text/primary')] } })
  const report = judge(tree, [built('1:1', { fill: 'colors/text/muted' })])
  assert.equal(report.counts.diverged, 1)
})

/* ---------------------------------------------------------------- missing */

test('a property the build needed and the channel cannot answer is MISSING, and lands in wanted', () => {
  // No appearance on the layer at all: exactly what `design.ir` without `appearance: true`
  // hands over, and exactly the gap this whole change closes.
  const tree = node({ id: '1:1', children: [node({ id: '1:2' })] })
  const report = judge(tree, [
    built('1:1', { fill: '#112233', radius: 8 }),
    built('1:2', { fill: '#000000' }),
  ])
  assert.equal(report.counts.missing, 3)
  assert.equal(report.counts.diverged, 0)
  // Ordered most-reached-for first: this is the list that decides what the IR carries next.
  assert.deepEqual(report.wanted, [
    { property: 'fill', layers: 2 },
    { property: 'radius', layers: 1 },
  ])
  // And it says WHY, so the answer is actionable rather than just a complaint.
  assert.match(report.findings[0].note ?? '', /appearance: true/)
})

test('missing is per LAYER, not per claim — one property wanted twice on one layer counts once', () => {
  const tree = node({ id: '1:1' })
  const report = judge(tree, [built('1:1', { fill: '#111' }), built('1:1', { fill: '#222' })])
  assert.deepEqual(report.wanted, [{ property: 'fill', layers: 1 }])
})

/* ---------------------------------------------------------------- unknown */

test('a property this channel does not describe is UNKNOWN, never a silent pass', () => {
  const tree = node({ id: '1:1', appearance: { fills: [paint('#112233')] } })
  const report = judge(tree, [built('1:1', { boxShadowSpread: 4 })])
  assert.equal(report.counts.unknown, 1)
  assert.equal(report.counts.matched, 0)
  // Counting it as a pass would let a whole vocabulary go unchecked behind a clean report.
  assert.match(report.findings[0].note ?? '', /not a property this channel describes/)
  // It is not the channel's gap either: nothing was asked for that the channel claims to hold.
  assert.deepEqual(report.wanted, [])
})

test('a layer the tree does not contain is reported once, not judged property by property', () => {
  const tree = node({ id: '1:1' })
  const report = judge(tree, [built('9:9', { fill: '#000', radius: 4, gap: 8 })])
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].property, '*')
  assert.equal(report.findings[0].verdict, 'unknown')
  assert.deepEqual(report.layers, { claimed: 1, matched: 0, unmatched: 1 })
})

/* ------------------------------------------------------------ the vocabulary */

test('intrinsic sizing is an answer, and comparing it to a pixel count would be wrong', () => {
  // A layer that HUGS has no width number. A build that emitted `hug` is correct; one that
  // emitted 200 is not, and both used to be indistinguishable.
  const hugging = node({ id: '1:1' })
  assert.equal(judge(hugging, [built('1:1', { width: 'hug' })]).counts.matched, 1)
  assert.equal(judge(hugging, [built('1:1', { width: 200 })]).counts.diverged, 1)

  const fixed = node({ id: '1:1', width: 200 })
  assert.equal(judge(fixed, [built('1:1', { width: 200 })]).counts.matched, 1)
})

test('a line height keeps Figma’s own unit, so a ratio and a length stay distinguishable', () => {
  /* `150%` and `24px` are different instructions, and flattening both to a number is what puts
   * Android font metrics in `dp`. */
  const ratio = node({
    id: '1:1',
    characters: 'hi',
    appearance: { typography: { family: 'Inter', face: 'Regular', size: 16, lineHeight: '150%', letterSpacing: '0' } },
  })
  assert.equal(judge(ratio, [built('1:1', { lineHeight: '150%' })]).counts.matched, 1)
  assert.equal(judge(ratio, [built('1:1', { lineHeight: '24px' })]).counts.diverged, 1)
})

test('per-corner radii are reported as mixed rather than collapsed to one of them', () => {
  const tree = node({
    id: '1:1',
    appearance: {
      radius: {
        topLeft: { value: 8 },
        topRight: { value: 8 },
        bottomRight: { value: 0 },
        bottomLeft: { value: 0 },
      },
    },
  })
  // Answering "8" here would tell a build its uniform 8px radius was right when the design has
  // two square corners.
  const report = judge(tree, [built('1:1', { radius: 8 })])
  assert.equal(report.counts.diverged, 1)
  assert.equal(report.findings[0].design?.value, 'mixed')
})

test('the effect stack is compared by count — one shadow where the design has three is a divergence', () => {
  const tree = node({ id: '1:1', appearance: { effects: [{}, {}, {}] } })
  assert.equal(judge(tree, [built('1:1', { effects: 3 })]).counts.matched, 1)
  assert.equal(judge(tree, [built('1:1', { effects: 1 })]).counts.diverged, 1)
})

test('only narrows the judgement so a colour-only build is not told it dropped the type scale', () => {
  const tree = node({
    id: '1:1',
    characters: 'hi',
    appearance: {
      fills: [paint('#112233')],
      typography: { family: 'Inter', face: 'Regular', size: 16, lineHeight: 'auto', letterSpacing: '0' },
    },
  })
  const everything = judge(tree, [built('1:1', { fill: '#112233', fontSize: null })])
  assert.equal(everything.counts.dropped, 1)

  const narrowed = judge(tree, [built('1:1', { fill: '#112233', fontSize: null })], { only: ['fill'] })
  assert.equal(narrowed.counts.dropped, 0)
  assert.equal(narrowed.counts.matched, 1)
})

test('the layout token is a match for the layout number it names', () => {
  const tree = node({ id: '1:1', gap: 16, appearance: { layoutTokens: { itemSpacing: 'spacing/md' } } })
  assert.equal(judge(tree, [built('1:1', { gap: 'spacing/md' })]).counts.matched, 1)
  // The literal still matches: a build without token support is not wrong, just less portable.
  assert.equal(judge(tree, [built('1:1', { gap: 16 })]).counts.matched, 1)
})

test('the vocabulary is published, so a pile of unknowns is answerable', () => {
  const vocabulary = comparableProperties()
  for (const property of ['fill', 'radius', 'gap', 'paddingLeft', 'fontSize', 'lineHeight', 'width', 'text']) {
    assert.ok(vocabulary.includes(property), `${property} should be comparable`)
  }
})

test('a clean run lists nothing at all', () => {
  const tree = node({
    id: '1:1',
    gap: 16,
    padding: { top: 8, right: 8, bottom: 8, left: 8 },
    appearance: { fills: [paint('#112233', 'colors/surface')], radius: { token: 'radius/md', value: 12 } },
  })
  const report = judge(tree, [
    built('1:1', { fill: 'colors/surface', radius: 'radius/md', gap: 16, paddingLeft: 8, direction: 'row' }),
  ])
  assert.deepEqual(report.findings, [], 'a clean report is an empty list, not a wall of agreement')
  assert.equal(report.counts.matched, 5)
})

test('the text properties the judge asked for are now answerable, defaults included', () => {
  /* Auditing a real screen returned `unknown` for `textTruncation` while `IrTextNode` was
   * carrying `truncate`, `textAlign` and `noWrap` all along. This is the `wanted`/`unknown` loop
   * working on its own author: a build reached for something the tree held and the vocabulary
   * did not expose. */
  const plain = node({ id: '1:1', characters: 'Hello' })
  // The IR records only a NON-default alignment, so absent means left — an answer, not a gap.
  assert.equal(judge(plain, [built('1:1', { textAlign: 'left' })]).counts.matched, 1)
  assert.equal(judge(plain, [built('1:1', { textAlign: 'center' })]).counts.diverged, 1)
  // Three states, not two: no truncation, truncation with a cap, truncation without one.
  assert.equal(judge(plain, [built('1:1', { maxLines: 'none' })]).counts.matched, 1)
  assert.equal(judge(plain, [built('1:1', { noWrap: false })]).counts.matched, 1)

  const clamped = { ...(plain as unknown as Record<string, unknown>), truncate: { maxLines: 2 }, noWrap: true } as unknown as IrNode
  assert.equal(judge(clamped, [built('1:1', { maxLines: 2 })]).counts.matched, 1)
  assert.equal(judge(clamped, [built('1:1', { maxLines: 'none' })]).counts.diverged, 1)
  assert.equal(judge(clamped, [built('1:1', { noWrap: true })]).counts.matched, 1)

  const unbounded = { ...(plain as unknown as Record<string, unknown>), truncate: { maxLines: null } } as unknown as IrNode
  // "truncates, no line cap" is not the same instruction as "clamp to 1 line".
  assert.equal(judge(unbounded, [built('1:1', { maxLines: 'unbounded' })]).counts.matched, 1)
  assert.equal(judge(unbounded, [built('1:1', { maxLines: 1 })]).counts.diverged, 1)

  // And a container has no text answers at all — asking is a real gap, not a false default.
  const box = node({ id: '2:1' })
  assert.equal(judge(box, [built('2:1', { textAlign: 'left' })]).counts.missing, 1)
})
