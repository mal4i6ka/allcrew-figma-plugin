/**
 * Adapts a prototyping `Transition.easing` (the `Easing`/`EasingFunctionSpring` shape reactions
 * carry — physical `{mass, stiffness, damping, initialVelocity}` springs) to CSS, reusing T5.1's
 * shared easing module (`src/easing/index.ts`), which solves the spring ODE. `Easing` and
 * `MotionEasing` share every preset name except `HOLD` (prototyping reactions don't have it), so
 * the bezier-preset table applies unchanged.
 *
 * Springs are solved from the reaction's OWN numbers: `CUSTOM_SPRING` from its mass/stiffness/
 * damping/initialVelocity, a named preset from its bounce at the frequency whose period is the
 * duration the designer typed. Both used to be flattened onto one hardcoded 10 rad/s spring, so
 * every spring in every file animated at the same speed and for the same length of time no matter
 * what the designer set.
 */

import {
  BEZIER_PRESETS,
  observeSpringPreset,
  springCurve,
  springParamsFromEasing,
  springParamsToCssLinear,
  type MotionCurve,
  type SpringPresetObservation,
  type SpringSource,
} from '../easing/index.ts'

export interface CssTiming {
  readonly timingFunction: string
  readonly durationMs: number
  /** The same easing as numbers, for a consumer that is not a stylesheet: bezier control points,
   * or a spring's ζ/ω₀/response/stiffness. Built from what this function already resolved -
   * `timingFunction` is the web's projection of it, not the other way round. */
  readonly curve: MotionCurve
  /** Set only for springs. `preset-table` means the curve rests on the reverse-engineered
   * `NAMED_SPRING_BOUNCE` estimate rather than on numbers Figma stated — the export reports those
   * so a wrong guess is visible in the package instead of only in the pixels. */
  readonly springSource?: SpringSource
  /** The preset name (`GENTLE`, `BOUNCY`, …) a spring easing carried, so the report can name which
   * estimate a curve rests on. Absent for `CUSTOM_SPRING`, which is never an estimate. */
  readonly springPreset?: string
  /** Set only when a named preset arrived carrying enough of its own numbers to check the table. */
  readonly springObservation?: SpringPresetObservation
}

/** Converts a `SimpleTransition`'s `{easing, duration}` to a CSS timing-function + duration. */
export function transitionToCssTiming(transition: { readonly easing: Easing; readonly duration: number }): CssTiming {
  const { easing, duration } = transition
  const durationMs = Math.round(duration * 1000)

  switch (easing.type) {
    case 'LINEAR':
      return { timingFunction: 'linear', durationMs, curve: { kind: 'linear' } }
    case 'CUSTOM_CUBIC_BEZIER': {
      if (!easing.easingFunctionCubicBezier) {
        throw new Error('CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier')
      }
      const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier
      return {
        timingFunction: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
        durationMs,
        curve: { kind: 'bezier', x1, y1, x2, y2 },
      }
    }
    case 'CUSTOM_SPRING':
    case 'GENTLE':
    case 'QUICK':
    case 'BOUNCY':
    case 'SLOW': {
      if (easing.type === 'CUSTOM_SPRING' && !easing.easingFunctionSpring) {
        throw new Error('CUSTOM_SPRING easing is missing easingFunctionSpring')
      }
      // A spring's own physics decide how long it runs - the reaction's `duration` field is inert
      // for it in Figma too - but a preset that states only a bounce takes that duration as the
      // period it should oscillate at.
      const resolved = springParamsFromEasing(easing, duration)
      const sampled = springParamsToCssLinear(resolved.params)
      const observation = observeSpringPreset(easing)
      return {
        timingFunction: sampled.easing,
        durationMs: sampled.durationMs,
        // The solved settle time, not the nominal one: the CSS duration and the native spring's
        // own runtime are the same number, and they come from the same sampling.
        curve: springCurve(resolved, sampled.durationMs),
        springSource: resolved.source,
        ...(resolved.preset ? { springPreset: resolved.preset } : {}),
        ...(observation ? { springObservation: observation } : {}),
      }
    }
    default: {
      const bezier = BEZIER_PRESETS[easing.type]
      return {
        timingFunction: `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`,
        durationMs,
        curve: { kind: 'bezier', ...bezier, preset: easing.type },
      }
    }
  }
}
