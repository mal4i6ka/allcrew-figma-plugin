import test from 'node:test'
import assert from 'node:assert/strict'
import { emitViewTransition, namesForPaths, pathToViewTransitionName } from './view-transitions.ts'

test('pathToViewTransitionName sanitizes a NodePath into a valid CSS custom-ident', () => {
  assert.equal(pathToViewTransitionName('Icon Wrap/Icon#0'), 'icon-wrap-icon-0')
  assert.equal(pathToViewTransitionName(''), 'node')
  assert.equal(pathToViewTransitionName('###'), 'node')
})

test('namesForPaths builds one entry per path', () => {
  assert.deepEqual(namesForPaths(['Header#0', 'Footer#0']), [
    { path: 'Header#0', name: 'header-0' },
    { path: 'Footer#0', name: 'footer-0' },
  ])
})

test('emitViewTransition injects view-transition-name per node and group timing from duration/easing', () => {
  const result = emitViewTransition({
    pathToSelector: (path) => `[data-path="${path}"]`,
    names: namesForPaths(['Icon#0']),
    durationMs: 300,
    timingFunction: 'cubic-bezier(0.42, 0, 1, 1)',
    toggleSelector: '.nav-link',
    toggleClass: 'is-active',
  })

  assert.ok(result.css.includes('[data-path="Icon#0"] { view-transition-name: icon-0; }'))
  assert.ok(result.css.includes('::view-transition-group(icon-0) {'))
  assert.ok(result.css.includes('animation-duration: 300ms;'))
  assert.ok(result.css.includes('animation-timing-function: cubic-bezier(0.42, 0, 1, 1);'))
})

test('emitViewTransition wraps the state change in startViewTransition with a no-VT fallback', () => {
  const result = emitViewTransition({
    pathToSelector: (path) => `[data-path="${path}"]`,
    names: [],
    durationMs: 300,
    timingFunction: 'ease',
    toggleSelector: '.nav-link',
    toggleClass: 'is-active',
  })

  assert.match(result.js, /document\.startViewTransition/)
  assert.match(result.js, /if \(!document\.startViewTransition\)/)
  assert.match(result.js, /classList\.toggle\("is-active"\)/)
})
