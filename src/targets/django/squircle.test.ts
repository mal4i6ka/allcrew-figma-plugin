import test from 'node:test'
import assert from 'node:assert/strict'
import { scaleBorderRadius } from './css-emitter.ts'

test('a plain radius is scaled by the squircle factor', () => {
  assert.equal(scaleBorderRadius('16px', 0.6), '21.76px')
  assert.equal(scaleBorderRadius('8px', 1), '12.8px')
  assert.equal(scaleBorderRadius('16px', 0), '16px')
})

test('every corner of a multi-value radius is scaled', () => {
  assert.equal(scaleBorderRadius('8px 8px 0 0', 0.6), '10.88px 10.88px 0 0')
  assert.equal(scaleBorderRadius('4px 8px / 2px 6px', 0.5), '5.2px 10.4px / 2.6px 7.8px')
})

test('a token-bound radius keeps reading its token', () => {
  // Scaling the fallback alone is the bug this guards: where `--radius-x-large` is defined the
  // browser would take 16px and the smoothing would vanish without a trace.
  assert.equal(
    scaleBorderRadius('var(--radius-x-large, 16px)', 0.6),
    'calc(var(--radius-x-large, 16px) * 1.36)'
  )
  assert.equal(scaleBorderRadius('var(--r)', 0.5), 'calc(var(--r) * 1.3)')
})

test('a var() component survives the space inside its own fallback', () => {
  assert.equal(
    scaleBorderRadius('var(--a, 4px) 8px', 0.6),
    'calc(var(--a, 4px) * 1.36) 10.88px'
  )
})

test('percentages and zero are left alone', () => {
  assert.equal(scaleBorderRadius('50%', 0.6), '50%')
  assert.equal(scaleBorderRadius('0', 0.6), '0')
  assert.equal(scaleBorderRadius('50% 50% 0 0', 0.6), '50% 50% 0 0')
})
