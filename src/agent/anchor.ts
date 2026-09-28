/**
 * Agent listener — where a pin goes.
 *
 * Figma's comment API pins a comment with a `FrameOffset`: `{ node_id, node_offset: {x, y} }`,
 * where the offset is measured from the TOP-LEFT OF THE FRAME, and `node_id` is documented as
 * "unique id specifying the frame". Neither half is something an agent has.
 *
 * What an agent has is a node id out of `design.ir` or `node.find` — usually a deep one, a label
 * six levels inside a card inside a section. Its own `position` in the IR is relative to its
 * PARENT, which is not the frame; `design.measure` gives boxes relative to whatever root was
 * measured, which is also not the frame. Composing either into a frame offset means walking
 * ancestors and summing transforms, and getting it wrong puts the pin somewhere plausible and
 * wrong — a comment attached to the right layer, pointing at the wrong pixel.
 *
 * So this is the aiming primitive: hand it a node, get back the frame that a pin must be
 * addressed to and the offset within it, plus the nine points of the node's own box so "the
 * top-right corner of the badge" is a word rather than arithmetic.
 *
 * It reads `absoluteBoundingBox` rather than accumulating `relativeTransform` up the tree. That
 * is deliberate: the accumulated version has to reproduce Figma's own rotation and scaling
 * composition exactly, and it silently disagrees the first time a group is rotated.
 * `absoluteBoundingBox` is Figma's own answer to "where is this on the canvas", already
 * accounting for every transform above it, and the subtraction of two absolute boxes is exact.
 */

/* --------------------------------------------------------------------- types */

/** Where on the node's own box the pin sits. Nine named points beat a pair of numbers an agent
 * has to derive, and `center` is what almost every annotation wants. */
export type AnchorPoint =
  | 'center'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

export const ANCHOR_POINTS: readonly AnchorPoint[] = [
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]

export function isAnchorPoint(value: unknown): value is AnchorPoint {
  return typeof value === 'string' && (ANCHOR_POINTS as readonly string[]).includes(value)
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface AnchorResult {
  node: { id: string; name: string; type: string }
  /** The frame a pin has to be addressed to: the nearest ancestor Figma treats as a frame, or
   * the node itself when it is one. `null` when the node sits on the canvas under no frame at
   * all — then a pin must use absolute canvas coordinates instead, and `absolute` is the answer. */
  frame: { id: string; name: string; type: string; box: Box } | null
  /** The node's own box in absolute canvas coordinates. This is what a `Vector` pin uses. */
  absolute: Box
  /** The node's box expressed from the frame's top-left — the coordinate space `node_offset`
   * is in. Absent when there is no enclosing frame. */
  inFrame?: Box
  /** Every named point, already in `node_offset` space when there is a frame and in absolute
   * canvas space when there is not. This is the value that goes straight into a pin. */
  offsets: Readonly<Record<AnchorPoint, { x: number; y: number }>>
  /** How many levels up the frame is. 0 means the node IS the frame. Reported because a pin
   * addressed to a distant ancestor is worth noticing: the comment will move with that frame,
   * not with the layer. */
  depth: number
  /** True when the node's own box is rotated, so its axis-aligned bounding box is larger than
   * the layer itself and a corner anchor lands outside the visible shape. Named rather than
   * silently corrected: there is no honest single point for "the top-left of a rotated label",
   * and `center` is still exact. */
  rotated?: true
}

/* ----------------------------------------------------------------- the walk */

/**
 * Node types Figma pins a comment to.
 *
 * `FrameOffset.node_id` is documented as a frame, and these are the types that behave as one:
 * a frame, a component and its instances (which are frames), and a section. A GROUP is
 * deliberately absent — it has no fill, no clip and no independent coordinate space in the way a
 * frame does, and a pin addressed to one is accepted but tracks the group's bounding box, which
 * moves whenever any child moves. Skipping past it lands the pin on something stable.
 */
const PINNABLE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'])

/**
 * Whether an id can be a pin target at all.
 *
 * A layer inside an instance carries a COMPOSITE id — `I4658:161436;823:99713` — and **Figma's
 * comment API refuses one**: posting with that as `node_id` answers `400 "Comment couldn't be
 * saved"`, twice in the same second, while the enclosing real frame is accepted. Measured
 * against the live API, because nothing in the docs says so.
 *
 * It matters because a frame inside an instance is extremely common — a `Header` instance whose
 * main component is built out of frames — and the walk would otherwise stop at the first one and
 * produce a pin Figma throws away. So the walk keeps going until it reaches a frame with a real
 * id, and the offset is measured from THAT frame. Subtracting two absolute boxes means the
 * arithmetic does not care how far up it had to go.
 */
function pinnableId(id: string): boolean {
  return typeof id === 'string' && !id.includes(';')
}

/** Enough of a `SceneNode` to aim at. Structural so a fixture works and so node types Figma
 * keeps adding need no branch here. */
export interface AnchorSource {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly absoluteBoundingBox?: Box | null
  readonly rotation?: number
  readonly parent?: AnchorSource | null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function pointsOf(box: Box): Record<AnchorPoint, { x: number; y: number }> {
  const left = box.x
  const right = box.x + box.width
  const top = box.y
  const bottom = box.y + box.height
  const midX = box.x + box.width / 2
  const midY = box.y + box.height / 2
  const at = (x: number, y: number) => ({ x: round(x), y: round(y) })
  return {
    center: at(midX, midY),
    'top-left': at(left, top),
    top: at(midX, top),
    'top-right': at(right, top),
    left: at(left, midY),
    right: at(right, midY),
    'bottom-left': at(left, bottom),
    bottom: at(midX, bottom),
    'bottom-right': at(right, bottom),
  }
}

function boxOf(node: AnchorSource): Box | null {
  const box = node.absoluteBoundingBox
  if (!box || typeof box.x !== 'number' || typeof box.y !== 'number') return null
  if (typeof box.width !== 'number' || typeof box.height !== 'number') return null
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/**
 * The frame a pin on this node must be addressed to, and how far up it is.
 *
 * The node itself counts when it is a frame: pinning a comment to a screen means pinning it to
 * that screen, not to the page behind it.
 */
export function enclosingFrame(node: AnchorSource): { frame: AnchorSource; depth: number } | null {
  let current: AnchorSource | null = node
  let depth = 0
  while (current) {
    // A PAGE is not a frame and is where the walk stops: above it there is no coordinate space
    // to be relative to, which is exactly the case a `Vector` pin exists for.
    if (current.type === 'PAGE' || current.type === 'DOCUMENT') return null
    if (PINNABLE.has(current.type) && pinnableId(current.id) && boxOf(current)) {
      return { frame: current, depth }
    }
    current = current.parent ?? null
    depth += 1
  }
  return null
}

/**
 * Everything needed to aim a pin at one node.
 *
 * Throws only when the node has no box at all — a node Figma cannot place has no point to pin
 * to, and inventing `{0, 0}` would put the comment in the corner of the frame and look like a
 * bug in the design rather than a gap in the answer.
 */
export function anchorOf(node: AnchorSource): AnchorResult {
  const absolute = boxOf(node)
  if (!absolute) {
    throw new Error(
      `"${node.name}" (${node.type}) has no absoluteBoundingBox — it cannot be placed, so there is no point to pin to`
    )
  }

  const enclosing = enclosingFrame(node)
  const rotated = typeof node.rotation === 'number' && Math.abs(round(node.rotation)) > 0.01

  if (!enclosing) {
    return {
      node: { id: node.id, name: node.name, type: node.type },
      frame: null,
      absolute: roundBox(absolute),
      offsets: pointsOf(absolute),
      depth: 0,
      ...(rotated ? { rotated: true } : {}),
    }
  }

  const frameBox = boxOf(enclosing.frame) as Box
  // Two absolute boxes, subtracted. Exact by construction, and it needs no knowledge of how
  // Figma composed the transforms that produced either one.
  const inFrame: Box = {
    x: absolute.x - frameBox.x,
    y: absolute.y - frameBox.y,
    width: absolute.width,
    height: absolute.height,
  }

  return {
    node: { id: node.id, name: node.name, type: node.type },
    frame: {
      id: enclosing.frame.id,
      name: enclosing.frame.name,
      type: enclosing.frame.type,
      box: roundBox(frameBox),
    },
    absolute: roundBox(absolute),
    inFrame: roundBox(inFrame),
    offsets: pointsOf(inFrame),
    depth: enclosing.depth,
    ...(rotated ? { rotated: true } : {}),
  }
}

function roundBox(box: Box): Box {
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

/**
 * The pin a comment write should carry for this node and anchor — Figma's own `client_meta`
 * shape, ready to POST.
 *
 * `FrameOffset` when there is an enclosing frame, because a pin addressed that way MOVES WITH
 * THE FRAME: the designer drags the screen across the canvas and the comment stays on the
 * button. An absolute `Vector` does not, which is why it is the fallback and not the default.
 */
export function pinFor(
  anchor: AnchorResult,
  point: AnchorPoint = 'center'
): { node_id: string; node_offset: { x: number; y: number } } | { x: number; y: number } {
  const offset = anchor.offsets[point]
  if (!anchor.frame) return { x: offset.x, y: offset.y }
  return { node_id: anchor.frame.id, node_offset: { x: offset.x, y: offset.y } }
}
