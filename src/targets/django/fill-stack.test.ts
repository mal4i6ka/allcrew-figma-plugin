import test from 'node:test'
import assert from 'node:assert/strict'

/* The fill sandwich in CSS.
 *
 * Figma writes a layered fill as comma-separated layers and hands the variables the field
 * reaches back as one flat list. Taking `boundVariables.fills[0]` for "the colour of this box"
 * and wrapping the whole declaration in it produced, on a banner painted colour + shader +
 * photo, `background: var(--orange, url(…), var(--white, #FFF))` — a declaration that keeps one
 * layer, and that layer a colour the banner never showed. */

import { singleLayer, tokenOverrides } from './css-emitter.ts'

test('a one-layer value is one layer, whatever commas sit inside its functions', () => {
  assert.equal(singleLayer(undefined), true)
  assert.equal(singleLayer('#FFF'), true)
  assert.equal(singleLayer('var(--white, #FFF)'), true)
  assert.equal(singleLayer('rgba(0, 0, 0, 0.5)'), true)
  assert.equal(singleLayer('linear-gradient(90deg, #000 0%, #FFF 100%)'), true)
})

test('a stack is more than one layer', () => {
  assert.equal(singleLayer('url(a.png) no-repeat, var(--white, #FFF)'), false)
  assert.equal(singleLayer('#000, #FFF'), false)
})

test('a single-layer background still takes its token', () => {
  const overrides = tokenOverrides(
    { fills: [{ id: 'VariableID:1' }] } as never,
    false,
    new Map([['VariableID:1', 'Background/Neutral 1']]),
    { background: 'var(--x, #FFFFFF)' }
  )
  assert.equal(overrides.background, 'var(--background-neutral-1, #FFFFFF)')
})

test('a stacked background keeps every layer instead of collapsing into one token', () => {
  const literal = 'url(../img/photo.png) 0 0 / 100% 100% no-repeat, var(--Background-Neutral-1, #FFF)'
  const overrides = tokenOverrides(
    { fills: [{ id: 'VariableID:1' }] } as never,
    false,
    new Map([['VariableID:1', 'Base/orange/O500 - Main']]),
    { background: literal }
  )
  // No override at all: the caller's own literal stands, and the shader layer missing from it
  // is reported as a note rather than papered over with a colour.
  assert.equal(overrides.background, undefined)
})

test('text colour is never a stack, so it takes its token as before', () => {
  const overrides = tokenOverrides(
    { fills: [{ id: 'VariableID:1' }] } as never,
    true,
    new Map([['VariableID:1', 'Text/Primary']]),
    { color: '#1D1D1F' }
  )
  assert.equal(overrides.color, 'var(--text-primary, #1D1D1F)')
})
