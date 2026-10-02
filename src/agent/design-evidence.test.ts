import test from 'node:test'
import assert from 'node:assert/strict'
import { DESIGN_EVIDENCE_OPS } from './design-evidence.ts'
import { validateParams } from './protocol.ts'

interface FakeNode {
  id: string
  name: string
  type: string
  parent: FakeNode | null
  children: FakeNode[]
  [key: string]: unknown
}

interface EvidenceResult {
  policy: string
  coverage: {
    visual: string
    behavior: string
    productIntent: string
  }
  sources: {
    annotations: Array<{ category?: { label: string } }>
    devResources: Array<{ name: string }>
    designSystem: {
      variableBindings: number
      components: Array<{ name: string }>
    }
    behavior: { transitions: number }
    layout: {
      layoutGrids: Array<{ grids: Array<{ count?: number }> }>
      inferredLayouts: Array<{ inferred: boolean }>
    }
    content: { textNodes: number }
  }
  gaps: Array<{
    code: string
    blockingFor?: string[]
    blockingForExistingReproduction?: boolean
  }>
  truncated: boolean
  inspected: number
}

function node(id: string, name: string, type = 'FRAME', extra: Record<string, unknown> = {}): FakeNode {
  return { id, name, type, parent: null, children: [], ...extra }
}

function append(parent: FakeNode, ...children: FakeNode[]): void {
  for (const child of children) child.parent = parent
  parent.children.push(...children)
}

function install(t: test.TestContext, root: FakeNode, categories: unknown[] = []): void {
  const page = node('0:1', 'Product', 'PAGE', {
    loadAsync: async () => {},
    selection: [root],
    flowStartingPoints: [{ nodeId: root.id, name: 'Start' }],
  })
  page.children.push(root)
  root.parent = page
  const byId = new Map<string, FakeNode>()
  const walk = (entry: FakeNode) => { byId.set(entry.id, entry); entry.children.forEach(walk) }
  walk(page)
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    currentPage: page,
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    annotations: { getAnnotationCategoriesAsync: async () => categories },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })
}

const evidence = DESIGN_EVIDENCE_OPS[0]

test('design.evidence combines annotations, dev resources, tokens, components, behavior and layout', async (t) => {
  const root = node('1:1', 'Checkout', 'FRAME', {
    layoutMode: 'HORIZONTAL',
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
    fillStyleId: 'S:fill',
    annotations: [{ label: 'Primary checkout flow', properties: [{ type: 'width' }], categoryId: 'cat:product' }],
    layoutGrids: [{ pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 24, count: 12, offset: 32, visible: true }],
    reactions: [{ actions: [{ type: 'NODE', transition: { type: 'DISSOLVE' } }] }],
    getDevResourcesAsync: async () => [
      { nodeId: '1:1', name: 'Checkout specification', url: 'https://example.com/spec' },
    ],
  })
  const component = node('1:2', 'Button', 'COMPONENT', {
    descriptionMarkdown: '## Primary action',
    documentationLinks: [{ uri: 'https://example.com/button' }],
  })
  const inferred = node('1:3', 'Legacy row', 'FRAME', {
    layoutMode: 'NONE',
    inferredAutoLayout: {
      layoutMode: 'HORIZONTAL', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
      primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', strokesIncludedInLayout: true,
      layoutWrap: 'NO_WRAP', primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER',
      counterAxisAlignContent: 'AUTO', itemSpacing: 8, counterAxisSpacing: null, itemReverseZIndex: false,
    },
  })
  const copy = node('1:4', 'Title', 'TEXT')
  append(root, component, inferred, copy)
  install(t, root, [{ id: 'cat:product', label: 'Product', color: 'blue' }])

  // OpDef returns unknown at the registry boundary; this test validates the fields it consumes.
  const result = await evidence.run(validateParams(evidence.params, { nodeId: root.id })) as unknown as EvidenceResult
  assert.equal(result.policy, 'allcrew.fidelity-first')
  assert.equal(result.coverage.visual, 'strong')
  assert.equal(result.coverage.behavior, 'declared')
  assert.equal(result.coverage.productIntent, 'signals-present')
  assert.equal(result.sources.annotations[0].category.label, 'Product')
  assert.equal(result.sources.devResources[0].name, 'Checkout specification')
  assert.equal(result.sources.designSystem.variableBindings, 1)
  assert.equal(result.sources.designSystem.components[0].name, 'Button')
  assert.equal(result.sources.behavior.transitions, 1)
  assert.equal(result.sources.layout.layoutGrids[0].grids[0].count, 12)
  assert.equal(result.sources.layout.inferredLayouts[0].inferred, true)
  assert.equal(result.sources.content.textNodes, 1)
  assert.deepEqual(result.gaps, [])
})

test('a new screen with no brief reports direction gaps without pretending reproduction is blocked', async (t) => {
  const root = node('2:1', 'New dashboard')
  install(t, root)
  const result = await evidence.run(validateParams(evidence.params, { nodeId: root.id })) as unknown as EvidenceResult
  assert.equal(result.coverage.productIntent, 'not-documented-in-figma')
  const intent = result.gaps.find((gap) => gap.code === 'FIGMA_INTENT_NOT_DOCUMENTED')
  assert.deepEqual(intent?.blockingFor, ['new-surface', 'new-flow', 'redesign'])
  assert.equal(intent?.blockingForExistingReproduction, false)
  assert.ok(result.gaps.some((gap) => gap.code === 'NO_DESIGN_SYSTEM_SIGNALS'))
})

test('a bounded evidence read names truncation rather than claiming completeness', async (t) => {
  const root = node('3:1', 'Large screen')
  append(root, node('3:2', 'One'), node('3:3', 'Two'), node('3:4', 'Three'))
  install(t, root)
  const result = await evidence.run(validateParams(evidence.params, { nodeId: root.id, limit: 2 })) as unknown as EvidenceResult
  assert.equal(result.truncated, true)
  assert.equal(result.inspected, 2)
  assert.ok(result.gaps.some((gap) => gap.code === 'EVIDENCE_TRUNCATED'))
})
