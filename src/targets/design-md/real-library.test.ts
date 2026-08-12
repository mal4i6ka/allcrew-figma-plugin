/**
 * Regression fixture from a REAL corporate design library (read live through the Figma MCP
 * server), not a synthetic tree. Its naming scheme is what broke the first cut of the classifier:
 * plural groups (`colors/buttons`, `colors/borders`, `colors/fills`), participle states
 * (`hovered`, `pressed`) and an explicit resting marker (`default`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTokenModel, splitState, classifyRole, rolesFromScopes, lifecycleOf } from './model.ts'
import type { TokenTree, TokenValue, W3CToken } from '../../tokens/engine.ts'

function token(value: TokenValue, type = 'color', scopes?: readonly string[]): W3CToken {
  return {
    $type: type,
    $value: value,
    $extensions: { modes: { Light: value }, figma: { collection: 'Colors', defaultMode: 'Light', scopes } },
  }
}

/** Verbatim slice of the library's variables (values as exported). */
const TREE: TokenTree = {
  colors: {
    buttons: {
      primary: {
        default: token('#002780'),
        hovered: token('#222660'),
        pressed: token('#000537'),
        error: { default: token('#cd1918'), hovered: token('#a01213'), pressed: token('#720e0d') },
      },
      secondary: {
        default: token('#ebf1ff'),
        hovered: token('#d6e2ff'),
        pressed: token('#c2d4ff'),
      },
      ghost: { hovered: token('#69707c14'), pressed: token('#69707c29') },
      grey: { default: token('#11141a') },
    },
    borders: {
      'grey-default': token('#d7dae0'),
      'grey-hovered': token('#9da3ae'),
      'negative-default': token('#cd1918'),
      'active-default': token('#002780'),
    },
    fills: { primary: token('#ffffff'), secondary: token('#69707c14') },
    glyph: {
      primary: token('#11141a'),
      secondary: token('#69707c'),
      'action-default': token('#002780'),
      'action-hovered': token('#222660'),
      'primary-inverse': token('#ffffff'),
    },
    tags: { warning: token('#fff2b3') },
  },
  spacing: { xs: token(4, 'number'), sm: token(8, 'number'), md: token(12, 'number') },
  radius: { xs: token(4, 'number'), sm: token(8, 'number'), md: token(12, 'number') },
  'font-size': { xs: token(12, 'number'), md: token(14, 'number') },
  'line-height': { xs: token(16, 'number'), sm: token(20, 'number') },
  'font-weight': { regular: token(400, 'number'), medium: token(500, 'number') },
  'font-family': { inter: token('Inter', 'string') },
}

const model = buildTokenModel(TREE, ['Light'], 'Light')
const bySlug = new Map(model.entries.map((entry) => [entry.slug, entry]))

test('plural group names classify like their singular form', () => {
  assert.equal(bySlug.get('colors-borders-grey-default')!.role, 'border')
  assert.equal(bySlug.get('colors-fills-primary')!.role, 'surface')
  assert.equal(bySlug.get('colors-glyph-primary')!.role, 'icon')
})

test('participle states and the resting marker are recognised', () => {
  assert.deepEqual(splitState('colors-buttons-primary-hovered'), { base: 'colors-buttons-primary', state: 'hovered' })
  assert.deepEqual(splitState('colors-borders-grey-hovered'), { base: 'colors-borders-grey', state: 'hovered' })
  assert.deepEqual(splitState('colors-buttons-primary-default'), { base: 'colors-buttons-primary' })
  assert.equal(bySlug.get('colors-buttons-primary-pressed')!.state, 'pressed')
  // The state must not cost the token its role: a hovered border is still a border.
  assert.equal(bySlug.get('colors-borders-grey-hovered')!.role, 'border')
  assert.equal(bySlug.get('colors-glyph-action-hovered')!.role, 'icon')
})

test('component roll-up keeps one block per component, variants as rows', () => {
  const buttons = model.components.find((block) => block.prefix.join('/') === 'colors/buttons')
  assert.ok(buttons, 'the buttons group is detected through its plural name')
  assert.equal(buttons!.name, 'Buttons')
  assert.deepEqual(
    buttons!.variants.map((variant) => variant.name).sort(),
    ['Ghost', 'Grey', 'Primary', 'Primary · Error', 'Secondary']
  )
  // All 12 button tokens live in ONE section, not 5 — that is what keeps a large system readable.
  assert.equal(buttons!.entryCount, 12)
  assert.ok(model.components.some((block) => block.name === 'Tags'))
})

test('Figma variable scopes outrank the name heuristic', () => {
  assert.deepEqual(rolesFromScopes(['FRAME_FILL']), ['surface'])
  assert.deepEqual(rolesFromScopes(['TEXT_FILL']), ['text'])
  assert.deepEqual(rolesFromScopes(['STROKE_COLOR']), ['border'])
  // Multi-scope is normal in a real library — keep every home instead of giving up.
  assert.deepEqual(rolesFromScopes(['FRAME_FILL', 'TEXT_FILL']), ['surface', 'text'])
  assert.deepEqual(rolesFromScopes([]), [])

  const scopedTree: TokenTree = {
    colors: { buttons: { primary: { default: token('#002780', 'color', ['FRAME_FILL']) } } },
  }
  const scoped = buildTokenModel(scopedTree, ['Light'], 'Light').entries[0]
  // By name alone this token is unclassifiable; the designer's scope settles it.
  assert.equal(classifyRole('colors-buttons-primary', 'color'), 'color')
  assert.equal(scoped.role, 'surface')
  assert.equal(scoped.roleSource, 'scope')
})

test('the scale layers stay correctly typed', () => {
  assert.equal(bySlug.get('spacing-md')!.role, 'spacing')
  assert.equal(bySlug.get('radius-md')!.role, 'radius')
  assert.equal(bySlug.get('font-size-md')!.role, 'font-size')
  assert.equal(bySlug.get('line-height-sm')!.role, 'line-height')
  assert.equal(bySlug.get('font-weight-medium')!.role, 'font-weight')
  assert.equal(bySlug.get('font-family-inter')!.role, 'font-family')
})

/* ---- the plugin's own tokens.json from that library: multi-scope, lifecycle, breakpoints ---- */

const SCOPED_TREE: TokenTree = {
  colors: {
    // Scoped to every fill kind + text: legitimately usable as background, icon and text.
    action: { default: token('#002780', 'color', ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL']) },
    // Vector + text fill only — an icon/label color, never a container background.
    glyph: { primary: token('#11141a', 'color', ['SHAPE_FILL', 'TEXT_FILL']) },
    buttons: { primary: { default: token('#002780', 'color', ['FRAME_FILL']) } },
    borders: { 'grey-default': token('#d7dae0', 'color', ['STROKE_COLOR']) },
    fills: { 'background EXPERIMENTAL': token('#f7f8fb', 'color', ['FRAME_FILL']) },
  },
  spacing: { md: token(12, 'number', ['GAP']) },
  radius: { md: token(12, 'number', ['CORNER_RADIUS']) },
}

test('a multi-scope token keeps every property its scopes allow', () => {
  const model = buildTokenModel(SCOPED_TREE, ['Light'], 'Light')
  const by = new Map(model.entries.map((entry) => [entry.slug, entry]))

  const action = by.get('colors-action-default')!
  assert.equal(action.roleSource, 'scope')
  assert.deepEqual(action.scopeRoles, ['surface', 'text', 'icon'])
  // Deduped: text and icon both land on `color`.
  assert.equal(action.applyTo, 'background-color / color / fill')

  // SHAPE_FILL is the VECTOR fill, not a background — a glyph token must not read as a surface.
  const glyph = by.get('colors-glyph-primary')!
  assert.equal(glyph.role, 'icon')
  assert.equal(glyph.applyTo, 'color / fill')

  // Nameless as to role, but FRAME_FILL settles it — this is what "unscoped" used to mislabel.
  const button = by.get('colors-buttons-primary-default')!
  assert.equal(button.role, 'surface')
  assert.equal(button.roleSource, 'scope')

  assert.equal(by.get('colors-borders-grey-default')!.role, 'border')
  assert.equal(by.get('spacing-md')!.role, 'spacing')
  assert.equal(by.get('radius-md')!.role, 'radius')
})

test('lifecycle markers in a token name are surfaced as a DO-NOT', () => {
  const model = buildTokenModel(SCOPED_TREE, ['Light'], 'Light')
  const flagged = model.entries.filter((entry) => entry.lifecycle)
  assert.deepEqual(flagged.map((entry) => entry.slug), ['colors-fills-background-experimental'])
  assert.equal(flagged[0].lifecycle, 'experimental')
  // A colour called "Gold" must not read as "old".
  assert.equal(lifecycleOf(['colors', 'Gold', '500']), undefined)
})

test('a modes-as-breakpoints Width variable reads as a breakpoint, not a fixed size', () => {
  const tree: TokenTree = {
    number: {
      Width: {
        $type: 'number',
        $value: 1440,
        $extensions: {
          modes: { Desktop: 1440, Tablet: 834, Mobile: 390 },
          figma: { collection: 'Breakpoints', defaultMode: 'Desktop' },
        },
      },
    },
  }
  const entry = buildTokenModel(tree, ['Desktop'], 'Desktop').entries[0]
  assert.equal(entry.role, 'breakpoint')
})
