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
