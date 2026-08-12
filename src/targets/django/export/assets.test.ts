import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateVectorLeaves, annotateVideoFills, collectExportAssets, collectManualAssets } from './assets.ts'
import { renderAssetLeaf } from '../html-emitter.ts'
import type { IrNode, IrContainerNode, IrImageNode, IrVectorNode } from '../ir.ts'

const BASE_NODE = {
  position: { x: 0, y: 0 },
  sizing: { width: { mode: 'fixed' as const, value: 0 }, height: { mode: 'fixed' as const, value: 0 } },
  gridPlacement: null,
  componentPropertyReferences: {},
  warnings: [],
}

function makeImage(id: string, name = 'Photo'): IrImageNode {
  return { ...BASE_NODE, type: 'image', id, name, imageHash: 'hash-1' }
}

function makeVector(id: string, name = 'Icon'): IrVectorNode {
  return { ...BASE_NODE, type: 'vector', id, name }
}

function makeContainer(id: string, children: IrNode[]): IrContainerNode {
  return { ...BASE_NODE, type: 'container', id, name: 'Frame', layout: { kind: 'absolute' }, component: null, children }
}

function makeFilledContainer(id: string, imageHash: string, assetSrc: string, children: IrNode[] = []): IrContainerNode {
  return { ...makeContainer(id, children), backgroundImages: [{ imageHash, assetSrc }] }
}

function makeSourceNode(id: string, name: string) {
  return {
    id,
    name,
    exportAsync: async (settings: any) => {
      if (settings.format === 'SVG_STRING') return '<svg></svg>'
      return new Uint8Array([1])
    },
  }
}

test('collectExportAssets exports a raster asset for an image node with a live source', async () => {
  const image = makeImage('1:1', 'Hero')
  const sceneNodesById = new Map([['1:1', makeSourceNode('1:1', 'Hero')]])

  const assets = await collectExportAssets([image], sceneNodesById)

  assert.ok(assets.length > 0)
  assert.ok(assets.every((a) => a.filename.startsWith('1-1-hero')))
})

test('collectExportAssets writes a file for a vector node above the inline threshold', async () => {
  const vector = makeVector('2:2', 'Illustration')
  const bigSvg = `<svg>${'x'.repeat(5000)}</svg>`
  const sceneNodesById = new Map([
    ['2:2', { id: '2:2', name: 'Illustration', exportAsync: async () => bigSvg }],
  ])

  const assets = await collectExportAssets([vector], sceneNodesById)

  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '2-2-illustration.svg')
  assert.equal(assets[0].content, bigSvg)
})

test('collectExportAssets skips a vector node at or below the inline threshold (no file emitted)', async () => {
  const vector = makeVector('3:3', 'Small icon')
  const sceneNodesById = new Map([
    ['3:3', { id: '3:3', name: 'Small icon', exportAsync: async () => '<svg></svg>' }],
  ])

  const assets = await collectExportAssets([vector], sceneNodesById)

  assert.equal(assets.length, 0)
})

test('collectExportAssets exports a marked graphic per its designer settings, even below the inline threshold', async () => {
  // A designer-marked vector (assetSrc set) ships as files per its Export panel setup — the template <img>s the primary one.
  const marked: IrVectorNode = { ...makeVector('6:6', 'Logo'), assetSrc: 'img/6-6-logo.svg' }
  const sceneNodesById = new Map([
    [
      '6:6',
      {
        id: '6:6',
        name: 'Logo',
        exportSettings: [{ format: 'SVG' }],
        exportAsync: async () => '<svg></svg>',
      },
    ],
  ])

  const assets = await collectExportAssets([marked], sceneNodesById as any)

  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '6-6-logo.svg', 'filename matches the assetSrc the emitter references')
})

test('collectExportAssets exports every designer setting of a marked graphic (formats + @Nx scales)', async () => {
  const marked = { ...makeImage('9:9', 'Hero'), assetSrc: 'img/9-9-hero.png' }
  const calls: any[] = []
  const sceneNodesById = new Map([
    [
      '9:9',
      {
        id: '9:9',
        name: 'Hero',
        exportSettings: [
          { format: 'PNG', constraint: { type: 'SCALE', value: 1 } },
          { format: 'PNG', suffix: '@2x', constraint: { type: 'SCALE', value: 2 } },
          { format: 'JPG', constraint: { type: 'SCALE', value: 3 } },
        ],
        exportAsync: async (settings: any) => {
          calls.push(settings)
          return new Uint8Array([1])
        },
      },
    ],
  ])

  const assets = await collectExportAssets([marked], sceneNodesById as any)

  assert.deepEqual(
    assets.map((a) => a.filename).sort(),
    ['9-9-hero.png', '9-9-hero@2x.png', '9-9-hero@3x.jpg']
  )
  assert.equal(calls.length, 3, 'each designer setting exported')
  assert.deepEqual(calls[1], { format: 'PNG', suffix: '@2x', constraint: { type: 'SCALE', value: 2 } }, 'settings passed verbatim')
})

test('collectExportAssets skips nodes with no corresponding live scene node', async () => {
  const image = makeImage('4:4', 'Ghost')

  const assets = await collectExportAssets([image], new Map())

  assert.equal(assets.length, 0)
})

test('collectExportAssets skips a node whose exportAsync throws instead of aborting the batch', async () => {
  const broken = makeImage('7:7', 'Broken')
  const good = makeImage('8:8', 'Good')
  const sceneNodesById = new Map([
    ['7:7', { id: '7:7', name: 'Broken', exportAsync: async () => { throw new Error('render failed') } }],
    ['8:8', makeSourceNode('8:8', 'Good')],
  ])

  const assets = await collectExportAssets([broken, good], sceneNodesById as any)

  assert.ok(assets.length > 0, 'the good node still exported')
  assert.ok(assets.every((a) => a.filename.startsWith('8-8-good')), 'no partial output from the broken node')
})

test("an unmarked image leaf's template reference names a file the asset pass actually ships", async () => {
  // Regression: the emitter fallback used images/<id>.png while the asset pass wrote
  // img/<id>-<slug>.png — every unmarked image leaf's {% static %} reference 404'd.
  const image = makeImage('1:23', 'Hero Photo')
  const sceneNodesById = new Map([['1:23', makeSourceNode('1:23', 'Hero Photo')]])

  const assets = await collectExportAssets([image], sceneNodesById)
  const src = /\{% static '([^']+)' %\}/.exec(renderAssetLeaf(image, ''))?.[1]

  assert.ok(src, 'the leaf renders an <img> with a {% static %} src')
  assert.ok(
    assets.some((a) => `img/${a.filename}` === src),
    `template references ${src} but the asset pass ships: ${assets.map((a) => a.filename).join(', ')}`
  )
})

test('collectExportAssets walks nested containers to find image/vector descendants', async () => {
  const image = makeImage('5:5', 'Nested')
  const tree = makeContainer('root', [makeContainer('inner', [image])])
  const sceneNodesById = new Map([['5:5', makeSourceNode('5:5', 'Nested')]])

  const assets = await collectExportAssets([tree], sceneNodesById)

  assert.ok(assets.length > 0)
})

test('annotateVectorLeaves inlines small unmarked vectors and files large ones', async () => {
  const small = makeVector('10:1', 'Logo')
  const large = makeVector('10:2', 'Illustration')
  const marked: IrVectorNode = { ...makeVector('10:3', 'Icon'), assetSrc: 'img/10-3-icon.svg' }
  const bigSvg = `<svg>${'x'.repeat(5000)}</svg>`
  const sceneNodesById = new Map<string, any>([
    ['10:1', { id: '10:1', name: 'Logo', exportAsync: async () => '<svg viewBox="0 0 10 10"/>' }],
    ['10:2', { id: '10:2', name: 'Illustration', exportAsync: async () => bigSvg }],
    ['10:3', { id: '10:3', name: 'Icon', exportAsync: async () => '<svg/>' }],
  ])

  await annotateVectorLeaves([small, large, marked], sceneNodesById)

  assert.equal(small.inlineSvg, '<svg viewBox="0 0 10 10"/>')
  assert.equal(small.assetSrc, undefined)
  assert.equal(large.assetSrc, 'img/10-2-illustration.svg')
  assert.equal(large.inlineSvg, undefined)
  assert.equal(marked.inlineSvg, undefined, 'marked vectors keep their designer assetSrc untouched')
})

test('collectExportAssets skips inlined vectors and writes files for annotated large ones', async () => {
  const inlined: IrVectorNode = { ...makeVector('11:1', 'Logo'), inlineSvg: '<svg/>' }
  const filed: IrVectorNode = { ...makeVector('11:2', 'Illustration'), assetSrc: 'img/11-2-illustration.svg' }
  const sceneNodesById = new Map<string, any>([
    ['11:1', { id: '11:1', name: 'Logo', exportAsync: async () => '<svg/>' }],
    // Small SVG, but the template references a file — threshold must not apply.
    ['11:2', { id: '11:2', name: 'Illustration', exportAsync: async () => '<svg/>' }],
  ])

  const assets = await collectExportAssets([inlined, filed], sceneNodesById)

  assert.deepEqual(assets.map((a) => a.filename), ['11-2-illustration.svg'])
})

// --- container background fills: raw fill bytes via getImageByHash, never exportAsync ---

test('collectExportAssets writes a container fill as the raw image bytes under its assetSrc filename', async () => {
  const container = makeFilledContainer('12:1', 'hash-bg', 'img/12-1-frame-fill.jpg')
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
  const requested: string[] = []
  const getImageByHash = (hash: string) => {
    requested.push(hash)
    return { getBytesAsync: async () => bytes }
  }

  const assets = await collectExportAssets([container], new Map(), getImageByHash)

  assert.deepEqual(requested, ['hash-bg'])
  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '12-1-frame-fill.jpg', 'filename matches the assetSrc the CSS references')
  assert.equal(assets[0].content, bytes, 'raw fill bytes, not a rasterized exportAsync render')
})

test('collectExportAssets finds container fills on nested containers and instance nodes', async () => {
  const nested = makeFilledContainer('14:2', 'hash-inner', 'img/14-2-frame-fill.png')
  const instance: IrNode = {
    ...BASE_NODE,
    type: 'instance-ref',
    id: '14:3',
    name: 'Card',
    layout: { kind: 'absolute' },
    componentId: null,
    componentKey: null,
    componentProperties: {},
    backgroundImages: [{ imageHash: 'hash-card', assetSrc: 'img/14-3-card-fill.png' }],
    children: [],
  }
  const tree = makeContainer('14:1', [nested, instance])

  const assets = await collectExportAssets([tree], new Map(), () => ({ getBytesAsync: async () => new Uint8Array([1]) }))

  assert.deepEqual(
    assets.map((a) => a.filename).sort(),
    ['14-2-frame-fill.png', '14-3-card-fill.png']
  )
})

test('collectExportAssets skips container fills when no getImageByHash is provided', async () => {
  const container = makeFilledContainer('15:1', 'hash-bg', 'img/15-1-frame-fill.png')

  const assets = await collectExportAssets([container], new Map())

  assert.equal(assets.length, 0)
})

test('collectExportAssets skips a fill whose image is gone or whose byte fetch throws, keeping the rest', async () => {
  const missing = makeFilledContainer('16:1', 'hash-gone', 'img/16-1-frame-fill.png')
  const broken = makeFilledContainer('16:2', 'hash-broken', 'img/16-2-frame-fill.png')
  const good = makeFilledContainer('16:3', 'hash-good', 'img/16-3-frame-fill.png')
  const getImageByHash = (hash: string) => {
    if (hash === 'hash-gone') return null
    if (hash === 'hash-broken') return { getBytesAsync: async (): Promise<Uint8Array> => { throw new Error('image expired') } }
    return { getBytesAsync: async () => new Uint8Array([7]) }
  }

  const assets = await collectExportAssets([missing, broken, good], new Map(), getImageByHash)

  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '16-3-frame-fill.png')
})

test('collectExportAssets exports a video-fill leaf via exportAsync MP4 under its assetSrc filename', async () => {
  const video: IrImageNode = { ...makeImage('17:1', 'Banner video'), imageHash: null, assetSrc: 'img/17-1-banner-video.mp4' }
  const calls: any[] = []
  const sceneNodesById = new Map<string, any>([
    ['17:1', { id: '17:1', name: 'Banner video', exportAsync: async (s: any) => { calls.push(s); return new Uint8Array([9]) } }],
  ])

  const assets = await collectExportAssets([video], sceneNodesById)

  assert.deepEqual(calls, [{ format: 'MP4' }], 'MP4 export called for the video leaf')
  assert.ok(assets.some((a) => a.filename === '17-1-banner-video.mp4'), 'the .mp4 asset ships')
})

// --- M11: poster PNG export alongside video assets ---

test('collectExportAssets exports a poster PNG alongside a video-fill leaf (M11)', async () => {
  const video: IrImageNode = {
    ...makeImage('18:1', 'Hero clip'),
    imageHash: null,
    assetSrc: 'img/18-1-hero-clip.mp4',
    posterSrc: 'img/18-1-hero-clip-poster.png',
  }
  const calls: any[] = []
  const sceneNodesById = new Map<string, any>([
    ['18:1', {
      id: '18:1',
      name: 'Hero clip',
      exportAsync: async (s: any) => {
        calls.push(s)
        return new Uint8Array([s.format === 'MP4' ? 9 : 1])
      },
    }],
  ])

  const assets = await collectExportAssets([video], sceneNodesById)

  assert.ok(assets.some((a) => a.filename === '18-1-hero-clip.mp4'), 'the .mp4 asset ships')
  assert.ok(assets.some((a) => a.filename === '18-1-hero-clip-poster.png'), 'the poster PNG ships')
  assert.deepEqual(calls.map((c) => c.format), ['MP4', 'PNG'], 'MP4 then PNG poster exported')
})

test('collectExportAssets falls back to PNG raster when a video-fill leaf MP4 export fails (FigJam MediaNode image)', async () => {
  const video: IrImageNode = {
    ...makeImage('19:1', 'Still media'),
    imageHash: null,
    assetSrc: 'img/19-1-still-media.mp4',
    posterSrc: 'img/19-1-still-media-poster.png',
  }
  const sceneNodesById = new Map<string, any>([
    ['19:1', {
      id: '19:1',
      name: 'Still media',
      exportAsync: async (s: any) => {
        if (s.format === 'MP4') throw new Error('not a video')
        return new Uint8Array([1])
      },
    }],
  ])

  const assets = await collectExportAssets([video], sceneNodesById)

  // MP4 failed → fell back to PNG raster (1x + 2x) + poster PNG.
  assert.ok(assets.some((a) => a.filename === '19-1-still-media.png'), '1x PNG raster fallback')
  assert.ok(assets.some((a) => a.filename === '19-1-still-media-poster.png'), 'poster PNG still ships')
  assert.ok(!assets.some((a) => a.filename === '19-1-still-media.mp4'), 'no .mp4 written (MP4 export failed)')
})

// --- M11: container video background fill export ---

test('collectExportAssets exports a container backgroundVideo as .mp4 + poster PNG (M11)', async () => {
  const container: IrContainerNode = {
    ...makeContainer('20:1', []),
    backgroundVideo: {
      videoHash: 'vid-hash-2',
      assetSrc: 'img/20-1-frame.mp4',
      posterSrc: 'img/20-1-frame-poster.png',
      scaleMode: 'FILL',
    },
  }
  const calls: any[] = []
  const sceneNodesById = new Map<string, any>([
    ['20:1', {
      id: '20:1',
      name: 'Frame',
      exportAsync: async (s: any) => {
        calls.push(s)
        return new Uint8Array([s.format === 'MP4' ? 9 : 1])
      },
    }],
  ])

  const assets = await collectExportAssets([container], sceneNodesById)

  assert.ok(assets.some((a) => a.filename === '20-1-frame.mp4'), 'the .mp4 background video ships')
  assert.ok(assets.some((a) => a.filename === '20-1-frame-poster.png'), 'the poster PNG ships')
  assert.deepEqual(calls.map((c) => c.format), ['MP4', 'PNG'], 'MP4 then PNG poster exported on the container')
})

test('annotateVideoFills caches the MP4 bytes and collectExportAssets ships them without re-exporting (M11 fix)', async () => {
  const container: IrContainerNode = {
    ...makeContainer('21:1', []),
    backgroundVideo: {
      videoHash: 'vid-hash-3',
      assetSrc: 'img/21-1-frame.mp4',
      posterSrc: 'img/21-1-frame-poster.png',
      scaleMode: 'FILL',
    },
  }
  const calls: any[] = []
  const sceneNodesById = new Map<string, any>([
    ['21:1', {
      id: '21:1',
      name: 'Frame',
      exportAsync: async (s: any) => {
        calls.push(s)
        return new Uint8Array([s.format === 'MP4' ? 9 : 1])
      },
    }],
  ])

  const videoBytesById = await annotateVideoFills([container], sceneNodesById)

  assert.equal(container.backgroundVideo?.videoUnavailable, undefined, 'successful export leaves the annotation clean')
  assert.deepEqual([...videoBytesById.keys()], ['21:1'])

  const assets = await collectExportAssets([container], sceneNodesById, undefined, videoBytesById)

  assert.ok(assets.some((a) => a.filename === '21-1-frame.mp4'), 'the cached .mp4 ships')
  assert.deepEqual(calls.map((c) => c.format), ['MP4', 'PNG'], 'exactly one MP4 export (annotation) — the asset pass reuses the cache')
})

test('annotateVideoFills marks a failed MP4 export videoUnavailable and the asset pass ships only the poster (M11 fix)', async () => {
  const container: IrContainerNode = {
    ...makeContainer('22:1', []),
    backgroundVideo: {
      videoHash: 'vid-hash-4',
      assetSrc: 'img/22-1-banner.mp4',
      posterSrc: 'img/22-1-banner-poster.png',
      scaleMode: 'FILL',
    },
  }
  const sceneNodesById = new Map<string, any>([
    ['22:1', {
      id: '22:1',
      name: 'Banner',
      exportAsync: async (s: any) => {
        if (s.format === 'MP4') throw new Error('video bytes unavailable')
        return new Uint8Array([1])
      },
    }],
  ])

  const videoBytesById = await annotateVideoFills([container], sceneNodesById)

  assert.equal(container.backgroundVideo?.videoUnavailable, true, 'failure is annotated on the IR')
  assert.equal(videoBytesById.size, 0)

  const assets = await collectExportAssets([container], sceneNodesById, undefined, videoBytesById)

  assert.ok(!assets.some((a) => a.filename.endsWith('.mp4')), 'no .mp4 ships — the emitter degraded the layer to the poster')
  assert.ok(!assets.some((a) => a.filename === '22-1-banner.png'), 'no stray raster fallback under a name nothing references')
  assert.ok(assets.some((a) => a.filename === '22-1-banner-poster.png'), 'the poster PNG still ships')

  assert.deepEqual(collectManualAssets([container]), [{ nodeId: '22:1', assetSrc: 'img/22-1-banner.mp4' }], 'the unshippable .mp4 is reported as a manual asset')
})

test('annotateVideoFills marks a failed video LEAF unavailable — poster only, no stray raster, .mp4 reported manual (M11 fix)', async () => {
  // A standalone shape with a VideoPaint fill (the "native video layer" convention) — serialized
  // as an image leaf whose assetSrc ends in .mp4.
  const leaf: IrImageNode = {
    ...makeImage('24:1', 'Rectangle 240649126'),
    assetSrc: 'img/24-1-rectangle-240649126.mp4',
    posterSrc: 'img/24-1-rectangle-240649126-poster.png',
  }
  const sceneNodesById = new Map<string, any>([
    ['24:1', {
      id: '24:1',
      name: 'Rectangle 240649126',
      exportAsync: async (s: any) => {
        if (s.format === 'MP4') throw new Error('Cannot export node as video')
        return new Uint8Array([1])
      },
    }],
  ])

  const videoBytesById = await annotateVideoFills([leaf], sceneNodesById)

  assert.equal(leaf.videoUnavailable, true, 'failure is annotated on the leaf')
  assert.equal(videoBytesById.size, 0)

  const assets = await collectExportAssets([leaf], sceneNodesById, undefined, videoBytesById)

  assert.ok(!assets.some((a) => a.filename.endsWith('.mp4')), 'no .mp4 ships')
  assert.ok(!assets.some((a) => a.filename === '24-1-rectangle-240649126.png'), 'no misleading raster under the video name')
  assert.ok(assets.some((a) => a.filename === '24-1-rectangle-240649126-poster.png'), 'the poster still ships')
  assert.deepEqual(collectManualAssets([leaf]), [{ nodeId: '24:1', assetSrc: 'img/24-1-rectangle-240649126.mp4' }])
})

test('annotateVideoFills caches a successful video LEAF export and the leaf loop reuses it', async () => {
  const leaf: IrImageNode = {
    ...makeImage('25:1', 'Promo'),
    assetSrc: 'img/25-1-promo.mp4',
    posterSrc: 'img/25-1-promo-poster.png',
  }
  const calls: string[] = []
  const sceneNodesById = new Map<string, any>([
    ['25:1', {
      id: '25:1',
      name: 'Promo',
      exportAsync: async (s: any) => {
        calls.push(s.format)
        return new Uint8Array([s.format === 'MP4' ? 9 : 1])
      },
    }],
  ])

  const videoBytesById = await annotateVideoFills([leaf], sceneNodesById)
  const assets = await collectExportAssets([leaf], sceneNodesById, undefined, videoBytesById)

  assert.ok(assets.some((a) => a.filename === '25-1-promo.mp4'), 'the cached .mp4 ships')
  assert.deepEqual(calls.filter((f) => f === 'MP4'), ['MP4'], 'exactly one MP4 export — the leaf loop reuses the cache')
  assert.deepEqual(collectManualAssets([leaf]), [], 'a shipped video is not a manual asset')
})

test('collectManualAssets returns nothing when every video fill exported', () => {
  const container: IrContainerNode = {
    ...makeContainer('23:1', []),
    backgroundVideo: {
      videoHash: 'vid-hash-5',
      assetSrc: 'img/23-1-frame.mp4',
      posterSrc: 'img/23-1-frame-poster.png',
      scaleMode: 'FILL',
    },
  }
  assert.deepEqual(collectManualAssets([container]), [])
})

test('collectExportAssets exports the mask shape SVG for an image-mask wrapper (M7)', async () => {
  const wrapper: IrContainerNode = {
    ...makeContainer('20:1--mask', [makeContainer('20:2', [])]),
    mask: { kind: 'image', mode: 'alpha', nodeId: '20:9', assetSrc: 'img/20-9-blob-mask.svg' },
  }
  const sceneNodesById = new Map([['20:9', makeSourceNode('20:9', 'Blob')]])

  const assets = await collectExportAssets([wrapper], sceneNodesById)
  const mask = assets.find((a) => a.filename === '20-9-blob-mask.svg')
  assert.ok(mask, 'the mask shape ships as an SVG asset under its promised filename')
  assert.equal(mask!.content, '<svg></svg>')
})

// --- M5: non-PNG image-fill leaves ship as raw bytes, not a rasterized PNG render ---

test('collectExportAssets ships a GIF-fill image leaf as raw bytes under its .gif filename, not rasterized to PNG (M5)', async () => {
  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  const image: IrImageNode = { ...makeImage('21:1', 'Loading spinner'), assetSrc: 'img/21-1-loading-spinner.gif' }
  const sceneNodesById = new Map([
    [
      '21:1',
      {
        id: '21:1',
        name: 'Loading spinner',
        exportAsync: async () => { throw new Error('exportAsync must not be called for a raw GIF fill leaf') },
      },
    ],
  ])
  const getImageByHash = (hash: string) => (hash === 'hash-1' ? { getBytesAsync: async () => gifBytes } : null)

  const assets = await collectExportAssets([image], sceneNodesById, getImageByHash)

  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, '21-1-loading-spinner.gif')
  assert.equal(assets[0].content, gifBytes, 'raw GIF bytes, not a rasterized PNG render')
})

test('collectExportAssets skips a non-PNG image-fill leaf when no getImageByHash is provided, rather than mis-rasterizing it as PNG', async () => {
  const image: IrImageNode = { ...makeImage('22:1', 'Spinner'), assetSrc: 'img/22-1-spinner.gif' }
  const sceneNodesById = new Map([['22:1', makeSourceNode('22:1', 'Spinner')]])

  const assets = await collectExportAssets([image], sceneNodesById)

  assert.equal(assets.length, 0)
})

test('annotateVectorLeaves skips a vector that already has an inline SVG (M7 pre-inlined arc)', async () => {
  const arc: IrVectorNode = { ...makeVector('30:1', 'Pie'), inlineSvg: '<svg>arc</svg>' }
  let called = false
  const sceneNodesById = new Map([['30:1', { id: '30:1', name: 'Pie', exportAsync: async () => { called = true; return '<svg>other</svg>' } }]])

  await annotateVectorLeaves([arc], sceneNodesById)
  assert.equal(called, false, 'a pre-inlined arc is not re-exported')
  assert.equal(arc.inlineSvg, '<svg>arc</svg>')
})
