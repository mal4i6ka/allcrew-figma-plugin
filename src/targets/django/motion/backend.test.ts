import test from 'node:test'
import assert from 'node:assert/strict'
import { pickBackend } from './backend.ts'
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

test('pickBackend picks CSS for a simple autoplay fade on <=2 nodes', () => {
  const decision = pickBackend({
    tracks: [
      makeTrack({
        field: 'OPACITY',
        keyframes: [
          { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
          { id: 'kf-1', timelinePosition: 1, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: 1 } },
        ],
      }),
    ],
    nodeCount: 2,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'css')
})

test('pickBackend forces GSAP for a spring with bounce above the threshold', () => {
  const decision = pickBackend({
    tracks: [
      makeTrack({
        field: 'TRANSLATION_Y',
        keyframes: [
          {
            id: 'kf-0',
            timelinePosition: 0.3,
            easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
            value: { type: 'FLOAT', value: 120 },
          },
        ],
      }),
    ],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'gsap')
  assert.match(decision.reason, /spring/)
})

test('pickBackend allows a low-bounce spring on CSS', () => {
  const decision = pickBackend({
    tracks: [
      makeTrack({
        field: 'TRANSLATION_Y',
        keyframes: [
          {
            id: 'kf-0',
            timelinePosition: 0.3,
            easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.05 } },
            value: { type: 'FLOAT', value: 120 },
          },
        ],
      }),
    ],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'css')
})

test('pickBackend ignores a spring bound to a variable alias (can\'t resolve bounce statically)', () => {
  const decision = pickBackend({
    tracks: [
      makeTrack({
        field: 'TRANSLATION_Y',
        keyframes: [
          {
            id: 'kf-0',
            timelinePosition: 0.3,
            easing: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' },
            value: { type: 'FLOAT', value: 120 },
          },
        ],
      }),
    ],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'css')
})

test('pickBackend forces GSAP for a TEXT_DATA track', () => {
  const decision = pickBackend({
    tracks: [
      makeTrack({
        field: 'OPACITY',
        baseValue: { type: 'TEXT_DATA', value: 'Hello' },
        keyframes: [],
      }),
    ],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'gsap')
  assert.match(decision.reason, /TEXT_DATA/)
})

test('pickBackend forces GSAP for a dual PATH_TRIM_START + PATH_TRIM_END track pair', () => {
  const decision = pickBackend({
    tracks: [makeTrack({ field: 'PATH_TRIM_START' }), makeTrack({ field: 'PATH_TRIM_END' })],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'gsap')
  assert.match(decision.reason, /PATH_TRIM/)
})

test('pickBackend allows a single PATH_TRIM field alone on CSS', () => {
  const decision = pickBackend({
    tracks: [makeTrack({ field: 'PATH_TRIM_END' })],
    nodeCount: 1,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'css')
})

test('pickBackend forces GSAP for 3 or more animated nodes', () => {
  const decision = pickBackend({
    tracks: [makeTrack({})],
    nodeCount: 3,
    trigger: 'autoplay',
  })

  assert.equal(decision.backend, 'gsap')
  assert.match(decision.reason, /nodes/)
})

test('pickBackend forces GSAP for an interactive trigger', () => {
  const decision = pickBackend({
    tracks: [makeTrack({})],
    nodeCount: 1,
    trigger: 'scrub',
  })

  assert.equal(decision.backend, 'gsap')
  assert.match(decision.reason, /trigger/)
})

test('pickBackend allows hover on CSS', () => {
  const decision = pickBackend({
    tracks: [makeTrack({})],
    nodeCount: 1,
    trigger: 'hover',
  })

  assert.equal(decision.backend, 'css')
})

test('pickBackend override forces CSS even when the rule would pick GSAP', () => {
  const decision = pickBackend({ tracks: [makeTrack({})], nodeCount: 5, trigger: 'scrub' }, 'css')

  assert.deepEqual(decision, { backend: 'css', reason: 'override' })
})

test('pickBackend override forces GSAP even when the rule would pick CSS', () => {
  const decision = pickBackend({ tracks: [makeTrack({})], nodeCount: 1, trigger: 'autoplay' }, 'gsap')

  assert.deepEqual(decision, { backend: 'gsap', reason: 'override' })
})
