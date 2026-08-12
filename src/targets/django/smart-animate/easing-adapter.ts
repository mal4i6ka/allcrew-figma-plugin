/**
 * Adapts a prototyping `Transition.easing` (the `Easing`/`EasingFunctionSpring` shape reactions
 * carry — physical `{mass, stiffness, damping}` springs) to CSS, reusing T5.1's shared easing
 * module (`src/easing/index.ts`), which already solves the spring ODE and exposes
 * `physicalSpringToNormalized`. `Easing` and `MotionEasing` share every preset name except
 * `HOLD` (prototyping reactions don't have it), so the bezier-preset table applies unchanged.
 */

import { BEZIER_PRESETS, NAMED_SPRING_BOUNCE, physicalSpringToNormalized, springToCssLinear } from '../easing/index.ts'

export interface CssTiming {
  readonly timingFunction: string
  readonly durationMs: number
}

/** Converts a `SimpleTransition`'s `{easing, duration}` to a CSS timing-function + duration. */
export function transitionToCssTiming(transition: { readonly easing: Easing; readonly duration: number }): CssTiming {
  const { easing, duration } = transition
  const durationMs = Math.round(duration * 1000)

  switch (easing.type) {
    case 'LINEAR':
      return { timingFunction: 'linear', durationMs }
    case 'CUSTOM_CUBIC_BEZIER': {
      if (!easing.easingFunctionCubicBezier) {
        throw new Error('CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier')
      }
      const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier
      return { timingFunction: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`, durationMs }
    }
    case 'CUSTOM_SPRING': {
      if (!easing.easingFunctionSpring) {
        throw new Error('CUSTOM_SPRING easing is missing easingFunctionSpring')
      }
      const bounce = physicalSpringToNormalized(easing.easingFunctionSpring)
      const sampled = springToCssLinear(bounce)
      return { timingFunction: sampled.easing, durationMs: sampled.durationMs }
    }
    case 'GENTLE':
    case 'QUICK':
    case 'BOUNCY':
    case 'SLOW': {
      const sampled = springToCssLinear(NAMED_SPRING_BOUNCE[easing.type])
      return { timingFunction: sampled.easing, durationMs: sampled.durationMs }
    }
    default: {
      const bezier = BEZIER_PRESETS[easing.type]
      return { timingFunction: `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`, durationMs }
    }
  }
}
