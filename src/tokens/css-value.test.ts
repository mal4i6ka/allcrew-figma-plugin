/**
 * Emission precision — Figma hands the plugin raw floats (`9.899999618530273`), and a token file
 * that prints them teaches agents that the noise is data. Everything numeric is rounded to ≤2
 * decimals on the way out; `tokens.json` keeps whatever Figma stored.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { cssValue } from './engine.ts'

test('px values are rounded to at most two decimals', () => {
  assert.equal(cssValue(9.899999618530273, ['font-size', '3xs']), '9.9px')
  assert.equal(cssValue(14.850000381469727, ['line-height', '3xs']), '14.85px')
  assert.equal(cssValue(3.9999998474121094, ['number', 'Half']), '4px')
  assert.equal(cssValue(16, ['spacing', 'md']), '16px')
})

test('unitless values are rounded the same way', () => {
  assert.equal(cssValue(0.30000001192092896, ['opacity', 'muted']), '0.3')
  assert.equal(cssValue(1.4666666666, ['line-height', 'body']), '1.47')
  assert.equal(cssValue(500, ['font-weight', 'medium']), '500')
})

test('rounding never invents a value class change', () => {
  // A near-zero float rounds to plain 0, not "0px" vs "0" ambiguity.
  assert.equal(cssValue(0.0001, ['spacing', 'none']), '0')
  assert.equal(cssValue(0, ['spacing', 'none']), '0')
})
