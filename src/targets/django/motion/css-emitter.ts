/**
 * Emits a CSS `@keyframes` rule from a Motion track (T5.4, docs/research/06-motion-to-gsap-tokens.md
 * §2.6-2.7): `timelinePosition`/`timelineDuration` become `NN%` offsets, and each keyframe's
 * `easing` — which in Figma describes the segment *entering* that keyframe — is shifted back
 * onto the *previous* percentage block, since CSS `animation-timing-function` set inside a
 * `@keyframes` block governs the segment *leaving* that block. Transform-affecting fields
 * (`TRANSLATION_*`/`SCALE_*`/`ROTATION`) emit the standalone `translate`/`scale`/`rotate`
 * properties rather than a combined `transform`, so independently-tracked axes never clobber
 * each other when their tracks are emitted as separate `@keyframes` rules.
 *
 * The 3D transform tracks (typings 1.143.0, beta) cannot go that way: Figma applies them in one
 * fixed order — translateZ → rotateX → rotateY → rotateZ — and CSS has no standalone property per
 * axis that keeps it. So each 3D track animates a registered custom property of its own
 * (`@property`, which is what makes a custom property interpolate), and the node carries one
 * composite `transform` that reads them in Figma's order. Tracks stay independent, each with its
 * own easing, and none clobbers another. `SCENE_3D_PERSPECTIVE` lives on the container that holds
 * the scene and is plain CSS `perspective` there.
 */

import { easingToCss, perceptualAngularFrequency, resolveSpringBounce, springToCssLinear } from '../easing/index.ts'
import type { MotionKeyframe, MotionStaticTransform3d, MotionTrack } from './types.ts'

type TransformAxisField = 'TRANSLATION_X' | 'TRANSLATION_Y' | 'TRANSLATION_XY' | 'SCALE_X' | 'SCALE_Y' | 'SCALE_XY'

interface TransformMapping {
  readonly cssProperty: 'translate' | 'scale'
  readonly axis: 'x' | 'y' | 'xy'
  readonly unit: string
  /** Value written to the untouched axis when only one axis of this transform is tracked. */
  readonly identity: number
}

const TRANSFORM_FIELD_MAPPING: Record<TransformAxisField, TransformMapping> = {
  TRANSLATION_X: { cssProperty: 'translate', axis: 'x', unit: 'px', identity: 0 },
  TRANSLATION_Y: { cssProperty: 'translate', axis: 'y', unit: 'px', identity: 0 },
  TRANSLATION_XY: { cssProperty: 'translate', axis: 'xy', unit: 'px', identity: 0 },
  SCALE_X: { cssProperty: 'scale', axis: 'x', unit: '', identity: 1 },
  SCALE_Y: { cssProperty: 'scale', axis: 'y', unit: '', identity: 1 },
  SCALE_XY: { cssProperty: 'scale', axis: 'xy', unit: '', identity: 1 },
}

const SCALAR_FIELD_MAPPING: Partial<Record<KeyframePropertyFieldName, { cssProperty: string; unit: string }>> = {
  ROTATION: { cssProperty: 'rotate', unit: 'deg' },
  OPACITY: { cssProperty: 'opacity', unit: '' },
  TRANSFORM_3D_TRANSLATION_Z: { cssProperty: '--motion-translate-z', unit: 'px' },
  TRANSFORM_3D_ROTATION_X: { cssProperty: '--motion-rotate-x', unit: 'deg' },
  TRANSFORM_3D_ROTATION_Y: { cssProperty: '--motion-rotate-y', unit: 'deg' },
  TRANSFORM_3D_ROTATION_Z: { cssProperty: '--motion-rotate-z', unit: 'deg' },
  // On the container itself — the node that holds `scene3d` is the node the track is on.
  SCENE_3D_PERSPECTIVE: { cssProperty: 'perspective', unit: 'px' },
}

type Transform3dField =
  | 'TRANSFORM_3D_TRANSLATION_Z'
  | 'TRANSFORM_3D_ROTATION_X'
  | 'TRANSFORM_3D_ROTATION_Y'
  | 'TRANSFORM_3D_ROTATION_Z'

/** Figma's order, which is also the order the functions are written in the composite `transform`. */
const TRANSFORM_3D_AXES: ReadonlyArray<{
  field: Transform3dField
  fn: string
  key: keyof MotionStaticTransform3d
  syntax: '<length>' | '<angle>'
}> = [
  { field: 'TRANSFORM_3D_TRANSLATION_Z', fn: 'translateZ', key: 'translateZ', syntax: '<length>' },
  { field: 'TRANSFORM_3D_ROTATION_X', fn: 'rotateX', key: 'rotateX', syntax: '<angle>' },
  { field: 'TRANSFORM_3D_ROTATION_Y', fn: 'rotateY', key: 'rotateY', syntax: '<angle>' },
  { field: 'TRANSFORM_3D_ROTATION_Z', fn: 'rotateZ', key: 'rotateZ', syntax: '<angle>' },
]

export function hasTransform3dTrack(tracks: readonly MotionTrack[]): boolean {
  return tracks.some((track) => TRANSFORM_3D_AXES.some((axis) => axis.field === track.field))
}

/**
 * The `@property` rules the 3D tracks animate. Global by nature and identical for every node, so
 * a stylesheet needs them once; `inherits: false` keeps a parent's turn out of its children.
 */
export function emitTransform3dPropertyRules(): string {
  return TRANSFORM_3D_AXES.map((axis) => {
    const mapping = SCALAR_FIELD_MAPPING[axis.field]!
    return `@property ${mapping.cssProperty} { syntax: '${axis.syntax}'; inherits: false; initial-value: 0${mapping.unit}; }`
  }).join('\n')
}

/**
 * The composite `transform` of a node with 3D tracks: a tracked axis reads its custom property,
 * an untracked one is the node's own static number (zero when the caller has no transform to give).
 */
export function formatTransform3dDeclaration(tracks: readonly MotionTrack[], fixed?: MotionStaticTransform3d): string {
  const parts = TRANSFORM_3D_AXES.map((axis) => {
    const mapping = SCALAR_FIELD_MAPPING[axis.field]!
    const tracked = tracks.some((track) => track.field === axis.field)
    return `${axis.fn}(${tracked ? `var(${mapping.cssProperty})` : `${formatNumber(fixed?.[axis.key] ?? 0)}${mapping.unit}`})`
  })
  return `transform: ${parts.join(' ')}`
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function formatNumber(value: number): string {
  return String(round(value, 4))
}

function formatTransformDeclaration(mapping: TransformMapping, value: KeyframeValue): string {
  const { cssProperty, axis, unit, identity } = mapping
  const identityFormatted = `${identity}${unit}`

  if (axis === 'xy') {
    if (value.type !== 'VECTOR') throw new Error(`Expected a VECTOR value for ${cssProperty} (XY), got ${value.type}`)
    return `${cssProperty}: ${formatNumber(value.value.x)}${unit} ${formatNumber(value.value.y)}${unit}`
  }
  if (value.type !== 'FLOAT') throw new Error(`Expected a FLOAT value for ${cssProperty} (${axis}), got ${value.type}`)
  const formatted = `${formatNumber(value.value)}${unit}`
  return axis === 'x' ? `${cssProperty}: ${formatted} ${identityFormatted}` : `${cssProperty}: ${identityFormatted} ${formatted}`
}

function formatDeclaration(field: KeyframePropertyFieldName, value: KeyframeValue): string {
  const transform = TRANSFORM_FIELD_MAPPING[field as TransformAxisField]
  if (transform) return formatTransformDeclaration(transform, value)

  const scalar = SCALAR_FIELD_MAPPING[field]
  if (scalar) {
    if (value.type !== 'FLOAT') throw new Error(`Expected a FLOAT value for ${field}, got ${value.type}`)
    return `${scalar.cssProperty}: ${formatNumber(value.value)}${scalar.unit}`
  }

  throw new Error(`No CSS mapping for Motion field "${field}" — not supported by the CSS keyframes emitter`)
}

function isLiteralEasing(easing: MotionEasing | VariableAlias): easing is MotionEasing {
  return easing.type !== 'VARIABLE_ALIAS'
}

/** Resolves any `MotionEasing` (bezier/named preset or spring) to a CSS timing-function string.
 * A spring is solved at the frequency whose period is `segmentSec`, the length of the keyframe
 * segment it eases: `linear()` is normalized over that segment either way, so a spring solved at
 * a fixed frequency drew the wrong number of bounces into every segment that wasn't ~630 ms. */
function easingToTimingFunctionCss(easing: MotionEasing, segmentSec: number): string {
  try {
    return easingToCss(easing)
  } catch {
    return springToCssLinear(resolveSpringBounce(easing), perceptualAngularFrequency(segmentSec)).easing
  }
}

/** Figma holds `baseValue` until the first keyframe — if that isn't already at `t=0`, synthesize it. */
function withBaseKeyframe(track: MotionTrack): readonly MotionKeyframe[] {
  const first = track.keyframes[0]
  if (first && first.timelinePosition === 0) return track.keyframes
  const base: MotionKeyframe = {
    id: '__base__',
    timelinePosition: 0,
    easing: { type: 'LINEAR' },
    value: track.baseValue,
  }
  return [base, ...track.keyframes]
}

interface PercentFrame {
  readonly percent: number
  readonly declaration: string
  timingFunction?: string
}

function buildPercentFrames(track: MotionTrack): PercentFrame[] {
  const keyframes = withBaseKeyframe(track)
  const duration = track.timelineDuration

  const frames: PercentFrame[] = keyframes.map((keyframe) => ({
    percent: duration > 0 ? (keyframe.timelinePosition / duration) * 100 : 0,
    declaration: formatDeclaration(track.field, keyframe.value),
  }))

  for (let i = 1; i < keyframes.length; i++) {
    const easing = keyframes[i].easing
    if (!isLiteralEasing(easing)) {
      throw new Error(
        `Cannot emit CSS for field "${track.field}": keyframe easing is a variable alias — resolve it before calling the CSS emitter`
      )
    }
    // A segment whose value doesn't change renders identically under any timing function
    // (this is how a HOLD keyframe that repeats the previous value collapses to a no-op shift).
    if (frames[i].declaration === frames[i - 1].declaration) continue
    const segmentSec = keyframes[i].timelinePosition - keyframes[i - 1].timelinePosition
    frames[i - 1].timingFunction = easingToTimingFunctionCss(easing, segmentSec)
  }

  return frames
}

function formatPercent(percent: number): string {
  return `${round(percent, 3)}%`
}

function formatFrame(frame: PercentFrame): string {
  const declarations = [`${frame.declaration};`]
  if (frame.timingFunction) declarations.push(`animation-timing-function: ${frame.timingFunction};`)
  return `  ${formatPercent(frame.percent)} { ${declarations.join(' ')} }`
}

/**
 * Emits a `@keyframes name { ... }` rule for one Motion track. `name` must already be a
 * valid CSS `<custom-ident>` — sanitizing/hashing a Figma node name into one is a concern of
 * the caller that addresses tracks to selectors (docs/research/06-motion-to-gsap-tokens.md §2.5).
 */
export function emitKeyframesRule(name: string, track: MotionTrack): string {
  const frames = buildPercentFrames(track)
  return `@keyframes ${name} {\n${frames.map(formatFrame).join('\n')}\n}`
}

export interface NodeAnimationCssInput {
  readonly selector: string
  readonly tracks: readonly MotionTrack[]
  /** Names each track's `@keyframes` rule; defaults to `<sanitized-selector>-<field-kebab>`. */
  readonly nameForTrack?: (track: MotionTrack) => string
  /** The node's static FIXED_ORDER transform — the untracked axes of the composite `transform`. */
  readonly transform3d?: MotionStaticTransform3d
  /** `false` leaves the `@property` rules out, for a caller that writes them once per stylesheet. */
  readonly registerProperties?: boolean
}

function sanitizeIdentPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

function defaultTrackName(selector: string, track: MotionTrack): string {
  return `${sanitizeIdentPart(selector)}-${track.field.toLowerCase().replace(/_/g, '-')}`
}

function formatSeconds(duration: number): string {
  return `${round(duration, 4)}s`
}

/**
 * Emits the full per-node CSS block that Dev Mode MCP's `get_motion_context` returns for a
 * CSS-backend timeline (docs/research/06-motion-to-gsap-tokens.md §2.7): the selector's
 * initial-state declarations (each track's `baseValue`) plus an `animation:` shorthand
 * listing one `@keyframes` name per track, followed by every track's `@keyframes` rule
 * (via `emitKeyframesRule` — the same function callers use standalone).
 */
export function emitNodeAnimationCss(input: NodeAnimationCssInput): string {
  const nameForTrack = input.nameForTrack ?? ((track: MotionTrack) => defaultTrackName(input.selector, track))

  const baseDeclarations = input.tracks.map((track) => `  ${formatDeclaration(track.field, track.baseValue)};`)
  const is3d = hasTransform3dTrack(input.tracks)
  if (is3d) baseDeclarations.push(`  ${formatTransform3dDeclaration(input.tracks, input.transform3d)};`)
  const animationEntries = input.tracks.map((track) => `${nameForTrack(track)} ${formatSeconds(track.timelineDuration)} linear both`)
  const rule = [
    `${input.selector} {`,
    ...baseDeclarations,
    `  animation:`,
    `    ${animationEntries.join(',\n    ')};`,
    `}`,
  ].join('\n')

  const reducedMotionGuard = [
    '@media (prefers-reduced-motion: reduce) {',
    `  ${input.selector} {`,
    '    animation: none;',
    '  }',
    '}',
  ].join('\n')

  const keyframesBlocks = input.tracks.map((track) => emitKeyframesRule(nameForTrack(track), track))
  const properties = is3d && input.registerProperties !== false ? [emitTransform3dPropertyRules()] : []
  return [...properties, rule, reducedMotionGuard, ...keyframesBlocks].join('\n\n')
}
