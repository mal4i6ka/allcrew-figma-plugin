import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_OPS,
  imagePlacement,
  OPS_BY_NAME,
  READ_OPS,
  summarizeComponentProperties,
  summarizeNode,
  summarizeReactions,
} from './ops.ts'
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

test('summarizeReactions reads the current actions[] shape', async () => {
  const summary = await summarizeReactions([
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE' }] },
  ])
  assert.deepEqual(summary, [
    { trigger: 'ON_CLICK', action: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE', transition: null },
  ])
})

test('summarizeReactions still reads the legacy single action', async () => {
  const summary = await summarizeReactions([{ trigger: { type: 'ON_HOVER' }, action: { type: 'NODE', destinationId: '5:6' } }])
  assert.deepEqual(summary, [{ trigger: 'ON_HOVER', action: 'NODE', destinationId: '5:6', transition: null }])
})

test('summarizeReactions keeps destination-less actions but omits the key', async () => {
  const summary = await summarizeReactions([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] }])
  assert.deepEqual(summary, [{ trigger: 'ON_CLICK', action: 'CLOSE' }])
})

test('summarizeReactions tolerates a node with no reactions at all', async () => {
  assert.deepEqual(await summarizeReactions(undefined), [])
  assert.deepEqual(await summarizeReactions([null, 'junk']), [])
})

test("summarizeReactions surfaces a NODE transition's duration and easing", async () => {
  const summary = await summarizeReactions([
    {
      trigger: { type: 'ON_CLICK' },
      actions: [
        {
          type: 'NODE',
          destinationId: '9:1',
          navigation: 'NAVIGATE',
          transition: { type: 'SMART_ANIMATE', duration: 0.4, easing: { type: 'EASE_IN_AND_OUT' } },
        },
      ],
    },
  ])
  assert.deepEqual(summary[0].transition, {
    type: 'SMART_ANIMATE',
    duration: 0.4,
    easing: 'EASE_IN_AND_OUT',
    // The preset name is opaque off the web; its control points ride along so a native
    // consumer does not have to keep Figma's table itself.
    curve: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_IN_AND_OUT' },
  })
})

test('summarizeReactions names a NODE destination only when a resolver is given', async () => {
  const raw = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:1', navigation: 'NAVIGATE' }] }]

  const withoutResolver = await summarizeReactions(raw)
  assert.equal('destinationName' in withoutResolver[0], false)

  const withResolver = await summarizeReactions(raw, async (id) => (id === '9:1' ? 'Details' : null))
  assert.equal(withResolver[0].destinationName, 'Details')
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

test('summarizeNode reports textLength regardless of truncation, and fullText skips it', () => {
  const long = 'x'.repeat(400)
  const truncated = summarizeNode({ id: '1:8', name: 'Body', type: 'TEXT', characters: long })
  assert.equal(truncated.textLength, 400)
  assert.equal(truncated.text!.length, 161)

  const full = summarizeNode({ id: '1:9', name: 'Body', type: 'TEXT', characters: long }, true)
  assert.equal(full.textLength, 400)
  assert.equal(full.text, long)
})

/* ----------------------------------------------------- node.get enrichment */

test('node.get reports effects only when asked, and stays quiet by default', async () => {
  const node = {
    id: '1:1',
    name: 'Card',
    type: 'FRAME',
    children: [],
    effects: [{ type: 'LAYER_BLUR', visible: true, radius: 8 }],
  }
  setFigma({ getNodeByIdAsync: async () => node })

  const op = OPS_BY_NAME.get('node.get')!
  const bare = (await op.run(validateParams(op.params, { nodeId: '1:1', depth: 0 }))) as { effects?: unknown }
  assert.equal(bare.effects, undefined)

  const withEffects = (await op.run(validateParams(op.params, { nodeId: '1:1', depth: 0, effects: true }))) as {
    effects?: Array<Record<string, unknown>>
  }
  assert.deepEqual(withEffects.effects, [{ blur: 'layer', radius: 8 }])
})

test("node.get names a TEXT node's style, and reports a mixed style honestly", async () => {
  const style = { id: 'S:1', name: 'Heading/H2', remote: false }
  const bound = { id: '1:2', name: 'Title', type: 'TEXT', characters: 'Hello', textStyleId: 'S:1', children: [] }
  const mixedSentinel = Symbol('figma.mixed')
  const mixed = { id: '1:3', name: 'Mixed', type: 'TEXT', characters: 'Hi', textStyleId: mixedSentinel, children: [] }
  setFigma({
    mixed: mixedSentinel,
    getStyleByIdAsync: async (id: string) => (id === 'S:1' ? style : null),
    getNodeByIdAsync: async (id: string) => (id === bound.id ? bound : id === mixed.id ? mixed : null),
  })

  const op = OPS_BY_NAME.get('node.get')!
  const boundResult = (await op.run(validateParams(op.params, { nodeId: '1:2', depth: 0 }))) as {
    textStyle?: { id: string; name: string | null; remote: boolean }
  }
  assert.deepEqual(boundResult.textStyle, { id: 'S:1', name: 'Heading/H2', remote: false })

  const mixedResult = (await op.run(validateParams(op.params, { nodeId: '1:3', depth: 0 }))) as {
    textStyle?: { id: string; name: string | null; remote: boolean }
  }
  assert.deepEqual(mixedResult.textStyle, { id: 'mixed', name: null, remote: false })
})

test('node.get truncates at 160 by default and reports textLength either way; fullText skips the cut', async () => {
  const long = 'y'.repeat(400)
  const node = { id: '1:4', name: 'Body', type: 'TEXT', characters: long, children: [] }
  setFigma({ getNodeByIdAsync: async () => node })

  const op = OPS_BY_NAME.get('node.get')!
  const truncated = (await op.run(validateParams(op.params, { nodeId: '1:4', depth: 0 }))) as {
    text?: string
    textLength?: number
  }
  assert.equal(truncated.text!.length, 161)
  assert.equal(truncated.textLength, 400)

  const full = (await op.run(validateParams(op.params, { nodeId: '1:4', depth: 0, fullText: true }))) as {
    text?: string
    textLength?: number
  }
  assert.equal(full.text, long)
  assert.equal(full.textLength, 400)
})

test("node.get names a reaction's destination and carries its Smart Animate timing", async () => {
  const destination = { id: '2:1', name: 'Screen 2', type: 'FRAME' }
  const node = {
    id: '1:9',
    name: 'Button',
    type: 'FRAME',
    children: [],
    reactions: [
      {
        trigger: { type: 'ON_CLICK' },
        actions: [
          {
            type: 'NODE',
            destinationId: '2:1',
            navigation: 'NAVIGATE',
            transition: { type: 'SMART_ANIMATE', duration: 0.4, easing: { type: 'EASE_IN_AND_OUT' } },
          },
        ],
      },
    ],
  }
  setFigma({
    getNodeByIdAsync: async (id: string) => (id === node.id ? node : id === destination.id ? destination : null),
  })

  const op = OPS_BY_NAME.get('node.get')!
  const result = (await op.run(validateParams(op.params, { nodeId: '1:9', depth: 0 }))) as {
    reactions?: Array<{ destinationName?: string; transition?: { type: string; duration: number; easing: unknown; curve?: unknown } | null }>
  }
  assert.equal(result.reactions?.[0].destinationName, 'Screen 2')
  assert.deepEqual(result.reactions?.[0].transition, {
    type: 'SMART_ANIMATE',
    duration: 0.4,
    easing: 'EASE_IN_AND_OUT',
    curve: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_IN_AND_OUT' },
  })
})

test('a flow edge carries the navigation kind and the timing, not only the two node ids', async () => {
  // A build needs to render the transition, and the numbers were already computed by
  // `summarizeReactions` one line away — an edge of five strings sent it to guess.
  const button = {
    id: '1:9',
    name: 'Open sheet',
    type: 'INSTANCE',
    reactions: [
      {
        trigger: { type: 'ON_CLICK' },
        actions: [
          {
            type: 'NODE',
            destinationId: '2:1',
            navigation: 'NAVIGATE',
            transition: { type: 'PUSH', direction: 'RIGHT', duration: 0.3, easing: { type: 'EASE_OUT' } },
          },
        ],
      },
    ],
  }
  const screen = { id: '2:1', name: 'Sheet', type: 'FRAME' }
  const currentPage = {
    id: '0:1',
    name: 'Page 1',
    children: [screen, button],
    flowStartingPoints: [],
    findAllWithCriteria: () => [button],
    findAll: () => [button],
  }
  setFigma({ currentPage, skipInvisibleInstanceChildren: false })

  const op = OPS_BY_NAME.get('flow.map')!
  const result = (await op.run(validateParams(op.params, {}))) as {
    edges: Array<{ to: string; navigation?: string; transition?: { type: string; duration: number; curve?: unknown } }>
  }

  assert.equal(result.edges.length, 1)
  assert.equal(result.edges[0].navigation, 'NAVIGATE')
  // Direction folds into the name the write vocabulary takes, so a rebuild of this link reads back
  // identically — `PUSH` + `RIGHT` is one `PUSH_RIGHT`.
  assert.equal(result.edges[0].transition?.type, 'PUSH_RIGHT')
  assert.equal(result.edges[0].transition?.duration, 0.3)
  assert.deepEqual(result.edges[0].transition?.curve, {
    kind: 'bezier',
    x1: 0,
    y1: 0,
    x2: 0.58,
    y2: 1,
    preset: 'EASE_OUT',
  })
})

test('an image crop comes back as numbers a layout takes, not as a matrix', () => {
  // Checked against Figma's own output for 4477:114155, where it prints
  // `background-size: 265.451% 114.231%; background-position: -523.197px 0px` on a 343px box:
  // 1/0.3767 = 2.6546, and -0.5746/0.3767 * 343 = -523.2.
  assert.deepEqual(
    imagePlacement('CROP', [
      [0.3767179250717163, 0, 0.5746288895606995],
      [0, 0.875420868396759, 0],
    ], undefined),
    { fit: 'crop', scale: { x: 2.6545, y: 1.1423 }, offset: { x: -1.5254, y: -0 } }
  )
})

test('the scale modes that need no matrix answer without one', () => {
  assert.deepEqual(imagePlacement('FILL', undefined, undefined), { fit: 'cover' })
  assert.deepEqual(imagePlacement('FIT', undefined, undefined), { fit: 'contain' })
  assert.deepEqual(imagePlacement('TILE', undefined, 0.5), { fit: 'tile', scalingFactor: 0.5 })
})

test('a rotated crop is named, not flattened onto two axes', () => {
  // There is no honest background-position for it, and a plausible wrong number is worse than
  // a refusal that points back at `imageTransform`.
  assert.deepEqual(imagePlacement('CROP', [[0.9, 0.2, 0], [-0.2, 0.9, 0]], undefined), { fit: 'matrix' })
  assert.equal(imagePlacement('CROP', undefined, undefined), null)
})
