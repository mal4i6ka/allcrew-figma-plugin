import test from 'node:test'
import assert from 'node:assert/strict'
import { emitGsapTimeline, type GsapTimelineNode } from './gsap-emitter.ts'
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

function makeNode(overrides: Partial<GsapTimelineNode>): GsapTimelineNode {
  return {
    nodeId: '1:1',
    tracks: [],
    ...overrides,
  }
}

test('opacity fade with LINEAR easing uses fromTo and a terminal 100% keyframe', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        nodeId: '1:1',
        tracks: [
          makeTrack({
            field: 'OPACITY',
            baseValue: { type: 'FLOAT', value: 0 },
            keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /tl\.fromTo\(q\("\[data-node-id=\\"1:1\\"\]"\), \{"opacity":0\}/)
  assert.match(result.js, /"100%":\{"opacity":1,"ease":"none"\}/)
  assert.equal(result.usedPlugins.length, 0)
})

test('a keyframe at position 0 is dropped from keyframes since fromVars already covers it', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            baseValue: { type: 'FLOAT', value: 0 },
            keyframes: [
              { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
              { id: 'kf-1', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } },
            ],
          }),
        ],
      }),
    ],
  })

  assert.doesNotMatch(result.js, /"0%":/)
})

test('named bezier preset registers a single deduplicated CustomEase', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'TRANSLATION_Y',
            baseValue: { type: 'FLOAT', value: 40 },
            keyframes: [
              { id: 'kf-0', timelinePosition: 0.5, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: 0 } },
            ],
          }),
          makeTrack({
            field: 'SCALE_X',
            baseValue: { type: 'FLOAT', value: 0.9 },
            keyframes: [
              { id: 'kf-1', timelinePosition: 0.5, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: 1 } },
            ],
          }),
        ],
      }),
    ],
  })

  const matches = [...result.js.matchAll(/CustomEase\.create/g)]
  assert.equal(matches.length, 1)
  assert.match(result.js, /CustomEase\.create\("figmaEase0", "0, 0, 0\.58, 1"\)/)
  assert.match(result.js, /gsap\.registerPlugin\(CustomEase\)/)
  assert.equal(result.usedPlugins.length, 1)
  assert.equal(result.usedPlugins[0], 'CustomEase')
})

test('CUSTOM_CUBIC_BEZIER easing uses its exact control points', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            keyframes: [
              {
                id: 'kf-0',
                timelinePosition: 1,
                easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 } },
                value: { type: 'FLOAT', value: 1 },
              },
            ],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /CustomEase\.create\("figmaEase0", "0\.1, 0\.2, 0\.3, 0\.4"\)/)
})

test('spring with bounce <= 0.25 resolves to back.out with the documented formula', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'TRANSLATION_Y',
            keyframes: [
              {
                id: 'kf-0',
                timelinePosition: 1,
                easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.2 } },
                value: { type: 'FLOAT', value: 0 },
              },
            ],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /"ease":"back\.out\(1\.5\)"/)
  assert.equal(result.usedPlugins.length, 0)
})

test('spring with bounce > 0.25 registers a sampled ease exactly once via the inlined lerp helper', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'TRANSLATION_Y',
            keyframes: [
              {
                id: 'kf-0',
                timelinePosition: 0.5,
                easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.6 } },
                value: { type: 'FLOAT', value: 10 },
              },
            ],
          }),
          makeTrack({
            field: 'SCALE_X',
            keyframes: [
              {
                id: 'kf-1',
                timelinePosition: 0.5,
                easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.6 } },
                value: { type: 'FLOAT', value: 1 },
              },
            ],
          }),
        ],
      }),
    ],
  })

  const helperMatches = [...result.js.matchAll(/function __figmaLerpEase/g)]
  assert.equal(helperMatches.length, 1)
  const registerMatches = [...result.js.matchAll(/gsap\.registerEase\("figmaSpring0", __figmaLerpEase/g)]
  assert.equal(registerMatches.length, 1)
})

test('HOLD easing maps to ease: none', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            keyframes: [{ id: 'kf-0', timelinePosition: 0.5, easing: { type: 'HOLD' }, value: { type: 'FLOAT', value: 1 } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /"50%":\{"opacity":1,"ease":"none"\}/)
})

test('missing terminal 100% keyframe gets a synthetic entry duplicating the last value', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            keyframes: [{ id: 'kf-0', timelinePosition: 0.5, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /"100%":\{"opacity":1,"ease":"none"\}/)
})

test('VECTOR field (TRANSLATION_XY) splits into x and y in the same keyframe', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'TRANSLATION_XY',
            baseValue: { type: 'VECTOR', value: { x: 0, y: 0 } },
            keyframes: [
              { id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'VECTOR', value: { x: 10, y: 20 } } },
            ],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /\{"x":0,"y":0\}/)
  assert.match(result.js, /"100%":\{"x":10,"y":20,"ease":"none"\}/)
})

test('PATH_TRIM_START and PATH_TRIM_END merge into a single DrawSVGPlugin tween', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'PATH_TRIM_START',
            baseValue: { type: 'FLOAT', value: 0 },
            keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
          }),
          makeTrack({
            field: 'PATH_TRIM_END',
            baseValue: { type: 'FLOAT', value: 1 },
            keyframes: [],
          }),
        ],
      }),
    ],
  })

  const drawSvgMatches = [...result.js.matchAll(/drawSVG/g)]
  assert.equal(drawSvgMatches.length, 2)
  assert.match(result.js, /"drawSVG":"0% 100%"/)
  assert.match(result.js, /"100%":\{"drawSVG":"100% 100%","ease":"none"\}/)
  assert.equal(result.usedPlugins.length, 1)
  assert.equal(result.usedPlugins[0], 'DrawSVGPlugin')
})

test('TEXT_DATA track uses TextPlugin with text: {value}', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            baseValue: { type: 'TEXT_DATA', value: 'Hello' },
            keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'TEXT_DATA', value: 'World' } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /\{"text":\{"value":"Hello"\}\}/)
  assert.match(result.js, /"100%":\{"text":\{"value":"World"\},"ease":"none"\}/)
  assert.equal(result.usedPlugins.length, 1)
  assert.equal(result.usedPlugins[0], 'TextPlugin')
})

test('nodes are addressed via data-node-id in the generated selector text', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        nodeId: '42:7',
        tracks: [
          makeTrack({
            field: 'OPACITY',
            keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /data-node-id=\\"42:7\\"/)
})

test('overall script structure matches the DOMContentLoaded + IntersectionObserver skeleton', () => {
  const result = emitGsapTimeline({
    timelineId: 'hero',
    duration: 1,
    nodes: [
      makeNode({
        tracks: [
          makeTrack({
            field: 'OPACITY',
            keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
          }),
        ],
      }),
    ],
  })

  assert.match(result.js, /DOMContentLoaded/)
  assert.match(result.js, /IntersectionObserver/)
  assert.match(result.js, /paused: true/)
  assert.match(result.js, /prefers-reduced-motion/)
  assert.match(result.js, /data-timeline="hero"/)
})

/* ------------------------------------------------- 3D transforms (typings 1.143.0, beta) */

const turn3d = (field: MotionTrack['field'], from: number, to: number): MotionTrack =>
  makeTrack({
    field,
    baseValue: { type: 'FLOAT', value: from },
    keyframes: [{ id: 'kf-1', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: to } }],
  })

test('a 3D track tweens a custom property with its unit, not GSAP’s own rotationY', () => {
  const result = emitGsapTimeline({
    timelineId: 'flip',
    duration: 1,
    nodes: [makeNode({ selector: '.card', tracks: [turn3d('TRANSFORM_3D_ROTATION_Y', 0, 180), turn3d('TRANSFORM_3D_TRANSLATION_Z', 0, 40)] })],
  })
  assert.match(result.js, /tl\.fromTo\(q\("\.card"\), \{"--motion-rotate-y":"0deg"\}/)
  assert.match(result.js, /"100%":\{"--motion-rotate-y":"180deg","ease":"none"\}/)
  assert.match(result.js, /\{"--motion-translate-z":"0px"\}/)
  assert.doesNotMatch(result.js, /rotationY|"z":/)
})

test('the composite transform is written on the element in Figma’s order, with the static axes filled in', () => {
  const result = emitGsapTimeline({
    timelineId: 'flip',
    duration: 1,
    nodes: [
      makeNode({
        selector: '.card',
        tracks: [turn3d('TRANSFORM_3D_ROTATION_Y', 0, 180)],
        transform3d: { translateZ: 40, rotateX: 10, rotateY: 0, rotateZ: 0 },
      }),
    ],
  })
  assert.match(
    result.js,
    /q\("\.card"\)\.forEach\(function \(el\) \{ el\.style\.transform = "translateZ\(40px\) rotateX\(10deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(0deg\)"; \}\);/
  )
  // Before the tween that drives it.
  assert.ok(result.js.indexOf('el.style.transform') < result.js.indexOf('--motion-rotate-y":"0deg"'))
})

test('3D tracks are left out, with a warning, when GSAP owns the same element’s transform', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
  try {
    const result = emitGsapTimeline({
      timelineId: 'mixed',
      duration: 1,
      nodes: [makeNode({ nodeId: '7:7', selector: '.card', tracks: [turn3d('TRANSLATION_X', 0, 100), turn3d('TRANSFORM_3D_ROTATION_Y', 0, 180)] })],
    })
    assert.match(result.js, /\{"x":0\}/)
    assert.doesNotMatch(result.js, /--motion-rotate-y|el\.style\.transform/)
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /node "7:7" animates both 2D transform tracks and 3D transform tracks.*TRANSFORM_3D_ROTATION_Y/)
})

test('a perspective track is a plain tween on the container', () => {
  const result = emitGsapTimeline({
    timelineId: 'scene',
    duration: 1,
    nodes: [makeNode({ selector: '.scene', tracks: [turn3d('SCENE_3D_PERSPECTIVE', 800, 400)] })],
  })
  assert.match(result.js, /tl\.fromTo\(q\("\.scene"\), \{"perspective":800\}/)
  assert.doesNotMatch(result.js, /el\.style\.transform/)
})
