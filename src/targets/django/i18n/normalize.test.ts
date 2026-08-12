import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, translationKey } from './normalize.ts'

test('normalize collapses a layout-driven soft wrap into a single space', () => {
  assert.equal(normalize('Read the docs\nbefore starting'), 'Read the docs before starting')
})

test('normalize collapses U+2028/U+2029 separators and repeated whitespace', () => {
  const withSeparators = 'Line one' + String.fromCharCode(0x2028) + 'Line two' + String.fromCharCode(0x2029) + 'Line three'
  assert.equal(normalize(withSeparators), 'Line one Line two Line three')
  assert.equal(normalize('  extra   spaces  '), 'extra spaces')
})

test('normalize is idempotent so export and import agree on the same key', () => {
  const text = '  Place  \n order  '
  assert.equal(normalize(normalize(text)), normalize(text))
})

test('translationKey combines msgctxt and the normalized text so different contexts never collide', () => {
  const a = translationKey('checkout', 'Place order')
  const b = translationKey('nav', 'Place order')
  const c = translationKey('checkout', 'Place  \norder')

  assert.notEqual(a, b)
  assert.equal(a, c)
})
