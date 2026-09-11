// `context-ops.ts` and `ops.ts` import each other. Every real entry point (listener.ts,
// ops.test.ts) reaches `context-ops.ts` THROUGH `ops.ts`, so `ops.ts`'s own top-level
// `ALL_OPS = [...CONTEXT_OPS...]` never reads `CONTEXT_OPS` before `context-ops.ts` finished
// initializing it. Importing this file directly would reverse that order and crash on the
// same TDZ — importing `ops.ts` first here restores it.
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectContextAssets } from './context-ops.ts'
import { emitDjango } from '../targets/django/index.ts'
import { imageStaticPath, renderAssetLeaf } from '../targets/django/html-emitter.ts'
import type { DjangoNodeSource } from '../targets/django/css-emitter.ts'
import type { IrContainerNode, IrImageNode, IrTextNode, IrVectorNode } from '../targets/django/ir.ts'

const BASE = {
  position: { x: 0, y: 0 },
  sizing: { width: { mode: 'fixed' as const, value: 100 }, height: { mode: 'fixed' as const, value: 100 } },
  gridPlacement: null,
  componentPropertyReferences: {},
  warnings: [],
}

function makeImage(id: string, name = 'Photo'): IrImageNode {
  return { ...BASE, type: 'image', id, name, imageHash: 'hash-1' }
}

function makeVector(id: string, name = 'Icon'): IrVectorNode {
  return { ...BASE, type: 'vector', id, name }
}

function makeContainer(id: string, children: IrContainerNode['children'], extra: Partial<IrContainerNode> = {}): IrContainerNode {
  return { ...BASE, type: 'container', id, name: 'Frame', layout: { kind: 'absolute' }, component: null, children, ...extra }
}

function makeText(id: string, name = 'Label'): IrTextNode {
  return { ...BASE, type: 'text', id, name, characters: 'Hello' }
}

/** A minimal duck-typed live node — same shape unit tests across this target use in place of a
 * real Figma `SceneNode` (see `export/assets.test.ts`'s `makeSourceNode`). */
interface FakeSceneNode {
  id: string
  name: string
  exportSettings?: ReadonlyArray<{ format: string; constraint?: { type: string; value: number } }>
}

test('collectContextAssets: a raster leaf, a vector leaf, and a container background image each report one entry naming the file the emitted HTML/CSS actually references', async () => {
  const image = makeImage('1:1', 'Hero Photo') // unmarked leaf — no assetSrc, like a fresh serializeNode() output
  const vector: IrVectorNode = { ...makeVector('1:2', 'Icon'), assetSrc: 'img/1-2-icon.svg' } // already resolved by annotateVectorLeaves
  const root = makeContainer('1:0', [image, vector], {
    backgroundImages: [{ imageHash: 'bg-hash', assetSrc: 'img/1-0-frame.png' }],
  })

  const assets = await collectContextAssets([root], new Map<string, FakeSceneNode>() as unknown as ReadonlyMap<string, SceneNode>)
  assert.equal(assets.length, 3, 'one entry per distinct asset — leaf image, leaf vector, container background')

  const leafAsset = assets.find((a) => a.nodeId === image.id)
  const vectorAsset = assets.find((a) => a.nodeId === vector.id)
  const bgAsset = assets.find((a) => a.nodeId === root.id)
  assert.ok(leafAsset && vectorAsset && bgAsset, 'each source node produced exactly one entry')

  // The filenames match the same static-path helper the HTML emitter itself calls.
  assert.equal(`img/${leafAsset!.filename}`, imageStaticPath(image))
  assert.equal(`img/${vectorAsset!.filename}`, vector.assetSrc)
  assert.equal(leafAsset!.kind, 'raster')
  assert.equal(vectorAsset!.kind, 'vector')
  assert.equal(bgAsset!.kind, 'raster')
  assert.equal(leafAsset!.scale, 1)
  assert.equal(vectorAsset!.scale, 1)
  assert.equal(bgAsset!.scale, 1)

  // Render the real subtree the way `design.context` does, and confirm each filename actually
  // shows up in the markup/stylesheet it produces — not just in this op's own bookkeeping.
  const sceneNodesById = new Map<string, DjangoNodeSource>([
    [root.id, { getCSSAsync: async () => ({ background: 'url(<path-to-image>) center / cover' }) }],
  ])
  const { html, css } = await emitDjango([root], sceneNodesById, new Map(), { cssFile: 'design.css' })
  assert.ok(html.includes(`img/${leafAsset!.filename}`), 'emitted HTML references the raster leaf file')
  assert.ok(html.includes(`img/${vectorAsset!.filename}`), 'emitted HTML references the vector leaf file')
  assert.ok(css.includes(bgAsset!.filename), 'emitted CSS references the container background file')
  assert.equal(renderAssetLeaf(image, '').includes(leafAsset!.filename), true)
})

test('collectContextAssets reports the designer scale from an @3x export setting', async () => {
  const marked: IrImageNode = { ...makeImage('9:9', 'Hero'), imageHash: null, assetSrc: 'img/9-9-hero@3x.png' }
  const sceneNodesById = new Map<string, FakeSceneNode>([
    ['9:9', { id: '9:9', name: 'Hero', exportSettings: [{ format: 'PNG', constraint: { type: 'SCALE', value: 3 } }] }],
  ])

  const assets = await collectContextAssets([marked], sceneNodesById as unknown as ReadonlyMap<string, SceneNode>)

  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '9-9-hero@3x.png')
  assert.equal(assets[0].scale, 3, 'the @3x export setting reports scale 3, not the default 1')
  assert.equal(assets[0].format, 'png')
  assert.equal(assets[0].kind, 'raster')
})

test('collectContextAssets reports assets: [] for a node with no image/vector/video assets', async () => {
  const root = makeContainer('2:0', [makeText('2:1')])

  const assets = await collectContextAssets([root], new Map<string, FakeSceneNode>() as unknown as ReadonlyMap<string, SceneNode>)

  assert.deepEqual(assets, [])
})

test('collectContextAssets marks a video the export API already refused as unexportable, with a reason — so NODE_EXPORT is not retried on it', async () => {
  const leaf: IrImageNode = {
    ...makeImage('5:1', 'Promo'),
    imageHash: null,
    assetSrc: 'img/5-1-promo.mp4',
    posterSrc: 'img/5-1-promo-poster.png',
    videoUnavailable: true,
  }

  const assets = await collectContextAssets([leaf], new Map<string, FakeSceneNode>() as unknown as ReadonlyMap<string, SceneNode>)

  const video = assets.find((a) => a.kind === 'video')
  const poster = assets.find((a) => a.kind === 'poster')
  assert.ok(video && poster, 'both the failed .mp4 and its still-shipped poster are reported')
  assert.equal(video!.exportable, false)
  assert.equal(video!.filename, '5-1-promo.mp4')
  assert.ok(typeof video!.reason === 'string' && video!.reason.length > 0, 'the reason names why NODE_EXPORT would fail too')
  assert.equal(poster!.exportable, undefined, 'the poster itself still ships fine — only the video is unexportable')
})
