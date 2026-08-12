import test from 'node:test'
import assert from 'node:assert/strict'
import { emitTransitionCss } from './css-emitter.ts'
import type { StateDiff } from './diff-properties.ts'

function pathToSelector(path: string): string {
  return path === '' ? '' : ` [data-path="${path}"]`
}

test('emitTransitionCss lists only the properties that changed on the base transition (never "all")', () => {
  const diff: StateDiff = {
    pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.5 }] }],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.match(result.css, /transition:\s*\n\s*opacity 300ms ease-out;/)
  assert.ok(!result.css.includes('transition: all'))
  assert.equal(result.js, undefined)
})

test('emitTransitionCss merges x and y changes into one translate declaration (not two clobbering ones)', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          { prop: 'x', from: 0, to: 10 },
          { prop: 'y', from: 0, to: -5 },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  const translateDeclarations = result.css.match(/translate: [^;]+;/g) ?? []
  assert.equal(translateDeclarations.length, 1)
  assert.equal(translateDeclarations[0], 'translate: 10px -5px;')
})

test('emitTransitionCss uses a :hover selector with no JS for a css-pseudo-class mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.8 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'linear',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('.btn:hover'))
  assert.equal(result.js, undefined)
})

test('emitTransitionCss emits a click-toggle class selector + JS for a toggle-class mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.8 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'linear',
    mechanism: { kind: 'toggle-class', event: 'click' },
  })

  assert.ok(result.css.includes('.btn.is-active'))
  assert.ok(result.js?.includes("addEventListener('click'"))
  assert.ok(result.js?.includes('classList.toggle'))
})

test('emitTransitionCss emits a setTimeout snippet for a timeout mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 0, to: 1 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.toast',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease',
    mechanism: { kind: 'timeout', timeoutMs: 1500 },
  })

  assert.ok(result.js?.includes('setTimeout'))
  assert.ok(result.js?.includes('1500'))
})

test('emitTransitionCss scopes each transition declaration to the selector that actually changes (descendants included, not just baseSelector)', () => {
  const diff: StateDiff = {
    pairs: [
      { path: 'Icon#0', changes: [{ prop: 'opacity', from: 1, to: 0.5 }] },
      { path: 'Label#0', changes: [{ prop: 'x', from: 0, to: 8 }] },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.match(result.css, /\.card \[data-path="Icon#0"\] \{\s*\n\s*transition:\s*\n\s*opacity 300ms ease-out;\s*\n\}/)
  assert.match(result.css, /\.card \[data-path="Label#0"\] \{\s*\n\s*transition:\s*\n\s*translate 300ms ease-out;\s*\n\}/)
  assert.ok(!result.css.includes('.card {\n  transition:'))
})

test('emitTransitionCss emits fade-in (0 -> 1) and fade-out (-> 0) opacity rules for added/removed nodes', () => {
  const diff: StateDiff = { pairs: [], fadeOut: ['Badge#0'], fadeIn: ['Spinner#0'] }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 250,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('.card:hover [data-path="Badge#0"] { opacity: 0; }'))
  assert.ok(result.css.includes('.card [data-path="Spinner#0"] { opacity: 0; }'))
  assert.ok(result.css.includes('.card:hover [data-path="Spinner#0"] { opacity: 1; }'))
  assert.match(result.css, /transition:\s*\n\s*opacity 250ms ease;/)
})
