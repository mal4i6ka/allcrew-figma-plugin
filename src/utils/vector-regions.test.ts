import test from 'node:test'
import assert from 'node:assert/strict'

const MIXED = Symbol('figma.mixed')
;(globalThis as { figma?: unknown }).figma = { mixed: MIXED }

const { regionFills, withRegionFills, writeRegionFills, paintAliasId, summarizeRegions } = await import('./vector-regions.ts')

const black = { type: 'SOLID', color: { r: 0, g: 0, b: 0 } } as unknown as Paint
const orange = {
  type: 'SOLID',
  color: { r: 0.98, g: 0.36, b: 0.04 },
  boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } },
} as unknown as Paint

const network = {
  vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
  regions: [
    { windingRule: 'NONZERO', loops: [[0, 1, 2]], fills: [black] },
    { windingRule: 'EVENODD', loops: [[0, 1]], fills: [orange], fillStyleId: 'S:abc,' },
    { windingRule: 'NONZERO', loops: [[1, 2]] },
  ],
} as unknown as VectorNetwork

test('a vector painted per region hands its colours over by region', () => {
  const regions = regionFills({ type: 'VECTOR', fills: MIXED, vectorNetwork: network })
  assert.ok(regions)
  assert.equal(regions.length, 3)
  assert.deepEqual(regions[0], { region: 0, fills: [black] })
  assert.equal(regions[1].fillStyleId, 'S:abc,')
  // A region without its own fills has none to report — not a crash, not the node's paints.
  assert.deepEqual(regions[2], { region: 2, fills: [] })
})

test('ordinary fills are not regions, even an empty stack', () => {
  assert.equal(regionFills({ type: 'VECTOR', fills: [black], vectorNetwork: network }), null)
  assert.equal(regionFills({ type: 'VECTOR', fills: [], vectorNetwork: network }), null)
})

test('a mixed node with no network is not a region case — that is mixed TEXT', () => {
  assert.equal(regionFills({ type: 'TEXT', fills: MIXED }), null)
  assert.equal(regionFills(null), null)
})

test('a network the sandbox refuses to read reads as no regions', () => {
  const holder = {
    fills: MIXED,
    get vectorNetwork(): VectorNetwork {
      throw new Error('not available')
    },
  }
  assert.equal(regionFills(holder), null)
})

test('a rewrite replaces only the regions it names and keeps the drawing whole', () => {
  const next = withRegionFills(network, new Map([[0, [orange]]]))
  assert.equal(next.vertices, network.vertices)
  assert.equal(next.segments, network.segments)
  assert.deepEqual(next.regions?.[0], { windingRule: 'NONZERO', loops: [[0, 1, 2]], fills: [orange] })
  // Untouched regions are the very same objects, style links and winding rules included.
  assert.equal(next.regions?.[1], network.regions?.[1])
  assert.equal(next.regions?.[2], network.regions?.[2])
})

test('the write goes through setVectorNetworkAsync with the whole network', async () => {
  let written: VectorNetwork | null = null
  const node = {
    type: 'VECTOR',
    vectorNetwork: network,
    async setVectorNetworkAsync(value: VectorNetwork) {
      written = value
    },
  } as unknown as SceneNode
  await writeRegionFills(node, new Map([[2, [black]]]))
  assert.ok(written)
  assert.deepEqual((written as VectorNetwork).regions?.[2].fills, [black])
  assert.equal((written as VectorNetwork).regions?.length, 3)
})

test('a node without a network says so instead of writing nothing', async () => {
  await assert.rejects(
    writeRegionFills({ type: 'RECTANGLE' } as unknown as SceneNode, new Map([[0, [black]]])),
    /no vector network/
  )
})

test('the alias a paint is bound to is the rebind key, and an unbound paint has none', () => {
  assert.equal(paintAliasId(orange), 'VariableID:1:2')
  assert.equal(paintAliasId(black), '')
})

test('a region read is plain data — colour, opacity, the alias — and needs no lookup', () => {
  const summary = summarizeRegions(regionFills({ fills: MIXED, vectorNetwork: network }) ?? [])
  assert.deepEqual(summary[0], { region: 0, fills: [{ index: 0, type: 'SOLID', color: '#000000' }] })
  assert.deepEqual(summary[1], {
    region: 1,
    fills: [{ index: 0, type: 'SOLID', color: '#FA5C0A', boundTo: 'VariableID:1:2' }],
    fillStyleId: 'S:abc,',
  })
  assert.deepEqual(summary[2], { region: 2, fills: [] })
})
