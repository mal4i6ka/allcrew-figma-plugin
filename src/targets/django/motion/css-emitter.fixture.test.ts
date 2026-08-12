/**
 * Fixture-driven unit tests (T7.2, docs/PLAN.md E7): exercises the keyframes emitter
 * (`emitKeyframesRule`/`emitNodeAnimationCss`) against `tests/fixtures/motion/translation-track.json`
 * and `tests/fixtures/motion/node-animation.json`. Complements css-emitter.test.ts's inline-mock
 * unit tests with coverage driven from fixture files, per the DoD's "on fixtures from
 * tests/fixtures/" requirement.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emitKeyframesRule, emitNodeAnimationCss } from './css-emitter.ts'
import type { MotionTrack } from './types.ts'

function readFixture(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/motion/${relativePath}`, import.meta.url), 'utf8'))
}

test('emitKeyframesRule converts the fixture timelinePosition/duration to percentages and shifts easing to the previous block', () => {
  const track: MotionTrack = readFixture('translation-track.json')

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

test('emitNodeAnimationCss emits base declarations, animation shorthand and @keyframes rule for the fixture node', () => {
  const input = readFixture('node-animation.json')

  const css = emitNodeAnimationCss(input)

  assert.equal(
    css,
    [
      '.card-9c41 {',
      '  opacity: 0;',
      '  animation:',
      '    card-9c41-opacity 0.8s linear both;',
      '}',
      '',
      '@media (prefers-reduced-motion: reduce) {',
      '  .card-9c41 {',
      '    animation: none;',
      '  }',
      '}',
      '',
      '@keyframes card-9c41-opacity {',
      '  0% { opacity: 0; animation-timing-function: cubic-bezier(0, 0, 0.58, 1); }',
      '  100% { opacity: 1; }',
      '}',
    ].join('\n')
  )
})
