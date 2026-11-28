import test from 'node:test'
import assert from 'node:assert/strict'
import { scaleCssUnits } from './units.ts'

test('pixels become rems at the scale Dev Mode hands over, zero loses its unit', () => {
  assert.equal(
    scaleCssUnits('.card { padding: 16px 24px; border: 1px solid; margin: 0px; top: -8px; }', 16),
    '.card { padding: 1rem 1.5rem; border: 0.0625rem solid; margin: 0; top: -0.5rem; }'
  )
})

test('only real pixel values move — not names, ids or hex that happen to end in px', () => {
  assert.equal(scaleCssUnits('.w-12px { width: 12px; } #a12px {}', 16), '.w-12px { width: 0.75rem; } #a12px {}')
  assert.equal(scaleCssUnits('@media (min-width: 768px) { a { gap: 2.5px } }', 16), '@media (min-width: 48rem) { a { gap: 0.1563rem } }')
})

test('a scale that is not a scale leaves the CSS alone', () => {
  assert.equal(scaleCssUnits('a { width: 10px }', 0), 'a { width: 10px }')
})
