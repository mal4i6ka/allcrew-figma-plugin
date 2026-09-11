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
 * Fallback angular frequency (rad/s) for a spring that arrives with neither physical parameters
 * nor a duration to derive a period from — `NormalizedSpring` carries only `bounce`, and a
 * keyframe whose segment length is unknown gives nothing to scale by. Matches Framer Motion's
 * default physical spring (`stiffness: 100, mass: 1` → `sqrt(stiffness / mass)`). Every caller
 * that HAS a duration should pass `perceptualAngularFrequency(duration)` instead: with a fixed
 * frequency a 150 ms BOUNCY reaction played for most of a second, because the shape was solved
 * for a spring nobody asked for.
 */
export const BASE_SPRING_ANGULAR_FREQUENCY = 10

/**
 * The angular frequency whose oscillation period IS the designer's duration — the same
 * duration↔frequency relation Apple's `Spring(duration:bounce:)` and Figma's own duration handle
 * use (`ω₀ = 2π / duration`). A normalized spring has no speed knob of its own, so the duration
 * the designer typed next to it is the only statement of intended speed there is.
 */
export function perceptualAngularFrequency(durationSec: number): number {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return BASE_SPRING_ANGULAR_FREQUENCY
  return (2 * Math.PI) / durationSec
}

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

/** The three numbers the ODE actually needs. Everything upstream — a normalized `bounce`, a
 * physical `{mass, stiffness, damping, initialVelocity}`, a named preset — resolves to this. */
export interface SpringParams {
  /** ζ: 1 = critically damped (no overshoot), <1 = bouncy, floored above 0 so it settles. */
  readonly dampingRatio: number
  /** ω₀ in rad/s. */
  readonly angularFrequency: number
  /** Progress units per second at t=0. A prototype reaction can hand the layer an initial kick
   * (`EasingFunctionSpring.initialVelocity`); ignoring it flattened the first third of every
   * such spring. */
  readonly initialVelocity: number
}

/**
 * The real physics of a prototyping spring: `ω₀ = sqrt(k/m)`, `ζ = c / (2·sqrt(k·m))`. Reactions
 * carry `{mass, stiffness, damping, initialVelocity}` in full, so a stiff heavy spring and a soft
 * light one no longer collapse onto the same curve the way they did when every spring was solved
 * at one hardcoded frequency and its bounce alone.
 */
export function physicalSpringParams(spring: {
  readonly mass: number
  readonly stiffness: number
  readonly damping: number
  readonly initialVelocity?: number
}): SpringParams {
  const mass = spring.mass > 0 ? spring.mass : 1
  const stiffness = spring.stiffness > 0 ? spring.stiffness : 1
  const angularFrequency = Math.sqrt(stiffness / mass)
  const dampingRatio = clamp(spring.damping / (2 * Math.sqrt(stiffness * mass)), MIN_DAMPING_RATIO, 1)
  return { dampingRatio, angularFrequency, initialVelocity: spring.initialVelocity ?? 0 }
}

/** A `bounce`-only spring (Motion's `NormalizedSpring`, or a named preset) at a chosen frequency. */
export function normalizedSpringParams(bounce: number, angularFrequency = BASE_SPRING_ANGULAR_FREQUENCY): SpringParams {
  return { dampingRatio: clamp(1 - bounce, MIN_DAMPING_RATIO, 1), angularFrequency, initialVelocity: 0 }
}

/** Where the numbers behind an emitted spring curve came from. Only `preset-table` is an estimate:
 * Figma publishes no physics for its named presets, so `NAMED_SPRING_BOUNCE` is reverse-engineered
 * and the export has to be able to say which curves rest on it. */
export type SpringSource = 'physical' | 'normalized' | 'preset-table'

export interface ResolvedSpring {
  readonly params: SpringParams
  readonly source: SpringSource
  /** The preset name (`GENTLE`, `BOUNCY`, …) when the easing was one, for reporting. */
  readonly preset?: string
}

/** A spring easing object as either API surface hands it over: prototyping reactions carry the full
 * physics, Motion keyframes carry a normalized bounce, and a named preset may carry either or
 * neither depending on what Figma chooses to fill in. */
interface SpringEasingLike {
  readonly type: string
  readonly easingFunctionSpring?: {
    readonly bounce?: number
    readonly mass?: number
    readonly stiffness?: number
    readonly damping?: number
    readonly initialVelocity?: number
  }
}

/**
 * Resolves ANY spring easing to solvable parameters, preferring what Figma actually stated over
 * what this module guesses:
 *
 * 1. physical `{mass, stiffness, damping}` — exact, and available on `CUSTOM_SPRING` reactions.
 *    A named preset that arrives WITH these numbers is resolved from them too, which is how this
 *    stops depending on the reverse-engineered table the moment Figma fills the field in.
 * 2. a normalized `bounce` — Motion's own value, solved at `durationSec`'s period.
 * 3. the `NAMED_SPRING_BOUNCE` estimate — flagged `preset-table` so the caller can report that the
 *    curve is a guess instead of letting it pass as measured.
 */
export function springParamsFromEasing(easing: SpringEasingLike, durationSec?: number): ResolvedSpring {
  const spring = easing.easingFunctionSpring
  const preset = easing.type === 'CUSTOM_SPRING' ? undefined : easing.type

  if (spring && typeof spring.mass === 'number' && typeof spring.stiffness === 'number' && typeof spring.damping === 'number') {
    return {
      params: physicalSpringParams({
        mass: spring.mass,
        stiffness: spring.stiffness,
        damping: spring.damping,
        initialVelocity: spring.initialVelocity,
      }),
      source: 'physical',
      preset,
    }
  }

  const angularFrequency = durationSec === undefined ? BASE_SPRING_ANGULAR_FREQUENCY : perceptualAngularFrequency(durationSec)

  if (spring && typeof spring.bounce === 'number') {
    return { params: normalizedSpringParams(spring.bounce, angularFrequency), source: 'normalized', preset }
  }

  if (easing.type in NAMED_SPRING_BOUNCE) {
    const bounce = NAMED_SPRING_BOUNCE[easing.type as keyof typeof NAMED_SPRING_BOUNCE]
    return { params: normalizedSpringParams(bounce, angularFrequency), source: 'preset-table', preset }
  }

  throw new Error(`${easing.type} is not a spring easing`)
}

/** One reading of a named preset taken from a real file: the bounce Figma's own numbers imply,
 * next to the one the table assumes. Collected across a document, these are what turn the
 * reverse-engineered table into a measured one — see `summarizeSpringPresetObservations`. */
export interface SpringPresetObservation {
  readonly preset: string
  readonly observedBounce: number
  readonly tableBounce: number
}

/** Reads a named preset's ACTUAL bounce when the easing carries the numbers to compute it, so a
 * real file can confirm or correct `NAMED_SPRING_BOUNCE`. Returns null for `CUSTOM_SPRING` (no
 * table entry to check), for non-springs, and for a preset Figma left empty (nothing to measure). */
export function observeSpringPreset(easing: SpringEasingLike): SpringPresetObservation | null {
  if (!(easing.type in NAMED_SPRING_BOUNCE)) return null
  const spring = easing.easingFunctionSpring
  if (!spring) return null

  const tableBounce = NAMED_SPRING_BOUNCE[easing.type as keyof typeof NAMED_SPRING_BOUNCE]
  if (typeof spring.mass === 'number' && typeof spring.stiffness === 'number' && typeof spring.damping === 'number') {
    const observedBounce = physicalSpringToNormalized({ mass: spring.mass, stiffness: spring.stiffness, damping: spring.damping })
    return { preset: easing.type, observedBounce, tableBounce }
  }
  if (typeof spring.bounce === 'number') {
    return { preset: easing.type, observedBounce: spring.bounce, tableBounce }
  }
  return null
}

/** Per-preset drift across every observation in a file. `matches: false` on any row means the
 * emitted curves for that preset are wrong by the stated delta and the table needs the observed
 * value — the point of collecting them at all. */
export function summarizeSpringPresetObservations(
  observations: readonly SpringPresetObservation[],
  tolerance = 0.02
): Record<string, { observedBounce: number; tableBounce: number; delta: number; matches: boolean; samples: number }> {
  const byPreset: Record<string, { total: number; samples: number; tableBounce: number }> = {}
  for (const observation of observations) {
    const bucket = byPreset[observation.preset] ?? { total: 0, samples: 0, tableBounce: observation.tableBounce }
    bucket.total += observation.observedBounce
    bucket.samples += 1
    byPreset[observation.preset] = bucket
  }

  const summary: Record<string, { observedBounce: number; tableBounce: number; delta: number; matches: boolean; samples: number }> = {}
  for (const preset of Object.keys(byPreset).sort()) {
    const { total, samples, tableBounce } = byPreset[preset]
    const observedBounce = round(total / samples, 4)
    const delta = round(Math.abs(observedBounce - tableBounce), 4)
    summary[preset] = { observedBounce, tableBounce, delta, matches: delta <= tolerance, samples }
  }
  return summary
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

/** The integration step that keeps RK4 accurate for this spring: a hundredth of its own period,
 * capped at 10 ms so a very soft spring still gets a sane step. */
function integrationStepSec(omega0: number): number {
  return Math.min((2 * Math.PI) / omega0 / 100, 0.01)
}

/** Integrates until the displacement stays within `SETTLE_TOLERANCE` of the target for good. */
function findSettlingTimeSec(params: SpringParams): number {
  const dt = integrationStepSec(params.angularFrequency)
  const maxSteps = Math.ceil(MAX_SETTLE_TIME_SEC / dt)

  let state: SpringState = { d: -1, v: params.initialVelocity }
  let lastUnsettledStep = 0
  for (let step = 1; step <= maxSteps; step++) {
    state = rk4Step(state, dt, params.dampingRatio, params.angularFrequency)
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
 * Solves the spring ODE for `params` and samples ~80 progress points across its physically-derived
 * settling time. Shared by both CSS (`springParamsToCssLinear`) and GSAP (`createLerpEase` +
 * `gsap.registerEase`) backends.
 *
 * Sampling and integration are separated: a bouncy spring runs for many oscillations, and stepping
 * RK4 once per emitted sample integrated a quarter-period at a time — the curve that reached the
 * stylesheet was a numerically damped caricature of the one Figma plays. The solver now steps at
 * `integrationStepSec` and records the state at each sample boundary.
 */
export function sampleSpringParams(params: SpringParams): SampledSpring {
  const settlingTimeSec = findSettlingTimeSec(params)

  if (settlingTimeSec <= 0) {
    return { points: Array(SAMPLE_COUNT).fill(1), settlingTimeMs: 0 }
  }

  const sampleDt = settlingTimeSec / (SAMPLE_COUNT - 1)
  const stepsPerSample = Math.max(1, Math.ceil(sampleDt / integrationStepSec(params.angularFrequency)))
  const dt = sampleDt / stepsPerSample

  const points: number[] = [0]
  let state: SpringState = { d: -1, v: params.initialVelocity }
  for (let i = 1; i < SAMPLE_COUNT; i++) {
    for (let step = 0; step < stepsPerSample; step++) {
      state = rk4Step(state, dt, params.dampingRatio, params.angularFrequency)
    }
    points.push(1 + state.d)
  }
  points[points.length - 1] = 1

  return { points, settlingTimeMs: settlingTimeSec * 1000 }
}

/** `sampleSpringParams` for a spring known only by its normalized `bounce`. */
export function sampleSpring(bounce: number, angularFrequency: number = BASE_SPRING_ANGULAR_FREQUENCY): SampledSpring {
  return sampleSpringParams(normalizedSpringParams(bounce, angularFrequency))
}

/** Bakes a sampled spring into a CSS `linear()` easing function, paired with its real duration. */
export function springParamsToCssLinear(params: SpringParams): { easing: string; durationMs: number } {
  const { points, settlingTimeMs } = sampleSpringParams(params)
  return { easing: `linear(${points.map((p) => round(p, 4)).join(', ')})`, durationMs: settlingTimeMs }
}

/** `springParamsToCssLinear` for a spring known only by its normalized `bounce`. */
export function springToCssLinear(
  bounce: number,
  angularFrequency?: number
): { easing: string; durationMs: number } {
  return springParamsToCssLinear(normalizedSpringParams(bounce, angularFrequency))
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
