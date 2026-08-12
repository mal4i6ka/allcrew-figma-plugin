import test from 'node:test'
import assert from 'node:assert/strict'
import { readMotionData } from './beta-adapter.ts'

function makeMotionKeyframe(overrides: any): any {
  return { id: 'kf-1', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 }, ...overrides }
}

function makeMotionNode(overrides: any): any {
  return {
    id: '1:1',
    name: 'Card',
    type: 'FRAME',
    animations: {},
    timelines: [],
    animationStyles: [],
    manualKeyframeTracks: {},
    fills: [],
    strokes: [],
    effects: [],
    ...overrides,
  }
}

test('readMotionData snapshots only allowlisted manual keyframe tracks', () => {
  const node = makeMotionNode({
    timelines: [{ id: 'tl-1', duration: 2 }],
    animationStyles: [{ id: 'style-1', styleId: 'preset-fade', name: 'Fade in' }],
    animations: {
      OPACITY: { baseValue: { type: 'FLOAT', value: 1 }, timelineDuration: 2, tracks: [] },
    },
    manualKeyframeTracks: {
      OPACITY: {
        id: 'track-opacity',
        baseValue: { type: 'FLOAT', value: 0 },
        keyframes: [
          makeMotionKeyframe({ id: 'kf-opacity-0', timelinePosition: 0, value: { type: 'FLOAT', value: 0 } }),
          makeMotionKeyframe({ id: 'kf-opacity-1', timelinePosition: 1, value: { type: 'FLOAT', value: 1 } }),
        ],
      },
    },
  })

  const snapshot = readMotionData(node)

  assert.deepEqual(snapshot, {
    animationStyles: [{ id: 'style-1', styleId: 'preset-fade', name: 'Fade in' }],
    timelines: [{ id: 'tl-1', duration: 2 }],
    tracks: [
      {
        field: 'OPACITY',
        baseValue: { type: 'FLOAT', value: 0 },
        timelineDuration: 2,
        keyframes: [
          { id: 'kf-opacity-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
          { id: 'kf-opacity-1', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } },
        ],
      },
    ],
  })
})

test('readMotionData returns null when the node has no Motion API (graceful degradation)', () => {
  const node = { id: '2:1', name: 'Legacy', type: 'FRAME' }

  assert.equal(readMotionData(node as any), null)
})

test('readMotionData returns null when a Beta accessor throws', () => {
  const node = makeMotionNode({})
  Object.defineProperty(node, 'manualKeyframeTracks', {
    get(): never {
      throw new Error('Motion API unavailable')
    },
  })

  assert.equal(readMotionData(node), null)
})

test('readMotionData skips shader-type indexed effect tracks and warns', () => {
  const warnCalls: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args)
  }

  try {
    const node = makeMotionNode({
      effects: [{ type: 'SHADER' }],
      manualKeyframeTracks: {
        effects: {
          0: {
            RADIUS: {
              id: 'track-shader-radius',
              baseValue: { type: 'FLOAT', value: 0 },
              keyframes: [makeMotionKeyframe({ id: 'kf-shader-0' })],
            },
          },
        },
      },
    })

    const snapshot = readMotionData(node)

    assert.ok(snapshot)
    assert.deepEqual(snapshot?.tracks, [])
    assert.ok(warnCalls.some((call) => call[0] === '[motion] skipping shader/unknown track:' && call[1] === 'SHADER'))
  } finally {
    console.warn = originalWarn
  }
})
