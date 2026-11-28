import test from 'node:test'
import assert from 'node:assert/strict'
import { ARRANGE_OPS, insideInstance, screenDestination, screenSource, type Placeable } from './arrange-ops.ts'
import { OPS_BY_NAME } from './ops.ts'
import { validateParams } from './protocol.ts'

const n = (id: string, type: string, parent: Placeable | null = null, name = id): Placeable => ({ id, type, parent, name })

/* --------------------------------------------------------------- policy */

test('a layer inside an instance can be neither moved nor copied', () => {
  const page = n('0:1', 'PAGE')
  const inst = n('I1:1', 'INSTANCE', page)
  const label = n('I1:1;2:2', 'TEXT', inst, 'Label')
  assert.equal(insideInstance(label), true)
  assert.throws(() => screenSource(label, 'move'), /belongs to the main component/)
  assert.throws(() => screenSource(label, 'copy'), /copy the instance/)
  // The instance itself moves and copies like anything else.
  assert.doesNotThrow(() => screenSource(inst, 'move'))
})

test('a destination must hold layers, sit outside instances, and not be the node or inside it', () => {
  const page = n('0:1', 'PAGE')
  const frame = n('1:1', 'FRAME', page)
  const child = n('1:2', 'FRAME', frame)
  const text = n('1:3', 'TEXT', page)
  const inst = n('I5:1', 'INSTANCE', page)
  assert.throws(() => screenDestination(text, null), /cannot hold layers/)
  assert.throws(() => screenDestination(inst, null), /cannot hold layers|inside an instance/)
  assert.throws(() => screenDestination(child, frame), /inside the node/)
  assert.throws(() => screenDestination(frame, frame), /the node itself/)
  assert.throws(() => screenDestination(n('9:1', 'COMPONENT_SET', page), frame), /only its variants/)
  assert.doesNotThrow(() => screenDestination(page, frame))
})

test('both ops are registered, documented and gated as writes', () => {
  for (const name of ['node.move', 'node.duplicate']) {
    const op = OPS_BY_NAME.get(name)
    assert.ok(op, name)
    assert.equal(op!.mutates, true)
    assert.ok((op!.agent ?? '').length > 40)
  }
  assert.equal(ARRANGE_OPS.length, 2)
})

/* --------------------------------------------------------------- runs on a mock document */

type Mock = Record<string, any>

function doc() {
  const mk = (id: string, type: string, extra: Mock = {}): Mock => ({ id, type, name: id, x: 0, y: 0, width: 100, height: 50, children: undefined, parent: null, removed: false, ...extra })
  const nodes = new Map<string, Mock>()
  const container = (node: Mock) => {
    node.children = []
    node.appendChild = (c: Mock) => node.insertChild(node.children.length, c)
    node.insertChild = (i: number, c: Mock) => {
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1)
      node.children.splice(i, 0, c)
      c.parent = node
    }
    return node
  }
  const page = container(mk('0:1', 'PAGE', { loadAsync: async () => {} }))
  const a = container(mk('1:1', 'FRAME', { absoluteTransform: [[1, 0, 100], [0, 1, 100]] }))
  const b = container(mk('2:1', 'FRAME', { absoluteTransform: [[1, 0, 1000], [0, 1, 100]] }))
  const card = mk('1:2', 'RECTANGLE', { x: 10, y: 20, absoluteTransform: [[1, 0, 110], [0, 1, 120]] })
  page.appendChild(a); page.appendChild(b); a.appendChild(card)
  card.clone = () => { const c = mk('9:9', 'RECTANGLE', { x: card.x, y: card.y, absoluteTransform: card.absoluteTransform }); nodes.set(c.id, c); return c }
  for (const x of [page, a, b, card]) nodes.set(x.id, x)
  let undo = 0
  ;(globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null, commitUndo: () => undo++ }
  return { page, a, b, card, undos: () => undo }
}

test('node.move into another frame keeps the node where it was on the canvas', async () => {
  const d = doc()
  const op = OPS_BY_NAME.get('node.move')!
  const r = (await op.run(validateParams(op.params, { nodes: [{ node: '1:2', parent: '2:1' }] }))) as Mock
  assert.equal(r.moved, 1)
  assert.equal(d.card.parent.id, '2:1')
  // Absolute 110,120 inside a frame that starts at 1000,100.
  assert.deepEqual([d.card.x, d.card.y], [-890, 20])
  assert.equal(r.results[0].before.parent.id, '1:1')
  assert.equal(r.results[0].after.parent.id, '2:1')
  assert.equal(d.undos(), 1)
})

test('node.move dry run moves nothing, and a refused row does not stop the others', async () => {
  const d = doc()
  const op = OPS_BY_NAME.get('node.move')!
  const r = (await op.run(validateParams(op.params, { nodes: [{ node: '1:1', parent: '1:2' }, { node: '1:2', parent: '2:1' }], dryRun: true }))) as Mock
  assert.equal(r.failed, 1)
  assert.match(r.results[0].error, /cannot hold layers/)
  assert.equal(r.results[1].to.parent.id, '2:1')
  assert.equal(d.card.parent.id, '1:1')
  assert.equal(d.undos(), 0)
})

test('node.duplicate pastes beside the source, stepped aside, and reports the new id', async () => {
  const d = doc()
  const op = OPS_BY_NAME.get('node.duplicate')!
  const r = (await op.run(validateParams(op.params, { nodes: [{ node: '1:2', name: 'Card copy' }] }))) as Mock
  assert.equal(r.copied, 1)
  assert.equal(r.results[0].node, '9:9')
  assert.equal(r.results[0].name, 'Card copy')
  assert.deepEqual(d.a.children.map((c: Mock) => c.id), ['1:2', '9:9'])
  assert.equal(r.results[0].x, 10 + 100 + 40)
})

test('node.duplicate refuses a component set unless asked to clone mains', async () => {
  doc()
  const set = { id: '7:1', type: 'COMPONENT_SET', name: 'Buttons', parent: { id: '0:1', type: 'PAGE', parent: null } }
  ;(globalThis as { figma?: Mock }).figma!.getNodeByIdAsync = async () => set
  const op = OPS_BY_NAME.get('node.duplicate')!
  const r = (await op.run(validateParams(op.params, { nodes: ['7:1'], dryRun: true }))) as Mock
  assert.match(r.results[0].error, /components: "clone"/)
})
