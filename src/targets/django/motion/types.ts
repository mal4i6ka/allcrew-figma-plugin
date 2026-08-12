/**
 * Types for the Motion Beta-adapter (T5.2): a normalized snapshot of `node.animations` /
 * `node.timelines` / `node.animationStyles` / `node.manualKeyframeTracks` — the Motion
 * Plugin API added in Update 127 (June 2026, see docs/research/02-figma-motion-prototyping-api.md).
 * The API is Beta ("subject to change"), so every field here mirrors only what
 * `beta-adapter.ts` actually reads, not the full upstream shape.
 */

/** The complete `KeyframePropertyFieldName` union (30 values) — every scalar property Motion can keyframe. */
export const MOTION_PROPERTY_ALLOWLIST: readonly KeyframePropertyFieldName[] = [
  'TRANSLATION_X',
  'TRANSLATION_Y',
  'TRANSLATION_XY',
  'ROTATION',
  'SCALE_X',
  'SCALE_Y',
  'SCALE_XY',
  'OPACITY',
  'WIDTH',
  'HEIGHT',
  'CORNER_RADIUS',
  'RECTANGLE_TOP_LEFT_CORNER_RADIUS',
  'RECTANGLE_TOP_RIGHT_CORNER_RADIUS',
  'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS',
  'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS',
  'STROKE_WEIGHT',
  'BORDER_TOP_WEIGHT',
  'BORDER_BOTTOM_WEIGHT',
  'BORDER_LEFT_WEIGHT',
  'BORDER_RIGHT_WEIGHT',
  'STACK_SPACING',
  'STACK_COUNTER_SPACING',
  'STACK_PADDING_LEFT',
  'STACK_PADDING_TOP',
  'STACK_PADDING_RIGHT',
  'STACK_PADDING_BOTTOM',
  'GRID_ROW_GAP',
  'GRID_COLUMN_GAP',
  'PATH_TRIM_START',
  'PATH_TRIM_END',
] as const

export interface MotionKeyframe {
  readonly id: string
  readonly timelinePosition: number
  readonly easing: MotionEasing | VariableAlias
  readonly value: KeyframeValue
}

/** One allowlisted property's full manual keyframe track, flattened out of `manualKeyframeTracks`. */
export interface MotionTrack {
  readonly field: KeyframePropertyFieldName
  readonly baseValue: KeyframeValue
  readonly timelineDuration: number
  readonly keyframes: readonly MotionKeyframe[]
}

export type MotionTimeline = Timeline

export type MotionAnimationStyle = AppliedAnimationStyle

export interface MotionSnapshot {
  readonly animationStyles: readonly MotionAnimationStyle[]
  readonly timelines: readonly MotionTimeline[]
  readonly tracks: readonly MotionTrack[]
}
