import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { VariableSnapshot } from '../variables'
import { emitTokenArtifacts } from './index.ts'
import { applyFileTokenConfig, normalizeFileTokenConfig, withMapping } from './file-config.ts'
import { describeMapping, mappingFileProblems, mappingFromSettings, mappingToSettings, normalizeMapping, suggestMapping, type TokenMapping } from './mapping.ts'
import { normalizeExportOptions } from '../settings.ts'

/* ------------------------------------------------------------------------------- fixtures */

const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 })
const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
const collection = (id: string, name: string, modes: string[]) => ({ id, name, defaultModeId: `${id}:${modes[0]}`, modes: modes.map((m) => ({ modeId: `${id}:${m}`, name: m })) })
const variable = (id: string, coll: string, name: string, values: Record<string, unknown>, type = 'COLOR') => ({
  id, key: id, name, collectionId: coll, scopes: ['ALL_SCOPES'], resolvedType: type,
  valuesByMode: Object.fromEntries(Object.entries(values).map(([mode, value]) => [`${coll}:${mode}`, value])),
})
const snapshot = (collections: unknown[], variables: unknown[]) => ({ collections, variables }) as unknown as VariableSnapshot

/** A two-product design system in miniature: a palette, One with Light/Dark, Business holding overrides, a copy
 * and a token of its own, Shared, the merged Product experiment, breakpoints and legacy sizes. */
function ds3(): VariableSnapshot {
  return snapshot(
    [
      collection('col', 'Colors', ['Value']),
      collection('one', 'One', ['Light', 'Dark']),
      collection('bus', 'Business', ['Light', 'Dark']),
      collection('sh', 'Shared', ['Light', 'Dark']),
      collection('prod', 'Product', ['One Light', 'One Dark', 'Business Light', 'Business Dark']),
      collection('bp', 'Breakpoints', ['Value']),
      collection('sz', 'Sizes', ['Mode 1']),
    ],
    [
      variable('n0', 'col', 'neutral/0', { Value: rgb('#ffffff') }),
      variable('n900', 'col', 'neutral/900', { Value: rgb('#1b1b1b') }),
      variable('n1000', 'col', 'neutral/1000', { Value: rgb('#000000') }),
      variable('n850', 'col', 'neutral/850', { Value: rgb('#202020') }),
      variable('o500', 'col', 'orange/500', { Value: rgb('#fb5b0a') }),
      variable('o600', 'col', 'orange/600', { Value: rgb('#ef5e15') }),
      variable('o-bg', 'one', 'background/base', { Light: alias('n0'), Dark: alias('n1000') }),
      variable('o-text', 'one', 'content/primary', { Light: alias('n850'), Dark: alias('n0') }),
      variable('o-cta', 'one', 'action/primary/background', { Light: alias('o500'), Dark: alias('o500') }),
      variable('o-card', 'one', 'surface/card', { Light: alias('o-bg'), Dark: alias('o-bg') }),
      variable('o-gap', 'one', 'spacing/s', { Light: 12, Dark: 12 }, 'FLOAT'),
      variable('b-bg', 'bus', 'background/base', { Light: alias('n0'), Dark: alias('n900') }),
      variable('b-text', 'bus', 'content/primary', { Light: alias('n850'), Dark: alias('n0') }),
      variable('b-cta', 'bus', 'action/primary/background', { Light: alias('o500'), Dark: alias('o600') }),
      variable('b-icon', 'bus', 'icon/background', { Light: alias('n0'), Dark: alias('n850') }),
      variable('s-logo', 'sh', 'component/logo/foreground', { Light: alias('n850'), Dark: alias('n0') }),
      variable('p-bg', 'prod', 'background/base', { 'One Light': alias('n0'), 'One Dark': alias('n1000'), 'Business Light': alias('n0'), 'Business Dark': alias('n900') }),
      variable('p-text', 'prod', 'content/primary', { 'One Light': alias('n850'), 'One Dark': alias('n0'), 'Business Light': alias('n850'), 'Business Dark': alias('n0') }),
      variable('bp-sm', 'bp', 'breakpoint/sm', { Value: 576 }, 'FLOAT'),
      variable('sz-s', 'sz', 'spacing/s', { 'Mode 1': 8 }, 'FLOAT'),
    ]
  )
}

const OPTIONS = { inlinePrimitives: true, flattenAliases: true, themeAttribute: 'data-theme-name' }
const cssOf = (s: VariableSnapshot, settings: { collectionRoles?: string; themeAxes?: unknown; slugThemes?: boolean; themeAttribute?: string }) =>
  emitTokenArtifacts(s, { ...OPTIONS, ...settings } as Parameters<typeof emitTokenArtifacts>[1]).css

/** A stylesheet as what it declares: selector → sorted declarations, comments and order aside. */
function declared(css: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const [selector, body] = block.split('{')
    if (!body) continue
    out[selector.trim().replace(/\s+/g, ' ')] = body.split(';').map((d) => d.trim()).filter(Boolean).sort()
  }
  return out
}

/** The pin set in the two-product file on 27.10 by hand, before the mapping existed — what it shipped is what
 * the mapping must ship. */
const PIN_27_10 = {
  collectionRoles: 'Product: hidden, Colors: hidden, Sizes: hidden, Breakpoints: breakpoints',
  slugThemes: true,
  themeAxes: {
    axes: [
      { attribute: 'data-product', source: 'collections', values: [{ label: 'One', base: true }, { label: 'Business' }, { label: 'Platform', sameAs: 'Business' }], shared: ['Shared'] },
      { attribute: 'data-theme', nested: true, values: [{ label: 'Light' }, { label: 'Dark' }] },
    ],
  },
}

/** Two attributes over the two-product file. */
const SERGEY: TokenMapping = {
  version: 1,
  attributes: [
    {
      name: 'data-product',
      from: 'collections',
      values: [{ value: 'one', collections: ['One'], base: true }, { value: 'business', collections: ['Business'] }, { value: 'platform', sameAs: 'business' }],
      shared: ['Shared'],
    },
    { name: 'data-theme', from: 'columns', nested: true, values: [{ value: 'light', columns: ['Light'], base: true }, { value: 'dark', columns: ['Dark'] }] },
  ],
  collections: { Colors: 'palette', Product: 'skip', Sizes: 'skip', Breakpoints: 'breakpoints' },
}

/* ---------------------------------------------------------------------------------- tests */

test('the file the designers set up reads as two attributes — the merged copy and the clashing legacy scale left out', () => {
  const suggested = suggestMapping(ds3())
  // A suggestion puts both attributes on one element; the 27.10 pin also let the theme nest.
  const plain = SERGEY.attributes.map(({ nested: _, ...a }) => a)
  assert.deepEqual(suggested.attributes, plain.map((a) => (a.name === 'data-product' ? { ...a, values: a.values.slice(0, 2) } : a)))
  // Sizes has one column but repeats `spacing/s`, which One defines too: shipping it would put two
  // answers to one name in tokens.css.
  assert.deepEqual(suggested.collections, { Colors: 'palette', Breakpoints: 'breakpoints', Product: 'skip', Sizes: 'skip' })
})

test('a mapping ships exactly what the hand-written pin shipped', () => {
  const s = ds3()
  const before = cssOf(s, PIN_27_10)
  const after = cssOf(s, mappingToSettings(SERGEY))
  assert.equal(after, before)
  assert.match(after, /\[data-product="business"\]\[data-theme="dark"\]/)
  assert.match(after, /\[data-product="platform"\]/)
  assert.doesNotMatch(after, /var\(--|data-theme-name/)
})

test('the hand-written pin opens on the screen as the mapping it is', () => {
  assert.deepEqual(mappingFromSettings(PIN_27_10, ds3()), SERGEY)
})

test('attributes are whatever the file needs: one called data-brand, read off a collection\'s columns', () => {
  const s = ds3()
  const mapping: TokenMapping = {
    version: 1,
    attributes: [{ name: 'data-brand', from: 'columns', collections: ['Product'], values: [{ value: 'one', columns: ['One Light'] }, { value: 'one-night', columns: ['One Dark'] }, { value: 'business', columns: ['Business Light'] }, { value: 'business-night', columns: ['Business Dark'] }] }],
    collections: { One: 'skip', Business: 'skip', Shared: 'skip', Colors: 'palette' },
  }
  assert.deepEqual(normalizeMapping(mapping).problems, [])
  const css = cssOf(s, mappingToSettings(mapping))
  assert.match(css, /\[data-brand="business-night"\]/)
  assert.doesNotMatch(css, /data-product|data-theme/)
  // A column no value takes cannot ship as part of the attribute: the screen says which.
  const partial = { ...mapping, attributes: [{ ...mapping.attributes[0], values: mapping.attributes[0].values.slice(0, 2) }] }
  assert.deepEqual(describeMapping(s, partial).unbound, ['Product / Business Light', 'Product / Business Dark'])
})

test('the same product × theme stylesheet from every layout a plan allows', () => {
  // Pro: a collection per product, Light/Dark columns in each (a common way).
  const pro = snapshot(
    [collection('one', 'One', ['Light', 'Dark']), collection('bus', 'Business', ['Light', 'Dark'])],
    [
      variable('a', 'one', 'background/base', { Light: 'white', Dark: 'black' }, 'STRING'),
      variable('b', 'one', 'content/primary', { Light: 'ink', Dark: 'paper' }, 'STRING'),
      variable('c', 'bus', 'background/base', { Light: 'white', Dark: 'night' }, 'STRING'),
    ]
  )
  const proMapping: TokenMapping = {
    version: 1,
    attributes: [
      { name: 'data-product', from: 'collections', values: [{ value: 'one', collections: ['One'], base: true }, { value: 'business', collections: ['Business'] }] },
      { name: 'data-theme', from: 'columns', nested: true, values: [{ value: 'light', columns: ['Light'], base: true }, { value: 'dark', columns: ['Dark'] }] },
    ],
  }
  // Pro, one collection: product × theme in its four columns.
  const grid = snapshot(
    [collection('p', 'Product', ['One Light', 'One Dark', 'Business Light', 'Business Dark'])],
    [
      variable('a', 'p', 'background/base', { 'One Light': 'white', 'One Dark': 'black', 'Business Light': 'white', 'Business Dark': 'night' }, 'STRING'),
      variable('b', 'p', 'content/primary', { 'One Light': 'ink', 'One Dark': 'paper', 'Business Light': 'ink', 'Business Dark': 'paper' }, 'STRING'),
    ]
  )
  const gridMapping: TokenMapping = {
    version: 1,
    attributes: [
      { name: 'data-product', from: 'columns', collections: ['Product'], values: [{ value: 'one', columns: ['One Light', 'One Dark'], base: true }, { value: 'business', columns: ['Business Light', 'Business Dark'] }] },
      { name: 'data-theme', from: 'columns', collections: ['Product'], nested: true, values: [{ value: 'light', columns: ['One Light', 'Business Light'], base: true }, { value: 'dark', columns: ['One Dark', 'Business Dark'] }] },
    ],
  }
  // Free: one column per collection, a collection per cell.
  const free = snapshot(
    [collection('ol', 'One Light', ['Value']), collection('od', 'One Dark', ['Value']), collection('bl', 'Business Light', ['Value']), collection('bd', 'Business Dark', ['Value'])],
    [
      variable('a', 'ol', 'background/base', { Value: 'white' }, 'STRING'),
      variable('b', 'ol', 'content/primary', { Value: 'ink' }, 'STRING'),
      variable('c', 'od', 'background/base', { Value: 'black' }, 'STRING'),
      variable('d', 'od', 'content/primary', { Value: 'paper' }, 'STRING'),
      variable('e', 'bl', 'background/base', { Value: 'white' }, 'STRING'),
      variable('f', 'bd', 'background/base', { Value: 'night' }, 'STRING'),
    ]
  )
  const freeMapping: TokenMapping = {
    version: 1,
    attributes: [
      { name: 'data-product', from: 'collections', values: [{ value: 'one', collections: ['One Light', 'One Dark'], base: true }, { value: 'business', collections: ['Business Light', 'Business Dark'] }] },
      { name: 'data-theme', from: 'collections', nested: true, values: [{ value: 'light', collections: ['One Light', 'Business Light'], base: true }, { value: 'dark', collections: ['One Dark', 'Business Dark'] }] },
    ],
  }
  // Free: a collection per product, the dark theme marked in the token names.
  const marked = snapshot(
    [collection('one', 'One', ['Value']), collection('bus', 'Business', ['Value'])],
    [
      variable('a', 'one', 'background/base', { Value: 'white' }, 'STRING'),
      variable('b', 'one', 'content/primary', { Value: 'ink' }, 'STRING'),
      variable('c', 'one', 'dark/background/base', { Value: 'black' }, 'STRING'),
      variable('d', 'one', 'dark/content/primary', { Value: 'paper' }, 'STRING'),
      variable('e', 'bus', 'background/base', { Value: 'white' }, 'STRING'),
      variable('f', 'bus', 'dark/background/base', { Value: 'night' }, 'STRING'),
    ]
  )
  const markedMapping: TokenMapping = {
    version: 1,
    attributes: [
      { name: 'data-product', from: 'collections', values: [{ value: 'one', collections: ['One'], base: true }, { value: 'business', collections: ['Business'] }] },
      { name: 'data-theme', from: 'names', nested: true, values: [{ value: 'light', base: true }, { value: 'dark' }] },
    ],
  }
  const want = declared(cssOf(pro, mappingToSettings(proMapping)))
  assert.ok(Object.keys(want).some((s) => s.includes('[data-product="business"]')), 'the reference has a Business block')
  for (const [layout, s, mapping] of [['one collection', grid, gridMapping], ['free plan collections', free, freeMapping], ['marked names', marked, markedMapping]] as const) {
    assert.deepEqual(normalizeMapping(mapping).problems, [], layout)
    assert.deepEqual(declared(cssOf(s, mappingToSettings(mapping))), want, layout)
  }
})

test('the older string setting over one collection\'s columns reads as two column attributes and ships the same', () => {
  const s = ds3()
  const legacy = { collectionRoles: 'Product: themes, One: hidden, Business: hidden, Shared: hidden, Colors: hidden, Sizes: hidden, Breakpoints: breakpoints', slugThemes: true, themeAxes: 'data-product: One, Business; data-theme: Light, Dark' }
  const mapping = mappingFromSettings(legacy, s)
  assert.ok(mapping)
  assert.deepEqual(mapping.attributes.map((a) => [a.name, a.from, a.collections, a.values.map((v) => `${v.value}=${(v.columns ?? []).join('+')}`)]), [
    ['data-product', 'columns', ['Product'], ['one=One Light+One Dark', 'business=Business Light+Business Dark']],
    ['data-theme', 'columns', ['Product'], ['light=One Light+Business Light', 'dark=One Dark+Business Dark']],
  ])
  assert.equal(cssOf(s, mappingToSettings(mapping)), cssOf(s, legacy))
})

test('a mapping that cannot ship says why instead of guessing', () => {
  const problems = (raw: unknown) => normalizeMapping(raw).problems.join(' | ')
  const theme = { name: 'data-theme', from: 'columns', values: [{ value: 'light', columns: ['Light'] }] }
  assert.match(problems({ attributes: [{ name: 'a', from: 'collections', values: [{ value: 'x', collections: ['X'], base: true }, { value: 'y', collections: ['Y'], base: true }] }, theme] }), /one base value/)
  assert.match(problems({ attributes: [{ name: 'a', from: 'collections', values: [{ value: 'x', collections: ['X'] }, { value: 'p', sameAs: 'caas' }] }] }), /not a value with tokens of its own/)
  assert.match(problems({ attributes: [theme] }), /say which collection's columns/)
  assert.match(problems({ attributes: [theme, { ...theme, name: 'data-theme' }] }), /same name/)
  assert.match(problems({ attributes: [theme, theme, theme].map((a, i) => ({ ...a, name: `a${i}` })) }), /two attributes at most/)
  assert.match(problems({ attributes: [{ name: 'x', from: 'modes', values: [] }] }), /"from" must be one of/)
  assert.match(problems({ attributes: [], collections: { Colors: 'theme' } }), /role must be one of/)
  // A person writes `collection: "One"`; values are slugged; the first value with tokens is the base.
  const { mapping } = normalizeMapping({ attributes: [{ name: 'data-product', from: 'collections', values: [{ value: 'One App', collection: 'One' }, { value: 'Business Web', collection: 'Business' }] }] })
  assert.deepEqual(mapping?.attributes[0].values, [{ value: 'one-app', collections: ['One'], base: true }, { value: 'business-web', collections: ['Business'] }])
})

test('Business on the screen: what it overrides, what only repeats One, what it takes from One', () => {
  const view = describeMapping(ds3(), SERGEY, { collection: 'Business' })
  const rows = Object.fromEntries((view.table?.rows ?? []).map((r) => [r.name, r]))
  assert.equal(rows['background/base'].status, 'override')
  assert.equal(rows['content/primary'].status, 'same')
  assert.equal(rows['icon/background'].status, 'override', 'a token One does not have is Business\'s own')
  assert.equal(rows['surface/card'].status, 'base')
  assert.deepEqual(rows['background/base'].cells, [{ text: 'neutral/0', color: '#ffffff' }, { text: 'neutral/900', color: '#1b1b1b' }])
  assert.equal(rows['action/primary/background'].code, '--action-primary-background')
  assert.equal(view.table?.base, 'One')
  assert.deepEqual(view.table?.columns, [{ mode: 'Light', bindings: [{ attribute: 'data-theme', value: 'light' }] }, { mode: 'Dark', bindings: [{ attribute: 'data-theme', value: 'dark' }] }])
  const line = Object.fromEntries(view.collections.map((c) => [c.name, c.line]))
  assert.equal(line.One, 'data-product = one · base')
  assert.equal(line.Business, 'data-product = business · on top of One')
  assert.equal(line.Shared, 'in every data-product')
  assert.equal(line.Product, 'Off')
  assert.equal(view.maxColumns, 4)
  // What a names attribute's marker can be: the segments the token names are made of, not the leaves.
  assert.deepEqual(view.markers.slice(0, 3), [{ segment: 'neutral', tokens: 4 }, { segment: 'background', tokens: 3 }, { segment: 'content', tokens: 3 }])
  assert.ok(!view.markers.some((m) => m.segment === 'base'), 'a leaf is the token, not a marker')
})

test('the file stores the mapping alone, and the export reads it as the settings it stands for', () => {
  const { config, problems } = normalizeFileTokenConfig({ mapping: SERGEY, inlinePrimitives: true })
  assert.deepEqual(problems, [])
  const options = applyFileTokenConfig(normalizeExportOptions({ tokens: { themeAxes: 'stale: a', collectionRoles: 'Stale: hidden' } }), config)
  assert.equal(options.tokens.collectionRoles, mappingToSettings(SERGEY).collectionRoles)
  assert.deepEqual(options.tokens.themeAxes, mappingToSettings(SERGEY).themeAxes)
  assert.equal(options.tokens.slugThemes, true)
  assert.match(normalizeFileTokenConfig({ mapping: { attributes: [{ name: 'x', from: 'nope' }] } }).problems[0], /^"mapping": /)
})

test('a pinned mapping carries the older settings beside it, so an older plugin build ships the same — and they read back as the mapping', () => {
  const s = ds3()
  const pinned = withMapping({ inlinePrimitives: true, structure: { version: 1, collections: [] } as never }, SERGEY)
  assert.equal(pinned.structure, undefined, 'a structure would overrule the older settings in a build that has it')
  assert.equal(pinned.inlinePrimitives, true)
  // A build that knows nothing of `mapping` reads these fields alone.
  const { mapping, ...older } = pinned
  assert.equal(cssOf(s, older), cssOf(s, PIN_27_10))
  // And when such a build saved its settings and dropped the mapping, the screen gets it back.
  assert.deepEqual(mappingFromSettings(older, s), SERGEY)
  assert.deepEqual(mapping, SERGEY)
})

test('a mapping naming columns or collections the file does not hold is a problem, not a quiet export of everything', () => {
  // What the two-product file held on 28.10: the theme read off "Light" and "Dark" columns of Product, whose
  // columns are product × theme — so One, Business and Shared shipped as they stand beside it.
  const broken: TokenMapping = {
    version: 1,
    attributes: [
      { name: 'data-product', from: 'columns', collections: ['Product'], values: [{ value: 'one', columns: ['One Light', 'One Dark'], base: true }, { value: 'business', columns: ['Business Light', 'Business Dark'] }] },
      { name: 'data-theme', from: 'columns', collections: ['Product'], values: [{ value: 'light', columns: ['Light'], base: true }, { value: 'dark', columns: ['Dark'] }] },
    ],
    collections: { Colors: 'palette', Gradients: 'skip' },
  }
  assert.deepEqual(mappingFileProblems(ds3(), broken), ['the file has no collection "Gradients"', 'data-theme: Product has no column "Light", "Dark"'])
  // The developer's: the theme's columns are where the products are, One and Business.
  assert.deepEqual(mappingFileProblems(ds3(), SERGEY), [])
})
