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

test('emitKeyframesRule holds a late first keyframe from 0% — the layer’s base value is never shown', () => {
  // Rendered by Figma on 19.11.2026: a track whose first keyframe is at 1.5 s of 3 shows that
  // keyframe's value from 0 s. This used to emit the base value at 0% and animate towards it.
  const css = emitKeyframesRule('delayed', makeTrack({
    field: 'OPACITY',
    baseValue: { type: 'FLOAT', value: 0 },
    timelineDuration: 2,
    keyframes: [{ id: 'kf-0', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } }],
  }))

  assert.match(css, /0% \{ opacity: 1; \}/)
  assert.match(css, /50% \{ opacity: 1; \}/)
  assert.doesNotMatch(css, /opacity: 0/)
})

test('the element’s own declaration is where the timeline starts, not the layer’s base value', () => {
  const css = emitNodeAnimationCss({
    selector: '.box',
    tracks: [
      makeTrack({
        field: 'TRANSLATION_X',
        baseValue: { type: 'FLOAT', value: 0 },
        timelineDuration: 3,
        keyframes: [
          { id: 'a', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 300 } },
          { id: 'b', timelinePosition: 3, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
        ],
      }),
    ],
  })
  assert.match(css, /\.box \{\n  translate: 300px 0px;/)
  assert.match(css, /0% \{ translate: 300px 0px; animation-timing-function: linear; \}/)
  assert.match(css, /100% \{ translate: 0px 0px; \}/)
})

test('keyframes given out of order are put in order', () => {
  const css = emitKeyframesRule('shuffled', makeTrack({
    field: 'OPACITY',
    timelineDuration: 2,
    keyframes: [
      { id: 'b', timelinePosition: 2, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 1 } },
      { id: 'a', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0.2 } },
    ],
  }))
  assert.ok(css.indexOf('0% { opacity: 0.2;') < css.indexOf('100% { opacity: 1; }'))
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

/* ------------------------------------------------- 3D transforms (typings 1.143.0, beta) */

const turn = (field: MotionTrack['field'], from: number, to: number): MotionTrack =>
  makeTrack({
    field,
    baseValue: { type: 'FLOAT', value: from },
    // From the start: before its first keyframe a track holds that keyframe's value, so a
    // movement that begins at 0 has a keyframe there.
    keyframes: [
      { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: from } },
      { id: 'kf-1', timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: to } },
    ],
  })

test('a 3D track animates a registered custom property, in the unit Figma holds it in', () => {
  assert.equal(
    emitKeyframesRule('flip', turn('TRANSFORM_3D_ROTATION_Y', 0, 180)),
    ['@keyframes flip {', '  0% { --motion-rotate-y: 0deg; animation-timing-function: linear; }', '  100% { --motion-rotate-y: 180deg; }', '}'].join('\n')
  )
  assert.match(emitKeyframesRule('depth', turn('TRANSFORM_3D_TRANSLATION_Z', 0, 40)), /--motion-translate-z: 40px;/)
  assert.match(emitKeyframesRule('x', turn('TRANSFORM_3D_ROTATION_X', 0, 10)), /--motion-rotate-x: 10deg;/)
  assert.match(emitKeyframesRule('z', turn('TRANSFORM_3D_ROTATION_Z', 0, 10)), /--motion-rotate-z: 10deg;/)
})

test('the composite transform keeps Figma’s order whatever order the tracks arrive in', () => {
  const css = emitNodeAnimationCss({
    selector: '.card',
    // Deliberately backwards.
    tracks: [turn('TRANSFORM_3D_ROTATION_Z', 0, 90), turn('TRANSFORM_3D_ROTATION_Y', 0, 180), turn('TRANSFORM_3D_ROTATION_X', 0, 45), turn('TRANSFORM_3D_TRANSLATION_Z', 0, 40)],
  })
  assert.match(
    css,
    /  transform: translateZ\(var\(--motion-translate-z\)\) rotateX\(var\(--motion-rotate-x\)\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(var\(--motion-rotate-z\)\);/
  )
  // One declaration, not one per track.
  assert.equal(css.match(/^  transform:/gm)?.length, 1)
})

test('an axis without a track is the layer’s own number, and zero when nothing was given', () => {
  const tracks = [turn('TRANSFORM_3D_ROTATION_Y', 30, 180)]
  const withStatic = emitNodeAnimationCss({ selector: '.card', tracks, transform3d: { translateZ: 40, rotateX: 5.5, rotateY: 30, rotateZ: 0 } })
  assert.match(withStatic, /  transform: translateZ\(40px\) rotateX\(5\.5deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(0deg\);/)
  // The tracked axis starts from the track's base value, not from the static transform.
  assert.match(withStatic, /  --motion-rotate-y: 30deg;/)

  const bare = emitNodeAnimationCss({ selector: '.card', tracks })
  assert.match(bare, /  transform: translateZ\(0px\) rotateX\(0deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(0deg\);/)
})

test('the custom properties are registered so they interpolate, and a caller may write them once itself', () => {
  const tracks = [turn('TRANSFORM_3D_ROTATION_Y', 0, 180)]
  const css = emitNodeAnimationCss({ selector: '.card', tracks })
  assert.ok(css.startsWith("@property --motion-translate-z { syntax: '<length>'; inherits: false; initial-value: 0px; }"))
  assert.match(css, /@property --motion-rotate-y \{ syntax: '<angle>'; inherits: false; initial-value: 0deg; \}/)
  assert.equal(css.match(/@property/g)?.length, 4)

  assert.doesNotMatch(emitNodeAnimationCss({ selector: '.card', tracks, registerProperties: false }), /@property/)
  // No 3D track, no registration and no composite transform.
  const flat = emitNodeAnimationCss({ selector: '.card', tracks: [turn('OPACITY', 0, 1)] })
  assert.doesNotMatch(flat, /@property|transform:/)
})

test('a 3D track sits beside the standalone 2D properties without touching them', () => {
  const css = emitNodeAnimationCss({ selector: '.card', tracks: [turn('ROTATION', 0, 90), turn('TRANSFORM_3D_ROTATION_X', 0, 45)] })
  assert.match(css, /  rotate: 0deg;/)
  assert.match(css, /  transform: translateZ\(0px\) rotateX\(var\(--motion-rotate-x\)\) rotateY\(0deg\) rotateZ\(0deg\);/)
})

test('perspective is plain CSS on the container, and needs no composite transform', () => {
  const css = emitNodeAnimationCss({ selector: '.scene', tracks: [turn('SCENE_3D_PERSPECTIVE', 800, 400)] })
  assert.match(css, /  perspective: 800px;/)
  assert.match(css, /100% \{ perspective: 400px; \}/)
  assert.doesNotMatch(css, /@property|transform:/)
})

test('an animated layer that is also turned in 2D keeps its 2D turn and its pivot while it moves', () => {
  const tracks = [turn('TRANSFORM_3D_ROTATION_Y', 0, 180)]
  // Figma's rotation is counter-clockwise; CSS's is clockwise — 20 becomes -20, as getCSSAsync writes it.
  const centred = emitNodeAnimationCss({ selector: '.card', tracks, transform3d: { translateZ: 0, rotateX: 25, rotateY: 0, rotateZ: 10, rotation: 20 } })
  assert.match(
    centred,
    /  transform: rotate\(-20deg\) translate\(50%, 50%\) translateZ\(0px\) rotateX\(25deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(10deg\) translate\(-50%, -50%\);/
  )

  const hinged = emitNodeAnimationCss({
    selector: '.card',
    tracks,
    transform3d: { translateZ: 0, rotateX: 0, rotateY: 0, rotateZ: 0, rotation: -15, origin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 50 } } },
  })
  assert.match(hinged, /  transform: rotate\(15deg\) translate\(0px, 50%\) translateZ\(0px\) rotateX\(0deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(0deg\) translate\(0px, -50%\);/)

  // With the pivot at the top-left there is nothing to bake.
  const corner = emitNodeAnimationCss({
    selector: '.card',
    tracks,
    transform3d: { translateZ: 0, rotateX: 0, rotateY: 0, rotateZ: 0, rotation: 90, origin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 0 } } },
  })
  assert.match(corner, /  transform: rotate\(-90deg\) translateZ\(0px\) rotateX\(0deg\) rotateY\(var\(--motion-rotate-y\)\) rotateZ\(0deg\);/)
})
