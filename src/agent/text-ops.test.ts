// See context-ops.test.ts for why `ops.ts` is imported first: the op registry and the op
// modules import each other, and reaching a module directly reverses the initialization order.
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'

interface FakeNode {
  id: string
  name: string
  type: string
  characters?: string
  visible?: boolean
  textStyleId?: string
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
    getStyleByIdAsync: async (id: string) => ({ name: `style:${id}` }),
  }
}

const text = (id: string, characters: string, extra: Partial<FakeNode> = {}): FakeNode => ({
  id,
  name: characters,
  type: 'TEXT',
  characters,
  ...extra,
})

const SCREEN: FakeNode = {
  id: '1:1',
  name: 'Main_container',
  type: 'FRAME',
  children: [
    text('1:2', 'Money that moves'),
    {
      id: '1:3',
      name: 'Img_hero',
      type: 'FRAME',
      children: [
        text('1:4', 'Randy F.'),
        { id: '1:5', name: 'Section Info', type: 'FRAME', children: [text('1:6', '- $3,500.00')] },
      ],
    },
    { id: '1:7', name: 'Cards', type: 'FRAME', children: [text('1:8', 'Open account')] },
    text('1:9', 'Hidden promo', { visible: false }),
  ],
}

async function inventory(params: Record<string, unknown>) {
  const op = OPS_BY_NAME.get('text.inventory')!
  return (await op.run(params)) as {
    counts: { total: number; content: number; baked: number; distinct: number }
    texts: Array<{ id: string; role: string; bakedIn?: string; path: string; characters: string }>
  }
}

test('copy and text drawn inside an illustration are told apart', async () => {
  setFigma(SCREEN)
  const result = await inventory({ nodeId: '1:1', limit: 500, includeHidden: false, role: 'all' })
  assert.deepEqual(result.counts, { total: 4, content: 2, baked: 2, distinct: 2 })
  const byId = Object.fromEntries(result.texts.map((row) => [row.id, row]))
  assert.equal(byId['1:2'].role, 'content')
  assert.equal(byId['1:8'].role, 'content')
  // Two levels below `Img_hero` is still inside the picture: the amount is drawn, not written.
  assert.equal(byId['1:6'].role, 'baked')
  assert.equal(byId['1:6'].bakedIn, 'Img_hero')
  assert.equal(byId['1:6'].path, 'Main_container/Img_hero/Section Info/- $3,500.00')
})

test('a hidden layer is reported only when asked for', async () => {
  setFigma(SCREEN)
  const without = await inventory({ nodeId: '1:1', limit: 500, includeHidden: false, role: 'all' })
  const with_ = await inventory({ nodeId: '1:1', limit: 500, includeHidden: true, role: 'all' })

  assert.equal(without.texts.some((row) => row.characters === 'Hidden promo'), false)
  assert.equal(with_.texts.some((row) => row.characters === 'Hidden promo'), true)
})

test('role filters the report without changing the verdict', async () => {
  setFigma(SCREEN)
  const content = await inventory({ nodeId: '1:1', limit: 500, includeHidden: false, role: 'content' })

  assert.deepEqual(
    content.texts.map((row) => row.characters).sort(),
    ['Money that moves', 'Open account']
  )
})

test('an extra illustration name moves its text out of the copy deck', async () => {
  setFigma(SCREEN)
  const result = await inventory({
    nodeId: '1:1',
    limit: 500,
    includeHidden: false,
    role: 'baked',
    illustrations: ['Cards'],
  })

  assert.equal(result.texts.some((row) => row.characters === 'Open account'), true)
})
