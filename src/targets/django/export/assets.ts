/**
 * Export pipeline asset collection (T6.2, docs/research/04-figma-to-django-templates.md §1.8):
 * walks the IR tree for image/vector nodes and, for the ones this run still has a live Figma node
 * for, calls T2.4's `exportRasterAsset`/`exportVectorAsset` to produce the bytes that land under
 * `static/img/` in the assembled file tree (`file-tree.ts`). A node missing from `sceneNodesById`
 * (a stale re-run, or IR loaded from a snapshot) is skipped rather than failing the whole export.
 */

import type { IrNode } from '../ir.ts'
import {
  exportRasterAsset,
  exportVectorAsset,
  exportDesignerAssets,
  DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES,
  type RasterAsset,
  type DesignerExportSetting,
} from '../assets.ts'
import { resolveExportSettings } from '../../../utils/graphics.ts'
import { toCssVarName } from '../tokens.ts'

/** Structural shape of a live Figma node this module needs — matches `SceneNode`'s `ExportMixin`.
 * `type`/`getMainComponentAsync`/`mainComponent` feed the master-settings lookup for instances of
 * export-marked components (utils/graphics `resolveExportSettings`). */
export interface AssetSourceNode {
  readonly id: string
  readonly name: string
  readonly type?: string
  readonly exportSettings?: ReadonlyArray<DesignerExportSetting>
  getMainComponentAsync?(): Promise<{ exportSettings?: ReadonlyArray<DesignerExportSetting> } | null>
  readonly mainComponent?: { exportSettings?: ReadonlyArray<DesignerExportSetting> } | null
  exportAsync(settings: { format: 'PNG' | 'JPG'; constraint: { type: 'SCALE'; value: 1 | 2 } }): Promise<Uint8Array>
  exportAsync(settings: { format: 'SVG_STRING' }): Promise<string>
  exportAsync(settings: DesignerExportSetting): Promise<Uint8Array | string>
}

export interface ExportAsset {
  /** Filename this asset should be written under `static/img/` in the assembled tree. */
  filename: string
  content: string | Uint8Array
}

interface AssetLeafRef {
  id: string
  type: 'image' | 'vector'
  /** Template-referenced file for this leaf ("img/…"), when one is expected. */
  assetSrc?: string
  /** M11: poster PNG path for a video leaf — exported alongside the .mp4. */
  posterSrc?: string
  /** Vector whose SVG is inlined into the markup — no file to export. */
  inline: boolean
  /** M5: the image node's fill hash, when it's an image-fill leaf — lets the asset pass fetch the
   * raw fill bytes for a non-PNG format instead of rasterizing it via `exportAsync`. */
  imageHash?: string
  /** Mirror of `IrImageNode.videoUnavailable` — the MP4 export already failed in
   * `annotateVideoFills`, so the leaf ships poster-only (no misleading raster under a name
   * nothing references) and the .mp4 path lands in export-report.json manualAssets. */
  unavailable?: boolean
}

/** Duck-typed `figma.getImageByHash` + `Image.getBytesAsync`, injected by the plugin entry so
 * unit tests and non-plugin callers don't need the `figma` global. */
export interface ImageFillSource {
  getBytesAsync(): Promise<Uint8Array>
}
export type GetImageByHash = (hash: string) => ImageFillSource | null

/** A container/instance node's own image fill: exported as the raw fill bytes under the exact
 * filename the IR serializer promised the CSS emitter (`backgroundImages[].assetSrc`). */
interface ContainerFill {
  nodeId: string
  name: string
  imageHash: string
  filename: string
}

/** An alpha/luminance/vector mask shape (M7) to export as an SVG asset for a wrapper's `mask-image`. */
interface MaskShape {
  nodeId: string
  filename: string
}

/** M11: a container/instance node's video background fill, exported as an .mp4 via
 * `exportAsync({format:'MP4'})` on the container node (the video bytes can't be fetched via
 * `getVideoByHashAsync` without a live figma global, but `exportAsync` on the container renders
 * the video fill). A poster PNG is exported alongside via `exportAsync({format:'PNG'})`. */
interface VideoFillExport {
  nodeId: string
  name: string
  /** `static`-relative .mp4 path the CSS emitter references. */
  filename: string
  /** `static`-relative poster PNG path. */
  posterFilename: string
  /** Mirror of `IrBackgroundVideo.videoUnavailable` — the MP4 export already failed in
   * `annotateVideoFills`, so the asset pass ships only the poster (the emitter degraded the
   * layer to a poster `<img>`, so nothing references the .mp4). */
  unavailable: boolean
}

/** One walk collecting what to export as an <img>/inline-SVG leaf (image + vector nodes), which
 * container/instance nodes carry their own image fill to ship as raw background bytes, which
 * carry a video background fill (M11), and which mask-wrapper containers need their mask shape
 * exported as an SVG asset (M7). */
function collectAssetTargets(nodes: readonly IrNode[]): { leaves: AssetLeafRef[]; fills: ContainerFill[]; videoFills: VideoFillExport[]; masks: MaskShape[] } {
  const leaves: AssetLeafRef[] = []
  const fills: ContainerFill[] = []
  const videoFills: VideoFillExport[] = []
  const masks: MaskShape[] = []

  const visit = (node: IrNode): void => {
    if (node.type === 'image') {
      leaves.push({
        id: node.id,
        type: 'image',
        assetSrc: node.assetSrc,
        posterSrc: node.posterSrc,
        inline: false,
        imageHash: node.imageHash ?? undefined,
        unavailable: node.videoUnavailable === true,
      })
    }
    else if (node.type === 'vector') {
      leaves.push({ id: node.id, type: 'vector', assetSrc: node.assetSrc, inline: node.inlineSvg != null })
    } else if (node.type === 'container' || node.type === 'instance-ref') {
      for (const bg of node.backgroundImages ?? []) {
        fills.push({
          nodeId: node.id,
          name: node.name,
          imageHash: bg.imageHash,
          filename: bg.assetSrc.replace(/^img\//, ''),
        })
      }
      if (node.backgroundVideo) {
        videoFills.push({
          nodeId: node.id,
          name: node.name,
          filename: node.backgroundVideo.assetSrc.replace(/^img\//, ''),
          posterFilename: node.backgroundVideo.posterSrc.replace(/^img\//, ''),
          unavailable: node.backgroundVideo.videoUnavailable === true,
        })
      }
      if (node.type === 'container' && node.mask?.kind === 'image') {
        masks.push({ nodeId: node.mask.nodeId, filename: node.mask.assetSrc.replace(/^img\//, '') })
      }
      node.children.forEach(visit)
    }
  }
  nodes.forEach(visit)

  return { leaves, fills, videoFills, masks }
}

/**
 * Live pre-pass before template emission: resolves every unmarked vector leaf to either inline
 * SVG markup (small — T2.4's inline rule, set as `inlineSvg` on the IR node) or an exported file
 * (large — `assetSrc`), so the emitters can render real graphics instead of placeholder divs.
 * Mutates the IR in place. Nodes without a live source, or whose export throws, keep the
 * placeholder-div behavior.
 */
/**
 * Puts the token back into an inlined SVG. Figma renders vector paints as literal `fill="#rrggbb"`
 * attributes, so a bound icon comes out of `exportAsync` carrying the hex — the very hex the rest
 * of this pipeline is careful never to emit, since the CSS path writes `var(--token, #fallback)`.
 *
 * The substitution is driven by *this node's own bindings*, never by looking a colour up in the
 * palette. A hex does not identify a token: the same value is routinely two different semantic
 * tokens, and choosing between them is a decision about meaning. Here there is nothing to choose
 * — the paint says which variable it carries. A colour that two of this node's own bound paints
 * share is skipped for the same reason: at that point the node itself is ambiguous.
 */
export async function tokeniseInlineSvg(svg: string, source: AssetSourceNode): Promise<string> {
  const byColor = new Map<string, string | null>()
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')

  for (const prop of ['fills', 'strokes'] as const) {
    const paints = (source as unknown as Record<string, unknown>)[prop]
    if (!Array.isArray(paints)) continue
    for (const paint of paints as Paint[]) {
      if (paint.type !== 'SOLID' || paint.visible === false) continue
      const aliasId = (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id
      if (!aliasId) continue
      // `documentAccess: "dynamic-page"` forbids the sync lookup — it throws rather than
      // returning null, and this call sits inside the caller's try/catch, so the sync form
      // would have quietly turned every bound icon into a placeholder.
      const variable = await figma.variables.getVariableByIdAsync(aliasId)
      if (!variable) continue
      const solid = paint as SolidPaint
      const hex = `#${channel(solid.color.r)}${channel(solid.color.g)}${channel(solid.color.b)}`.toLowerCase()
      const known = byColor.get(hex)
      // Second, different token on the same colour → this node cannot say which one a given
      // attribute meant. Mark it poisoned rather than pick.
      byColor.set(hex, known === undefined ? variable.name : known === variable.name ? known : null)
    }
  }
  if (byColor.size === 0) return svg

  return svg.replace(/\b(fill|stroke)="(#[0-9a-fA-F]{6})"/g, (whole, attribute: string, hex: string) => {
    const token = byColor.get(hex.toLowerCase())
    if (!token) return whole
    return `${attribute}="var(${toCssVarName(token)}, ${hex})"`
  })
}

export async function annotateVectorLeaves(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, AssetSourceNode>,
  inlineThresholdBytes: number = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES
): Promise<void> {
  const visit = async (node: IrNode): Promise<void> => {
    if (node.type === 'container' || node.type === 'instance-ref') {
      for (const child of node.children) await visit(child)
      return
    }
    // Already resolved (a marked graphic, or an arc/complex-stroke shape the IR pre-inlined) — leave it.
    if (node.type !== 'vector' || node.assetSrc != null || node.inlineSvg != null) return
    const source = sceneNodesById.get(node.id)
    if (!source) return
    try {
      const asset = await exportVectorAsset(source, inlineThresholdBytes)
      if (asset.kind === 'inline') node.inlineSvg = await tokeniseInlineSvg(asset.svg, source)
      else node.assetSrc = `img/${asset.filename}`
    } catch (error) {
      console.warn(
        `[export] vector "${source.name}" (${source.id}) failed to export — left as a placeholder:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  for (const node of nodes) await visit(node)
}

/**
 * M11 fix: resolves every container/instance `backgroundVideo` BEFORE the emitters and the asset
 * pass run (mirrors `annotateVectorLeaves` — both passes read the annotation). Tries the MP4
 * export once per video fill, returning the bytes keyed by node id so `collectExportAssets`
 * doesn't export twice. A failure (video bytes aren't always available to the plugin API) marks
 * the annotation `videoUnavailable`, which degrades the emitted layer to its poster `<img>` and
 * keeps the .mp4 out of the template's `{% static %}` refs — a template must never reference a
 * file the zip doesn't ship. Mutates the IR in place.
 */
export async function annotateVideoFills(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, AssetSourceNode>
): Promise<Map<string, Uint8Array>> {
  const videoBytesById = new Map<string, Uint8Array>()
  const probe = async (nodeId: string, markUnavailable: () => void): Promise<void> => {
    const source = sceneNodesById.get(nodeId)
    if (!source) return
    try {
      videoBytesById.set(nodeId, (await source.exportAsync({ format: 'MP4' } as never)) as Uint8Array)
    } catch (error) {
      markUnavailable()
      console.warn(
        `[export] video "${source.name}" (${source.id}) failed to export — poster only, .mp4 goes to manualAssets:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  const visit = async (node: IrNode): Promise<void> => {
    // A standalone video LEAF (a shape whose fill is a VideoPaint, emitted as its own <video>).
    if (node.type === 'image' && node.assetSrc?.endsWith('.mp4') && !node.videoUnavailable) {
      await probe(node.id, () => {
        node.videoUnavailable = true
      })
      return
    }
    if (node.type !== 'container' && node.type !== 'instance-ref') return
    const bv = node.backgroundVideo
    if (bv && !bv.videoUnavailable) {
      await probe(node.id, () => {
        bv.videoUnavailable = true
      })
    }
    for (const child of node.children) await visit(child)
  }
  for (const node of nodes) await visit(node)
  return videoBytesById
}

/** Video fills the API refused to export (`videoUnavailable`) — the templates still reference
 * their `static`-relative paths (<video src> shows its poster until the file exists), so the
 * export report lists them for the user to drop in manually. `nodeId` lets the UI's attach
 * panel jump the viewport to the offending layer (same SCROLL_INTO_VIEW as the linter). */
export interface ManualAsset {
  nodeId: string
  assetSrc: string
}

export function collectManualAssets(nodes: readonly IrNode[]): ManualAsset[] {
  const out: ManualAsset[] = []
  const visit = (node: IrNode): void => {
    if (node.type === 'image' && node.videoUnavailable && node.assetSrc) {
      out.push({ nodeId: node.id, assetSrc: node.assetSrc })
    }
    if (node.type !== 'container' && node.type !== 'instance-ref') return
    if (node.backgroundVideo?.videoUnavailable) {
      out.push({ nodeId: node.id, assetSrc: node.backgroundVideo.assetSrc })
    }
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return out
}

function toExportAssets(assets: RasterAsset[]): ExportAsset[] {
  return assets.map((asset) => ({ filename: asset.filename, content: asset.bytes }))
}

/**
 * Exports every image/vector IR node's asset that still has a corresponding live Figma node.
 * Designer-marked graphics (`assetSrc` set) export per their own Export panel settings — every
 * format/scale/suffix the designer configured. Container/instance nodes with an image fill
 * (`backgroundImages` set) export the raw fill bytes via `getImageByHash` — calling `exportAsync`
 * on the container would rasterize its children into the background. Unmarked vector nodes at or
 * below `inlineThresholdBytes` (T2.4's inline-vs-file rule) produce no file — their SVG belongs
 * inlined into the template markup instead, so they're skipped here.
 *
 * A node whose `exportAsync` throws (render failure, zero-size geometry, …) is skipped with a
 * console warning — one bad node must not abort the whole export, same as a missing node.
 */
export async function collectExportAssets(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, AssetSourceNode>,
  getImageByHash?: GetImageByHash,
  videoBytesById?: ReadonlyMap<string, Uint8Array>,
  inlineThresholdBytes: number = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES
): Promise<ExportAsset[]> {
  const { leaves, fills, videoFills, masks } = collectAssetTargets(nodes)
  const assets: ExportAsset[] = []

  const warnSkipped = (source: { id: string; name: string }, error: unknown) =>
    console.warn(
      `[export] asset "${source.name}" (${source.id}) failed to export — skipped:`,
      error instanceof Error ? error.message : String(error)
    )

  for (const leaf of leaves) {
    const source = sceneNodesById.get(leaf.id)
    if (!source) continue
    if (leaf.inline) continue // inlined into the markup — no file
    try {
      const designerSettings = (await resolveExportSettings(source)) as ReadonlyArray<DesignerExportSetting>
      if (designerSettings.length > 0) {
        // Designer-marked (own settings, or the master component's for an instance): one file per
        // configured export setting (format/scale/suffix as-is).
        assets.push(...(await exportDesignerAssets(source, designerSettings)))
      } else if (leaf.assetSrc?.endsWith('.mp4')) {
        // A video-fill layer (or FigJam MediaNode): exportAsync renders the node's video content
        // as MP4. The typings lag the runtime here (the format enum accepts MP4/GIF/WEBM).
        // `annotateVideoFills` normally resolved the bytes already (videoBytesById) or marked the
        // leaf unavailable — then only the poster ships and the .mp4 is a declared manual asset.
        const cached = videoBytesById?.get(leaf.id)
        if (cached) {
          assets.push({ filename: leaf.assetSrc.replace(/^img\//, ''), content: cached })
        } else if (!leaf.unavailable) {
          try {
            const bytes = (await source.exportAsync({ format: 'MP4' } as never)) as Uint8Array
            assets.push({ filename: leaf.assetSrc.replace(/^img\//, ''), content: bytes })
          } catch (mp4Error) {
            // Un-annotated direct call: a FigJam MediaNode may carry an image/GIF, not a video —
            // MP4 export fails. Fall back to a 1x PNG raster.
            assets.push(...toExportAssets(await exportRasterAsset(source)))
          }
        }
        // M11: export a 1x PNG poster alongside every video asset — the <video poster="…">
        // attribute references it for the pre-load still.
        if (leaf.posterSrc) {
          try {
            const posterBytes = await source.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } })
            assets.push({ filename: leaf.posterSrc.replace(/^img\//, ''), content: posterBytes })
          } catch (posterError) {
            // Poster is best-effort — a missing poster degrades to no still, not a broken export.
            console.warn(`[export] poster for "${source.name}" (${source.id}) failed — skipped:`, posterError instanceof Error ? posterError.message : String(posterError))
          }
        }
      } else if (leaf.type === 'image' && leaf.imageHash && leaf.assetSrc && !leaf.assetSrc.endsWith('.png')) {
        // M5: a non-PNG image fill (GIF/JPG/WEBP, per the format `ir.ts` already sniffed into the
        // assetSrc extension) ships as the raw fill bytes — exportAsync would only ever rasterize
        // it to a static PNG, silently freezing an animated GIF fill. A missing/expired image (no
        // getImageByHash, or the hash no longer resolves) skips the leaf, same as a container fill
        // without one — better than shipping a mismatched-filename PNG.
        const image = getImageByHash?.(leaf.imageHash) ?? null
        if (image) assets.push({ filename: leaf.assetSrc.replace(/^img\//, ''), content: await image.getBytesAsync() })
      } else if (leaf.type === 'image') {
        assets.push(...toExportAssets(await exportRasterAsset(source)))
      } else {
        // Unmarked vector: threshold 0 when the template references a file (assetSrc from
        // annotateVectorLeaves), the inline rule otherwise.
        const asset = await exportVectorAsset(source, leaf.assetSrc ? 0 : inlineThresholdBytes)
        if (asset.kind === 'file') assets.push({ filename: asset.filename, content: asset.svg })
      }
    } catch (error) {
      warnSkipped(source, error)
    }
  }

  // Mask shapes (M7): the alpha/luminance/vector mask of a wrapper container, exported as SVG and
  // referenced by the wrapper's `mask-image`. The mask node isn't rendered as a leaf, so it's
  // exported here from its own live source. A missing source (stale re-run) skips it, same as a leaf.
  for (const mask of masks) {
    const source = sceneNodesById.get(mask.nodeId)
    if (!source) continue
    try {
      const svg = await source.exportAsync({ format: 'SVG_STRING' })
      assets.push({ filename: mask.filename, content: svg })
    } catch (error) {
      warnSkipped(source, error)
    }
  }

  // Container background fills: raw fill bytes, written to the exact filename the IR promised
  // the CSS emitter. A missing image (no injected store, stale hash) skips the fill, same as a
  // missing scene node — the CSS reference then degrades to a 404, not a broken export.
  for (const fill of fills) {
    const image = getImageByHash?.(fill.imageHash) ?? null
    if (!image) continue
    try {
      assets.push({ filename: fill.filename, content: await image.getBytesAsync() })
    } catch (error) {
      warnSkipped({ id: fill.nodeId, name: fill.name }, error)
    }
  }

  // M11: container video background fills — exported as .mp4 via exportAsync on the container
  // node (the VideoPaint's videoHash could also resolve via figma.getVideoByHashAsync, but
  // exportAsync on the container renders the fill directly and is already available here). A
  // poster PNG is exported alongside for the <video poster="…"> attribute. `annotateVideoFills`
  // normally resolved the bytes already (videoBytesById) or marked the fill unavailable — in
  // which case the emitter degraded the layer to a poster <img> and no .mp4 must ship (a
  // template must never reference a file the zip doesn't carry).
  for (const vf of videoFills) {
    const source = sceneNodesById.get(vf.nodeId)
    if (!source) continue
    const cached = videoBytesById?.get(vf.nodeId)
    if (cached) {
      assets.push({ filename: vf.filename, content: cached })
    } else if (!vf.unavailable) {
      try {
        const bytes = (await source.exportAsync({ format: 'MP4' } as never)) as Uint8Array
        assets.push({ filename: vf.filename, content: bytes })
      } catch (mp4Error) {
        // Un-annotated direct call (tests, legacy): the fill may be a static image — fall back
        // to a PNG raster.
        try {
          assets.push(...toExportAssets(await exportRasterAsset(source)))
        } catch (fallbackError) {
          warnSkipped({ id: vf.nodeId, name: vf.name }, fallbackError)
        }
      }
    }
    try {
      const posterBytes = await source.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } })
      assets.push({ filename: vf.posterFilename, content: posterBytes })
    } catch (posterError) {
      // Poster is best-effort.
      console.warn(`[export] poster for "${vf.name}" (${vf.nodeId}) failed — skipped:`, posterError instanceof Error ? posterError.message : String(posterError))
    }
  }

  return assets
}
