import test from 'node:test'
import assert from 'node:assert/strict'
import './ops.ts'
import { OPS_BY_NAME } from './ops.ts'
import { validateParams } from './protocol.ts'

function setFigma(mock: Record<string, unknown>) {
  ;(globalThis as { figma?: unknown }).figma = mock
}

function rootWith(nodes: unknown[], pages: unknown[] = []) {
  return {
    children: pages,
    findAllWithCriteria({ types }: { types: string[] }) {
      return nodes.filter((node) => types.includes((node as { type: string }).type))
    },
  }
}

test('component.instances inventories used and unused local masters with placement links', async () => {
  const page = { id: 'p:1', name: 'Page', type: 'PAGE', parent: null, loadAsync: async () => {} }
  const frame = { id: 'f:1', name: 'Hero', type: 'FRAME', parent: page }
  const used = { id: 'c:1', key: 'used-key', name: 'Button', type: 'COMPONENT', parent: page, removed: false }
  const unused = { id: 'c:2', key: 'unused-key', name: 'Badge', type: 'COMPONENT', parent: page, removed: false }
  const instance = {
    id: 'i:1', name: 'Button', type: 'INSTANCE', parent: frame,
    getMainComponentAsync: async () => used,
  }
  const root = rootWith([used, unused, instance], [page])
  setFigma({ root, fileKey: 'file-key', skipInvisibleInstanceChildren: false, loadAllPagesAsync: async () => {} })

  const op = OPS_BY_NAME.get('component.instances')!
  const result = await op.run(validateParams(op.params, {})) as {
    instances: number
    unused: number
    inventory: Array<{ component: { id: string }; count: number; copies: Array<{ frame: { id: string }; link: string }> }>
  }
  assert.equal(result.instances, 1)
  assert.equal(result.unused, 1)
  assert.deepEqual(result.inventory.map((row) => [row.component.id, row.count]), [['c:1', 1], ['c:2', 0]])
  assert.equal(result.inventory[0].copies[0].frame.id, 'f:1')
  assert.equal(result.inventory[0].copies[0].link, 'https://www.figma.com/design/file-key/?node-id=i-1')
})

test('component.orphans separates deleted local masters from missing masters and ranks groups', async () => {
  const page = { id: 'p:1', name: 'Page', type: 'PAGE', parent: null, loadAsync: async () => {} }
  const dead = { id: 'c:dead', name: 'Old Button', type: 'COMPONENT', removed: true }
  const deleted = {
    id: 'i:1', name: 'Old Button', type: 'INSTANCE', parent: page,
    getMainComponentAsync: async () => dead,
  }
  const missing = {
    id: 'i:2', name: 'Library Card', type: 'INSTANCE', parent: page,
    getMainComponentAsync: async () => null,
  }
  const root = rootWith([deleted, missing], [page])
  setFigma({ root, skipInvisibleInstanceChildren: false, loadAllPagesAsync: async () => {} })

  const op = OPS_BY_NAME.get('component.orphans')!
  const result = await op.run({}) as { groups: number; orphans: Array<{ status: string; name: string; count: number }> }
  assert.equal(result.groups, 2)
  assert.deepEqual(
    result.orphans.map((group) => [group.status, group.name, group.count]).sort(),
    [['deleted', 'Old Button', 1], ['missing', 'Library Card', 1]]
  )
})

test('instance.swap accepts a component id and reports the native swap without rebuilding', async () => {
  const target = { id: 'c:2', key: 'target', name: 'New Button', type: 'COMPONENT', parent: null, removed: false }
  const old = { id: 'c:1', key: 'old', name: 'Old Button', type: 'COMPONENT', parent: null, removed: false }
  let swappedTo: unknown = null
  const instance = {
    id: 'i:1', name: 'Button', type: 'INSTANCE', parent: { type: 'PAGE' },
    overrides: [], componentProperties: {},
    getMainComponentAsync: async () => old,
    swapComponent(component: unknown) { swappedTo = component },
    setProperties() {},
  }
  setFigma({
    mixed: Symbol('mixed'),
    commitUndo() {},
    getNodeByIdAsync: async (id: string) => id === 'i:1' ? instance : id === 'c:2' ? target : null,
  })

  const op = OPS_BY_NAME.get('instance.swap')!
  const result = await op.run(validateParams(op.params, { nodes: ['i:1'], to: 'c:2', strategy: 'swap' })) as {
    succeeded: number
    results: Array<{ strategy: string; newId?: string }>
  }
  assert.equal(swappedTo, target)
  assert.equal(result.succeeded, 1)
  assert.equal(result.results[0].strategy, 'swap')
  assert.equal(result.results[0].newId, undefined)
})

test('instance.swap auto falls back to rebuild, returns newId, and keeps unsupported overrides separate', async () => {
  const children: unknown[] = []
  const parent = {
    type: 'FRAME', layoutMode: 'NONE', children,
    insertChild(index: number, node: unknown) { children.splice(index, 0, node) },
  }
  let oldRemoved = false
  const old = { id: 'c:1', key: 'old', name: 'Old', type: 'COMPONENT', parent: null, removed: false }
  const replacement = {
    id: 'i:2', name: 'New', type: 'INSTANCE', parent,
    overrides: [], componentProperties: {}, x: 0, y: 0, rotation: 0, visible: true, locked: false,
    opacity: 1, blendMode: 'PASS_THROUGH', constraints: { horizontal: 'MIN', vertical: 'MIN' },
    layoutAlign: 'INHERIT', layoutGrow: 0, layoutPositioning: 'AUTO',
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, width: 10, height: 10,
    reactions: [], getPluginDataKeys: () => [], getPluginData: () => '', setPluginData() {},
    resize(width: number, height: number) { this.width = width; this.height = height },
    setReactionsAsync: async () => {}, setProperties() {}, remove() {},
  }
  const target = {
    id: 'c:2', key: 'target', name: 'New', type: 'COMPONENT', parent: null, removed: false,
    createInstance: () => replacement,
  }
  const instance = {
    id: 'i:1', name: 'Old', type: 'INSTANCE', parent,
    overrides: [{ id: 'i:1', overriddenFields: ['boundVariables'] }], componentProperties: {},
    x: 4, y: 5, rotation: 0, visible: true, locked: false, opacity: 1, blendMode: 'PASS_THROUGH',
    constraints: { horizontal: 'MIN', vertical: 'MIN' }, layoutAlign: 'INHERIT', layoutGrow: 0,
    layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
    minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, width: 40, height: 20,
    reactions: [], getPluginDataKeys: () => [], getPluginData: () => '',
    getMainComponentAsync: async () => old,
    swapComponent() { throw new Error('native swap refused') },
    remove() { oldRemoved = true },
  }
  children.push(instance)
  setFigma({
    mixed: Symbol('mixed'), commitUndo() {},
    getNodeByIdAsync: async (id: string) => id === 'i:1' ? instance : id === 'c:2' ? target : null,
  })

  const op = OPS_BY_NAME.get('instance.swap')!
  const result = await op.run(validateParams(op.params, { nodes: ['i:1'], to: 'c:2', strategy: 'auto' })) as {
    succeeded: number
    results: Array<{ newId: string; strategy: string; fellBackBecause: string; lost: unknown[]; unsupported: unknown[] }>
  }
  assert.equal(oldRemoved, true)
  assert.equal(result.succeeded, 1)
  assert.equal(result.results[0].newId, 'i:2')
  assert.equal(result.results[0].strategy, 'rebuild')
  assert.match(result.results[0].fellBackBecause, /native swap refused/)
  assert.deepEqual(result.results[0].lost, [])
  assert.deepEqual(result.results[0].unsupported, [{ layer: 'Old', field: 'boundVariables' }])
})

test('instance.swap removes a partial replacement when rebuild property copying fails', async () => {
  const children: unknown[] = []
  const parent = {
    type: 'FRAME', layoutMode: 'NONE', children,
    insertChild(index: number, node: unknown) { children.splice(index, 0, node) },
  }
  let replacementRemoved = false
  let oldRemoved = false
  const replacement = {
    id: 'i:2', name: 'New', type: 'INSTANCE', parent,
    x: 0, y: 0, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    resize() { throw new Error('cannot resize in parent') },
    remove() { replacementRemoved = true; children.splice(children.indexOf(this), 1) },
  }
  const target = {
    id: 'c:2', key: 'target', name: 'New', type: 'COMPONENT', parent: null, removed: false,
    createInstance: () => replacement,
  }
  const instance = {
    id: 'i:1', name: 'Old', type: 'INSTANCE', parent,
    overrides: [], componentProperties: {}, x: 4, y: 5, rotation: 0, visible: true, locked: false,
    opacity: 1, blendMode: 'PASS_THROUGH', constraints: { horizontal: 'MIN', vertical: 'MIN' },
    layoutAlign: 'INHERIT', layoutGrow: 0, layoutPositioning: 'AUTO',
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, width: 40, height: 20,
    reactions: [], getPluginDataKeys: () => [], getPluginData: () => '',
    getMainComponentAsync: async () => null,
    remove() { oldRemoved = true },
  }
  children.push(instance)
  setFigma({
    mixed: Symbol('mixed'), commitUndo() {},
    getNodeByIdAsync: async (id: string) => id === 'i:1' ? instance : id === 'c:2' ? target : null,
  })

  const op = OPS_BY_NAME.get('instance.swap')!
  const result = await op.run(validateParams(op.params, { nodes: ['i:1'], to: 'c:2', strategy: 'rebuild' })) as {
    failed: number
  }
  assert.equal(result.failed, 1)
  assert.equal(replacementRemoved, true)
  assert.equal(oldRemoved, false)
  assert.deepEqual(children, [instance])
})

test('component.restore creates a master and reassigns every orphan in its group', async () => {
  const page = {
    id: 'p:1', name: 'Page', type: 'PAGE', parent: null, children: [] as unknown[],
    loadAsync: async () => {}, appendChild(node: unknown) { this.children.push(node) },
  }
  const dead = { id: 'c:dead', name: 'Old Card', type: 'COMPONENT', removed: true }
  const master = { id: 'c:new', key: 'new', name: '', type: 'COMPONENT', parent: page, removed: false, x: 0, y: 0 }
  let swappedTo: unknown = null
  const source = {
    id: 'i:1', name: 'Old Card', type: 'INSTANCE', parent: page, x: 10, y: 20, width: 100,
    overrides: [], componentProperties: {},
    getMainComponentAsync: async () => dead,
    clone: () => ({ detachInstance: () => ({ id: 'frame:clone', type: 'FRAME' }) }),
    swapComponent(component: unknown) { swappedTo = component },
    setProperties() {},
  }
  const root = rootWith([source], [page])
  setFigma({
    root, fileKey: null, skipInvisibleInstanceChildren: false, loadAllPagesAsync: async () => {},
    commitUndo() {}, getNodeByIdAsync: async (id: string) => id === 'i:1' ? source : null,
    createComponentFromNode: () => master,
  })

  const op = OPS_BY_NAME.get('component.restore')!
  const result = await op.run(validateParams(op.params, { restoreFrom: 'i:1' })) as {
    restored: number
    master: { id: string; name: string }
  }
  assert.equal(swappedTo, master)
  assert.equal(result.restored, 1)
  assert.deepEqual(result.master, { id: 'c:new', name: 'Old Card', type: 'COMPONENT', link: '?node-id=c-new' })
})

test('node.focus selects same-page nodes together and groups other pages under elsewhere', async () => {
  const pageA = { id: 'p:a', name: 'A', type: 'PAGE', parent: null, loadAsync: async () => {}, selection: [] as unknown[] }
  const pageB = { id: 'p:b', name: 'B', type: 'PAGE', parent: null, loadAsync: async () => {}, selection: [] as unknown[] }
  const one = { id: '1:1', name: 'One', type: 'FRAME', parent: pageA }
  const two = { id: '1:2', name: 'Two', type: 'FRAME', parent: pageA }
  const three = { id: '2:1', name: 'Three', type: 'FRAME', parent: pageB }
  let currentPage = pageB
  let scrolled: unknown[] = []
  setFigma({
    fileKey: null,
    get currentPage() { return currentPage },
    getNodeByIdAsync: async (id: string) => ({ '1:1': one, '1:2': two, '2:1': three } as Record<string, unknown>)[id] ?? null,
    setCurrentPageAsync: async (page: typeof pageA) => { currentPage = page },
    viewport: { scrollAndZoomIntoView(nodes: unknown[]) { scrolled = nodes } },
  })

  const op = OPS_BY_NAME.get('node.focus')!
  const result = await op.run(validateParams(op.params, { nodes: ['1:1', '1:2', '2:1'] })) as {
    selected: Array<{ id: string }>
    elsewhere: Array<{ page: { id: string }; nodes: unknown[] }>
  }
  assert.deepEqual(result.selected.map((node) => node.id), ['1:1', '1:2'])
  assert.deepEqual(pageA.selection, [one, two])
  assert.deepEqual(scrolled, [one, two])
  assert.equal(result.elsewhere[0].page.id, 'p:b')
  assert.equal(result.elsewhere[0].nodes.length, 1)
})
