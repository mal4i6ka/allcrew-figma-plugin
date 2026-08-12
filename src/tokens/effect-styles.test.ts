/**
 * Effect styles → tokens. Fixtures are the real `Focus/Default` / `Focus/Error` styles of the
 * Corporate Design Library (read through the Figma MCP server): a drop shadow with zero offset,
 * zero blur and a 2px spread — i.e. a focus ring, the thing a coding agent otherwise reinvents as
 * `outline: 2px solid blue`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blurEffectToCss,
  buildPackage,
  leaves,
  shadowEffectToCss,
  varName,
  variablesToW3CMultiMode,
  type TokenGraph,
} from './engine.ts'
import { buildDesignTokens } from '../targets/design-tokens.ts'

const FOCUS_GRAPH: TokenGraph = {
  fileName: 'Corporate Design Library',
  collections: [],
  variables: [],
  effectStyles: [
    {
      id: 'S:1',
      name: 'Focus/Default',
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0.278, b: 0.902, a: 0.161 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2, visible: true }],
    },
    {
      id: 'S:2',
      name: 'Focus/Error',
      effects: [{ type: 'DROP_SHADOW', color: { r: 0.804, g: 0.098, b: 0.094, a: 0.161 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2, visible: true }],
    },
  ],
}

test('a drop shadow becomes a CSS box-shadow layer', () => {
  assert.equal(
    shadowEffectToCss({ type: 'DROP_SHADOW', color: { r: 0, g: 0.278, b: 0.902, a: 0.161 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2 }),
    '0px 0px 0px 2px rgba(0, 71, 230, 0.161)'
  )
  assert.equal(
    shadowEffectToCss({ type: 'INNER_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 2 }, radius: 4 }),
    'inset 0px 2px 4px rgba(0, 0, 0, 0.2)'
  )
  // A spread of 0 is Figma's default and adds nothing to the CSS.
  assert.equal(
    shadowEffectToCss({ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 1, y: 2 }, radius: 3, spread: 0 }),
    '1px 2px 3px #000000'
  )
  assert.equal(blurEffectToCss({ type: 'BACKGROUND_BLUR', radius: 12 }), 'blur(12px)')
  // Effects with no CSS equivalent are skipped rather than guessed at.
  assert.equal(shadowEffectToCss({ type: 'NOISE', radius: 4 }), null)
  assert.equal(blurEffectToCss({ type: 'DROP_SHADOW', radius: 4 }), null)
})

test('effect styles land in the token tree under shadow/…', () => {
  const paths = leaves(variablesToW3CMultiMode(FOCUS_GRAPH)).map((leaf) => varName(leaf.path))
  assert.deepEqual(paths, ['shadow-focus-default', 'shadow-focus-error'])
})

test('a file whose only design data is effect styles still produces a package', () => {
  const pkg = buildPackage(FOCUS_GRAPH, {})
  assert.equal(pkg.summary.effectStyleCount, 2)
  assert.match(pkg.files['tokens.css'], /--shadow-focus-default: 0px 0px 0px 2px rgba\(0, 71, 230, 0\.161\);/)

  // DESIGN.md must name them, or an agent writes its own outline for focus.
  const design = buildDesignTokens(FOCUS_GRAPH, {}).files['DESIGN.md']
  assert.match(design, /--shadow-focus-default/)
  assert.match(design, /\*\*DO NOT\*\* hand-write a `box-shadow`/)
})

test('multiple visible effects merge into one comma-separated value; hidden ones are dropped', () => {
  const tree = variablesToW3CMultiMode({
    collections: [],
    variables: [],
    effectStyles: [
      {
        id: 'S:3',
        name: 'Elevation/Card',
        effects: [
          { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 1 }, radius: 2, visible: true },
          { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.04 }, offset: { x: 0, y: 4 }, radius: 8, visible: true },
          { type: 'DROP_SHADOW', color: { r: 1, g: 0, b: 0, a: 1 }, offset: { x: 9, y: 9 }, radius: 9, visible: false },
        ],
      },
    ],
  })
  const [leaf] = leaves(tree)
  assert.equal(leaf.token.$value, '0px 1px 2px rgba(0, 0, 0, 0.08), 0px 4px 8px rgba(0, 0, 0, 0.04)')
})

test('varName keeps non-ASCII letters instead of emptying the token name', () => {
  // Cyrillic names used to slug down to '' — every such token collided on `--`.
  assert.equal(varName(['Цвет', 'Кнопка', 'Фон']), 'цвет-кнопка-фон')
  assert.equal(varName(['Colors', 'Кнопка', 'bg-hovered']), 'colors-кнопка-bg-hovered')
  // Punctuation and emoji are still stripped; ASCII naming is untouched.
  assert.equal(varName(['🎨 Colors', 'Primary']), 'colors-primary')
  assert.equal(varName(['Color', 'Surface', 'Card']), 'color-surface-card')
})
