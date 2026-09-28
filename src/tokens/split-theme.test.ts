import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  darkCompanionName,
  foldSplitThemeCollections,
  isDarkCompanionOf,
  parseCollectionMerges,
  singleModeCollectionState,
} from './split-theme.ts'
import { emitTokenArtifacts } from './index.ts'

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })

/** A paid-plan file: one `theme` collection carrying both modes. */
const twoModes = () => ({
  collections: [
    { id: 'c-colors', name: 'colors', defaultModeId: 'm-colors', modes: [{ modeId: 'm-colors', name: 'Value' }] },
    {
      id: 'c-theme',
      name: 'theme',
      defaultModeId: 'm-light',
      modes: [
        { modeId: 'm-light', name: 'Light' },
        { modeId: 'm-dark', name: 'Dark' },
      ],
    },
  ],
  variables: [
    {
      id: 'v-n0',
      name: 'Neutral/N0',
      collectionId: 'c-colors',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-colors': { r: 1, g: 1, b: 1 } },
    },
    {
      id: 'v-n1000',
      name: 'Neutral/N1000',
      collectionId: 'c-colors',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-colors': { r: 0, g: 0, b: 0 } },
    },
    {
      id: 'v-canvas',
      name: 'bg/canvas',
      collectionId: 'c-theme',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-light': alias('v-n0'), 'm-dark': alias('v-n1000') },
    },
  ],
})

/** The same file on the free plan: the dark values live in a companion collection. */
const split = () => ({
  collections: [
    { id: 'c-colors', name: 'colors', defaultModeId: 'm-colors', modes: [{ modeId: 'm-colors', name: 'Value' }] },
    { id: 'c-theme', name: 'theme', defaultModeId: 'm-light', modes: [{ modeId: 'm-light', name: 'Light' }] },
    { id: 'c-dark', name: 'theme-dark', defaultModeId: 'm-dark', modes: [{ modeId: 'm-dark', name: 'Dark' }] },
  ],
  variables: [
    {
      id: 'v-n0',
      name: 'Neutral/N0',
      collectionId: 'c-colors',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-colors': { r: 1, g: 1, b: 1 } },
    },
    {
      id: 'v-n1000',
      name: 'Neutral/N1000',
      collectionId: 'c-colors',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-colors': { r: 0, g: 0, b: 0 } },
    },
    {
      id: 'v-canvas',
      name: 'bg/canvas',
      collectionId: 'c-theme',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-light': alias('v-n0') },
    },
    {
      id: 'v-canvas-dark',
      name: 'bg/canvas',
      collectionId: 'c-dark',
      resolvedType: 'COLOR',
      scopes: [],
      valuesByMode: { 'm-dark': alias('v-n1000') },
    },
  ],
})

const emitOptions = { inlinePrimitives: false, flattenAliases: false, themeAttribute: 'data-theme' }
const cssOf = (snapshot: unknown) => emitTokenArtifacts(foldSplitThemeCollections(snapshot as never) as never, emitOptions)

test('the companion collection disappears into a second mode on the base', () => {
  const folded = foldSplitThemeCollections(split())
  assert.deepEqual(
    folded.collections.map((c) => c.name),
    ['colors', 'theme']
  )
  const theme = folded.collections.find((c) => c.name === 'theme')!
  assert.deepEqual(
    theme.modes.map((m) => m.name),
    ['Light', 'Dark']
  )
  const canvas = folded.variables.find((v) => v.id === 'v-canvas')!
  assert.deepEqual(canvas.valuesByMode, { 'm-light': alias('v-n0'), 'm-dark': alias('v-n1000') })
  assert.equal(folded.variables.some((v) => v.collectionId === 'c-dark'), false)
})

test('a split file emits exactly the stylesheet a two-mode file does', () => {
  // The whole point of the workaround: the free-plan limitation must not reach the output.
  assert.equal(cssOf(split()).css, cssOf(twoModes()).css)
  assert.deepEqual(cssOf(split()).themes, ['Light', 'Dark'])
})

test('the emitted CSS really carries both themes', () => {
  const css = cssOf(split()).css
  assert.ok(css.includes(':root'), css)
  assert.ok(/\[data-theme[^\]]*=["']?dark/i.test(css), css)
})

test('the JSON token tree matches the two-mode file too', () => {
  assert.equal(cssOf(split()).json, cssOf(twoModes()).json)
})

test('folding is idempotent — a paid-plan snapshot passes through untouched', () => {
  const paid = twoModes()
  assert.deepEqual(foldSplitThemeCollections(paid), paid)
  const once = foldSplitThemeCollections(split())
  assert.deepEqual(foldSplitThemeCollections(once), once)
})

test('a generic mode name on the companion is replaced with "Dark"', () => {
  // Figma names a new collection's only mode "Mode 1"; that must not become the theme name.
  const snapshot = split()
  snapshot.collections[2].modes = [{ modeId: 'm-dark', name: 'Mode 1' }]
  const theme = foldSplitThemeCollections(snapshot).collections.find((c) => c.name === 'theme')!
  assert.deepEqual(
    theme.modes.map((m) => m.name),
    ['Light', 'Dark']
  )
})

test('generic single modes are named Light and Dark after an automatic fold', () => {
  const snapshot = split()
  snapshot.collections[1].modes = [{ modeId: 'm-light', name: 'Mode 1' }]
  snapshot.collections[2].modes = [{ modeId: 'm-dark', name: 'Mode 1' }]
  const theme = foldSplitThemeCollections(snapshot).collections.find((collection) => collection.name === 'theme')!
  assert.deepEqual(
    theme.modes.map((mode) => mode.name),
    ['Light', 'Dark']
  )
})

test('an explicit pair folds arbitrarily named free-plan collections', () => {
  const snapshot = split()
  snapshot.collections[1].name = 'Semantic day'
  snapshot.collections[1].modes = [{ modeId: 'm-light', name: 'Mode 1' }]
  snapshot.collections[2].name = 'Semantic night'
  snapshot.collections[2].modes = [{ modeId: 'm-dark', name: 'Mode 1' }]

  const folded = foldSplitThemeCollections(snapshot, [{
    name: 'theme',
    modes: [
      { collection: 'Semantic day', name: 'Light' },
      { collection: 'Semantic night', name: 'Dark' },
    ],
  }])
  const theme = folded.collections.find((collection) => collection.name === 'theme')!
  assert.deepEqual(
    theme.modes.map((mode) => mode.name),
    ['Light', 'Dark']
  )
  assert.equal(cssOf(folded).css, cssOf(twoModes()).css)
})

test('merge declarations are semicolon separated and malformed rows are ignored', () => {
  assert.deepEqual(
    parseCollectionMerges(
      'Theme = Semantic light + Semantic dark; invalid; Brand = Brand day + Brand night'
    ),
    [
      {
        name: 'Theme',
        modes: [
          { collection: 'Semantic light', name: 'Light' },
          { collection: 'Semantic dark', name: 'Dark' },
        ],
      },
      {
        name: 'Brand',
        modes: [
          { collection: 'Brand day', name: 'Light' },
          { collection: 'Brand night', name: 'Dark' },
        ],
      },
    ]
  )
})

test('one logical collection can contain more than two free-plan themes', () => {
  const snapshot = split()
  snapshot.collections[1].name = 'theme-light'
  snapshot.collections.push({
    id: 'c-contrast',
    name: 'theme-contrast',
    defaultModeId: 'm-contrast',
    modes: [{ modeId: 'm-contrast', name: 'Mode 1' }],
  })
  snapshot.variables.push({
    id: 'v-canvas-contrast',
    name: 'bg/canvas',
    collectionId: 'c-contrast',
    resolvedType: 'COLOR',
    scopes: [],
    valuesByMode: { 'm-contrast': alias('v-n1000') },
  })

  const folded = foldSplitThemeCollections(snapshot, [{
    name: 'Theme',
    modes: [
      { collection: 'theme-light', name: 'Light' },
      { collection: 'theme-dark', name: 'Dark' },
      { collection: 'theme-contrast', name: 'High contrast' },
    ],
  }])
  const theme = folded.collections.find((collection) => collection.name === 'Theme')!
  assert.deepEqual(theme.modes.map((mode) => mode.name), ['Light', 'Dark', 'High contrast'])
  assert.deepEqual(
    folded.variables.find((variable) => variable.name === 'bg/canvas')!.valuesByMode,
    {
      'm-light': alias('v-n0'),
      'm-dark': alias('v-n1000'),
      'm-contrast': alias('v-n1000'),
    }
  )
})

test('a companion-only token survives with the modes it actually has', () => {
  const snapshot = split()
  snapshot.variables.push({
    id: 'v-dark-only',
    name: 'accent/rose/base',
    collectionId: 'c-dark',
    resolvedType: 'COLOR',
    scopes: [],
    valuesByMode: { 'm-dark': alias('v-n1000') },
  })
  const folded = foldSplitThemeCollections(snapshot)
  const rose = folded.variables.find((variable) => variable.name === 'accent/rose/base')!
  assert.equal(rose.collectionId, 'c-theme')
  assert.deepEqual(rose.valuesByMode, { 'm-dark': alias('v-n1000') })
})

test('a lookalike name is left alone when the two collections share no variables', () => {
  // "Surface" and "Surface dark" that describe different things are a naming coincidence,
  // not a split theme — folding them would silently corrupt both.
  const snapshot = {
    collections: [
      { id: 'a', name: 'Surface', defaultModeId: 'ma', modes: [{ modeId: 'ma', name: 'Value' }] },
      { id: 'b', name: 'Surface dark', defaultModeId: 'mb', modes: [{ modeId: 'mb', name: 'Value' }] },
    ],
    variables: [
      { id: 'v1', name: 'card', collectionId: 'a', valuesByMode: { ma: { r: 1, g: 1, b: 1 } } },
      { id: 'v2', name: 'shadow', collectionId: 'b', valuesByMode: { mb: { r: 0, g: 0, b: 0 } } },
    ],
  }
  assert.deepEqual(foldSplitThemeCollections(snapshot), snapshot)
})

test('a collection merely named "Dark" is not mistaken for a companion', () => {
  const snapshot = {
    collections: [
      { id: 'a', name: 'theme', defaultModeId: 'ma', modes: [{ modeId: 'ma', name: 'Light' }] },
      { id: 'b', name: 'Dark', defaultModeId: 'mb', modes: [{ modeId: 'mb', name: 'Value' }] },
    ],
    variables: [
      { id: 'v1', name: 'bg', collectionId: 'a', valuesByMode: { ma: 1 } },
      { id: 'v2', name: 'bg', collectionId: 'b', valuesByMode: { mb: 2 } },
    ],
  }
  assert.deepEqual(foldSplitThemeCollections(snapshot), snapshot)
})

test('separator variants are all recognised', () => {
  for (const name of ['theme-dark', 'theme dark', 'theme_dark', 'Theme-Dark']) {
    const snapshot = split()
    snapshot.collections[2].name = name
    const folded = foldSplitThemeCollections(snapshot)
    assert.equal(folded.collections.length, 2, `${name} was not folded`)
  }
})

test('a base token with no dark counterpart survives as a single value', () => {
  const snapshot = split()
  snapshot.variables.push({
    id: 'v-radius',
    name: 'border/radius',
    collectionId: 'c-theme',
    resolvedType: 'COLOR',
    scopes: [],
    valuesByMode: { 'm-light': alias('v-n0') },
  })
  const folded = foldSplitThemeCollections(snapshot)
  const radius = folded.variables.find((v) => v.id === 'v-radius')!
  assert.deepEqual(Object.keys(radius.valuesByMode), ['m-light'])
})

test('the fold does not mutate the snapshot it was given', () => {
  const snapshot = split()
  const before = JSON.stringify(snapshot)
  foldSplitThemeCollections(snapshot)
  assert.equal(JSON.stringify(snapshot), before)
})

test('the companion name and its recogniser agree', () => {
  assert.equal(darkCompanionName('theme'), 'theme-dark')
  assert.ok(isDarkCompanionOf(darkCompanionName('theme'), 'theme'))
  assert.ok(isDarkCompanionOf('Theme Dark', 'theme'))
  assert.equal(isDarkCompanionOf('theme', 'theme'), false)
  assert.equal(isDarkCompanionOf('other-dark', 'theme'), false)
})

test('the free-plan workaround is offered only for an all-single-mode file', () => {
  const free = singleModeCollectionState(split().collections)
  assert.equal(free.singleModeOnly, true)
  assert.deepEqual(free.collections.map((collection) => collection.name), ['colors', 'theme', 'theme-dark'])

  const paid = singleModeCollectionState(twoModes().collections)
  assert.equal(paid.singleModeOnly, false)
  assert.deepEqual(paid.collections.map((collection) => collection.name), ['colors'])
})
