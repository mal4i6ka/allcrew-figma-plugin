import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assetFileName,
  assetPath,
  collectComponentUses,
  countIrNodes,
  requestedScales,
  uniqueStem,
  IR_OPS,
} from './ir-ops.ts'
import { isSafeFileName } from './files.ts'
import type { IrNode } from '../targets/django/ir.ts'

/** Enough of an IR node to walk. The real ones carry layout, paints and geometry; none of that
 * matters to counting or to reading which component an instance came from. */
function container(id: string, ...children: IrNode[]): IrNode {
  return { type: 'container', id, name: id, children } as unknown as IrNode
}

function instance(id: string, set: string, props: Record<string, unknown> = {}): IrNode {
  return {
    type: 'instance-ref',
    id,
    name: id,
    componentKey: `key-${set}`,
    componentSetName: set,
    componentProperties: props,
    children: [],
  } as unknown as IrNode
}

function text(id: string): IrNode {
  return { type: 'text', id, name: id } as unknown as IrNode
}

test('stats count the whole subtree by node type', () => {
  const tree = container('root', text('a'), container('row', text('b'), instance('i1', 'Button')))

  assert.deepEqual(countIrNodes(tree), { container: 2, text: 2, 'instance-ref': 1 })
})

test('component uses are grouped by set, and identical property sets are reported once', () => {
  const tree = container(
    'root',
    instance('i1', 'Button', { Type: 'Primary' }),
    instance('i2', 'Button', { Type: 'Primary' }),
    instance('i3', 'Button', { Type: 'Secondary' }),
    instance('i4', 'Card')
  )

  const uses = collectComponentUses(tree)

  assert.deepEqual(uses, [
    {
      name: 'Button',
      componentKey: 'key-Button',
      uses: 3,
      // Twelve identical rows are one fact about the component, not twelve lines of context.
      properties: [{ Type: 'Primary' }, { Type: 'Secondary' }],
      // One instance is kept so the set behind the component can be resolved by id — a key is
      // not something any read op accepts.
      instanceId: 'i1',
    },
    { name: 'Card', componentKey: 'key-Card', uses: 1, properties: [], instanceId: 'i4' },
  ])
})

test('an asset catalogue, density buckets and an @2x pair are three different layouts', () => {
  assert.equal(
    assetPath('Card cover', { naming: 'ios', scale: 2, format: 'PNG' }),
    'Assets.xcassets/card-cover.imageset/card-cover@2x.png'
  )
  assert.equal(assetPath('Card cover', { naming: 'android', scale: 3, format: 'PNG' }), 'res/drawable-xxhdpi/card-cover.png')
  assert.equal(assetPath('Card cover', { naming: 'web', scale: 2, format: 'PNG' }), 'assets/card-cover@2x.png')
  assert.equal(assetPath('Card cover', { naming: 'plain', scale: 1, format: 'PNG' }), 'card-cover.png')
})

test('a vector is not density-specific — Android keeps it out of the density buckets', () => {
  assert.equal(assetPath('Logo', { naming: 'android', scale: 1, format: 'SVG' }), 'assets/logo.svg')
})

test('an unknown density lands in nodpi rather than in the nearest bucket', () => {
  // Guessing "close enough" ships an icon at the wrong size on a real phone; nodpi is
  // Android's own way of saying this file is not density-specific.
  assert.equal(assetPath('Logo', { naming: 'android', scale: 2.5, format: 'PNG' }), 'res/drawable-nodpi/logo.png')
})

test('files stay flat and never collide across scales', () => {
  assert.equal(assetFileName('Card cover', 1, 'PNG'), 'card-cover.png')
  assert.equal(assetFileName('Card cover', 3, 'PNG'), 'card-cover@3x.png')
  assert.equal(assetFileName('Card cover', 2, 'JPG'), 'card-cover@2x.jpg')
})

test('vector formats export once, whatever scales were asked for', () => {
  assert.deepEqual(requestedScales([1, 2, 3], 'SVG'), [1])
  assert.deepEqual(requestedScales([1, 2, 3], 'PDF'), [1])
})

test('scales are sorted, de-duplicated and bounded; nonsense falls back to 1x', () => {
  assert.deepEqual(requestedScales([3, 1, 2, 2], 'PNG'), [1, 2, 3])
  assert.deepEqual(requestedScales([0, 99, 'x'], 'PNG'), [1])
  assert.deepEqual(requestedScales(undefined, 'PNG'), [1])
  assert.deepEqual(requestedScales(2, 'PNG'), [2])
})

test('both ops only read — a screen description is not a document change', () => {
  assert.deepEqual(IR_OPS.filter((op) => op.mutates), [])
  for (const op of IR_OPS) {
    assert.ok((op.agent ?? '').length > 40, `${op.name} ships without guidance`)
  }
})

test('two layers with the same name do not overwrite each other, and a density keeps its stem', () => {
  // Three cards each holding `img/topiccard_template` is the ordinary case; every file of one
  // call lands in one directory, so the second would replace the first.
  const taken = new Set<string>()
  const first = uniqueStem('topiccard-template', taken)
  const second = uniqueStem('topiccard-template', taken)
  const third = uniqueStem('topiccard-template', taken)

  assert.deepEqual([first, second, third], ['topiccard-template', 'topiccard-template-2', 'topiccard-template-3'])
  assert.equal(assetFileName(second, 2, 'PNG'), 'topiccard-template-2@2x.png')
  assert.equal(assetFileName(second, 3, 'PNG'), 'topiccard-template-2@3x.png')
})

test('a density suffix is a legal file name — the bridge writes it as it stands', () => {
  // iOS and every web build expect `icon@2x.png`; renaming it on the way out would make the
  // agent rename it back, and the rule exists to stop traversal, not `@`.
  assert.ok(isSafeFileName('icon@2x.png'))
  assert.ok(!isSafeFileName('../icon.png'))
  assert.ok(!isSafeFileName('dir/icon.png'))
})

test('an export stops before the answer outgrows the channel and says where to resume', async () => {
  // A reply past roughly three megabytes never arrives — the sandbox→UI hop stalls and the call
  // dies on the bridge's ceiling with nothing in it. So the ceiling is enforced before the file
  // joins the answer, and the caller is told which asset to ask for next.
  const big = new Uint8Array(1_000_000)
  const node = {
    id: '1:2',
    name: 'Cover',
    type: 'RECTANGLE',
    width: 400,
    height: 300,
    exportAsync: async () => big,
  }
  ;(globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async () => node,
    base64Encode: () => 'AAAA',
  }

  const op = IR_OPS.find((entry) => entry.name === 'assets.export')
  assert.ok(op)
  const answer = (await op.run({
    nodeId: '1:2',
    select: 'node',
    format: 'PNG',
    scales: [1, 2, 3],
    naming: 'web',
    limit: 24,
    offset: 0,
    budgetBytes: 2_500_000,
    budgetMs: 60_000,
    maxPixels: 4_000_000,
  })) as { bytes: number; stoppedOn?: string; assets: Array<{ files: unknown[] }>; nextOffset?: number }

  // Two megabytes fit, the third would cross 2.5 — so two files, not three.
  assert.equal(answer.assets[0].files.length, 2)
  assert.equal(answer.bytes, 2_000_000)
  assert.equal(answer.stoppedOn, 'bytes')
  assert.equal(answer.nextOffset, 0, 'the unfinished asset is where the next call starts')
})

test('an export too big to encode is skipped with the alternative named', async () => {
  const node = {
    id: '1:3',
    name: 'Section',
    type: 'FRAME',
    width: 1440,
    height: 756,
    exportAsync: async () => {
      throw new Error('should never be reached — the pixel ceiling comes first')
    },
  }
  ;(globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async () => node,
    base64Encode: () => 'AAAA',
  }

  const op = IR_OPS.find((entry) => entry.name === 'assets.export')
  assert.ok(op)
  const answer = (await op.run({
    nodeId: '1:3',
    select: 'node',
    format: 'PNG',
    scales: [3],
    naming: 'plain',
    limit: 24,
    offset: 0,
    budgetBytes: 2_500_000,
    budgetMs: 60_000,
    maxPixels: 4_000_000,
  })) as { exported: number; skipped?: Array<{ reason: string }> }

  assert.equal(answer.exported, 0)
  assert.match(answer.skipped?.[0]?.reason ?? '', /megapixels/)
  assert.match(answer.skipped?.[0]?.reason ?? '', /export the icon or image layer/)
})

test('assets.export flags a raster backed by a transparent source, never from the exported bytes, and only when asked', async () => {
  // Colour type 2 (RGB, no channel) is what the EXPORTED file says; 6 (RGBA) is what the
  // paint's actual uploaded source says. If the flag were read off the export, this asset
  // would come back `none` — the bug this op exists to close.
  const opaqueExport = new Uint8Array(26)
  opaqueExport.set([0x89, 0x50, 0x4e, 0x47], 0)
  opaqueExport[25] = 2
  const transparentSource = new Uint8Array(26)
  transparentSource.set([0x89, 0x50, 0x4e, 0x47], 0)
  transparentSource[25] = 6

  const node = {
    id: '5:1',
    name: 'Cutout',
    type: 'RECTANGLE',
    width: 100,
    height: 100,
    fills: [{ type: 'IMAGE', imageHash: 'hash-a', visible: true }],
    exportAsync: async () => opaqueExport,
  }
  let hashRequests = 0
  ;(globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async () => node,
    getImageByHash: (hash: string) => {
      hashRequests += 1
      return hash === 'hash-a' ? { getBytesAsync: async () => transparentSource } : null
    },
    base64Encode: () => 'AAAA',
  }

  const op = IR_OPS.find((entry) => entry.name === 'assets.export')
  assert.ok(op)
  const baseParams = {
    nodeId: '5:1',
    select: 'node' as const,
    format: 'PNG',
    scales: [1],
    naming: 'plain',
    limit: 24,
    offset: 0,
    budgetBytes: 2_500_000,
    budgetMs: 60_000,
    maxPixels: 4_000_000,
  }

  // Off by default: getBytesAsync hands back the whole original upload, unbounded by maxPixels,
  // so it is never fetched unless the caller opts in.
  const withoutAsking = (await op.run(baseParams)) as { assets: Array<{ alpha?: string }> }
  assert.equal(withoutAsking.assets[0].alpha, undefined)
  assert.equal(hashRequests, 0)

  const asked = (await op.run({ ...baseParams, alpha: true })) as { assets: Array<{ alpha?: string }> }
  assert.equal(asked.assets[0].alpha, 'alpha', 'the source paint is transparent, whatever the exported PNG says')
})

test('a vector export is never flagged, even with alpha requested', async () => {
  const vectorNode = {
    id: '5:2',
    name: 'Icon',
    type: 'VECTOR',
    width: 24,
    height: 24,
    // Carries an image paint too — the format is what rules this out, not the absence of a fill.
    fills: [{ type: 'IMAGE', imageHash: 'hash-b', visible: true }],
    exportAsync: async () => new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
  }
  let hashRequests = 0
  ;(globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async () => vectorNode,
    getImageByHash: () => {
      hashRequests += 1
      return { getBytesAsync: async () => new Uint8Array([1, 2, 3]) }
    },
    base64Encode: () => 'AAAA',
  }

  const op = IR_OPS.find((entry) => entry.name === 'assets.export')
  assert.ok(op)
  const answer = (await op.run({
    nodeId: '5:2',
    select: 'node',
    format: 'SVG',
    scales: [1],
    naming: 'plain',
    limit: 24,
    offset: 0,
    budgetBytes: 2_500_000,
    budgetMs: 60_000,
    maxPixels: 4_000_000,
    alpha: true,
  })) as { assets: Array<{ alpha?: string }> }

  assert.equal(answer.assets[0].alpha, undefined)
  assert.equal(hashRequests, 0, 'SVG/PDF have no bitmap source to ask about')
})
