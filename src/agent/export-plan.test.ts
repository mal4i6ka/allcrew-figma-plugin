// `ops.ts` first — the registry and the op modules import each other (see context-ops.test.ts).
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'

interface FakeNode {
  id: string
  name: string
  type: string
  visible?: boolean
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number }
  fills?: Array<{ type: string; visible?: boolean }>
  exportSettings?: Array<{ format: string }>
  children?: FakeNode[]
}

function setFigma(root: FakeNode) {
  const index = new Map<string, FakeNode>()
  const walk = (node: FakeNode) => {
    index.set(node.id, node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  ;(globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async (id: string) => index.get(id) ?? null,
  }
}

const boxOf = (width: number, height: number) => ({ x: 0, y: 0, width, height })

async function plan(nodeId: string, scale = 2) {
  const op = OPS_BY_NAME.get('export.plan')!
  return (await op.run({ nodeId, scale })) as {
    strategy: string
    paintsBitmap: boolean
    children: { total: number; marked: number; allMarked: boolean }
    density: { wanted: number; fits: number; steppedDown: boolean }
    calls: Array<{ op: string; params: Record<string, unknown> }>
  }
}

test('a photo slot whose children are all marked exports as a plate plus vectors', async () => {
  setFigma({
    id: '1:1',
    name: 'Img_hero',
    type: 'FRAME',
    absoluteBoundingBox: boxOf(636, 720),
    fills: [{ type: 'IMAGE' }],
    children: [
      { id: '1:2', name: 'Interface 1', type: 'FRAME', exportSettings: [{ format: 'SVG' }] },
      { id: '1:3', name: 'Interface 2', type: 'FRAME', exportSettings: [{ format: 'SVG' }] },
    ],
  })
  const result = await plan('1:1')

  assert.equal(result.strategy, 'plate+vector')
  assert.deepEqual(result.children, { total: 2, marked: 2, allMarked: true })
  // The plate must hide the children, or the vector would be drawn twice.
  assert.equal(result.calls[0].params.command, 'NODE_EXPORT')
  assert.equal((result.calls[0].params.params as { withoutChildren?: boolean }).withoutChildren, true)
  assert.deepEqual((result.calls[1].params as { nodes: string[] }).nodes, ['1:2', '1:3'])
})

test('half-marked children fall back to one flat render, and say why', async () => {
  setFigma({
    id: '2:1',
    name: 'Img',
    type: 'FRAME',
    absoluteBoundingBox: boxOf(636, 720),
    fills: [{ type: 'IMAGE' }],
    children: [
      { id: '2:2', name: 'badge', type: 'FRAME', exportSettings: [{ format: 'SVG' }] },
      { id: '2:3', name: 'photo card', type: 'FRAME' },
    ],
  })
  const result = await plan('2:1')

  assert.equal(result.strategy, 'raster')
  assert.equal(result.calls.length, 1)
  assert.equal((result.calls[0].params.params as { withoutChildren?: boolean }).withoutChildren, undefined)
  assert.match(String((result.calls[0] as { why?: string }).why), /only some children are marked/)
})

test('a frame too large for one answer is planned at a lower density', async () => {
  setFigma({
    id: '3:1',
    name: 'Img_hero',
    type: 'FRAME',
    absoluteBoundingBox: boxOf(1296, 680),
    fills: [{ type: 'IMAGE' }],
    children: [],
  })
  const result = await plan('3:1', 2)

  // 1296×680 at 2x is ~3.5 MP — past the 3 MB hop, so the plan steps down before asking.
  assert.equal(result.density.steppedDown, true)
  assert.ok(result.density.fits < 2)
  assert.equal((result.calls[0].params.params as { scale: number }).scale, result.density.fits)
})

test('a flat vector slot is not planned as a photo plate', async () => {
  setFigma({
    id: '4:1',
    name: 'Calculator',
    type: 'FRAME',
    absoluteBoundingBox: boxOf(636, 720),
    fills: [{ type: 'SOLID' }],
    children: [{ id: '4:2', name: 'Frame 208', type: 'FRAME', exportSettings: [{ format: 'SVG' }] }],
  })
  const result = await plan('4:1')

  assert.equal(result.paintsBitmap, false)
  assert.equal(result.strategy, 'vector-over-plate')
})

test('a page-tall frame is named oversized instead of getting a call that will be refused', async () => {
  setFigma({
    id: '5:1',
    name: 'Migration board',
    type: 'FRAME',
    absoluteBoundingBox: boxOf(1680, 11137),
    fills: [{ type: 'SOLID' }],
    children: [],
  })
  const result = (await plan('5:1', 2)) as unknown as {
    density: { oversized: boolean; fits: number }
    calls: Array<{ why?: string }>
  }

  assert.equal(result.density.oversized, true)
  assert.match(String(result.calls[0].why), /even 1× is past the hop/)
})
