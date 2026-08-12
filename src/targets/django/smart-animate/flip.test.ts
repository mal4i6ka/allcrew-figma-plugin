import test from 'node:test'
import assert from 'node:assert/strict'
import { emitFlipToggle } from './flip.ts'

test('emitFlipToggle parameterizes root selector, toggle class, duration and easing', () => {
  const js = emitFlipToggle({
    rootSelector: '.card',
    toggleClass: 'is-expanded',
    durationMs: 250,
    timingFunction: 'cubic-bezier(0.42, 0, 1, 1)',
  })

  assert.match(js, /document\.querySelector\("\.card"\)/)
  assert.match(js, /"is-expanded"/)
  assert.match(js, /getBoundingClientRect/)
  assert.match(js, /\.animate\(/)
  assert.match(js, /250, "cubic-bezier\(0\.42, 0, 1, 1\)"/)
})

test('emitFlipToggle defaults the FLIP marker attribute to data-flip', () => {
  const js = emitFlipToggle({ rootSelector: '.card', toggleClass: 'is-expanded', durationMs: 100, timingFunction: 'linear' })
  assert.match(js, /\[data-flip\]/)
})

test('emitFlipToggle honors a custom FLIP marker attribute', () => {
  const js = emitFlipToggle({
    rootSelector: '.card',
    toggleClass: 'is-expanded',
    durationMs: 100,
    timingFunction: 'linear',
    flipAttribute: 'data-anim-child',
  })
  assert.match(js, /\[data-anim-child\]/)
  assert.ok(!js.includes('[data-flip]'))
})

test('emitFlipToggle guards against a zero-size element to avoid dividing by zero', () => {
  const js = emitFlipToggle({ rootSelector: '.card', toggleClass: 'is-expanded', durationMs: 100, timingFunction: 'linear' })
  assert.match(js, /last\[i\]\.width === 0 \? 1 : /)
  assert.match(js, /last\[i\]\.height === 0 \? 1 : /)
})
