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

/* ------------------------------------------------- 3D transforms (typings 1.143.0, beta) */

test('readMotionData keeps the five 3D tracks and the static transform they are composed with', () => {
  const float = (value: number) => ({ type: 'FLOAT', value })
  const track = (value: number) => ({ id: 't', baseValue: float(0), keyframes: [makeMotionKeyframe({ timelinePosition: 1, value: float(value) })] })
  const node = makeMotionNode({
    transform3d: { type: 'FIXED_ORDER', translateZ: 40, rotateX: 0, rotateY: 30, rotateZ: 0, backfaceVisible: false },
    manualKeyframeTracks: {
      TRANSFORM_3D_TRANSLATION_Z: track(80),
      TRANSFORM_3D_ROTATION_X: track(10),
      TRANSFORM_3D_ROTATION_Y: track(180),
      TRANSFORM_3D_ROTATION_Z: track(90),
      SCENE_3D_PERSPECTIVE: track(400),
    },
  })

  const snapshot = readMotionData(node)
  assert.deepEqual(
    snapshot?.tracks.map((one) => one.field),
    ['TRANSFORM_3D_TRANSLATION_Z', 'TRANSFORM_3D_ROTATION_X', 'TRANSFORM_3D_ROTATION_Y', 'TRANSFORM_3D_ROTATION_Z', 'SCENE_3D_PERSPECTIVE']
  )
  // The four numbers only — backface and visibility are the static export's business.
  assert.deepEqual(snapshot?.transform3d, { translateZ: 40, rotateX: 0, rotateY: 30, rotateZ: 0 })
})

test('readMotionData invents no numbers for a transform that has none', () => {
  assert.equal(readMotionData(makeMotionNode({ transform3d: { type: 'NONE' } }))?.transform3d, undefined)
  assert.equal(readMotionData(makeMotionNode({ transform3d: { type: 'FREEFORM', backfaceVisible: true } }))?.transform3d, undefined)
  // An older Figma, where the property is not there at all.
  assert.ok(!('transform3d' in (readMotionData(makeMotionNode({})) ?? {})))
})

test('readMotionData carries the 2D turn and the pivot only for a layer that has a turn', () => {
  const fixedOrder = { type: 'FIXED_ORDER', translateZ: 0, rotateX: 0, rotateY: 0, rotateZ: 0 }
  const origin = { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 50 } }
  assert.deepEqual(readMotionData(makeMotionNode({ transform3d: fixedOrder, rotation: 20, transformOrigin: origin }))?.transform3d, {
    translateZ: 0,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
    rotation: 20,
    origin,
  })
  // No turn: the static rule's own transform-origin stands, so neither is carried.
  assert.deepEqual(readMotionData(makeMotionNode({ transform3d: fixedOrder, rotation: 0, transformOrigin: origin }))?.transform3d, {
    translateZ: 0,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
  })
})
