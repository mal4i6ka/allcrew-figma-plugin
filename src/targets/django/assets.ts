/**
 * Asset export (T2.4, docs/research/04-figma-to-django-templates.md §1.8): raster
 * nodes (image fills) export via `exportAsync` at 1x/2x in PNG; vector nodes
 * export as SVG, inlined into the template or written to a `static/` file
 * depending on a size threshold.
 *
 * Designer-marked graphics (nodes with export settings — utils/graphics) instead
 * export exactly what the designer configured in Figma's Export panel: every
 * format (PNG/JPG/SVG/PDF/GIF/MP4/WEBM) at every scale/suffix (@0.5x…@4x, custom
 * suffixes), each setting passed to `exportAsync` verbatim. See
 * `exportDesignerAssets`. GIF references render as `<img>`, MP4/WEBM as `<video>`.
 *
 * NOTE the research doc (§1.8) also called for WEBP, but `exportAsync` rejects it
 * at runtime: `Property "settings" failed validation: Invalid discriminator value.
 * Expected 'PNG' | 'JPG' | 'PDF' | 'SVG' | 'SVG_STRING' | 'JSON_REST_V1' | 'MP4' |
 * 'GIF' | 'WEBM' at .format` (Figma's Export panel can't produce WEBP either).
 * WEBP variants need a post-export conversion step outside the plugin.
 */

/** The raster formats `exportAsync` actually validates (see module note — no WEBP). */
export type RasterFormat = 'png' | 'jpg'
export type RasterScale = 1 | 2

interface RasterExportSettings {
  readonly format: 'PNG' | 'JPG'
  readonly constraint: { readonly type: 'SCALE'; readonly value: RasterScale }
  /** M8: passed through from the node's own `exportSettings[0].colorProfile` — omitted for
   * `'DOCUMENT'`, which is `exportAsync`'s own default, so there's nothing to override. */
  readonly colorProfile?: 'SRGB' | 'DISPLAY_P3_V4'
}

/** Minimal shape asset export needs from a live Figma node — structural (rather than the ambient
 * `ExportMixin`) so unit-test mocks and IR-level callers don't need a full `SceneNode`. */
export interface RasterExportableNode {
  readonly id: string
  readonly name: string
  /** M8: read for `colorProfile` only — the designer's own first export setting's color profile,
   * if they set one (Figma's Export panel, DISPLAY_P3_V4/SRGB vs. the DOCUMENT default).
   * `format` is included (unused) so this stays structurally compatible with `DesignerExportSetting`
   * — an object type with only optional properties and zero overlap is a TS "weak type", which
   * rejects otherwise-compatible callers like `AssetSourceNode` in export/assets.ts. */
  readonly exportSettings?: ReadonlyArray<{ readonly format?: string; readonly colorProfile?: 'DOCUMENT' | 'SRGB' | 'DISPLAY_P3_V4' }>
  exportAsync(settings: RasterExportSettings): Promise<Uint8Array>
}

/** The node's own designer-set `colorProfile` (Export panel), when it's not the `'DOCUMENT'`
 * default — `exportAsync` already defaults to `DOCUMENT`, so passing it through explicitly would
 * be a no-op. */
function rasterColorProfile(node: RasterExportableNode): 'SRGB' | 'DISPLAY_P3_V4' | undefined {
  const profile = node.exportSettings?.[0]?.colorProfile
  return profile === 'SRGB' || profile === 'DISPLAY_P3_V4' ? profile : undefined
}

export interface RasterAsset {
  filename: string
  format: RasterFormat
  scale: RasterScale
  bytes: Uint8Array
}

const RASTER_FORMATS: ReadonlyArray<{ format: RasterFormat; figmaFormat: 'PNG' | 'JPG' }> = [
  { format: 'png', figmaFormat: 'PNG' },
]

const RASTER_SCALES: readonly RasterScale[] = [1, 2]

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
  return slug || 'asset'
}

/** Sanitizes a Figma node id (`1:23`) into a filesystem-safe segment (`1-23`). */
function idSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '-')
}

/** `@2x` (etc.) suffix for scales above 1x; 1x files stay unsuffixed, matching the `img.png`/`img@2x.png` web convention. */
function scaleSuffix(scale: RasterScale): string {
  return scale === 1 ? '' : `@${scale}x`
}

export function rasterFilename(id: string, name: string, format: RasterFormat, scale: RasterScale): string {
  return `${idSegment(id)}-${slugify(name)}${scaleSuffix(scale)}.${format}`
}

/** Raster assets export at 1x/2x as PNG via `exportAsync` (WEBP is rejected — see module note). */
export async function exportRasterAsset(node: RasterExportableNode): Promise<RasterAsset[]> {
  const assets: RasterAsset[] = []
  const colorProfile = rasterColorProfile(node)

  for (const { format, figmaFormat } of RASTER_FORMATS) {
    for (const scale of RASTER_SCALES) {
      const bytes = await node.exportAsync({
        format: figmaFormat,
        constraint: { type: 'SCALE', value: scale },
        ...(colorProfile ? { colorProfile } : {}),
      })
      assets.push({ filename: rasterFilename(node.id, node.name, format, scale), format, scale, bytes })
    }
  }

  return assets
}

// --- container background fills: raw image-fill bytes, format sniffed from magic numbers ---

/** Formats an image fill's raw bytes (`figma.getImageByHash(...).getBytesAsync()`) can carry —
 * everything Figma accepts as a pasted/imported fill image. */
export type ImageFillFormat = 'png' | 'jpg' | 'gif' | 'webp'

function bytesMatch(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/** Magic-number sniff of raw image-fill bytes, so the exported file's extension matches what the
 * bytes actually are (Figma's Image API exposes no format). Unrecognized bytes fall back to `png`
 * — the file is still written and referenced under that name, and browsers content-sniff CSS
 * background images, so a wrong extension degrades to cosmetics rather than a broken visual. */
export function detectImageFillFormat(bytes: Uint8Array): ImageFillFormat {
  if (bytesMatch(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (bytesMatch(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpg'
  if (bytesMatch(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif' // "GIF8"
  if (bytesMatch(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && bytesMatch(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp' // "RIFF…WEBP"
  return 'png'
}

/** Filename for a container node's background-image fill under `static/img/`. The `-fill` suffix
 * marks it as a background (vs a rasterized leaf) and keeps it clear of `rasterFilename`'s
 * namespace. Shared between the IR serializer (which writes it into `backgroundImages[].assetSrc`)
 * and the asset pass (which writes the bytes to it). `index` (M8 layered fills) distinguishes a
 * node's stacked image fills from one another — the first (0) stays unsuffixed so single-fill
 * nodes keep their pre-M8 filename. */
export function containerFillFilename(id: string, name: string, format: ImageFillFormat, index = 0): string {
  const suffix = index > 0 ? `-${index + 1}` : ''
  return `${idSegment(id)}-${slugify(name)}-fill${suffix}.${format}`
}

/** Filename for an unmarked image-fill leaf under `static/img/`, when the fill's actual bytes
 * (`detectImageFillFormat`) aren't `png` — those ship as the exact raw fill bytes rather than a
 * rasterized PNG render (M5: an animated GIF fill must stay animated). No scale suffix: the raw
 * fill has one resolution, unlike `exportRasterAsset`'s 1x/2x PNG renders. */
export function imageFillLeafFilename(id: string, name: string, format: ImageFillFormat): string {
  return `${idSegment(id)}-${slugify(name)}.${format}`
}

export interface VectorExportableNode {
  readonly id: string
  readonly name: string
  exportAsync(settings: { format: 'SVG_STRING' }): Promise<string>
}

export type VectorAsset = { kind: 'inline'; svg: string } | { kind: 'file'; filename: string; svg: string }

/** Docs §1.8: small vectors/icons stay inline; larger ones ship as a `static/` file. */
export const DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES = 4096

export function vectorFilename(id: string, name: string): string {
  return `${idSegment(id)}-${slugify(name)}.svg`
}

/** Filename a video-fill layer exports under (`exportAsync({format:'MP4'})` on the node). */
export function videoFilename(id: string, name: string): string {
  return `${idSegment(id)}-${slugify(name)}.mp4`
}

/** Filename for the poster PNG (1x) exported alongside a video asset — M11 DoD: a still snapshot
 * browsers show before the video loads/plays. The `-poster` suffix keeps it clear of the video
 * and raster-leaf namespaces. */
export function videoPosterFilename(id: string, name: string): string {
  return `${idSegment(id)}-${slugify(name)}-poster.png`
}

/** Filename for an alpha/luminance/vector mask shape (M7), applied via CSS `mask-image`. The
 * `-mask` suffix keeps it clear of the leaf/fill namespaces; SVG so it stays crisp at any size. */
export function maskFilename(id: string, name: string): string {
  return `${idSegment(id)}-${slugify(name)}-mask.svg`
}

/** UTF-8 byte length of `text`, without depending on `TextEncoder` (untyped under this project's `lib`). */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * Docs §1.8: SVG-exports a vector node and decides inline-vs-file by its UTF-8 byte
 * size against `inlineThresholdBytes` — small icons inline into the template, larger
 * vector art (illustrations) becomes a named file for `static/img/`.
 */
export async function exportVectorAsset(
  node: VectorExportableNode,
  inlineThresholdBytes: number = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES
): Promise<VectorAsset> {
  const svg = await node.exportAsync({ format: 'SVG_STRING' })

  if (utf8ByteLength(svg) <= inlineThresholdBytes) return { kind: 'inline', svg }
  return { kind: 'file', filename: vectorFilename(node.id, node.name), svg }
}

// --- designer-configured exports: honor the node's own Export panel settings verbatim ---

/** One entry of a node's `exportSettings` — structural (matches Figma's `ExportSettings` union)
 * so unit-test mocks work. Extra per-format options (svgOutlineText, colorProfile, …) ride along
 * untouched because the whole object is passed to `exportAsync` verbatim. */
export interface DesignerExportSetting {
  readonly format: string
  readonly suffix?: string
  readonly constraint?: { readonly type: 'SCALE' | 'WIDTH' | 'HEIGHT'; readonly value: number }
}

/** Minimal live-node shape `exportDesignerAssets` needs. `exportAsync` takes the designer's
 * setting object verbatim — it came from Figma, so it's valid by construction. */
export interface DesignerExportableNode {
  readonly id: string
  readonly name: string
  readonly exportSettings?: ReadonlyArray<DesignerExportSetting>
  exportAsync(settings: DesignerExportSetting): Promise<Uint8Array | string>
}

/** File extension per designer-exportable format — everything Figma's Export panel can produce
 * (`exportAsync` validates exactly this set plus SVG_STRING/JSON_REST_V1). GIF renders in an
 * `<img>`; MP4/WEBM become `<video>` tags in the emitted template. */
const SETTING_EXTENSIONS: Record<string, string> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf',
  GIF: 'gif',
  MP4: 'mp4',
  WEBM: 'webm',
}

/** `static`-relative paths the emitter must render as a `<video>` tag instead of an `<img>`. */
export function isVideoAssetPath(path: string): boolean {
  return path.endsWith('.mp4') || path.endsWith('.webm')
}

/** Maps an ImagePaint/VideoPaint `scaleMode` to the CSS `object-fit`/`background-size` keyword
 * that reproduces it on a `<video>` or background layer (M11, docs/research/09 §1). FILL → cover,
 * FIT → contain, CROP → cover (the transform positions the video within the layer — not expressible
 * via object-fit alone, so we degrade to cover, the closest CSS equivalent), TILE → fill (tiled
 * video has no direct CSS object-fit; the fill mode avoids letterboxing the first tile). */
export function scaleModeToObjectFit(scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE' | undefined): string {
  switch (scaleMode) {
    case 'FIT': return 'contain'
    case 'TILE': return 'fill'
    case 'CROP':
    case 'FILL': return 'cover'
    default: return 'cover'
  }
}

/** Designer suffixes are free text — keep them filesystem-safe but preserve the `@2x` convention. */
function sanitizeSuffix(suffix: string): string {
  return suffix.replace(/[^a-zA-Z0-9@_-]+/g, '-')
}

/** Filename for one export setting: id + name slug + the designer's suffix (or a derived `@Nx`
 * when they set a non-1 scale without a suffix). `null` for unsupported (video) formats. */
export function designerAssetFilename(id: string, name: string, setting: DesignerExportSetting): string | null {
  const ext = SETTING_EXTENSIONS[setting.format]
  if (!ext) return null
  let suffix = setting.suffix ? sanitizeSuffix(setting.suffix) : ''
  if (!suffix && setting.constraint?.type === 'SCALE' && setting.constraint.value !== 1) {
    suffix = `@${setting.constraint.value}x`
  }
  return `${idSegment(id)}-${slugify(name)}${suffix}.${ext}`
}

/** The setting whose file the template should reference: SVG beats raster (crisp at any size),
 * then a 1x raster, then any raster, then GIF (renders in an `<img>`), then MP4/WEBM (rendered as
 * a `<video>` tag). PDF can't render in either, so a PDF-only node gets `null` — callers fall
 * back to a default PNG. */
export function primaryDesignerSetting(
  settings: ReadonlyArray<DesignerExportSetting>
): DesignerExportSetting | null {
  const svg = settings.find((s) => s.format === 'SVG')
  if (svg) return svg
  const rasters = settings.filter((s) => s.format === 'PNG' || s.format === 'JPG')
  const oneX = rasters.find((s) => !s.constraint || (s.constraint.type === 'SCALE' && s.constraint.value === 1))
  const gif = settings.find((s) => s.format === 'GIF')
  const video = settings.find((s) => s.format === 'MP4' || s.format === 'WEBM')
  return oneX ?? rasters[0] ?? gif ?? video ?? null
}

/** The `static/img/`-relative filename the template references for a marked node — shared between
 * the IR serializer (which writes it into `assetSrc`) and the asset pass (which must emit it). */
export function primaryDesignerAssetFilename(
  id: string,
  name: string,
  settings: ReadonlyArray<DesignerExportSetting>
): string {
  const primary = primaryDesignerSetting(settings)
  const filename = primary ? designerAssetFilename(id, name, primary) : null
  return filename ?? rasterFilename(id, name, 'png', 1)
}

export interface DesignerAsset {
  filename: string
  content: Uint8Array | string
}

/**
 * Exports a designer-marked node exactly as configured in Figma's Export panel: one file per
 * export setting, each setting passed to `exportAsync` verbatim (so scales, suffixes, and
 * per-format options all behave exactly like Figma's own Export button). Settings with an
 * unrecognized format, and settings whose export throws, are skipped with a warning. When no
 * setting is browser-usable (PDF-only), a default 1x PNG is added so the template's reference
 * resolves.
 */
export async function exportDesignerAssets(
  node: DesignerExportableNode,
  /** Overrides the node's own settings — an INSTANCE of a marked master exports with the
   * MASTER's Export panel settings (its own list is empty; see utils/graphics). */
  settingsOverride?: ReadonlyArray<DesignerExportSetting>
): Promise<DesignerAsset[]> {
  const settings = settingsOverride ?? node.exportSettings ?? []
  const assets: DesignerAsset[] = []
  const seen = new Set<string>()

  for (const setting of settings) {
    const filename = designerAssetFilename(node.id, node.name, setting)
    if (!filename) {
      console.warn(`[export] "${node.name}" (${node.id}): unrecognized export format ${setting.format} — skipped`)
      continue
    }
    if (seen.has(filename)) continue // duplicate format+suffix — same file, export once
    try {
      assets.push({ filename, content: await node.exportAsync(setting) })
      seen.add(filename)
    } catch (error) {
      console.warn(
        `[export] "${node.name}" (${node.id}): ${setting.format} export failed — skipped:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // PDF-only setups still need the file the template's <img> points at (a default 1x PNG).
  if (primaryDesignerSetting(settings) === null) {
    const filename = primaryDesignerAssetFilename(node.id, node.name, settings)
    try {
      assets.push({ filename, content: await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }) })
    } catch (error) {
      console.warn(
        `[export] "${node.name}" (${node.id}): fallback PNG export failed — skipped:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  return assets
}
