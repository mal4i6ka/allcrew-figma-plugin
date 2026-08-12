import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTokensDesignMd } from './tokens-target.ts'
import { buildTokenAudit } from './audit.ts'
import { DEFAULT_OPTIONS, type TokenGraph, type TokenTree, type TokenValue, type W3CToken } from '../../tokens/engine.ts'
import { buildDesignTokens } from '../design-tokens.ts'

function token(value: TokenValue, type: string, modes: Record<string, TokenValue> = {}): W3CToken {
  return { $type: type, $value: value, $extensions: { modes, figma: { collection: 'Colors', defaultMode: 'Light' } } }
}

const TREE: TokenTree = {
  Color: {
    Surface: { Card: token('#ffffff', 'color', { Light: '#ffffff', Dark: '#101014' }) },
    Text: { Primary: token('#111111', 'color', { Light: '#111111', Dark: '#f4f4f4' }) },
  },
  Spacing: { md: token(16, 'number', { Light: 16, Dark: 16 }) },
  Radius: { md: token(12, 'number', { Light: 12, Dark: 12 }) },
}

const EMPTY_AUDIT = buildTokenAudit({ collections: [], variables: [] })

function render(overrides: Partial<Parameters<typeof buildTokensDesignMd>[0]> = {}): string {
  return buildTokensDesignMd({
    fileName: 'Altery DS',
    tree: TREE,
    themes: ['Light', 'Dark'],
    defaultTheme: 'Light',
    themeAttribute: 'data-theme-name',
    files: ['tokens.css', 'tokens.json', 'tokens.ts', 'README.md', 'DESIGN.md'],
    options: DEFAULT_OPTIONS,
    audit: EMPTY_AUDIT,
    ...overrides,
  })
}

test('the tokens DESIGN.md maps every token to the CSS property it belongs on', () => {
  const md = render()
  assert.match(md, /target: design-tokens/)
  assert.match(md, /\| `Color\/Surface\/Card` \| `var\(--color-surface-card\)` \| `#ffffff` \| `#101014` \| `background-color` \|/)
  assert.match(md, /\| `Color\/Text\/Primary` \| `var\(--color-text-primary\)` .* \| `color` \|/)
  assert.match(md, /\| `Spacing\/md` \| `var\(--spacing-md\)` .* \| `padding \/ margin \/ gap` \|/)
})

test('the tokens DESIGN.md states the hard rules and the theme switch', () => {
  const md = render()
  assert.match(md, /\*\*DO NOT\*\* write raw colors/)
  assert.match(md, /\*\*DO NOT\*\* use arbitrary spacing/)
  assert.match(md, /\*\*DO NOT\*\* invent corner radii/)
  assert.match(md, /<html data-theme-name="Dark">/)
  assert.match(md, /## \d+\. Agent prompt/)
})

test('section numbering has no gaps when a section has nothing to say', () => {
  // This tree has no breakpoints and no text styles, so those sections are dropped entirely.
  const md = render()
  const numbers = [...md.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]))
  assert.deepEqual(numbers, numbers.map((_, index) => index))
  assert.equal(/## \d+\. Breakpoints/.test(md), false)
  assert.equal(/## \d+\. Typography/.test(md), false)
})

test('the design-tokens package ships DESIGN.md alongside tokens.css', () => {
  const graph: TokenGraph = {
    fileName: 'Altery DS',
    collections: [
      { id: 'c1', name: 'Colors', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }] },
    ],
    variables: [
      { id: 'v1', name: 'Color/Surface/Card', collectionId: 'c1', resolvedType: 'COLOR', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } } },
    ],
  }
  const artifacts = buildDesignTokens(graph, { target: 'design-tokens' }, '2026-07-29T00:00:00.000Z')
  assert.ok(artifacts.files['DESIGN.md'], 'DESIGN.md is part of the package')
  assert.match(artifacts.files['DESIGN.md'], /generated: 2026-07-29T00:00:00\.000Z/)
  // Its own file table must list it, or an agent reading the package inventory misses it.
  assert.match(artifacts.files['DESIGN.md'], /\| `DESIGN\.md` \|/)
})

test('an empty file produces no DESIGN.md rather than an empty contract', () => {
  const artifacts = buildDesignTokens({ fileName: 'Empty', collections: [], variables: [] }, {})
  assert.equal('DESIGN.md' in artifacts.files, false)
})

/* --------------------------------------------------- contract self-consistency (finding 1) */

test('recipes omit roles that have no tokens instead of inventing a fallback name', () => {
  // Colors only — no spacing, no radius. The old recipe wrote `var(--radius-md)` /
  // `var(--spacing-md)` here, violating its own "every `--…` name must exist" rule.
  const md = render({ tree: { Color: TREE.Color } as TokenTree })
  assert.equal(/var\(--radius-md\)/.test(md), false)
  assert.equal(/var\(--spacing-md\)/.test(md), false)
  assert.match(md, /No radius or spacing tokens are role-classified in this export/)
  assert.match(md, /background: var\(--color-surface-card\);/)
})

/** The observed export shape: colors + an unscoped worded numeric scale (`Mesure`), floats with
 * Figma noise, and a near-duplicate pair in the would-be type scale. */
const MESURE_GRAPH: TokenGraph = {
  fileName: 'Altery DS',
  collections: [
    { id: 'c1', name: 'Colors', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }] },
    { id: 'c2', name: 'Mesure', defaultModeId: 'm2', modes: [{ modeId: 'm2', name: 'Mode 1' }] },
  ],
  variables: [
    { id: 'v1', name: 'Color/Surface/Card', collectionId: 'c1', resolvedType: 'COLOR', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } } },
    { id: 'v2', name: 'number/Base', collectionId: 'c2', resolvedType: 'FLOAT', valuesByMode: { m2: 8 } },
    { id: 'v3', name: 'number/Half', collectionId: 'c2', resolvedType: 'FLOAT', valuesByMode: { m2: 3.9999998474121094 } },
  ],
}

test('every var(--…) mentioned in generated README/DESIGN.md exists in tokens.css', () => {
  const artifacts = buildDesignTokens(MESURE_GRAPH, { target: 'design-tokens' })
  const css = artifacts.files['tokens.css']
  assert.ok(css)
  for (const file of ['README.md', 'DESIGN.md']) {
    const text = artifacts.files[file]
    assert.ok(text, `${file} shipped`)
    const mentioned = [...text.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1])
    assert.ok(mentioned.length > 0, `${file} names at least one variable`)
    for (const name of mentioned) {
      assert.ok(css.includes(`${name}:`), `${file} mentions ${name}, which is not declared in tokens.css`)
    }
  }
})

test('emitted numeric values carry no float noise', () => {
  const artifacts = buildDesignTokens(MESURE_GRAPH, { target: 'design-tokens' })
  assert.match(artifacts.files['tokens.css'], /--number-half: 4px/)
  assert.equal(/3\.9999998/.test(artifacts.files['tokens.css']), false)
})

/* --------------------------------------------- the numeric scale is usable (finding 2) */

test('an unclassified numeric scale is delegated to, not quarantined', () => {
  const artifacts = buildDesignTokens(MESURE_GRAPH, { target: 'design-tokens' })
  const md = artifacts.files['DESIGN.md']
  assert.match(md, /carry no role — they ARE this file's spacing\/radius scale/)
  assert.match(md, /never write a raw px value/)
  assert.match(md, /scope these variables in Figma/)
  assert.equal(/treat them as\s+system internals/.test(md), false)
})

test('the collection→role setting classifies the scale and clears the delegation note', () => {
  const artifacts = buildDesignTokens(
    MESURE_GRAPH,
    { target: 'design-tokens', tokens: { collectionRoles: 'Mesure: spacing' } }
  )
  const md = artifacts.files['DESIGN.md']
  assert.match(md, /\| `number\/Base` \| `var\(--number-base\)` \| `8px` \| `padding \/ margin \/ gap` \|/)
  assert.equal(/they ARE this file's spacing\/radius scale/.test(md), false)
})

/* ------------------------------------------------- near-duplicate type scale (finding 6) */

test('type-scale steps closer than 0.5px are flagged as probable duplicates', () => {
  const nearDuplicates: TokenTree = {
    'font-size': {
      '3xs': token(9.9, 'number', { Light: 9.9 }),
      '2xs': token(10, 'number', { Light: 10 }),
      md: token(16, 'number', { Light: 16 }),
    },
  }
  const md = render({ tree: nearDuplicates, themes: ['Light'] })
  assert.match(md, /\*\*Probable duplicate type-scale steps\*\*/)
  assert.match(md, /`--font-size-3xs` \(9\.9px\) vs `--font-size-2xs` \(10px\)/)
})
