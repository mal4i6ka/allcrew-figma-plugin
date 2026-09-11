import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionToCssTiming } from './easing-adapter.ts'

test('transitionToCssTiming converts LINEAR and duration seconds to ms', () => {
  const result = transitionToCssTiming({ easing: { type: 'LINEAR' }, duration: 0.3 })
  assert.deepEqual(result, { timingFunction: 'linear', durationMs: 300 })
})

test('transitionToCssTiming converts a named bezier preset', () => {
  const result = transitionToCssTiming({ easing: { type: 'EASE_OUT' }, duration: 0.2 })
  assert.equal(result.timingFunction, 'cubic-bezier(0, 0, 0.58, 1)')
  assert.equal(result.durationMs, 200)
})

test('transitionToCssTiming passes through CUSTOM_CUBIC_BEZIER control points exactly', () => {
  const result = transitionToCssTiming({
    easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 } },
    duration: 0.5,
  })
  assert.equal(result.timingFunction, 'cubic-bezier(0.1, 0.2, 0.3, 0.4)')
  assert.equal(result.durationMs, 500)
})

test('transitionToCssTiming samples a CUSTOM_SPRING (physical) into a linear() curve with its own settling duration', () => {
  const result = transitionToCssTiming({
    easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 1, stiffness: 100, damping: 15, initialVelocity: 0 } },
    duration: 999, // ignored — springs compute their own settling duration
  })
  assert.match(result.timingFunction, /^linear\(/)
  assert.notEqual(result.durationMs, 999000)
  assert.ok(result.durationMs > 0)
})

test('transitionToCssTiming samples a named spring preset (GENTLE) into a linear() curve', () => {
  const result = transitionToCssTiming({ easing: { type: 'GENTLE' }, duration: 0.3 })
  assert.match(result.timingFunction, /^linear\(/)
  assert.ok(result.durationMs > 0)
})

test('a stiff CUSTOM_SPRING runs shorter than a soft one, instead of both getting the same curve', () => {
  const stiff = transitionToCssTiming({
    easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 1, stiffness: 900, damping: 45, initialVelocity: 0 } },
    duration: 0.3,
  })
  const soft = transitionToCssTiming({
    easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 3, stiffness: 100, damping: 26, initialVelocity: 0 } },
    duration: 0.3,
  })
  assert.ok(stiff.durationMs < soft.durationMs, `${stiff.durationMs} < ${soft.durationMs}`)
  assert.notEqual(stiff.timingFunction, soft.timingFunction)
})

test('a named spring is scaled by the duration the designer typed next to it', () => {
  const quick = transitionToCssTiming({ easing: { type: 'BOUNCY' }, duration: 0.15 })
  const slow = transitionToCssTiming({ easing: { type: 'BOUNCY' }, duration: 0.9 })
  // Same preset, different intent: a 150ms bounce must not outlive a 900ms one.
  assert.ok(quick.durationMs < slow.durationMs, `${quick.durationMs} < ${slow.durationMs}`)
  assert.ok(quick.durationMs < 400, `a 150ms BOUNCY settled in ${quick.durationMs}ms`)
})

test('transitionToCssTiming throws when CUSTOM_CUBIC_BEZIER is missing its control points', () => {
  assert.throws(() => transitionToCssTiming({ easing: { type: 'CUSTOM_CUBIC_BEZIER' }, duration: 0.2 }))
})
