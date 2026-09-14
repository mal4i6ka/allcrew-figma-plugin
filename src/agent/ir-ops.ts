/**
 * Agent listener — the framework-neutral half: a screen as data, and its pictures as files.
 *
 * `design.context` answers with reference HTML and CSS. That is the right answer when the
 * target is a web page and the wrong one for everything else: an agent building a React
 * Native screen, a SwiftUI view or a Compose screen has to *un-read* the markup to find the
 * stack, the gap and the token underneath it.
 *
 * `design.ir` hands over that underneath directly — the same intermediate tree the plugin's
 * own exporters compile, before any of them turns it into a language. Layout comes back in
 * flexbox vocabulary (row/column, gap, padding, justify/align, fixed/hug/fill sizing) because
 * that is the one model every modern target expresses: `flex-direction: row` is RN's
 * `flexDirection`, SwiftUI's `HStack`, Compose's `Row`. Nothing else about a framework is
 * assumed, and no code is emitted.
 *
 * `assets.export` is the other half. The IR *points* at pictures; a build needs the files, at
 * the densities its platform asks for and under the names its platform expects. Both ops keep
 * the channel's rule about bulk: bytes leave as files on disk, not as base64 in the answer.
 */

import { serializeNode, type IrNode } from '../targets/django/ir.ts'
import { annotateVectorLeaves, annotateVideoFills, type AssetSourceNode } from '../targets/django/export/assets.ts'
import {
  collectContextAssets,
  collectTokens,
  indexSceneNodes,
  resolveSceneNode,
  screenshot,
  type ContextAsset,
} from './subtree.ts'
import {
  groupTypeStyles,
  iosContents,
  screenSummary,
  typeStyleOf,
  type TextNodeFacts,
  type TypeStyle,
  type TypeStyleUse,
} from './ir-mobile.ts'
import { imageAlpha, type ImageAlpha } from './image-dimensions.ts'
import { binaryFile, slugify, textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

/* ------------------------------------------------------------------ shapes */

/** What the subtree is made of, by IR node type — the one number an agent reads before it
 * decides whether to open the tree at all. */
export type IrStats = Record<string, number>

export function countIrNodes(node: IrNode, into: IrStats = {}): IrStats {
  into[node.type] = (into[node.type] ?? 0) + 1
  // Only containers and instance references carry children; the union's own discriminant
  // answers that, so nothing is asserted onto a node that has none.
  for (const child of node.type === 'container' || node.type === 'instance-ref' ? node.children : []) {
    countIrNodes(child, into)
  }
  return into
}

/** One component the screen instantiates, with the property values it was given. A build needs
 * this to know the screen is `<Button type="Primary">` rather than a box with a label in it. */
export interface IrComponentUse {
  name: string
  componentKey: string | null
  uses: number
  /** Distinct property sets seen across the uses — the props the component takes, as used here. */
  properties: Array<Record<string, unknown>>
  /** One instance id, so the set behind this component can be resolved without a document-wide
   * search. `componentKey` identifies the component across files but no read op accepts a key,
   * which left an agent that wanted the component's full API (axes, options, defaults) with a
   * `components.list` call over the whole document as its only route. */
  instanceId: string
  /** The COMPONENT_SET this component belongs to, filled in by `design.ir` — `component.api` on
   * this id answers what each variant value does. Absent for a component with no set. */
  componentSetId?: string
  /** The variant axes the component takes, each with its options and default — the enum a build
   * declares. `properties` above is what this screen happens to USE; this is what exists. */
  axes?: Array<{ name: string; default: string; options: readonly string[] }>
}

export function collectComponentUses(node: IrNode, into = new Map<string, IrComponentUse>()): IrComponentUse[] {
  if (node.type === 'instance-ref') {
    const name = node.componentSetName || node.name || 'component'
    const entry =
      into.get(name) ?? { name, componentKey: node.componentKey, uses: 0, properties: [], instanceId: node.id }
    entry.uses += 1
    const props: Record<string, unknown> = { ...node.componentProperties }
    // Distinct property sets, not one per instance: a list of twelve identical rows is one
    // fact about the component, repeated twelve times is noise in the agent's context.
    const fingerprint = JSON.stringify(props)
    if (Object.keys(props).length > 0 && !entry.properties.some((seen) => JSON.stringify(seen) === fingerprint)) {
      entry.properties.push(props)
    }
    into.set(name, entry)
  }
  for (const child of node.type === 'container' || node.type === 'instance-ref' ? node.children : []) {
    collectComponentUses(child, into)
  }
  return [...into.values()].sort((a, b) => b.uses - a.uses)
}

/**
 * Fills `componentSetId` and `axes` in on each use, by asking one instance of each component
 * what it is an instance of. One `getMainComponentAsync` per DISTINCT component (not per
 * instance), and the definitions read is the same guarded getter `components.list` uses - a set
 * with errors in the file leaves the axes out instead of sinking the call.
 */
export async function annotateComponentUses(uses: readonly IrComponentUse[]): Promise<void> {
  for (const use of uses) {
    try {
      const instance = await figma.getNodeByIdAsync(use.instanceId)
      if (!instance || instance.type !== 'INSTANCE') continue
      const main = await instance.getMainComponentAsync()
      const set = main?.parent?.type === 'COMPONENT_SET' ? main.parent : null
      if (!set) continue
      use.componentSetId = set.id
      const definitions = set.componentPropertyDefinitions
      const axes = Object.entries(definitions ?? {})
        .filter(([, spec]) => spec.type === 'VARIANT')
        .map(([axis, spec]) => ({
          name: axis,
          default: String(spec.defaultValue ?? ''),
          options: spec.variantOptions ?? [],
        }))
      if (axes.length > 0) use.axes = axes
    } catch {
      // A component that cannot be resolved (deleted main, a set Figma refuses) keeps the use
      // count it already has - the screen still instantiates it.
    }
  }
}

/* ------------------------------------------------------------------ assets */

export type AssetNaming = 'plain' | 'web' | 'ios' | 'android'

/** Android density buckets, by the scale factor each one means. Anything else falls back to
 * `drawable-nodpi`, which is Android's own "this is not density-specific" bucket rather than a
 * guess at the closest one. */
const ANDROID_BUCKETS: Record<string, string> = {
  '1': 'drawable-mdpi',
  '1.5': 'drawable-hdpi',
  '2': 'drawable-xhdpi',
  '3': 'drawable-xxhdpi',
  '4': 'drawable-xxxhdpi',
}

/**
 * Where a file of this name, scale and format belongs in a project of this platform.
 *
 * The file that crosses the channel is always a flat basename — the bridge refuses a name with
 * a separator in it, and rightly so. So the layout travels as advice in the manifest: the
 * agent moves the file, and the advice is explicit enough to be followed without knowing the
 * platform's conventions by heart.
 */
export function assetPath(name: string, opts: { naming: AssetNaming; scale: number; format: string }): string {
  const base = slugify(name, 'asset')
  const ext = opts.format.toLowerCase() === 'jpg' ? 'jpg' : opts.format.toLowerCase()
  const suffix = opts.scale === 1 ? '' : `@${opts.scale}x`
  switch (opts.naming) {
    case 'ios':
      // An asset catalogue keys on the imageset directory; the scale lives in the filename and
      // Contents.json maps the two. Vectors go in as a single-scale PDF/SVG entry.
      return `Assets.xcassets/${base}.imageset/${base}${suffix}.${ext}`
    case 'android':
      // Android has no @Nx: density is the directory. A vector is not density-specific at all.
      if (ext === 'svg') return `assets/${base}.svg`
      return `res/${ANDROID_BUCKETS[String(opts.scale)] ?? 'drawable-nodpi'}/${base}.${ext}`
    case 'web':
      return `assets/${base}${suffix}.${ext}`
    default:
      return `${base}${suffix}.${ext}`
  }
}

/** The basename the file itself travels under. Kept flat and collision-free across scales, so
 * three densities of one icon do not overwrite each other in the bridge's directory. */
export function assetFileName(name: string, scale: number, format: string): string {
  const ext = format.toLowerCase() === 'jpg' ? 'jpg' : format.toLowerCase()
  return `${slugify(name, 'asset')}${scale === 1 ? '' : `@${scale}x`}.${ext}`
}

/** Scales requested by the caller, sane and de-duplicated. Vector formats ignore scale
 * entirely — exporting one SVG three times is three identical files and a slower answer. */
export function requestedScales(raw: unknown, format: string): number[] {
  if (format.toUpperCase() === 'SVG' || format.toUpperCase() === 'PDF') return [1]
  const list = Array.isArray(raw) ? raw : [raw]
  const scales = list
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0.1 && value <= 4)
  const unique = [...new Set(scales)]
  return unique.length > 0 ? unique.sort((a, b) => a - b) : [1]
}

/**
 * A stem no other asset in this call already took. `taken` is the caller's set, so the numbers
 * are stable for the run and an asset's densities all share one stem.
 */
export function uniqueStem(base: string, taken: Set<string>): string {
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`
  taken.add(candidate)
  return candidate
}

/** Export format → the mime type the file is written with. */
const MIME_BY_FORMAT: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  SVG: 'image/svg+xml',
  PDF: 'application/pdf',
}

/** One asset as it left: where it came from and every file produced for it, with the path the
 * target platform expects that file to live at. */
export interface ExportedAsset {
  nodeId: string
  name: string
  kind: string
  files: Array<{ scale: number; file: string; bytes: number; path: string }>
  /** Whether this asset's own IMAGE paint can carry transparency — the difference between a
   * cut-out figure and a photograph, and the reason a build places one in a corner and the
   * other under a `cover` scrim. Read from the paint's uploaded SOURCE bytes
   * (`figma.getImageByHash`), never from the file this op just produced: `exportAsync`'s PNG
   * always carries an alpha channel, so judging the export would answer `alpha` for every
   * raster and tell a build nothing. Absent — not `unknown` — when the asset has no image-paint
   * source at all: a vector export, or a raster made by rasterizing shapes/text rather than an
   * image fill. See `assets.export`'s `alpha` param for why this is opt-in.
   */
  alpha?: ImageAlpha
  /** iOS only: the imageset manifest written beside the images. Not a file of the asset — the
   * file that makes the other three an asset. */
  contents?: { file: string; path: string }
}

/* ------------------------------------------------------------------ reading */

/**
 * The screen's type, read off the text layers themselves.
 *
 * It has to come from the nodes rather than the tree because the tree never carried it: the
 * CSS emitter reads type from the live node on its way out, which a web target can afford and
 * a SwiftUI one cannot. Node-level values, not per-run ones — a run that diverges from its
 * node is a local override, and `text.segments` is the op for those.
 */
async function typographyOf(
  nodes: Iterable<SceneNode>,
  tokenNames: ReadonlyMap<string, string>
): Promise<TypeStyleUse[]> {
  const entries: Array<{ node: TextNodeFacts; style: TypeStyle }> = []
  for (const node of nodes) {
    if (node.type !== 'TEXT') continue
    const facts: TextNodeFacts = {
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontName: node.fontName,
      fontSize: node.fontSize,
      fontWeight: node.fontWeight,
      lineHeight: node.lineHeight,
      letterSpacing: node.letterSpacing,
      textCase: node.textCase,
      textDecoration: node.textDecoration,
      boundVariables: node.boundVariables as unknown as Record<string, unknown> | undefined,
    }
    entries.push({ node: facts, style: typeStyleOf(facts, tokenNames) })
  }
  return groupTypeStyles(entries)
}

/**
 * Alpha of a node's own IMAGE paint, read from the paint's SOURCE bytes — never from a file this
 * op is about to export. `exportAsync`'s PNG output always carries an alpha channel, so judging
 * the export would answer `alpha` for every raster asset and tell a build nothing; the honest
 * answer lives in the upload itself. `cache` is the caller's, keyed by image hash, so a photo
 * that fills both a frame and a rectangle inside it is read once per `assets.export` call, not
 * once per node that happens to share it.
 *
 * Undefined means "no image paint to ask" (a vector, a rasterized shape, a hash Figma can no
 * longer resolve) — never a guess. A resolvable hash whose format this reader cannot judge
 * (an animated GIF, say) still answers `unknown` rather than being folded into "no answer".
 */
async function sourceImageAlpha(node: SceneNode, cache: Map<string, ImageAlpha>): Promise<ImageAlpha | undefined> {
  const fills = (node as GeometryMixin).fills
  if (!Array.isArray(fills)) return undefined
  const paint = (fills as Paint[]).find(
    (candidate): candidate is ImagePaint =>
      candidate.type === 'IMAGE' && candidate.visible !== false && typeof (candidate as ImagePaint).imageHash === 'string'
  )
  if (!paint) return undefined
  const hash = paint.imageHash as string
  const cached = cache.get(hash)
  if (cached) return cached
  const image = figma.getImageByHash(hash)
  if (!image) return undefined
  try {
    const bytes = await image.getBytesAsync()
    const alpha = imageAlpha(bytes)
    cache.set(hash, alpha)
    return alpha
  } catch {
    // An expired/unresolvable hash answers nothing rather than a fabricated value — the same
    // node will fail its own exportAsync below if the image is genuinely gone from the file.
    return undefined
  }
}

/* --------------------------------------------------------------------- ops */

export const IR_OPS: readonly OpDef[] = [
  {
    name: 'design.ir',
    summary: 'A screen as a framework-neutral tree: stacks, sizing, type, paints by token name, text, interactions.',
    agent:
      'Reach for this when the target is not a web page — a mobile screen, a desktop view, any stack with its own ' +
      'component model. It is the same tree the plugin\'s own exporters compile, handed over before any of them turns ' +
      'it into a language: no HTML, no JSX, no assumption about a framework. Layout is flexbox vocabulary ' +
      '(row/column, gap, padding, justify/align, fixed/hug/fill), which maps one-to-one onto React Native, ' +
      'SwiftUI stacks and Compose rows. Colours and spacing carry the TOKEN that produced them where one exists — ' +
      'build from those, not from hex. The tree arrives as a JSON file (they are big); `stats`, `tokens`, ' +
      '`components` and `assets` come back inline so you can decide what to open. Pictures are only POINTED at ' +
      'here — call assets.export for the files. `type` is the table of distinct text styles with the token behind ' +
      'each value: the tree carries what the text SAYS, this says how it is set, and a mobile build needs both. ' +
      '`screen` is the phone-shaped half — what sits in the system bands top and bottom, what the designer pinned ' +
      'while the rest scrolls, how many children are placed by coordinates rather than by a stack. Figma has no ' +
      'safe-area concept, so those bands are reported as the layers that are actually there, never as an inset. ' +
      'Motion is not in the tree: motion.context and transition.context answer that, and flow.map has the ' +
      'navigation graph.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Frame, component or any layer to describe.' },
      assets: {
        type: 'boolean',
        default: true,
        description: 'List the pictures the tree references (names and node ids, not files).',
      },
      components: {
        type: 'boolean',
        default: true,
        description: 'List the component instances used, with the property values they were given.',
      },
      inline: {
        type: 'boolean',
        default: false,
        description: 'Return the tree in the answer instead of as a file. Small components only — a screen is megabytes.',
      },
      screenshot: {
        type: 'boolean',
        default: false,
        description: 'Also render a PNG, for a look at what the tree describes.',
      },
      type: {
        type: 'boolean',
        default: true,
        description: 'The distinct text styles of the screen — family, size, leading, tracking, and their tokens.',
      },
      screen: {
        type: 'boolean',
        default: true,
        description: 'System bands, pinned layers, scrolling and how much of the screen is absolutely positioned.',
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      // `documentAccess: "dynamic-page"` — a node handed over by id may live on a page nobody
      // has opened, and its subtree is unreadable until that page is loaded.
      let parent: BaseNode | null = root.parent
      while (parent && parent.type !== 'PAGE') parent = parent.parent
      if (parent) await (parent as PageNode).loadAsync()

      const sceneNodesById = await indexSceneNodes([root])
      const tokens = await collectTokens(sceneNodesById.values())
      const ir = await serializeNode(root)
      if (!ir) throw new Error(`"${root.name}" (${root.type}) produced no exportable structure`)

      const irNodes: readonly IrNode[] = [ir]
      const assetSourceNodes = sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>
      // Without these two passes a vector leaf has no file to point at and a video fill looks
      // shippable when Figma's export API is about to refuse it.
      await annotateVectorLeaves(irNodes, assetSourceNodes)
      await annotateVideoFills(irNodes, assetSourceNodes)

      const assets = params.assets === false ? [] : await collectContextAssets(irNodes, sceneNodesById)
      const slug = slugify(root.name)
      const tree = JSON.stringify(ir, null, 2)
      /* The set id and axes behind each instantiated component: one `getMainComponentAsync` per
       * distinct component, so the answer names what an agent should call `component.api` on
       * instead of leaving it to search the document for a name it only has as a key. */
      const componentUses = params.components === false ? [] : collectComponentUses(ir)
      if (componentUses.length > 0) await annotateComponentUses(componentUses)

      return {
        node: { id: root.id, name: root.name, type: root.type, width: root.width, height: root.height },
        layers: sceneNodesById.size,
        stats: countIrNodes(ir),
        tokens: tokens.usage,
        ...(params.components === false ? {} : { components: componentUses }),
        ...(params.assets === false ? {} : { assets }),
        ...(params.type === false ? {} : { type: await typographyOf(sceneNodesById.values(), tokens.names) }),
        ...(params.screen === false ? {} : { screen: screenSummary(ir, { width: root.width, height: root.height }) }),
        bytes: tree.length,
        ...(params.inline === true
          ? { ir }
          : { ir: textFile(`${slug}.ir.json`, 'application/json', tree) }),
        ...(params.screenshot === true
          ? { preview: binaryFile(`${slug}.png`, 'image/png', await screenshot(root, 2)) }
          : {}),
      }
    },
  },

  {
    name: 'assets.export',
    summary: 'The pictures of a screen as files — chosen formats and densities, named for the platform that will use them.',
    agent:
      'The companion to design.ir: the tree points at pictures, this produces them. `select: "assets"` exports every ' +
      'raster and vector the subtree actually references (deduplicated, the same list design.ir reports); ' +
      '`select: "node"` exports the node itself, which is what you want for a single icon or a share image. ' +
      'Scales apply to raster formats only — SVG and PDF are exported once, because three identical vectors is ' +
      'three files and a slower answer. `naming` decides the paths in the manifest: `ios` an asset catalogue, ' +
      '`android` density buckets, `web` an @2x pair, `plain` flat names. The FILES always arrive as flat ' +
      'basenames (the bridge refuses a path), and the manifest says where each one belongs — move them, do not ' +
      'guess the layout. An asset design.ir marked `exportable: false` is a video Figma already refused; it is ' +
      'skipped here with its reason rather than retried. One answer carries about 2.5 MB of image data — measured, ' +
      'not guessed: past roughly three megabytes the sandbox→UI hop stalls and the call never returns. So a screen ' +
      'comes in pages: the answer stops before that line, says `remaining` and `nextOffset`, and you call again with ' +
      '`offset`. Three calls of a second each beat one that dies at the bridge ceiling with nothing to show.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Node to export, or the screen whose assets to collect.' },
      select: {
        type: 'string',
        default: 'node',
        enum: ['node', 'assets'],
        description: '"node" exports this layer; "assets" exports every picture its subtree references.',
      },
      format: {
        type: 'string',
        default: 'PNG',
        enum: ['PNG', 'JPG', 'SVG', 'PDF'],
        description: 'Export format. Vectors are usually SVG; photos PNG or JPG.',
      },
      scales: {
        type: 'json',
        default: [1, 2, 3],
        description: 'Raster densities, e.g. [1,2,3] for mobile or [1,2] for web. Ignored for SVG/PDF.',
      },
      naming: {
        type: 'string',
        default: 'plain',
        enum: ['plain', 'web', 'ios', 'android'],
        description: 'Which platform’s file layout the manifest should advise.',
      },
      limit: {
        type: 'number',
        default: 24,
        min: 1,
        max: 200,
        description: 'How many assets to export in one call — a screen can reference dozens.',
      },
      offset: {
        type: 'number',
        default: 0,
        min: 0,
        max: 1000,
        description:
          'Skip this many assets before exporting — how you page through a screen whose pictures do not fit one ' +
          'call. The answer says `remaining` and the offset to ask for next.',
      },
      budgetBytes: {
        type: 'number',
        default: 2_500_000,
        min: 100_000,
        max: 8_000_000,
        description:
          'How many bytes one answer may carry. Measured, not guessed: a reply under ~2.5 MB of image data comes ' +
          'back in under a second, and one over ~3 MB never arrives at all — the sandbox→UI hop stalls past that. ' +
          'The export stops BEFORE crossing it and reports what is left, so paging with `offset` is the way to ' +
          'take a whole screen.',
      },
      budgetMs: {
        type: 'number',
        default: 60_000,
        min: 5_000,
        max: 170_000,
        description:
          'Stop after this long and answer with what is done. Checked BETWEEN exports — one export already under ' +
          'way runs to its end, which is why maxPixels exists as well. The bridge gives one call 180s.',
      },
      maxPixels: {
        type: 'number',
        default: 4_000_000,
        min: 250_000,
        max: 60_000_000,
        description:
          'Skip an export bigger than this many pixels. Figma’s exporter is not linear in size: the same 1440×756 ' +
          'section comes back in 0.6s at @2x (2.2 MP) and takes over two minutes at @3x (9.8 MP) — past the ' +
          'bridge’s 180s ceiling, with no way to interrupt it. Four megapixels is the ceiling that keeps a call ' +
          'answerable; a full-width frame at @3x is almost never the asset anyone wanted anyway.',
      },
      alpha: {
        type: 'boolean',
        default: false,
        description:
          'Report each raster asset’s own alpha ("none"/"alpha"/"unknown") — the difference between a cut-out ' +
          'figure and a photograph, read from the SOURCE image (figma.getImageByHash), never the exported PNG ' +
          '(which always carries a channel and would say "alpha" for everything). Off by default: unlike ' +
          'exportAsync this fetch is not bounded by maxPixels — it hands back the WHOLE original upload — so ' +
          'turning it on for every asset would double the unbounded work this op otherwise refuses to do. ' +
          'Cheap once asked for: cached per image hash within the call and charged against budgetMs, so a ' +
          'photo reused across several assets is only read once. Never set for SVG/PDF, which have no bitmap ' +
          'source to answer from.',
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      let parent: BaseNode | null = root.parent
      while (parent && parent.type !== 'PAGE') parent = parent.parent
      if (parent) await (parent as PageNode).loadAsync()

      const format = String(params.format ?? 'PNG').toUpperCase() as 'PNG' | 'JPG' | 'SVG' | 'PDF'
      const naming = String(params.naming ?? 'plain') as AssetNaming
      const scales = requestedScales(params.scales, format)
      const limit = Number(params.limit ?? 24)

      /** What to export: the node itself, or every picture its subtree points at. */
      const targets: Array<{ nodeId: string; name: string; kind: string; reason?: string }> = []
      if (params.select === 'assets') {
        const sceneNodesById = await indexSceneNodes([root])
        const ir = await serializeNode(root)
        if (!ir) throw new Error(`"${root.name}" (${root.type}) produced no exportable structure`)
        const irNodes: readonly IrNode[] = [ir]
        // The asset passes want the node's export settings and fills; `SceneNode` carries both,
        // and `AssetSourceNode` is the narrower view they declare. Same cast design.context makes.
        const assetSourceNodes = sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>
        await annotateVectorLeaves(irNodes, assetSourceNodes)
        await annotateVideoFills(irNodes, assetSourceNodes)
        const found: ContextAsset[] = await collectContextAssets(irNodes, sceneNodesById)
        const seen = new Set<string>()
        for (const asset of found) {
          if (seen.has(asset.nodeId)) continue
          seen.add(asset.nodeId)
          const node = sceneNodesById.get(asset.nodeId)
          targets.push({
            nodeId: asset.nodeId,
            name: node?.name ?? asset.filename,
            kind: asset.kind,
            ...(asset.exportable === false ? { reason: asset.reason ?? 'Figma refuses to export this asset' } : {}),
          })
        }
      } else {
        targets.push({ nodeId: root.id, name: root.name, kind: root.type.toLowerCase() })
      }

      const files: unknown[] = []
      const manifest: ExportedAsset[] = []
      const skipped: Array<{ name: string; reason: string }> = []
      // Two different layers routinely share a name — three cards each holding
      // `img/topiccard_template`. Every file of one call lands in one directory, so without a
      // number the second would overwrite the first and the manifest would point three entries
      // at one file. Numbered once per ASSET, so its @2x and @3x keep the same stem.
      const taken = new Set<string>()
      const wantAlpha = params.alpha === true
      // Keyed by image hash, not by asset: the same photo often fills more than one node in a
      // subtree (a card's background and the thumbnail inside it), and a build calling
      // `assets.export` on a whole screen should not pay `getBytesAsync` for it twice.
      const imageAlphaCache = new Map<string, ImageAlpha>()
      const budget = Number(params.budgetBytes ?? 2_500_000)
      const deadline = Date.now() + Number(params.budgetMs ?? 60_000)
      const maxPixels = Number(params.maxPixels ?? 4_000_000)
      const offset = Number(params.offset ?? 0)
      const page = targets.slice(offset, offset + limit)
      let spent = 0
      let ranOut: 'bytes' | 'time' | null = null
      /** How many of this page were finished — the offset to ask for next. */
      let done = 0

      for (const target of page) {
        if (ranOut) break
        if (target.reason) {
          skipped.push({ name: target.name, reason: target.reason })
          continue
        }
        const found = await figma.getNodeByIdAsync(target.nodeId)
        const node = found && found.type !== 'PAGE' && found.type !== 'DOCUMENT' ? found : null
        if (!node || !('exportAsync' in node)) {
          skipped.push({ name: target.name, reason: 'node is gone or cannot be exported' })
          continue
        }
        const stem = uniqueStem(slugify(target.name, 'asset'), taken)
        const entry: ExportedAsset = { nodeId: target.nodeId, name: target.name, kind: target.kind, files: [] }
        // Charged against the same `budgetMs` the per-scale exports below respect — a call that
        // already ran out of time answers with whatever it has rather than reaching for one more
        // fetch. SVG/PDF never ask: a vector's own shape is what ships, not a bitmap fill.
        if (wantAlpha && format !== 'SVG' && format !== 'PDF' && Date.now() <= deadline) {
          const alpha = await sourceImageAlpha(node, imageAlphaCache)
          if (alpha !== undefined) entry.alpha = alpha
        }
        for (const scale of scales) {
          if (Date.now() > deadline) {
            // Stopping on a budget beats stopping on the call timeout: what did come back is
            // usable, and the answer says what stopped it rather than failing whole.
            ranOut = 'time'
            break
          }
          // Figma exports a 4320×2268 PNG for a full-width section at @3x, then the sandbox
          // base64-encodes ten megapixels of it — minutes, for an asset nobody asked for. The
          // reason names the alternative rather than leaving the caller with a silent gap.
          const pixels = Math.round(node.width * scale) * Math.round(node.height * scale)
          if (format !== 'SVG' && format !== 'PDF' && pixels > maxPixels) {
            skipped.push({
              name: target.name,
              reason:
                `${Math.round(node.width * scale)}×${Math.round(node.height * scale)} at @${scale}x is ` +
                `${(pixels / 1e6).toFixed(1)} megapixels, past maxPixels — export the icon or image layer ` +
                'itself rather than the frame around it, or drop the scale.',
            })
            continue
          }
          try {
            const bytes =
              format === 'SVG' || format === 'PDF'
                ? await node.exportAsync({ format })
                : await node.exportAsync({ format, constraint: { type: 'SCALE', value: scale } })
            if (spent > 0 && spent + bytes.length > budget) {
              // BEFORE, not after: a reply past roughly three megabytes of image data never
              // arrives — the sandbox→UI hop stalls and the call dies on the bridge's ceiling
              // with nothing to show. The exported bytes are dropped on the floor here on
              // purpose; the caller asks for this asset again with `offset`.
              ranOut = 'bytes'
              break
            }
            spent += bytes.length
            const name = assetFileName(stem, scale, format)
            // Even SVG travels as bytes: the sandbox has no TextDecoder, and base64 through the
            // envelope lands the identical file on disk — the mime type is what a reader needs.
            files.push(binaryFile(name, MIME_BY_FORMAT[format], bytes))
            entry.files.push({
              scale,
              file: name,
              bytes: bytes.length,
              path: assetPath(stem, { naming, scale, format }),
            })
          } catch (err) {
            // One asset that will not export is one line in `skipped`, not a failed call: a
            // screen with thirty icons and one broken video should still hand over twenty-nine.
            skipped.push({ name: target.name, reason: String((err as Error)?.message || err) })
          }
        }
        if (entry.files.length > 0) {
          manifest.push(entry)
          if (naming === 'ios') {
            // Xcode does not read loose files: an imageset is a directory plus the Contents.json
            // that maps each file to its scale. Emitting it here is the difference between
            // "here are three PNGs" and a catalogue folder that compiles as it stands.
            const contents = `${stem}.Contents.json`
            files.push(textFile(contents, 'application/json', iosContents(entry.files, format)))
            entry.contents = { file: contents, path: `Assets.xcassets/${stem}.imageset/Contents.json` }
          }
        }
        if (!ranOut) done += 1
      }

      return {
        node: { id: root.id, name: root.name, type: root.type },
        format,
        scales,
        naming,
        exported: manifest.length,
        bytes: spent,
        ...(ranOut ? { stoppedOn: ranOut } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(targets.length > offset + done
          ? { remaining: targets.length - offset - done, nextOffset: offset + done }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        assets: manifest,
        files,
        manifest: textFile(
          `${slugify(root.name)}.assets.json`,
          'application/json',
          JSON.stringify({ naming, format, scales, assets: manifest }, null, 2)
        ),
      }
    },
  },
]
