import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BEZIER_PRESETS,
  NAMED_SPRING_BOUNCE,
  SAMPLE_COUNT,
  easingToCss,
  physicalSpringToNormalized,
  resolveSpringBounce,
  sampleSpring,
  springToCssLinear,
  createLerpEase,
  verifyBezierPreset,
  verifyBezierPresets,
  verifySpringBounce,
} from './index.ts'

test('easingToCss renders LINEAR and HOLD as CSS keywords', () => {
  assert.equal(easingToCss({ type: 'LINEAR' }), 'linear')
  assert.equal(easingToCss({ type: 'HOLD' }), 'step-end')
})

test('easingToCss renders CUSTOM_CUBIC_BEZIER using the easing\'s own control points', () => {
  const css = easingToCss({
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 },
  })
  assert.equal(css, 'cubic-bezier(0.1, 0.2, 0.3, 0.4)')
})

test('easingToCss throws when CUSTOM_CUBIC_BEZIER is missing its control points', () => {
  assert.throws(() => easingToCss({ type: 'CUSTOM_CUBIC_BEZIER' }), /easingFunctionCubicBezier/)
})

test('easingToCss renders every named bezier preset from the hardcoded table', () => {
  for (const [type, bezier] of Object.entries(BEZIER_PRESETS)) {
    assert.equal(
      easingToCss({ type: type as keyof typeof BEZIER_PRESETS }),
      `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`
    )
  }
})

test('easingToCss rejects spring types — they need sampleSpring for a duration override', () => {
  for (const type of ['GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING'] as const) {
    assert.throws(() => easingToCss({ type }), /spring easing/)
  }
})

test('physicalSpringToNormalized: critically damped spring has bounce 0', () => {
  const bounce = physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 20 })
  assert.ok(Math.abs(bounce) < 1e-9)
})

test('physicalSpringToNormalized: overdamped spring clamps bounce to 0', () => {
  const bounce = physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 40 })
  assert.equal(bounce, 0)
})

test('physicalSpringToNormalized: underdamped spring has bounce between 0 and 1', () => {
  const bounce = physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 5 })
  assert.ok(bounce > 0 && bounce < 1)
})

test('resolveSpringBounce reads named presets from the hardcoded table', () => {
  assert.equal(resolveSpringBounce({ type: 'GENTLE' }), NAMED_SPRING_BOUNCE.GENTLE)
  assert.equal(resolveSpringBounce({ type: 'BOUNCY' }), NAMED_SPRING_BOUNCE.BOUNCY)
})

test('resolveSpringBounce reads CUSTOM_SPRING from its own easingFunctionSpring', () => {
  assert.equal(resolveSpringBounce({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.42 } }), 0.42)
})

test('resolveSpringBounce throws for non-spring easings', () => {
  assert.throws(() => resolveSpringBounce({ type: 'LINEAR' }), /not a spring easing/)
})

test('sampleSpring produces ~80 points starting at 0 and settling at exactly 1', () => {
  const { points, settlingTimeMs } = sampleSpring(0.4)
  assert.equal(points.length, SAMPLE_COUNT)
  assert.equal(points[0], 0)
  assert.equal(points[points.length - 1], 1)
  assert.ok(settlingTimeMs > 0)
})

test('sampleSpring with bounce 0 (critically damped) never overshoots past 1', () => {
  const { points } = sampleSpring(0)
  for (const p of points) assert.ok(p <= 1 + 1e-6)
})

test('sampleSpring with high bounce overshoots past 1 at some point', () => {
  const { points } = sampleSpring(0.7)
  assert.ok(points.some((p) => p > 1.01))
})

test('sampleSpring is monotonically non-decreasing in settling time as bounce increases', () => {
  const low = sampleSpring(0.1)
  const high = sampleSpring(0.8)
  assert.ok(high.settlingTimeMs >= low.settlingTimeMs)
})

test('springToCssLinear renders a CSS linear() easing paired with the settle duration', () => {
  const { easing, durationMs } = springToCssLinear(0.3)
  assert.match(easing, /^linear\(0, .*, 1\)$/)
  assert.ok(durationMs > 0)
})

test('createLerpEase interpolates between sampled points and clamps out-of-range progress', () => {
  const ease = createLerpEase([0, 0.5, 1])
  assert.equal(ease(0), 0)
  assert.equal(ease(0.5), 0.5)
  assert.equal(ease(1), 1)
  assert.equal(ease(-1), 0)
  assert.equal(ease(2), 1)
})

test('verifyBezierPreset matches when observed control points equal the hardcoded table', () => {
  const result = verifyBezierPreset('EASE_OUT_BACK', BEZIER_PRESETS.EASE_OUT_BACK)
  assert.equal(result.matches, true)
  assert.equal(result.maxDelta, 0)
})

test('verifyBezierPreset flags drift beyond tolerance', () => {
  const drifted = { ...BEZIER_PRESETS.EASE_OUT, x2: BEZIER_PRESETS.EASE_OUT.x2 + 0.1 }
  const result = verifyBezierPreset('EASE_OUT', drifted, 0.01)
  assert.equal(result.matches, false)
  assert.ok(result.maxDelta > 0.01)
})

test('verifyBezierPresets runs the check across a batch of observed presets', () => {
  const results = verifyBezierPresets({
    EASE_IN: BEZIER_PRESETS.EASE_IN,
    EASE_OUT: { ...BEZIER_PRESETS.EASE_OUT, y2: 0 },
  })
  assert.equal(results.EASE_IN.matches, true)
  assert.equal(results.EASE_OUT.matches, false)
})

test('verifySpringBounce matches/flags drift the same way as the bezier check', () => {
  assert.equal(verifySpringBounce('BOUNCY', NAMED_SPRING_BOUNCE.BOUNCY).matches, true)
  assert.equal(verifySpringBounce('BOUNCY', NAMED_SPRING_BOUNCE.BOUNCY + 0.5).matches, false)
})
