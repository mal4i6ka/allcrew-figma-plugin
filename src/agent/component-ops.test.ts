/**
 * Components, their copies, and the repair for a main somebody deleted.
 *
 * The document here is plain objects: these ops are graph walks and property writes, and what
 * has to be proven is the DECISIONS — which copies count as orphaned, which copy is worth
 * rebuilding a main from, and above all that an override survives a repoint. Figma's own
 * `swapComponent` preserves overrides "with the same heuristics as the UI", so the failure this
 * suite is written against is the silent one: a swap that quietly resets a text layer and a
 * report that still says it worked.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'
import { classifyMain, sameValue } from './component-ops.ts'
import { validateParams } from './protocol.ts'

/* ------------------------------------------------------------- fake document */

type Fake = Record<string, any>

const MIXED = Symbol('figma.mixed')
let nextId = 0

function node(props: Fake): Fake {
  const built: Fake = {
    visible: true,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    parent: null,
    children: [],
    getPluginDataKeys: () => [],
    getPluginData: () => '',
    ...props,
  }
  for (const child of built.children) child.parent = built
  if (built.type === 'FRAME' || built.type === 'INSTANCE' || built.type === 'COMPONENT') {
    built.insertChild = (index: number, child: Fake) => {
      if (child.parent) child.parent.children = child.parent.children.filter((one: Fake) => one !== child)
      built.children.splice(index, 0, child)
      child.parent = built
    }
    built.appendChild = (child: Fake) => built.insertChild(built.children.length, child)
    built.remove = () => {
      if (built.parent) built.parent.children = built.parent.children.filter((one: Fake) => one !== built)
      built.parent = null
      built.removed = true
    }
    built.resize = (w: number, h: number) => {
      built.width = w
      built.height = h
    }
    built.resizeWithoutConstraints = built.resize
  }
  return built
}

function text(name: string, characters: string): Fake {
  return node({ id: `t:${name}:${++nextId}`, name, type: 'TEXT', characters })
}

/** An instance whose `swapComponent` behaves like Figma's: the subtree becomes the new main's,
 * and only the overrides the heuristics recognise come along. `keeps` names those. */
function instance(props: Fake & { main: Fake | null; keeps?: string[] }): Fake {
  const built = node({ type: 'INSTANCE', componentProperties: {}, overrides: [], ...props })
  built.getMainComponentAsync = async () => built.main
  built.setProperties = (values: Record<string, string | boolean>) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in built.componentProperties)) throw new Error(`no property ${key}`)
      built.componentProperties[key] = { type: 'TEXT', value }
    }
  }
  built.swapComponent = (main: Fake) => {
    if (built.swapRefuses) throw new Error(built.swapRefuses)
    built.main = main
    built.getMainComponentAsync = async () => main
    /* The heuristic: children are rebuilt from the new main, and a field not named in `keeps`
     * goes back to what the main says. This is the exact behaviour the repair pass exists for. */
    const keeps = new Set(built.keeps ?? [])
    built.children = main.children.map((child: Fake) => {
      const mirror = node({ ...child, id: `${built.id};${child.id}`, children: [], parent: built })
      const was = built.children.find((one: Fake) => one.name === child.name)
      if (was && keeps.has(child.name)) mirror.characters = was.characters
      return mirror
    })
    built.componentProperties = { ...(main.componentProperties ?? {}) }
  }
  built.clone = () => {
    const copy = node({
      ...built,
      id: `${built.id}:clone`,
      parent: null,
      children: built.children.map((child: Fake) => node({ ...child, id: `${child.id}:clone`, children: [] })),
    })
    copy.detachInstance = () => {
      copy.type = 'FRAME'
      return copy
    }
    return copy
  }
  built.detachInstance = () => {
    built.type = 'FRAME'
    return built
  }
  return built
}

function component(props: Fake): Fake {
  const built = node({ type: 'COMPONENT', key: '', remote: false, componentProperties: {}, ...props })
  built.createInstance = () => {
    const made = instance({
      id: `${built.id}:i${++nextId}`,
      name: built.name,
      main: built,
      children: built.children.map((child: Fake) => node({ ...child, id: `${child.id}:m`, children: [] })),
      componentProperties: { ...built.componentProperties },
    })
    return made
  }
  return built
}

function page(id: string, name: string, children: Fake[]): Fake {
  const built = node({ id, name, type: 'PAGE', children, loadAsync: async () => {} })
  built.insertChild = (index: number, child: Fake) => {
    if (child.parent) child.parent.children = child.parent.children.filter((one: Fake) => one !== child)
    built.children.splice(index, 0, child)
    child.parent = built
  }
  built.appendChild = (child: Fake) => built.insertChild(built.children.length, child)
  return built
}

function mount(pages: Fake[], extra: Fake = {}): Map<string, Fake> {
  const byId = new Map<string, Fake>()
  const index = (one: Fake) => {
    byId.set(one.id, one)
    for (const child of one.children ?? []) {
      child.parent = one
      index(child)
    }
  }
  const root = node({ id: '0:0', type: 'DOCUMENT', name: 'Document', children: pages })
  for (const one of pages) {
    one.parent = root
    index(one)
  }
  const created: Fake[] = []
  ;(globalThis as Fake).figma = {
    root,
    currentPage: pages[0],
    mixed: MIXED,
    skipInvisibleInstanceChildren: false,
    fileKey: null,
    loadAllPagesAsync: async () => {},
    commitUndo: () => {},
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? created.find((one) => one.id === id) ?? null,
    loadFontAsync: async () => {},
    createComponentFromNode: (frame: Fake) => {
      frame.type = 'COMPONENT'
      frame.key = 'restored-key'
      frame.remote = false
      frame.createInstance = component({ id: frame.id, name: frame.name, children: frame.children }).createInstance
      created.push(frame)
      byId.set(frame.id, frame)
      return frame
    },
    ...extra,
  }
  return byId
}

async function run(op: string, params: Record<string, unknown>): Promise<Fake> {
  const def = OPS_BY_NAME.get(op)
  assert.ok(def, `${op} is not registered`)
  return (await def.run(validateParams(def.params, params))) as Fake
}

/* ------------------------------------------------------------------- rules */

test('a main with no page is deleted, a library main is not, and an unresolvable one is missing', () => {
  assert.equal(classifyMain(null, false), 'missing')
  assert.equal(classifyMain({ removed: false, remote: false }, true), 'live')
  // The whole diagnosis: Figma unparents a deleted main instead of removing it, and the
  // instances go on rendering from a component that is on no page.
  assert.equal(classifyMain({ removed: false, remote: false }, false), 'deleted')
  assert.equal(classifyMain({ removed: true, remote: false }, true), 'deleted')
  // A library main is never on a page of THIS file — the same test would call every library
  // instance an orphan.
  assert.equal(classifyMain({ removed: false, remote: true }, false), 'live')
})

test('a mixed value never counts as preserved, so nothing claims an override it cannot read', () => {
  ;(globalThis as Fake).figma = { mixed: MIXED }
  assert.equal(sameValue(MIXED, 'Sale'), false)
  assert.equal(sameValue(MIXED, MIXED), false)
  assert.equal(sameValue('Sale', MIXED), false)
  assert.equal(sameValue([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]), true)
  assert.equal(sameValue([{ type: 'SOLID' }], [{ type: 'IMAGE' }]), false)
})

/* ----------------------------------------------------------------- census */

test('component.instances counts copies per component, splits nested from placed, and names the unused', async () => {
  const button = component({ id: 'c:1', name: 'Button' })
  const card = component({ id: 'c:2', name: 'Card' })
  const orphanMain = component({ id: 'c:dead', name: 'Chip', parent: null })
  const nested = instance({ id: 'i:3', name: 'Button', main: button })
  mount([
    page('p:1', 'Screens', [
      instance({ id: 'i:1', name: 'Button', main: button }),
      instance({ id: 'i:2', name: 'Card', main: card, children: [nested] }),
      instance({ id: 'i:4', name: 'Chip', main: orphanMain }),
    ]),
    page('p:2', 'Library', [button, card]),
  ])

  const inventory = await run('component.instances', {})
  assert.equal(inventory.mode, 'inventory')
  assert.equal(inventory.totals.instances, 4)
  assert.equal(inventory.totals.orphans, 1, 'the copy of the deleted Chip is counted as an orphan')
  const byName = new Map(inventory.components.map((row: Fake) => [row.component.name, row]))
  assert.equal(byName.get('Button').instances, 2)
  assert.equal(byName.get('Button').nested, 1, 'the copy inside the Card is a mirror, not a placed copy')
  assert.equal(byName.get('Button').placed, 1)
  assert.deepEqual(
    inventory.unused.map((row: Fake) => row.name),
    [],
    'every local component here has a copy'
  )

  const detail = await run('component.instances', { nodeId: 'c:1' })
  assert.equal(detail.mode, 'component')
  assert.equal(detail.components.length, 1)
  assert.deepEqual(
    detail.components[0].rows.map((row: Fake) => row.id),
    ['i:1'],
    'nested copies stay out of the rows until nested: true asks for them'
  )
  assert.equal(detail.components[0].rows[0].link, '?node-id=i-1')

  const withNested = await run('component.instances', { nodeId: 'c:1', nested: true })
  assert.deepEqual(
    withNested.components[0].rows.map((row: Fake) => row.id),
    ['i:1', 'i:3']
  )
})

test('the per-page counts cover every copy, not just the rows that fit under limit', async () => {
  const button = component({ id: 'c:1', name: 'Button' })
  const copies = [1, 2, 3, 4, 5].map((n) => instance({ id: `i:${n}`, name: 'Button', main: button }))
  mount([page('p:1', 'Screens', copies), page('p:2', 'Library', [button])])

  // Measured on a live file first: 20 copies on one page reported as 2, because the page tally
  // was taken off the truncated row list instead of the census.
  const report = await run('component.instances', { nodeId: 'c:1', limit: 2 })
  assert.equal(report.components[0].instances, 5)
  assert.equal(report.components[0].rows.length, 2)
  assert.deepEqual(report.components[0].byPage, [{ name: 'Screens', count: 5 }])
  assert.equal(report.components[0].truncated, true)
})

test('component.instances lists a component nothing instantiates', async () => {
  const used = component({ id: 'c:1', name: 'Button' })
  const never = component({ id: 'c:2', name: 'Legacy Banner' })
  mount([page('p:1', 'Screens', [instance({ id: 'i:1', name: 'Button', main: used })]), page('p:2', 'Library', [used, never])])

  const inventory = await run('component.instances', {})
  assert.deepEqual(
    inventory.unused.map((row: Fake) => row.name),
    ['Legacy Banner']
  )
})

/* ---------------------------------------------------------------- orphans */

test('component.orphans groups copies by the dead main and ranks rebuild sources by structure kept', async () => {
  const dead = component({ id: 'c:dead', name: 'Chip', parent: null })
  const alive = component({ id: 'c:1', name: 'Button' })
  const rich = instance({
    id: 'i:rich',
    name: 'Chip',
    main: dead,
    children: [text('Label', 'Sale'), text('Icon', '★')],
    overrides: [],
  })
  const thin = instance({ id: 'i:thin', name: 'Chip', main: dead, children: [text('Label', 'New')] })
  mount([
    page('p:1', 'Screens', [rich, thin, instance({ id: 'i:ok', name: 'Button', main: alive })]),
    page('p:2', 'Library', [alive]),
  ])

  const report = await run('component.orphans', {})
  assert.equal(report.totals.deadMains, 1)
  assert.equal(report.totals.orphanInstances, 2)
  assert.equal(report.groups[0].status, 'deleted')
  assert.equal(report.groups[0].keyedBy, 'main')
  assert.deepEqual(
    report.groups[0].restoreFrom.map((row: Fake) => row.id),
    ['i:rich', 'i:thin'],
    'the copy that kept the most structure is the one worth rebuilding the main from'
  )
})

test('component.orphans keys an unresolvable main by name, because there is no id to key on', async () => {
  const lost = instance({ id: 'i:1', name: 'Avatar', main: null })
  mount([page('p:1', 'Screens', [lost])])

  const report = await run('component.orphans', { detached: false })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].status, 'missing')
  assert.equal(report.groups[0].keyedBy, 'name')
  assert.equal(report.groups[0].main.name, 'Avatar')
})
test('component.orphans reports detached local casualties separately from unverified library origins', async () => {
  const local = node({
    id: 'f:local',
    name: 'Detached local',
    type: 'FRAME',
    detachedInfo: { componentId: 'c:gone' },
  })
  const library = node({
    id: 'f:library',
    name: 'Detached library',
    type: 'FRAME',
    detachedInfo: { componentKey: 'library-key' },
  })
  mount([page('p:1', 'Screens', [local, library])])

  const report = await run('component.orphans', {})
  assert.equal(report.totals.detachedFrames, 1)
  assert.equal(report.totals.detachedUnverified, 1)
  assert.deepEqual(report.detached.map((row: Fake) => [row.id, row.verified]), [
    ['f:local', true],
    ['f:library', false],
  ])
})


/* -------------------------------------------------------------------- swap */

test('instance.swap writes back the override Figma\'s own heuristics dropped', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Label'), text('Caption', 'Caption')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({
    id: 'i:1',
    name: 'Chip',
    main: old,
    children: [text('Label', 'Sale'), text('Caption', 'ends today')],
    keeps: ['Label'], // the swap keeps Label's text and resets Caption — the silent failure
  })
  copy.overrides = copy.children.map((child: Fake) => ({ id: child.id, overriddenFields: ['characters'] }))
  mount([page('p:1', 'Screens', [copy]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new' })
  assert.equal(report.repointed, 1)
  const row = report.rows[0]
  assert.equal(row.method, 'swap')
  assert.equal(row.overrides.kept, 1, 'Label survived on its own')
  assert.deepEqual(row.overrides.restored, [
    { layer: 'Caption', path: [1], fields: ['characters'], matchedBy: 'path' },
  ])
  assert.deepEqual(row.overrides.lost, [])
  assert.deepEqual(
    copy.children.map((child: Fake) => child.characters),
    ['Sale', 'ends today'],
    'the copy still reads the way the designer wrote it'
  )
})

test('instance.swap remaps component property keys by their designer-visible name', async () => {
  const target = component({
    id: 'c:new',
    name: 'Chip v2',
    componentProperties: { 'Label#new': { type: 'TEXT', value: 'Default' } },
  })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({
    id: 'i:1',
    name: 'Chip',
    main: old,
    componentProperties: { 'Label#old': { type: 'TEXT', value: 'Sale' } },
  })
  mount([page('p:1', 'Screens', [copy]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new' })
  assert.equal(copy.componentProperties['Label#new'].value, 'Sale')
  assert.deepEqual(report.rows[0].overrides.properties.restored, ['Label#new'])
})

test('instance.swap can deliberately reset overrides to the new main defaults', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Default')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({
    id: 'i:1',
    name: 'Chip',
    main: old,
    children: [text('Label', 'Sale')],
    keeps: [],
  })
  copy.overrides = [{ id: copy.children[0].id, overriddenFields: ['characters'] }]
  mount([page('p:1', 'Screens', [copy]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new', preserveOverrides: false })
  assert.equal(copy.children[0].characters, 'Default')
  assert.match(report.rows[0].note, /not preserved/)
})

test('instance.swap names the override it could not carry instead of reporting a clean run', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Label')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({
    id: 'i:1',
    name: 'Chip',
    main: old,
    children: [text('Label', 'Sale'), text('Badge', '3')],
  })
  copy.overrides = copy.children.map((child: Fake) => ({ id: child.id, overriddenFields: ['characters'] }))
  mount([page('p:1', 'Screens', [copy]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new' })
  const lost = report.rows[0].overrides.lost
  assert.equal(lost.length, 1)
  assert.equal(lost[0].layer, 'Badge')
  assert.match(lost[0].reason, /no layer at that position or by that name/)
})

test('instance.swap falls back to the rebuild when Figma refuses the swap, and says why', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Label')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({ id: 'i:1', name: 'Chip', main: old, children: [text('Label', 'Sale')] })
  copy.overrides = [{ id: copy.children[0].id, overriddenFields: ['characters'] }]
  copy.swapRefuses = 'cannot swap this instance'
  const screens = page('p:1', 'Screens', [node({ id: 'f:0', name: 'Spacer', type: 'FRAME' }), copy])
  mount([screens, page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new' })
  const row = report.rows[0]
  assert.equal(row.method, 'rebuild')
  assert.equal(row.fellBackBecause, 'cannot swap this instance')
  assert.ok(row.newId && row.newId !== 'i:1', 'a rebuild is a new node, and the report says so')
  assert.deepEqual(
    screens.children.map((child: Fake) => child.id),
    ['f:0', row.newId],
    'the replacement sits exactly where the old copy did'
  )
  assert.equal(screens.children[1].children[0].characters, 'Sale', 'the override was replayed onto the fresh copy')
})

test('instance.swap refuses to rebuild a copy nested inside another instance', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Label')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const inner = instance({ id: 'i:inner', name: 'Chip', main: old, children: [text('Label', 'Sale')] })
  const outer = instance({ id: 'i:outer', name: 'Card', main: component({ id: 'c:card', name: 'Card' }), children: [inner] })
  mount([page('p:1', 'Screens', [outer]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:inner'], to: 'c:new', strategy: 'rebuild' })
  assert.equal(report.rows[0].ok, false)
  assert.match(report.rows[0].error, /nested inside an instance/)
})

test('instance.swap dry run touches nothing', async () => {
  const target = component({ id: 'c:new', name: 'Chip v2', children: [text('Label', 'Label')] })
  const old = component({ id: 'c:old', name: 'Chip' })
  const copy = instance({ id: 'i:1', name: 'Chip', main: old, children: [text('Label', 'Sale')] })
  mount([page('p:1', 'Screens', [copy]), page('p:2', 'Library', [target, old])])

  const report = await run('instance.swap', { nodes: ['i:1'], to: 'c:new', dryRun: true })
  assert.equal(report.repointed, 0)
  assert.equal(report.rows[0].repointed, false)
  assert.equal(await copy.getMainComponentAsync(), old, 'the copy still points at the main it had')
})

/* ----------------------------------------------------------------- restore */

test('component.restore refuses a copy whose main is alive', async () => {
  const alive = component({ id: 'c:1', name: 'Button' })
  mount([page('p:1', 'Screens', [instance({ id: 'i:1', name: 'Button', main: alive })]), page('p:2', 'Library', [alive])])

  await assert.rejects(() => run('component.restore', { restoreFrom: 'i:1' }), /still has its main/)
})

test('component.restore dry run names every copy it would relink and writes nothing', async () => {
  const dead = component({ id: 'c:dead', name: 'Chip', parent: null })
  const one = instance({ id: 'i:1', name: 'Chip', main: dead, children: [text('Label', 'Sale')] })
  const two = instance({ id: 'i:2', name: 'Chip', main: dead, children: [text('Label', 'New')] })
  const screens = page('p:1', 'Screens', [one, two])
  mount([screens])

  const plan = await run('component.restore', { restoreFrom: 'i:1', dryRun: true })
  assert.equal(plan.restored, false)
  assert.deepEqual(
    plan.relink.map((row: Fake) => row.id),
    ['i:1', 'i:2']
  )
  assert.equal(plan.dead.matchedBy, 'main')
  assert.equal(screens.children.length, 2, 'no component was created')
})

test('component.restore rebuilds the main from a copy and relinks the siblings with their own overrides', async () => {
  const dead = component({ id: 'c:dead', name: 'Chip', parent: null })
  const source = instance({ id: 'i:1', name: 'Chip', main: dead, children: [text('Label', 'Sale'), text('Caption', 'ends today')] })
  const sibling = instance({
    id: 'i:2',
    name: 'Chip',
    main: dead,
    children: [text('Label', 'New'), text('Caption', 'this week')],
    keeps: ['Label'], // the swap drops Caption — the restore has to put it back
  })
  sibling.overrides = sibling.children.map((child: Fake) => ({ id: child.id, overriddenFields: ['characters'] }))
  const screens = page('p:1', 'Screens', [source, sibling])
  mount([screens])

  const report = await run('component.restore', { restoreFrom: 'i:1', name: 'Chip' })
  assert.equal(report.restored, true)
  assert.equal(report.relinked, 2)
  assert.equal(report.component.name, 'Chip')
  assert.equal(report.failed, 0)

  const restored = screens.children.find((child: Fake) => child.type === 'COMPONENT')
  assert.ok(restored, 'the rebuilt main is on the page')
  assert.equal(await sibling.getMainComponentAsync(), restored, 'the sibling points at the restored main')
  assert.deepEqual(
    sibling.children.map((child: Fake) => child.characters),
    ['New', 'this week'],
    'the sibling kept its own copy, not the source copy it was rebuilt from'
  )
})
