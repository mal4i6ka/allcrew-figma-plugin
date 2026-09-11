import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_OPS, OPS_BY_NAME, READ_OPS, summarizeComponentProperties, summarizeNode, summarizeReactions } from './ops.ts'
import { validateParams } from './protocol.ts'

/* -------------------------------------------------------------- registry */

test('op names are unique across the whole registry', () => {
  const names = ALL_OPS.map((op) => op.name)
  assert.deepEqual(names, [...new Set(names)])
})

test('the read registry stays read-only — writes live behind their own gate', () => {
  assert.deepEqual(READ_OPS.filter((op) => op.mutates), [])
  assert.ok(ALL_OPS.some((op) => op.mutates), 'no mutating op is registered at all')
})

test('every write op documents itself for the paste-once skill', () => {
  // The "Teach the agent" section renders from OpDef.agent — a mutating op that ships without
  // guidance is an op the agent will misuse, and it would silently vanish from the how-to list.
  for (const op of ALL_OPS) {
    if (!op.mutates) continue
    assert.ok(typeof op.agent === 'string' && op.agent.length > 20, `${op.name} has no agent guidance`)
  }
})

test('every op carries a summary and describes each param', () => {
  for (const op of ALL_OPS) {
    assert.ok(op.summary.length > 0, `${op.name} has no summary`)
    for (const [param, spec] of Object.entries(op.params)) {
      assert.ok(spec.description.length > 0, `${op.name}.${param} has no description`)
    }
  }
})

/* --------------------------------------------------------------- search ops */

function setFigma(mock: Record<string, unknown>) {
  ;(globalThis as { figma?: unknown }).figma = mock
}

test('node.find searches by native type when types is given, and stays post-filtered by name', async () => {
  const header = { id: '2:1', name: 'Header', type: 'FRAME' }
  const footer = { id: '2:2', name: 'Footer', type: 'FRAME' }
  const currentPage = {
    id: '0:1',
    name: 'Page 1',
    findAllWithCriteria(criteria: { types: string[] }) {
      assert.deepEqual(criteria.types, ['FRAME'])
      return [header, footer]
    },
  }
  setFigma({ currentPage, skipInvisibleInstanceChildren: false })

  const op = OPS_BY_NAME.get('node.find')!
  const params = validateParams(op.params, { types: ['FRAME'], name: 'head' })
  const result = (await op.run(params)) as { total: number; truncated: boolean; nodes: Array<{ id: string }> }

  // The native path returns every FRAME; the name substring is the same post-filter the old
  // hand-rolled DFS applied, so only the header survives despite the mock returning both.
  assert.equal(result.total, 1)
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    ['2:1']
  )
})

test('node.find without types keeps walking with the hand-rolled DFS', async () => {
  const title = { id: '2:3', name: 'Title', type: 'TEXT', children: [] }
  const currentPage = { id: '0:1', name: 'Page 1', type: 'PAGE', children: [title] }
  setFigma({ currentPage, skipInvisibleInstanceChildren: false })

  const op = OPS_BY_NAME.get('node.find')!
  const params = validateParams(op.params, { name: 'title' })
  const result = (await op.run(params)) as { total: number; nodes: Array<{ id: string }> }

  assert.deepEqual(
    result.nodes.map((n) => n.id),
    ['2:3']
  )
})

test('components.list finds components and sets natively, still dropping variants and applying the name filter', async () => {
  const variant = { id: '1:3', key: 'keyC', name: 'Size=Small', type: 'COMPONENT', parent: null as unknown }
  const iconSet = {
    id: '1:2',
    key: 'keyB',
    name: 'Icon',
    type: 'COMPONENT_SET',
    description: '',
    documentationLinks: [],
    componentPropertyDefinitions: {},
    children: [variant],
  }
  variant.parent = iconSet
  const button = {
    id: '1:1',
    key: 'keyA',
    name: 'Button',
    type: 'COMPONENT',
    parent: null,
    description: 'Primary action',
    documentationLinks: [],
    componentPropertyDefinitions: {},
  }
  const page1 = { id: 'page1', name: 'Page 1', loadAsync: async () => {} }
  const root = {
    children: [page1],
    findAllWithCriteria(criteria: { types: string[] }) {
      assert.deepEqual(criteria.types, ['COMPONENT', 'COMPONENT_SET'])
      // The variant is reachable through `iconSet.children` too — the native call returning it
      // directly is exactly the case the "reachable through its parent" post-filter must catch.
      return [button, iconSet, variant]
    },
  }
  setFigma({ root, skipInvisibleInstanceChildren: false })

  const op = OPS_BY_NAME.get('components.list')!
  const params = validateParams(op.params, {})
  const result = (await op.run(params)) as {
    total: number
    truncated: boolean
    components: Array<{ id: string; variants?: Array<{ id: string }> }>
  }

  assert.equal(result.total, 2)
  assert.deepEqual(
    result.components.map((c) => c.id),
    ['1:1', '1:2']
  )
  assert.deepEqual(result.components[1].variants, [{ id: '1:3', name: 'Size=Small' }])
})

test('a component set Figma refuses to describe costs its own properties, not the whole inventory', async () => {
  // Live failure on the 54-page file: one set answered `componentPropertyDefinitions` with
  // "Component set has existing errors", and the op returned zero components out of ~500.
  const broken = {
    id: '1:9',
    key: 'keyBroken',
    name: 'Broken set',
    type: 'COMPONENT_SET',
    description: '',
    documentationLinks: [],
    children: [],
    get componentPropertyDefinitions(): never {
      throw new Error('Component set has existing errors')
    },
  }
  const healthy = {
    id: '1:1',
    key: 'keyA',
    name: 'Button',
    type: 'COMPONENT',
    parent: null,
    description: '',
    documentationLinks: [],
    componentPropertyDefinitions: { Size: { type: 'VARIANT', variantOptions: ['S'] } },
  }
  const root = {
    children: [{ id: 'page1', name: 'Page 1', loadAsync: async () => {} }],
    findAllWithCriteria: () => [broken, healthy],
  }
  setFigma({ root, skipInvisibleInstanceChildren: false })

  const op = OPS_BY_NAME.get('components.list')!
  const result = (await op.run(validateParams(op.params, {}))) as {
    total: number
    components: Array<{ id: string; properties?: unknown; propertiesError?: string }>
  }

  assert.equal(result.total, 2)
  assert.deepEqual(
    result.components.map((component) => component.id),
    ['1:9', '1:1']
  )
  assert.match(result.components[0].propertiesError!, /existing errors/)
  assert.equal(result.components[0].properties, undefined)
  assert.deepEqual(result.components[1].properties, { Size: { type: 'VARIANT', variantOptions: ['S'] } })
})

test('an instance names the component SET it comes from, not just the variant it points at', async () => {
  // Live shape from the 54-page file: `getMainComponentAsync` answers the variant
  // "Device=Desktop" (823:97861), while every consumer — components.list, Code Connect, the
  // designer — calls the thing "Tittle_text" (823:97862).
  const set = { id: '823:97862', name: 'Tittle_text', type: 'COMPONENT_SET' }
  const variant = { id: '823:97861', name: 'Device=Desktop', type: 'COMPONENT', parent: set }
  const instance = {
    id: '2259:129969',
    name: 'Tittle_text',
    type: 'INSTANCE',
    width: 1296,
    height: 160,
    children: [],
    componentProperties: { 'Tittle#1956:0': { type: 'TEXT', value: 'Built to back your business' } },
    getMainComponentAsync: async () => variant,
  }
  setFigma({ getNodeByIdAsync: async (id: string) => (id === instance.id ? instance : null) })

  const op = OPS_BY_NAME.get('node.get')!
  const result = (await op.run(validateParams(op.params, { nodeId: '2259:129969', depth: 0 }))) as {
    instanceOf: { id: string; name: string; setId?: string; setName?: string; properties?: Record<string, unknown> }
  }

  assert.equal(result.instanceOf.id, '823:97861')
  assert.equal(result.instanceOf.setId, '823:97862')
  assert.equal(result.instanceOf.setName, 'Tittle_text')
  // Property keys keep Figma's `#nodeId` suffix here, exactly as the live file hands them over.
  assert.deepEqual(result.instanceOf.properties, { 'Tittle#1956:0': 'Built to back your business' })
})

test('a lone component with no variants leaves the set fields out rather than inventing one', async () => {
  const main = { id: '823:97569', name: 'Frame QR', type: 'COMPONENT', parent: { id: 'page1', type: 'PAGE' } }
  const instance = {
    id: '1:5',
    name: 'Frame QR',
    type: 'INSTANCE',
    width: 80,
    height: 80,
    children: [],
    componentProperties: null,
    getMainComponentAsync: async () => main,
  }
  setFigma({ getNodeByIdAsync: async () => instance })

  const op = OPS_BY_NAME.get('node.get')!
  const result = (await op.run(validateParams(op.params, { nodeId: '1:5', depth: 0 }))) as {
    instanceOf: { setId?: string; setName?: string }
  }

  assert.equal('setId' in result.instanceOf, false)
  assert.equal('setName' in result.instanceOf, false)
})

test("a mode pinned on a child is reported there, not swallowed by the root's inherited picture", async () => {
  // In this file the theme is pinned on the Figma page ("Redesign One" → Light) and frames
  // inherit it, but a section forced to its own mode is a decision a designer makes on the node —
  // and a read that only described the root hid every one of them.
  const collection = {
    id: 'VariableCollectionId:1:1',
    name: 'Variable collection',
    modes: [
      { modeId: '1:0', name: 'Light' },
      { modeId: '1:1', name: 'Dark' },
    ],
  }
  const child = {
    id: '2:2',
    name: 'Container',
    type: 'FRAME',
    children: [],
    explicitVariableModes: { 'VariableCollectionId:1:1': '1:1' },
    resolvedVariableModes: { 'VariableCollectionId:1:1': '1:1' },
  }
  const page = {
    id: '1:2',
    name: 'One Main',
    type: 'FRAME',
    children: [child],
    explicitVariableModes: {},
    resolvedVariableModes: { 'VariableCollectionId:1:1': '1:0' },
  }
  setFigma({
    getNodeByIdAsync: async () => page,
    variables: { getVariableCollectionByIdAsync: async () => collection },
  })

  const op = OPS_BY_NAME.get('node.get')!
  const result = (await op.run(validateParams(op.params, { nodeId: '1:2', depth: 1 }))) as {
    modes: { explicit?: unknown[]; resolved?: Array<{ mode: string }> }
    children: Array<{ modes?: { explicit?: Array<{ collection: string; mode: string }>; resolved?: unknown[] } }>
  }

  assert.equal(result.modes.resolved?.[0].mode, 'Light', 'the root still reports what applies')
  assert.equal('explicit' in result.modes, false, 'the page frame pins nothing itself')
  assert.deepEqual(result.children[0].modes?.explicit, [
    { collectionId: 'VariableCollectionId:1:1', collection: 'Variable collection', modeId: '1:1', mode: 'Dark' },
  ])
  assert.equal(
    'resolved' in (result.children[0].modes ?? {}),
    false,
    'the inherited picture repeats down the tree — it stays on the root'
  )
})

/* ------------------------------------------------------------- reactions */

test('summarizeReactions reads the current actions[] shape', () => {
  const summary = summarizeReactions([
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE' }] },
  ])
  assert.deepEqual(summary, [
    { trigger: 'ON_CLICK', action: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE' },
  ])
})

test('summarizeReactions still reads the legacy single action', () => {
  const summary = summarizeReactions([{ trigger: { type: 'ON_HOVER' }, action: { type: 'NODE', destinationId: '5:6' } }])
  assert.deepEqual(summary, [{ trigger: 'ON_HOVER', action: 'NODE', destinationId: '5:6' }])
})

test('summarizeReactions keeps destination-less actions but omits the key', () => {
  const summary = summarizeReactions([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] }])
  assert.deepEqual(summary, [{ trigger: 'ON_CLICK', action: 'CLOSE' }])
})

test('summarizeReactions tolerates a node with no reactions at all', () => {
  assert.deepEqual(summarizeReactions(undefined), [])
  assert.deepEqual(summarizeReactions([null, 'junk']), [])
})

/* ---------------------------------------------------- component properties */

test('summarizeComponentProperties flattens {type,value} entries', () => {
  const props = summarizeComponentProperties({
    Size: { type: 'VARIANT', value: 'Large' },
    Disabled: { type: 'BOOLEAN', value: false },
  })
  assert.deepEqual(props, { Size: 'Large', Disabled: false })
})

test('summarizeComponentProperties returns undefined when there is nothing to report', () => {
  assert.equal(summarizeComponentProperties({}), undefined)
  assert.equal(summarizeComponentProperties(null), undefined)
})

/* ------------------------------------------------------------------ nodes */

test('summarizeNode rounds float-noisy geometry to two places', () => {
  const summary = summarizeNode({ id: '1:1', name: 'Card', type: 'FRAME', x: 10.00000001, y: 3.456, width: 320.5, height: 200 })
  assert.equal(summary.x, 10)
  assert.equal(summary.y, 3.46)
  assert.equal(summary.width, 320.5)
})

test('summarizeNode reports auto-layout only when the node actually uses it', () => {
  const plain = summarizeNode({ id: '1:1', name: 'Group', type: 'FRAME', layoutMode: 'NONE' })
  assert.equal(plain.layout, undefined)

  const stack = summarizeNode({
    id: '1:2',
    name: 'Row',
    type: 'FRAME',
    layoutMode: 'HORIZONTAL',
    itemSpacing: 8,
    paddingTop: 12,
    paddingRight: 16,
    paddingBottom: 12,
    paddingLeft: 16,
    primaryAxisAlignItems: 'SPACE_BETWEEN',
  })
  assert.deepEqual(stack.layout, {
    mode: 'HORIZONTAL',
    itemSpacing: 8,
    padding: [12, 16, 12, 16],
    primaryAxisAlign: 'SPACE_BETWEEN',
  })
})

test('summarizeNode truncates long copy instead of shipping the whole deck', () => {
  const long = 'x'.repeat(400)
  const summary = summarizeNode({ id: '1:3', name: 'Body', type: 'TEXT', characters: long })
  assert.equal(summary.text!.length, 161)
  assert.ok(summary.text!.endsWith('…'))
})

test('summarizeNode keeps short text verbatim', () => {
  assert.equal(summarizeNode({ id: '1:4', name: 'CTA', type: 'TEXT', characters: 'Buy now' }).text, 'Buy now')
})

test('summarizeNode counts children without walking them', () => {
  const summary = summarizeNode({ id: '1:5', name: 'List', type: 'FRAME', children: [{}, {}, {}] })
  assert.equal(summary.childCount, 3)
  assert.equal(summary.children, undefined)
})

test('summarizeNode flags hidden nodes and stays quiet about visible ones', () => {
  assert.equal(summarizeNode({ id: '1:6', name: 'Off', type: 'FRAME', visible: false }).visible, false)
  assert.equal(summarizeNode({ id: '1:7', name: 'On', type: 'FRAME', visible: true }).visible, undefined)
})
