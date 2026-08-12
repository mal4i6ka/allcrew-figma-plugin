/**
 * Backend selection rule (T5.3, docs/research/06-motion-to-gsap-tokens.md §2.6): one
 * timeline gets exactly one CSS-vs-GSAP backend — never split per-node, or the two
 * runtimes desync. GSAP wins on any strong signal (spring bounce, TEXT_DATA, dual
 * PATH_TRIM, ≥3 animated nodes, an interactive trigger); everything else is CSS.
 * The UI's per-timeline override (T6.1) short-circuits the rule entirely via `override`.
 */

import { NAMED_SPRING_BOUNCE, resolveSpringBounce } from '../easing/index.ts'
import type { MotionTrack } from './types.ts'

export type MotionBackend = 'css' | 'gsap'

/** `autoplay`/`loop`/`hover` are CSS-eligible; everything else needs a controllable timeline. */
export type MotionTrigger = 'autoplay' | 'loop' | 'hover' | 'scrub' | 'replay' | 'click' | 'other-interactive'

const CSS_ELIGIBLE_TRIGGERS: ReadonlySet<MotionTrigger> = new Set(['autoplay', 'loop', 'hover'])

/** Springs with a bounce at or below this settle close enough to a bezier ease-out for CSS. */
const SPRING_BOUNCE_THRESHOLD = 0.05

/** ≥3 animated nodes on a timeline need cross-node orchestration CSS delays can't guarantee. */
const GSAP_NODE_COUNT_THRESHOLD = 3

export interface TimelineBackendInput {
  /** Every manual keyframe track touched by the timeline, across all of its animated nodes. */
  readonly tracks: readonly MotionTrack[]
  /** Distinct nodes the timeline animates. */
  readonly nodeCount: number
  readonly trigger: MotionTrigger
}

export interface BackendDecision {
  readonly backend: MotionBackend
  /** Why this backend was picked — surfaced in the UI so an override makes an informed choice. */
  readonly reason: string
}

function isLiteralEasing(easing: MotionEasing | VariableAlias): easing is MotionEasing {
  return easing.type !== 'VARIABLE_ALIAS'
}

function isSpringEasing(easing: MotionEasing): boolean {
  return easing.type === 'CUSTOM_SPRING' || easing.type in NAMED_SPRING_BOUNCE
}

function hasBouncySpring(tracks: readonly MotionTrack[]): boolean {
  return tracks.some((track) =>
    track.keyframes.some((keyframe) => {
      const easing = keyframe.easing
      return isLiteralEasing(easing) && isSpringEasing(easing) && resolveSpringBounce(easing) > SPRING_BOUNCE_THRESHOLD
    })
  )
}

function hasTextDataTrack(tracks: readonly MotionTrack[]): boolean {
  return tracks.some(
    (track) => track.baseValue.type === 'TEXT_DATA' || track.keyframes.some((keyframe) => keyframe.value.type === 'TEXT_DATA')
  )
}

function hasDualPathTrim(tracks: readonly MotionTrack[]): boolean {
  const fields = new Set(tracks.map((track) => track.field))
  return fields.has('PATH_TRIM_START') && fields.has('PATH_TRIM_END')
}

/**
 * Picks the CSS-vs-GSAP backend for one timeline. `override` is the UI's per-timeline
 * force-CSS/force-GSAP control (T6.1) and always wins over the automatic rule.
 */
export function pickBackend(input: TimelineBackendInput, override?: MotionBackend | null): BackendDecision {
  if (override) {
    return { backend: override, reason: 'override' }
  }
  if (hasBouncySpring(input.tracks)) {
    return { backend: 'gsap', reason: `spring bounce > ${SPRING_BOUNCE_THRESHOLD}` }
  }
  if (hasTextDataTrack(input.tracks)) {
    return { backend: 'gsap', reason: 'TEXT_DATA track' }
  }
  if (hasDualPathTrim(input.tracks)) {
    return { backend: 'gsap', reason: 'PATH_TRIM_START + PATH_TRIM_END' }
  }
  if (input.nodeCount >= GSAP_NODE_COUNT_THRESHOLD) {
    return { backend: 'gsap', reason: `${input.nodeCount} animated nodes >= ${GSAP_NODE_COUNT_THRESHOLD}` }
  }
  if (!CSS_ELIGIBLE_TRIGGERS.has(input.trigger)) {
    return { backend: 'gsap', reason: `interactive trigger "${input.trigger}"` }
  }
  return { backend: 'css', reason: '<=2 nodes, transform/opacity, bezier easing, autoplay/loop/hover trigger' }
}
