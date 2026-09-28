/**
 * What a number token MEANS, and what each platform therefore has to spell.
 *
 * Figma calls a corner radius, a gap, a font size and an opacity all `FLOAT`. Deciding the unit
 * from the name alone worked for CSS (`px` or nothing) and silently broke Android, where a text
 * metric in `dp` ignores the user's system font-size setting. These tests pin the three things
 * that fixes: the kind comes from Figma's own scopes when the file has them, the name is only a
 * fallback, and Compose gets `sp` for text and `dp` for layout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  codeSyntaxOf,
  cssValue,
  isLengthKind,
  isLengthToken,
  isTextMetricKind,
  tokenKind,
  variablesToW3CMultiMode,
  type TokenGraph,
  type TokenTree,
  type W3CToken,
} from './engine.ts'
import { camelIdentifier, resourceName, toAndroidColors, toTokensKotlin, toTokensSwift } from './native.ts'

const scoped = (type: string, value: number | string, scopes: string[]): W3CToken => ({
  $type: type,
  $value: value,
  $extensions: {
    modes: { Light: value },
    figma: { collection: 'Core', defaultMode: 'Light', ...(scopes.length > 0 ? { scopes } : {}) },
  },
})

/* ------------------------------------------------------------------- kinds */

test('a scope decides the kind even when the name disagrees', () => {
  // `scale/16` is the real case from this file: the name says nothing, the scope says radius.
  assert.equal(tokenKind(scoped('number', 16, ['CORNER_RADIUS']), ['scale', '16']), 'radius')
  assert.equal(tokenKind(scoped('number', 16, ['GAP']), ['scale', '16']), 'spacing')
  assert.equal(tokenKind(scoped('number', 14, ['FONT_SIZE']), ['scale', '14']), 'fontSize')
  assert.equal(tokenKind(scoped('number', 1, ['STROKE_FLOAT']), ['scale', '1']), 'borderWidth')
  assert.equal(tokenKind(scoped('number', 0.4, ['OPACITY']), ['scale', '40']), 'opacity')
})

test('the name answers only when no scope does', () => {
  assert.equal(tokenKind(scoped('number', 14, []), ['font-size', 'sm']), 'fontSize')
  assert.equal(tokenKind(undefined, ['line-height', 'body']), 'lineHeight')
  assert.equal(tokenKind(undefined, ['radius', 'md']), 'radius')
  assert.equal(tokenKind(undefined, ['opacity', 'muted']), 'opacity')
  // Nothing recognisable is a length: that is what every unnamed spacing token in a real file is.
  assert.equal(tokenKind(undefined, ['foo', 'bar']), 'length')
})

test('a colour is a colour before anything else is consulted', () => {
  assert.equal(tokenKind(scoped('color', '#fff', ['TEXT_FILL']), ['line-height', 'x']), 'color')
})

test('text metrics are exactly the three Android sizes in sp', () => {
  assert.ok(isTextMetricKind('fontSize'))
  assert.ok(isTextMetricKind('lineHeight'))
  assert.ok(isTextMetricKind('letterSpacing'))
  assert.ok(!isTextMetricKind('spacing'))
  assert.ok(!isTextMetricKind('radius'))
})

test('a line-height is a ratio below 4 and a length at or above it', () => {
  assert.ok(!isLengthKind('lineHeight', 1.5))
  assert.ok(isLengthKind('lineHeight', 24))
  // Zero has no unit in any language.
  assert.ok(!isLengthKind('spacing', 0))
})

/* ------------------------------------------------- the CSS answer is unchanged */

test('the CSS emitter renders exactly what it rendered before the kind existed', () => {
  assert.equal(isLengthToken(16, ['spacing', 'md']), true)
  assert.equal(isLengthToken(0.3, ['opacity', 'muted']), false)
  assert.equal(isLengthToken(500, ['font-weight', 'medium']), false)
  assert.equal(isLengthToken(1.5, ['line-height', 'body']), false)
  assert.equal(isLengthToken(24, ['line-height', 'body']), true)
  assert.equal(isLengthToken(2, ['z-index', 'modal']), false)
  // `scale` is a length here and was the bug that proved it: a unitless 16 made every
  // `calc(var(--scale-16, 16px) * 1.36)` invalid.
  assert.equal(isLengthToken(16, ['scale', '16']), true)
})

test('a duration carries milliseconds, not pixels', () => {
  // `200px` for a transition-duration is not a near miss, it is an invalid declaration.
  assert.equal(cssValue(200, ['motion', 'duration', 'fast']), '200ms')
  assert.equal(cssValue(80, ['delay', 'short']), '80ms')
  assert.equal(cssValue(16, ['spacing', 'md']), '16px')
})

/* --------------------------------------------------------------- Compose units */

test('Compose sizes text in sp and layout in dp', () => {
  const tree: TokenTree = {
    type: {
      size: scoped('number', 14, ['FONT_SIZE']),
      leading: scoped('number', 20, ['LINE_HEIGHT']),
      tracking: scoped('number', -0.32, ['LETTER_SPACING']),
      ratio: scoped('number', 1.5, ['LINE_HEIGHT']),
    },
    space: { md: scoped('number', 16, ['GAP']) },
    corner: { sm: scoped('number', 4, ['CORNER_RADIUS']) },
    fade: { muted: scoped('number', 0.4, ['OPACITY']) },
  }
  const kotlin = toTokensKotlin(tree, ['Light'])
  assert.match(kotlin, /val typeSize = 14\.sp/)
  assert.match(kotlin, /val typeLeading = 20\.sp/)
  assert.match(kotlin, /val typeTracking = -0\.32\.sp/)
  // A ratio is neither sp nor dp — it is a multiplier Compose takes as a float.
  assert.match(kotlin, /val typeRatio = 1\.5f/)
  assert.match(kotlin, /val spaceMd = 16\.dp/)
  assert.match(kotlin, /val cornerSm = 4\.dp/)
  assert.match(kotlin, /val fadeMuted = 0\.4f/)
})

test('Compose imports only the units the file actually uses', () => {
  const layoutOnly = toTokensKotlin({ space: { md: scoped('number', 16, ['GAP']) } }, ['Light'])
  assert.match(layoutOnly, /import androidx\.compose\.ui\.unit\.dp/)
  assert.ok(!layoutOnly.includes('unit.sp'), 'no sp import when nothing is a text metric')

  const textOnly = toTokensKotlin({ size: { sm: scoped('number', 14, ['FONT_SIZE']) } }, ['Light'])
  assert.match(textOnly, /import androidx\.compose\.ui\.unit\.sp/)
  assert.ok(!textOnly.includes('unit.dp'), 'no dp import when nothing is a layout length')
})

test('Swift keeps a ratio out of CGFloat', () => {
  const swift = toTokensSwift(
    {
      space: { md: scoped('number', 16, ['GAP']) },
      lead: { body: scoped('number', 1.5, ['LINE_HEIGHT']) },
    },
    ['Light']
  )
  assert.match(swift, /public static let spaceMd = CGFloat\(16\)/)
  assert.match(swift, /public static let leadBody = 1\.5$/m)
})

/* ------------------------------------------------------------- committed names */

const withSyntax = (syntax: Record<string, string>): W3CToken => ({
  $type: 'color',
  $value: '#112233',
  $extensions: {
    modes: { Light: '#112233' },
    figma: { collection: 'Core', defaultMode: 'Light', codeSyntax: syntax },
  },
})

test('codeSyntax survives the graph into the token tree', () => {
  const graph: TokenGraph = {
    collections: [{ id: 'c1', name: 'Core', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }] }],
    variables: [
      {
        id: 'v1',
        name: 'text/primary',
        collectionId: 'c1',
        resolvedType: 'COLOR',
        valuesByMode: { m1: { r: 0, g: 0, b: 0 } },
        codeSyntax: { WEB: '--ink', ANDROID: 'ink_strong', iOS: 'Color.inkStrong' },
      },
      {
        id: 'v2',
        name: 'text/muted',
        collectionId: 'c1',
        resolvedType: 'COLOR',
        valuesByMode: { m1: { r: 1, g: 1, b: 1 } },
        // An empty string is a designer who opened the field and closed it — not a commitment.
        codeSyntax: { ANDROID: '   ' },
      },
    ],
  }
  const tree = variablesToW3CMultiMode(graph) as { text: { primary: W3CToken; muted: W3CToken } }
  assert.deepEqual(codeSyntaxOf(tree.text.primary), {
    WEB: '--ink',
    ANDROID: 'ink_strong',
    iOS: 'Color.inkStrong',
  })
  assert.equal(codeSyntaxOf(tree.text.muted), undefined)
})

test('the name the team committed to beats the one we would invent', () => {
  const tree: TokenTree = { text: { primary: withSyntax({ ANDROID: 'ink_strong', iOS: 'Color.inkStrong' }) } }
  assert.match(toTokensSwift(tree, ['Light']), /public static let colorInkStrong = /)
  assert.match(toAndroidColors(tree, ['Light'], 'Light')['res/values/colors.xml'], /name="ink_strong"/)
})

test('a token with no commitment keeps the spelling the CSS package uses', () => {
  const tree: TokenTree = {
    text: {
      primary: {
        $type: 'color',
        $value: '#112233',
        $extensions: { modes: { Light: '#112233' } },
      },
    },
  }
  assert.match(toTokensSwift(tree, ['Light']), /public static let textPrimary = /)
  assert.equal(resourceName(['text', 'primary']), 'text_primary')
})

test('a committed name is made legal for its language, not pasted raw', () => {
  // `R.color.brand-500` is not a resource name and `2xl` is not an identifier.
  assert.equal(resourceName(['x'], { ANDROID: 'R.color.brand-500' }), 'r_color_brand_500')
  assert.equal(resourceName(['x'], { ANDROID: '2xl' }), '_2xl')
  // A camel hump is a word boundary on Android and stays a hump on iOS.
  assert.equal(resourceName(['x'], { ANDROID: 'inkStrong' }), 'ink_strong')
  assert.equal(camelIdentifier(['x'], { iOS: 'ink_strong' }), 'inkStrong')
  // An acronym survives as one word rather than being shattered letter by letter.
  assert.equal(resourceName(['x'], { ANDROID: 'URLColor' }), 'url_color')
  assert.equal(camelIdentifier(['x'], { iOS: 'URLColor' }), 'urlColor')
})
