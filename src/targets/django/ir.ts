/**
 * IR (intermediate representation) schema: a Figma-independent tree that later
 * passes (layout normalization, collapse, codegen) operate on instead of live
 * Figma nodes. Every IR node's `id` is the originating Figma node id, kept
 * stable across re-generation so downstream diffing/round-tripping can match
 * nodes by identity rather than position.
 */

import { resolveExportSettings, type ExportMarkedInstanceNode } from '../../utils/graphics.ts'
import { needsSvg, ellipseArcPath, isDefaultArc } from './geometry.ts'
import { rgbaToCss } from './tokens.ts'
import { transitionToCssTiming } from './smart-animate/easing-adapter.ts'
import {
  primaryDesignerSetting,
  primaryDesignerAssetFilename,
  rasterFilename,
  videoFilename,
  videoPosterFilename,
  containerFillFilename,
  imageFillLeafFilename,
  maskFilename,
  detectImageFillFormat,
  type DesignerExportSetting,
  type ImageFillFormat,
} from './assets.ts'

export type IrNodeType = 'container' | 'text' | 'image' | 'vector' | 'instance-ref'

/** CSS `justify-content` values reachable from Figma's `primaryAxisAlignItems`. */
export type IrJustifyContent = 'flex-start' | 'center' | 'flex-end' | 'space-between'

/** CSS `align-items` values reachable from Figma's `counterAxisAlignItems`. */
export type IrAlignItems = 'flex-start' | 'center' | 'flex-end' | 'baseline'

/** `overflowDirection` (M4c) — the scrollable axis/axes of a clipped frame. Only meaningful
 * alongside `clip` (an un-clipped frame's children still render outside its box, so there's
 * nothing to contain in a scroll box); the CSS emitter additionally skips this on the top-level
 * frame, where the page itself scrolls instead. */
export type IrOverflow = 'x' | 'y' | 'both'

export interface IrFlexLayout {
  kind: 'flex'
  direction: 'row' | 'column'
  wrap: boolean
  /** `itemSpacing` — the main-axis gap. Can be NEGATIVE (overlapping children): CSS `gap` cannot
   * go below 0, so the emitter compiles a negative value to negative margins on the flow children
   * instead of a `gap` declaration (docs/research/08 §1). */
  gap: number
  justifyContent: IrJustifyContent
  alignItems: IrAlignItems
  padding: { top: number; right: number; bottom: number; left: number }
  /** Cross-axis gap between wrapped tracks (`counterAxisSpacing`) — only set when it differs
   * from `gap` on a WRAP layout. `null`/absent → the main-axis gap applies to both. */
  crossGap?: number
  /** `counterAxisAlignContent: 'SPACE_BETWEEN'` on a WRAP layout → CSS `align-content`. */
  alignContent?: 'space-between'
  /** `strokesIncludedInLayout: true` — Figma counts strokes in the layout box (docs literally say
   * "behave like css box-sizing: border-box"). Set only when `true`; the emitter pins the frame to
   * `box-sizing: border-box` per-frame rather than trusting the global reset (docs/research/08 §1). */
  strokesIncludedInLayout?: true
  /** `itemReverseZIndex: true` — the FIRST child paints on top (docs/research/08 §1). Matters when
   * `gap` < 0 and children overlap. Set only when `true`; the emitter stacks children with a
   * descending `z-index`. */
  reverseZIndex?: true
  /** `clipsContent` — children outside the box are hidden (CSS `overflow: hidden`). */
  clip?: true
  /** `overflowDirection` — see `IrOverflow`. */
  overflow?: IrOverflow
}

/** A single grid track: `FIXED` px, `FLEX` → CSS `fr`, or `HUG` → `fit-content(100%)`. */
export type IrGridTrack = { type: 'fixed'; value: number } | { type: 'fr'; value: number } | { type: 'hug' }

export interface IrGridLayout {
  kind: 'grid'
  columns: IrGridTrack[]
  rows: IrGridTrack[]
  columnGap: number
  rowGap: number
  /** `gridItemsPositioning: 'ROW_AUTO_FLOW'` — children flow row-major with no per-child placement
   * (docs equate it to `grid-auto-flow: row`); their anchors are meaningless, so no `gridPlacement`
   * is attached. Absent for the default `'MANUAL'` mode (explicit anchors — see `IrGridPlacement`). */
  autoFlow?: 'row'
  /** `gridAutoTracks: 'ROWS'` — rows are created/removed implicitly as children append, so the
   * emitter uses `grid-auto-rows: auto` instead of an explicit `grid-template-rows` (research/08 §2). */
  autoRows?: true
  /** `clipsContent` — see `IrFlexLayout.clip`. */
  clip?: true
  /** `overflowDirection` — see `IrOverflow`. */
  overflow?: IrOverflow
}

/** No Auto Layout on this node (`layoutMode: 'NONE'`, or a Group): children keep their own x/y. */
export interface IrAbsoluteLayout {
  kind: 'absolute'
  /** `clipsContent` — see `IrFlexLayout.clip`. */
  clip?: true
  /** `overflowDirection` — see `IrOverflow`. */
  overflow?: IrOverflow
}

export type IrLayout = IrFlexLayout | IrGridLayout | IrAbsoluteLayout

/** A node's own width/height behavior as a child of its parent's layout. */
export type IrSize = { mode: 'fixed'; value: number } | { mode: 'hug' } | { mode: 'fill' }

export interface IrSizing {
  width: IrSize
  height: IrSize
  /** Auto Layout min/max sizing (`minWidth`/`maxWidth`/`minHeight`/`maxHeight`) — a `fill`/`hug`
   * node clamped to a range, e.g. a paragraph capped at `max-width: 720px`. Omitted when unset. */
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}

/** One anchor per axis, straight from Figma's `ConstraintType` (`MIN`/`MAX`/`CENTER`/`STRETCH`/
 * `SCALE`) lowercased to match the other Ir* enums' casing. */
export type IrConstraint = 'min' | 'max' | 'center' | 'stretch' | 'scale'

/** `constraints.horizontal`/`constraints.vertical` (M4) for a node that's laid out absolutely —
 * either a direct child of a non-auto-layout container/Group, or `layoutPositioning: 'ABSOLUTE'`
 * inside an auto-layout parent. Absent on Group/TransformGroup/BooleanOperation (no
 * ConstraintMixin) and on any node the emitter never positions absolutely. */
export interface IrConstraints {
  horizontal: IrConstraint
  vertical: IrConstraint
}

/** Row/column anchor + span for a direct child of a `layoutMode: 'GRID'` container. */
export interface IrGridPlacement {
  rowStart: number
  rowSpan: number
  columnStart: number
  columnSpan: number
}

/** The four `componentPropertyDefinitions` types T3.2 maps to Django (docs §2.2). `SLOT` is out of scope. */
export type IrComponentPropertyType = 'BOOLEAN' | 'TEXT' | 'VARIANT' | 'INSTANCE_SWAP'

/** One entry of a ComponentNode's `componentPropertyDefinitions`, property-name suffix (`#123:0`) stripped. */
export interface IrComponentPropertyDef {
  name: string
  type: IrComponentPropertyType
  defaultValue: string | boolean
  /** Only set for `VARIANT` properties. */
  variantOptions: string[] | null
}

/** Marks a `container` IR node as a Figma main component — the emitter's signal to render it as a partial. */
export interface IrComponentDef {
  key: string
  properties: IrComponentPropertyDef[]
  /** REFORM phase 7: the parent ComponentSet's name for a variant component ("Button" for the
   * node named "variant=primary") — the Bootstrap component matcher keys off it. Absent/null
   * for a standalone component (its own `node.name` is the component name then). */
  setName?: string | null
}

/** A single `componentProperties` entry on an instance — becomes an `{% include with %}` param. */
export type IrComponentPropertyValue =
  | { type: 'BOOLEAN'; value: boolean }
  | { type: 'TEXT'; value: string }
  | { type: 'VARIANT'; value: string }
  /** `value` is the swapped-in component's Figma node id. */
  | { type: 'INSTANCE_SWAP'; value: string }

/** Which component property (name, suffix stripped) a node's own field is bound to (docs §2.2,
 * `node.componentPropertyReferences`) — the emitter's cue for *where* to place `{{ var }}`/`{% if %}`. */
export interface IrComponentPropertyReferences {
  characters?: string
  visible?: string
  mainComponent?: string
}

/** `targetAspectRatio` (M4c) — set via `lockAspectRatio()`, read-only on the node itself. The CSS
 * emitter renders it as `aspect-ratio: w / h` and drops the literal height (the browser derives
 * it), except on auto-resizing text — see `IrTextNode.autoResize`. */
export interface IrAspectRatio {
  width: number
  height: number
}

interface IrNodeBase {
  /** Stable key: the originating Figma node id. */
  id: string
  name: string
  /** Position relative to the parent — the coordinates an `absolute` parent layout positions this node with. */
  position: { x: number; y: number }
  sizing: IrSizing
  /** Set only for direct children of a `layoutMode: 'GRID'` container. */
  gridPlacement: IrGridPlacement | null
  componentPropertyReferences: IrComponentPropertyReferences
  /** Design-linter findings surfaced during normalization (e.g. missing Auto Layout). */
  warnings: string[]
  /** `layoutPositioning: 'ABSOLUTE'` — this child ignores its auto-layout parent's flow and
   * overlays at its own x/y (CSS `position: absolute`). Absent for normal flow children. */
  absoluteInLayout?: true
  /** `layoutAlign` override (non-INHERIT) — the child's own cross-axis alignment inside an
   * auto-layout parent, mapped to CSS `align-self`. */
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  /** `constraints.horizontal`/`.vertical` (M4) — the CSS emitter's anchoring input when this
   * node ends up absolutely positioned. See `IrConstraints`. */
  constraints?: IrConstraints
  /** `targetAspectRatio` (M4c) — see `IrAspectRatio`. */
  aspectRatio?: IrAspectRatio
  /** An `ON_CLICK`/`MOUSE_UP` NAVIGATE-to-frame prototype reaction (M9). The Django emitter
   * resolves `destinationId` against the exported page set and wraps this node in `<a href>`.
   * `transition` (Tauri target) carries the reaction's animated transition, when it has one —
   * the cross-document view-transition emitter turns it into `::view-transition-*` timing. */
  navigate?: { destinationId: string; transition?: IrNavigateTransition }
  /** `ON_HOVER`/`ON_PRESS` reactions with a `CHANGE_TO` to another variant (M9). The CSS
   * interactions emitter diffs the two nodes' `getCSSAsync` output and emits `:hover`/`:active`
   * transition classes naming only the concrete properties that changed — never `all`. */
  interactions?: readonly IrInteraction[]
  /** `OVERLAY` navigation reactions (M9). The Django emitter renders a `<dialog>` for each
   * overlay target, and the interactions JS wires the trigger to `showModal()`/`close()`. */
  overlays?: readonly IrOverlay[]
  /** Shared style names resolved from this node's `fillStyleId`/`strokeStyleId`/`effectStyleId`/
   * `gridStyleId` (M8). Absent when the node references no shared style. */
  styleRefs?: IrStyleRefs
}

/** M8: a shared style's `name` (`figma.getStyleByIdAsync(id).name`), keyed by which style slot it
 * came from. The emitter can't turn these into CSS custom properties the way `boundVariables`
 * does (styles aren't variables), so it surfaces them as a `/* tokens *\/` comment above the
 * node's rule instead — informational, not a functional mapping. */
export interface IrStyleRefs {
  fillStyleName?: string
  strokeStyleName?: string
  effectStyleName?: string
  gridStyleName?: string
}

/** The animated transition on a NAVIGATE reaction (SMART_ANIMATE/DISSOLVE/MOVE_IN/…). Durations
 * arrive in ms (Figma stores seconds; `transitionToCssTiming` converts), the easing is already a
 * CSS timing-function string (springs sampled to `linear(…)` by the shared easing module). */
export interface IrNavigateTransition {
  style: 'DISSOLVE' | 'SMART_ANIMATE' | 'SCROLL_ANIMATE' | 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT'
  /** Only on directional transitions (MOVE/PUSH/SLIDE). */
  direction?: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM'
  durationMs: number
  timingFunction: string
}

/** One hover/press interaction from an `ON_HOVER`/`ON_PRESS` reaction with `CHANGE_TO` (M9).
 * The CSS emitter diffs the source node's `getCSSAsync` against the destination's and emits a
 * `:hover` (ON_HOVER) or `:active` (ON_PRESS) rule naming the changed properties only. */
export interface IrInteraction {
  /** `ON_HOVER` → `:hover` (reverts on mouse leave); `ON_PRESS` → `:active` (reverts on mouse up);
   * `ON_CLICK` → a persistent toggled state class (small JS flips it), for click-driven CHANGE_TO
   * prototypes on free-form components (P2). */
  trigger: 'ON_HOVER' | 'ON_PRESS' | 'ON_CLICK'
  /** The target variant node id — resolved against `sceneNodesById` at emit time. If the
   * destination isn't in the exported node set, the interaction is skipped with a warning. */
  destinationId: string
  /** The node id whose `getCSSAsync` is the diff SOURCE (the resting/base state). Absent → the
   * interacting node itself. For an interactive-component instance whose reaction is INHERITED from
   * the main component (P2c), this is the DEFAULT variant (`mainComponent.id`) — so the emitter
   * diffs default-variant↔destination-variant (the designer-intended delta only), and the instance's
   * OWN overrides (e.g. `cornerRadius`) survive on hover/press via the base class CSS instead of being
   * reverted to the raw variant's value (P2d). An instance-level override reaction leaves this unset. */
  sourceId?: string
  /** Transition duration in milliseconds (Figma stores seconds; converted for CSS). */
  durationMs: number
  /** CSS timing-function string (e.g. `cubic-bezier(0.42, 0, 0.58, 1)`) — resolved from the
   * transition's `Easing` via `src/smart-animate/easing-adapter.ts`'s `transitionToCssTiming`. */
  timingFunction: string
}

/** An overlay reaction (M9): the trigger opens a destination frame as a modal overlay. The
 * Django emitter renders a `<dialog>` per overlay and the interactions JS binds the trigger. */
export interface IrOverlay {
  /** The trigger type that opens the overlay — maps to a JS event listener. */
  trigger: Trigger['type']
  /** The overlay target node id. */
  destinationId: string
  /** `overlayRelativePosition` (Vector | null) — MANUAL positioning relative to the trigger. */
  relativePosition?: { x: number; y: number } | null
  /** `overlayPositionType` — CENTER (default), TOP_LEFT, …, MANUAL. */
  positionType: 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'MANUAL'
  /** Overlay background: NONE or SOLID_COLOR with an RGBA color. */
  background: { type: 'NONE' } | { type: 'SOLID_COLOR'; color: { r: number; g: number; b: number; a: number } }
  /** `CLOSE_ON_CLICK_OUTSIDE` → the dialog gets a click-outside-to-close listener; `NONE` omits it. */
  closeInteraction: 'NONE' | 'CLOSE_ON_CLICK_OUTSIDE'
}

/** A container's own image fill, exported as a real file so its CSS background survives — the
 * container's `getCSSAsync` reports the fill as `url(<path-to-image>)`, which the CSS emitter
 * resolves to `assetSrc` (`static`-relative `img/<file>`). The asset pass writes the raw
 * `figma.getImageByHash(imageHash)` bytes to exactly that file; `exportAsync` on the container
 * would bake its children into the background instead. */
export interface IrBackgroundImage {
  imageHash: string
  assetSrc: string
}

/** M11: a container's own video fill (VideoPaint), emitted as a positioned `<video>` background
 * layer behind the container's content. The container clips (overflow:hidden + border-radius
 * preservation) and the video fills the render area via `object-fit` derived from `scaleMode`.
 * `videoHash` resolves the video bytes via `figma.getVideoByHashAsync`; `posterSrc` is the 1x PNG
 * still the `<video>` shows before it loads. */
export interface IrBackgroundVideo {
  videoHash: string
  /** `static`-relative path (`img/<file>.mp4`) of the exported video. */
  assetSrc: string
  /** `static`-relative path (`img/<file>-poster.png`) of the poster snapshot. */
  posterSrc: string
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE'
  /** Set by `annotateVideoFills` (export/assets.ts) when the MP4 export failed — video bytes
   * aren't always available to the plugin API. The emitter degrades the layer to a poster
   * `<img>` and the asset pass skips the .mp4, so no template references a file the zip
   * doesn't ship. */
  videoUnavailable?: true
}

/** A rect/ellipse mask (M7): the wrapper clips its children to the shape via `overflow: hidden`
 * plus a `border-radius` copied from the mask (rectangles) or `50%` (ellipses). */
export interface IrMaskClip {
  kind: 'clip'
  shape: 'rect' | 'ellipse'
  /** Rectangle corner radius copied off the mask shape — a uniform px value, or the four corners
   * when they differ. Absent for a square-cornered rect (and always for an ellipse). */
  radius?: number | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }
}

/** An alpha/luminance/vector mask (M7): the mask shape is exported as an asset and applied to the
 * wrapper via CSS `mask-image` + `mask-mode` (docs/research/09 §6). */
export interface IrMaskImage {
  kind: 'image'
  /** `maskType` → CSS `mask-mode`: LUMINANCE → `luminance`, ALPHA/VECTOR → `alpha`. */
  mode: 'alpha' | 'luminance'
  /** Figma id of the mask shape, so the asset pass can `exportAsync` it. */
  nodeId: string
  /** `static`-relative path (`img/<file>.svg`) of the exported mask shape. */
  assetSrc: string
}

/** How a synthetic mask-wrapper container clips its children — see `IrMaskClip`/`IrMaskImage`. */
export type IrMask = IrMaskClip | IrMaskImage

/** Frame/Group/Component: a layout box holding other IR nodes. `component` is non-null only for a
 * serialized ComponentNode — Frame/Group always carry `null`. */
export interface IrContainerNode extends IrNodeBase {
  type: 'container'
  layout: IrLayout
  component: IrComponentDef | null
  /** Present only when the container itself has one or more visible image fills — one entry per
   * stacked layer, in `fills[]` order (M8 "layered fills"). */
  backgroundImages?: IrBackgroundImage[]
  /** M11: present only when the container itself has a visible video fill (VideoPaint). The
   * emitter renders a positioned `<video>` background layer behind the container's content. */
  backgroundVideo?: IrBackgroundVideo
  /** Set only on a synthetic mask-wrapper container (M7) — how it clips its children. The wrapper
   * is created by `serializeChildren` around a mask node and its following siblings; the mask node
   * itself is never rendered as a visible element. */
  mask?: IrMask
  /** `numberOfFixedChildren` (M4c) — the trailing N entries of `children` stay pinned
   * (`position: sticky`) while the rest scroll. Omitted when zero. */
  fixedChildrenCount?: number
  children: IrNode[]
}

export interface IrTextNode extends IrNodeBase {
  type: 'text'
  characters: string
  /** `textAlignHorizontal` mapped to CSS `text-align` — omitted for `LEFT` (the CSS default),
   * so a full-width heading/paragraph with a non-left alignment lands correctly instead of
   * defaulting to left inside a center-aligned Auto Layout block. */
  textAlign?: 'center' | 'right' | 'justify'
  /** `textAlignVertical` (CENTER/BOTTOM) — the text box becomes a flex column so its paragraphs
   * sit at the mapped edge/center of a fixed-height box; omitted for `TOP` (the CSS default). */
  textAlignVertical?: 'center' | 'flex-end'
  /** `textTruncation: 'ENDING'` — clip overflowing text with a trailing ellipsis. `maxLines` is
   * Figma's explicit line cap (`-webkit-line-clamp`); `null` means the box just clips at its own
   * height with no explicit count, rendered as a single-line ellipsis. */
  truncate?: { maxLines: number | null }
  /** `textAutoResize: 'WIDTH_AND_HEIGHT'` — the box hugs both axes, so Figma never wraps this
   * text; the browser must not either, or a long single line would reflow onto extra lines the
   * box wasn't sized for. */
  noWrap?: true
  /** `textAutoResize !== 'NONE'` — the box hugs its content on at least one axis, so it can't also
   * hold a fixed `aspectRatio`; the CSS emitter skips aspect-ratio emission for these. */
  autoResize?: true
  /** `paragraphSpacing` (>0) — CSS gap between this node's `<p>`/`<li>` blocks. */
  paragraphSpacing?: number
  /** `paragraphIndent` (>0) — CSS `text-indent` on each paragraph's first line. */
  paragraphIndent?: number
  /** `listSpacing` (>0) — CSS gap between `<li>` items, overriding `paragraphSpacing` for lists. */
  listSpacing?: number
  /** `leadingTrim: 'CAP_HEIGHT'` — trims the extra space above the cap height/below the baseline
   * that a font's own line-height metrics normally leave. `NONE`/`figma.mixed` omit the field
   * (CSS `text-box-trim`/`text-box-edge` are new enough that "not set" is the safe default). */
  leadingTrim?: 'CAP_HEIGHT'
  /** `hangingPunctuation`/`hangingList` — punctuation or list markers hang outside the text box's
   * edge. Both map to the same CSS `hanging-punctuation` longhand (Safari-only today). */
  hangingPunctuation?: true
  hangingList?: true
}

/** A shape node whose fill is an image (e.g. a Rectangle used as a photo placeholder). */
export interface IrImageNode extends IrNodeBase {
  type: 'image'
  imageHash: string | null
  /** `static`-relative path (`img/<file>`) of a pre-exported asset — set when this node is a
   * designer-marked graphic (see utils/graphics), so the emitter references the file directly. */
  assetSrc?: string
  /** M11: present when this node carries a VideoPaint fill. The `static`-relative path of the
   * 1x PNG poster snapshot exported alongside the .mp4 — renders as `<video poster="…">`. */
  posterSrc?: string
  /** M11: the VideoPaint's `scaleMode`, mapped to CSS `object-fit` on the `<video>` element. */
  videoScaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE'
  /** Set by `annotateVideoFills` when this video leaf's MP4 export failed ("Cannot export node
   * as video" — the Figma API has no video-byte access). The asset pass ships poster-only and the
   * .mp4 path is reported in export-report.json manualAssets (see IrBackgroundVideo). */
  videoUnavailable?: true
  /** M8: the image fill's own baked-in rotation (`ImagePaint.rotation`) — the emitter applies this
   * as `transform: rotate(Ndeg)` on the `<img>`. Absent when the fill isn't rotated. */
  imageRotation?: 90 | 180 | 270
}

/** A shape or vector node with no image fill — destined for SVG emission. */
export interface IrVectorNode extends IrNodeBase {
  type: 'vector'
  /** `static`-relative path (`img/<file>.svg`) of a pre-exported asset — set for a designer-marked
   * graphic (or a large unmarked vector, by `annotateVectorLeaves`), so the emitter renders an
   * `<img>` and the asset pass writes the file. */
  assetSrc?: string
  /** Raw SVG markup for a small unmarked vector (T2.4's inline-vs-file rule) — the emitter drops
   * it straight into the template instead of a placeholder div. Set by `annotateVectorLeaves`. */
  inlineSvg?: string
}

/** A component instance: keeps its own children (for structural fallback) plus a link to the main component. */
export interface IrInstanceRefNode extends IrNodeBase {
  type: 'instance-ref'
  /**
   * True when the instance was restyled where it sits — a different font, size, colour or
   * auto-resize than its component draws.
   *
   * A component takes text and its own properties; it does not take "and set this line in Inter
   * 13 and let it hug". The payment tile's rows are that: rendered as the component they came
   * from, they came out in the master's 15px SF Pro at a fixed 120px, wrapping a line early.
   */
  restyled?: true
  layout: IrLayout
  componentId: string | null
  componentKey: string | null
  /** The main component's SET name (or its own name) — the page emitter uses it to recognize an
   * inline instance as a Bootstrap component when no partial exists (main def outside the export). */
  componentSetName?: string | null
  /** Current `componentProperties` values on the instance, property-name suffix stripped —
   * the emitter turns these into `{% include ... with %}` params. */
  componentProperties: Record<string, IrComponentPropertyValue>
  /** Present only when the instance itself has one or more visible image fills — see
   * `IrContainerNode.backgroundImages`. */
  backgroundImages?: IrBackgroundImage[]
  /** M11: present only when the instance itself has a visible video fill (VideoPaint). */
  backgroundVideo?: IrBackgroundVideo
  /** `numberOfFixedChildren` (M4c) — see `IrContainerNode.fixedChildrenCount`. */
  fixedChildrenCount?: number
  children: IrNode[]
}

export type IrNode = IrContainerNode | IrTextNode | IrImageNode | IrVectorNode | IrInstanceRefNode

/** True when the node carries a visible VIDEO fill — a "video layer". Such a node exports as an
 * .mp4 (the emitter renders a <video> tag) instead of being flattened into a static graphic. */
function hasVideoFill(node: { fills?: MinimalFillsMixin['fills'] }): boolean {
  return Array.isArray(node.fills) && node.fills.some((fill) => fill.type === 'VIDEO' && fill.visible !== false)
}

/** The first visible VIDEO paint on a node, or `null` — so `serializeShape` and
 * `containerBackgroundVideo` can read `scaleMode`/`videoHash` off the same fill. */
function videoFill(node: { fills?: MinimalFillsMixin['fills'] }): VideoPaint | null {
  if (!Array.isArray(node.fills)) return null
  const fill = node.fills.find((f): f is VideoPaint => f.type === 'VIDEO' && f.visible !== false)
  return fill ?? null
}

/** M11: a FigJam MediaNode carries `mediaData: { hash }` instead of `fills`. The hash resolves via
 * `figma.getVideoByHashAsync` (video) or `figma.getImageByHashAsync` (image). Without a live figma
 * global (unit tests, IR snapshots) we can't distinguish — but `exportAsync({format:'MP4'})`
 * succeeds on a video MediaNode and throws on an image one, so the asset pass determines the type
 * at export time. The IR marks the node with `isMediaNode` so the serializer and emitter know to
 * treat it as a potential video (poster + video attributes, same as a VideoPaint leaf). */
function hasMediaData(node: unknown): node is { mediaData: { hash: string } } {
  return typeof node === 'object' && node !== null && 'mediaData' in node && typeof (node as any).mediaData?.hash === 'string'
}

function imageFillHash(node: { fills?: MinimalFillsMixin['fills'] }): string | null {
  if (!Array.isArray(node.fills)) return null
  const imageFill = node.fills.find(
    (fill): fill is ImagePaint => fill.type === 'IMAGE' && fill.visible !== false
  )
  return imageFill?.imageHash ?? null
}

/** `ImagePaint.rotation` (M8) — the asset's own baked-in rotation, distinct from `node.rotation`
 * (the layer's rotation on the canvas). Figma only ever reports 0/90/180/270 here. Only a leaf
 * image (`serializeShape`) can safely apply this as `transform: rotate()` on its own element — a
 * container's background-image can't rotate without also rotating its children, so multi-layer
 * container fills don't attempt this (see `containerBackgroundImage`). */
function imageFillRotation(node: { fills?: MinimalFillsMixin['fills'] }): 90 | 180 | 270 | undefined {
  if (!Array.isArray(node.fills)) return undefined
  const imageFill = node.fills.find(
    (fill): fill is ImagePaint => fill.type === 'IMAGE' && fill.visible !== false
  )
  const rotation = imageFill?.rotation
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : undefined
}

/** Every visible IMAGE paint on a node, in `fills[]` order — a container/instance can stack more
 * than one image fill (docs/1TO1-FIDELITY.md M8 "layered fills"), unlike a leaf shape which only
 * ever renders its first (`imageFillHash`/`serializeShape`). `fills[]`'s declared order is assumed
 * to match the order `getCSSAsync`'s multi-layer `background`/`background-image` shorthand lists
 * the corresponding `<path-to-image>` placeholders in — there's no live-Figma way to verify this
 * assumption offline, but it's a strict improvement over the prior single-fill behavior either way. */
function visibleImageFills(node: { fills?: MinimalFillsMixin['fills'] }): (ImagePaint & { imageHash: string })[] {
  if (!Array.isArray(node.fills)) return []
  return node.fills.filter(
    (fill): fill is ImagePaint & { imageHash: string } =>
      fill.type === 'IMAGE' && fill.visible !== false && typeof fill.imageHash === 'string'
  )
}

/** Format cache for `containerBackgroundImage`: image hashes are content-addressed, so a hash's
 * sniffed format can never change — and containers sharing one fill (the same photo on several
 * frames) skip refetching its bytes. */
const imageFillFormatByHash = new Map<string, Promise<ImageFillFormat>>()

/** Sniffs an image fill's actual byte format so the exported file's extension is honest. Without
 * a live `figma` (unit tests, IR loaded from a snapshot) or on a failed byte fetch it assumes PNG
 * — the asset pass writes the bytes under whatever name lands in `assetSrc`, so the CSS reference
 * resolves either way. */
function imageFillFormat(imageHash: string): Promise<ImageFillFormat> {
  let format = imageFillFormatByHash.get(imageHash)
  if (!format) {
    format = (async () => {
      if (typeof figma === 'undefined') return 'png'
      try {
        const bytes = await figma.getImageByHash(imageHash)?.getBytesAsync()
        return bytes ? detectImageFillFormat(bytes) : 'png'
      } catch {
        return 'png'
      }
    })()
    imageFillFormatByHash.set(imageHash, format)
  }
  return format
}

/** The `backgroundImages` field for a container-ish node with one or more visible image fills,
 * shaped for spreading — a fill-less node contributes no key at all. Groups carry no `fills` of
 * their own, so they always come back empty. Each entry gets its own exported file (index-suffixed
 * beyond the first) since a stacked multi-fill node needs one asset per layer, not one shared file. */
async function containerBackgroundImage(node: {
  id: string
  name: string
  fills?: MinimalFillsMixin['fills']
}): Promise<{ backgroundImages?: IrBackgroundImage[]; backgroundVideo?: IrBackgroundVideo }> {
  // M11: a video fill on a container becomes a background video layer (takes precedence over
  // an image fill, mirroring Figma's own paint stacking — a visible VIDEO paint renders on top).
  const vfill = videoFill(node)
  if (vfill && vfill.videoHash) {
    return {
      backgroundVideo: {
        videoHash: vfill.videoHash,
        assetSrc: `img/${videoFilename(node.id, node.name)}`,
        posterSrc: `img/${videoPosterFilename(node.id, node.name)}`,
        scaleMode: vfill.scaleMode,
      },
    }
  }
  const imageFills = visibleImageFills(node)
  if (imageFills.length === 0) return {}
  const backgroundImages = await Promise.all(
    imageFills.map(async (fill, index) => {
      const format = await imageFillFormat(fill.imageHash)
      const assetSrc = `img/${containerFillFilename(node.id, node.name, format, index)}`
      return { imageHash: fill.imageHash, assetSrc }
    })
  )
  return { backgroundImages }
}

/** `node[key]`, narrowed to a non-empty string — every style-id field is `string | typeof
 * figma.mixed | undefined` depending on node type, and not every node type even declares the
 * field, so this reads it structurally instead of requiring a precise mixin type at each call site. */
function styleIdOf(node: unknown, key: string): string | undefined {
  const value = (node as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** `figma.getStyleByIdAsync(id).name` (M8) — resolves a shared style id to its name, e.g. for
 * surfacing a design token name in the emitted CSS. `dynamic-page` document access (manifest.json)
 * means only the async lookup is available; `getStyleById` throws under this access mode. Missing
 * `figma` global (unit tests, IR snapshots) or a deleted/inaccessible style both resolve to
 * `undefined` rather than throwing — a stale style reference shouldn't break the whole export. */
async function resolveStyleId(styleId: string | undefined): Promise<string | undefined> {
  if (!styleId || typeof figma === 'undefined') return undefined
  try {
    const style = await figma.getStyleByIdAsync(styleId)
    return style?.name ?? undefined
  } catch {
    return undefined
  }
}

/** The `styleRefs` field for any node — reads whichever of `fillStyleId`/`strokeStyleId`/
 * `effectStyleId`/`gridStyleId` the node happens to declare (most nodes only have a subset) and
 * resolves each concurrently. Shaped for spreading; a node with no shared styles contributes no key. */
async function readStyleRefs(node: unknown): Promise<{ styleRefs?: IrStyleRefs }> {
  const [fillStyleName, strokeStyleName, effectStyleName, gridStyleName] = await Promise.all([
    resolveStyleId(styleIdOf(node, 'fillStyleId')),
    resolveStyleId(styleIdOf(node, 'strokeStyleId')),
    resolveStyleId(styleIdOf(node, 'effectStyleId')),
    resolveStyleId(styleIdOf(node, 'gridStyleId')),
  ])
  const styleRefs: IrStyleRefs = {
    ...(fillStyleName ? { fillStyleName } : {}),
    ...(strokeStyleName ? { strokeStyleName } : {}),
    ...(effectStyleName ? { effectStyleName } : {}),
    ...(gridStyleName ? { gridStyleName } : {}),
  }
  return Object.keys(styleRefs).length > 0 ? { styleRefs } : {}
}

/** Frame/Component/Instance: the node types that can carry their own `layoutMode`. */
type AutoLayoutContainer = FrameNode | ComponentNode | InstanceNode

const JUSTIFY_CONTENT: Record<'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN', IrJustifyContent> = {
  MIN: 'flex-start',
  MAX: 'flex-end',
  CENTER: 'center',
  SPACE_BETWEEN: 'space-between',
}

const ALIGN_ITEMS: Record<'MIN' | 'MAX' | 'CENTER' | 'BASELINE', IrAlignItems> = {
  MIN: 'flex-start',
  MAX: 'flex-end',
  CENTER: 'center',
  BASELINE: 'baseline',
}

function normalizeGridTrack(track: GridTrackSize): IrGridTrack {
  if (track.type === 'FIXED') return { type: 'fixed', value: track.value ?? 0 }
  if (track.type === 'FLEX') return { type: 'fr', value: track.value ?? 1 }
  return { type: 'hug' }
}

/** `clipsContent` as the optional IR flag — absent (not `false`) when the box doesn't clip, so
 * pre-clip fixtures and regeneration snapshots stay byte-identical. */
function clipFlag(node: { clipsContent?: boolean }): { clip?: true } {
  return node.clipsContent ? { clip: true } : {}
}

const OVERFLOW_DIRECTION: Record<'HORIZONTAL' | 'VERTICAL' | 'BOTH', IrOverflow> = {
  HORIZONTAL: 'x',
  VERTICAL: 'y',
  BOTH: 'both',
}

/** `overflowDirection` (M4c) — only meaningful when the frame also clips, since an un-clipped
 * frame's children already render outside its box in Figma (nothing to scroll inside).
 * When the designer did NOT set a scroll behavior, `measuredOverflowFlag` falls back to the
 * live geometry: a clipping auto-layout frame whose in-flow content overruns its FIXED primary
 * axis is a list the designer overfilled — in a real app that container scrolls, so the export
 * gives it a scrollbar instead of silently clipping (the "containers with overflow but no
 * scroll" fidelity gap). Decorative bleeds stay clipped: absolutely-positioned children are
 * excluded from the measurement, and hug-sized frames grow instead of overflowing. */
function overflowFlag(node: {
  clipsContent?: boolean
  overflowDirection?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH'
}): { overflow?: IrOverflow } {
  if (!node.clipsContent) return {}
  const direction = node.overflowDirection
  return direction && direction !== 'NONE' ? { overflow: OVERFLOW_DIRECTION[direction] } : {}
}

/** Content must overrun the box by more than this to count — Figma float noise and 1-2px
 * shadow/stroke spill must not turn every clipped card into a scroll container. */
const MEASURED_OVERFLOW_SLACK_PX = 8

function measuredOverflowFlag(node: {
  clipsContent?: boolean
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  primaryAxisSizingMode?: 'FIXED' | 'AUTO'
  width?: number
  height?: number
  children?: readonly SceneNode[]
}): { overflow?: IrOverflow } {
  try {
    if (!node.clipsContent || !node.children) return {}
    const mode = node.layoutMode
    if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') return {}
    // A hug-sized primary axis grows with content — nothing can overflow it.
    if (node.primaryAxisSizingMode !== 'FIXED') return {}
    const size = mode === 'VERTICAL' ? node.height : node.width
    if (typeof size !== 'number') return {}
    let extent = 0
    for (const child of node.children) {
      if (child.visible === false) continue
      if ('layoutPositioning' in child && child.layoutPositioning === 'ABSOLUTE') continue
      const edge = mode === 'VERTICAL' ? child.y + child.height : child.x + child.width
      if (edge > extent) extent = edge
    }
    if (extent > size + MEASURED_OVERFLOW_SLACK_PX) return { overflow: mode === 'VERTICAL' ? 'y' : 'x' }
    return {}
  } catch {
    return {} // detached/variant edge cases — no scroll is the safe default
  }
}

/** The `AutoLayoutMixin` fields a flex layout reads. A real auto-layout frame and an
 * `inferredAutoLayout` result share this shape (`InferredAutoLayoutResult extends AutoLayoutMixin`),
 * so both build the identical IR through `flexLayout`. */
type FlexSource = Pick<
  AutoLayoutMixin,
  | 'layoutMode'
  | 'layoutWrap'
  | 'counterAxisSpacing'
  | 'counterAxisAlignContent'
  | 'itemSpacing'
  | 'primaryAxisAlignItems'
  | 'counterAxisAlignItems'
  | 'paddingTop'
  | 'paddingRight'
  | 'paddingBottom'
  | 'paddingLeft'
  | 'strokesIncludedInLayout'
  | 'itemReverseZIndex'
>

/** Builds the flex layout from an `AutoLayoutMixin`-shaped source (the node itself, or its
 * `inferredAutoLayout`). `clipsContent`/`overflowDirection` always come from the real `node` —
 * an inferred result carries the auto-layout fields but not the frame's own clip/scroll settings. */
function flexLayout(
  al: FlexSource,
  node: {
    clipsContent?: boolean
    overflowDirection?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH'
    layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
    primaryAxisSizingMode?: 'FIXED' | 'AUTO'
    width?: number
    height?: number
    children?: readonly SceneNode[]
  }
): IrFlexLayout {
  const wrap = al.layoutMode === 'HORIZONTAL' && al.layoutWrap === 'WRAP'
  // counterAxisSpacing (wrap-only cross-axis gap): null means "same as itemSpacing".
  const crossGap = wrap && al.counterAxisSpacing != null && al.counterAxisSpacing !== al.itemSpacing
    ? { crossGap: al.counterAxisSpacing }
    : {}
  const alignContent = wrap && al.counterAxisAlignContent === 'SPACE_BETWEEN'
    ? { alignContent: 'space-between' as const }
    : {}
  return {
    kind: 'flex',
    direction: al.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
    wrap,
    gap: al.itemSpacing,
    justifyContent: JUSTIFY_CONTENT[al.primaryAxisAlignItems],
    alignItems: ALIGN_ITEMS[al.counterAxisAlignItems],
    padding: {
      top: al.paddingTop,
      right: al.paddingRight,
      bottom: al.paddingBottom,
      left: al.paddingLeft,
    },
    ...crossGap,
    ...alignContent,
    ...(al.strokesIncludedInLayout ? { strokesIncludedInLayout: true as const } : {}),
    ...(al.itemReverseZIndex ? { reverseZIndex: true as const } : {}),
    ...clipFlag(node),
    // The designer's explicit scroll behavior wins; measured content overflow fills the gap.
    ...(overflowFlag(node).overflow ? overflowFlag(node) : measuredOverflowFlag(node)),
  }
}

/** Builds the CSS-Grid layout from a `layoutMode: 'GRID'` container. Track sizes are the source of
 * truth (`gridRowSizes`/`gridColumnSizes`, not the counts); `gridItemsPositioning`/`gridAutoTracks`
 * pick per-child placement vs. auto-flow and explicit vs. implicit rows (docs/research/08 §2). */
function gridLayout(node: AutoLayoutContainer): IrGridLayout {
  return {
    kind: 'grid',
    columns: node.gridColumnSizes.map(normalizeGridTrack),
    rows: node.gridRowSizes.map(normalizeGridTrack),
    columnGap: node.gridColumnGap,
    rowGap: node.gridRowGap,
    ...(node.gridItemsPositioning === 'ROW_AUTO_FLOW' ? { autoFlow: 'row' as const } : {}),
    ...(node.gridAutoTracks === 'ROWS' ? { autoRows: true as const } : {}),
    ...clipFlag(node),
    ...overflowFlag(node),
  }
}

/** `inferredAutoLayout` is Figma's guess at an auto-layout for a frame that has none — the same
 * shape as a real auto-layout frame. Reading it can throw on the variant-component edge cases the
 * other getters guard, so read it defensively. */
function readInferredAutoLayout(node: { inferredAutoLayout?: InferredAutoLayoutResult | null }): InferredAutoLayoutResult | null {
  try {
    return node.inferredAutoLayout ?? null
  } catch {
    return null
  }
}

/** Docs §1.3–1.5: Auto Layout → flex, `layoutMode: 'GRID'` → CSS Grid, `'NONE'` → Figma's
 * `inferredAutoLayout` if it found one (a big fidelity win on legacy non-auto-layout designs),
 * else absolute positioning + a linter warning. */
function normalizeLayout(node: AutoLayoutContainer): { layout: IrLayout; warnings: string[] } {
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    return { layout: flexLayout(node, node), warnings: [] }
  }

  if (node.layoutMode === 'GRID') {
    return { layout: gridLayout(node), warnings: [] }
  }

  // layoutMode NONE — before dropping to absolute, adopt Figma's inferred auto-layout when it
  // resolved one (only H/V is ever inferred; GRID never is).
  const inferred = readInferredAutoLayout(node)
  if (inferred && (inferred.layoutMode === 'HORIZONTAL' || inferred.layoutMode === 'VERTICAL')) {
    const direction = inferred.layoutMode === 'HORIZONTAL' ? 'row' : 'column'
    return {
      layout: flexLayout(inferred, node),
      warnings: [`"${node.name}" has no Auto Layout — inferred a ${direction} flex layout from its children`],
    }
  }

  return {
    layout: { kind: 'absolute', ...clipFlag(node), ...overflowFlag(node) },
    warnings: [`"${node.name}" has no Auto Layout — children fall back to absolute positioning`],
  }
}

/** Groups never carry their own layout (docs §1.1): always absolute, always flagged. */
function groupLayout(node: GroupNode): { layout: IrLayout; warnings: string[] } {
  return {
    layout: { kind: 'absolute' },
    warnings: [`"${node.name}" is a Group without Auto Layout — children fall back to absolute positioning`],
  }
}

function normalizeSize(sizing: 'FIXED' | 'HUG' | 'FILL', value: number): IrSize {
  if (sizing === 'HUG') return { mode: 'hug' }
  if (sizing === 'FILL') return { mode: 'fill' }
  return { mode: 'fixed', value }
}

/** Copies a min/max sizing constraint onto the sizing object only when Figma set it (non-null). */
function minMax(node: LayoutMixin): Partial<Pick<IrSizing, 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'>> {
  const constraints: Record<string, number | null | undefined> = {
    minWidth: (node as { minWidth?: number | null }).minWidth,
    maxWidth: (node as { maxWidth?: number | null }).maxWidth,
    minHeight: (node as { minHeight?: number | null }).minHeight,
    maxHeight: (node as { maxHeight?: number | null }).maxHeight,
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(constraints)) {
    if (typeof value === 'number') out[key] = value
  }
  return out
}

function normalizeSizing(node: LayoutMixin): IrSizing {
  return {
    width: normalizeSize(node.layoutSizingHorizontal, node.width),
    height: normalizeSize(node.layoutSizingVertical, node.height),
    ...minMax(node),
  }
}

/** A GRID container whose children are placed manually (anchor + span). A `ROW_AUTO_FLOW` grid
 * flows children row-major with no per-child placement — anchors are meaningless there (docs/
 * research/08 §2) — so its children never carry a `gridPlacement`. The default (unset) mode is
 * `'MANUAL'`. */
function isManualGridParent(node: { layoutMode?: string; gridItemsPositioning?: string }): boolean {
  return node.layoutMode === 'GRID' && node.gridItemsPositioning !== 'ROW_AUTO_FLOW'
}

function normalizeGridPlacement(node: LayoutMixin, isGridChild: boolean): IrGridPlacement | null {
  if (!isGridChild) return null
  return {
    rowStart: node.gridRowAnchorIndex,
    rowSpan: node.gridRowSpan,
    columnStart: node.gridColumnAnchorIndex,
    columnSpan: node.gridColumnSpan,
  }
}

/** Component property names are suffixed `#<unique-id>` for non-VARIANT properties (docs §2.1) —
 * strip it so the emitted Django variable/param name is stable and human-readable. */
function stripPropertySuffix(name: string): string {
  const index = name.lastIndexOf('#')
  return index === -1 ? name : name.slice(0, index)
}

type ComponentPropertyReferencesField = { [K in 'visible' | 'characters' | 'mainComponent']?: string } | null | undefined

function normalizeComponentPropertyReferences(refs: ComponentPropertyReferencesField): IrComponentPropertyReferences {
  if (!refs) return {}
  const result: IrComponentPropertyReferences = {}
  if (refs.visible) result.visible = stripPropertySuffix(refs.visible)
  if (refs.characters) result.characters = stripPropertySuffix(refs.characters)
  if (refs.mainComponent) result.mainComponent = stripPropertySuffix(refs.mainComponent)
  return result
}

const COMPONENT_PROPERTY_TYPES = new Set<string>(['BOOLEAN', 'TEXT', 'VARIANT', 'INSTANCE_SWAP'])

function isSupportedComponentPropertyType(type: string): type is IrComponentPropertyType {
  return COMPONENT_PROPERTY_TYPES.has(type)
}

/** `componentPropertyDefinitions` THROWS on a variant — a ComponentNode whose parent is a
 * ComponentSet ("Component set for node … should be accessed through its parent component set").
 * Read them from the parent set in that case, and never throw, so a single variant reached during
 * serialization can't abort the whole export at the "scan" stage. */
function readComponentPropertyDefinitions(node: ComponentNode): {
  definitions: ComponentPropertyDefinitions
  warning: string | null
} {
  const parent = node.parent
  const source: { componentPropertyDefinitions: ComponentPropertyDefinitions } =
    parent && parent.type === 'COMPONENT_SET' ? (parent as ComponentSetNode) : node
  try {
    return { definitions: source.componentPropertyDefinitions ?? {}, warning: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { definitions: {}, warning: `"${node.name}" component properties couldn't be read (${reason}) — treated as having none` }
  }
}

/** Reads a ComponentNode's `componentPropertyDefinitions` into an `IrComponentDef` (docs §2.1–2.2).
 * `SLOT` properties (out of T3.2's scope) are dropped with a linter warning. */
function normalizeComponentDef(node: ComponentNode): { component: IrComponentDef; warnings: string[] } {
  const properties: IrComponentPropertyDef[] = []
  const { definitions, warning } = readComponentPropertyDefinitions(node)
  const warnings: string[] = warning ? [warning] : []

  for (const [rawName, def] of Object.entries(definitions)) {
    if (!isSupportedComponentPropertyType(def.type)) {
      warnings.push(`"${node.name}" property "${stripPropertySuffix(rawName)}" has unsupported type ${def.type} — skipped`)
      continue
    }
    properties.push({
      name: stripPropertySuffix(rawName),
      type: def.type,
      defaultValue: def.defaultValue,
      variantOptions: def.variantOptions ?? null,
    })
  }

  const setName = node.parent && node.parent.type === 'COMPONENT_SET' ? node.parent.name : null
  return { component: { key: node.key, properties, setName }, warnings }
}

/** `instance.componentProperties` THROWS ("in get_componentProperties: Component set … should be
 * accessed through its parent component set") for some instances of variant components. Reading it
 * defensively keeps one bad instance from aborting the whole export at the "scan" stage. */
function readComponentProperties(node: InstanceNode): ComponentProperties | undefined {
  try {
    return node.componentProperties
  } catch {
    return undefined
  }
}

/** `componentPropertyReferences` can throw on the same variant-component edge cases as
 * `componentProperties`; baseProps runs on every node, so guard it too. */
function readComponentPropertyReferences(node: {
  componentPropertyReferences?: ComponentPropertyReferencesField
}): ComponentPropertyReferencesField {
  try {
    return node.componentPropertyReferences
  } catch {
    return null
  }
}

/** Reads an InstanceNode's current `componentProperties` values (docs §2.1–2.2) — these become
 * `{% include ... with %}` params. `SLOT` values (out of scope) are dropped. */
function normalizeComponentProperties(properties: ComponentProperties | undefined): Record<string, IrComponentPropertyValue> {
  const result: Record<string, IrComponentPropertyValue> = {}
  for (const [rawName, prop] of Object.entries(properties ?? {})) {
    if (!isSupportedComponentPropertyType(prop.type)) continue
    const name = stripPropertySuffix(rawName)
    if (prop.type === 'BOOLEAN') result[name] = { type: 'BOOLEAN', value: Boolean(prop.value) }
    else result[name] = { type: prop.type, value: String(prop.value) }
  }
  return result
}

/** `layoutAlign` is the legacy counter-axis API; `STRETCH` is deliberately NOT mapped — it
 * duplicates the modern `layoutSizingHorizontal/Vertical: 'FILL'` (already emitted as
 * `align-self: stretch` by the sizing pass) and instances can report a stale `STRETCH` while
 * their modern sizing says hug/fixed (observed live: a 1296px centered Banner stretched to
 * 1776px). Only the pure alignment overrides are trusted. */
const LAYOUT_ALIGN_SELF: Record<string, 'flex-start' | 'center' | 'flex-end'> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
}

/** The per-child auto-layout overrides: `layoutPositioning: 'ABSOLUTE'` (the child overlays at
 * its own x/y instead of participating in flow) and a non-INHERIT `layoutAlign` (cross-axis
 * `align-self`). Both are emitted only when set, so plain-flow fixtures stay unchanged. */
function childLayoutOverrides(node: {
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  layoutAlign?: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'INHERIT'
}): { absoluteInLayout?: true; alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch' } {
  const overrides: { absoluteInLayout?: true; alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch' } = {}
  try {
    if (node.layoutPositioning === 'ABSOLUTE') overrides.absoluteInLayout = true
    const alignSelf = node.layoutAlign && LAYOUT_ALIGN_SELF[node.layoutAlign]
    if (alignSelf) overrides.alignSelf = alignSelf
  } catch {
    /* variant-component getters can throw (see readComponentProperties) — treat as defaults */
  }
  return overrides
}

const CONSTRAINT_TYPE: Record<ConstraintType, IrConstraint> = {
  MIN: 'min',
  MAX: 'max',
  CENTER: 'center',
  STRETCH: 'stretch',
  SCALE: 'scale',
}

/** `constraints` is absent on Group/TransformGroup/BooleanOperation — no ConstraintMixin (docs
 * §1 "constraints — NOT on Group/BooleanOperation"). Those wrappers contribute none of their
 * own; each child (Frame/Rectangle/Text/Vector/… all carry ConstraintMixin) is read normally
 * through its own `baseProps` call, so the wrapper is transparent to M4 anchoring. */
function readConstraints(node: { constraints?: Constraints }): IrConstraints | undefined {
  const constraints = node.constraints
  if (!constraints) return undefined
  return { horizontal: CONSTRAINT_TYPE[constraints.horizontal], vertical: CONSTRAINT_TYPE[constraints.vertical] }
}

/** `targetAspectRatio` (M4c) — read-only, set via `lockAspectRatio()`. Figma reports it as a
 * `Vector` (`x`/`y`, the same shape as a point) rather than `width`/`height`, despite meaning the
 * latter — renamed here so the IR field reads naturally. `null` (unset) and `undefined` (a
 * mock/fixture without the field) both omit the key. */
function readAspectRatio(node: { targetAspectRatio?: { x: number; y: number } | null }): { aspectRatio?: IrAspectRatio } {
  const ratio = node.targetAspectRatio
  return ratio ? { aspectRatio: { width: ratio.x, height: ratio.y } } : {}
}

/** `ON_CLICK`/`MOUSE_UP` are the two triggers a Django `<a href>` can faithfully replicate — a
 * plain anchor activates on click, matching both a mouse click and a touch tap (`MOUSE_UP`'s
 * usual proxy on touch devices). Hover/press/timeout/drag/key/media triggers stay out of scope:
 * they need JS to drive, and this milestone's DoD limits JS to smart-animate view-transitions. */
const NAVIGATE_TRIGGERS = new Set<Trigger['type']>(['ON_CLICK', 'MOUSE_UP'])

/** `node.reactions` can throw on the same variant-component edge cases as `componentProperties`
 * (see `readComponentProperties`) — read it defensively so one bad node can't abort the export.
 * Picks the first `ON_CLICK`/`MOUSE_UP` reaction whose action is a NODE navigation;
 * SWAP/OVERLAY/SCROLL_TO/CHANGE_TO stay with their own pipelines. Animated transitions
 * (SMART_ANIMATE included — previously skipped) are captured as `navigate.transition` so the
 * Tauri target's cross-document view-transition emitter can time the page swap; the Django
 * emitter just gets a working `<a href>` where the click used to do nothing. */
function readNavigateReaction(node: { reactions?: ReadonlyArray<Reaction> }): { navigate?: { destinationId: string; transition?: IrNavigateTransition } } {
  let reactions: ReadonlyArray<Reaction> | undefined
  try {
    reactions = node.reactions
  } catch {
    return {}
  }

  for (const reaction of reactions ?? []) {
    if (!reaction.trigger || !NAVIGATE_TRIGGERS.has(reaction.trigger.type)) continue
    for (const action of reaction.actions ?? []) {
      if (action.type !== 'NODE' || action.navigation !== 'NAVIGATE' || !action.destinationId) continue
      return { navigate: { destinationId: action.destinationId, ...readNavigateTransition(action.transition) } }
    }
  }
  return {}
}

/** Maps an animated `Transition` to `IrNavigateTransition`; `null`/instant transitions map to
 * no field. `transitionToCssTiming` can throw on malformed custom easing payloads — degrade to
 * "no transition" (an un-animated but working link) rather than sinking the whole serialize. */
function readNavigateTransition(transition: Transition | null): { transition?: IrNavigateTransition } {
  if (!transition) return {}
  try {
    const timing = transitionToCssTiming(transition)
    const direction = 'direction' in transition ? { direction: transition.direction } : {}
    return { transition: { style: transition.type, ...direction, durationMs: timing.durationMs, timingFunction: timing.timingFunction } }
  } catch {
    return {}
  }
}

/** The trigger types that produce a temporary state change via CSS pseudo-classes (M9).
 * `ON_HOVER` maps to `:hover` (reverts on mouse leave); `ON_PRESS` maps to `:active` (reverts on
 * mouse up). MOUSE_ENTER/LEAVE are permanent (one-way) and need JS — left out of this set. */
const INTERACTION_TRIGGERS = new Set<Trigger['type']>(['ON_HOVER', 'ON_PRESS', 'ON_CLICK', 'MOUSE_UP'])

/** Reads `ON_HOVER`/`ON_PRESS` reactions whose action is a `CHANGE_TO` navigation (M9). Each
 * becomes an `IrInteraction` the CSS emitter diffs against the destination's `getCSSAsync`. The
 * easing/duration come from the reaction's `transition` — a null transition (instant swap) still
 * emits a rule but with zero duration and `linear` timing. */
function readInteractions(
  node: { reactions?: ReadonlyArray<Reaction> },
  sourceId?: string
): { interactions?: readonly IrInteraction[] } {
  let reactions: ReadonlyArray<Reaction> | undefined
  try {
    reactions = node.reactions
  } catch {
    return {}
  }

  const interactions: IrInteraction[] = []
  for (const reaction of reactions ?? []) {
    if (!reaction.trigger || !INTERACTION_TRIGGERS.has(reaction.trigger.type)) continue
    // MOUSE_UP is treated as a click (toggle), like ON_CLICK. Hover/press stay temporary CSS.
    const t = reaction.trigger.type
    const trigger: 'ON_HOVER' | 'ON_PRESS' | 'ON_CLICK' = t === 'ON_HOVER' || t === 'ON_PRESS' ? t : 'ON_CLICK'
    for (const action of reaction.actions ?? []) {
      if (action.type !== 'NODE' || action.navigation !== 'CHANGE_TO' || !action.destinationId) continue
      const transition = action.transition ?? ({ type: 'DISSOLVE', easing: { type: 'LINEAR' }, duration: 0 } as Transition)
      const { timingFunction, durationMs } = transitionToCssTiming(
        transition as { easing: Easing; duration: number }
      )
      // `sourceId` is set only for reactions read off a main-component VARIANT (P2d): the diff base is
      // the default variant, not the instance, so the instance's own overrides survive the state.
      interactions.push({ trigger, destinationId: action.destinationId, durationMs, timingFunction, ...(sourceId ? { sourceId } : {}) })
    }
  }
  return interactions.length > 0 ? { interactions } : {}
}

/** REFORM phase 13 (P2e): interactive-component prototypes commonly CHAIN state variants —
 * `default --ON_HOVER--> hover --ON_PRESS--> press`. `serializeInstance` reads reactions off the
 * DEFAULT variant (`getMainComponentAsync`), so it only ever sees the ON_HOVER link; the ON_PRESS
 * reaction lives on the HOVER variant, one hop away, and is otherwise lost (the button exports with
 * no `:active` state). Given the already-resolved ON_HOVER interaction, this loads the hover-variant
 * node and reads ITS ON_PRESS CHANGE_TO reaction, returning a synthesized ON_PRESS `IrInteraction`.
 * The source stays the instance (≈ default variant) and the destination is the press variant, so
 * `emitInteractions` diffs instance↔press → `.<class>:active` with no emit-side change; the press
 * variant's id — off-page in the component set — is picked up by `collectReactionDestinationIds`
 * from this interaction and resolved into the scene map by P2b (`addReactionDestinationsToScene`).
 * Async + guarded: under dynamic-page `getNodeByIdAsync` loads the off-page variant, and a stale or
 * absent id (or an unavailable `figma` global in unit tests) yields null rather than throwing. */
async function readChainedPressInteraction(hover: IrInteraction): Promise<IrInteraction | null> {
  try {
    const hoverVariant = await figma.getNodeByIdAsync(hover.destinationId)
    if (!hoverVariant || !('reactions' in hoverVariant)) return null
    // The pressed state's diff base is the HOVER variant (`hover.destinationId`), NOT the default:
    // while the pointer is down BOTH `:hover` and `:active` co-apply at equal specificity, so `:active`
    // must re-declare every property the hover state changed (diff hover↔press) to fully override it —
    // otherwise a property hover changed but press reverts to base leaks the hover value into the
    // pressed state. Properties equal across hover↔press (incl. the instance's own overrides) stay
    // excluded, so overrides still survive (P2d preserved).
    const chained = readInteractions(hoverVariant as { reactions?: ReadonlyArray<Reaction> }, hover.destinationId).interactions ?? []
    return chained.find((i) => i.trigger === 'ON_PRESS') ?? null
  } catch {
    return null
  }
}

/** The overlay position types from `OverlayPositionType` (research/09 §4). */
const OVERLAY_POSITION_TYPES = new Set([
  'CENTER', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'MANUAL',
])

/** Reads `OVERLAY` navigation reactions (M9). Each becomes an `IrOverlay` the Django emitter
 * renders as a `<dialog>` element, with the trigger's JS event listener wired to `showModal()`. */
function readOverlays(node: { reactions?: ReadonlyArray<Reaction> }): { overlays?: readonly IrOverlay[] } {
  let reactions: ReadonlyArray<Reaction> | undefined
  try {
    reactions = node.reactions
  } catch {
    return {}
  }

  const overlays: IrOverlay[] = []
  for (const reaction of reactions ?? []) {
    if (!reaction.trigger) continue
    for (const action of reaction.actions ?? []) {
      if (action.type !== 'NODE' || action.navigation !== 'OVERLAY' || !action.destinationId) continue
      const positionType = OVERLAY_POSITION_TYPES.has((action as { overlayPositionType?: string }).overlayPositionType ?? '')
        ? ((action as { overlayPositionType?: string }).overlayPositionType as IrOverlay['positionType'])
        : 'CENTER'
      const rawBackground = (action as { overlayBackground?: { type: string; color?: RGBA } }).overlayBackground
      const background: IrOverlay['background'] = rawBackground && rawBackground.type === 'SOLID_COLOR' && rawBackground.color
        ? { type: 'SOLID_COLOR', color: rawBackground.color }
        : { type: 'NONE' }
      const closeInteraction = (action as { overlayBackgroundInteraction?: string }).overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE'
        ? 'CLOSE_ON_CLICK_OUTSIDE' as const
        : 'NONE' as const
      const relativePosition = (action as { overlayRelativePosition?: { x: number; y: number } }).overlayRelativePosition ?? null
      overlays.push({
        trigger: reaction.trigger.type,
        destinationId: action.destinationId,
        relativePosition,
        positionType,
        background,
        closeInteraction,
      })
    }
  }
  return overlays.length > 0 ? { overlays } : {}
}

/** Fields every IR node carries regardless of kind: identity, position/sizing, grid placement, warnings. */
function baseProps(
  node: LayoutMixin & {
    id: string
    name: string
    componentPropertyReferences?: ComponentPropertyReferencesField
    constraints?: Constraints
    targetAspectRatio?: { x: number; y: number } | null
    reactions?: ReadonlyArray<Reaction>
  },
  isGridChild: boolean
) {
  const constraints = readConstraints(node)
  return {
    id: node.id,
    name: node.name,
    position: { x: node.x, y: node.y },
    sizing: normalizeSizing(node),
    gridPlacement: normalizeGridPlacement(node, isGridChild),
    componentPropertyReferences: normalizeComponentPropertyReferences(readComponentPropertyReferences(node)),
    warnings: [] as string[],
    ...(constraints ? { constraints } : {}),
    ...childLayoutOverrides(node),
    ...readAspectRatio(node),
    ...readNavigateReaction(node),
    ...readInteractions(node),
    ...readOverlays(node),
  }
}

/** `numberOfFixedChildren` (M4c) — see `IrContainerNode.fixedChildrenCount`. Omitted when zero so
 * plain frames stay unchanged. */
function fixedChildrenCount(node: { numberOfFixedChildren?: number }): { fixedChildrenCount?: number } {
  return node.numberOfFixedChildren ? { fixedChildrenCount: node.numberOfFixedChildren } : {}
}

/** A serialized child paired with its live Figma node — kept together so the mask pass can read
 * `isMask`/`maskType`/geometry off the source while grouping the IR nodes. */
interface SerializedChild {
  live: SceneNode
  ir: IrNode
}

function isMaskNode(node: SceneNode): boolean {
  return (node as { isMask?: boolean }).isMask === true
}

/** A numeric corner radius, treating Figma's `mixed` symbol / missing value as 0. */
function radiusNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** The mask shape's corner radius for the clip's `border-radius` — a uniform px value, the four
 * corners when they differ, or `undefined` for a square rectangle. */
function maskClipRadius(node: SceneNode): IrMaskClip['radius'] {
  const uniform = (node as { cornerRadius?: number | symbol }).cornerRadius
  if (typeof uniform === 'number') return uniform > 0 ? uniform : undefined
  const corners = node as { topLeftRadius?: number; topRightRadius?: number; bottomRightRadius?: number; bottomLeftRadius?: number }
  const topLeft = radiusNumber(corners.topLeftRadius)
  const topRight = radiusNumber(corners.topRightRadius)
  const bottomRight = radiusNumber(corners.bottomRightRadius)
  const bottomLeft = radiusNumber(corners.bottomLeftRadius)
  if (!topLeft && !topRight && !bottomRight && !bottomLeft) return undefined
  return { topLeft, topRight, bottomRight, bottomLeft }
}

/** The mask descriptor for a mask shape: a rect/ellipse clips geometrically (overflow + radius);
 * every other shape is exported and applied as a CSS `mask-image` at its `maskType`'s mode. */
function maskDescriptor(node: SceneNode): IrMask {
  if (node.type === 'RECTANGLE') return { kind: 'clip', shape: 'rect', ...(maskClipRadius(node) != null ? { radius: maskClipRadius(node) } : {}) }
  if (node.type === 'ELLIPSE') return { kind: 'clip', shape: 'ellipse' }
  const mode = (node as { maskType?: string }).maskType === 'LUMINANCE' ? 'luminance' : 'alpha'
  return { kind: 'image', mode, nodeId: node.id, assetSrc: `img/${maskFilename(node.id, node.name)}` }
}

/** Places a mask's following siblings inside the wrapper's coordinate space by subtracting the
 * mask's own origin from each direct child's position (deeper descendants stay parent-relative). */
function offsetChildren(children: IrNode[], dx: number, dy: number): IrNode[] {
  if (!dx && !dy) return children
  return children.map((child) => ({ ...child, position: { x: child.position.x - dx, y: child.position.y - dy } }))
}

/** Wraps a mask node and the siblings it clips into a synthetic container (M7). The wrapper takes
 * the mask's box and clips to it; the mask node itself is dropped (never painted as a visible box).
 * A mask with no following siblings clips nothing, so it just disappears. */
function buildMaskWrapper(maskLive: SceneNode, maskIr: IrNode, masked: IrNode[]): IrContainerNode | null {
  if (masked.length === 0) return null
  const mask = maskDescriptor(maskLive)
  return {
    id: `${maskLive.id}--mask`,
    name: maskIr.name,
    position: maskIr.position,
    sizing: maskIr.sizing,
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    ...(maskIr.constraints ? { constraints: maskIr.constraints } : {}),
    type: 'container',
    // A geometric clip hides overflow; a mask-image already bounds the paint, so no extra clip.
    layout: mask.kind === 'clip' ? { kind: 'absolute', clip: true } : { kind: 'absolute' },
    component: null,
    mask,
    children: offsetChildren(masked, maskIr.position.x, maskIr.position.y),
  }
}

/** Groups each mask child with the siblings that follow it (Figma masks clip *following* siblings
 * within the same parent) into a wrapper container, leaving non-mask children in place. */
function groupMasks(children: readonly SerializedChild[]): IrNode[] {
  const out: IrNode[] = []
  let i = 0
  while (i < children.length) {
    const { live, ir } = children[i]
    if (!isMaskNode(live)) {
      out.push(ir)
      i++
      continue
    }
    let j = i + 1
    const masked: IrNode[] = []
    while (j < children.length && !isMaskNode(children[j].live)) {
      masked.push(children[j].ir)
      j++
    }
    const wrapper = buildMaskWrapper(live, ir, masked)
    if (wrapper) out.push(wrapper)
    i = j
  }
  return out
}

async function serializeChildren(node: ChildrenMixin, isGridParent: boolean): Promise<IrNode[]> {
  const serialized = await Promise.all(
    node.children.map(async (child): Promise<SerializedChild | null> => {
      const ir = await serializeNode(child, isGridParent)
      return ir ? { live: child, ir } : null
    })
  )
  return groupMasks(serialized.filter((child): child is SerializedChild => child !== null))
}

export async function serializeFrame(node: FrameNode, isGridChild = false): Promise<IrContainerNode> {
  const { layout, warnings } = normalizeLayout(node)
  return {
    ...baseProps(node, isGridChild),
    ...(await containerBackgroundImage(node)),
    ...(await readStyleRefs(node)),
    ...fixedChildrenCount(node),
    type: 'container',
    layout,
    component: null,
    warnings,
    children: await serializeChildren(node, isManualGridParent(node)),
  }
}

export async function serializeGroup(node: GroupNode, isGridChild = false): Promise<IrContainerNode> {
  const { layout, warnings } = groupLayout(node)
  // A GROUP/BOOLEAN_OPERATION doesn't define its own coordinate space: a child's relativeTransform
  // (hence x/y) is measured against the group's *container parent*, not the group (docs/research/08
  // §4). The emitter positions the group as an absolute box at its own x/y and then its children
  // relative to that box, so their raw parent-space x/y must have the group's origin subtracted or
  // they'd be doubly offset by the group's position. Nested groups telescope correctly — each level
  // subtracts only its own origin. Frames define their own space, so `serializeFrame` never does this.
  return {
    ...baseProps(node, isGridChild),
    ...(await containerBackgroundImage(node)),
    ...(await readStyleRefs(node)),
    type: 'container',
    layout,
    component: null,
    warnings,
    children: offsetChildren(await serializeChildren(node, false), node.x, node.y),
  }
}

const TEXT_ALIGN: Record<string, 'center' | 'right' | 'justify'> = {
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFIED: 'justify',
}

const TEXT_ALIGN_VERTICAL: Record<string, 'center' | 'flex-end'> = {
  CENTER: 'center',
  BOTTOM: 'flex-end',
}

/** Node-level text properties (`paragraphSpacing`, `paragraphIndent`, `listSpacing`) report
 * Figma's `mixed` sentinel when they vary across the text — never serialize the symbol, just
 * omit the field (matches `minMax()`'s guard for per-range sizing constraints above). */
function mixedOrNumber(value: number | symbol): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function textTruncate(node: TextNode): Pick<IrTextNode, 'truncate'> | Record<string, never> {
  if (node.textTruncation !== 'ENDING') return {}
  const maxLines = typeof node.maxLines === 'number' ? node.maxLines : null
  return { truncate: { maxLines } }
}

export async function serializeText(node: TextNode, isGridChild = false): Promise<IrTextNode> {
  const textAlign = TEXT_ALIGN[node.textAlignHorizontal]
  const textAlignVertical = TEXT_ALIGN_VERTICAL[node.textAlignVertical]
  const paragraphSpacing = mixedOrNumber(node.paragraphSpacing)
  const paragraphIndent = mixedOrNumber(node.paragraphIndent)
  const listSpacing = mixedOrNumber(node.listSpacing)
  return {
    ...baseProps(node, isGridChild),
    ...(await readStyleRefs(node)),
    type: 'text',
    characters: node.characters,
    ...(textAlign ? { textAlign } : {}),
    ...(textAlignVertical ? { textAlignVertical } : {}),
    ...textTruncate(node),
    ...(node.textAutoResize === 'WIDTH_AND_HEIGHT' ? { noWrap: true } : {}),
    ...(node.textAutoResize && node.textAutoResize !== 'NONE' ? { autoResize: true as const } : {}),
    ...(paragraphSpacing ? { paragraphSpacing } : {}),
    ...(paragraphIndent ? { paragraphIndent } : {}),
    ...(listSpacing ? { listSpacing } : {}),
    ...(node.leadingTrim === 'CAP_HEIGHT' ? { leadingTrim: 'CAP_HEIGHT' as const } : {}),
    ...(node.hangingPunctuation ? { hangingPunctuation: true as const } : {}),
    ...(node.hangingList ? { hangingList: true as const } : {}),
  }
}

/** CSS color of the first visible SOLID paint in a paints array (fill/stroke) — `undefined` when
 * there's no solid paint (empty, gradient, image), so callers can fall back. */
function firstSolidCss(paints: unknown): string | undefined {
  if (!Array.isArray(paints)) return undefined
  const solid = paints.find((p) => p?.type === 'SOLID' && p.visible !== false) as { color?: RGB; opacity?: number } | undefined
  if (!solid?.color) return undefined
  return rgbaToCss(solid.opacity != null && solid.opacity < 1 ? { ...solid.color, a: solid.opacity } : solid.color)
}

/** `stroke`/`stroke-width` attributes for the arc SVG, when the ellipse carries a visible solid
 * stroke — an empty string otherwise (no stroke to draw). */
function arcStrokeAttrs(node: SceneNode): string {
  const stroke = firstSolidCss((node as { strokes?: unknown }).strokes)
  if (!stroke) return ''
  const weight = (node as { strokeWeight?: number | symbol }).strokeWeight
  const width = typeof weight === 'number' ? weight : 1
  return ` stroke="${stroke}" stroke-width="${width}"`
}

/** Inline SVG for an ellipse with a non-default `arcData` (arc/pie/ring) — a partial ellipse is
 * not a `border-radius: 50%` box, so it's drawn from the arc `<path>` (`geometry.ts`) using the
 * shape's own solid fill/stroke. `undefined` for a full-circle ellipse or any non-ellipse. */
function arcInlineSvg(node: SceneNode): string | undefined {
  if (node.type !== 'ELLIPSE') return undefined
  const arc = (node as EllipseNode).arcData
  if (!arc || isDefaultArc(arc)) return undefined
  const width = Math.round(node.width * 100) / 100
  const height = Math.round(node.height * 100) / 100
  const d = ellipseArcPath(arc, node.width, node.height)
  const fill = firstSolidCss((node as { fills?: unknown }).fills) ?? 'currentColor'
  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${d}" fill="${fill}"${arcStrokeAttrs(node)}/></svg>`
  )
}

/** A leaf graphic — any non-container shape (RECTANGLE, ELLIPSE, POLYGON, STAR, LINE, VECTOR,
 * BOOLEAN_OPERATION, TEXT_PATH, and FigJam decoration leaves). A video fill → an `.mp4` asset, an
 * image fill → a raster asset, otherwise a vector destined for SVG (inline or file). Shapes with
 * no fill (a LINE, an unfilled ellipse) still export as SVG so their stroke survives. A shape whose
 * stroke/geometry has no CSS mapping (`needsSvg` — arcs, dashes, decorative caps, brush strokes)
 * is forced down the vector/SVG path even when it has an image fill, so those properties aren't lost. */
async function serializeShape(node: SceneNode, isGridChild: boolean): Promise<IrImageNode | IrVectorNode> {
  const base = { ...baseProps(node as Parameters<typeof baseProps>[0], isGridChild), ...(await readStyleRefs(node)) }
  const filled = node as unknown as { fills?: MinimalFillsMixin['fills'] }
  // A video layer (VideoPaint fill) → renderAssetLeaf turns the .mp4 assetSrc into a <video>.
  if (hasVideoFill(filled)) {
    const vfill = videoFill(filled)
    return {
      ...base,
      type: 'image',
      imageHash: null,
      assetSrc: `img/${videoFilename(node.id, node.name)}`,
      posterSrc: `img/${videoPosterFilename(node.id, node.name)}`,
      videoScaleMode: vfill?.scaleMode,
    }
  }
  // M11: a FigJam MediaNode (mediaData instead of fills) — treat as a video-capable media element.
  // The asset pass exports it as MP4 (video) or PNG (image); the emitter renders a <video> or <img>
  // based on whether the MP4 export succeeded. Here we emit the video path (poster + mp4 assetSrc)
  // since the MediaNode is most commonly video, and the asset pass falls back to PNG if MP4 fails.
  if (hasMediaData(node)) {
    return {
      ...base,
      type: 'image',
      imageHash: null,
      assetSrc: `img/${videoFilename(node.id, node.name)}`,
      posterSrc: `img/${videoPosterFilename(node.id, node.name)}`,
    }
  }
  const forceSvg = needsSvg(node as Parameters<typeof needsSvg>[0])
  const imageHash = imageFillHash(filled)
  if (imageHash !== null && !forceSvg) {
    // The asset pass exports this node at img/<rasterFilename> — reference the same file, unless
    // the fill's actual bytes are a non-PNG format (GIF/JPG/WEBP): those ship as the raw fill
    // bytes (M5) so e.g. an animated GIF fill doesn't get silently frozen into a static PNG render.
    const imageRotation = imageFillRotation(filled)
    const format = await imageFillFormat(imageHash)
    const assetSrc =
      format === 'png'
        ? `img/${rasterFilename(node.id, node.name, 'png', 1)}`
        : `img/${imageFillLeafFilename(node.id, node.name, format)}`
    return {
      ...base,
      type: 'image',
      imageHash,
      assetSrc,
      ...(imageRotation ? { imageRotation } : {}),
    }
  }
  const arc = arcInlineSvg(node)
  return { ...base, type: 'vector', ...(arc ? { inlineSvg: arc } : {}) }
}

/** Kept for backward-compatible imports; RECTANGLE routes through `serializeShape` now. */
export async function serializeRectangle(node: RectangleNode, isGridChild = false): Promise<IrImageNode | IrVectorNode> {
  return serializeShape(node, isGridChild)
}

export async function serializeVector(node: VectorNode, isGridChild = false): Promise<IrVectorNode> {
  return (await serializeShape(node, isGridChild)) as IrVectorNode
}

/** A container without its own auto-layout metadata (SECTION, COMPONENT_SET, TRANSFORM_GROUP, or
 * any future/FigJam node that has children) — laid out absolutely, walking its children so nothing
 * inside is dropped. `normalizeLayout` handles a present `layoutMode` and otherwise falls back to
 * absolute, so a COMPONENT_SET with Auto Layout is still honored. */
async function serializeGenericContainer(node: SceneNode & ChildrenMixin, isGridChild: boolean): Promise<IrContainerNode> {
  const hasAutoLayout = 'layoutMode' in node
  const { layout, warnings } = hasAutoLayout
    ? normalizeLayout(node as unknown as AutoLayoutContainer)
    : { layout: { kind: 'absolute' as const }, warnings: [] as string[] }
  return {
    ...baseProps(node as Parameters<typeof baseProps>[0], isGridChild),
    ...(await containerBackgroundImage(node as { id: string; name: string; fills?: MinimalFillsMixin['fills'] })),
    ...(await readStyleRefs(node)),
    type: 'container',
    layout,
    component: null,
    warnings,
    children: await serializeChildren(node, isManualGridParent(node as { layoutMode?: string; gridItemsPositioning?: string })),
  }
}

export async function serializeComponent(node: ComponentNode, isGridChild = false): Promise<IrContainerNode> {
  const { layout, warnings: layoutWarnings } = normalizeLayout(node)
  const { component, warnings: componentWarnings } = normalizeComponentDef(node)
  return {
    ...baseProps(node, isGridChild),
    ...(await containerBackgroundImage(node)),
    ...(await readStyleRefs(node)),
    ...fixedChildrenCount(node),
    type: 'container',
    layout,
    component,
    warnings: [...layoutWarnings, ...componentWarnings],
    children: await serializeChildren(node, isManualGridParent(node)),
  }
}

export async function serializeInstance(node: InstanceNode, isGridChild = false): Promise<IrInstanceRefNode> {
  const mainComponent = await node.getMainComponentAsync()
  // The main component's SET name (or its own name) — lets the page emitter recognize an inline
  // instance as a Bootstrap component even when the main definition lives outside the export set
  // (so no partial exists to carry the recognition). Parent access is wrapped: under dynamic-page
  // an unloaded set parent can throw.
  let componentSetName: string | null = null
  try {
    componentSetName = mainComponent
      ? mainComponent.parent?.type === 'COMPONENT_SET'
        ? mainComponent.parent.name
        : mainComponent.name
      : null
  } catch {
    componentSetName = mainComponent?.name ?? null
  }
  const { layout, warnings } = normalizeLayout(node)
  // Interactive-component prototype reactions (hover/press/click → CHANGE_TO another variant) are
  // defined on the main component's VARIANT — and the plugin API does NOT surface them on the
  // instance (unlike the REST API, which inlines the inherited reactions). So read them off the
  // main component too, or every interactive component exports as a dead element. An instance-level
  // reaction override still wins; a component with no reactions yields nothing (no regression).
  // Both own and inherited interactions diff from the CURRENT VARIANT (mainComponent.id), never the
  // instance: a CHANGE_TO always swaps variants, and Figma preserves instance overrides (cornerRadius…)
  // across the swap — diffing the instance against a raw variant would revert those overrides in the
  // state rule. (Confirmed live: the plugin API surfaces interactive-component reactions on the
  // instance itself, so the own-reactions path is the common one for kit buttons.)
  const ownReactions = { ...readNavigateReaction(node), ...readInteractions(node, mainComponent?.id), ...readOverlays(node) }
  const inheritedReactions = mainComponent
    ? { ...readNavigateReaction(mainComponent), ...readInteractions(mainComponent, mainComponent.id), ...readOverlays(mainComponent) }
    : {}
  const navigate = ownReactions.navigate ?? inheritedReactions.navigate
  const overlays = ownReactions.overlays ?? inheritedReactions.overlays
  let interactions = ownReactions.interactions ?? inheritedReactions.interactions
  // P2e: the default variant only wires ON_HOVER (default→hover); the ON_PRESS link (hover→press)
  // lives one hop away on the hover variant. Follow the chain and append a synthesized ON_PRESS so
  // the pressed state exports as `:active` — unless an ON_PRESS is already present (an instance- or
  // default-level ON_PRESS override wins; no double-capture, and no chain lookup in that case).
  if (interactions && !interactions.some((i) => i.trigger === 'ON_PRESS')) {
    const hover = interactions.find((i) => i.trigger === 'ON_HOVER')
    const press = hover ? await readChainedPressInteraction(hover) : null
    if (press) interactions = [...interactions, press]
  }
  const reactions = {
    ...(navigate ? { navigate } : {}),
    ...(interactions ? { interactions } : {}),
    ...(overlays ? { overlays } : {}),
  }
  return {
    ...baseProps(node, isGridChild),
    ...(await containerBackgroundImage(node)),
    ...(await readStyleRefs(node)),
    ...fixedChildrenCount(node),
    ...reactions,
    type: 'instance-ref',
    layout,
    warnings,
    componentId: mainComponent?.id ?? null,
    componentKey: mainComponent?.key ?? null,
    componentSetName,
    componentProperties: normalizeComponentProperties(readComponentProperties(node)),
    ...(restyledInPlace(node) ? { restyled: true as const } : {}),
    children: await serializeChildren(node, isManualGridParent(node)),
  }
}

/** What an instance can say through its component: the text of a layer it holds. Everything else
 * it overrides — a fill, a font, a size, an auto-resize — has nowhere to go in
 * `<Component text="…" />`.
 *
 * `componentProperties` is on this list for the instance ITSELF (which travels as props and is
 * skipped before this is asked) and deliberately not for a DESCENDANT instance: the payment tile
 * picks Mastercard on an icon three levels down, and the component that holds it exposes no such
 * prop — rendered as that component, the screen came out showing Visa. */
const PROPERTY_FIELDS = new Set(['characters'])

/** Whether this instance was changed in ways its component cannot be asked for. */
function restyledInPlace(node: InstanceNode): boolean {
  try {
    const own = node.id
    const prefix = own.startsWith('I') ? `${own};` : `I${own};`
    return node.overrides.some(
      (entry) =>
        entry.id !== own &&
        entry.id.startsWith(prefix) &&
        entry.overriddenFields.some((field) => !PROPERTY_FIELDS.has(field as string))
    )
  } catch {
    // A variant, a detached thing, a node Figma will not answer for: not knowing is not a reason
    // to claim it was restyled.
    return false
  }
}

/** A designer-marked graphic (utils/graphics) collapses to an asset leaf: no recursion into its
 * vector tree, so its internals are never linted or serialized. The asset pass exports every
 * format/scale the designer configured in Figma's Export panel; `assetSrc` names the primary file
 * (SVG > 1x raster > any raster, defaulting to a 1x PNG) the template's `<img>` references. */
async function serializeExportedGraphic(
  node: SceneNode,
  isGridChild: boolean,
  settingsOverride?: ReadonlyArray<DesignerExportSetting>
): Promise<IrImageNode | IrVectorNode> {
  const base = { ...baseProps(node as Parameters<typeof baseProps>[0], isGridChild), ...(await readStyleRefs(node)) }
  const settings = settingsOverride ?? (((node as ExportMixin).exportSettings ?? []) as ReadonlyArray<DesignerExportSetting>)
  const assetSrc = `img/${primaryDesignerAssetFilename(node.id, node.name, settings)}`
  if (primaryDesignerSetting(settings)?.format === 'SVG') {
    return { ...base, type: 'vector', assetSrc }
  }
  return { ...base, type: 'image', imageHash: null, assetSrc }
}

/** Leaf shape types that serialize as a single graphic (image/vector/video asset). */
const SHAPE_TYPES = new Set<string>([
  'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION', 'TEXT_PATH',
  // FigJam decoration leaves — never appear in a design file, but render as graphics if they do.
  'STAMP', 'HIGHLIGHT', 'WASHI_TAPE', 'MEDIA',
  // FigJam content nodes + connector (docs/1TO1-FIDELITY.md M6). The docs make richer HTML
  // achievable for some (semantic <table>, <pre><code>, link/embed cards) but a graphic export —
  // exportAsync captures the rendered node, connector line and label included — is the honest
  // minimum bar: none of these is ever dropped. Routed here (ahead of the `children`/`fills`
  // fallbacks) so a `cellAt`-based TABLE or a fill-less CODE_BLOCK/CONNECTOR still serializes.
  'STICKY', 'SHAPE_WITH_TEXT', 'CODE_BLOCK', 'TABLE', 'TABLE_CELL', 'EMBED', 'LINK_UNFURL', 'CONNECTOR',
])

/**
 * Dispatches a Figma scene node to its serializer. Every node type documented at
 * developers.figma.com/docs/plugins/api/nodes is handled: design containers and text get their
 * dedicated serializers; every shape becomes a graphic asset; SECTION/COMPONENT_SET/TRANSFORM_GROUP
 * and any other node carrying `children` (including Figma Slides SLIDE/SLIDE_ROW/SLIDE_GRID/
 * INTERACTIVE_SLIDE_ELEMENT) become absolute containers; SLICE (an export-only helper) is
 * intentionally skipped. A truly leaf node of an unknown type still renders as a graphic if it
 * has geometry, and only a childless, fill-less unknown (WIDGET, SLOT, Slides scaffolds) is
 * dropped — with a warning, never silently.
 */
export async function serializeNode(node: SceneNode, isGridChild = false): Promise<IrNode | null> {
  // A node deleted mid-export reports `removed === true`; reading any other property then throws
  // ("The node with id … does not exist"). Bail before touching `visible`/`type`/anything else so
  // one stale entry in a children array can't abort the whole export (docs M6, RemovedNode guard).
  if ((node as { removed?: boolean }).removed) return null
  if (node.visible === false) return null
  // A node with export settings is an opaque graphic — emit it as one asset, don't walk its tree.
  // For an INSTANCE without its own settings, the master component's Export panel counts
  // (`resolveExportSettings`) — Figma never mirrors the master root's settings onto instances.
  // EXCEPTION: a video fill wins over the convention. Export settings on a video layer (usually a
  // leftover from a Dev Mode → Assets → Download attempt) can only produce stills — routing the
  // node to serializeExportedGraphic would silently freeze the <video> into an <img>.
  const exportSettings = await resolveExportSettings(node as unknown as ExportMarkedInstanceNode)
  if (exportSettings.length > 0 && !hasVideoFill(node as unknown as { fills?: MinimalFillsMixin['fills'] })) {
    return serializeExportedGraphic(node, isGridChild, exportSettings as ReadonlyArray<DesignerExportSetting>)
  }

  switch (node.type) {
    case 'FRAME':
      return serializeFrame(node, isGridChild)
    case 'COMPONENT':
      return serializeComponent(node, isGridChild)
    case 'INSTANCE':
      return serializeInstance(node, isGridChild)
    case 'TEXT':
      return serializeText(node, isGridChild)
    case 'GROUP':
    case 'TRANSFORM_GROUP':
      return serializeGroup(node as GroupNode, isGridChild)
    case 'SLICE':
      return null // export-region helper — never rendered
  }

  if (SHAPE_TYPES.has(node.type)) return serializeShape(node, isGridChild)
  if ('children' in node) return serializeGenericContainer(node as SceneNode & ChildrenMixin, isGridChild)
  // A leaf of an unhandled type: render it as a graphic if it has geometry, else drop with a note.
  if ('fills' in node) return serializeShape(node, isGridChild)
  console.warn(`[ir] node type ${node.type} ("${node.name}") has no visual representation — skipped`)
  return null
}
