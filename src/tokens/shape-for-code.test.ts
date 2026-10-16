import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPackage, parseCollectionModes, type TokenGraph } from './engine.ts'

/**
 * The shape of Corporate Design Library, the file a developer asked for "clean, short" tokens
 * from: a library palette it only reaches through aliases, a one-mode primitive layer aliasing
 * that palette, a one-mode semantic layer aliasing the primitives, a breakpoint collection and a
 * typography scale beside the text styles. The export it produced was six theme blocks of the
 * same three hundred variables; these pin what it should have been.
 */

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
const rgb = (r: number, g: number, b: number) => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 })

function consumerFile(extra: Partial<TokenGraph> = {}): TokenGraph {
  return {
    collections: [
      { id: 'c-lib', name: 'Colors', defaultModeId: 'm-value', modes: [{ modeId: 'm-value', name: 'Value' }], inlineOnly: true },
      { id: 'c-prim', name: 'Primitives', defaultModeId: 'm-1', modes: [{ modeId: 'm-1', name: 'Mode 1' }] },
      { id: 'c-tok', name: 'Tokens', defaultModeId: 'm-light', modes: [{ modeId: 'm-light', name: 'Light' }] },
      {
        id: 'c-bp',
        name: 'Breakpoints',
        defaultModeId: 'm-desk',
        modes: [
          { modeId: 'm-desk', name: 'Desktop' },
          { modeId: 'm-tab', name: 'Tablet' },
          { modeId: 'm-mob', name: 'Mobile' },
        ],
      },
      { id: 'c-typo', name: 'Typography', defaultModeId: 'm-t', modes: [{ modeId: 'm-t', name: 'Mode 1' }] },
      ...(extra.collections ?? []),
    ],
    variables: [
      { id: 'lib-blue', name: 'blue/700', collectionId: 'c-lib', resolvedType: 'COLOR', valuesByMode: { 'm-value': rgb(43, 64, 109) } },
      { id: 'p-b800', name: 'colors/b/800', collectionId: 'c-prim', resolvedType: 'COLOR', valuesByMode: { 'm-1': alias('lib-blue') } },
      { id: 't-action', name: 'colors/action/default', collectionId: 'c-tok', resolvedType: 'COLOR', valuesByMode: { 'm-light': alias('p-b800') } },
      {
        id: 'bp-width',
        name: 'width',
        collectionId: 'c-bp',
        resolvedType: 'FLOAT',
        valuesByMode: { 'm-desk': 1440, 'm-tab': 768, 'm-mob': 375 },
      },
      {
        id: 'bp-layout',
        name: 'layout',
        collectionId: 'c-bp',
        resolvedType: 'STRING',
        valuesByMode: { 'm-desk': 'Desktop', 'm-tab': 'Tablet', 'm-mob': 'Mobile' },
      },
      { id: 'fs-lg', name: 'font-size/lg', collectionId: 'c-typo', resolvedType: 'FLOAT', valuesByMode: { 'm-t': 24 } },
      ...(extra.variables ?? []),
    ],
    textStyles: [
      {
        id: 's-h3',
        name: 'Headings/H3',
        fontName: { family: 'Inter', style: 'Semi Bold' },
        fontSize: 24,
        lineHeight: { unit: 'PIXELS', value: 32 },
        letterSpacing: { unit: 'PERCENT', value: -2 },
      },
    ],
  } as TokenGraph
}

const sergeysSettings = {
  inlinePrimitives: true,
  flattenAliases: true,
  themeAttr: 'data-theme-name',
  typoScaleOnly: true,
  collectionRoles: 'Primitives: hidden',
}

test('a consumer file exports its semantic tokens as plain values under one :root', () => {
  const css = buildPackage(consumerFile(), sergeysSettings).files['tokens.css']

  assert.match(css, /^:root \{/)
  assert.match(css, /--colors-action-default: #2b406d;/)
  // Nothing the file only consumes, nothing it hid, no theme it does not have.
  assert.doesNotMatch(css, /blue-700|colors-b-800|variableid|Mode 1|data-theme-name|var\(/)
})

test('frame widths are not breakpoints: without thresholds no --bp-* is emitted, and the export says why', () => {
  // Corporate's Breakpoints held Width = 1440/834/390 per mode — the artboards. Exported as
  // --bp-mobile: 390px they read as min-widths, which they are not.
  const pkg = buildPackage(consumerFile(), sergeysSettings)
  const css = pkg.files['tokens.css']

  assert.doesNotMatch(css, /--bp-|--number-width|--string-layout|"Desktop"/)
  assert.ok(pkg.summary.notes?.some((note) => /Breakpoints holds frame widths .*no thresholds/.test(note)), String(pkg.summary.notes))
})

test('breakpoint/* thresholds become --bp-*, narrowest first, one value whatever the mode', () => {
  const thresholds = [['xs', 0], ['md', 768], ['sm', 576], ['3xl', 1700]].map(([name, px]) => ({
    id: `bp-${name}`,
    name: `breakpoint/${name}`,
    collectionId: 'c-bp',
    resolvedType: 'FLOAT',
    valuesByMode: { 'm-desk': px, 'm-tab': px, 'm-mob': px },
  }))
  const pkg = buildPackage(consumerFile({ variables: thresholds as TokenGraph['variables'] }), sergeysSettings)
  const css = pkg.files['tokens.css']

  const bp = [...css.matchAll(/--bp-([a-z0-9]+): (\d+)px;/g)].map((m) => `${m[1]}=${m[2]}`)
  assert.deepEqual(bp, ['xs=0', 'sm=576', 'md=768', '3xl=1700'])
  assert.doesNotMatch(css, /1440px|834px|375px/)
  assert.ok(!pkg.summary.notes?.some((note) => /frame widths/.test(note)))
})

test('scale only leaves the text-style mirror out once there is a scale to compose from', () => {
  const css = buildPackage(consumerFile(), sergeysSettings).files['tokens.css']

  assert.match(css, /--font-size-lg: 24px;/)
  assert.doesNotMatch(css, /--typography-/)

  const withMirror = buildPackage(consumerFile(), { ...sergeysSettings, typoScaleOnly: false }).files['tokens.css']
  assert.match(withMirror, /--typography-headings-h3-font-size: 24px;/)
})

test('a real theme gets its own block, holding only what it changes', () => {
  const graph = consumerFile({
    collections: [
      {
        id: 'c-theme',
        name: 'Theme',
        defaultModeId: 'm-l',
        modes: [
          { modeId: 'm-l', name: 'Light' },
          { modeId: 'm-d', name: 'Dark' },
        ],
      },
    ],
    variables: [
      {
        id: 'th-bg',
        name: 'surface/base',
        collectionId: 'c-theme',
        resolvedType: 'COLOR',
        valuesByMode: { 'm-l': rgb(255, 255, 255), 'm-d': rgb(16, 16, 16) },
      },
    ],
  })
  const css = buildPackage(graph, sergeysSettings).files['tokens.css']

  assert.match(css, /:root,\n\[data-theme-name="Light"\] \{/)
  const dark = /\[data-theme-name="Dark"\] \{\n([\s\S]*?)\n\}/.exec(css)
  assert.ok(dark, 'a Dark block')
  const declarations = dark[1].split('\n').filter((line) => line.includes('--')).map((line) => line.trim())
  assert.deepEqual(declarations, ['--surface-base: #101010;'])
})

test('a hidden layer still resolves when nothing is flattened', () => {
  // Hiding is about what is emitted, not about whether references are followed: a token that
  // pointed at a hidden primitive must not be left holding var(--) to something that is gone.
  const css = buildPackage(consumerFile(), { ...sergeysSettings, inlinePrimitives: false, flattenAliases: false }).files['tokens.css']

  assert.match(css, /--colors-action-default: #2b406d;/)
  assert.doesNotMatch(css, /colors-b-800/)
})

test('collection roles read hidden and breakpoint collections, in any spelling', () => {
  assert.deepEqual(parseCollectionModes('Primitives: hidden, Viewports = bp; Mesure: spacing; One: product'), {
    hidden: ['Primitives'],
    breakpoints: ['Viewports'],
    products: ['One'],
  })
})

test('a variable named private stays out of the code, and what points at it still resolves', () => {
  // Corporate keeps nine `_deprecated/…` sizes published for old consumers; the slug drops the
  // underscore, so they used to reach code as `--deprecated-font-size-sm`.
  const graph = consumerFile({
    variables: [
      { id: 'fs-old', name: '_deprecated/font-size/sm', collectionId: 'c-typo', resolvedType: 'FLOAT', valuesByMode: { 'm-t': 13 } },
      { id: 'fs-cap', name: 'font-size/caption', collectionId: 'c-typo', resolvedType: 'FLOAT', valuesByMode: { 'm-t': alias('fs-old') } },
    ],
  })
  const css = buildPackage(graph, sergeysSettings).files['tokens.css']

  assert.doesNotMatch(css, /deprecated/)
  assert.match(css, /--font-size-caption: 13px;/)
})

test('a semantic token another one points at survives when its primitive layer is hidden', () => {
  // Live on Corporate: with Primitives hidden, --colors-action-default and thirteen others
  // vanished — the tokens the glyph and button colours alias.
  const graph = consumerFile({
    variables: [
      { id: 't-glyph', name: 'colors/glyph/action', collectionId: 'c-tok', resolvedType: 'COLOR', valuesByMode: { 'm-light': alias('t-action') } },
    ],
  })
  const css = buildPackage(graph, sergeysSettings).files['tokens.css']

  assert.match(css, /--colors-action-default: #2b406d;/)
  assert.match(css, /--colors-glyph-action: #2b406d;/)
})

test('a primitive that aliases a library stays a primitive when nothing is hidden', () => {
  // Without a hidden role the primitive layer is still inlined where it is used and dropped
  // there — reaching its own value through the library does not make it semantic.
  const css = buildPackage(consumerFile(), { ...sergeysSettings, collectionRoles: '' }).files['tokens.css']

  assert.match(css, /--colors-action-default: #2b406d;/)
  assert.doesNotMatch(css, /colors-b-800/)
})

/** Two parallel products over one palette, the shape of DS 3.0: One and Business define the same
 * names with their own values, each in Light and Dark; Business has not caught up on everything. */
function productsFile(): TokenGraph {
  const lightDark = (id: string) => ({
    id,
    name: id === 'c-one' ? 'One' : 'Business',
    defaultModeId: `${id}-l`,
    modes: [
      { modeId: `${id}-l`, name: 'Light' },
      { modeId: `${id}-d`, name: 'Dark' },
    ],
  })
  return {
    collections: [
      { id: 'c-pal', name: 'Colors', defaultModeId: 'v', modes: [{ modeId: 'v', name: 'Value' }] },
      lightDark('c-one'),
      lightDark('c-bus'),
    ],
    variables: [
      { id: 'pal-white', name: 'neutral/0', collectionId: 'c-pal', resolvedType: 'COLOR', valuesByMode: { v: rgb(255, 255, 255) } },
      { id: 'pal-black', name: 'neutral/1000', collectionId: 'c-pal', resolvedType: 'COLOR', valuesByMode: { v: rgb(0, 0, 0) } },
      { id: 'pal-orange', name: 'orange/500', collectionId: 'c-pal', resolvedType: 'COLOR', valuesByMode: { v: rgb(251, 91, 10) } },
      { id: 'pal-blue', name: 'blue/900', collectionId: 'c-pal', resolvedType: 'COLOR', valuesByMode: { v: rgb(0, 5, 55) } },
      { id: 'one-bg', name: 'background/base', collectionId: 'c-one', resolvedType: 'COLOR', valuesByMode: { 'c-one-l': alias('pal-white'), 'c-one-d': alias('pal-black') } },
      { id: 'one-act', name: 'action/primary', collectionId: 'c-one', resolvedType: 'COLOR', valuesByMode: { 'c-one-l': alias('pal-orange'), 'c-one-d': alias('pal-orange') } },
      { id: 'one-nav', name: 'navigation/background', collectionId: 'c-one', resolvedType: 'COLOR', valuesByMode: { 'c-one-l': alias('pal-white'), 'c-one-d': alias('pal-black') } },
      { id: 'bus-bg', name: 'background/base', collectionId: 'c-bus', resolvedType: 'COLOR', valuesByMode: { 'c-bus-l': alias('pal-white'), 'c-bus-d': alias('pal-black') } },
      { id: 'bus-act', name: 'action/primary', collectionId: 'c-bus', resolvedType: 'COLOR', valuesByMode: { 'c-bus-l': alias('pal-blue'), 'c-bus-d': alias('pal-white') } },
    ],
  } as TokenGraph
}

const productSettings = { ...sergeysSettings, collectionRoles: 'Colors: hidden, One: product, Business: product' }

test('each product gets its own file, with the same names and its own Light and Dark', () => {
  const pkg = buildPackage(productsFile(), productSettings)
  const one = pkg.files['one.css']
  const business = pkg.files['business.css']

  assert.match(one, /:root,\n\[data-theme-name="Light"\] \{[\s\S]*--action-primary: #fb5b0a;/)
  assert.match(business, /:root,\n\[data-theme-name="Light"\] \{[\s\S]*--action-primary: #000537;/)
  assert.match(business, /\[data-theme-name="Dark"\] \{[\s\S]*--action-primary: #ffffff;/)
  // The same name in both, never a `-2`, and neither product inside the other's file.
  assert.doesNotMatch(one + business, /-2:/)
  assert.doesNotMatch(one, /#000537/)
  assert.doesNotMatch(business, /--navigation-background/)
  assert.doesNotMatch(pkg.files['tokens.css'] ?? '', /--action-primary|--background-base/)
})

test('a product missing what another product defines is told so', () => {
  const pkg = buildPackage(productsFile(), productSettings)
  const business = pkg.summary.products?.find((p) => p.name === 'Business')

  assert.deepEqual(business?.missing, ['navigation-background'])
  assert.deepEqual(pkg.summary.products?.find((p) => p.name === 'One')?.missing, [])
  assert.ok(pkg.summary.notes?.some((note) => note.startsWith('Business lacks 1 token')))
})

test('per-theme modules are named after their product', () => {
  const files = Object.keys(buildPackage(productsFile(), productSettings).files)

  for (const name of ['one-light.module.css', 'one-dark.module.css', 'business-light.module.css', 'business-dark.module.css']) {
    assert.ok(files.includes(name), `${name} in ${files.join(', ')}`)
  }
})
