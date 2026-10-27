/**
 * Agent listener — design context.
 *
 * The export pipeline in `src/targets` already turns a Figma subtree into HTML and CSS that
 * speak in token references rather than raw hex. It was only ever reachable from the plugin's
 * own UI, which meant a CLI agent could read a file in detail and still had nothing to
 * implement *from*. These two ops are the bridge to it.
 *
 * What makes this worth having next to Figma's own design-context tool is the token layer: a
 * generic exporter reports the colour it found, `#F2F4F5`, while this one reports the variable
 * that produced it, `colors/neutral/100`, because it reads `boundVariables` on the way past.
 * An agent generating code from the first has to guess which token to use; from the second it
 * does not have to guess at all.
 *
 * Both ops return *paths*, never payloads — see `files.ts` for why.
 */

import { regionFills, summarizeRegions } from '../utils/vector-regions.ts'
import { emitDjango } from '../targets/django/index.ts'
import { imageStaticPath } from '../targets/django/html-emitter.ts'
import { pickBackend, type MotionTrigger } from '../targets/django/motion/backend.ts'
import { motionCurve } from '../targets/django/easing/index.ts'
import { readMotionData } from '../targets/django/motion/beta-adapter.ts'
import { emitMotionExportArtifacts, type MotionExportNode } from '../targets/django/motion/export-assets.ts'
import { buildPreviewDocument } from '../targets/django/motion/preview.ts'
import type { MotionTrack } from '../targets/django/motion/types.ts'
import { serializeNode, type IrNode, type IrContainerNode } from '../targets/django/ir.ts'
import { annotateVectorLeaves, annotateVideoFills, collectManualAssets, type AssetSourceNode } from '../targets/django/export/assets.ts'
import { emitInteractions } from '../targets/django/interactions.ts'
import { emitBreakpointCss, type BreakpointGroup } from '../targets/django/breakpoint-frames.ts'
import { detectImageFillFormat, isVideoAssetPath, primaryDesignerSetting, type DesignerExportSetting } from '../targets/django/assets.ts'
import { resolveExportSettings, type ExportMarkedInstanceNode } from '../utils/graphics.ts'
import { imageAlpha, imageDimensions } from './image-dimensions.ts'
import { walkSceneNodes } from '../utils/tree.ts'
import { checkpoint, enforceDeadline } from '../utils/budget.ts'
import { exportPlate } from '../canvas/plate.ts'
import { fileUrlPath } from '../canvas/board.ts'
import { readLocalVariables } from '../variables.ts'
import { binaryFile, slugify, textFile } from './files.ts'
import { shadersFor } from './ops.ts'
import { describePaint, describeShader, type PaintSummary, type ShaderSummary } from './paints.ts'
import type { OpDef } from './protocol.ts'
import { ExportGuard, fitScaleToPixels, MAX_REPLY_RAW_BYTES } from './export-guard.ts'
import { openSweep, resolveSweepRoots, SWEEP_PARAMS } from './sweep.ts'
import {
  collectContextAssets,
  collectTokens,
  indexSceneNodes,
  resolveSceneNode,
  screenshot,
  type ContextAsset,
} from './subtree.ts'

// Re-exported where they were first published: `design.context`'s asset list is asserted by
// `context-assets.test.ts`, and the shape is this module's contract, not the leaf's.
export { collectContextAssets, type ContextAsset } from './subtree.ts'

/** Figma's Motion API is a beta that is simply absent for most accounts. Saying so beats
 * answering "no animations" for a file full of them. */
function hasMotionApi(): boolean {
  return Boolean((figma as unknown as { motion?: unknown }).motion)
}

/**
 * An easing reads back as a Figma object, and when it is bound to a variable it reads back as
 * an alias with an id and nothing else. Resolving the name here keeps the op's promise: this
 * channel reports the token, not the number it happened to resolve to.
 */
async function describeEasing(easing: MotionTrack['keyframes'][number]['easing']): Promise<unknown> {
  if ((easing as { type?: string }).type !== 'VARIABLE_ALIAS') return easing
  const id = (easing as unknown as { id?: unknown }).id
  if (typeof id !== 'string') return easing
  try {
    const variable = await figma.variables.getVariableByIdAsync(id)
    return { type: 'VARIABLE_ALIAS', token: variable?.name ?? id }
  } catch {
    return easing
  }
}

/** One node's own markup and CSS. `design.context` emits a whole subtree; the motion preview
 * needs each animated layer on its own, because that is the unit `buildPreviewDocument` places. */
async function emitOne(
  node: SceneNode,
  cssFile: string,
  sceneNodesById: Map<string, SceneNode>,
  variableNamesById: ReadonlyMap<string, string>
): Promise<{ html: string; css: string }> {
  const ir = await serializeNode(node)
  if (!ir) throw new Error(`"${node.name}" (${node.type}) produced no exportable structure`)
  const nodes: readonly IrNode[] = [ir]
  await annotateVectorLeaves(nodes, sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>)
  return emitDjango(nodes, sceneNodesById, variableNamesById, { cssFile })
}

/** Stage timings, so a slow op says *which* stage was slow. `design.context` once spent three
 * minutes inside a variable read that looked like a one-liner; without this the only way to
 * find that was to guess and rebuild. */
class Stopwatch {
  private readonly marks: Array<{ stage: string; ms: number }> = []
  private last = Date.now()
  mark(stage: string): void {
    const now = Date.now()
    this.marks.push({ stage, ms: now - this.last })
    this.last = now
  }
  async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const result = await work()
    this.mark(stage)
    return result
  }
  report(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const entry of this.marks) out[entry.stage] = (out[entry.stage] ?? 0) + entry.ms
    return out
  }
}

/**

/* --------------------------------------------------------------------- ops */

export const CONTEXT_OPS: readonly OpDef[] = [
  {
    name: 'node.screenshot',
    summary: 'Render a node to PNG — the one way an agent can check what it actually drew.',
    agent:
      'Oversized screenshots are downscaled before exportAsync so the sandbox and the 3 MiB reply hop stay safe; ' +
      '`scale` in the answer is the scale actually rendered and `requestedScale` is present when it changed.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Layer to render.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Export scale. 2 for retina.' },
    },
    async run(params) {
      const node = await resolveSceneNode(params.nodeId)
      const requestedScale = params.scale as number
      const shot = await screenshot(node, requestedScale)
      return {
        node: { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height },
        scale: shot.scale,
        ...(shot.downscaled ? { requestedScale, downscaled: true } : {}),
        bytes: shot.bytes.length,
        file: binaryFile(`${slugify(node.name)}.png`, 'image/png', shot.bytes),
      }
    },
  },

  {
    name: 'image.plate',
    summary: 'A node rendered to PNG/JPG with every descendant hidden — the photo itself, not the badge baked over it.',
    agent:
      'A card thumbnail is routinely an instance whose own IMAGE fill is the photo and whose only child is an overlay ' +
      '— a "10 min" reading-time chip, a rating badge — and node.screenshot/NODE_EXPORT bake that overlay into the ' +
      'pixels, because exportAsync has no "skip children" switch. image.fills answers this without touching the ' +
      'canvas at all when the photo is a plain paint (getImageByHash, no render), but its subtree walk can outrun a ' +
      "large file's budget; reach for image.plate once a walk already has nodeId and the photo just needs to come " +
      'back clean. Oversized plates are downscaled before exportAsync; the answer reports the scale actually used. ' +
      'Costs a fleeting clone — created, hidden, exported, deleted — the document is back to itself once this returns.',
    mutates: true,
    params: {
      nodeId: { type: 'string', required: true, description: 'Node to render without its descendants.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Export scale. 2 for retina.' },
      format: { type: 'string', default: 'PNG', enum: ['PNG', 'JPG'], description: 'Raster format.' },
    },
    async run(params) {
      const node = await resolveSceneNode(params.nodeId)
      const requestedScale = params.scale as number
      const format = params.format as 'PNG' | 'JPG'
      const fitted = fitScaleToPixels(node, requestedScale, Math.floor(MAX_REPLY_RAW_BYTES / 5))
      const bytes = await exportPlate(node, {
        format,
        constraint: { type: 'SCALE', value: fitted.scale },
        maxPixels: Math.floor(MAX_REPLY_RAW_BYTES / 5),
      })
      const ext = format === 'JPG' ? 'jpg' : 'png'
      return {
        node: { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height },
        scale: fitted.scale,
        ...(fitted.downscaled ? { requestedScale, downscaled: true } : {}),
        format,
        bytes: bytes.length,
        file: binaryFile(`${slugify(node.name)}.${ext}`, format === 'JPG' ? 'image/jpeg' : 'image/png', bytes),
      }
    },
  },

  {
    name: 'image.fills',
    summary: 'The original files behind a subtree’s image fills — the photo itself, not a render with text baked over it.',
    agent:
      'A render (node.screenshot, NODE_EXPORT, image.plate) flattens overlays and text into the pixels; this hands ' +
      'back the uploaded source of each IMAGE paint under the node, deduplicated by hash, largest first. A large ' +
      'subtree is swept in resumable slices: on `complete: false`, call again with the same params plus `cursor`. ' +
      'Byte fetching is paged separately; when `nextOffset` is present, repeat the call with that offset. The byte ' +
      'budget is clamped below the 3 MiB transport ceiling. Pin one fill with `imageHash`, or use `self: true`.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Subtree to search for image fills.' },
      limit: { type: 'number', default: 20, min: 1, max: 100, description: 'How many distinct images to hand back.' },
      offset: {
        type: 'number',
        default: 0,
        min: 0,
        max: 10000,
        description: 'Skip this many ranked fills. Use nextOffset to resume byte fetching.',
      },
      budgetBytes: {
        type: 'number',
        default: MAX_REPLY_RAW_BYTES,
        min: 100_000,
        max: 12_000_000,
        description: 'Raw image bytes allowed in one reply; clamped to the transport-safe ceiling.',
      },
      minSide: {
        type: 'number',
        default: 64,
        min: 0,
        description: 'Skip images whose longer side is below this many pixels — icons and textures, not photos.',
      },
      imageHash: { type: 'string', description: 'Only this image hash.' },
      paintIndex: { type: 'number', min: 0, description: "Only this index in a node's own fill stack." },
      self: { type: 'boolean', default: false, description: "Check only nodeId's own fills." },
      ...SWEEP_PARAMS,
      budgetMs: {
        type: 'number',
        default: 60000,
        min: 1000,
        max: 170000,
        description: 'Time for this sweep/fetch slice; the active agent-run deadline is also enforced.',
      },
      imageMs: {
        type: 'number',
        default: 15000,
        min: 1000,
        max: 170000,
        description: 'Per-image getBytesAsync deadline, shortened when the call deadline is close.',
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      const limit = params.limit as number
      const offset = params.offset as number
      const minSide = params.minSide as number
      const imageHash = params.imageHash as string | undefined
      const paintIndex = params.paintIndex as number | undefined
      const self = params.self === true
      const budgetMs = params.budgetMs as number
      const imageMs = params.imageMs as number
      const start = Date.now()
      const deadlineAt = start + budgetMs
      type Hit = { node: SceneNode; paintIndex: number; scaleMode: string }
      type State = { hits: Map<string, Hit> }

      const record = (hits: Map<string, Hit>, node: SceneNode): void => {
        if (node.visible === false) return
        const fills = (node as GeometryMixin).fills
        if (!Array.isArray(fills)) return
        fills.forEach((paint, index) => {
          if (paint.type !== 'IMAGE' || !paint.imageHash || paint.visible === false) return
          if (paintIndex !== undefined && index !== paintIndex) return
          if (imageHash !== undefined && paint.imageHash !== imageHash) return
          if (!hits.has(paint.imageHash)) {
            hits.set(paint.imageHash, { node, paintIndex: index, scaleMode: paint.scaleMode })
          }
        })
      }

      let state: State
      let sweepReport: {
        complete: boolean
        cursor?: string
        stoppedOn?: 'budget' | 'limit'
        swept: { nodes: number; roots: { done: number; of: number }; calls: number }
      }
      if (self) {
        state = { hits: new Map() }
        record(state.hits, root)
        sweepReport = { complete: true, swept: { nodes: 1, roots: { done: 1, of: 1 }, calls: 1 } }
      } else {
        const sweep = await openSweep<State>({
          op: 'image.fills',
          params,
          roots: () => resolveSweepRoots(params),
          state: () => ({ hits: new Map() }),
          includeRoots: true,
        })
        state = sweep.state
        await sweep.walk((node) => record(state.hits, node))
        sweepReport = sweep.report()
      }

      if (!sweepReport.complete) {
        return {
          node: { id: root.id, name: root.name, type: root.type },
          ...sweepReport,
          note: 'Collection is incomplete; call image.fills again with the same params plus cursor.',
        }
      }

      const raceDeadline = <T,>(work: Promise<T>, what: string, ms: number): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms)
          work.then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
          )
        })

      const ranked = [...state.hits.entries()].sort(
        ([, a], [, b]) => b.node.width * b.node.height - a.node.width * a.node.height,
      )
      const failures: Array<{ node: string; hash: string; error: string }> = []
      const images: Array<Record<string, unknown>> = []
      const guard = new ExportGuard({ budgetBytes: params.budgetBytes as number, reserveMs: 2_000 })
      let skipped = 0
      let index = offset
      let stoppedOn: 'bytes' | 'deadline' | 'cancelled' | 'time' | null = null

      while (index < ranked.length && images.length < limit) {
        if (Date.now() >= deadlineAt) {
          stoppedOn = 'time'
          break
        }
        const gate = await guard.beforeRender(index)
        if (!gate.include) {
          stoppedOn = gate.stoppedOn ?? 'time'
          break
        }
        const [hash, hit] = ranked[index]
        const image = figma.getImageByHash(hash)
        if (!image) {
          failures.push({ node: hit.node.id, hash, error: 'image hash is no longer available' })
          index += 1
          continue
        }
        let bytes: Uint8Array
        try {
          const perImageMs = Math.max(1, Math.min(imageMs, deadlineAt - Date.now()))
          bytes = await raceDeadline(image.getBytesAsync(), `getBytesAsync ${hit.node.name}`, perImageMs)
        } catch (error) {
          failures.push({ node: hit.node.id, hash, error: String(error) })
          index += 1
          continue
        }
        const format = detectImageFillFormat(bytes)
        const { width, height } = imageDimensions(bytes)
        if (width && height && Math.max(width, height) < minSide) {
          skipped += 1
          index += 1
          continue
        }
        const admitted = guard.admit(bytes.length, index)
        if (!admitted.include) {
          stoppedOn = 'bytes'
          if (admitted.firstItemTooLarge) {
            failures.push({
              node: hit.node.id,
              hash,
              error:
                `source is ${bytes.length} bytes, too large for one transport-safe reply; ` +
                'use image.plate to render a smaller copy',
            })
            index += 1
          }
          break
        }
        images.push({
          node: { id: hit.node.id, name: hit.node.name, type: hit.node.type, width: hit.node.width, height: hit.node.height },
          paintIndex: hit.paintIndex,
          scaleMode: hit.scaleMode,
          hash,
          width,
          height,
          bytes: bytes.length,
          format,
          alpha: imageAlpha(bytes),
          file: binaryFile(
            `${slugify(hit.node.name)}-${hash.slice(0, 8)}.${format}`,
            format === 'jpg' ? 'image/jpeg' : `image/${format}`,
            bytes,
          ),
        })
        index += 1
      }

      const more = index < ranked.length
      return {
        node: { id: root.id, name: root.name, type: root.type },
        ...sweepReport,
        count: images.length,
        skippedSmall: skipped,
        failed: failures,
        timedOut: stoppedOn === 'time' || stoppedOn === 'deadline' || stoppedOn === 'cancelled',
        ...(stoppedOn ? { stoppedOn } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(more ? { remaining: ranked.length - index, nextOffset: index } : {}),
        bytes: guard.spent,
        elapsedMs: Date.now() - start,
        images,
      }
    },
  },

  {
    name: 'node.focus',
    summary: 'Select one or many nodes and reveal their page; cross-page nodes return as grouped jump links.',
    agent:
      'Pass nodes[] for a whole review list. Figma can select only one page at a time, so the first node chooses the visible page; every node on another page is returned under elsewhere with a one-line jump link.',
    mutates: false,
    params: {
      nodeId: { type: 'string', description: 'One node to reveal (legacy shorthand for nodes: [nodeId]).' },
      nodes: { type: 'string[]', description: 'Node ids to select together where they share a page.' },
      select: { type: 'boolean', default: true, description: 'Also select visible-page nodes, not just scroll to them.' },
      zoom: {
        type: 'number',
        description:
          'Hold this zoom (1 = 100%) centred on the nodes instead of fitting them — a detail at 400% rather than a whole screen shrunk to fit.',
      },
    },
    async run(params) {
      if (params.zoom !== undefined && (typeof params.zoom !== 'number' || !(params.zoom > 0) || params.zoom > 256)) {
        throw new Error('zoom must be a number above 0 and at most 256 — 1 is 100%')
      }
      const ids = [
        ...(Array.isArray(params.nodes)
          ? (params.nodes as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
          : []),
        ...(typeof params.nodeId === 'string' && params.nodeId !== '' ? [params.nodeId] : []),
      ]
      const unique = [...new Set(ids)]
      if (unique.length === 0) throw new Error('send nodeId or a non-empty nodes[]')

      const resolved = await Promise.all(unique.map((id) => resolveSceneNode(id)))
      const rows = resolved.map((node) => {
        let page: BaseNode | null = node.parent
        while (page && page.type !== 'PAGE') page = page.parent
        if (!page) throw new Error(`"${node.name}" is not on a page — nothing to scroll to`)
        const anchor = `?node-id=${node.id.replace(':', '-')}`
        const fileKey = figma.fileKey
        return {
          node,
          page: page as PageNode,
          result: {
            node: { id: node.id, name: node.name, type: node.type },
            page: { id: page.id, name: (page as PageNode).name },
            url: fileKey ? `https://www.figma.com/${fileUrlPath(figma.editorType)}/${fileKey}/${anchor}` : null,
            deepLinkSuffix: anchor,
          },
        }
      })

      const visiblePage = rows[0].page
      await visiblePage.loadAsync()
      await figma.setCurrentPageAsync(visiblePage)
      const visible = rows.filter((row) => row.page.id === visiblePage.id)
      if (params.select !== false) figma.currentPage.selection = visible.map((row) => row.node)
      figma.viewport.scrollAndZoomIntoView(visible.map((row) => row.node))
      if (typeof params.zoom === 'number') {
        // Fit first and then hold the zoom: the fit has already put the nodes' centre in the
        // middle of the window, which is where a zoom should be anchored.
        const centre = figma.viewport.center
        figma.viewport.zoom = params.zoom
        figma.viewport.center = centre
      }

      const elsewhere = new Map<string, { page: { id: string; name: string }; nodes: unknown[] }>()
      for (const row of rows.filter((candidate) => candidate.page.id !== visiblePage.id)) {
        const group = elsewhere.get(row.page.id) ?? {
          page: { id: row.page.id, name: row.page.name },
          nodes: [],
        }
        group.nodes.push(row.result)
        elsewhere.set(row.page.id, group)
      }

      return {
        page: { id: visiblePage.id, name: visiblePage.name },
        selected: params.select === false ? [] : visible.map((row) => row.result.node),
        elsewhere: [...elsewhere.values()],
        nodes: rows.map((row) => row.result),
        viewport: {
          zoom: Math.round(figma.viewport.zoom * 1000) / 1000,
          center: { x: Math.round(figma.viewport.center.x), y: Math.round(figma.viewport.center.y) },
        },
      }
    },
  },

  {
    name: 'design.context',
    summary: 'Reference HTML + CSS + PNG for a node, with the tokens it binds — implement from this.',
    agent:
      'Answers with file paths, not payloads — open them. The token usage table says which variables actually carry ' +
      'the subtree. Oversized reference PNGs are downscaled before exportAsync; `screenshotScale` is the actual scale. ' +
      '`assets[]` names every raster/vector/video/poster the emitted HTML+CSS references — `filename` is exactly the ' +
      'path the markup asks for, and `nodeId` goes straight to NODE_EXPORT. An entry with `exportable: false` names ' +
      "a video Figma's export API already refused, so do not retry it.",
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Frame or component to describe.' },
      cssFile: { type: 'string', default: 'design.css', description: 'Name the emitted HTML links to.' },
      screenshot: { type: 'boolean', default: true, description: 'Also render a PNG reference.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Screenshot scale.' },
      pair: {
        type: 'string',
        description:
          "Node id of the OTHER breakpoint frame (e.g. the mobile frame when nodeId is the desktop one). " +
          'When set, the response gets a `breakpoints` field: the narrower frame\'s @media CSS, merged ' +
          "against nodeId's own tree by layer name+path (matchLayers) — no naming convention required, " +
          "unlike the whole-site export's `<slug>/mobile` grouping.",
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      // `documentAccess: "dynamic-page"` — the node's page has to be loaded before its subtree
      // can be walked, and a node handed over by id may live on a page nobody has opened.
      const page = (() => {
        let parent: BaseNode | null = root.parent
        while (parent && parent.type !== 'PAGE') parent = parent.parent
        return parent as PageNode | null
      })()
      if (page) await page.loadAsync()

      const clock = new Stopwatch()
      const sceneNodesById = await clock.time('index', () => indexSceneNodes([root]))
      const tokens = await clock.time('tokens', () => collectTokens(sceneNodesById.values()))
      const ir = await clock.time('serialize', () => serializeNode(root))
      if (!ir) throw new Error(`"${root.name}" (${root.type}) produced no exportable structure`)
      const irNodes: readonly IrNode[] = [ir]
      const assetSourceNodes = sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>
      await clock.time('vectors', () => annotateVectorLeaves(irNodes, assetSourceNodes))
      // Unannotated, a video fill's `assetSrc` looks shippable even when Figma's export API is
      // about to refuse it — `collectContextAssets` needs `videoUnavailable` set first to say so.
      await clock.time('videos', () => annotateVideoFills(irNodes, assetSourceNodes))
      const { html, css } = await clock.time('emit', () =>
        emitDjango(irNodes, sceneNodesById, tokens.names, { cssFile: params.cssFile as string })
      )
      // M9: emitDjango (single-node) never calls emitInteractions — only emitDjangoProject does
      // (index.ts:294-299). Reusing the exact same call here surfaces a node's own hover/press
      // CSS and overlay JS to design.context for the first time. Off-tree reaction destinations
      // (a variant outside root's own subtree) still resolve to nothing — sceneNodesById here
      // only covers root's own descendants, unlike the whole-site export's
      // collectReactionDestinationIds pass — an existing single-node-op limitation, not a
      // regression from this change.
      const interactions = await clock.time('interactions', () => emitInteractions(irNodes, sceneNodesById))

      const slug = slugify(root.name)
      let screenshotScale: { scale: number; downscaled: boolean } | null = null
      const files: unknown[] = [
        textFile(`${slug}.html`, 'text/html', html),
        textFile(`${slug}.css`, 'text/css', css),
      ]
      if (params.screenshot !== false) {
        const shot = await clock.time('screenshot', () => screenshot(root, params.scale as number))
        files.push(binaryFile(`${slug}.png`, 'image/png', shot.bytes))
        screenshotScale = shot
      }
      const assets = await clock.time('assets', () => collectContextAssets(irNodes, sceneNodesById))

      return {
        node: { id: root.id, name: root.name, type: root.type, width: root.width, height: root.height },
        layers: sceneNodesById.size,
        tokens: tokens.usage,
        ms: clock.report(),
        files,
        ...(screenshotScale
          ? {
              screenshotScale: screenshotScale.scale,
              ...(screenshotScale.downscaled
                ? { requestedScreenshotScale: params.scale as number, screenshotDownscaled: true }
                : {}),
            }
          : {}),
        assets,
        // Only when there is anything to link — a node with no hover/press/overlay behaviour
        // emits an empty string, and an empty stylesheet is not a file worth a caller opening.
        ...(interactions.css.length > 0
          ? { interactionsCss: textFile(`${slug}.interactions.css`, 'text/css', interactions.css) }
          : {}),
        ...(interactions.js.length > 0
          ? { interactionsJs: textFile(`${slug}.interactions.js`, 'text/javascript', interactions.js) }
          : {}),
        ...(typeof params.pair === 'string' && params.pair !== ''
          ? {
              breakpoints: await clock.time('breakpoints', async () => {
                if (!('children' in ir)) {
                  throw new Error(`"${root.name}" (${root.type}) has no children — nothing to pair a breakpoint frame against`)
                }
                const pairRoot = await resolveSceneNode(params.pair)
                // Same dynamic-page load dance as `root` above, for `pairRoot`.
                let pairParent: BaseNode | null = pairRoot.parent
                while (pairParent && pairParent.type !== 'PAGE') pairParent = pairParent.parent
                if (pairParent) await (pairParent as PageNode).loadAsync()

                const pairSceneNodesById = await indexSceneNodes([pairRoot])
                const pairIr = await serializeNode(pairRoot)
                if (!pairIr || !('children' in pairIr)) {
                  throw new Error(`"${pairRoot.name}" (${pairRoot.type}) produced no exportable structure to pair against`)
                }
                const mergedSceneNodesById = new Map([...sceneNodesById, ...pairSceneNodesById])
                // `tokens` above was collected over root's own subtree only — a variable the
                // pair frame binds and root never does would otherwise render as a raw resolved
                // value instead of a token reference for those properties. Re-collecting over
                // the merged set costs one more walk, only paid when `pair` is actually asked
                // for, and keeps this op's whole reason to exist (token references, not hex).
                const pairTokens = await collectTokens(mergedSceneNodesById.values())
                // `BreakpointGroup.frames` is widest-first (breakpoint-frames.ts's own doc) —
                // sort instead of assuming nodeId is always the wider one; a caller may pass
                // the mobile frame as `nodeId` and the desktop one as `pair`.
                const group: BreakpointGroup = {
                  slug,
                  frames: [
                    { width: root.width, breakpoint: 'a', node: ir as IrContainerNode },
                    { width: pairRoot.width, breakpoint: 'b', node: pairIr as IrContainerNode },
                  ].sort((x, y) => y.width - x.width),
                }
                const breakpointCss = await emitBreakpointCss(group, mergedSceneNodesById, pairTokens.names)
                return {
                  a: { id: root.id, name: root.name, width: root.width },
                  b: { id: pairRoot.id, name: pairRoot.name, width: pairRoot.width },
                  css: breakpointCss,
                }
              }),
            }
          : {}),
      }
    },
  },
  {
    name: 'motion.preview',
    summary: 'A standalone HTML page that actually plays the animation — open it and watch.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Root whose animated layers to preview.' },
      trigger: {
        type: 'string',
        default: 'autoplay',
        enum: ['autoplay', 'loop', 'hover', 'scrub', 'replay', 'click', 'other-interactive'],
        description: 'How the timeline starts in the preview.',
      },
      backend: {
        type: 'string',
        default: 'auto',
        enum: ['auto', 'css', 'gsap'],
        description: 'Override the backend choice. `auto` lets pickBackend decide.',
      },
    },
    async run(params) {
      if (!hasMotionApi()) {
        return { available: false, reason: 'this Figma build exposes no Motion API — the beta is not enabled' }
      }
      const root = await resolveSceneNode(params.nodeId)
      const sceneNodesById = await indexSceneNodes([root])

      const animated: Array<{ node: SceneNode; tracks: readonly MotionTrack[] }> = []
      for (const node of sceneNodesById.values()) {
        const snapshot = readMotionData(node)
        if (snapshot && snapshot.tracks.length > 0) animated.push({ node, tracks: snapshot.tracks })
      }
      if (animated.length === 0) return { available: true, animated: 0, files: [] }

      const { names } = await collectTokens(sceneNodesById.values())
      const nodes = []
      for (const entry of animated) {
        const { html } = await emitOne(entry.node, 'preview.css', sceneNodesById, names)
        nodes.push({ nodeId: entry.node.id, tracks: entry.tracks, html })
      }

      const duration = Math.max(...animated.flatMap((entry) => entry.tracks.map((track) => track.timelineDuration)))
      const backend = params.backend as string
      const preview = buildPreviewDocument({
        timelineId: root.id,
        duration,
        nodes,
        trigger: params.trigger as MotionTrigger,
        backendOverride: backend === 'auto' ? null : (backend as 'css' | 'gsap'),
      })

      return {
        available: true,
        animated: animated.length,
        backend: preview.backend,
        reason: preview.reason,
        // A GSAP-backed preview needs the GSAP runtime inlined, and the plugin ships none —
        // `networkAccess: none` means the page cannot fetch one either. Saying so is the
        // difference between "the animation is wrong" and "nothing ran".
        inert: preview.backend === 'gsap',
        files: [textFile(`${slugify(root.name)}.preview.html`, 'text/html', preview.html)],
      }
    },
  },

  {
    name: 'motion.context',
    summary: 'Keyframe tracks, the CSS/GSAP they compile to, and which backend fits — for a subtree.',
    agent:
      'Each keyframe reports `easing` as Figma stored it (a preset name, or a variable token when one is bound) ' +
      'and `curve` as numbers - bezier control points, or a spring\'s damping ratio, stiffness and solved settle ' +
      'time. Off the web, build from `curve` and pass `target: "native"`: the `backend` verdict (`css`/`gsap`) is a ' +
      'choice between two WEB runtimes and the emitted files are a stylesheet and a GSAP timeline, none of which ' +
      'means anything on iOS or Android - asking for them there is paying for an answer to someone else\'s question.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Root to scan for animated layers.' },
      trigger: {
        type: 'string',
        default: 'autoplay',
        enum: ['autoplay', 'loop', 'hover', 'scrub', 'replay', 'click', 'other-interactive'],
        description: 'How the timeline is meant to start. Changes which backend fits.',
      },
      keyframes: { type: 'boolean', default: true, description: 'Include per-keyframe detail, not just counts.' },
      target: {
        type: 'string',
        default: 'web',
        enum: ['web', 'native'],
        description:
          'What you are building. `native` drops the CSS/GSAP verdict and the files that go with it, and leaves ' +
          'the tracks and their curves - which is the whole answer off the web.',
      },
    },
    async run(params) {
      if (!hasMotionApi()) {
        // Not an error: the file may be fine and the account simply lacks the beta. An agent
        // needs to tell "nothing animates here" apart from "I cannot see animation at all".
        return {
          available: false,
          reason: 'this Figma build exposes no Motion API — the beta is not enabled for this account',
          animated: [],
        }
      }

      const root = await resolveSceneNode(params.nodeId)
      const sceneNodesById = await indexSceneNodes([root])
      // Where the designer has the timeline parked (Update 132), in seconds — null with no Motion
      // timeline open. "The keyframe I'm looking at" means the one under it.
      const playhead = (figma.motion as { playheadPosition?: number }).playheadPosition ?? null

      const motionNodes: MotionExportNode[] = []
      for (const node of sceneNodesById.values()) {
        const snapshot = readMotionData(node)
        if (snapshot && snapshot.tracks.length > 0) motionNodes.push({ nodeId: node.id, snapshot })
      }

      if (motionNodes.length === 0) {
        return { available: true, scanned: sceneNodesById.size, playhead, animated: [], files: [] }
      }

      const trigger = params.trigger as MotionTrigger
      const wantKeyframes = params.keyframes !== false
      const web = params.target !== 'native'

      const animated = []
      for (const entry of motionNodes) {
        const node = sceneNodesById.get(entry.nodeId)
        const tracks = entry.snapshot.tracks
        // Per node rather than per timeline: the same question ("CSS or GSAP, and why") is what
        // the export asks, and answering it here means an agent sees the reasoning instead of
        // just the output it produced.
        // Only asked for a web build: the verdict chooses between two browser runtimes, and
        // stating one for a SwiftUI target would be an answer to a question nobody asked.
        const decision = web ? pickBackend({ tracks, nodeCount: 1, trigger }) : null
        animated.push({
          nodeId: entry.nodeId,
          name: node?.name ?? entry.nodeId,
          type: node?.type ?? null,
          timelines: entry.snapshot.timelines.length,
          // The styles applied on top of the hand-made tracks, Figma's own and this file's
          // custom ones, told apart by `type`. A custom one holds its animations and their
          // timing itself, so all that is set here is where it starts.
          ...(entry.snapshot.animationStyles.length > 0
            ? {
                styles: entry.snapshot.animationStyles.map((style) =>
                  style.type === 'CUSTOM'
                    ? {
                        type: 'CUSTOM',
                        name: style.name,
                        styleId: style.styleId,
                        ...(style.timelineOffset ? { offset: style.timelineOffset } : {}),
                      }
                    : {
                        type: 'FIGMA',
                        name: style.name,
                        styleId: style.styleId,
                        ...(style.duration === undefined ? {} : { duration: style.duration }),
                        ...(style.timelineOffset ? { offset: style.timelineOffset } : {}),
                      }
                ),
              }
            : {}),
          ...(decision ? { backend: decision.backend, reason: decision.reason } : {}),
          tracks: await Promise.all(
            tracks.map(async (track) => ({
              field: track.field,
              duration: track.timelineDuration,
              keyframes: wantKeyframes
                ? await Promise.all(
                    track.keyframes.map(async (frame) => {
                      // `easing` is what Figma stored (a preset name, a variable alias, a raw
                      // spring); `curve` is what it means in numbers, for a consumer that is not
                      // a stylesheet. A keyframe's segment duration is the gap to the next one,
                      // which is what a bounce-only spring needs as its period.
                      const curve = motionCurve(frame.easing as { type?: string } | undefined, track.timelineDuration)
                      return {
                        at: frame.timelinePosition,
                        easing: await describeEasing(frame.easing),
                        ...(curve ? { curve } : {}),
                        value: frame.value,
                      }
                    })
                  )
                : track.keyframes.length,
            }))
          ),
        })
      }

      if (!web) {
        return {
          available: true,
          scanned: sceneNodesById.size,
          playhead,
          target: 'native',
          animated,
          files: [],
          note:
            'No backend verdict and no files: `css`/`gsap` is a choice between two browser runtimes, and the ' +
            'artifacts are a stylesheet and a GSAP timeline. The tracks and their `curve` are the whole answer here.',
        }
      }

      const { animation } = emitMotionExportArtifacts(motionNodes)
      const files: unknown[] = []
      if (animation.css) files.push(textFile('animations.css', 'text/css', animation.css))
      if (animation.js) files.push(textFile('animations.js', 'text/javascript', animation.js))

      return {
        available: true,
        scanned: sceneNodesById.size,
          playhead,
        animated,
        gsapPlugins: animation.gsapPlugins,
        files,
      }
    },
  },

  {
    name: 'paints.stack',
    summary: 'Every layer of one node’s fill sandwich, bottom to top — shader layers included.',
    agent:
      'The op for “what is this thing actually painted with”. `node.get` with paints:true answers the same question ' +
      'per node while walking a tree; this one answers it for one node and adds what only matters when you mean to ' +
      'rebuild the stack: the node’s own opacity and blend mode under the paints, the style the paints came from, and ' +
      'a catalogue entry per shader in the stack. A shader paint carries no colour, no stops and no hash — its id and ' +
      'its settings are the whole of it, so they are reported in full, with any variable bound inside them named. ' +
      'An applied shader hands its own setting names, types and defaults back with the paint, so the usual answer is ' +
      'named:true without importing anything; where the layer carries no such metadata the settings come back ' +
      'numbered with named:false — see `shaders[].why`. Read-only: nothing is imported into the file.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'The layer to take apart.' },
      children: {
        type: 'boolean',
        default: false,
        description: 'Also report every descendant that paints something — a banner’s picture is often on a child.',
      },
      limit: { type: 'number', default: 50, min: 1, max: 500, description: 'How many painted nodes come back.' },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      const withChildren = params.children as boolean
      const limit = params.limit as number

      const catalogue: { map?: Map<string, Shader> } = {}
      const seen = new Map<string, ShaderSummary>()

      const paintsOf = async (node: SceneNode, field: 'fills' | 'strokes'): Promise<PaintSummary[] | null> => {
        const paints = (node as unknown as Record<string, unknown>)[field]
        if (!Array.isArray(paints) || paints.length === 0) return null
        const shaders = paints.some((paint) => (paint as { type?: string })?.type === 'SHADER')
          ? await shadersFor(catalogue)
          : undefined
        const out: PaintSummary[] = []
        for (const [index, paint] of paints.entries()) {
          const described = await describePaint(paint, index, shaders)
          if (described.shader) seen.set(described.shader.id, described.shader)
          out.push(described)
        }
        return out
      }

      const styleName = async (node: SceneNode, field: 'fillStyleId' | 'strokeStyleId'): Promise<string | null> => {
        const id = (node as unknown as Record<string, unknown>)[field]
        if (id === figma.mixed) return 'mixed'
        if (typeof id !== 'string' || id === '') return null
        const style = await figma.getStyleByIdAsync(id)
        return style ? style.name : id
      }

      /* A vector painted per region keeps one stack per region of its network; its node-level
       * fills read as mixed, which used to make the whole layer look unpainted. */
      const regionsOf = async (node: SceneNode) => {
        const regions = regionFills(node)
        return regions ? summarizeRegions(regions) : null
      }

      const describeLayer = async (node: SceneNode) => {
        const fills = await paintsOf(node, 'fills')
        const strokes = await paintsOf(node, 'strokes')
        const regions = await regionsOf(node)
        if (!fills && !strokes && !regions) return null
        const opacity = (node as unknown as { opacity?: number }).opacity
        const blendMode = (node as unknown as { blendMode?: string }).blendMode
        return {
          id: node.id,
          name: node.name,
          type: node.type,
          // The node's own opacity and blend mode sit UNDER the paints: the stack is composited
          // first and the result is then blended into the page. A reading that reports only the
          // paints is a reading of half the sandwich.
          ...(typeof opacity === 'number' && opacity < 1 ? { opacity } : {}),
          ...(typeof blendMode === 'string' && blendMode !== 'NORMAL' && blendMode !== 'PASS_THROUGH'
            ? { blendMode }
            : {}),
          ...(fills ? { fills, fillStyle: await styleName(node, 'fillStyleId') } : {}),
          ...(strokes ? { strokes, strokeStyle: await styleName(node, 'strokeStyleId') } : {}),
          ...(regions ? { regions } : {}),
        }
      }

      const layers: unknown[] = []
      const first = await describeLayer(root)
      if (first) layers.push(first)
      if (withChildren && 'children' in root) {
        const queue: SceneNode[] = [...(root.children as readonly SceneNode[])]
        let cursor = 0
        while (cursor < queue.length && layers.length < limit) {
          const node = queue[cursor++] as SceneNode
          const described = await describeLayer(node)
          if (described) layers.push(described)
          if ('children' in node) queue.push(...(node.children as readonly SceneNode[]))
          await checkpoint()
        }
      }

      // Shader effects live on `effects`, not on `fills`, and the same shader is often both.
      // Reported here too so one call answers "which shaders is this layer made of".
      const effects = (root as unknown as { effects?: readonly unknown[] }).effects
      const shaderEffects: unknown[] = []
      if (Array.isArray(effects)) {
        for (const effect of effects) {
          if ((effect as { type?: string })?.type !== 'SHADER') continue
          const described = await describeShader(
            effect as { id?: unknown; properties?: unknown; propertyMetadata?: unknown },
            await shadersFor(catalogue)
          )
          seen.set(described.id, described)
          shaderEffects.push({
            visible: (effect as { visible?: boolean }).visible !== false,
            shader: described,
          })
        }
      }

      const shaders = [...seen.values()].map((shader) => ({
        ...shader,
        ...(shader.named
          ? {}
          : {
              why:
                'Neither this layer’s shader metadata nor listAvailableShaders() could name the settings — an ' +
                'older Figma runtime, or a shader not offered here. The ids below are stable and go back verbatim ' +
                'on a write; to get names, import the shader into the file first (figma.importShaderById, see ' +
                '`shader.define`) — a write, and not this op’s to make.',
            }),
      }))

      return {
        node: { id: root.id, name: root.name, type: root.type },
        layers,
        ...(shaderEffects.length > 0 ? { shaderEffects } : {}),
        ...(shaders.length > 0 ? { shaders } : {}),
      }
    },
  },

  {
    name: 'shader.define',
    summary: 'Import a shader by id so its settings get names — for the reads that come back unnamed.',
    agent:
      'An applied shader usually names its own settings: Figma hands the definitions back on the paint/effect ' +
      '(`propertyMetadata`), so `paints.stack` reports `named: true` with names, types and defaults without any ' +
      'import. This op is for the leftovers — a runtime old enough not to supply that metadata, or an id you have ' +
      'but have not applied to anything — where a read can only show opaque setting ids (`2331874402:1925656642`) ' +
      'and answers `named: false`. It imports the ids you name and returns their definitions. Write-gated because ' +
      '`importShaderById` materialises the shader into the file — for a shader already on a layer that is a no-op, ' +
      'but it is the Plugin API call for putting one there, and an op does not get to decide that on the ' +
      "designer's behalf. Run it once; afterwards every read names the settings, because the shader is then in the " +
      'catalogue. Ids come from `paints.stack` or `SHADER_LIST`.',
    mutates: true,
    params: {
      shaders: {
        type: 'json',
        required: true,
        description:
          'An ARRAY of shader ids; a bare string is refused by the param check. The ids must be ones ' +
          '`figma.listAvailableShaders()` offers — NOT the id a paint carries: those are two id spaces, and the ' +
          'paint\'s `8ce92017…/625` form is rejected outright.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Report what would be imported, and what the file already offers, without importing anything.',
      },
    },
    async run(params) {
      const raw = params.shaders
      const ids = (Array.isArray(raw) ? raw : [raw]).filter(
        (id): id is string => typeof id === 'string' && id !== ''
      )
      if (ids.length === 0) throw new Error('shaders must be a shader id, or an array of them')
      const dryRun = params.dryRun as boolean

      // What the file offers BEFORE anything is imported: that is the difference this op makes,
      // and reporting it is how a caller learns the import was unnecessary rather than assuming.
      const offered = new Map<string, Shader>()
      try {
        for (const shader of await figma.listAvailableShaders()) offered.set(shader.id, shader)
      } catch {
        /* a sandbox without the shader API — the import below will say so per id */
      }

      // Since API 1.141 an applied shader hands its definitions back on the paint/effect itself,
      // so an import changes nothing for an id already on this page. Scanned only for a dry run,
      // because that is the question a dry run is asked.
      const namedOnCanvas = new Set<string>()
      if (dryRun) {
        await enforceDeadline(async () => {
          const note = (entry: unknown) => {
            const one = entry as { type?: string; id?: unknown; propertyMetadata?: unknown }
            if (one?.type !== 'SHADER' || typeof one.id !== 'string') return
            if (one.propertyMetadata && Object.keys(one.propertyMetadata).length > 0) namedOnCanvas.add(one.id)
          }
          await figma.currentPage.loadAsync()
          await walkSceneNodes(figma.currentPage, (node) => {
            for (const field of ['fills', 'strokes', 'effects'] as const) {
              const bag = (node as unknown as Record<string, unknown>)[field]
              if (Array.isArray(bag)) for (const entry of bag) note(entry)
            }
          }, { includeRoot: false })
        })
      }

      const results: Array<Record<string, unknown>> = []
      for (const id of ids) {
        const before = offered.get(id)
        if (dryRun) {
          results.push({
            id,
            ok: true,
            offeredAlready: before !== undefined,
            ...(before ? { name: before.name, kind: before.type, imported: before.imported } : {}),
            would: namedOnCanvas.has(id)
              ? 'nothing — the read already names it'
              : before?.propertyDefinitions
                ? 'nothing — the file already names it'
                : 'import to read its settings',
          })
          continue
        }
        try {
          const shader = await figma.importShaderById(id)
          results.push({
            id,
            ok: true,
            offeredAlready: before !== undefined,
            name: shader.name,
            kind: shader.type,
            imported: shader.imported,
            // The whole point of the call: id → { name, type, default }, so a reading of a paint
            // stops being a row of numbers.
            properties: Object.entries(shader.propertyDefinitions ?? {}).map(([defId, definition]) => ({
              id: defId,
              name: definition.name,
              type: definition.type,
              ...(definition.defaultValue === undefined ? {} : { default: definition.defaultValue }),
              ...(definition.description ? { description: definition.description } : {}),
            })),
          })
        } catch (error) {
          // On a file whose catalogue is empty every id is "unknown", and Figma's message sends
          // the reader to the very call that answered nothing. Say which of the two it is.
          results.push({
            id,
            ok: false,
            error: String((error as Error)?.message || error),
            ...(offered.size === 0
              ? {
                  why:
                    'listAvailableShaders() offers nothing in this file, so no id can be imported — including the ' +
                    'ids of shaders visibly in use here. Read the shader off a layer instead: an applied shader ' +
                    'carries its own setting names (`paints.stack` → `named: true`). Failing that — an older ' +
                    'Figma runtime — read them from the shader panel, or from the source the Figma MCP hands out ' +
                    '(list_shaders → get_shader).',
                }
              : { offeredIds: [...offered.keys()].slice(0, 20) }),
          })
        }
      }

      const named = results.filter((row) => Array.isArray(row.properties) && (row.properties as unknown[]).length > 0)
      return {
        dryRun,
        total: results.length,
        named: named.length,
        failed: results.filter((row) => row.ok === false).length,
        results,
      }
    },
  },
]
