/**
 * Shared easing conversion for the CSS and GSAP emitters (T5.4/T5.5): turns a Figma
 * `MotionEasing` into a CSS timing-function, and normalizes physical/named springs into
 * a single ODE-sampled progress curve consumable by both `linear()` and `gsap.registerEase`.
 *
 * The Motion Plugin API only returns explicit control points for `CUSTOM_CUBIC_BEZIER`
 * and `CUSTOM_SPRING` — every other preset (`EASE_IN`, `GENTLE`, ...) is an opaque name.
 * The tables below are reverse-engineered by switching a preset to "Custom" in the Figma
 * UI and reading the resulting control points; see `verifyBezierPreset`/`verifySpringBounce`
 * for the check to re-run after a Figma release touches Motion easing.
 */

export type SpringEasingType = 'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW' | 'CUSTOM_SPRING'

export type BezierPresetType = Exclude<
  MotionEasing['type'],
  'LINEAR' | 'HOLD' | 'CUSTOM_CUBIC_BEZIER' | SpringEasingType
>

/** Control points reverse-engineered via Figma's preset → Custom conversion (see module doc). */
export const BEZIER_PRESETS: Record<BezierPresetType, EasingFunctionBezier> = {
  EASE_IN: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  EASE_OUT: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  EASE_IN_AND_OUT: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  EASE_IN_BACK: { x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 },
  EASE_OUT_BACK: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  EASE_IN_AND_OUT_BACK: { x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 },
}

/** Normalized `bounce` reverse-engineered the same way, pending verification (see module doc). */
export const NAMED_SPRING_BOUNCE: Record<Exclude<SpringEasingType, 'CUSTOM_SPRING'>, number> = {
  GENTLE: 0,
  QUICK: 0.05,
  BOUNCY: 0.6,
  SLOW: 0.15,
}

/**
 * Angular frequency (rad/s) used for every normalized spring, since `NormalizedSpring`
 * exposes only `bounce` — no independent speed knob. Matches Framer Motion's default
 * physical spring (`stiffness: 100, mass: 1` → `sqrt(stiffness / mass)`), a reasonable
 * "medium" feel until Figma's own frequency can be verified (see module doc).
 */
export const BASE_SPRING_ANGULAR_FREQUENCY = 10

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function bezierToCss(bezier: EasingFunctionBezier): string {
  return `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`
}

/**
 * Converts a Figma `MotionEasing` to a CSS timing-function. Springs (`GENTLE`, `QUICK`,
 * `BOUNCY`, `SLOW`, `CUSTOM_SPRING`) throw — they need a duration override from
 * `sampleSpring`/`springToCssLinear`, which a bare string return can't carry.
 */
export function easingToCss(easing: MotionEasing): string {
  switch (easing.type) {
    case 'LINEAR':
      return 'linear'
    case 'HOLD':
      // Value holds until the next keyframe, then jumps — CSS `step-end`.
      return 'step-end'
    case 'CUSTOM_CUBIC_BEZIER': {
      if (!easing.easingFunctionCubicBezier) {
        throw new Error('CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier')
      }
      return bezierToCss(easing.easingFunctionCubicBezier)
    }
    case 'GENTLE':
    case 'QUICK':
    case 'BOUNCY':
    case 'SLOW':
    case 'CUSTOM_SPRING':
      throw new Error(
        `${easing.type} is a spring easing — use sampleSpring()/springToCssLinear() instead of easingToCss()`
      )
    default:
      return bezierToCss(BEZIER_PRESETS[easing.type])
  }
}

/** `figma.motion.physicalSpringToNormalized()` reimplemented for use outside the plugin sandbox. */
export function physicalSpringToNormalized(spring: PhysicalSpring): number {
  const dampingRatio = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass))
  return clamp(1 - dampingRatio, 0, 1)
}

/** Resolves any spring `MotionEasing` (named preset or `CUSTOM_SPRING`) to a normalized bounce. */
export function resolveSpringBounce(easing: MotionEasing): number {
  if (easing.type === 'CUSTOM_SPRING') {
    if (!easing.easingFunctionSpring) {
      throw new Error('CUSTOM_SPRING easing is missing easingFunctionSpring')
    }
    return easing.easingFunctionSpring.bounce
  }
  if (easing.type in NAMED_SPRING_BOUNCE) {
    return NAMED_SPRING_BOUNCE[easing.type as keyof typeof NAMED_SPRING_BOUNCE]
  }
  throw new Error(`${easing.type} is not a spring easing`)
}

interface SpringState {
  /** Displacement from the target (1 = fully settled). */
  d: number
  v: number
}

function springDerivative(state: SpringState, dampingRatio: number, omega0: number): SpringState {
  return {
    d: state.v,
    v: -omega0 * omega0 * state.d - 2 * dampingRatio * omega0 * state.v,
  }
}

/** One RK4 step solving `d'' + 2*dampingRatio*omega0*d' + omega0^2*d = 0`. */
function rk4Step(state: SpringState, dt: number, dampingRatio: number, omega0: number): SpringState {
  const k1 = springDerivative(state, dampingRatio, omega0)
  const k2 = springDerivative({ d: state.d + (dt / 2) * k1.d, v: state.v + (dt / 2) * k1.v }, dampingRatio, omega0)
  const k3 = springDerivative({ d: state.d + (dt / 2) * k2.d, v: state.v + (dt / 2) * k2.v }, dampingRatio, omega0)
  const k4 = springDerivative({ d: state.d + dt * k3.d, v: state.v + dt * k3.v }, dampingRatio, omega0)
  return {
    d: state.d + (dt / 6) * (k1.d + 2 * k2.d + 2 * k3.d + k4.d),
    v: state.v + (dt / 6) * (k1.v + 2 * k2.v + 2 * k3.v + k4.v),
  }
}

/** Below this damping ratio the spring never fully settles (undamped oscillation); floor it. */
const MIN_DAMPING_RATIO = 0.001
const SETTLE_TOLERANCE = 0.004
const MAX_SETTLE_TIME_SEC = 10

/** Integrates until the displacement stays within `SETTLE_TOLERANCE` of the target for good. */
function findSettlingTimeSec(dampingRatio: number, omega0: number): number {
  const period = (2 * Math.PI) / omega0
  const dt = Math.min(period / 100, 0.01)
  const maxSteps = Math.ceil(MAX_SETTLE_TIME_SEC / dt)

  let state: SpringState = { d: -1, v: 0 }
  let lastUnsettledStep = 0
  for (let step = 1; step <= maxSteps; step++) {
    state = rk4Step(state, dt, dampingRatio, omega0)
    if (Math.abs(state.d) > SETTLE_TOLERANCE) lastUnsettledStep = step
  }

  return Math.min(lastUnsettledStep * dt, MAX_SETTLE_TIME_SEC)
}

export const SAMPLE_COUNT = 80

export interface SampledSpring {
  /** Progress samples from 0 to 1, evenly spaced across `settlingTimeMs`. */
  points: number[]
  /** Physically-derived settle time — use this as the animation duration, not any nominal one. */
  settlingTimeMs: number
}

/**
 * Solves the normalized spring ODE for `bounce` and samples ~80 progress points across
 * its physically-derived settling time. Shared by both CSS (`springToCssLinear`) and
 * GSAP (`createLerpEase` + `gsap.registerEase`) backends.
 */
export function sampleSpring(bounce: number, angularFrequency: number = BASE_SPRING_ANGULAR_FREQUENCY): SampledSpring {
  const dampingRatio = clamp(1 - bounce, MIN_DAMPING_RATIO, 1)
  const settlingTimeSec = findSettlingTimeSec(dampingRatio, angularFrequency)

  if (settlingTimeSec <= 0) {
    return { points: Array(SAMPLE_COUNT).fill(1), settlingTimeMs: 0 }
  }

  const dt = settlingTimeSec / (SAMPLE_COUNT - 1)
  const points: number[] = [0]
  let state: SpringState = { d: -1, v: 0 }
  for (let i = 1; i < SAMPLE_COUNT; i++) {
    state = rk4Step(state, dt, dampingRatio, angularFrequency)
    points.push(1 + state.d)
  }
  points[points.length - 1] = 1

  return { points, settlingTimeMs: settlingTimeSec * 1000 }
}

/** Bakes a sampled spring into a CSS `linear()` easing function, paired with its real duration. */
export function springToCssLinear(
  bounce: number,
  angularFrequency?: number
): { easing: string; durationMs: number } {
  const { points, settlingTimeMs } = sampleSpring(bounce, angularFrequency)
  return { easing: `linear(${points.map((p) => round(p, 4)).join(', ')})`, durationMs: settlingTimeMs }
}

/** Builds a `p => progress` function from sampled points, for `gsap.registerEase(name, fn)`. */
export function createLerpEase(points: number[]): (progress: number) => number {
  return (progress: number) => {
    const scaled = clamp(progress, 0, 1) * (points.length - 1)
    const index = Math.floor(scaled)
    if (index >= points.length - 1) return points[points.length - 1]
    const fraction = scaled - index
    return points[index] + (points[index + 1] - points[index]) * fraction
  }
}

export interface BezierPresetVerification {
  matches: boolean
  maxDelta: number
  expected: EasingFunctionBezier
  observed: EasingFunctionBezier
}

/**
 * Verification procedure for bezier presets: in the Figma UI, switch the preset to
 * "Custom" and read the resulting `easingFunctionCubicBezier` — pass it here as `observed`
 * to check it still matches our hardcoded table. Re-run after any Figma release that
 * touches Motion easing.
 */
export function verifyBezierPreset(
  type: BezierPresetType,
  observed: EasingFunctionBezier,
  tolerance = 0.01
): BezierPresetVerification {
  const expected = BEZIER_PRESETS[type]
  const maxDelta = Math.max(
    Math.abs(expected.x1 - observed.x1),
    Math.abs(expected.y1 - observed.y1),
    Math.abs(expected.x2 - observed.x2),
    Math.abs(expected.y2 - observed.y2)
  )
  return { matches: maxDelta <= tolerance, maxDelta, expected, observed }
}

/** Batch form of `verifyBezierPreset`, for a full QA pass across every preset at once. */
export function verifyBezierPresets(
  observed: Partial<Record<BezierPresetType, EasingFunctionBezier>>,
  tolerance = 0.01
): Record<string, BezierPresetVerification> {
  const results: Record<string, BezierPresetVerification> = {}
  for (const [type, bezier] of Object.entries(observed) as [BezierPresetType, EasingFunctionBezier][]) {
    results[type] = verifyBezierPreset(type, bezier, tolerance)
  }
  return results
}

export interface SpringBounceVerification {
  matches: boolean
  maxDelta: number
  expected: number
  observed: number
}

/** Same procedure as `verifyBezierPreset`, for named spring presets (switch to Custom Spring). */
export function verifySpringBounce(
  type: Exclude<SpringEasingType, 'CUSTOM_SPRING'>,
  observedBounce: number,
  tolerance = 0.02
): SpringBounceVerification {
  const expected = NAMED_SPRING_BOUNCE[type]
  const maxDelta = Math.abs(expected - observedBounce)
  return { matches: maxDelta <= tolerance, maxDelta, expected, observed: observedBounce }
}
