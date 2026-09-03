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

import { emitDjango } from '../targets/django/index.ts'
import { pickBackend, type MotionTrigger } from '../targets/django/motion/backend.ts'
import { readMotionData } from '../targets/django/motion/beta-adapter.ts'
import { emitMotionExportArtifacts, type MotionExportNode } from '../targets/django/motion/export-assets.ts'
import { buildPreviewDocument } from '../targets/django/motion/preview.ts'
import type { MotionTrack } from '../targets/django/motion/types.ts'
import { serializeNode, type IrNode } from '../targets/django/ir.ts'
import { annotateVectorLeaves, type AssetSourceNode } from '../targets/django/export/assets.ts'
import { detectImageFillFormat } from '../targets/django/assets.ts'
import { imageDimensions } from './image-dimensions.ts'
import { findAllWithCriteria } from '../utils/tree.ts'
import { readLocalVariables } from '../variables.ts'
import { binaryFile, slugify, textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

/* ----------------------------------------------------------------- helpers */

async function resolveSceneNode(ref: unknown): Promise<SceneNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await figma.getNodeByIdAsync(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as SceneNode
}

/** Lifted from the plugin UI's own export path so the agent walks the identical tree. */
async function indexSceneNodes(roots: readonly SceneNode[]): Promise<Map<string, SceneNode>> {
  const index = new Map<string, SceneNode>()
  for (const root of roots) {
    index.set(root.id, root)
    for (const node of await findAllWithCriteria(root, (candidate): candidate is SceneNode => true)) {
      index.set(node.id, node)
    }
  }
  return index
}

interface TokenReport {
  /** id → name, for the emitter, which takes a static map. */
  readonly names: Map<string, string>
  /** What the subtree binds and how often — the part an agent reads. */
  readonly usage: Array<{ token: string; uses: number }>
}

/**
 * Every variable the subtree actually binds, by token name and how often. This is the half a
 * screenshot cannot carry: it tells a generating agent which tokens are in play before it
 * writes a single declaration, and — because the count is there — which of them carry the
 * design and which appear once.
 *
 * Names come from the *local* variables plus a lookup for each bound id that is not among
 * them. The obvious alternative, `readAllVariables()`, is what the plugin's own export uses —
 * and it pulls every enabled library over the network, which is fine for an export a person
 * asked for and pathological for an op an agent is waiting on. A library variable that a layer
 * actually binds has already been imported into this file, so resolving it by id is a local
 * read; the cost stays proportional to the subtree rather than to the libraries.
 */
async function collectTokens(nodes: Iterable<SceneNode>): Promise<TokenReport> {
  const local = await readLocalVariables()
  const names = new Map(local.variables.map((variable) => [variable.id, variable.name]))
  const counts = new Map<string, number>()
  const missing = new Set<string>()

  const nameFor = async (id: string): Promise<string | null> => {
    const known = names.get(id)
    if (known !== undefined) return known
    if (missing.has(id)) return null
    try {
      const variable = await figma.variables.getVariableByIdAsync(id)
      if (variable) {
        names.set(id, variable.name)
        return variable.name
      }
    } catch {
      /* fall through — an id we cannot resolve is reported as absent, not as an error */
    }
    missing.add(id)
    return null
  }

  for (const node of nodes) {
    const bound = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables
    if (!bound) continue
    for (const entry of Object.values(bound)) {
      // A field is either one alias (`fills` on a shape) or an array of them (`fills` on a
      // multi-paint node) — flattening here keeps the caller from caring which.
      const aliases = Array.isArray(entry) ? entry : [entry]
      for (const alias of aliases) {
        const id = (alias as { id?: unknown } | null)?.id
        if (typeof id !== 'string') continue
        const name = await nameFor(id)
        if (!name) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }
  return {
    names,
    usage: [...counts.entries()]
      .map(([token, uses]) => ({ token, uses }))
      .sort((a, b) => b.uses - a.uses || a.token.localeCompare(b.token)),
  }
}

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

async function screenshot(node: SceneNode, scale: number): Promise<Uint8Array> {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
}

/* --------------------------------------------------------------------- ops */

export const CONTEXT_OPS: readonly OpDef[] = [
  {
    name: 'node.screenshot',
    summary: 'Render a node to PNG — the one way an agent can check what it actually drew.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Layer to render.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Export scale. 2 for retina.' },
    },
    async run(params) {
      const node = await resolveSceneNode(params.nodeId)
      const scale = params.scale as number
      const bytes = await screenshot(node, scale)
      return {
        node: { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height },
        scale,
        bytes: bytes.length,
        file: binaryFile(`${slugify(node.name)}.png`, 'image/png', bytes),
      }
    },
  },

  {
    name: 'image.fills',
    summary: 'The original files behind a subtree’s image fills — the photo itself, not a render with text baked over it.',
    agent:
      'A render (node.screenshot, NODE_EXPORT) flattens overlays and text into the pixels; this hands back the uploaded ' +
      'source of each IMAGE paint under the node, deduplicated by hash, largest first. Read-only: no export settings on ' +
      'the node, no write gate — `figma.getImageByHash` is a read. Answers with files, not payloads.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Subtree to search for image fills.' },
      limit: { type: 'number', default: 20, min: 1, max: 100, description: 'How many distinct images to hand back.' },
      minSide: {
        type: 'number',
        default: 64,
        min: 0,
        description: 'Skip images whose longer side is below this many pixels — icons and textures, not photos.',
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      const limit = params.limit as number
      const minSide = params.minSide as number

      // Image data belongs to a loaded page: with dynamic page loading, an image on a page the
      // designer has not opened is a promise that never settles. Load it first.
      let page: BaseNode | null = root
      while (page && page.type !== 'PAGE') page = page.parent
      if (page) await (page as PageNode).loadAsync()

      // A read that does not come back is worse than one that says it failed: every fetch
      // below is raced against a deadline and reported per image.
      const deadline = <T,>(work: Promise<T>, what: string, ms = 20000): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms)
          work.then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            (error) => {
              clearTimeout(timer)
              reject(error)
            },
          )
        })

      // One entry per distinct image: the same photo is often the fill of a frame and of the
      // rectangle inside it, and the caller wants the file once.
      const hits = new Map<string, { node: SceneNode; paintIndex: number; scaleMode: string }>()
      const visit = (node: SceneNode) => {
        if (node.visible === false) return
        const fills = (node as GeometryMixin).fills
        if (Array.isArray(fills)) {
          fills.forEach((paint, paintIndex) => {
            if (paint.type !== 'IMAGE' || !paint.imageHash || paint.visible === false) return
            if (!hits.has(paint.imageHash)) {
              hits.set(paint.imageHash, { node, paintIndex, scaleMode: paint.scaleMode })
            }
          })
        }
        if ('children' in node) for (const child of node.children) visit(child)
      }
      visit(root)

      // `getSizeAsync` is not consulted: on a live file it never settled, for any image. The
      // fills are ranked by the area of the layer they paint — the section photo is the big
      // node, the thumbnails are the small ones — bytes are fetched for the top `limit` only,
      // and pixel dimensions are read off the file header.
      const ranked = [...hits.entries()].sort(
        ([, a], [, b]) => b.node.width * b.node.height - a.node.width * a.node.height,
      )
      const failures: Array<{ node: string; hash: string; error: string }> = []
      let skipped = 0
      const images: Array<Record<string, unknown>> = []
      for (const [hash, hit] of ranked) {
        if (images.length >= limit) break
        const image = figma.getImageByHash(hash)
        if (!image) continue
        let bytes: Uint8Array
        try {
          bytes = await deadline(image.getBytesAsync(), `getBytesAsync ${hit.node.name}`, 60000)
        } catch (error) {
          failures.push({ node: hit.node.id, hash, error: String(error) })
          continue
        }
        const format = detectImageFillFormat(bytes)
        const { width, height } = imageDimensions(bytes)
        if (width && height && Math.max(width, height) < minSide) {
          skipped += 1
          continue
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
          file: binaryFile(
            `${slugify(hit.node.name)}-${hash.slice(0, 8)}.${format}`,
            format === 'jpg' ? 'image/jpeg' : `image/${format}`,
            bytes,
          ),
        })
      }
      const truncated = Math.max(0, ranked.length - images.length - failures.length - skipped)
      return {
        node: { id: root.id, name: root.name, type: root.type },
        count: images.length,
        truncated,
        skippedSmall: skipped,
        /** Images Figma would not hand over in time — named, so the caller can retry or fall back. */
        failed: failures,
        images,
      }
    },
  },

  {
    name: 'node.focus',
    summary: 'Select a node and scroll the designer to it — how an agent says "this one, look".',
    agent:
      'Selects the node and scrolls the designer to it — use it instead of describing where something is.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Node to reveal.' },
      select: { type: 'boolean', default: true, description: 'Also select it, not just scroll to it.' },
    },
    async run(params) {
      const node = await resolveSceneNode(params.nodeId)
      let page: BaseNode | null = node.parent
      while (page && page.type !== 'PAGE') page = page.parent
      if (!page) throw new Error(`"${node.name}" is not on a page — nothing to scroll to`)

      // Moving the viewport works on every plan and touches no part of the document, which is
      // why this sits with the reads. The link is the better answer when it can be built — but
      // `figma.fileKey` is given only to private plugins on Organization plans, so outside one
      // there is nothing to build it from and the suffix is all an agent can hand over.
      await (page as PageNode).loadAsync()
      await figma.setCurrentPageAsync(page as PageNode)
      if (params.select !== false) figma.currentPage.selection = [node]
      figma.viewport.scrollAndZoomIntoView([node])

      const anchor = `?node-id=${node.id.replace(':', '-')}`
      const fileKey = figma.fileKey
      return {
        node: { id: node.id, name: node.name, type: node.type },
        page: { id: page.id, name: (page as PageNode).name },
        selected: params.select !== false,
        /** A link worth sending, when this plugin is private to an Organization. */
        url: fileKey ? `https://www.figma.com/design/${fileKey}/${anchor}` : null,
        /** Paste the file's own URL in front of this when there is no `url` above. */
        deepLinkSuffix: anchor,
      }
    },
  },

  {
    name: 'design.context',
    summary: 'Reference HTML + CSS + PNG for a node, with the tokens it binds — implement from this.',
    agent:
      'Answers with file paths, not payloads — open them. The token usage table says which variables actually carry the subtree.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Frame or component to describe.' },
      cssFile: { type: 'string', default: 'design.css', description: 'Name the emitted HTML links to.' },
      screenshot: { type: 'boolean', default: true, description: 'Also render a PNG reference.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Screenshot scale.' },
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
      await clock.time('vectors', () =>
        annotateVectorLeaves(irNodes, sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>)
      )
      const { html, css } = await clock.time('emit', () =>
        emitDjango(irNodes, sceneNodesById, tokens.names, { cssFile: params.cssFile as string })
      )

      const slug = slugify(root.name)
      const files: unknown[] = [
        textFile(`${slug}.html`, 'text/html', html),
        textFile(`${slug}.css`, 'text/css', css),
      ]
      if (params.screenshot !== false) {
        const png = await clock.time('screenshot', () => screenshot(root, params.scale as number))
        files.push(binaryFile(`${slug}.png`, 'image/png', png))
      }

      return {
        node: { id: root.id, name: root.name, type: root.type, width: root.width, height: root.height },
        layers: sceneNodesById.size,
        tokens: tokens.usage,
        ms: clock.report(),
        files,
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

      const motionNodes: MotionExportNode[] = []
      for (const node of sceneNodesById.values()) {
        const snapshot = readMotionData(node)
        if (snapshot && snapshot.tracks.length > 0) motionNodes.push({ nodeId: node.id, snapshot })
      }

      if (motionNodes.length === 0) {
        return { available: true, scanned: sceneNodesById.size, animated: [], files: [] }
      }

      const trigger = params.trigger as MotionTrigger
      const wantKeyframes = params.keyframes !== false

      const animated = []
      for (const entry of motionNodes) {
        const node = sceneNodesById.get(entry.nodeId)
        const tracks = entry.snapshot.tracks
        // Per node rather than per timeline: the same question ("CSS or GSAP, and why") is what
        // the export asks, and answering it here means an agent sees the reasoning instead of
        // just the output it produced.
        const decision = pickBackend({ tracks, nodeCount: 1, trigger })
        animated.push({
          nodeId: entry.nodeId,
          name: node?.name ?? entry.nodeId,
          type: node?.type ?? null,
          timelines: entry.snapshot.timelines.length,
          backend: decision.backend,
          reason: decision.reason,
          tracks: await Promise.all(
            tracks.map(async (track) => ({
              field: track.field,
              duration: track.timelineDuration,
              keyframes: wantKeyframes
                ? await Promise.all(
                    track.keyframes.map(async (frame) => ({
                      at: frame.timelinePosition,
                      easing: await describeEasing(frame.easing),
                      value: frame.value,
                    }))
                  )
                : track.keyframes.length,
            }))
          ),
        })
      }

      const { animation } = emitMotionExportArtifacts(motionNodes)
      const files: unknown[] = []
      if (animation.css) files.push(textFile('animations.css', 'text/css', animation.css))
      if (animation.js) files.push(textFile('animations.js', 'text/javascript', animation.js))

      return {
        available: true,
        scanned: sceneNodesById.size,
        animated,
        gsapPlugins: animation.gsapPlugins,
        files,
      }
    },
  },
]
