import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDiff, pathToSelector } from './transition-ops.ts'

test('a matched path becomes a descendant selector, duplicate index stripped', () => {
  assert.equal(pathToSelector(''), '')
  assert.equal(pathToSelector('Badge'), ' .badge')
  assert.equal(pathToSelector('Card/Badge#2'), ' .card .badge')
  assert.equal(pathToSelector('Button Label/Icon'), ' .button-label .icon')
})

test('a path segment that slugifies to nothing still yields a usable class', () => {
  assert.equal(pathToSelector('🌅'), ' .layer')
  assert.equal(pathToSelector('Card/✨#3'), ' .card .layer')
})

test('a diff is summarised by what moved, not by coordinates', () => {
  const summary = describeDiff({
    pairs: [
      { path: 'Badge', changes: [{ prop: 'x', from: 0, to: 10 }, { prop: 'opacity', from: 1, to: 0.5 }] },
      { path: 'Label', changes: [] },
      { path: 'Icon', changes: [{ prop: 'x', from: 4, to: 8 }] },
    ],
    fadeIn: ['Spinner'],
    fadeOut: ['Chevron', 'Dot'],
  })
  assert.deepEqual(summary, { moved: 2, fadeIn: 1, fadeOut: 2, properties: ['opacity', 'x'] })
})

test('a diff where nothing changed reports nothing changed', () => {
  assert.deepEqual(describeDiff({ pairs: [{ path: 'Badge', changes: [] }], fadeIn: [], fadeOut: [] }), {
    moved: 0,
    fadeIn: 0,
    fadeOut: 0,
    properties: [],
  })
})
