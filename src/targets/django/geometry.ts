/**
 * Advanced-geometry helpers (M7): the `needsSvg` guard that decides when a shape's stroke or
 * geometry has no faithful CSS mapping (so it must go through the SVG path instead of a plain
 * `border`), and `ellipseArcPath`, the standard superellipse-free arc formula that turns an
 * `EllipseNode.arcData` (arcs, pie slices, rings/donuts) into an SVG `<path d=…>`.
 *
 * Both are pure and Figma-independent — they take duck-typed property bags so unit tests and the
 * IR builder can call them without a live `figma` global.
 */

/** `EllipseNode.arcData` (radians, `innerRadius` 0..1). Full-circle default: `{0, 2π, 0}`. */
export interface ArcData {
  readonly startingAngle: number
  readonly endingAngle: number
  readonly innerRadius: number
}

const TWO_PI = Math.PI * 2

/** Floating-point tolerance for the full-circle default check — Figma stores 2π as a rounded float. */
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-4
}

/** True for the full-circle default (`startingAngle 0`, `endingAngle 2π`, `innerRadius 0`) — an
 * ellipse a plain CSS `border-radius: 50%` box already renders, so it needs no SVG path. */
export function isDefaultArc(arc: ArcData): boolean {
  return approx(arc.startingAngle, 0) && approx(arc.endingAngle, TWO_PI) && approx(arc.innerRadius, 0)
}

/** Rounds to 2 decimals so the path string doesn't carry Figma's float noise. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** A point on an axis-aligned ellipse (centre `cx,cy`, radii `rx,ry`) at `angle` radians. Angles
 * run clockwise from the positive x-axis in Figma's y-down screen space, matching SVG's. */
function polar(cx: number, cy: number, rx: number, ry: number, angle: number): [number, number] {
  return [round(cx + rx * Math.cos(angle)), round(cy + ry * Math.sin(angle))]
}

/**
 * The SVG `<path d>` for a non-default `arcData` in a `width`×`height` box. A zero `innerRadius`
 * yields a pie wedge (`M centre → L start → A → Z`); a positive one yields a ring/donut band (outer
 * arc out, inner arc back). Sweep follows the angle's sign; the large-arc flag is set once the swept
 * angle exceeds π. Angles run clockwise (Figma's convention), so the outer arc uses sweep-flag 1.
 */
export function ellipseArcPath(arc: ArcData, width: number, height: number): string {
  const cx = width / 2
  const cy = height / 2
  const rx = width / 2
  const ry = height / 2
  const delta = arc.endingAngle - arc.startingAngle
  const largeArc = Math.abs(delta) > Math.PI ? 1 : 0
  const sweep = delta >= 0 ? 1 : 0

  const [ox0, oy0] = polar(cx, cy, rx, ry, arc.startingAngle)
  const [ox1, oy1] = polar(cx, cy, rx, ry, arc.endingAngle)

  if (arc.innerRadius <= 0) {
    return `M ${round(cx)} ${round(cy)} L ${ox0} ${oy0} A ${round(rx)} ${round(ry)} 0 ${largeArc} ${sweep} ${ox1} ${oy1} Z`
  }

  const irx = rx * arc.innerRadius
  const iry = ry * arc.innerRadius
  const [ix0, iy0] = polar(cx, cy, irx, iry, arc.startingAngle)
  const [ix1, iy1] = polar(cx, cy, irx, iry, arc.endingAngle)
  // The inner arc retraces the swept angle in the opposite direction to close the band.
  const innerSweep = sweep ? 0 : 1
  return (
    `M ${ox0} ${oy0} A ${round(rx)} ${round(ry)} 0 ${largeArc} ${sweep} ${ox1} ${oy1} ` +
    `L ${ix1} ${iy1} A ${round(irx)} ${round(iry)} 0 ${largeArc} ${innerSweep} ${ix0} ${iy0} Z`
  )
}

/** The default `strokeCap`/`strokeJoin` values a CSS `border` can already represent — a rectangular
 * border has no visible caps and mitred joins, so these never force the SVG path. */
const PLAIN_STROKE_CAPS = new Set<string>(['NONE', 'ROUND', 'SQUARE'])

function isMixed(value: unknown): boolean {
  return typeof value === 'symbol'
}

/** Duck-typed subset of a shape node's stroke/geometry properties `needsSvg` inspects. */
export interface StrokeGeometrySource {
  strokeCap?: string | symbol
  strokeJoin?: string | symbol
  dashPattern?: readonly number[]
  strokeMiterLimit?: number
  variableWidthStrokeProperties?: unknown
  complexStrokeProperties?: { type?: string } | null
  arcData?: ArcData
}

/**
 * True when a shape's stroke or geometry can't be reproduced with a CSS `border`/`border-radius`
 * and must go through the SVG path instead (docs/research/08 §3, 09 §9): a decorative `strokeCap`
 * (arrows/diamonds/triangles/circles) or non-mitre `strokeJoin`, a dash pattern, a non-default miter
 * limit, brush/dynamic (`variableWidthStrokeProperties`/`complexStrokeProperties`) or variable-width
 * strokes, a `figma.mixed` cap/join (per-vertex values on a vector network), or a non-full-circle
 * `arcData` (a partial ellipse / ring is not a `border-radius` circle).
 */
export function needsSvg(node: StrokeGeometrySource): boolean {
  if (isMixed(node.strokeCap) || isMixed(node.strokeJoin)) return true
  if (typeof node.strokeCap === 'string' && !PLAIN_STROKE_CAPS.has(node.strokeCap)) return true
  if (typeof node.strokeJoin === 'string' && node.strokeJoin !== 'MITER') return true
  if (Array.isArray(node.dashPattern) && node.dashPattern.length > 0) return true
  if (typeof node.strokeMiterLimit === 'number' && node.strokeMiterLimit !== 4) return true
  if (node.variableWidthStrokeProperties != null) return true
  const complex = node.complexStrokeProperties
  if (complex && (complex.type === 'BRUSH' || complex.type === 'DYNAMIC')) return true
  if (node.arcData && !isDefaultArc(node.arcData)) return true
  return false
}
