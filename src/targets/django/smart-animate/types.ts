/**
 * Shared types for Smart Animate → CSS diff (T5.6, docs/research/05-smart-animate-css-diff.md
 * §1). `DiffableNode` mirrors only the SceneNode fields `match-layers.ts`/`diff-properties.ts`
 * actually read — kept independent of `@figma/plugin-typings` so the diff algorithm is testable
 * with plain fixtures and reusable outside the plugin sandbox (same rationale as
 * `src/motion/types.ts`'s `MotionTrack`). `MIXED` stands in for `figma.mixed`: callers reading
 * real nodes must translate `figma.mixed` to this sentinel before diffing.
 */

export const MIXED = Symbol('smart-animate-mixed')
export type Mixed = typeof MIXED

/** Figma's `Transform` — a 2x3 affine matrix `[[a, b, tx], [c, d, ty]]` mapping paint space to
 * node space. Kept as a plain tuple (not imported from `@figma/plugin-typings`) for the same
 * reason as the rest of this module. */
export type DiffableTransform = readonly [readonly [number, number, number], readonly [number, number, number]]

export interface DiffableColorStop {
  readonly position: number
  readonly color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
}

/** A paint stack (`fills`/`strokes`) follows Figma's own layer convention — same as
 * `SceneNode.children` being back-to-front — index 0 is painted first (bottom-most), the last
 * index paints last (topmost, and so the one that actually shows through if it's opaque). */
export interface DiffablePaint {
  readonly type: string
  readonly color?: { readonly r: number; readonly g: number; readonly b: number }
  readonly opacity?: number
  /** Paints default to visible; `false` means Figma renders (and Smart Animate interpolates)
   * as though this layer of the stack were absent. */
  readonly visible?: boolean
  readonly blendMode?: string
  /** Present on `GRADIENT_*` paints — without these a gradient is indistinguishable from a
   * SOLID paint with no color, so the diff can't tell "recolor" apart from "replace with
   * gradient". */
  readonly gradientStops?: readonly DiffableColorStop[]
  readonly gradientTransform?: DiffableTransform
  /** Present on `IMAGE` paints. `imageHash` alone is not a URL — the emitter has no way to
   * turn it into CSS, so a change touching it is reported but deliberately left unexpressed. */
  readonly imageHash?: string | null
  readonly scaleMode?: string
}

/** The destination-only, emitter-facing subset of an `IMAGE` paint's fields — `imageHash`
 * narrowed to a definite `string` once a caller has already filtered out paints Figma left
 * mid-edit with `imageHash: null` (see `DiffablePaint.imageHash`'s note). Exists so a
 * `background` `PropertyChange` can carry "here is an actual photo to cross-fade in" without
 * making every other `DiffablePaint` consumer (which never cares about `imageHash`) handle a
 * value that might be absent. */
export interface DiffableImagePaint {
  readonly imageHash: string
  readonly scaleMode?: string
  readonly opacity?: number
}

/** Mirrors Figma's `Effect` union down to the fields `diff-properties.ts` composes into
 * `box-shadow`/`filter`/`backdrop-filter` — shadows read `color`/`offset`/`spread`, blurs read
 * only `radius`. */
export interface DiffableEffect {
  readonly type: string
  readonly color?: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
  readonly offset?: { readonly x: number; readonly y: number }
  readonly radius: number
  readonly spread?: number
  /** Effects default to visible; `false` means Figma renders as though this effect weren't
   * in the list at all. */
  readonly visible?: boolean
}

export interface DiffableLetterSpacing {
  readonly value: number
  readonly unit: 'PIXELS' | 'PERCENT'
}

export type DiffableLineHeight = { readonly value: number; readonly unit: 'PIXELS' | 'PERCENT' } | { readonly unit: 'AUTO' }

export interface DiffableNode {
  /** Originating node id — unused by the diff itself, but carried so a matched pair can be traced
   * back to its source node (e.g. M4b's breakpoint matcher keys CSS classes by the widest frame's
   * node id). Optional so existing fixtures need no id. */
  readonly id?: string
  readonly type: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation?: number
  readonly opacity?: number
  /** `false` means Figma dissolves the layer out/in instead of interpolating anything else on
   * it — Smart Animate treats a visibility flip as its own step, not a `display` toggle. */
  readonly visible?: boolean
  readonly blendMode?: string
  readonly cornerRadius?: number | Mixed
  readonly topLeftRadius?: number
  readonly topRightRadius?: number
  readonly bottomRightRadius?: number
  readonly bottomLeftRadius?: number
  readonly fills?: readonly DiffablePaint[] | Mixed
  readonly strokes?: readonly DiffablePaint[] | Mixed
  readonly strokeWeight?: number | Mixed
  readonly strokeAlign?: string
  readonly effects?: readonly DiffableEffect[]
  /** Auto-layout padding — undefined on non-auto-layout frames, exactly like Figma's own
   * `paddingTop` etc., which throw rather than read on a frame without `layoutMode` set. */
  readonly paddingTop?: number
  readonly paddingRight?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly itemSpacing?: number
  readonly counterAxisSpacing?: number | null
  readonly fontSize?: number | Mixed
  readonly fontWeight?: number | Mixed
  readonly letterSpacing?: DiffableLetterSpacing | Mixed
  readonly lineHeight?: DiffableLineHeight | Mixed
  readonly characters?: string
  readonly children?: readonly DiffableNode[]
}

/** `name#dupIndex` segments joined by `/` — see `match-layers.ts` for how duplicates are indexed. */
export type NodePath = string
