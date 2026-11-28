/**
 * Types for the Motion Beta-adapter (T5.2): a normalized snapshot of `node.animations` /
 * `node.timelines` / `node.animationStyles` / `node.manualKeyframeTracks` — the Motion
 * Plugin API added in Update 127 (June 2026, see docs/research/02-figma-motion-prototyping-api.md).
 * The API is Beta ("subject to change"), so every field here mirrors only what
 * `beta-adapter.ts` actually reads, not the full upstream shape.
 */

/**
 * The complete `KeyframePropertyFieldName` union (35 values) — every scalar property Motion can
 * keyframe. The last five arrived with 3D transforms (typings 1.143.0, beta): the rotations are in
 * degrees, `TRANSFORM_3D_TRANSLATION_Z` and `SCENE_3D_PERSPECTIVE` in pixels, all `FLOAT`.
 */
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
  'TRANSFORM_3D_TRANSLATION_Z',
  'TRANSFORM_3D_ROTATION_X',
  'TRANSFORM_3D_ROTATION_Y',
  'TRANSFORM_3D_ROTATION_Z',
  'SCENE_3D_PERSPECTIVE',
] as const

/**
 * The four numbers of a `FIXED_ORDER` 3D transform as they stand outside the timeline. A track
 * animates one of them; the composite `transform` an emitter writes needs the other three too.
 */
export interface MotionStaticTransform3d {
  readonly translateZ: number
  readonly rotateX: number
  readonly rotateY: number
  readonly rotateZ: number
}

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

/**
 * One applied animation style. Figma's own carry their duration and settings; a custom one —
 * `type: 'CUSTOM'` — names a style this file owns and carries only its timeline offset, because
 * the animations and their timing live in the style itself.
 */
export type MotionAnimationStyle = AppliedAnimationStyle

export interface MotionSnapshot {
  readonly animationStyles: readonly MotionAnimationStyle[]
  readonly timelines: readonly MotionTimeline[]
  readonly tracks: readonly MotionTrack[]
  /** The node's own `FIXED_ORDER` transform, when it has one — absent for `NONE` and `FREEFORM`. */
  readonly transform3d?: MotionStaticTransform3d
}
