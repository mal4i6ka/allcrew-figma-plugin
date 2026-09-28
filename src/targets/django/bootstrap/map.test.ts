import test from 'node:test'
import assert from 'node:assert/strict'
import { variablesToW3CMultiMode, leaves, orderedThemes, type TokenGraph } from '../../../tokens/engine.ts'
import { cssColorToRgbTriplet, emitBootstrapArtifacts, matchBootstrapMap } from './map.ts'
import { inlinePrimitivesTree } from '../../../tokens/engine.ts'

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })

/** AllCrew Channel-style scheme (capitalized groups, palette + semantic split across two
 * collections, Light/Dark modes) — the adapter must match it without renames. */
function brandGraph(): TokenGraph {
  return {
    collections: [
      {
        id: 'col-palette',
        name: 'Palette',
        defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Value' }],
      },
      {
        id: 'col-sem',
        name: 'Semantic',
        defaultModeId: 'light',
        modes: [
          { modeId: 'light', name: 'Light' },
          { modeId: 'dark', name: 'Dark' },
        ],
      },
    ],
    variables: [
      {
        id: 'v-orange',
        name: 'Primary/Orange',
        collectionId: 'col-palette',
        resolvedType: 'COLOR',
        valuesByMode: { m1: { r: 251 / 255, g: 91 / 255, b: 10 / 255, a: 1 } },
      },
      {
        id: 'v-white',
        name: 'Primary/White',
        collectionId: 'col-palette',
        resolvedType: 'COLOR',
        valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } },
      },
      {
        id: 'v-primary',
        name: 'Color/Primary',
        collectionId: 'col-sem',
        resolvedType: 'COLOR',
        valuesByMode: { light: alias('v-orange'), dark: alias('v-orange') },
      },
      {
        id: 'v-bg',
        name: 'Color/Background',
        collectionId: 'col-sem',
        resolvedType: 'COLOR',
        valuesByMode: { light: alias('v-white'), dark: { r: 0.06, g: 0.06, b: 0.08, a: 1 } },
      },
      {
        id: 'v-text-secondary',
        name: 'Text/Secondary',
        collectionId: 'col-sem',
        resolvedType: 'COLOR',
        valuesByMode: {
          light: { r: 0.46, g: 0.46, b: 0.46, a: 1 },
          dark: { r: 0.66, g: 0.66, b: 0.66, a: 1 },
        },
      },
      {
        id: 'v-radius',
        name: 'Radius/MD',
        collectionId: 'col-palette',
        resolvedType: 'FLOAT',
        valuesByMode: { m1: 11 },
      },
    ],
  }
}

function artifactsOf(graph: TokenGraph) {
  const source = variablesToW3CMultiMode(graph)
  const themes = orderedThemes(leaves(source))
  return emitBootstrapArtifacts(source, themes, { themeAttribute: 'data-bs-theme' })
}

test('cssColorToRgbTriplet parses hex and rgb(), refuses non-colors', () => {
  assert.equal(cssColorToRgbTriplet('#fb5b0a'), '251, 91, 10')
  assert.equal(cssColorToRgbTriplet('rgb(255 0 0 / 0.5)'), '255, 0, 0')
  assert.equal(cssColorToRgbTriplet('var(--x)'), undefined)
  assert.equal(cssColorToRgbTriplet('linear-gradient(#fff, #000)'), undefined)
})

test('matching is scheme-tolerant: capitalized Color/Primary, Text/Secondary and Radius/MD all land', () => {
  const { mapJson } = artifactsOf(brandGraph())
  const parsed = JSON.parse(mapJson)
  assert.equal(parsed.map['--bs-primary'], 'Color.Primary')
  assert.equal(parsed.map['--bs-body-bg'], 'Color.Background')
  assert.equal(parsed.map['--bs-secondary-color'], 'Text.Secondary')
  assert.equal(parsed.map['--bs-border-radius'], 'Radius.MD')
  assert.ok(parsed.unmatched.includes('--bs-success')) // nothing satisfies it — recorded for the CLI
})

test('bootstrap-tokens.css: literals per theme with -rgb companions, dark mode on [data-bs-theme="dark"]', () => {
  const { css } = artifactsOf(brandGraph())
  assert.match(css, /^\/\* Bootstrap variable overrides/)
  assert.match(css, /:root,\n\[data-bs-theme="light"\] \{/)
  assert.match(css, /\[data-bs-theme="dark"\] \{/)
  // Aliases are flattened to literals (var() would break the -rgb companion and load order).
  assert.match(css, /--bs-primary: #fb5b0a;/)
  assert.match(css, /--bs-primary-rgb: 251, 91, 10;/)
  // Theme-dependent value: background flips between blocks.
  const [lightBlock, darkBlock] = css.split('\n\n')
  assert.match(lightBlock, /--bs-body-bg: #ffffff;/)
  assert.match(darkBlock, /--bs-body-bg: #0f0f14;/)
  // Non-color mapping renders with the unit rule.
  assert.match(css, /--bs-border-radius: 11px;/)
  // Non-rgb entries get no companion.
  assert.doesNotMatch(css, /--bs-border-radius-rgb/)
})

test('a token under bs/* maps directly and WINS over the candidate table', () => {
  const graph = brandGraph()
  ;(graph.variables as unknown[]).push({
    id: 'v-override',
    name: 'bs/primary',
    collectionId: 'col-palette',
    resolvedType: 'COLOR',
    valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } },
  })
  const { mapJson, css } = artifactsOf(graph)
  assert.equal(JSON.parse(mapJson).map['--bs-primary'], 'bs.primary')
  assert.match(css, /--bs-primary: #000000;/)
})

test('_tokens.scss: default-theme literals with Bootstrap SCSS names (secondary-color exception)', () => {
  const { scss } = artifactsOf(brandGraph())
  assert.match(scss, /\$primary: #fb5b0a;/)
  assert.match(scss, /\$body-bg: #ffffff;/) // default theme is Light
  assert.match(scss, /\$body-secondary-color: /) // --bs-secondary-color → $body-secondary-color
  assert.match(scss, /\$border-radius: 11px;/)
})

test('an empty match set emits empty css/scss but still records every unmatched variable', () => {
  const graph: TokenGraph = {
    collections: [{ id: 'c', name: 'C', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'Default' }] }],
    variables: [
      { id: 'v', name: 'shadow/soft', collectionId: 'c', resolvedType: 'STRING', valuesByMode: { m: '0 1px 2px' } },
    ],
  }
  const artifacts = artifactsOf(graph)
  assert.equal(artifacts.css, '')
  assert.equal(artifacts.scss, '')
  assert.equal(JSON.parse(artifacts.mapJson).unmatched.length > 10, true)
})

test('matchBootstrapMap picks the FIRST existing candidate in priority order', () => {
  const graph: TokenGraph = {
    collections: [{ id: 'c', name: 'C', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'Default' }] }],
    variables: [
      { id: 'v1', name: 'accent', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { r: 0, g: 0, b: 1, a: 1 } } },
      { id: 'v2', name: 'color/primary', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } },
    ],
  }
  const flat = leaves(inlinePrimitivesTree(variablesToW3CMultiMode(graph), true))
  const { matched } = matchBootstrapMap(flat)
  const primary = matched.find((m) => m.bsVar === '--bs-primary')!
  assert.deepEqual(primary.leaf.path, ['color', 'primary']) // beats the lower-priority 'accent'
})
