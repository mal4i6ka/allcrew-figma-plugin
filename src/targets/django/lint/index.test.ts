import test from 'node:test'
import assert from 'node:assert/strict'
import { lintScope, lintScopeAsync, type LintFinding } from './index.ts'

function frame(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'frame-1',
    name: 'Frame',
    type: 'FRAME',
    layoutMode: 'NONE',
    fills: [],
    children: [],
    ...overrides,
  }
}

function text(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'text-1',
    name: 'Text',
    type: 'TEXT',
    textStyleId: 'style-1',
    fills: [],
    ...overrides,
  }
}

function findingsFor(findings: LintFinding[], rule: string): LintFinding[] {
  return findings.filter((f) => f.rule === rule)
}

test('lintScope flags a frame with no Auto Layout', () => {
  const findings = lintScope([frame()])
  assert.equal(findingsFor(findings, 'missing-auto-layout').length, 1)
})

test('lintScope does not flag a frame with Auto Layout', () => {
  const findings = lintScope([frame({ layoutMode: 'HORIZONTAL' })])
  assert.equal(findingsFor(findings, 'missing-auto-layout').length, 0)
})

test('lintScope flags a solid fill with no bound variable', () => {
  const node = frame({ fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] })
  const findings = lintScope([node])
  assert.equal(findingsFor(findings, 'unbound-fill').length, 1)
})

test('lintScope reports the colour of the offending fill, not just that it is unbound', () => {
  const node = frame({ fills: [{ type: 'SOLID', color: { r: 1, g: 0.357, b: 0.039 } }] })
  const [finding] = findingsFor(lintScope([node]), 'unbound-fill')
  // The whole point of carrying it: a fixer can pick a token from this without re-reading the
  // node, which `node.get` would not answer anyway — it reports bindings, not raw paints.
  assert.equal(finding.value, '#ff5b0a')
  assert.equal(finding.paintIndex, 0)
  assert.equal(finding.alpha, undefined)
})

test('lintScope names which paint in the stack is unbound', () => {
  // First paint is bound, second is not: the index has to point at the second, because that is
  // the argument `node.bind` takes to narrow the fix to one paint.
  const node = frame({
    fills: [
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
      { type: 'SOLID', color: { r: 1, g: 1, b: 1 } },
    ],
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1' }] },
  })
  const [finding] = findingsFor(lintScope([node]), 'unbound-fill')
  assert.equal(finding.paintIndex, 1)
  assert.equal(finding.value, '#ffffff')
})

test('lintScope carries paint alpha only when it is not opaque', () => {
  const node = frame({ fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }] })
  const [finding] = findingsFor(lintScope([node]), 'unbound-fill')
  assert.equal(finding.alpha, 0.5)
  assert.equal(finding.value, '#000000')
})

test('lintScope reports the colour of an unbound stroke too', () => {
  const node = frame({
    layoutMode: 'HORIZONTAL',
    strokes: [{ type: 'SOLID', color: { r: 0.098, g: 0.098, b: 0.098 } }],
  })
  const [finding] = findingsFor(lintScope([node]), 'unbound-stroke')
  assert.equal(finding.value, '#191919')
  assert.equal(finding.paintIndex, 0)
})

test('lintScope does not flag a solid fill bound to a variable', () => {
  const node = frame({
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1' }] },
  })
  const findings = lintScope([node])
  assert.equal(findingsFor(findings, 'unbound-fill').length, 0)
})

test('lintScope ignores invisible fills', () => {
  const node = frame({ fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, visible: false }] })
  const findings = lintScope([node])
  assert.equal(findingsFor(findings, 'unbound-fill').length, 0)
})

test('lintScope does not flag a fill bound at the paint level (instance sublayer view)', () => {
  const node = frame({
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } } }],
  })
  const findings = lintScope([node])
  assert.equal(findingsFor(findings, 'unbound-fill').length, 0)
})

test('lintScope does not flag fills or strokes that come from a paint style', () => {
  const styledFill = frame({ fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], fillStyleId: 'S:paint1' })
  const styledStroke = frame({ strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeStyleId: 'S:paint2' })
  assert.equal(findingsFor(lintScope([styledFill]), 'unbound-fill').length, 0)
  assert.equal(findingsFor(lintScope([styledStroke]), 'unbound-stroke').length, 0)
})

test('lintScope flags a solid stroke with no bound variable', () => {
  const node = frame({ strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] })
  const findings = lintScope([node])
  assert.equal(findingsFor(findings, 'unbound-stroke').length, 1)
})

test('lintScope does not flag bound or invisible strokes', () => {
  const bound = frame({
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1' }] },
  })
  const invisible = frame({ strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false }] })
  assert.equal(findingsFor(lintScope([bound]), 'unbound-stroke').length, 0)
  assert.equal(findingsFor(lintScope([invisible]), 'unbound-stroke').length, 0)
})

test('lintScope flags a text node with no text style', () => {
  const findings = lintScope([text({ textStyleId: '' })])
  assert.equal(findingsFor(findings, 'text-without-style').length, 1)
})

test('lintScope does not flag a text node with a text style', () => {
  const findings = lintScope([text({ textStyleId: 'style-1' })])
  assert.equal(findingsFor(findings, 'text-without-style').length, 0)
})

test('lintScope flags nodes nested past the depth threshold', () => {
  let leaf: any = frame({ id: 'leaf', layoutMode: 'HORIZONTAL' })
  for (let i = 0; i < 10; i++) {
    leaf = frame({ id: `wrapper-${i}`, layoutMode: 'HORIZONTAL', children: [leaf] })
  }
  const findings = lintScope([leaf])
  assert.ok(findingsFor(findings, 'excessive-nesting').length > 0)
})

test('lintScope measures nesting per template — depth resets inside an instance (it exports as an include)', () => {
  // 3 wrapper frames inside a Card instance that itself sits 8 levels deep in the page tree.
  // Straight-through that leaf is at depth ~11; per-template it's only ~3, so it must NOT be flagged.
  let inner: any = frame({ id: 'inner-leaf', layoutMode: 'HORIZONTAL' })
  for (let i = 0; i < 3; i++) inner = frame({ id: `inner-${i}`, layoutMode: 'HORIZONTAL', children: [inner] })
  const card = { ...frame({ id: 'card', layoutMode: 'HORIZONTAL', children: [inner] }), type: 'INSTANCE' }
  let page: any = card
  for (let i = 0; i < 8; i++) page = frame({ id: `page-${i}`, layoutMode: 'HORIZONTAL', children: [page] })

  const findings = lintScope([page])
  assert.equal(findingsFor(findings, 'excessive-nesting').length, 0)
})

test('lintScope still flags genuinely deep nesting within a single template file', () => {
  let leaf: any = frame({ id: 'leaf', layoutMode: 'HORIZONTAL' })
  for (let i = 0; i < 10; i++) leaf = frame({ id: `plain-${i}`, layoutMode: 'HORIZONTAL', children: [leaf] })

  const findings = lintScope([leaf])
  assert.ok(findingsFor(findings, 'excessive-nesting').length > 0)
})

test('lintScope walks descendants and reports their own ids', () => {
  const child = text({ id: 'child-text', textStyleId: '' })
  const root = frame({ id: 'root', layoutMode: 'HORIZONTAL', children: [child] })
  const findings = lintScope([root])
  assert.deepEqual(
    findingsFor(findings, 'text-without-style').map((f) => f.nodeId),
    ['child-text']
  )
})

test('lintScope returns no findings for a clean tree', () => {
  const child = text({ id: 'child-text', textStyleId: 'style-1' })
  const root = frame({ id: 'root', layoutMode: 'VERTICAL', children: [child] })
  assert.deepEqual(lintScope([root]), [])
})

test('lintScope skips a node marked for export and its whole subtree', () => {
  // Would normally trip missing-auto-layout + unbound-fill (self) and text-without-style (child).
  const dirtyChild = text({ id: 'graphic-child', textStyleId: '' })
  const graphic = frame({
    id: 'graphic',
    layoutMode: 'NONE',
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    exportSettings: [{ format: 'SVG' }],
    children: [dirtyChild],
  })
  assert.deepEqual(lintScope([graphic]), [])
})

test('lintScopeAsync skips instances of export-marked components (icons/flags)', async () => {
  const artwork = frame({ id: 'flag-art', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] })
  const icon: any = {
    id: 'inst-1',
    name: 'Flag/DE',
    type: 'INSTANCE',
    fills: [],
    children: [artwork],
    async getMainComponentAsync() {
      return { id: 'main-1', exportSettings: [{ format: 'SVG' }] }
    },
  }
  assert.deepEqual(await lintScopeAsync([icon]), [])
})

test('lintScopeAsync still lints instances whose main component has no export settings', async () => {
  const artwork = frame({ id: 'v1', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] })
  const card: any = {
    id: 'inst-2',
    name: 'Card',
    type: 'INSTANCE',
    fills: [],
    children: [artwork],
    async getMainComponentAsync() {
      return { id: 'main-2', exportSettings: [] }
    },
  }
  const findings = await lintScopeAsync([card])
  assert.ok(findings.some((f) => f.rule === 'unbound-fill'), 'artwork inside a regular component is still linted')
})

test('lintScopeAsync also skips export-marked graphics', async () => {
  const dirtyChild = text({ id: 'graphic-child', textStyleId: '' })
  const graphic = frame({ id: 'graphic', exportSettings: [{ format: 'PNG' }], children: [dirtyChild] })
  assert.deepEqual(await lintScopeAsync([graphic]), [])
})

/* ------------------------------------------------- 3D transforms (typings 1.143.0, beta) */

const scene = (overrides: Record<string, unknown> = {}) =>
  frame({ layoutMode: 'HORIZONTAL', scene3d: { perspective: 800, preserve3d: true }, opacity: 1, blendMode: 'PASS_THROUGH', effects: [], clipsContent: false, ...overrides })

test('a preserve3d container with nothing dead on it is not flagged', () => {
  assert.equal(findingsFor(lintScope([scene()]), 'preserve3d-dead-property').length, 0)
  // NORMAL is what any layer has; it is not a blend someone chose.
  assert.equal(findingsFor(lintScope([scene({ blendMode: 'NORMAL' })]), 'preserve3d-dead-property').length, 0)
  // A hidden effect draws nothing anywhere.
  assert.equal(findingsFor(lintScope([scene({ effects: [{ type: 'DROP_SHADOW', visible: false }] })]), 'preserve3d-dead-property').length, 0)
})

test('opacity, a blend mode, effects and clipping on a preserve3d container are flagged in one finding that names each', () => {
  const [finding, ...rest] = findingsFor(
    lintScope([scene({ opacity: 0.5, blendMode: 'MULTIPLY', effects: [{ type: 'DROP_SHADOW' }, { type: 'LAYER_BLUR' }], clipsContent: true })]),
    'preserve3d-dead-property'
  )
  assert.equal(rest.length, 0)
  assert.match(finding.message, /opacity 50%, blend mode MULTIPLY, 2 effects, clip content/)
  assert.match(finding.message, /Figma does not render them there/)
  assert.match(finding.message, /parent frame that does not preserve 3D/)
})

test('each dead property is enough on its own, and an effect style counts when its effects cannot be read', () => {
  for (const [over, said] of [
    [{ opacity: 0.99 }, /opacity 99%/],
    [{ blendMode: 'SCREEN' }, /blend mode SCREEN/],
    [{ effects: [{ type: 'INNER_SHADOW', visible: true }] }, /1 effect on/],
    [{ effectStyleId: 'S:abc,' }, /an effect style/],
    [{ clipsContent: true }, /clip content/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const found = findingsFor(lintScope([scene(over)]), 'preserve3d-dead-property')
    assert.equal(found.length, 1, JSON.stringify(over))
    assert.match(found[0].message, said)
    assert.match(found[0].message, /does not render it there/)
  }
})

test('the same properties on a flat scene, or with no scene, are ordinary', () => {
  const dead = { opacity: 0.5, blendMode: 'MULTIPLY', effects: [{ type: 'DROP_SHADOW' }], clipsContent: true }
  assert.equal(findingsFor(lintScope([scene({ ...dead, scene3d: { perspective: 800, preserve3d: false } })]), 'preserve3d-dead-property').length, 0)
  assert.equal(findingsFor(lintScope([scene({ ...dead, scene3d: null })]), 'preserve3d-dead-property').length, 0)
  assert.equal(findingsFor(lintScope([frame(dead)]), 'preserve3d-dead-property').length, 0)
})

test('a nested preserve3d container is found where it is', () => {
  const inner = scene({ id: 'inner', name: 'Inner', opacity: 0.3 })
  const found = findingsFor(lintScope([frame({ layoutMode: 'VERTICAL', children: [inner] })]), 'preserve3d-dead-property')
  assert.deepEqual(found.map((finding) => finding.nodeId), ['inner'])
})

test('an imported FREEFORM transform is flagged, a FIXED_ORDER one and a switched-off one are not', () => {
  const freeform = frame({ layoutMode: 'HORIZONTAL', transform3d: { type: 'FREEFORM', backfaceVisible: true } })
  const [finding] = findingsFor(lintScope([freeform]), 'transform3d-freeform')
  assert.match(finding.message, /exports flat/)

  const fixedOrder = frame({ layoutMode: 'HORIZONTAL', transform3d: { type: 'FIXED_ORDER', translateZ: 0, rotateX: 0, rotateY: 30, rotateZ: 0 } })
  assert.equal(findingsFor(lintScope([fixedOrder]), 'transform3d-freeform').length, 0)
  const off = frame({ layoutMode: 'HORIZONTAL', transform3d: { type: 'FREEFORM', backfaceVisible: true, visible: false } })
  assert.equal(findingsFor(lintScope([off]), 'transform3d-freeform').length, 0)
  assert.equal(findingsFor(lintScope([text({ transform3d: { type: 'FREEFORM', backfaceVisible: true } })]), 'transform3d-freeform').length, 1)
})
