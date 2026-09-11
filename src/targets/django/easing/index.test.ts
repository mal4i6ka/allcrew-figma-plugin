import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BEZIER_PRESETS,
  NAMED_SPRING_BOUNCE,
  SAMPLE_COUNT,
  easingToCss,
  normalizedSpringParams,
  perceptualAngularFrequency,
  physicalSpringParams,
  physicalSpringToNormalized,
  observeSpringPreset,
  resolveSpringBounce,
  springParamsFromEasing,
  summarizeSpringPresetObservations,
  sampleSpring,
  sampleSpringParams,
  springToCssLinear,
  createLerpEase,
  verifyBezierPreset,
  verifyBezierPresets,
  verifySpringBounce,
} from './index.ts'

test('springParamsFromEasing prefers physics Figma stated over the estimated preset table', () => {
  // The whole point of the table is that Figma publishes no numbers for its presets. The moment a
  // preset arrives WITH numbers, the guess must step aside — otherwise the export keeps animating
  // on an estimate while the file is holding the answer.
  const stated = springParamsFromEasing(
    { type: 'BOUNCY', easingFunctionSpring: { mass: 1, stiffness: 400, damping: 12, initialVelocity: 2 } },
    0.3
  )
  assert.equal(stated.source, 'physical')
  assert.equal(stated.preset, 'BOUNCY')
  assert.ok(Math.abs(stated.params.angularFrequency - 20) < 1e-9)
  assert.equal(stated.params.initialVelocity, 2)

  const guessed = springParamsFromEasing({ type: 'BOUNCY' }, 0.3)
  assert.equal(guessed.source, 'preset-table')
  assert.ok(Math.abs(guessed.params.dampingRatio - (1 - NAMED_SPRING_BOUNCE.BOUNCY)) < 1e-9)
  assert.ok(Math.abs(guessed.params.angularFrequency - perceptualAngularFrequency(0.3)) < 1e-9)
})

test('springParamsFromEasing uses a normalized bounce when that is all Motion gives', () => {
  const resolved = springParamsFromEasing({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } }, 0.25)
  assert.equal(resolved.source, 'normalized')
  assert.equal(resolved.preset, undefined)
  assert.ok(Math.abs(resolved.params.dampingRatio - 0.6) < 1e-9)
})

test('observeSpringPreset measures a preset against the table, and stays silent when it cannot', () => {
  const measured = observeSpringPreset({ type: 'GENTLE', easingFunctionSpring: { mass: 1, stiffness: 100, damping: 10 } })
  assert.deepEqual(measured, { preset: 'GENTLE', observedBounce: 0.5, tableBounce: NAMED_SPRING_BOUNCE.GENTLE })

  assert.equal(observeSpringPreset({ type: 'GENTLE' }), null, 'nothing to measure')
  assert.equal(observeSpringPreset({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.5 } }), null, 'no table entry to check')
  assert.equal(observeSpringPreset({ type: 'LINEAR' }), null)
})

test('summarizeSpringPresetObservations reports per-preset drift and agreement', () => {
  const summary = summarizeSpringPresetObservations([
    { preset: 'QUICK', observedBounce: 0.06, tableBounce: 0.05 },
    { preset: 'QUICK', observedBounce: 0.04, tableBounce: 0.05 },
    { preset: 'BOUNCY', observedBounce: 0.9, tableBounce: 0.6 },
  ])

  assert.deepEqual(summary.QUICK, { observedBounce: 0.05, tableBounce: 0.05, delta: 0, matches: true, samples: 2 })
  assert.equal(summary.BOUNCY.matches, false)
  assert.equal(summary.BOUNCY.delta, 0.3)
  assert.deepEqual(Object.keys(summary), ['BOUNCY', 'QUICK'], 'sorted for byte-stable reports')
})

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

test('physicalSpringParams reads the spring the designer actually configured', () => {
  // omega0 = sqrt(k/m), zeta = c / (2*sqrt(k*m)): a stiff light spring is fast, a heavy one slow,
  // and the old code gave both the same hardcoded 10 rad/s.
  const stiff = physicalSpringParams({ mass: 1, stiffness: 400, damping: 20 })
  assert.ok(Math.abs(stiff.angularFrequency - 20) < 1e-9)
  assert.ok(Math.abs(stiff.dampingRatio - 0.5) < 1e-9)

  const heavy = physicalSpringParams({ mass: 4, stiffness: 400, damping: 20 })
  assert.ok(Math.abs(heavy.angularFrequency - 10) < 1e-9)
  assert.ok(heavy.dampingRatio < stiff.dampingRatio)
})

test('a stiffer spring settles sooner than a softer one with the same damping ratio', () => {
  const fast = sampleSpringParams(physicalSpringParams({ mass: 1, stiffness: 900, damping: 30 }))
  const slow = sampleSpringParams(physicalSpringParams({ mass: 1, stiffness: 100, damping: 10 }))
  assert.ok(fast.settlingTimeMs < slow.settlingTimeMs, `${fast.settlingTimeMs} < ${slow.settlingTimeMs}`)
})

test('initialVelocity kicks the spring forward instead of being discarded', () => {
  const params = physicalSpringParams({ mass: 1, stiffness: 100, damping: 20 })
  const still = sampleSpringParams(params)
  const kicked = sampleSpringParams({ ...params, initialVelocity: 8 })
  // Same spring, thrown at the target: further along early and done sooner. A velocity-blind
  // solve produced the identical curve for both, so the designer's kick simply disappeared.
  assert.ok(kicked.points[5] > still.points[5])
  assert.ok(kicked.settlingTimeMs < still.settlingTimeMs)

  // Hard enough a throw overshoots even a critically damped spring, which cannot overshoot at rest.
  const thrown = sampleSpringParams({ ...params, initialVelocity: 30 })
  assert.ok(thrown.points.some((p) => p > 1.01), `max ${Math.max(...thrown.points)}`)
  assert.ok(still.points.every((p) => p <= 1 + 1e-6))
})

test('perceptualAngularFrequency makes the designer duration the spring period', () => {
  assert.ok(Math.abs(perceptualAngularFrequency(0.5) - (2 * Math.PI) / 0.5) < 1e-9)
  // No usable duration → the documented fallback, never NaN or Infinity.
  assert.equal(perceptualAngularFrequency(0), 10)
  assert.equal(perceptualAngularFrequency(Number.NaN), 10)
})

test('a short duration yields a short spring: a 150ms BOUNCY no longer runs for most of a second', () => {
  const params = normalizedSpringParams(NAMED_SPRING_BOUNCE.BOUNCY, perceptualAngularFrequency(0.15))
  const { settlingTimeMs } = sampleSpringParams(params)
  assert.ok(settlingTimeMs < 400, `settled in ${settlingTimeMs}ms`)
  const atBaseFrequency = sampleSpring(NAMED_SPRING_BOUNCE.BOUNCY)
  assert.ok(atBaseFrequency.settlingTimeMs > settlingTimeMs * 2)
})

test('a bouncy spring keeps its oscillations instead of being numerically damped away', () => {
  // The sampler used to integrate one RK4 step per emitted point, which flattened the tail of a
  // multi-oscillation spring; count the direction changes that survive to the stylesheet.
  const { points } = sampleSpringParams(normalizedSpringParams(0.85))
  let crossings = 0
  for (let i = 1; i < points.length; i++) {
    if ((points[i - 1] - 1) * (points[i] - 1) < 0) crossings++
  }
  assert.ok(crossings >= 3, `only ${crossings} crossings of the target`)
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
