import test from 'node:test'
import assert from 'node:assert/strict'
import { emitMotionExportArtifacts } from './export-assets.ts'
import type { MotionSnapshot, MotionTrack } from './types.ts'

function makeTrack(overrides: Partial<MotionTrack> = {}): MotionTrack {
  return {
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 1,
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
      { id: 'kf-1', timelinePosition: 1, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: 1 } },
    ],
    ...overrides,
  }
}

function makeSnapshot(tracks: readonly MotionTrack[], timelineId = 'hero', duration = 1): MotionSnapshot {
  return {
    animationStyles: [],
    timelines: [{ id: timelineId, duration } as Timeline],
    tracks,
  }
}

test('emitMotionExportArtifacts emits linked CSS animations for a CSS-eligible timeline', () => {
  const result = emitMotionExportArtifacts([
    { nodeId: '1:1', snapshot: makeSnapshot([makeTrack()]) },
  ])

  assert.equal(result.animationLinks.animationsCss, true)
  assert.equal(result.animationLinks.animationsJs, false)
  assert.equal(result.animation.js, '')
  assert.match(result.animation.css, /\.n1-1 \{/)
  assert.match(result.animation.css, /@keyframes n1-1-hero-opacity/)
  assert.match(result.animation.css, /prefers-reduced-motion/)
})

test('emitMotionExportArtifacts chooses GSAP for a bouncy spring timeline', () => {
  const result = emitMotionExportArtifacts([
    {
      nodeId: '1:1',
      snapshot: makeSnapshot([
        makeTrack({
          field: 'TRANSLATION_Y',
          baseValue: { type: 'FLOAT', value: 0 },
          keyframes: [
            {
              id: 'kf-0',
              timelinePosition: 1,
              easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
              value: { type: 'FLOAT', value: 120 },
            },
          ],
        }),
      ]),
    },
  ])

  assert.equal(result.animationLinks.animationsCss, false)
  assert.equal(result.animationLinks.animationsJs, true)
  assert.match(result.animation.js, /gsap\.timeline/)
  assert.match(result.animation.js, /\.n1-1/)
  assert.match(result.animation.js, /prefers-reduced-motion/)
})

test('emitMotionExportArtifacts chooses GSAP for three-node orchestration', () => {
  const nodes = ['1:1', '1:2', '1:3'].map((nodeId) => ({
    nodeId,
    snapshot: makeSnapshot([makeTrack()], 'hero', 1),
  }))

  const result = emitMotionExportArtifacts(nodes)

  assert.equal(result.animationLinks.animationsJs, true)
  assert.equal(result.animation.css, '')
  assert.match(result.animation.js, /\.n1-1/)
  assert.match(result.animation.js, /\.n1-2/)
  assert.match(result.animation.js, /\.n1-3/)
})
