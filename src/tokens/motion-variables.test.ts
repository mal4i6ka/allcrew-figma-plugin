/**
 * Figma's TIMING and EASING variable types (Update 133) on their way to tokens.css.
 *
 * Before these existed a duration was a FLOAT whose NAME said "duration", and an easing a STRING
 * holding CSS. The native types carry seconds and a curve object instead — the object used to
 * reach the stylesheet as "[object Object]", and a TIMING named `fast` as `0.2px`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { leaves, orderedThemes, toTokensCss, tokenKind, variablesToW3CMultiMode, type TokenGraph } from './engine.ts'

const graph = (variables: TokenGraph['variables']): TokenGraph => ({
  collections: [{ id: 'c', name: 'Motion', modes: [{ modeId: 'm', name: 'Default' }], defaultModeId: 'm' }],
  variables,
})

const cssOf = (g: TokenGraph): string => {
  const tree = variablesToW3CMultiMode(g)
  const { ordered, defaultTheme } = orderedThemes(leaves(tree))
  return toTokensCss(tree, ordered, defaultTheme, 'data-theme')
}

test('a TIMING is milliseconds with its unit, whatever it is called', () => {
  const g = graph([{ id: 'v1', name: 'fast', collectionId: 'c', resolvedType: 'TIMING', valuesByMode: { m: 0.2 } }])
  const tree = variablesToW3CMultiMode(g)
  const leaf = leaves(tree).find((l) => l.path.includes('fast'))
  assert.equal(leaf?.token.$type, 'duration')
  assert.equal(leaf?.token.$value, '200ms')
  assert.equal(tokenKind(leaf!.token, leaf!.path), 'duration')
  assert.match(cssOf(g), /--[a-z-]*fast: 200ms;/)
})

test('an EASING preset is its cubic-bezier, a custom curve its own points, LINEAR is linear', () => {
  const css = cssOf(
    graph([
      { id: 'e1', name: 'ease/out', collectionId: 'c', resolvedType: 'EASING', valuesByMode: { m: { type: 'EASE_OUT' } } },
      {
        id: 'e2',
        name: 'ease/custom',
        collectionId: 'c',
        resolvedType: 'EASING',
        valuesByMode: { m: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } } },
      },
      { id: 'e3', name: 'ease/linear', collectionId: 'c', resolvedType: 'EASING', valuesByMode: { m: { type: 'LINEAR' } } },
    ])
  )
  assert.match(css, /--ease-out: cubic-bezier\(0, 0, 0\.58, 1\);/)
  assert.match(css, /--ease-custom: cubic-bezier\(0\.2, 0, 0, 1\);/)
  assert.match(css, /--ease-linear: linear;/)
  assert.ok(!css.includes('[object Object]'))
})

test('a spring EASING is its sampled linear()', () => {
  const css = cssOf(
    graph([{ id: 'e1', name: 'ease/bouncy', collectionId: 'c', resolvedType: 'EASING', valuesByMode: { m: { type: 'BOUNCY' } } }])
  )
  assert.match(css, /--ease-bouncy: linear\(0, /)
})

test('an alias between motion tokens stays an alias', () => {
  const css = cssOf(
    graph([
      { id: 'v1', name: 'base/fast', collectionId: 'c', resolvedType: 'TIMING', valuesByMode: { m: 0.15 } },
      { id: 'v2', name: 'button/press', collectionId: 'c', resolvedType: 'TIMING', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'v1' } } },
    ])
  )
  assert.match(css, /--base-fast: 150ms;/)
  assert.match(css, /--button-press: var\(--base-fast\);/)
})
