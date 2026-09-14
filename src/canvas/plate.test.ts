import test from 'node:test'
import assert from 'node:assert/strict'
import { exportPlate } from './plate.ts'

function setFigma(mock: { commitUndo: () => void }) {
  ;(globalThis as { figma?: unknown }).figma = mock
}

interface FakeExportSettings {
  format: string
  constraint: { type: string; value: number }
}

interface FakeExportCall {
  receiver: FakeNode
  settings: FakeExportSettings
}

/** A minimal duck-typed live node — same shape unit tests across this repo use in place of a
 * real Figma `SceneNode` (see `agent/context-assets.test.ts`'s `FakeSceneNode`). Every node
 * carries the full set of members `exportPlate` might touch on any node it walks, even where a
 * given test node never exercises them, so one interface covers the page, the auto-layout
 * frame, the export target, and its child alike. */
interface FakeNode {
  id: string
  name: string
  type: string
  visible: boolean
  x: number
  y: number
  removed: boolean
  children: FakeNode[]
  parent: FakeNode | null
  absoluteTransform: [[number, number, number], [number, number, number]]
  appendChild: (child: FakeNode) => void
  clone: () => FakeNode
  exportAsync: (settings: FakeExportSettings) => Promise<Uint8Array>
  remove: () => void
}

function reparent(container: FakeNode, child: FakeNode): void {
  if (child.parent) {
    const at = child.parent.children.indexOf(child)
    if (at >= 0) child.parent.children.splice(at, 1)
  }
  child.parent = container
  container.children.push(child)
}

function makeNode(id: string, name: string, type: string): FakeNode {
  const node: FakeNode = {
    id,
    name,
    type,
    visible: true,
    x: 0,
    y: 0,
    removed: false,
    children: [],
    parent: null,
    absoluteTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    appendChild: (child) => reparent(node, child),
    clone: () => {
      throw new Error(`${name} was never meant to be cloned in this test`)
    },
    exportAsync: () => {
      throw new Error(`${name} was never meant to be exported in this test`)
    },
    remove: () => {
      if (node.parent) {
        const at = node.parent.children.indexOf(node)
        if (at >= 0) node.parent.children.splice(at, 1)
      }
      node.parent = null
      node.removed = true
    },
  }
  return node
}

/** A page holding an auto-layout frame holding a card (the export target) holding a badge (the
 * child a clean plate must not bake in). `card.clone()` mirrors Figma's own default placement —
 * dropped into the same parent as the original, right next to it — closely enough for
 * `exportPlate` to actually have to move it away before this test can tell "parked on the page"
 * apart from "left sitting in the auto-layout frame". */
function makeTree(options: { exportFails?: boolean } = {}): {
  page: FakeNode
  frame: FakeNode
  card: FakeNode
  badge: FakeNode
  calls: FakeExportCall[]
} {
  const calls: FakeExportCall[] = []

  const page = makeNode('0:1', 'Page 1', 'PAGE')
  const frame = makeNode('1:1', 'Auto layout frame', 'FRAME')
  const card = makeNode('1:2', 'Card', 'INSTANCE')
  const badge = makeNode('1:3', 'Badge', 'TEXT')

  page.appendChild(frame)
  frame.appendChild(card)
  card.appendChild(badge)
  card.x = 40
  card.y = 60
  card.absoluteTransform = [
    [1, 0, 140],
    [0, 1, 260],
  ]

  function cloneDeep(source: FakeNode): FakeNode {
    const copy = makeNode(`${source.id}#clone`, source.name, source.type)
    copy.x = source.x
    copy.y = source.y
    for (const child of source.children) copy.appendChild(cloneDeep(child))
    return copy
  }

  card.clone = () => {
    const copy = cloneDeep(card)
    // Figma's own clone() drops the copy into the same parent as the original.
    frame.appendChild(copy)
    copy.exportAsync = async (settings) => {
      calls.push({ receiver: copy, settings })
      if (options.exportFails) throw new Error('exportAsync boom')
      return new Uint8Array([9, 9, 9])
    }
    return copy
  }

  return { page, frame, card, badge, calls }
}

function visibilityFlags(node: FakeNode): boolean[] {
  return [node.visible, ...node.children.flatMap(visibilityFlags)]
}

test('exportPlate exports a clone with every descendant hidden, restores its position on the page, and leaves no trace behind', async () => {
  const { page, frame, card, badge, calls } = makeTree()
  let commits = 0
  setFigma({ commitUndo: () => { commits += 1 } })

  // `card` is a hand-built duck-typed double, structurally close to `SceneNode` but not the
  // real ambient type — this is the one boundary cast, not a per-property one.
  const target = card as unknown as SceneNode
  const bytes = await exportPlate(target, { format: 'PNG', constraint: { type: 'SCALE', value: 2 } })

  assert.deepEqual([...bytes], [9, 9, 9])
  assert.equal(calls.length, 1)
  const clone = calls[0].receiver
  assert.notEqual(clone, card, 'exportAsync ran on the clone, not the live node')
  assert.deepEqual(calls[0].settings, { format: 'PNG', constraint: { type: 'SCALE', value: 2 } })

  // Every descendant of the clone was hidden before export — the clone itself stays visible
  // (there is nothing wrong with the plate's own pixels, only its children's).
  assert.equal(clone.visible, true)
  assert.deepEqual(visibilityFlags(clone.children[0]), [false])

  // The original document is untouched: the live badge never had its visibility flipped.
  assert.equal(badge.visible, true)

  // Position was restored from the original's absolute transform once the clone landed on the
  // page (a direct page child's local x/y is already the absolute position).
  assert.equal(clone.x, 140)
  assert.equal(clone.y, 260)

  // No residue anywhere: the auto-layout frame holds only the original card, and the page —
  // the clone's temporary home — ends up holding only the frame it always had, nothing more.
  assert.deepEqual(frame.children, [card])
  assert.deepEqual(page.children, [frame])
  assert.equal(clone.removed, true)

  assert.equal(commits, 1)
})

test('exportPlate deletes the clone even when exportAsync throws', async () => {
  const { page, frame, card } = makeTree({ exportFails: true })
  setFigma({ commitUndo: () => {} })

  const target = card as unknown as SceneNode // same duck-typed double as above
  await assert.rejects(
    () => exportPlate(target, { format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
    /exportAsync boom/
  )

  // The clone is gone whether or not the render itself succeeded.
  assert.deepEqual(frame.children, [card])
  assert.deepEqual(page.children, [frame])
})

test('exportPlate refuses a node with no page to clone onto', async () => {
  const detached = makeNode('9:9', 'Floating', 'FRAME')
  setFigma({ commitUndo: () => {} })

  const target = detached as unknown as SceneNode // same duck-typed double as above
  await assert.rejects(
    () => exportPlate(target, { format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
    /not on a page/
  )
})
