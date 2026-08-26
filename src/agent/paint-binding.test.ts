import test from 'node:test'
import assert from 'node:assert/strict'
import { paintColor, sameColor } from './ops.ts'

test("a solid paint's alpha comes from its opacity, not from color", () => {
  assert.deepEqual(paintColor({ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }), {
    r: 1,
    g: 0,
    b: 0,
    a: 0.5,
  })
  // No opacity means fully opaque — not "assume the token's alpha and call it a match".
  assert.deepEqual(paintColor({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }), { r: 0, g: 0, b: 0, a: 1 })
})

test('a paint that is not a solid colour has no colour to compare', () => {
  assert.equal(paintColor({ type: 'GRADIENT_LINEAR' }), null)
  assert.equal(paintColor({ type: 'IMAGE' }), null)
  assert.equal(paintColor(null), null)
  assert.equal(paintColor(undefined), null)
})

test('float noise is not a colour difference, but a byte is', () => {
  const base = { r: 0.5, g: 0.5, b: 0.5, a: 1 }
  assert.equal(sameColor(base, { r: 0.5001, g: 0.4999, b: 0.5, a: 1 }), true)
  assert.equal(sameColor(base, { r: 0.51, g: 0.5, b: 0.5, a: 1 }), false)
})

test('a colour matching in rgb but not in alpha is still a mismatch', () => {
  const base = { r: 0, g: 0, b: 0, a: 1 }
  assert.equal(sameColor(base, { r: 0, g: 0, b: 0, a: 0.5 }), false)
})
