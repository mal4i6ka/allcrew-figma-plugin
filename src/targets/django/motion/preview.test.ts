import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewDocument, type PreviewNode } from './preview.ts'
import { emitNodeAnimationCss } from './css-emitter.ts'
import { emitGsapTimeline } from './gsap-emitter.ts'
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

function makeNode(overrides: Partial<PreviewNode>): PreviewNode {
  return {
    nodeId: '1:1',
    tracks: [],
    html: '<div data-node-id="1:1">card</div>',
    ...overrides,
  }
}

test('buildPreviewDocument picks css for a single-node bezier fade and embeds exactly emitNodeAnimationCss\'s output', () => {
  const track = makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'EASE_OUT', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } }, value: { type: 'FLOAT', value: 1 } }],
  })
  const node = makeNode({ nodeId: '1:1', tracks: [track] })

  const result = buildPreviewDocument({
    timelineId: 'hero',
    duration: 1,
    nodes: [node],
    trigger: 'autoplay',
  })

  assert.equal(result.backend, 'css')
  const expectedCss = emitNodeAnimationCss({ selector: '[data-node-id="1:1"]', tracks: [track] })
  assert.ok(result.html.includes(expectedCss), 'preview html does not contain the exact emitNodeAnimationCss output')
  assert.ok(result.html.includes(node.html), 'preview html does not contain the node\'s static markup')
  assert.match(result.html, /<body data-timeline="hero">/)
})

test('buildPreviewDocument picks gsap for a bouncy spring and embeds exactly emitGsapTimeline\'s script', () => {
  const track = makeTrack({
    field: 'TRANSLATION_Y',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.6 } }, value: { type: 'FLOAT', value: 100 } }],
  })
  const node = makeNode({ nodeId: '1:1', tracks: [track] })

  const result = buildPreviewDocument({
    timelineId: 'hero',
    duration: 1,
    nodes: [node],
    trigger: 'autoplay',
    gsapRuntimeJs: '/* gsap core stub */',
  })

  assert.equal(result.backend, 'gsap')
  const expected = emitGsapTimeline({ timelineId: 'hero', duration: 1, nodes: [{ nodeId: '1:1', tracks: [track] }] })
  assert.ok(result.html.includes(expected.js), 'preview html does not contain the exact emitGsapTimeline output')
  assert.ok(result.html.includes('/* gsap core stub */'), 'preview html does not inline the supplied gsap runtime')
})

test('buildPreviewDocument throws when the picked gsap backend needs plugins but no runtime was supplied', () => {
  const track = makeTrack({
    field: 'PATH_TRIM_START',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
  })
  const endTrack = makeTrack({
    field: 'PATH_TRIM_END',
    baseValue: { type: 'FLOAT', value: 1 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
  })
  const node = makeNode({ nodeId: '1:1', tracks: [track, endTrack] })

  assert.throws(
    () => buildPreviewDocument({ timelineId: 'hero', duration: 1, nodes: [node], trigger: 'autoplay' }),
    /GSAP preview needs plugins/
  )
})

test('buildPreviewDocument respects a backend override even when the automatic rule would pick the other backend', () => {
  const track = makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
  })
  const node = makeNode({ nodeId: '1:1', tracks: [track] })

  const result = buildPreviewDocument({
    timelineId: 'hero',
    duration: 1,
    nodes: [node],
    trigger: 'autoplay',
    backendOverride: 'gsap',
    gsapRuntimeJs: '/* gsap core stub */',
  })

  assert.equal(result.backend, 'gsap')
  assert.equal(result.reason, 'override')
})
