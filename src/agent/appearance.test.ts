/**
 * The appearance annotation: what a layer looks like, token first.
 *
 * The defect this closes is not subtle. `design.ir` is the op the `mobile.app` playbook tells an
 * agent to build a screen from, and until now every node in that tree had structure and no
 * colour — the CSS emitter reads paint off the live node, which a SwiftUI build running after the
 * plugin closed cannot do. These tests pin the contract a native generator relies on: a token
 * where the design system has one, a literal where it does not, and silence where Figma says
 * nothing rather than a default that looks like a decision.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateAppearance, appearanceOf, type AppearanceSource } from './appearance.ts'
import type { IrNode } from '../targets/django/ir.ts'

const solid = (hex: string, boundId?: string) => ({
  type: 'SOLID',
  visible: true,
  opacity: 1,
  blendMode: 'NORMAL',
  color: {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  },
  ...(boundId ? { boundVariables: { color: { id: boundId } } } : {}),
})

/** The tokens this fixture file has names for. Anything else resolves to null, which is what a
 * deleted or unreachable variable does. */
const NAMES: Record<string, string> = {
  'v:ink': 'colors/text/primary',
  'v:radius': 'radius/md',
  'v:gap': 'spacing/md',
  'v:weight': 'border/hairline',
  'v:fade': 'opacity/muted',
}
const resolve = async (id: string) => NAMES[id] ?? null

/* -------------------------------------------------------------------- paint */

test('a fill reports the token that produced it, not just the hex', async () => {
  const got = await appearanceOf({ fills: [solid('#112233', 'v:ink')] }, resolve)
  assert.equal(got?.fills?.length, 1)
  assert.equal(got?.fills?.[0].color, '#112233')
  // The whole point: a generator emits `Tokens.colorsTextPrimary`, not `Color(0xFF112233)`.
  assert.equal(got?.fills?.[0].bound, 'colors/text/primary')
})

test('an unbound fill says so instead of pretending to be tokenised', async () => {
  const got = await appearanceOf({ fills: [solid('#FF0000')] }, resolve)
  assert.equal(got?.fills?.[0].bound, null)
})

test('the whole fill stack survives, in order', async () => {
  // A layer painted with three fills is a stack; keeping only the top one is a different picture.
  const got = await appearanceOf(
    { fills: [solid('#000000'), { ...solid('#FFFFFF'), opacity: 0.1 }, solid('#FF0000')] },
    resolve
  )
  assert.equal(got?.fills?.length, 3)
  assert.deepEqual(
    got?.fills?.map((paint) => paint.index),
    [0, 1, 2]
  )
  assert.equal(got?.fills?.[1].opacity, 0.1)
})

/* ------------------------------------------------------------------ corners */

test('a uniform radius collapses to one value and keeps its token', async () => {
  const got = await appearanceOf(
    {
      cornerRadius: 8,
      topLeftRadius: 8,
      topRightRadius: 8,
      bottomRightRadius: 8,
      bottomLeftRadius: 8,
      boundVariables: {
        topLeftRadius: { id: 'v:radius' },
        topRightRadius: { id: 'v:radius' },
        bottomRightRadius: { id: 'v:radius' },
        bottomLeftRadius: { id: 'v:radius' },
      },
    },
    resolve
  )
  assert.deepEqual(got?.radius, { token: 'radius/md', value: 8 })
})

test('a radius bound on one corner only does NOT collapse', async () => {
  // Collapsing would claim three corners are bound to `radius/md` when they are literals, and a
  // generator that then renamed the token would silently change three corners it never touched.
  const got = await appearanceOf(
    {
      topLeftRadius: 8,
      topRightRadius: 8,
      bottomRightRadius: 8,
      bottomLeftRadius: 8,
      boundVariables: { topLeftRadius: { id: 'v:radius' } },
    },
    resolve
  )
  assert.deepEqual(got?.radius, {
    topLeft: { token: 'radius/md', value: 8 },
    topRight: { value: 8 },
    bottomRight: { value: 8 },
    bottomLeft: { value: 8 },
  })
})

test('differing corners are reported per corner', async () => {
  const got = await appearanceOf(
    { topLeftRadius: 12, topRightRadius: 12, bottomRightRadius: 0, bottomLeftRadius: 0 },
    resolve
  )
  assert.deepEqual(got?.radius, {
    topLeft: { value: 12 },
    topRight: { value: 12 },
    bottomRight: { value: 0 },
    bottomLeft: { value: 0 },
  })
})

test('a square unbound corner is not reported at all', async () => {
  const got = await appearanceOf({ fills: [solid('#000000')], cornerRadius: 0 }, resolve)
  assert.equal(got?.radius, undefined)
})

/* ------------------------------------------------------------------ strokes */

test('stroke geometry rides along only when there is a stroke', async () => {
  const withStroke = await appearanceOf(
    {
      strokes: [solid('#CCCCCC')],
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      dashPattern: [4, 2],
      boundVariables: { strokeWeight: { id: 'v:weight' } },
    },
    resolve
  )
  assert.deepEqual(withStroke?.strokeWeight, { token: 'border/hairline', value: 1 })
  assert.equal(withStroke?.strokeAlign, 'INSIDE')
  assert.deepEqual(withStroke?.dashPattern, [4, 2])

  // A layer with no stroke has no stroke geometry, whatever Figma still holds in those fields.
  const noStroke = await appearanceOf(
    { fills: [solid('#000000')], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE' },
    resolve
  )
  assert.equal(noStroke?.strokeWeight, undefined)
  assert.equal(noStroke?.strokeAlign, undefined)
})

/* ------------------------------------------------- defaults stay unreported */

test('default opacity, blend mode and rotation say nothing', async () => {
  const got = await appearanceOf(
    { fills: [solid('#000000')], opacity: 1, blendMode: 'NORMAL', rotation: 0 },
    resolve
  )
  assert.equal(got?.opacity, undefined)
  assert.equal(got?.blendMode, undefined)
  assert.equal(got?.rotation, undefined)
})

test('PASS_THROUGH is the NODE default and is not a decision either', async () => {
  /* Caught on a real 1465-layer screen: checking only `NORMAL` put `blendMode: "PASS_THROUGH"`
   * on all 752 annotated layers — 752 fields claiming a choice nobody made, and a reader having
   * to learn which value to ignore. A paint defaults to `NORMAL`, a node to `PASS_THROUGH`, and
   * both have to count as silence. */
  const got = await appearanceOf({ fills: [solid('#000000')], blendMode: 'PASS_THROUGH' }, resolve)
  assert.equal(got?.blendMode, undefined)
  // A real blend mode still comes through.
  const multiply = await appearanceOf({ fills: [solid('#000000')], blendMode: 'MULTIPLY' }, resolve)
  assert.equal(multiply?.blendMode, 'MULTIPLY')
})
test('a non-default opacity, blend mode and rotation are all reported', async () => {
  const got = await appearanceOf(
    { opacity: 0.5, blendMode: 'MULTIPLY', rotation: -90, boundVariables: { opacity: { id: 'v:fade' } } },
    resolve
  )
  assert.deepEqual(got?.opacity, { token: 'opacity/muted', value: 0.5 })
  assert.equal(got?.blendMode, 'MULTIPLY')
  assert.equal(got?.rotation, -90)
})

test('an opacity of 1 that is BOUND is still reported', async () => {
  // The value is the default; the binding is not. A build that drops this loses the token.
  const got = await appearanceOf({ opacity: 1, boundVariables: { opacity: { id: 'v:fade' } } }, resolve)
  assert.deepEqual(got?.opacity, { token: 'opacity/muted', value: 1 })
})

test('a layer with nothing to say gets no appearance at all', async () => {
  // A plain GROUP. An empty object here would read as "described, and it is default", which is a
  // different claim from "there was nothing to describe".
  assert.equal(await appearanceOf({ opacity: 1, blendMode: 'NORMAL', rotation: 0 }, resolve), undefined)
})

test('a token that no longer resolves leaves the literal alone rather than inventing a name', async () => {
  const got = await appearanceOf(
    { topLeftRadius: 4, topRightRadius: 4, bottomRightRadius: 4, bottomLeftRadius: 4, boundVariables: { topLeftRadius: { id: 'v:deleted' } } },
    resolve
  )
  assert.deepEqual(got?.radius, { value: 4 })
})

/* ------------------------------------------------------------ layout tokens */

test('the tokens on layout numbers are reported by Figma field name', async () => {
  const got = await appearanceOf(
    {
      fills: [solid('#000000')],
      boundVariables: { itemSpacing: { id: 'v:gap' }, paddingLeft: { id: 'v:gap' } },
    },
    resolve
  )
  // Figma's own field names, not CSS property names: `gap` and `padding-left` mean nothing to
  // Compose, and these are the keys `node.bind` writes back through.
  assert.deepEqual(got?.layoutTokens, { itemSpacing: 'spacing/md', paddingLeft: 'spacing/md' })
})

/* -------------------------------------------------------------------- pass */

const irNode = (id: string, children: IrNode[] = []): IrNode =>
  ({
    type: 'container',
    id,
    name: id,
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' }, height: { mode: 'hug' } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    layout: { kind: 'absolute' },
    component: null,
    children,
  }) as unknown as IrNode

test('the pass annotates the tree in place and counts what it could not reach', async () => {
  const tree = irNode('1:1', [irNode('1:2'), irNode('1:3')])
  const sources = new Map<string, AppearanceSource>([
    ['1:1', { fills: [solid('#112233', 'v:ink')] }],
    ['1:2', { fills: [solid('#FF0000')] }],
    // `1:3` is absent: an export-flattened subtree has no single layer behind it.
  ])

  const report = await annotateAppearance([tree], sources, resolve)
  assert.deepEqual(report, { annotated: 2, unmatched: 1 })

  const root = tree as IrNode & { children: Array<IrNode & { appearance?: unknown }> }
  assert.equal((root as { appearance?: { fills?: Array<{ bound?: string | null }> } }).appearance?.fills?.[0].bound, 'colors/text/primary')
  assert.equal(root.children[0].appearance !== undefined, true)
  // Never invented: claiming default paint for a layer that is not there is a plausible wrong
  // answer, which is worse than a named gap.
  assert.equal(root.children[1].appearance, undefined)
})
