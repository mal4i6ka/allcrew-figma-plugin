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

export interface DiffablePaint {
  readonly type: string
  readonly color?: { readonly r: number; readonly g: number; readonly b: number }
  readonly opacity?: number
}

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
  readonly cornerRadius?: number | Mixed
  readonly topLeftRadius?: number
  readonly topRightRadius?: number
  readonly bottomRightRadius?: number
  readonly bottomLeftRadius?: number
  readonly fills?: readonly DiffablePaint[] | Mixed
  readonly children?: readonly DiffableNode[]
}

/** `name#dupIndex` segments joined by `/` — see `match-layers.ts` for how duplicates are indexed. */
export type NodePath = string
