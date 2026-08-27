import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  legacyAliasPairs,
  leaves,
  orderedThemes,
  toLegacyAliasCss,
  inlinePrimitivesTree,
  toTokensCss,
  toTokensJson,
  toThemeModuleCssFiles,
  type RenameMap,
  type TokenTree,
} from './engine.ts'

/** Two violet primitives and one semantic token that references one of them. */
const tree = (): TokenTree => ({
  colors: {
    Violet: {
      '500': { $type: 'color', $value: '#7C3AED', $extensions: { modes: { Light: '#7C3AED' } } },
      '600': { $type: 'color', $value: '#6D28D9', $extensions: { modes: { Light: '#6D28D9' } } },
    },
  },
})

const cssOf = (source: TokenTree, renames?: RenameMap): string => {
  const { ordered, defaultTheme } = orderedThemes(leaves(source))
  return toTokensCss(source, ordered, defaultTheme, 'data-theme', renames)
}

test('a renamed token keeps its old custom property, pointing at the new one', () => {
  const css = cssOf(tree(), { 'colors/Blue/500': 'colors/Violet/500' })
  assert.match(css, /--colors-blue-500: var\(--colors-violet-500\);/)
  assert.match(css, /Renamed by a color remap/)
  // The alias sits outside the theme blocks: `var()` resolves where it is used, so one copy
  // covers every theme.
  assert.ok(css.indexOf('--colors-blue-500') > css.lastIndexOf('[data-theme='))
})

test('no rename means no block at all, byte for byte as before', () => {
  assert.equal(cssOf(tree()), cssOf(tree(), {}))
  assert.equal(cssOf(tree(), undefined).includes('Renamed by'), false)
})

test('an alias is not emitted when its target never reached the stylesheet', () => {
  // The classic case: `inlinePrimitives` folded the primitive away, so nothing was lost when
  // it was renamed and there is no custom property to point at.
  const css = cssOf(tree(), { 'colors/Blue/500': 'colors/Teal/500' })
  assert.equal(css.includes('--colors-blue-500'), false)
})

test('an alias is not emitted when something still owns the old name', () => {
  // Two declarations of one property would resolve by source order rather than by intent.
  const css = cssOf(tree(), { 'colors/Violet/500': 'colors/Violet/600' })
  assert.equal(css.includes('var(--colors-violet-600);'), false)
})

test('a rename CSS cannot see is skipped', () => {
  // Both names slug to the same custom property, so there is nothing to alias.
  assert.deepEqual(legacyAliasPairs(tree(), { 'colors/violet/500': 'colors/Violet/500' }), [])
})

test('aliases are ordered so an unchanged file re-exports identically', () => {
  const renames = {
    'colors/Zinc/500': 'colors/Violet/500',
    'colors/Amber/500': 'colors/Violet/600',
    'colors/Mint/500': 'colors/Violet/500',
  }
  assert.deepEqual(
    legacyAliasPairs(tree(), renames).map((pair) => pair.from),
    ['colors-amber-500', 'colors-mint-500', 'colors-zinc-500']
  )
})

test('the module files carry the aliases once, in the default theme’s scope', () => {
  const source = tree()
  const { ordered, defaultTheme } = orderedThemes(leaves(source))
  const files = toThemeModuleCssFiles(source, ordered, defaultTheme, 'data-theme', true, {
    'colors/Blue/500': 'colors/Violet/500',
  })
  const withAlias = Object.keys(files).filter((name) => files[name].includes('--colors-blue-500'))
  assert.equal(withAlias.length, 1)
  assert.match(files[withAlias[0]], /:global\(:root\) \{\n  --colors-blue-500: var\(--colors-violet-500\);/)
})

test('tokens.json carries the map beside the tree, where neither engine reads it as a token', () => {
  const json = JSON.parse(toTokensJson(tree(), { 'colors/Blue/500': 'colors/Violet/500' }))
  assert.deepEqual(json.$extensions.altery.renames, { 'colors/Blue/500': 'colors/Violet/500' })
  assert.deepEqual(leaves(json as TokenTree).map((entry) => entry.path.join('/')).sort(), [
    'colors/Violet/500',
    'colors/Violet/600',
  ])
  assert.equal(toTokensJson(tree()), toTokensJson(tree(), {}), 'no renames leaves the file untouched')
})

test('the block renders exactly once, with the selector it was handed', () => {
  const pairs = [{ from: 'a', to: 'b' }]
  assert.equal(toLegacyAliasCss([]), '')
  assert.match(toLegacyAliasCss(pairs, ':global(:root)'), /^\/\* Renamed[^\n]*\n:global\(:root\) \{\n {2}--a: var\(--b\);\n\}\n$/)
})

/* ------------------------------------------------------------------ cross-engine parity */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../tests/fixtures/expected/${name}`, import.meta.url)), 'utf8')

test('the alias block matches the one the Python CLI writes, byte for byte', () => {
  // tests/test_cli.py asserts the same fixture from the other engine. Only the block is
  // compared here: the two emitters also differ on theme-attribute casing, which predates
  // this feature and is locked by its own golden.
  const raw = JSON.parse(fixture('tokens-renamed.json'))
  const renames = raw.$extensions.altery.renames
  delete raw.$extensions

  const source = raw as TokenTree
  const { ordered, defaultTheme } = orderedThemes(leaves(source))
  const css = toTokensCss(inlinePrimitivesTree(source, false), ordered, defaultTheme, 'data-bs-theme', renames)

  const blockOf = (text: string): string => text.slice(text.indexOf('/* Renamed by a color remap'))
  assert.equal(blockOf(css), blockOf(fixture('tokens-renamed.css')))
  assert.match(blockOf(css), /--color-brand: var\(--color-primary\);/)
})
