/**
 * Emits the CSS file for a Django export (T3.1, docs/research/04-figma-to-django-templates.md):
 * one class rule per IR node, keyed by a sanitized Figma node id. Visual properties (color,
 * background, border-color, border-radius, box-shadow) prefer a `var(--…)` reference (E1
 * tokens.css, T1.4 boundVariables) over the literal value `getCSSAsync` reports for that node —
 * the literal is only used as a fallback for values with no bound variable (e.g. a hand-tuned
 * gradient/shadow). Text nodes skip the box-level rule in favor of one rule per
 * `getStyledTextSegments` run (text-styles.ts), since a text node's font/spacing properties are
 * carried by its segments — except `color`, which is the node's own fill binding (Figma has no
 * per-segment bound color) and is folded into every segment rule instead.
 *
 * Image fills come out of `getCSSAsync` as a literal `url(<path-to-image>)` placeholder — resolved
 * here to the file the asset pass exports (see `imageFillUrl`) so the shipped CSS never references
 * a path that doesn't exist.
 */

import type {
  IrNode,
  IrLayout,
  IrGridTrack,
  IrSize,
  IrConstraint,
  IrConstraints,
  IrMask,
  IrStyleRefs,
  IrContainerNode,
  IrComponentDef,
  IrComponentPropertyDef,
} from './ir.ts'
import { rasterFilename } from './assets.ts'
import { toCssVarName, rgbaToCss } from './tokens.ts'
import { segmentsToCss, splitTextParagraphs, isMultiBlockText, TEXT_SEGMENT_FIELDS, type TextStyleSegment } from './text-styles.ts'
import { parseVariantName, themeButtonInstanceDecl } from './bootstrap/theme.ts'

/** A single bindable field: `VariableAlias` for a scalar property (e.g. `cornerRadius`). */
interface BoundVariableRef {
  readonly id: string
}

export interface DjangoBoundVariables {
  readonly fills?: readonly BoundVariableRef[]
  readonly strokes?: readonly BoundVariableRef[]
  readonly effects?: readonly BoundVariableRef[]
  readonly cornerRadius?: BoundVariableRef
  readonly topLeftRadius?: BoundVariableRef
  readonly topRightRadius?: BoundVariableRef
  readonly bottomLeftRadius?: BoundVariableRef
  readonly bottomRightRadius?: BoundVariableRef
}

/** A paint entry (fill/stroke) the emitter reads a solid color off — matches Figma's `SolidPaint`. */
interface SolidPaintLike {
  readonly type: string
  readonly visible?: boolean
  readonly color?: { readonly r: number; readonly g: number; readonly b: number }
  readonly opacity?: number
}

/** An effect entry the emitter reads for DropShadow re-mapping / unsupported-effect detection —
 * matches Figma's `Effect` union (docs/1TO1-FIDELITY.md M8). Only the fields the CSS mapping
 * actually needs; every effect type (DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR,
 * NOISE, TEXTURE, GLASS, SHADER) can be passed through this shape. */
interface EffectLike {
  readonly type: string
  readonly visible?: boolean
  /** DROP_SHADOW only: true → the shadow paints behind the node's own shape, which `box-shadow`
   * (always clipped to the box) can't express — remapped to `filter: drop-shadow()` instead. */
  readonly showShadowBehindNode?: boolean
  readonly color?: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
  readonly offset?: { readonly x: number; readonly y: number }
  readonly radius?: number
}

/** Duck-typed subset of Figma's `SceneNode`/`TextNode` the CSS emitter needs — kept minimal so
 * unit tests can pass plain mock objects instead of real Figma nodes. */
export interface DjangoNodeSource {
  getCSSAsync(): Promise<Record<string, string>>
  readonly boundVariables?: DjangoBoundVariables
  getStyledTextSegments?(fields: readonly string[]): readonly TextStyleSegment[]
  /** `strokeAlign` (M7) — drives INSIDE→border / CENTER→box-shadow / OUTSIDE→outline mapping. */
  readonly strokeAlign?: 'INSIDE' | 'CENTER' | 'OUTSIDE'
  readonly strokes?: readonly SolidPaintLike[]
  readonly strokeWeight?: number | symbol
  /** Per-side stroke weights (M7) — a differing set emits `border-<side>-width` (INSIDE only). */
  readonly individualStrokeWeights?: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  /** `cornerSmoothing` (M7, 0..1) — the iOS-squircle amount, approximated by scaling border-radius. */
  readonly cornerSmoothing?: number
  /** `effects` (M8) — DropShadow behind-node re-mapping and unsupported-effect detection. */
  readonly effects?: readonly EffectLike[]
  /** The node's shared plugin data, read by `html-emitter.ts` for the manual i18n `msgctxt` a
   * designer attached through the annotation panel. Optional so mock nodes stay two-field objects;
   * absent simply means "no annotation", which is what an un-annotated node has anyway. */
  getSharedPluginData?(namespace: string, key: string): string
}

/** A structured export-report note: the squircle approximation (M7), or an effect with no CSS
 * equivalent (M8 — NOISE/TEXTURE/GLASS/SHADER, silently skipped otherwise). Collected via
 * `EmitCssOptions.notes` instead of thrown/warned inline, so the caller can surface them together. */
export type EmitterNote =
  | { type: 'squircle-approx'; node: string; smoothing: number }
  | { type: 'unsupported-effect'; node: string; effect: string }
  /** A paint CSS has no way to draw — a SHADER layer above all. `getCSSAsync` drops it without
   * a word, so the emitted rule is a picture with a layer missing and nothing said about it. */
  | { type: 'unsupported-fill'; node: string; fill: string }

export function toClassName(id: string): string {
  return `n${id.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

export interface EmitCssOptions {
  /** Maps a node id to the id whose class name its rules should be keyed by. M4b's breakpoint
   * emitter aliases a narrower frame's matched nodes onto their widest-frame counterparts so the
   * `@media` rule overrides the base rule of the same DOM element. */
  idAliases?: ReadonlyMap<string, string>
  /** Emit the leading `box-sizing`/`body { margin: 0 }` reset. Off for `@media` sub-blocks (M4b),
   * which nest inside the base stylesheet that already carries the reset. Defaults to `true`. */
  preamble?: boolean
  /** Sink for structured notes (M7 squircle approximations) — pushed as they're emitted so the
   * caller can fold them into the export report. Left unset by callers that don't collect them. */
  notes?: EmitterNote[]
  /** REFORM phase 14 (C): node id → matching BASE master-variant css for themed kit-button
   * instances (`collectThemedInstanceMasters`). Their mapped pixel props become `--bs-btn-*`
   * var overrides (deltas) or drop entirely (theme-carried). Unset below theme fidelity. */
  themedInstances?: ReadonlyMap<string, Record<string, string>>
}

/** The class name a node's rules are keyed by, honoring any `idAliases` override (M4b). */
function classNameFor(id: string, options: EmitCssOptions): string {
  return toClassName(options.idAliases?.get(id) ?? id)
}

/** Properties the IR layout model (`normalizeLayout`/sizing) and the per-segment text rules own —
 * `getCSSAsync`'s versions are dropped so they can't fight the structural CSS we emit. Everything
 * else `getCSSAsync` computes (paint, gradients, borders/strokes, box-shadow, filter,
 * backdrop-filter, opacity, blend modes, transform, corner radii, …) passes through verbatim, so
 * new Figma CSS features are covered without a code change. */
const IR_OWNED_CSS = new Set<string>([
  // box model / positioning / sizing
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset', 'position', 'float', 'clear', 'box-sizing',
  'overflow', 'overflow-x', 'overflow-y', 'aspect-ratio',
  // flexbox
  'display', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap', 'flex-flow',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'place-items', 'place-content', 'place-self', 'order', 'gap', 'row-gap', 'column-gap',
  // grid
  'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-column', 'grid-row', 'grid-area', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-gap', 'grid-row-gap',
  // spacing
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  // font / text metrics — owned by the per-segment rules and the text box's text-align
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'text-align', 'text-indent', 'white-space', 'word-break', 'word-wrap',
  'text-overflow', 'writing-mode', '-webkit-line-clamp', '-webkit-box-orient',
])

/** Keeps only the visual transform functions (rotate/skew/scale/matrix) — a `translate()` from
 * `getCSSAsync` would fight the absolute `left`/`top` the IR positions the node with. */
function sanitizeTransform(value: string): string | undefined {
  const kept = value.match(/(?:rotate|skew|scale|matrix)[a-zA-Z]*\([^)]*\)/g)
  return kept ? kept.join(' ') : undefined
}

/** Every non-IR-owned declaration `getCSSAsync` computed — the node's full visual paint. */
/** Splits a CSS value on top-level commas only (commas inside `url()`/gradient parens stay). */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/** getCSSAsync emits each image fill as `url(…) lightgray 50% / cover no-repeat` — `lightgray`
 * is Figma's hardcoded placeholder swatch, never a design color (design colors arrive as
 * hex/var()). In a multi-layer `background` shorthand it's also illegal outside the final layer
 * (the browser drops the whole declaration); in a single/final layer it paints a grey haze
 * behind transparent PNGs the design never had. Strip it from every layer. */
function sanitizeBackgroundLayers(value: string): string {
  return splitTopLevelCommas(value)
    .map((layer) => layer.replace(/(^|\s)lightgray(\s|$)/, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((layer) => layer.length > 0)
    .join(', ')
}

function pickVisualDeclarations(css: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [property, value] of Object.entries(css)) {
    if (IR_OWNED_CSS.has(property)) continue
    if (property === 'transform') {
      const transform = sanitizeTransform(value)
      if (transform) {
        picked['transform'] = transform
        // Figma rotates about the node's top-left; CSS defaults to center, which offsets a rotated
        // absolutely-positioned node by up to ~½ its diagonal. Pin the origin to match Figma.
        picked['transform-origin'] = '0 0'
      }
      continue
    }
    const sanitized = property === 'background' ? sanitizeBackgroundLayers(value) : value
    if (sanitized.length > 0) picked[property] = sanitized
  }
  // Safari still needs the prefix for the frosted-glass background blur.
  if (picked['backdrop-filter'] && !picked['-webkit-backdrop-filter']) {
    picked['-webkit-backdrop-filter'] = picked['backdrop-filter']
  }
  return picked
}

/** `getCSSAsync` renders every image fill as a literal `url(<path-to-image>)` — shipped verbatim,
 * the browser resolves it against the stylesheet and requests `/static/css/%3Cpath-to-image%3E`. */
const IMAGE_FILL_PLACEHOLDER = /url\(\s*(["']?)<path-to-image>\1\s*\)/g

/** The stylesheet-relative url()s for a node's image fill(s), in `fills[]` order: the CSS lives
 * under `static/css/` and the asset pass (export/assets.ts) writes the file under `static/img/`,
 * so each reference is `../img/<file>`. Image leaves use `assetSrc` for a designer-marked graphic,
 * else the 1x PNG raster convention (leaves only ever render a single fill); containers/instances
 * use `backgroundImages[].assetSrc` — one entry per stacked layer (M8 "layered fills") — the IR
 * serializer resolved from each fill's raw bytes. An empty array for nodes that export no asset (a
 * vector leaf, or a container with no image fill): the caller degrades every placeholder occurrence
 * to `none`, which keeps the shorthand's other layers (gradients, fallback color) instead of a
 * guaranteed-404 request. */
export function imageFillUrls(node: IrNode): string[] {
  if (node.type === 'image') return [`../${node.assetSrc ?? `img/${rasterFilename(node.id, node.name, 'png', 1)}`}`]
  if (node.type === 'container' || node.type === 'instance-ref') {
    return (node.backgroundImages ?? []).map((bg) => `../${bg.assetSrc}`)
  }
  return []
}

/** Replaces each `<path-to-image>` placeholder with its corresponding fill's exported asset,
 * positionally — the Nth placeholder in a given declaration's value gets `fillUrls[N]` (`none`
 * once `fillUrls` is exhausted). Each declaration (`background`, `background-image`, …) is counted
 * independently, since Figma's multi-layer output can repeat the same fill list across more than
 * one longhand/shorthand property. */
/**
 * Replaces each `<path-to-image>` placeholder in declaration order with the corresponding entry
 * of `fillUrls` (M8 multi-layer fills). Once `fillUrls` is exhausted the LAST entry is reused
 * rather than falling through to `none` — Figma's own semi-transparency trick can render a single
 * image fill as more than one background layer (a leaf image only ever has one asset, but the CSS
 * for it can carry two placeholders), and there's no live-Figma way to distinguish that case from
 * a genuine extra stacked fill offline, so repeating the last known asset is the safer default.
 * `fillUrls` empty (no fill resolved at all — a stale/unreadable hash) still degrades to `none`.
 */
function resolveImageFillPlaceholders(
  declarations: Record<string, string>,
  fillUrls: readonly string[]
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [property, value] of Object.entries(declarations)) {
    let index = 0
    resolved[property] = value.replace(IMAGE_FILL_PLACEHOLDER, () => {
      if (fillUrls.length === 0) return 'none'
      const url = fillUrls[Math.min(index, fillUrls.length - 1)]
      index++
      return `url(${url})`
    })
  }
  return resolved
}

// --- layout declarations, derived from the IR (T2.2's normalized model, not getCSSAsync) ---

/** Rounds to 2 decimals so Figma's float noise (403.77362060546875) doesn't bloat the CSS. */
function px(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}px`
}

/** Same rounding as `px`, for the SCALE constraint's percentage-based position/size. */
function pct(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}%`
}

/** `border-radius` for a rect mask's clip — a uniform px value, or the four corners TL TR BR BL. */
function maskRadiusCss(radius: number | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }): string {
  if (typeof radius === 'number') return px(radius)
  return `${px(radius.topLeft)} ${px(radius.topRight)} ${px(radius.bottomRight)} ${px(radius.bottomLeft)}`
}

/** Emits the CSS that makes a mask-wrapper clip its children (M7). Geometric masks add a
 * `border-radius` on top of the wrapper's `overflow: hidden`; image masks add a `mask-image` at the
 * exported shape, prefixed for Safari, with `mask-mode` from the `maskType`. */
function applyMaskDeclarations(mask: IrMask, decl: Record<string, string>): void {
  if (mask.kind === 'clip') {
    if (mask.shape === 'ellipse') decl['border-radius'] = '50%'
    else if (mask.radius != null) decl['border-radius'] = maskRadiusCss(mask.radius)
    return
  }
  // CSS lives under static/css/, the asset under static/img/ → reference it as ../img/… (imageFillUrl).
  const url = `url(../${mask.assetSrc})`
  decl['-webkit-mask-image'] = url
  decl['mask-image'] = url
  decl['-webkit-mask-mode'] = mask.mode
  decl['mask-mode'] = mask.mode
  decl['-webkit-mask-size'] = '100% 100%'
  decl['mask-size'] = '100% 100%'
  decl['-webkit-mask-repeat'] = 'no-repeat'
  decl['mask-repeat'] = 'no-repeat'
}

function gridTracks(tracks: readonly IrGridTrack[]): string {
  return tracks
    .map((track) => {
      if (track.type === 'fixed') return px(track.value)
      if (track.type === 'fr') return `${track.value}fr`
      return 'fit-content(100%)'
    })
    .join(' ')
}

/** Maps one IrSize axis onto declarations, given the parent's layout. `fill` becomes `flex: 1`
 * along a flex parent's main axis, `align-self: stretch` across it, and `100%` elsewhere. */
function sizeDeclarations(
  axis: 'width' | 'height',
  size: IrSize,
  parentLayout: IrLayout | null,
  decl: Record<string, string>
): void {
  if (size.mode === 'fixed') {
    decl[axis] = px(size.value)
    return
  }
  if (size.mode !== 'fill') return // hug → auto, the CSS default
  if (parentLayout?.kind === 'flex') {
    const mainAxis = parentLayout.direction === 'row' ? 'width' : 'height'
    if (axis === mainAxis) {
      decl['flex'] = '1 0 0'
      // Figma sizes a FILL child to exactly its share of the free space; CSS's automatic minimum
      // (min-width/height:auto) lets the child's min-content overflow that share and push its
      // siblings out of the row. An explicit Figma min clamp (sizing.minWidth/minHeight, emitted
      // after this) overwrites the 0.
      decl[axis === 'width' ? 'min-width' : 'min-height'] = '0'
    } else decl['align-self'] = 'stretch'
    return
  }
  decl[axis] = '100%'
}

/** A node's own literal pixel size, only when both axes are `fixed` — the box the M4 constraint
 * math measures against. HUG/FILL nodes (an auto-resizing text, a hug-sized frame) carry no
 * literal px value, so callers degrade to MIN behavior for them (see `applyAxisConstraint`). */
function fixedPixelSize(node: IrNode): { width: number; height: number } | undefined {
  const { width, height } = node.sizing
  return width.mode === 'fixed' && height.mode === 'fixed' ? { width: width.value, height: height.value } : undefined
}

/** No constraints on the node (Group/BooleanOperation wrappers — see `readConstraints` in
 * ir.ts) falls back to MIN/MIN, i.e. the plain left/top pinning M4 shipped with before
 * constraint mapping existed. */
const DEFAULT_CONSTRAINTS: IrConstraints = { horizontal: 'min', vertical: 'min' }

/**
 * One axis of the M4 constraint mapping. MIN pins the start edge (`left`/`top`, unchanged from
 * pre-M4 behavior). MAX pins the end edge (`right`/`bottom`). CENTER anchors the start edge at
 * 50% and offsets it by a fixed px margin, so the node keeps its authored distance from the
 * parent's center as the parent's width/height changes. STRETCH pins both edges and drops the
 * literal size, so the browser computes it from the gap between them. SCALE expresses position
 * and size as percentages of the parent, so both move proportionally with it.
 *
 * MAX/STRETCH/SCALE need the node's own literal pixel size; CENTER only needs the parent's. When
 * that data isn't available (an auto-resizing text node, or a hug/fill-sized auto-layout parent
 * hosting an ABSOLUTE overlay child), every type degrades to MIN so the node still renders at
 * its authored position instead of an incorrect computed one.
 */
function applyAxisConstraint(
  decl: Record<string, string>,
  type: IrConstraint,
  position: number,
  ownSize: number | undefined,
  parentSize: number | undefined,
  startProp: 'left' | 'top',
  endProp: 'right' | 'bottom',
  sizeProp: 'width' | 'height',
  marginProp: 'margin-left' | 'margin-top'
): void {
  if (type === 'center' && parentSize != null) {
    decl[startProp] = '50%'
    decl[marginProp] = px(position - parentSize / 2)
    return
  }
  if (parentSize != null && ownSize != null) {
    if (type === 'max') {
      decl[endProp] = px(parentSize - position - ownSize)
      return
    }
    if (type === 'stretch') {
      decl[startProp] = px(position)
      decl[endProp] = px(parentSize - position - ownSize)
      delete decl[sizeProp]
      return
    }
    if (type === 'scale' && parentSize !== 0) {
      decl[startProp] = pct((position / parentSize) * 100)
      decl[sizeProp] = pct((ownSize / parentSize) * 100)
      return
    }
  }
  decl[startProp] = px(position)
}

/** Reads the node's own constraints (default MIN/MIN) and applies both axes' anchoring —
 * `parentSize` is the constraint-parent's own literal pixel size (undefined when it's HUG/FILL
 * and therefore unmeasurable, e.g. a hug-sized auto-layout frame hosting an ABSOLUTE child). */
function applyConstraints(
  node: IrNode,
  parentSize: { width: number; height: number } | undefined,
  decl: Record<string, string>
): void {
  const constraints = node.constraints ?? DEFAULT_CONSTRAINTS
  const ownSize = fixedPixelSize(node)
  applyAxisConstraint(
    decl, constraints.horizontal, node.position.x, ownSize?.width, parentSize?.width, 'left', 'right', 'width', 'margin-left'
  )
  applyAxisConstraint(
    decl, constraints.vertical, node.position.y, ownSize?.height, parentSize?.height, 'top', 'bottom', 'height', 'margin-top'
  )
}

/**
 * CSS for the IR's layout model: the node's own layout (Auto Layout → flex, GRID → grid,
 * NONE → a positioning context), its placement inside the parent (absolute x/y under an
 * `absolute` parent, grid anchors under a grid), and its sizing. Pure IR — works identically
 * for live exports and regeneration, and is unit-testable without a figma global.
 */
export function layoutDeclarations(
  node: IrNode,
  parentLayout: IrLayout | null,
  parentSize?: { width: number; height: number },
  childIndex?: number
): Record<string, string> {
  const decl: Record<string, string> = {}

  const layout = 'layout' in node ? node.layout : null
  if (layout?.kind === 'flex') {
    decl['display'] = 'flex'
    decl['flex-direction'] = layout.direction
    // Positioning context for layoutPositioning:ABSOLUTE children (and absolute grandchildren).
    decl['position'] = 'relative'
    if (layout.wrap) decl['flex-wrap'] = 'wrap'
    // CSS `gap` can't be negative — a negative itemSpacing (overlapping children) is compiled to
    // negative margins on the flow children instead (see the child-margin block below). Only a
    // positive main gap (or any cross gap) is emitted here. Figma IGNORES itemSpacing under
    // SPACE_BETWEEN (the stored value is stale editor state — e.g. 143px on a 4-stat row) while
    // CSS treats gap as a minimum and overflows the row — so SPACE_BETWEEN drops the main gap.
    const mainGap = layout.gap > 0 && layout.justifyContent !== 'space-between' ? layout.gap : 0
    if (mainGap || layout.crossGap != null) {
      // gap shorthand is <row-gap> <column-gap>; the cross-axis gap of a horizontal wrap is the
      // row gap (counterAxisSpacing), the main-axis gap the column gap (itemSpacing).
      decl['gap'] = layout.crossGap != null ? `${px(layout.crossGap)} ${px(mainGap)}` : px(mainGap)
    }
    const { top, right, bottom, left } = layout.padding
    if (top || right || bottom || left) decl['padding'] = `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`
    // Figma vs CSS: SPACE_BETWEEN with a single flow child centers it in Figma, while CSS
    // `space-between` start-aligns a lone item. Emit `center` for that child count so a
    // full-width header holding one 1296px content row stays centered like the design.
    const flowChildCount = ('children' in node ? node.children : []).filter((c) => c.absoluteInLayout !== true).length
    const justifyContent = layout.justifyContent === 'space-between' && flowChildCount === 1 ? 'center' : layout.justifyContent
    if (justifyContent !== 'flex-start') decl['justify-content'] = justifyContent
    // ALWAYS emitted, including flex-start: CSS's flex default is `stretch` while Figma's
    // counter-axis default is MIN — omitting flex-start makes every HUG child stretch the
    // cross axis (a hug button rendering as wide as its banner).
    decl['align-items'] = layout.alignItems
    if (layout.alignContent) decl['align-content'] = layout.alignContent
    // strokesIncludedInLayout: Figma counts strokes in the box like border-box. The exporter's
    // width/height already include padding (border-box), so this pins box-sizing per-frame — the
    // sweep's answer to "don't assume a global `* { box-sizing }` matches Figma" (research/08 §1).
    if (layout.strokesIncludedInLayout) decl['box-sizing'] = 'border-box'
  } else if (layout?.kind === 'grid') {
    decl['display'] = 'grid'
    decl['position'] = 'relative'
    decl['grid-template-columns'] = gridTracks(layout.columns)
    // gridAutoTracks:'ROWS' → rows are implicit (grid-auto-rows), not an explicit template.
    if (layout.autoRows) decl['grid-auto-rows'] = 'auto'
    else if (layout.rows.length) decl['grid-template-rows'] = gridTracks(layout.rows)
    // gridItemsPositioning:'ROW_AUTO_FLOW' → let the browser flow children row-major (no per-child
    // grid-row/column is emitted — children carry no gridPlacement in this mode).
    if (layout.autoFlow) decl['grid-auto-flow'] = layout.autoFlow
    if (layout.columnGap) decl['column-gap'] = px(layout.columnGap)
    if (layout.rowGap) decl['row-gap'] = px(layout.rowGap)
  } else if (layout?.kind === 'absolute') {
    // Positioning context for the children's left/top below.
    decl['position'] = 'relative'
  }
  // Figma clips children outside the box only when clipsContent is on.
  if (layout?.clip) decl['overflow'] = 'hidden'
  // M4c: overflowDirection → a scrollable axis, but only on a nested frame — the top-level frame
  // scrolls the whole page instead (the browser's default html/body scroll), so `overflow-x/y`
  // there would just clip content the page needs to stay reachable by scrolling.
  if (layout?.overflow && parentLayout !== null) {
    if (layout.overflow === 'x') decl['overflow-x'] = 'auto'
    else if (layout.overflow === 'y') decl['overflow-y'] = 'auto'
    else decl['overflow'] = 'auto'
  }
  // layoutGrids: design-time grid overlay — not emitted as CSS.
  // M7: a synthetic mask wrapper clips its children — a rect/ellipse geometrically (the clip flag
  // above already emitted overflow:hidden; add the shape's border-radius), an alpha/luminance/vector
  // mask via a CSS mask-image at the exported shape (mask-mode from the maskType).
  if ('mask' in node && node.mask) applyMaskDeclarations(node.mask, decl)

  const overlayChild = node.absoluteInLayout === true && (parentLayout?.kind === 'flex' || parentLayout?.kind === 'grid')
  const absoluteChild = parentLayout?.kind === 'absolute' || overlayChild
  if (absoluteChild) {
    // position:absolute also provides the positioning context for this node's own absolute
    // children, so it safely overrides the `relative` set above. layoutPositioning:ABSOLUTE
    // children overlay their auto-layout parent the same way (x/y are parent-relative).
    decl['position'] = 'absolute'
  }
  if (node.gridPlacement && !overlayChild) {
    decl['grid-row'] = `${node.gridPlacement.rowStart + 1} / span ${node.gridPlacement.rowSpan}`
    decl['grid-column'] = `${node.gridPlacement.columnStart + 1} / span ${node.gridPlacement.columnSpan}`
  }

  sizeDeclarations('width', node.sizing.width, parentLayout, decl)
  sizeDeclarations('height', node.sizing.height, parentLayout, decl)
  // Auto Layout min/max clamps (e.g. a paragraph capped at max-width:720px).
  if (node.sizing.minWidth != null) decl['min-width'] = px(node.sizing.minWidth)
  if (node.sizing.maxWidth != null) decl['max-width'] = px(node.sizing.maxWidth)
  if (node.sizing.minHeight != null) decl['min-height'] = px(node.sizing.minHeight)
  if (node.sizing.maxHeight != null) decl['max-height'] = px(node.sizing.maxHeight)
  // M4c: a top-level frame with a fixed design width becomes a full-bleed page root — `width:100%`
  // with NO max-width. A literal `width:1920px` overflows every narrower viewport (and the gaps
  // between M4b breakpoint frames); a max-width cap would keep the page's own section backgrounds
  // (headers, banners, footer) from reaching the window edge, which the design expects them to do.
  // Content is capped by the inner columns' own max-width (e.g. the 1296px content row), not here.
  // Only the root frame: a nested frame's own STRETCH already anchors both edges via
  // `applyConstraints` below, and its own FILL sizing already becomes `100%`/`flex:1` above.
  // Containers only — the page root is always a frame/container; a bare top-level text or
  // vector keeps its literal width.
  if (parentLayout === null && node.type === 'container' && node.sizing.width.mode === 'fixed') {
    decl['width'] = '100%'
  }
  // M4c: targetAspectRatio → CSS aspect-ratio; the browser derives height from it, so the literal
  // height emitted above is dropped. Auto-resizing text can't hold a fixed ratio while hugging
  // its own content on at least one axis — skipped (the skip note is emitted by the caller,
  // `collectNodeCss`, which owns the `rules` array this function doesn't have access to).
  if (node.aspectRatio && !(node.type === 'text' && node.autoResize)) {
    decl['aspect-ratio'] = `${node.aspectRatio.width} / ${node.aspectRatio.height}`
    delete decl['height']
  }
  // M4: constraints.horizontal/vertical anchor an absolute child (left/top under MIN,
  // right/bottom under MAX, 50%+margin under CENTER, both edges under STRETCH, or percentages
  // under SCALE) instead of always pinning to left/top.
  if (absoluteChild) applyConstraints(node, parentSize, decl)

  // Figma never shrinks flow children below their size — CSS's default flex-shrink:1 squishes
  // fixed-size items (flags, logos, cards) the moment a row overflows. `flex: 1 0 0` (fill) and
  // absolute overlays already opt out of shrinking.
  if (parentLayout?.kind === 'flex' && !overlayChild && !decl['flex']) {
    decl['flex-shrink'] = '0'
  }
  // A negative itemSpacing overlaps flow children (chips/avatars) — CSS `gap` can't go below 0,
  // so each child after the first pulls back onto the previous one with a negative main-axis
  // margin. When itemReverseZIndex is set the first child paints on top (descending z-index).
  if (parentLayout?.kind === 'flex' && !overlayChild && childIndex != null) {
    if (parentLayout.gap < 0 && childIndex > 0) {
      decl[parentLayout.direction === 'row' ? 'margin-left' : 'margin-top'] = px(parentLayout.gap)
    }
    if (parentLayout.reverseZIndex) decl['z-index'] = String(-childIndex)
  }
  // A child's own layoutAlign (STRETCH/CENTER/…) overrides the parent's align-items.
  if (node.alignSelf && !overlayChild) decl['align-self'] = node.alignSelf
  // Figma vs CSS: a cross-axis stretch child clamped by its max-width/max-height start-aligns in
  // CSS (the clamped box keeps the stretch placement), while Figma aligns the clamped box per the
  // parent's counterAxisAlignItems — a max-width:1296px content column inside a centered 1920px
  // section stays centered. `100%` + the max clamp reproduces Figma: the box fills up to the
  // clamp and the parent's align-items (or the child's own non-stretch alignSelf) places the rest.
  if (parentLayout?.kind === 'flex' && !overlayChild && decl['align-self'] === 'stretch') {
    const crossAxis = parentLayout.direction === 'row' ? 'height' : 'width'
    if (decl[crossAxis === 'width' ? 'max-width' : 'max-height'] != null) {
      delete decl['align-self']
      decl[crossAxis] = '100%'
    }
  }

  // Browser default margins on <p> (text nodes render as paragraphs) would break 1:1 geometry.
  if (node.type === 'text') {
    decl['margin'] = '0'
    // Without this a full-width heading/paragraph defaults to left, even inside a centered block.
    if (node.textAlign) decl['text-align'] = node.textAlign
    if (node.paragraphIndent) decl['text-indent'] = px(node.paragraphIndent)
    // WIDTH_AND_HEIGHT never wraps in Figma — the browser must not wrap it either.
    if (node.noWrap) decl['white-space'] = 'nowrap'
    if (node.truncate) {
      const maxLines = node.truncate.maxLines ?? 1
      if (maxLines <= 1) {
        decl['white-space'] = 'nowrap'
        decl['overflow'] = 'hidden'
        decl['text-overflow'] = 'ellipsis'
      } else {
        // The -webkit-box/line-clamp hack: no standard `line-clamp` fallback yet has the
        // cross-browser support this needs.
        decl['display'] = '-webkit-box'
        decl['-webkit-box-orient'] = 'vertical'
        decl['-webkit-line-clamp'] = String(maxLines)
        decl['overflow'] = 'hidden'
      }
    } else if (node.textAlignVertical) {
      // Stacks this node's paragraph(s) as flex items so they sit at the mapped edge/center of
      // a fixed-height box, instead of the CSS default of hugging the top.
      decl['display'] = 'flex'
      decl['flex-direction'] = 'column'
      decl['justify-content'] = node.textAlignVertical
    }
  }
  // <img> is inline by default — the baseline gap would offset absolutely-sized graphics.
  if ((node.type === 'image' || node.type === 'vector') && !decl['display']) decl['display'] = 'block'

  return decl
}

/** All four corners bound to the same variable is the only case `cornerRadius` (uniform) maps to. */
function uniformCornerRadiusRef(bound: DjangoBoundVariables): BoundVariableRef | undefined {
  if (bound.cornerRadius) return bound.cornerRadius
  const { topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius } = bound
  if (!topLeftRadius || !topRightRadius || !bottomLeftRadius || !bottomRightRadius) return undefined
  const sameId = [topRightRadius, bottomLeftRadius, bottomRightRadius].every((ref) => ref.id === topLeftRadius.id)
  return sameId ? topLeftRadius : undefined
}

/** The concrete value inside a getCSSAsync literal, usable as a `var()` fallback: for
 * `var(--Name, #hex)` the `#hex` part, for a plain value the value itself. `undefined` when the
 * literal is missing or itself an unfallbacked var reference. */
function literalFallback(literal: string | undefined): string | undefined {
  if (!literal) return undefined
  const inner = literal.match(/^var\([^,)]+,\s*(.+)\)$/)
  if (inner) return inner[1]
  return literal.startsWith('var(') ? undefined : literal
}

/** `var(--name, fallback)` — the fallback keeps the design visible when tokens.css is missing
 * or stale (tokens module off, or a variable created after the last tokens export). */
function withFallback(varName: string, fallback: string | undefined): string {
  return fallback ? `var(${varName}, ${fallback})` : `var(${varName})`
}

/**
 * Does this declaration say one thing, or is it a stack?
 *
 * A `var(--token, …)` override REPLACES the declaration, so it is only ever right when the
 * declaration is one layer. Figma writes a layered fill as comma-separated layers, and
 * `boundVariables.fills[0]` is not the colour of the bottom one — it is the first entry of a
 * flat list of every variable the field reaches, which on a layer holding a shader is one of
 * the shader's own gradient stops. The two together turned a banner painted colour + shader +
 * photo into `background: var(--orange, url(…), var(--white, #FFF))`: every layer but one
 * discarded, and the one kept a colour the layer never showed.
 */
export function singleLayer(value: string | undefined): boolean {
  if (!value) return true
  let depth = 0
  for (const character of value) {
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) return false
  }
  return true
}

export function tokenOverrides(
  bound: DjangoBoundVariables | undefined,
  isText: boolean,
  variableNamesById: ReadonlyMap<string, string>,
  literal: Record<string, string> = {}
): Record<string, string> {
  if (!bound) return {}
  const overrides: Record<string, string> = {}

  const fillProperty = isText ? 'color' : 'background'
  const fillName = bound.fills?.[0] && variableNamesById.get(bound.fills[0].id)
  // Text has one colour and cannot stack; a box can. Where it does, Figma's own value stands:
  // it is the whole picture minus what CSS cannot draw, and the notes name what that was.
  if (fillName && singleLayer(literal[fillProperty])) {
    overrides[fillProperty] = withFallback(toCssVarName(fillName), literalFallback(literal[fillProperty]))
  }

  const strokeName = bound.strokes?.[0] && variableNamesById.get(bound.strokes[0].id)
  if (strokeName && singleLayer(literal['border-color'])) {
    overrides['border-color'] = withFallback(toCssVarName(strokeName), literalFallback(literal['border-color']))
  }

  const effectName = bound.effects?.[0] && variableNamesById.get(bound.effects[0].id)
  if (effectName) overrides['box-shadow'] = withFallback(toCssVarName(effectName), literalFallback(literal['box-shadow']))

  const radiusRef = uniformCornerRadiusRef(bound)
  const radiusName = radiusRef && variableNamesById.get(radiusRef.id)
  if (radiusName) overrides['border-radius'] = withFallback(toCssVarName(radiusName), literalFallback(literal['border-radius']))

  return overrides
}

function formatRule(className: string, declarations: Record<string, string>): string | null {
  const entries = Object.entries(declarations)
  if (entries.length === 0) return null
  const body = entries.map(([property, value]) => `  ${property}: ${value};`).join('\n')
  return `.${className} {\n${body}\n}`
}

/**
 * A text node's own fill binding (`boundVariables.fills`) lives on the node itself, not per
 * `getStyledTextSegments` run (Figma's `VariableBindableTextField` covers font metrics only,
 * never color) — so its `var(--…)`/literal color is resolved once here and applied to every
 * segment rule, same override-over-literal precedence as `emitBoxRules`.
 */
async function emitTextRules(
  className: string,
  source: DjangoNodeSource | undefined,
  node: Extract<IrNode, { type: 'text' }>,
  variableNamesById: ReadonlyMap<string, string>,
  rules: string[]
): Promise<void> {
  const segments = source?.getStyledTextSegments?.(TEXT_SEGMENT_FIELDS) ?? []
  if (source && segments.length > 0) {
    const literal = pickVisualDeclarations(await source.getCSSAsync())
    const overrides = tokenOverrides(source.boundVariables, true, variableNamesById, literal)
    rules.push(...segmentsToCss(className, segments, {
      color: overrides.color ?? literal.color,
      leadingTrim: node.leadingTrim,
      hangingPunctuation: node.hangingPunctuation,
      hangingList: node.hangingList,
    }))
  }
  // No live node to query (e.g. regenerating from IR alone) — nothing to size text with.
}

/** Paint properties a vector leaf carries inside its own SVG (the `<svg>` path / exported .svg),
 * so emitting them on the element's box double-paints — a white logo vector's fill, reported by
 * `getCSSAsync` as `background`, would paint a solid white rectangle over the (white) artwork.
 * Effects/geometry (box-shadow, filter, opacity, transform, border, radius) are kept — they apply
 * to the box, not the artwork. Image leaves keep their `background` (it carries the fill's
 * scaleMode/position) and are never a solid color, so they're unaffected. */
const VECTOR_LEAF_PAINT = new Set<string>([
  'background', 'background-color', 'background-image', 'background-clip', 'background-origin',
  'background-blend-mode', 'fill', 'color',
])

/** CSS color of the first visible SOLID paint in a stroke array — `undefined` for an empty array
 * or a non-solid (gradient/image) stroke, so the caller leaves that node to the getCSSAsync path. */
function solidStrokeColor(strokes: readonly SolidPaintLike[] | undefined): string | undefined {
  const solid = strokes?.find((paint) => paint.type === 'SOLID' && paint.visible !== false)
  if (!solid?.color) return undefined
  return rgbaToCss(solid.opacity != null && solid.opacity < 1 ? { ...solid.color, a: solid.opacity } : solid.color)
}

/** getCSSAsync's border declarations, stripped when `strokeDeclarations` takes ownership of the
 * stroke — so a re-mapped CENTER/OUTSIDE/per-side stroke doesn't fight the passthrough `border`. */
const STROKE_OWNED_CSS = new Set<string>([
  'border', 'border-width', 'border-style', 'border-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'outline',
])

/**
 * The stroke's CSS, re-mapped from `strokeAlign` (docs/research/08 §3) because CSS `border` is
 * always INSIDE: CENTER → a doubled inset+outset `box-shadow` at half weight; OUTSIDE → `outline`
 * (which, like a Figma stroke, doesn't move siblings); INSIDE with differing per-side weights →
 * `border-<side>-width`. A uniform INSIDE stroke returns `{}` — getCSSAsync's `border` is already
 * exact, so it passes through untouched. Non-solid strokes (gradient/image) and `figma.mixed`
 * weights also return `{}` (the latter forces the SVG path in the IR instead).
 */
function strokeDeclarations(source: DjangoNodeSource): Record<string, string> {
  const align = source.strokeAlign
  if (!align) return {}
  const color = solidStrokeColor(source.strokes)
  if (!color) return {}

  if (align === 'INSIDE') {
    const w = source.individualStrokeWeights
    if (w && !(w.top === w.right && w.right === w.bottom && w.bottom === w.left)) {
      return {
        'border-style': 'solid',
        'border-color': color,
        'border-top-width': px(w.top),
        'border-right-width': px(w.right),
        'border-bottom-width': px(w.bottom),
        'border-left-width': px(w.left),
      }
    }
    return {} // uniform INSIDE — getCSSAsync's border is exact
  }

  const weight = typeof source.strokeWeight === 'number' ? source.strokeWeight : undefined
  if (weight == null) return {} // mixed weight → SVG path (IR), not a CSS border
  if (align === 'CENTER') {
    const half = px(weight / 2)
    return { 'box-shadow': `0 0 0 ${half} ${color} inset, 0 0 0 ${half} ${color}` }
  }
  // OUTSIDE
  return { outline: `${px(weight)} solid ${color}`, 'outline-offset': '0px' }
}

/** Scales each `px` corner radius by `1 + smoothing * 0.6` — the linear approximation of an iOS
 * squircle (`cornerSmoothing`, M7). Percentage radii (e.g. `50%`) are left as-is. */
/** Exported for the theme collector (REFORM phase 14 C): kit-master radii must go through the
 * SAME squircle approximation the instance CSS gets, or every smoothed instance would show a
 * spurious radius delta against its master. */
/** Splits a `border-radius` value into the components CSS reads, respecting parentheses —
 * `var(--r, 16px)` contains a space of its own, so splitting on whitespace alone tears it. */
function splitRadiusComponents(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth++
    else if (char === ')') depth--
    if (depth === 0 && (/\s/.test(char) || char === '/')) {
      if (current) parts.push(current)
      current = ''
      if (char === '/') parts.push('/')
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

export function scaleBorderRadius(value: string, smoothing: number): string {
  const factor = Math.round((1 + smoothing * 0.6) * 1000) / 1000
  return splitRadiusComponents(value)
    .map((part) => {
      if (part === '/') return '/'
      // A component that reads a variable has to keep reading it: scaling the *fallback*
      // inside `var(--r, 16px)` only takes effect when the token is missing, which is exactly
      // the case where the shape does not matter. Where the design system is wired up — the
      // whole point — the browser would take the token's own value and drop the squircle
      // compensation silently. `calc()` composes with the custom property instead.
      if (part.includes('var(')) return `calc(${part} * ${factor})`
      return part.replace(/(-?\d*\.?\d+)px/g, (_match, n: string) => `${Math.round(parseFloat(n) * factor * 100) / 100}px`)
    })
    .join(' ')
}

/** Effect types with no CSS equivalent (M8 DoD) — never emitted as (broken) CSS, only warned +
 * noted so the export report can surface what was silently dropped. */
/** M8: a `/* .<class> tokens: ... *\/` comment listing the shared style names resolved onto this
 * node (`ir.ts`'s `readStyleRefs`) — the DoD's "style-ids resolve to tokens" requirement. There's
 * no CSS custom property to bind a *style* (as opposed to a *variable*) to, so this stays a
 * human-readable note rather than a functional declaration, matching the aspect-ratio-skipped note
 * just above it in `collectNodeCss`. `undefined` when the node references no shared style. */
function formatStyleRefsComment(className: string, styleRefs: IrStyleRefs | undefined): string | undefined {
  if (!styleRefs) return undefined
  const parts: string[] = []
  if (styleRefs.fillStyleName) parts.push(`fill: ${styleRefs.fillStyleName}`)
  if (styleRefs.strokeStyleName) parts.push(`stroke: ${styleRefs.strokeStyleName}`)
  if (styleRefs.effectStyleName) parts.push(`effect: ${styleRefs.effectStyleName}`)
  if (styleRefs.gridStyleName) parts.push(`grid: ${styleRefs.gridStyleName}`)
  if (parts.length === 0) return undefined
  return `/* .${className} tokens — ${parts.join(', ')} */`
}

const UNSUPPORTED_EFFECT_TYPES = new Set<string>(['NOISE', 'TEXTURE', 'GLASS', 'SHADER'])

/** Paints with no CSS at all. A shader is a program; a pattern is another node tiled. Figma's
 * own `getCSSAsync` omits both silently, which is how a banner painted colour + shader + photo
 * came out looking like colour + photo with nobody able to say which half went missing. */
const UNSUPPORTED_FILL_TYPES = new Set<string>(['SHADER', 'PATTERN'])

function warnUnsupportedFills(source: DjangoNodeSource, nodeId: string, notes: EmitterNote[] | undefined): void {
  for (const field of ['fills', 'strokes'] as const) {
    const paints = (source as unknown as Record<string, unknown>)[field]
    if (!Array.isArray(paints)) continue
    for (const paint of paints) {
      const entry = paint as { type?: string; visible?: boolean }
      if (entry?.visible === false) continue
      if (typeof entry?.type !== 'string' || !UNSUPPORTED_FILL_TYPES.has(entry.type)) continue
      console.warn(`[css-emitter] "${nodeId}": ${entry.type} ${field.slice(0, -1)} has no CSS equivalent — skipped`)
      notes?.push({ type: 'unsupported-fill', node: nodeId, fill: entry.type })
    }
  }
}

function warnUnsupportedEffect(nodeId: string, effectType: string, notes: EmitterNote[] | undefined): void {
  console.warn(`[css-emitter] "${nodeId}": ${effectType} effect has no CSS equivalent — skipped`)
  notes?.push({ type: 'unsupported-effect', node: nodeId, effect: effectType })
}

/**
 * M8: re-maps a `DROP_SHADOW` effect with `showShadowBehindNode: true` to `filter: drop-shadow()`
 * — `box-shadow` is always clipped to the node's own box, so it can't paint a shadow that shows
 * from behind the node's shape the way Figma does. `drop-shadow()` has no `spread` parameter, so a
 * shadow's spread is dropped when it's remapped (matches the DoD's explicit call-out). When any
 * behind-node shadow is present, EVERY shadow's `box-shadow` contribution is dropped in favor of
 * the filter (an approximation — a node mixing a behind-node shadow with a plain one loses the
 * plain one's box-shadow layer, a rare combination in practice). Also flags any NOISE/TEXTURE/
 * GLASS/SHADER effect via `warnUnsupportedEffect` — those never had a CSS mapping to begin with,
 * `getCSSAsync` simply omits them, so this only adds the visibility the DoD asks for.
 */
function effectDeclarations(source: DjangoNodeSource, nodeId: string, notes: EmitterNote[] | undefined): { filter?: string; dropBoxShadow?: true } {
  const effects = source.effects
  if (!Array.isArray(effects) || effects.length === 0) return {}

  const filters: string[] = []
  let dropBoxShadow = false

  for (const effect of effects) {
    if (effect.visible === false) continue
    if (effect.type === 'DROP_SHADOW' && effect.showShadowBehindNode) {
      const { x, y } = effect.offset ?? { x: 0, y: 0 }
      const blur = effect.radius ?? 0
      const color = effect.color ? rgbaToCss(effect.color) : 'rgba(0, 0, 0, 1)'
      filters.push(`drop-shadow(${px(x)} ${px(y)} ${px(blur)} ${color})`)
      dropBoxShadow = true
      continue
    }
    if (UNSUPPORTED_EFFECT_TYPES.has(effect.type)) warnUnsupportedEffect(nodeId, effect.type, notes)
  }

  if (filters.length === 0) return {}
  return { filter: filters.join(' '), ...(dropBoxShadow ? { dropBoxShadow: true as const } : {}) }
}

async function emitBoxRules(
  className: string,
  node: IrNode,
  source: DjangoNodeSource | undefined,
  layout: Record<string, string>,
  fillUrls: readonly string[],
  isVectorLeaf: boolean,
  variableNamesById: ReadonlyMap<string, string>,
  rules: string[],
  notes: EmitterNote[] | undefined,
  themedMaster?: Record<string, string>
): Promise<void> {
  let literal = source ? resolveImageFillPlaceholders(pickVisualDeclarations(await source.getCSSAsync()), fillUrls) : {}
  if (isVectorLeaf) {
    literal = Object.fromEntries(Object.entries(literal).filter(([property]) => !VECTOR_LEAF_PAINT.has(property)))
  }
  const overrides = source && !isVectorLeaf ? tokenOverrides(source.boundVariables, false, variableNamesById, literal) : {}
  const decl: Record<string, string> = { ...layout, ...literal, ...overrides }

  // M7: re-map the stroke from strokeAlign when it isn't a plain uniform INSIDE border.
  const stroke = source && !isVectorLeaf ? strokeDeclarations(source) : {}
  if (Object.keys(stroke).length > 0) {
    for (const property of STROKE_OWNED_CSS) delete decl[property]
    // A CENTER stroke's box-shadow must ride alongside any real drop-shadow effect, not replace it.
    if (stroke['box-shadow'] && decl['box-shadow']) stroke['box-shadow'] = `${stroke['box-shadow']}, ${decl['box-shadow']}`
    Object.assign(decl, stroke)
  }

  // M7: cornerSmoothing (iOS squircle) has no CSS equivalent — approximate by scaling the radius
  // and record a structured note instead of warning inline.
  const smoothing = source?.cornerSmoothing
  if (smoothing && smoothing > 0 && decl['border-radius']) {
    decl['border-radius'] = scaleBorderRadius(decl['border-radius'], smoothing)
    notes?.push({ type: 'squircle-approx', node: node.id, smoothing })
  }

  // M8: showShadowBehindNode has no box-shadow equivalent — re-map to filter: drop-shadow() and
  // warn on any NOISE/TEXTURE/GLASS/SHADER effect (no CSS mapping exists for those either).
  if (source && !isVectorLeaf) warnUnsupportedFills(source, node.id, notes)
  const effect = source && !isVectorLeaf ? effectDeclarations(source, node.id, notes) : {}
  if (effect.filter) {
    if (effect.dropBoxShadow) delete decl['box-shadow']
    decl['filter'] = decl['filter'] ? `${effect.filter} ${decl['filter']}` : effect.filter
  }

  // M8: ImagePaint.rotation — the fill's own baked-in rotation, applied on the leaf <img> itself.
  // Only a leaf image node has this (a container's background-image can't rotate independently of
  // its children — see `IrImageNode.imageRotation`'s doc comment).
  if (node.type === 'image' && node.imageRotation) {
    decl['transform'] = decl['transform'] ? `${decl['transform']} rotate(${node.imageRotation}deg)` : `rotate(${node.imageRotation}deg)`
  }

  // REFORM phase 14 (C): a themed kit-button instance trades its mapped pixel props for Bootstrap
  // var overrides — equal-to-master props drop entirely (the theme's .btn/.btn-<role> vars carry
  // them), designer overrides become `--bs-btn-*` on the instance class. Runs AFTER the smoothing/
  // stroke/effect passes so the compared values match what would have been emitted.
  if (themedMaster) themeButtonInstanceDecl(decl, themedMaster)

  // M11 fill order: Figma paints fills bottom-up with a video usually at the BOTTOM and the other
  // fills (scrims/gradients) ABOVE it — but as css `background` those fills paint below every child,
  // so the <video> child covered them and the overlay vanished. Restore the order: the video layer
  // sits at z:-2 (html-emitter), the remaining fills move onto a `::before` at z:-1, and the
  // container gets `isolation: isolate` so the negative-z layers can't escape behind ancestor
  // backgrounds. Content children (in-flow / z:auto) still paint above both.
  if ('backgroundVideo' in node && node.backgroundVideo) {
    decl['isolation'] = 'isolate'
    const bgProps = Object.keys(decl).filter((property) => property === 'background' || property.startsWith('background-'))
    if (bgProps.length > 0) {
      const overlay: Record<string, string> = {
        content: '""',
        position: 'absolute',
        inset: '0',
        'z-index': '-1',
        'pointer-events': 'none',
        'border-radius': 'inherit',
      }
      for (const property of bgProps) {
        overlay[property] = decl[property]
        delete decl[property]
      }
      const rule = formatRule(className, decl)
      if (rule) rules.push(rule)
      rules.push(formatRule(`${className}::before`, overlay)!)
      return
    }
  }

  const rule = formatRule(className, decl)
  if (rule) rules.push(rule)
}

async function collectNodeCss(
  node: IrNode,
  parentLayout: IrLayout | null,
  parentSize: { width: number; height: number } | undefined,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  rules: string[],
  options: EmitCssOptions,
  isFixedChild = false,
  childIndex?: number
): Promise<void> {
  const className = classNameFor(node.id, options)
  const source = sceneNodesById.get(node.id)
  const layout = layoutDeclarations(node, parentLayout, parentSize, childIndex)
  // M4c: numberOfFixedChildren's fixed section stays pinned above the scrolling children —
  // sticky to the nearest scrolling ancestor (the overflow-auto frame above, or the page itself).
  if (isFixedChild) {
    layout['position'] = 'sticky'
    layout['top'] = '0'
    layout['z-index'] = '10'
  }
  // A per-layer "Fixed position when scrolling" / "Stick to top" is a design statement the export
  // used to read into the IR and then drop: the header scrolled away in the browser while it
  // stayed put in the prototype. The layer's own choice wins over the parent's fixed-children
  // section, which is the coarser of the two.
  if (node.scrollBehavior) {
    layout['position'] = node.scrollBehavior
    // Absolute placement already gave the layer its own offsets; a fixed/sticky box with no
    // resolved offset would never actually stick to anything.
    if (layout['top'] === undefined && layout['bottom'] === undefined) layout['top'] = '0'
    layout['z-index'] = layout['z-index'] ?? '10'
  }
  // M4c: aspect-ratio is skipped, not just omitted, for auto-resizing text (see
  // `layoutDeclarations`) — leave a note instead of silently dropping the design intent.
  if (node.aspectRatio && node.type === 'text' && node.autoResize) {
    rules.push(`/* .${className}: aspect-ratio skipped: auto-resize text */`)
  }
  // M8: shared style names resolved off fillStyleId/strokeStyleId/effectStyleId/gridStyleId —
  // informational only (styles aren't variables, so there's no CSS custom property to bind to).
  const styleRefsComment = formatStyleRefsComment(className, node.styleRefs)
  if (styleRefsComment) rules.push(styleRefsComment)

  if (node.type === 'text') {
    // Text gets a box rule too: placement/sizing live on the <p>, fonts on its segment <span>s.
    const segments = source?.getStyledTextSegments?.(TEXT_SEGMENT_FIELDS) ?? [{ characters: node.characters }]
    const paragraphs = splitTextParagraphs(segments)
    if (isMultiBlockText(paragraphs)) {
      // Multiple paragraphs/list items can't all carry the box's own position/sizing rule (every
      // sibling would then try to occupy the exact same place) — split it onto a `--box` wrapper
      // and keep only the per-paragraph typography (margin/text-align/text-indent) on the shared
      // class each rendered <p>/<li> still carries.
      const TYPOGRAPHY_KEYS = new Set(['margin', 'text-align', 'text-indent'])
      const boxDecl: Record<string, string> = {}
      const typographyDecl: Record<string, string> = {}
      for (const [property, value] of Object.entries(layout)) {
        ;(TYPOGRAPHY_KEYS.has(property) ? typographyDecl : boxDecl)[property] = value
      }
      const boxRule = formatRule(`${className}--box`, boxDecl)
      if (boxRule) rules.push(boxRule)
      const typographyRule = formatRule(className, typographyDecl)
      if (typographyRule) rules.push(typographyRule)
      if (node.paragraphSpacing) {
        rules.push(`.${className}:not(:first-child) {\n  margin-top: ${px(node.paragraphSpacing)};\n}`)
      }
      if (node.listSpacing) {
        rules.push(`li.${className}:not(:first-child) {\n  margin-top: ${px(node.listSpacing)};\n}`)
      }
    } else {
      const boxRule = formatRule(className, layout)
      if (boxRule) rules.push(boxRule)
    }
    await emitTextRules(className, source, node, variableNamesById, rules)
  } else {
    // A vector leaf renders as inline <svg>/exported .svg carrying its own fill — strip the box
    // background so a white logo vector doesn't paint a solid white rectangle over its artwork.
    await emitBoxRules(className, node, source, layout, imageFillUrls(node), node.type === 'vector', variableNamesById, rules, options.notes, options.themedInstances?.get(node.id))
  }

  if ('children' in node) {
    const ownLayout = 'layout' in node ? node.layout : null
    const ownSize = fixedPixelSize(node)
    // M4c: numberOfFixedChildren's fixed section is always the trailing N entries of `children`
    // (Figma keeps them topmost in the layers panel) — never the leading ones.
    const firstFixedIndex = node.children.length - (node.fixedChildrenCount ?? 0)
    for (const [index, child] of node.children.entries()) {
      await collectNodeCss(child, ownLayout, ownSize, sceneNodesById, variableNamesById, rules, options, index >= firstFixedIndex, index)
    }
  }
}

// --- component-set variant modifier CSS (Shell item 3) ---------------------------------------
//
// `variantModifierClasses` (component-emitter.ts) appends a `n<id>--{{ prop|default:'x' }}` BEM
// modifier to a collapsed component set's root class, but nothing ever defined those classes —
// every variant rendered pixel-identical to the default. This groups the exported component-set
// members back into sets, diffs each non-default option's ISOLATED sibling (every other axis at
// its own default) against the default variant position-for-position through both subtrees, and
// emits the delta scoped under the modifier class.

/** One VARIANT-property axis' definitions off a component, typed for `parseVariantName`'s
 * lower-cased map lookups. Non-VARIANT properties (TEXT/BOOLEAN/INSTANCE_SWAP) carry no
 * modifier class and never enter the diff. */
function variantPropertiesOf(component: IrComponentDef | null): (IrComponentPropertyDef & { type: 'VARIANT' })[] {
  return (component?.properties ?? []).filter((prop): prop is IrComponentPropertyDef & { type: 'VARIANT' } => prop.type === 'VARIANT')
}

/** A pure structural fingerprint (type + child count/types, recursively) — two variants with the
 * same signature carry the same node at every position, so a position-for-position CSS diff never
 * compares unrelated nodes. Ignores everything else (ids, text, styling) on purpose. */
function nodeShapeSignature(node: IrNode): string {
  return 'children' in node ? `${node.type}(${node.children.map(nodeShapeSignature).join(',')})` : node.type
}

/** Figma names a variant member by its own prop values ("Size=lg, State=Hover") — the IR carries
 * no other way to tell one member's values apart from its siblings (`component.properties` is the
 * SET's shared defs, identical across every member). A member is "the default" when every VARIANT
 * prop's own value (parsed from its name) matches that prop's declared default. */
function isDefaultVariant(node: IrContainerNode, variantProps: readonly IrComponentPropertyDef[]): boolean {
  const values = parseVariantName(node.name)
  return variantProps.every((prop) => values.get(prop.name.trim().toLowerCase()) === String(prop.defaultValue).trim().toLowerCase())
}

/** One component set's collected variant members, as seen by both the markup collapse
 * (`collectComponents` in component-emitter.ts) and this module's CSS diff pass — kept in ONE
 * place so the two can never disagree about which sets collapse or which member is the default. */
export interface ComponentVariantSet {
  readonly setName: string
  readonly members: readonly IrContainerNode[]
  readonly defaultVariant: IrContainerNode
  /** False for a structurally divergent set (different child count/types across variants, e.g. a
   * "with icon" variant) — callers keep the pre-collapse one-partial/one-CSS-block-per-variant
   * behavior for those instead of diffing subtrees that don't correspond position-for-position. */
  readonly uniform: boolean
}

/** Groups the flat component list `collectComponents` walks (every ComponentNode variant, one
 * entry per member — `component.setName` is the SAME string across every member of one set,
 * read off the shared parent ComponentSet) back into one `ComponentVariantSet` per distinct name,
 * in first-occurrence order. Components with no `setName` (standalone, non-variant) are excluded
 * — they're never part of a set to begin with. */
export function groupComponentVariantSets(components: readonly IrContainerNode[]): readonly ComponentVariantSet[] {
  const order: string[] = []
  const membersBySetName = new Map<string, IrContainerNode[]>()
  for (const component of components) {
    const setName = component.component?.setName?.trim()
    if (!setName) continue
    const members = membersBySetName.get(setName)
    if (members) members.push(component)
    else {
      membersBySetName.set(setName, [component])
      order.push(setName)
    }
  }
  return order.map((setName) => {
    const members = membersBySetName.get(setName)!
    const baseline = nodeShapeSignature(members[0])
    const uniform = members.every((member) => nodeShapeSignature(member) === baseline)
    const variantProps = variantPropertiesOf(members[0].component)
    const defaultVariant = members.find((member) => isDefaultVariant(member, variantProps)) ?? members[0]
    return { setName, members, defaultVariant, uniform }
  })
}

/** The declaration map `collectNodeCss`/`emitBoxRules` would emit for one node, computed at
 * top-level (no parent context) since a diffed variant is compared against its sibling in
 * isolation, not against whatever parent happened to contain it in the live document. Duplicated
 * from `emitBoxRules` rather than shared — same call interactions.ts makes for its own local
 * `IR_OWNED_CSS` copy — so this read-only diff pass can never mutate what a node's OWN base rule
 * contains. Text segment typography isn't covered (segments carry their own per-node class ids,
 * independent of the box declarations here) — out of this pass's scope. */
async function computeVariantDeclarations(
  node: IrNode,
  parentLayout: IrLayout | null,
  parentSize: { width: number; height: number } | undefined,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  childIndex?: number
): Promise<Record<string, string>> {
  const source = sceneNodesById.get(node.id)
  const layout = layoutDeclarations(node, parentLayout, parentSize, childIndex)
  if (node.type === 'text') return layout
  const isVectorLeaf = node.type === 'vector'
  let literal = source ? resolveImageFillPlaceholders(pickVisualDeclarations(await source.getCSSAsync()), imageFillUrls(node)) : {}
  if (isVectorLeaf) literal = Object.fromEntries(Object.entries(literal).filter(([property]) => !VECTOR_LEAF_PAINT.has(property)))
  const overrides = source && !isVectorLeaf ? tokenOverrides(source.boundVariables, false, variableNamesById, literal) : {}
  const decl: Record<string, string> = { ...layout, ...literal, ...overrides }
  const stroke = source && !isVectorLeaf ? strokeDeclarations(source) : {}
  if (Object.keys(stroke).length > 0) {
    for (const property of STROKE_OWNED_CSS) delete decl[property]
    if (stroke['box-shadow'] && decl['box-shadow']) stroke['box-shadow'] = `${stroke['box-shadow']}, ${decl['box-shadow']}`
    Object.assign(decl, stroke)
  }
  const smoothing = source?.cornerSmoothing
  if (smoothing && smoothing > 0 && decl['border-radius']) decl['border-radius'] = scaleBorderRadius(decl['border-radius'], smoothing)
  // Notes (squircle/unsupported-effect/-fill) stay owned by the real per-node pass above — this
  // is a derived comparison over the same nodes, not a second emission of the same warnings.
  const effect = source && !isVectorLeaf ? effectDeclarations(source, node.id, undefined) : {}
  if (effect.filter) {
    if (effect.dropBoxShadow) delete decl['box-shadow']
    decl['filter'] = decl['filter'] ? `${effect.filter} ${decl['filter']}` : effect.filter
  }
  return decl
}

/** Flattens a subtree into its declaration map in the SAME pre-order traversal `collectNodeCss`
 * walks, so position `i` in two structurally-identical variants' flattened lists is always "the
 * same slot" — `groupComponentVariantSets`'s `uniform` check is what guarantees that identity. */
async function flattenVariantDeclarations(
  node: IrNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>
): Promise<{ id: string; decl: Record<string, string> }[]> {
  const out: { id: string; decl: Record<string, string> }[] = []
  const visit = async (
    n: IrNode,
    parentLayout: IrLayout | null,
    parentSize: { width: number; height: number } | undefined,
    childIndex?: number
  ): Promise<void> => {
    out.push({ id: n.id, decl: await computeVariantDeclarations(n, parentLayout, parentSize, sceneNodesById, variableNamesById, childIndex) })
    if ('children' in n) {
      const ownLayout = 'layout' in n ? n.layout : null
      const ownSize = fixedPixelSize(n)
      for (const [index, child] of n.children.entries()) await visit(child, ownLayout, ownSize, index)
    }
  }
  await visit(node, null, undefined)
  return out
}

/** Only the properties where the sibling's value differs from the default's — matches
 * interactions.ts's `diffCss` discipline (a property the sibling doesn't carry is skipped, no
 * `unset`/`initial`), except IR-owned layout properties are NOT excluded here: a Size variant's
 * whole point is a different width/padding, unlike a hover/press pseudo-state's fixed box. */
function diffVariantDeclarations(defaultDecl: Record<string, string>, siblingDecl: Record<string, string>): Record<string, string> {
  const diff: Record<string, string> = {}
  for (const [property, value] of Object.entries(siblingDecl)) {
    if (defaultDecl[property] === value) continue
    diff[property] = value
  }
  return diff
}

/** The one sibling whose OTHER axes all sit at their own default and whose `targetProp` axis is
 * `targetValue` — isolating exactly one axis' effect, since the modifier classes are per-axis
 * (`variantModifierClasses` emits one class token per VARIANT prop, not one per full combination),
 * so the CSS diffed for it must be per-axis too. `undefined` when the export doesn't contain that
 * exact combination (a non-Cartesian export, or that variant simply wasn't included) — the
 * modifier class then stays dead weight for that one option, same as before this pass existed. */
function findIsolatedVariant(
  members: readonly IrContainerNode[],
  defaultVariant: IrContainerNode,
  variantProps: readonly IrComponentPropertyDef[],
  targetProp: IrComponentPropertyDef,
  targetValue: string
): IrContainerNode | undefined {
  const wantedValue = targetValue.trim().toLowerCase()
  return members.find((member) => {
    if (member === defaultVariant) return false
    const values = parseVariantName(member.name)
    return variantProps.every((prop) => {
      const actual = values.get(prop.name.trim().toLowerCase())
      const wanted = prop === targetProp ? wantedValue : String(prop.defaultValue).trim().toLowerCase()
      return actual === wanted
    })
  })
}

/** Recursively finds every collected component-set variant member — a local copy of
 * component-emitter.ts's `collectComponents` walk (pre-collapse): importing that function here
 * would create a css-emitter ↔ component-emitter import cycle (component-emitter already imports
 * FROM this module), so this module walks the same shape independently instead. */
function collectComponentSetMembers(nodes: readonly IrNode[]): IrContainerNode[] {
  const found: IrContainerNode[] = []
  const visit = (node: IrNode): void => {
    if (node.type === 'container' && node.component) found.push(node)
    if ('children' in node) node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return found
}

async function emitComponentVariantModifierCss(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  options: EmitCssOptions
): Promise<string[]> {
  const rules: string[] = []
  for (const set of groupComponentVariantSets(collectComponentSetMembers(nodes))) {
    if (!set.uniform || set.members.length < 2) continue
    const variantProps = variantPropertiesOf(set.defaultVariant.component)
    if (variantProps.length === 0) continue
    const defaultFlat = await flattenVariantDeclarations(set.defaultVariant, sceneNodesById, variableNamesById)
    const modifierRoot = classNameFor(set.defaultVariant.id, options)
    for (const prop of variantProps) {
      const defaultValue = String(prop.defaultValue).trim().toLowerCase()
      for (const option of prop.variantOptions ?? []) {
        if (option.trim().toLowerCase() === defaultValue) continue
        const sibling = findIsolatedVariant(set.members, set.defaultVariant, variantProps, prop, option)
        if (!sibling) continue
        const siblingFlat = await flattenVariantDeclarations(sibling, sceneNodesById, variableNamesById)
        if (siblingFlat.length !== defaultFlat.length) continue // uniform check already guards this; defensive only
        const modifierClass = `${modifierRoot}--${option}`
        for (let i = 0; i < defaultFlat.length; i++) {
          const diff = diffVariantDeclarations(defaultFlat[i].decl, siblingFlat[i].decl)
          if (Object.keys(diff).length === 0) continue
          const selector = i === 0 ? modifierClass : `${modifierClass} .${classNameFor(defaultFlat[i].id, options)}`
          const rule = formatRule(selector, diff)
          if (rule) rules.push(rule)
        }
      }
    }
  }
  return rules
}

/**
 * Emits one CSS class rule per IR node (recursing into containers/instance-refs), plus one
 * `.<class>--segment-N` rule per style range for text nodes. Layout geometry (flex/grid/absolute,
 * sizes, positions) comes from the IR itself; visual paint comes from `sceneNodesById`, which
 * resolves an IR node's Figma id back to the live node `getCSSAsync`/`getStyledTextSegments`
 * run against. The leading preamble (box-sizing reset, `body` margin, block-level media/skip-link
 * visibility, reduced-motion) is a small, fixed, deterministic baseline — never opinionated resets
 * beyond what an adaptive multipage document needs to not visibly break on a real device.
 */
const CSS_PREAMBLE = [
  '*, *::before, *::after {\n  box-sizing: border-box;\n}',
  'body {\n  margin: 0;\n}',
  'img, svg, video {\n  display: block;\n  max-width: 100%;\n}',
  // Visually hidden until :focus — a keyboard/screen-reader user tabs straight to it and past
  // repeated page chrome; a sighted mouse user never sees it at all.
  '.skip-to-content {\n  position: absolute;\n  left: -9999px;\n  top: 0;\n  z-index: 9999;\n  padding: 0.5rem 1rem;\n  background: #fff;\n  color: #000;\n}\n\n.skip-to-content:focus {\n  left: 0;\n}',
  '@media (prefers-reduced-motion: reduce) {\n  * {\n    animation-duration: .01ms !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: .01ms !important;\n    scroll-behavior: auto !important;\n  }\n}',
].join('\n\n')

export async function emitCss(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string> = new Map(),
  options: EmitCssOptions = {}
): Promise<string> {
  // Figma sizes are border-box (padding inside width/height) — the browser's content-box
  // default would inflate every padded fixed-size node (e.g. a 1920px header with 312px side
  // padding rendered 2544px wide).
  const rules: string[] = options.preamble === false ? [] : [CSS_PREAMBLE]
  for (const node of nodes) {
    await collectNodeCss(node, null, undefined, sceneNodesById, variableNamesById, rules, options)
  }
  // Shell: component-set variant modifier classes (`n<id>--lg`) are otherwise dead weight — no
  // rule ever defined them, so every variant of a collapsed set rendered identically.
  rules.push(...(await emitComponentVariantModifierCss(nodes, sceneNodesById, variableNamesById, options)))
  return rules.join('\n\n')
}
