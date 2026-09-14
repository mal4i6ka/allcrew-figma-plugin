import test from 'node:test'
import assert from 'node:assert/strict'
import { computeNodeStates, compareFrames, STATE_OPS } from './state-ops.ts'
import { validateParams } from './protocol.ts'

/* ------------------------------------------------------------------------- node.states fixtures */

/** A live-scene-node-shaped mock — the same duck type `interactions.test.ts`'s `liveNode` and
 * `spec-ops.test.ts`'s `layer` fixtures use for their own modules (`.id`/`.name`/`.type`/
 * `.children`/`.getCSSAsync`, plus the reaction/variant fields this module additionally reads). */
interface ChipFixture {
  id: string
  name: string
  type: string
  variantProperties: Record<string, string>
  parent: ComponentSetFixture | null
  children: ChipFixture[]
  getCSSAsync: () => Promise<Record<string, string>>
  reactions?: unknown[]
}

interface ComponentSetFixture {
  id: string
  name: string
  type: 'COMPONENT_SET'
  children: ChipFixture[]
}

function chip(id: string, state: string, css: Record<string, string>, variantProperties: Record<string, string> = { State: state }): ChipFixture {
  return { id, name: `State=${state}`, type: 'COMPONENT', variantProperties, parent: null, children: [], getCSSAsync: async () => css }
}

function chipSet(id: string, name: string, variants: ChipFixture[]): ComponentSetFixture {
  const set: ComponentSetFixture = { id, name, type: 'COMPONENT_SET', children: variants }
  for (const variant of variants) variant.parent = set
  return set
}

/* --------------------------------------------------------------------------------- node.states */

test('a State=Hover/Active variant set reports only the properties each state actually changes, not the whole CSS', async () => {
  const standart = chip('chip:std', 'Standart', { background: 'rgb(255, 255, 255)', padding: '8px', color: 'rgb(0, 0, 0)' })
  const hover = chip('chip:hov', 'Hover', { background: 'rgb(240, 240, 240)', padding: '10px', color: 'rgb(0, 0, 0)' })
  const active = chip('chip:act', 'Active', { background: 'rgb(0, 0, 255)', padding: '8px', color: 'rgb(255, 255, 255)' })
  chipSet('chip:set', 'Tabs', [standart, hover, active])

  const result = await computeNodeStates(standart, async () => null)

  assert.equal(result.states.length, 2)
  const byTrigger = new Map(result.states.map((s) => [s.trigger, s]))

  // Hover changes background + padding — color is IDENTICAL between Standart and Hover, so it
  // must NOT appear, proving this is a real diff and not a CSS dump.
  const hoverState = byTrigger.get('ON_HOVER')!
  assert.equal(hoverState.to.id, 'chip:hov')
  assert.deepEqual(
    hoverState.changes.map((c) => c.property).sort(),
    ['background', 'padding']
  )
  assert.deepEqual(
    hoverState.changes.find((c) => c.property === 'background'),
    { path: '', property: 'background', from: 'rgb(255, 255, 255)', to: 'rgb(240, 240, 240)' }
  )

  // Active changes background + color — padding is identical to Standart's, so it drops out.
  const activeState = byTrigger.get('ON_PRESS')!
  assert.equal(activeState.to.id, 'chip:act')
  assert.deepEqual(
    activeState.changes.map((c) => c.property).sort(),
    ['background', 'color']
  )
})

test('a variant sibling with a DIFFERENT Size, not just State, is not treated as a state (would attribute the wrong delta)', async () => {
  const small = chip('chip:sm-std', 'Standart', { padding: '4px' }, { State: 'Standart', Size: 'Small' })
  const smallHover = chip('chip:sm-hov', 'Hover', { padding: '6px' }, { State: 'Hover', Size: 'Small' })
  const largeStandart = chip('chip:lg-std', 'Standart', { padding: '8px' }, { State: 'Standart', Size: 'Large' })
  chipSet('chip:set2', 'Tabs', [small, smallHover, largeStandart])

  const result = await computeNodeStates(small, async () => null)

  assert.equal(result.states.length, 1)
  assert.equal(result.states[0].to.id, 'chip:sm-hov')
})

test('an ON_HOVER reaction CHANGE_TO reports the transition and diffs a descendant by its own path', async () => {
  const triggerIcon = { id: 'trig:1-icon', name: 'Icon', type: 'VECTOR', children: [], getCSSAsync: async () => ({ fill: 'rgb(0, 0, 0)' }) }
  const trigger = {
    id: 'trig:1',
    name: 'Button',
    type: 'FRAME',
    children: [triggerIcon],
    getCSSAsync: async () => ({ padding: '4px' }),
    reactions: [
      {
        trigger: { type: 'ON_HOVER' },
        actions: [
          {
            type: 'NODE',
            navigation: 'CHANGE_TO',
            destinationId: 'dest:1',
            transition: { type: 'DISSOLVE', duration: 0.2, easing: { type: 'EASE_IN_AND_OUT' } },
          },
        ],
      },
    ],
  }
  const destIcon = { id: 'dest:1-icon', name: 'Icon', type: 'VECTOR', children: [], getCSSAsync: async () => ({ fill: 'rgb(255, 0, 0)' }) }
  const dest = { id: 'dest:1', name: 'Button', type: 'FRAME', children: [destIcon], getCSSAsync: async () => ({ padding: '8px' }) }

  const resolve = async (id: string) => (id === 'dest:1' ? dest : null)
  const result = await computeNodeStates(trigger, resolve)

  assert.equal(result.states.length, 1)
  const state = result.states[0]
  assert.equal(state.trigger, 'ON_HOVER')
  assert.deepEqual(state.transition, {
    type: 'DISSOLVE',
    duration: 200,
    easing: 'EASE_IN_AND_OUT',
    curve: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_IN_AND_OUT' },
  })
  assert.deepEqual(
    state.changes.find((c) => c.path === ''),
    { path: '', property: 'padding', from: '4px', to: '8px' }
  )
  assert.deepEqual(
    state.changes.find((c) => c.path !== ''),
    { path: 'Icon#0', property: 'fill', from: 'rgb(0, 0, 0)', to: 'rgb(255, 0, 0)' }
  )
})

test('a CHANGE_TO reaction whose destination is not on the page is skipped, not thrown', async () => {
  const trigger = {
    id: 'trig:2',
    name: 'Ghost',
    type: 'FRAME',
    children: [],
    getCSSAsync: async () => ({}),
    reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: 'missing:1' }] }],
  }

  const result = await computeNodeStates(trigger, async () => null)

  assert.deepEqual(result.states, [])
})

/* ------------------------------------------------------------------------------ frames.compare */

interface FrameFixture {
  id: string
  name: string
  type: string
  width: number
  height: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  itemSpacing?: number
  fontSize?: number
  children: FrameFixture[]
}

function frameNode(
  id: string,
  name: string,
  options: { width?: number; height?: number; padding?: [number, number, number, number]; gap?: number; fontSize?: number } = {},
  children: FrameFixture[] = []
): FrameFixture {
  const [top, right, bottom, left] = options.padding ?? []
  return {
    id,
    name,
    type: 'FRAME',
    width: options.width ?? 100,
    height: options.height ?? 100,
    ...(options.padding ? { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left } : {}),
    ...(options.gap !== undefined ? { itemSpacing: options.gap } : {}),
    ...(options.fontSize !== undefined ? { fontSize: options.fontSize } : {}),
    children,
  }
}

test('frames.compare reports width/padding deltas for matched layers and honest onlyInA/onlyInB lists', async () => {
  const desktopCard = frameNode('d:card', 'Card', { width: 400, height: 200, padding: [16, 16, 16, 16] })
  const desktopSidebar = frameNode('d:side', 'Sidebar', { width: 300, height: 800 })
  const desktop = frameNode('d:root', 'Guides / Desktop', { width: 1280, height: 800 }, [desktopSidebar, desktopCard])

  const mobileCard = frameNode('m:card', 'Card', { width: 343, height: 240, padding: [8, 8, 8, 8] })
  const mobileBadge = frameNode('m:badge', 'Badge', { width: 60, height: 24 })
  const mobile = frameNode('m:root', 'Guides / Mobile', { width: 375, height: 900 }, [mobileCard, mobileBadge])

  const result = compareFrames(desktop, mobile)

  assert.deepEqual(result.a, { id: 'd:root', name: 'Guides / Desktop', width: 1280 })
  assert.deepEqual(result.b, { id: 'm:root', name: 'Guides / Mobile', width: 375 })

  const card = result.matched.find((m) => m.path === 'Card#0')!
  assert.deepEqual(card.deltas.width, { from: 400, to: 343 })
  assert.deepEqual(card.deltas.height, { from: 200, to: 240 })
  assert.deepEqual(card.deltas.padding, { from: '16 16 16 16', to: '8 8 8 8' })
  assert.equal(card.deltas.order, undefined) // sole common sibling on both sides — no reorder to report

  assert.deepEqual(
    result.onlyInA.map((e) => e.name),
    ['Sidebar']
  )
  assert.deepEqual(
    result.onlyInB.map((e) => e.name),
    ['Badge']
  )
  assert.deepEqual(result.reordered, [])
})

test('frames.compare puts a layer that moved among its shared siblings into reordered, without flagging a merely-removed sibling as a move', async () => {
  const a = frameNode('a:root', 'A', {}, [
    frameNode('shared:cta', 'CTA', { width: 120 }),
    frameNode('a:copy', 'Copy', { width: 200 }), // present only in A — must not shift CTA/Badge's read
    frameNode('shared:badge', 'Badge', { width: 40 }),
  ])
  const b = frameNode('b:root', 'A', {}, [
    frameNode('shared:badge-b', 'Badge', { width: 40 }),
    frameNode('shared:cta-b', 'CTA', { width: 120 }),
  ])

  const result = compareFrames(a, b)

  assert.deepEqual(
    result.reordered.map((r) => r.path).sort(),
    ['Badge#0', 'CTA#0']
  )
  const cta = result.reordered.find((r) => r.path === 'CTA#0')!
  const badge = result.reordered.find((r) => r.path === 'Badge#0')!
  // Rank is among the COMMON set only (Copy, present only in A, never enters the count): CTA was
  // first of the two common siblings in A (rank 0) and is second in B (rank 1); Badge the reverse.
  assert.deepEqual(cta, { path: 'CTA#0', from: 0, to: 1 })
  assert.deepEqual(badge, { path: 'Badge#0', from: 1, to: 0 })
})

/* ---------------------------------------------------------------------------------- op wiring */

function setFigma(mock: Record<string, unknown>) {
  ;(globalThis as { figma?: unknown }).figma = mock
}

test('the node.states op resolves nodeId through figma.getNodeByIdAsync and runs the same diff', async () => {
  const standart = chip('op:std', 'Standart', { background: 'red' })
  const hover = chip('op:hov', 'Hover', { background: 'blue' })
  chipSet('op:set', 'Tabs', [standart, hover])
  const byId = new Map<string, ChipFixture>([
    ['op:std', standart],
    ['op:hov', hover],
  ])
  setFigma({ getNodeByIdAsync: async (id: string) => byId.get(id) ?? null })

  const op = STATE_OPS.find((o) => o.name === 'node.states')!
  const params = validateParams(op.params, { nodeId: 'op:std' })
  const result = (await op.run(params)) as { states: unknown[] }

  assert.equal(result.states.length, 1)
})

test('the frames.compare op resolves both ids and rejects a missing one', async () => {
  const a = frameNode('op:a', 'A')
  const b = frameNode('op:b', 'B')
  const byId = new Map<string, FrameFixture>([
    ['op:a', a],
    ['op:b', b],
  ])
  setFigma({ getNodeByIdAsync: async (id: string) => byId.get(id) ?? null })

  const op = STATE_OPS.find((o) => o.name === 'frames.compare')!
  const ok = await op.run(validateParams(op.params, { a: 'op:a', b: 'op:b' }))
  assert.deepEqual((ok as { a: { id: string } }).a, { id: 'op:a', name: 'A', width: 100 })

  await assert.rejects(() => op.run(validateParams(op.params, { a: 'op:a', b: 'missing' })), /no node with id missing/)
})

test('a CUSTOM_SPRING state keeps its physics instead of collapsing to a type name', async () => {
  // `easing: 'CUSTOM_SPRING'` is the least useful string in the answer: the mass/stiffness/damping
  // the designer configured were right there on the reaction and were dropped.
  const press = chip('3:2', 'Press', { background: 'rgb(0, 0, 0)' })
  const idle = chip('3:1', 'Idle', { background: 'rgb(255, 255, 255)' })
  idle.reactions = [
    {
      trigger: { type: 'ON_PRESS' },
      actions: [
        {
          type: 'NODE',
          navigation: 'CHANGE_TO',
          destinationId: '3:2',
          transition: {
            type: 'SMART_ANIMATE',
            duration: 0.3,
            easing: {
              type: 'CUSTOM_SPRING',
              easingFunctionSpring: { mass: 1, stiffness: 100, damping: 15, initialVelocity: 0 },
            },
          },
        },
      ],
    },
  ]

  const result = await computeNodeStates(idle, async (id) => (id === press.id ? press : null))
  const transition = result.states[0].transition
  const curve = transition?.curve

  assert.equal(transition?.easing, 'CUSTOM_SPRING')
  assert.equal(curve?.kind, 'spring')
  assert.equal(curve?.kind === 'spring' && curve.dampingRatio, 0.75)
  assert.equal(curve?.kind === 'spring' && curve.stiffness, 100)
  // The designer stated these numbers — nothing in this curve is the reverse-engineered estimate.
  assert.equal(curve?.kind === 'spring' && curve.source, 'physical')
})

test('a component set answers about its resting member instead of "no states"', async () => {
  // `components.list` hands out the SET id, and the set has no states of its own — the hover
  // lives between its members. Answering `states: []` to that id read as "this has no states".
  const idle = chip('4:1', 'Standart', { background: 'rgb(255, 255, 255)' })
  const hover = chip('4:2', 'Hover', { background: 'rgb(240, 240, 240)' })
  const set: ComponentSetFixture = { id: '4:0', name: 'Button', type: 'COMPONENT_SET', children: [idle, hover] }
  idle.parent = set
  hover.parent = set

  const result = await computeNodeStates(set as never, async () => null)

  assert.deepEqual(result.resolvedFrom, { id: '4:1', name: 'State=Standart' })
  assert.deepEqual(
    result.states.map((state) => [state.trigger, state.to.name]),
    [['ON_HOVER', 'State=Hover']]
  )
})
