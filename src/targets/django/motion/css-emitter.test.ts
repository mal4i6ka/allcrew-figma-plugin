import test from 'node:test'
import assert from 'node:assert/strict'
import { emitKeyframesRule, emitNodeAnimationCss } from './css-emitter.ts'
import type { MotionTrack } from './types.ts'

function makeTrack(overrides: Partial<MotionTrack>): MotionTrack {
  return {
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 1,
    keyframes: [],
    ...overrides,
  }
}

// Reference example from docs/research/06-motion-to-gsap-tokens.md §2.7: 0.8s timeline,
// TRANSLATION_Y 40 -> 0 with EASE_OUT_BACK entering the 0.6s keyframe, then HOLD at 0.8s.
test('emitKeyframesRule converts timelinePosition/duration to percentages and shifts easing to the previous block', () => {
  const track = makeTrack({
    field: 'TRANSLATION_Y',
    baseValue: { type: 'FLOAT', value: 40 },
    timelineDuration: 0.8,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0.0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 40 } },
      {
        id: 'kf-1',
        timelinePosition: 0.6,
        easing: { type: 'EASE_OUT_BACK', easingFunctionCubicBezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
        value: { type: 'FLOAT', value: 0 },
      },
      { id: 'kf-2', timelinePosition: 0.8, easing: { type: 'HOLD' }, value: { type: 'FLOAT', value: 0 } },
    ],
  })

  const css = emitKeyframesRule('card-y-9c41', track)

  assert.equal(
    css,
    [
      '@keyframes card-y-9c41 {',
      '  0% { translate: 0px 40px; animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }',
      '  75% { translate: 0px 0px; }',
      '  100% { translate: 0px 0px; }',
      '}',
    ].join('\n')
  )
})

test('emitKeyframesRule shifts a plain bezier easing to the previous block for OPACITY', () => {
  const track = makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 0.8,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0.0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
      {
        id: 'kf-1',
        timelinePosition: 0.4,
        easing: { type: 'EASE_OUT', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
        value: { type: 'FLOAT', value: 1 },
      },
    ],
  })

  const css = emitKeyframesRule('card-fade-9c41', track)

  assert.equal(
    css,
    [
      '@keyframes card-fade-9c41 {',
      '  0% { opacity: 0; animation-timing-function: cubic-bezier(0, 0, 0.58, 1); }',
      '  50% { opacity: 1; }',
      '}',
    ].join('\n')
  )
})

test('emitKeyframesRule keeps a HOLD timing-function when the value actually jumps', () => {
  const track = makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 1 },
    timelineDuration: 1,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } },
      { id: 'kf-1', timelinePosition: 0.5, easing: { type: 'HOLD' }, value: { type: 'FLOAT', value: 0 } },
    ],
  })

  const css = emitKeyframesRule('blink', track)

  assert.match(css, /0% \{ opacity: 1; animation-timing-function: step-end; \}/)
})

test('emitKeyframesRule emits independent translate/scale/rotate instead of a combined transform', () => {
  const translateX = emitKeyframesRule('move-x', makeTrack({
    field: 'TRANSLATION_X',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 100 } }],
  }))
  assert.match(translateX, /translate: 100px 0px/)
  assert.doesNotMatch(translateX, /transform:/)

  const scaleY = emitKeyframesRule('grow-y', makeTrack({
    field: 'SCALE_Y',
    baseValue: { type: 'FLOAT', value: 1 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 2 } }],
  }))
  assert.match(scaleY, /scale: 1 2/)

  const rotate = emitKeyframesRule('spin', makeTrack({
    field: 'ROTATION',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 90 } }],
  }))
  assert.match(rotate, /rotate: 90deg/)
})

test('emitKeyframesRule handles a VECTOR value for TRANSLATION_XY', () => {
  const css = emitKeyframesRule('diagonal', makeTrack({
    field: 'TRANSLATION_XY',
    baseValue: { type: 'VECTOR', value: { x: 0, y: 0 } },
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'VECTOR', value: { x: 0, y: 0 } } },
      { id: 'kf-1', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'VECTOR', value: { x: 10, y: 20 } } },
    ],
  }))

  assert.match(css, /100% \{ translate: 10px 20px; \}/)
})

test('emitKeyframesRule synthesizes a 0% base keyframe when the first keyframe is not at t=0', () => {
  const css = emitKeyframesRule('delayed', makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 2,
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
  }))

  assert.match(css, /0% \{ opacity: 0; animation-timing-function: linear; \}/)
  assert.match(css, /50% \{ opacity: 1; \}/)
})

test('emitKeyframesRule resolves a spring easing via the sampled linear() curve', () => {
  const css = emitKeyframesRule('bouncy', makeTrack({
    field: 'TRANSLATION_Y',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 1,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
      {
        id: 'kf-1',
        timelinePosition: 1,
        easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
        value: { type: 'FLOAT', value: 100 },
      },
    ],
  }))

  assert.match(css, /animation-timing-function: linear\(/)
})

test('emitKeyframesRule throws on a variable-bound easing', () => {
  const track = makeTrack({
    field: 'OPACITY',
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
      { id: 'kf-1', timelinePosition: 1, easing: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }, value: { type: 'FLOAT', value: 1 } },
    ],
  })

  assert.throws(() => emitKeyframesRule('aliased', track), /variable alias/)
})

test('emitKeyframesRule throws for a field with no CSS mapping', () => {
  const track = makeTrack({ field: 'PATH_TRIM_START' })
  assert.throws(() => emitKeyframesRule('trim', track), /No CSS mapping/)
})

// T5.8 verification: reproduces the "Card" reference file's Motion Plugin API read and the
// "Эквивалентный CSS" get_motion_context is documented to return for it, verbatim from
// docs/research/06-motion-to-gsap-tokens.md §2.7 (a CSS-eligible timeline: 1 node, bezier
// easing, autoplay). Confirms `emitNodeAnimationCss` sverяется with that reference output —
// same percentage breakpoints, easing control points, and HOLD-shifted timing functions.
test('emitNodeAnimationCss matches the Dev Mode MCP get_motion_context reference example (06-motion-to-gsap-tokens.md §2.7)', () => {
  const translationY = makeTrack({
    field: 'TRANSLATION_Y',
    baseValue: { type: 'FLOAT', value: 40 },
    timelineDuration: 0.8,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0.0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 40 } },
      {
        id: 'kf-1',
        timelinePosition: 0.6,
        easing: { type: 'EASE_OUT_BACK', easingFunctionCubicBezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
        value: { type: 'FLOAT', value: 0 },
      },
      { id: 'kf-2', timelinePosition: 0.8, easing: { type: 'HOLD' }, value: { type: 'FLOAT', value: 0 } },
    ],
  })
  const opacity = makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 0.8,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0.0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
      {
        id: 'kf-1',
        timelinePosition: 0.4,
        easing: { type: 'EASE_OUT', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
        value: { type: 'FLOAT', value: 1 },
      },
    ],
  })

  const css = emitNodeAnimationCss({
    selector: '[data-anim="card-9c41"]',
    tracks: [translationY, opacity],
    nameForTrack: (track) => (track.field === 'TRANSLATION_Y' ? 'card-y-9c41' : 'card-fade-9c41'),
  })

  assert.equal(
    css,
    [
      [
        '[data-anim="card-9c41"] {',
        '  translate: 0px 40px;',
        '  opacity: 0;',
        '  animation:',
        '    card-y-9c41 0.8s linear both,',
        '    card-fade-9c41 0.8s linear both;',
        '}',
      ].join('\n'),
      [
        '@media (prefers-reduced-motion: reduce) {',
        '  [data-anim="card-9c41"] {',
        '    animation: none;',
        '  }',
        '}',
      ].join('\n'),
      [
        '@keyframes card-y-9c41 {',
        '  0% { translate: 0px 40px; animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }',
        '  75% { translate: 0px 0px; }',
        '  100% { translate: 0px 0px; }',
        '}',
      ].join('\n'),
      [
        '@keyframes card-fade-9c41 {',
        '  0% { opacity: 0; animation-timing-function: cubic-bezier(0, 0, 0.58, 1); }',
        '  50% { opacity: 1; }',
        '}',
      ].join('\n'),
    ].join('\n\n')
  )
})
