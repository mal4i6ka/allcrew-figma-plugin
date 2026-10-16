/**
 * Figma's composed colour (Update 139) and the COLOR_OPACITY scope on their way to tokens.css.
 *
 * A composed colour is a `{ color, opacity }` pair with at least one half an alias. The engine had
 * no idea what it was and wrote "[object Object]".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { leaves, orderedThemes, toTokensCss, variablesToW3CMultiMode, type TokenGraph } from './engine.ts'

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })

const cssOf = (g: TokenGraph): string => {
  const tree = variablesToW3CMultiMode(g)
  const { ordered, defaultTheme } = orderedThemes(leaves(tree))
  return toTokensCss(tree, ordered, defaultTheme, 'data-theme')
}

test('a composed colour exports as the colour it paints', () => {
  const css = cssOf({
    collections: [{ id: 'c', name: 'Core', modes: [{ modeId: 'm', name: 'Default' }], defaultModeId: 'm' }],
    variables: [
      { id: 'b', name: 'brand', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } },
      { id: 'o', name: 'alpha/40', collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { m: 40 }, scopes: ['COLOR_OPACITY'] },
      { id: 's', name: 'brand/soft', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { color: alias('b'), opacity: alias('o') } } },
      { id: 'h', name: 'brand/half', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { color: alias('b'), opacity: 50 } } },
    ],
  })
  assert.ok(!css.includes('[object Object]'), css)
  assert.match(css, /--brand-soft: rgba\(255, 0, 0, 0\.4\);/)
  assert.match(css, /--brand-half: rgba\(255, 0, 0, 0\.5\);/)
})

test('a composed colour over another composed colour multiplies both opacities', () => {
  // Live shape: semantic `Orange/Main` = { color: alias(Orange/O500), opacity: alias(solid) },
  // and Orange/O500 is itself { color: literal, opacity: alias }. It exported as [object Object].
  const css = cssOf({
    collections: [{ id: 'c', name: 'Core', modes: [{ modeId: 'm', name: 'Default' }], defaultModeId: 'm' }],
    variables: [
      { id: 'solid', name: 'alpha/100', collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { m: 100 } },
      { id: 'half', name: 'alpha/50', collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { m: 50 } },
      { id: 'p', name: 'orange/500', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { color: { r: 1, g: 0.5, b: 0, a: 1 }, opacity: alias('half') } } },
      { id: 'main', name: 'orange/main', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { color: alias('p'), opacity: alias('solid') } } },
    ],
  })
  assert.ok(!css.includes('[object Object]'), css)
  assert.match(css, /--orange-main: rgba\(255, 128, 0, 0\.5\);/)
})

test('a COLOR_OPACITY float is a fraction, not pixels', () => {
  const css = cssOf({
    collections: [{ id: 'c', name: 'Core', modes: [{ modeId: 'm', name: 'Default' }], defaultModeId: 'm' }],
    variables: [{ id: 'o', name: 'alpha/40', collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { m: 40 }, scopes: ['COLOR_OPACITY'] }],
  })
  assert.match(css, /--alpha-40: 0\.4;/)
})

test('a themed composed colour reads its halves in the theme of the same name', () => {
  const tree = variablesToW3CMultiMode({
    collections: [
      { id: 'p', name: 'Palette', modes: [{ modeId: 'pl', name: 'Light' }, { modeId: 'pd', name: 'Dark' }], defaultModeId: 'pl' },
      { id: 't', name: 'Theme', modes: [{ modeId: 'tl', name: 'Light' }, { modeId: 'td', name: 'Dark' }], defaultModeId: 'tl' },
    ],
    variables: [
      { id: 'ink', name: 'ink', collectionId: 'p', resolvedType: 'COLOR', valuesByMode: { pl: { r: 0, g: 0, b: 0, a: 1 }, pd: { r: 1, g: 1, b: 1, a: 1 } } },
      {
        id: 'scrim',
        name: 'scrim',
        collectionId: 't',
        resolvedType: 'COLOR',
        valuesByMode: { tl: { color: alias('ink'), opacity: 20 }, td: { color: alias('ink'), opacity: 20 } },
      },
    ],
  })
  const scrim = leaves(tree).find((l) => l.path.includes('scrim'))!
  assert.deepEqual(scrim.token.$extensions?.modes, { Light: 'rgba(0, 0, 0, 0.2)', Dark: 'rgba(255, 255, 255, 0.2)' })
})
