import test from 'node:test'
import assert from 'node:assert/strict'
import {
  darkThemeOf,
  parseColor,
  toAndroidColors,
  toArgbHex,
  toColorSets,
  toNativeFiles,
  toTokensKotlin,
  toTokensSwift,
} from './native.ts'
import { buildPackage, variablesToW3CMultiMode, type TokenGraph, type TokenTree } from './engine.ts'

/** Two colours that change with the theme, one spacing number that does not, and a line-height
 * ratio — the four cases the two languages have to spell differently. */
const TREE: TokenTree = {
  text: {
    primary: {
      $type: 'color',
      $value: '#111118',
      $extensions: { modes: { Light: '#111118', Dark: '#ffffff' } },
    },
  },
  overlay: {
    scrim: {
      $type: 'color',
      $value: 'rgba(0, 0, 0, 0.4)',
      $extensions: { modes: { Light: 'rgba(0, 0, 0, 0.4)', Dark: 'rgba(0, 0, 0, 0.72)' } },
    },
  },
  spacing: {
    md: { $type: 'number', $value: 16, $extensions: { modes: { Light: 16, Dark: 16 } } },
  },
  'line-height': {
    tight: { $type: 'number', $value: 1.2, $extensions: { modes: { Light: 1.2, Dark: 1.2 } } },
  },
}

const ORDERED = ['Light', 'Dark']

/* ------------------------------------------------------------------- colour */

test('the colour forms the tree actually holds all parse; anything else is refused', () => {
  assert.deepEqual(parseColor('#FB5B0A'), { r: 251, g: 91, b: 10, a: 1 })
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.4)'), { r: 0, g: 0, b: 0, a: 0.4 })
  assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 })
  // A gradient, a font family, an unresolved alias: nothing here is a colour, and answering
  // "black" would put a wrong value in a file nobody re-checks.
  assert.equal(parseColor('linear-gradient(#fff, #000)'), null)
  assert.equal(parseColor('{colors.blue.500}'), null)
  assert.equal(parseColor(16), null)
})

test('a native colour is AARRGGBB, not the web byte order', () => {
  assert.equal(toArgbHex({ r: 251, g: 91, b: 10, a: 1 }), '#FFFB5B0A')
  assert.equal(toArgbHex({ r: 0, g: 0, b: 0, a: 0.4 }), '#66000000')
})

test('the dark appearance follows the theme the designer named, whatever they called it', () => {
  assert.equal(darkThemeOf(['Light', 'Dark'], 'Light'), 'Dark')
  assert.equal(darkThemeOf(['Day', 'Night mode'], 'Day'), 'Night mode')
  // One theme means one appearance: duplicating it would claim a dark mode the file has not got.
  assert.equal(darkThemeOf(['Light'], 'Light'), null)
  assert.equal(darkThemeOf(['Brand A', 'Brand B'], 'Brand A'), null)
})

/* --------------------------------------------------------------- catalogue */

test('a colorset carries both appearances, in sRGB components', async () => {
  const files = toColorSets(TREE, ORDERED, 'Light')
  const contents = JSON.parse(files['Assets.xcassets/text-primary.colorset/Contents.json'])

  assert.equal(contents.colors.length, 2)
  assert.equal(contents.colors[0].appearances, undefined, 'the light value is the unqualified one')
  assert.deepEqual(contents.colors[1].appearances, [{ appearance: 'luminosity', value: 'dark' }])
  // Stated, not assumed: an unqualified catalogue entry is read in the display's own space, which
  // shifts the hue on a P3 screen.
  assert.equal(contents.colors[0].color['color-space'], 'srgb')
  assert.deepEqual(contents.colors[0].color.components, {
    red: '0.067',
    green: '0.067',
    blue: '0.094',
    alpha: '1',
  })
})

test('a number token gets no colorset — a catalogue holds colours', () => {
  const files = toColorSets(TREE, ORDERED, 'Light')
  assert.deepEqual(Object.keys(files).sort(), [
    'Assets.xcassets/overlay-scrim.colorset/Contents.json',
    'Assets.xcassets/text-primary.colorset/Contents.json',
  ])
})

test('android splits the appearance by directory, and only when there is a dark theme', () => {
  const both = toAndroidColors(TREE, ORDERED, 'Light')
  assert.match(both['res/values/colors.xml'], /<color name="text_primary">#FF111118<\/color>/)
  assert.match(both['res/values-night/colors.xml'], /<color name="text_primary">#FFFFFFFF<\/color>/)

  const single = toAndroidColors(TREE, ['Light'], 'Light')
  assert.equal('res/values-night/colors.xml' in single, false)
})

/* --------------------------------------------------------------- constants */

test('swift gets the numbers a Color literal takes, and CGFloat only where the token is a length', () => {
  const swift = toTokensSwift(TREE, ORDERED)

  assert.match(swift, /public static let spacingMd = CGFloat\(16\)/)
  // A line-height ratio is a multiplier: `CGFloat(1.2)` would be 1.2 points of leading.
  assert.match(swift, /public static let lineHeightTight = 1\.2/)
  assert.match(swift, /public enum Light \{[\s\S]*textPrimary = Color\(\.sRGB, red: 0\.067/)
  assert.match(swift, /public enum Dark \{[\s\S]*textPrimary = Color\(\.sRGB, red: 1, green: 1, blue: 1, opacity: 1\)/)
})

test('kotlin gets Compose vocabulary: 0xAARRGGBB and dp', () => {
  const kotlin = toTokensKotlin(TREE, ORDERED)

  assert.match(kotlin, /val spacingMd = 16\.dp/)
  assert.match(kotlin, /val lineHeightTight = 1\.2f/)
  assert.match(kotlin, /object Dark \{[\s\S]*val overlayScrim = Color\(0xB8000000\)/)
  assert.match(kotlin, /import androidx\.compose\.ui\.unit\.dp/)
})

test('an OPACITY-scoped variable reaches Swift and Kotlin as a fraction, a name-only "opacity" is left as stored', () => {
  // the two-product file's disabled button: Figma stores 30 for 30%. SwiftUI `.opacity(30)` and Compose
  // `alpha = 30f` both clamp to fully opaque, so the button would not look disabled.
  const scopedOpacity = (scope: string, modes: Record<string, number>) => ({
    $type: 'number',
    $value: modes.Light,
    $extensions: { modes, figma: { collection: 'Effects', defaultMode: 'Light', scopes: [scope] } },
  })
  const tree: TokenTree = {
    component: { button: { opacity: { disabled: scopedOpacity('OPACITY', { Light: 30, Dark: 30 }) } } },
    scrim: { alpha: scopedOpacity('COLOR_OPACITY', { Light: 40, Dark: 72 }) },
    // No scope to prove a percentage: a scope-less file may well store the fraction itself.
    overlay: { opacity: { $type: 'number', $value: 0.5, $extensions: { modes: { Light: 0.5, Dark: 0.5 } } } },
  }

  const swift = toTokensSwift(tree, ORDERED)
  assert.match(swift, /public static let componentButtonOpacityDisabled = 0\.3$/m)
  assert.match(swift, /public enum Light \{[\s\S]*scrimAlpha = 0\.4$/m)
  assert.match(swift, /public enum Dark \{[\s\S]*scrimAlpha = 0\.72$/m)
  assert.match(swift, /public static let overlayOpacity = 0\.5$/m)

  const kotlin = toTokensKotlin(tree, ORDERED)
  assert.match(kotlin, /val componentButtonOpacityDisabled = 0\.3f$/m)
  assert.match(kotlin, /object Light \{[\s\S]*val scrimAlpha = 0\.4f$/m)
  assert.match(kotlin, /object Dark \{[\s\S]*val scrimAlpha = 0\.72f$/m)
  assert.match(kotlin, /val overlayOpacity = 0\.5f$/m)
})

test('a composed colour reaches every native file as the alpha it paints', () => {
  // Update 139's `{ color, opacity }` pair: the opacity half is a percentage, here an alias to a
  // COLOR_OPACITY float. The engine flattens the pair to rgba(); the native files read that.
  const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
  const tree = variablesToW3CMultiMode({
    collections: [{ id: 'c', name: 'Core', modes: [{ modeId: 'm', name: 'Light' }], defaultModeId: 'm' }],
    variables: [
      { id: 'b', name: 'brand', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } },
      { id: 'o', name: 'alpha/40', collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { m: 40 }, scopes: ['COLOR_OPACITY'] },
      { id: 's', name: 'brand/soft', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { color: alias('b'), opacity: alias('o') } } },
    ],
  })
  const files = toNativeFiles(tree, ['Light'], 'Light')

  assert.match(files['Tokens.swift'], /brandSoft = Color\(\.sRGB, red: 1, green: 0, blue: 0, opacity: 0\.4\)/)
  // The opacity variable on its own agrees with the colour it composes into.
  assert.match(files['Tokens.swift'], /public static let alpha40 = 0\.4$/m)
  assert.match(files['Tokens.kt'], /val brandSoft = Color\(0x66FF0000\)/)
  assert.match(files['Tokens.kt'], /val alpha40 = 0\.4f$/m)
  assert.match(files['res/values/colors.xml'], /<color name="brand_soft">#66FF0000<\/color>/)
  const colorset = JSON.parse(files['Assets.xcassets/brand-soft.colorset/Contents.json'])
  assert.equal(colorset.colors[0].color.components.alpha, '0.4')
})

/* ------------------------------------------------------------ through aliases */

/** A primitive layer and a Light/Dark layer that only aliases it: what every themed DS file is.
 * `alpha/40` has neither a scope nor a name that says opacity, so only the consumer's own OPACITY
 * scope can say that its 40 is 40%; `button/fade` is the reverse, unscoped over the OPACITY-scoped
 * `opacity/30`. `card/*` aliases a token of its own layer, which `flattenAliases: false` leaves as
 * a `var()` in the stylesheet. */
const ALIASED: TokenGraph = (() => {
  const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
  const themed = (id: string, name: string, target: string, scopes: string[]) => ({
    id, name, collectionId: 't', resolvedType: 'FLOAT', scopes,
    valuesByMode: { l: alias(target), d: alias(target) },
  })
  return {
    fileName: 'aliases',
    collections: [
      { id: 'p', name: 'Primitives', modes: [{ modeId: 'v', name: 'Value' }], defaultModeId: 'v' },
      { id: 't', name: 'Theme', modes: [{ modeId: 'l', name: 'Light' }, { modeId: 'd', name: 'Dark' }], defaultModeId: 'l' },
    ],
    variables: [
      { id: 's16', name: 'space/16', collectionId: 'p', resolvedType: 'FLOAT', scopes: ['GAP'], valuesByMode: { v: 16 } },
      { id: 'o30', name: 'opacity/30', collectionId: 'p', resolvedType: 'FLOAT', scopes: ['OPACITY'], valuesByMode: { v: 30 } },
      { id: 'a40', name: 'alpha/40', collectionId: 'p', resolvedType: 'FLOAT', scopes: [], valuesByMode: { v: 40 } },
      { id: 'white', name: 'gray/0', collectionId: 'p', resolvedType: 'COLOR', valuesByMode: { v: { r: 1, g: 1, b: 1, a: 1 } } },
      { id: 'black', name: 'gray/900', collectionId: 'p', resolvedType: 'COLOR', valuesByMode: { v: { r: 0, g: 0, b: 0, a: 1 } } },
      themed('gap', 'button/gap', 's16', ['ALL_SCOPES']),
      themed('disabled', 'button/opacity/disabled', 'o30', ['OPACITY']),
      themed('pressed', 'button/opacity/pressed', 'a40', ['OPACITY']),
      themed('fade', 'button/fade', 'o30', ['ALL_SCOPES']),
      themed('card-gap', 'card/gap', 'gap', ['ALL_SCOPES']),
      { id: 'bg', name: 'surface/bg', collectionId: 't', resolvedType: 'COLOR', valuesByMode: { l: alias('white'), d: alias('black') } },
      { id: 'card-bg', name: 'card/bg', collectionId: 't', resolvedType: 'COLOR', valuesByMode: { l: alias('bg'), d: alias('bg') } },
    ],
  } as TokenGraph
})()

/** Every way the panel can ship aliases: inlined and flattened, inlined to the primitives only,
 * and left as references — and the primitive layer hidden, where `shapeForCode` substitutes it
 * before any alias chain exists. None of them may reach a native constant as a reference or as
 * CSS. */
const ALIAS_SETTINGS = [
  { inlinePrimitives: true, flattenAliases: true },
  { inlinePrimitives: true, flattenAliases: false },
  { inlinePrimitives: false, flattenAliases: false },
  { inlinePrimitives: true, flattenAliases: true, collectionRoles: 'Primitives: hidden' },
  { inlinePrimitives: false, flattenAliases: false, collectionRoles: 'Primitives: hidden' },
]

test('an aliased length reaches Swift and Kotlin as the number, not as the CSS it renders to', () => {
  // The inlined stylesheet holds `"16px"` and the uninlined one `var(--space-16)`; Swift got
  // whichever it was as a String, where `.padding()` wants a CGFloat.
  for (const settings of ALIAS_SETTINGS) {
    const { files } = buildPackage(ALIASED, { emitNative: true, ...settings })
    const label = JSON.stringify(settings)
    // `button/gap` is scope-less: the primitive's GAP scope is what says it is a length.
    assert.match(files['Tokens.swift'], /public static let buttonGap = CGFloat\(16\)$/m, label)
    assert.match(files['Tokens.swift'], /public static let cardGap = CGFloat\(16\)$/m, label)
    assert.match(files['Tokens.kt'], /val buttonGap = 16\.dp$/m, label)
    assert.match(files['Tokens.kt'], /val cardGap = 16\.dp$/m, label)
    for (const name of ['Tokens.swift', 'Tokens.kt']) assert.doesNotMatch(files[name], /"16px"|var\(--/, `${name} ${label}`)
  }
})

test('an aliased OPACITY-scoped value reaches Swift, Kotlin and CSS as a fraction, whichever end holds the scope', () => {
  for (const settings of ALIAS_SETTINGS) {
    const { files } = buildPackage(ALIASED, { emitNative: true, ...settings })
    const label = JSON.stringify(settings)
    // Scoped at both ends.
    assert.match(files['Tokens.swift'], /public static let buttonOpacityDisabled = 0\.3$/m, label)
    assert.match(files['Tokens.kt'], /val buttonOpacityDisabled = 0\.3f$/m, label)
    // Scoped only on the consumer: the primitive alone reads as `40` — or, by its name, `40px`.
    assert.match(files['Tokens.swift'], /public static let buttonOpacityPressed = 0\.4$/m, label)
    assert.match(files['Tokens.kt'], /val buttonOpacityPressed = 0\.4f$/m, label)
  }
  const inlined = buildPackage(ALIASED, { emitNative: true, inlinePrimitives: true, flattenAliases: true })
  assert.match(inlined.files['tokens.css'], /--button-opacity-disabled: 0\.3;/)
  assert.match(inlined.files['tokens.css'], /--button-opacity-pressed: 0\.4;/)
})

test('an unscoped value over a hidden OPACITY primitive reaches Swift, Kotlin and CSS as a fraction', () => {
  // Hidden, `opacity/30` was substituted into `button/fade` and its scope went with it: the
  // consumer, read by its own name, shipped `30px` and `CGFloat(30)`.
  for (const settings of ALIAS_SETTINGS) {
    const { files } = buildPackage(ALIASED, { emitNative: true, ...settings })
    const label = JSON.stringify(settings)
    assert.match(files['Tokens.swift'], /public static let buttonFade = 0\.3$/m, label)
    assert.match(files['Tokens.kt'], /val buttonFade = 0\.3f$/m, label)
  }
  const hidden = buildPackage(ALIASED, {
    emitNative: true,
    inlinePrimitives: true,
    flattenAliases: true,
    collectionRoles: 'Primitives: hidden',
  })
  assert.match(hidden.files['tokens.css'], /--button-fade: 0\.3;/)
  assert.match(hidden.files['tokens.css'], /--button-opacity-disabled: 0\.3;/)
  for (const name of ['tokens.css', 'Tokens.swift', 'Tokens.kt']) assert.doesNotMatch(hidden.files[name], /30px|CGFloat\(30\)|30\.dp/, name)
})

test('a hidden primitive layer ships the values an inlined one does, whichever link holds the evidence', () => {
  // Hiding a layer decides what is emitted, not what a value means. Every consumer here is
  // unscoped: `opacity/30` proves its unit by scope, the other two only by name — and the hidden
  // export read all three by the consumer's name instead, as `30px`, `1.5px` and `0.5px`.
  const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
  const themed = (id: string, name: string, target: string) => ({
    id, name, collectionId: 't', resolvedType: 'FLOAT', scopes: ['ALL_SCOPES'],
    valuesByMode: { l: alias(target), d: alias(target) },
  })
  const graph = {
    collections: [
      { id: 'p', name: 'Primitives', modes: [{ modeId: 'v', name: 'Value' }], defaultModeId: 'v' },
      { id: 't', name: 'Theme', modes: [{ modeId: 'l', name: 'Light' }, { modeId: 'd', name: 'Dark' }], defaultModeId: 'l' },
    ],
    variables: [
      { id: 'o30', name: 'opacity/30', collectionId: 'p', resolvedType: 'FLOAT', scopes: ['OPACITY'], valuesByMode: { v: 30 } },
      { id: 'lh', name: 'line-height/150', collectionId: 'p', resolvedType: 'FLOAT', scopes: ['ALL_SCOPES'], valuesByMode: { v: 1.5 } },
      { id: 'half', name: 'opacity/half', collectionId: 'p', resolvedType: 'FLOAT', scopes: ['ALL_SCOPES'], valuesByMode: { v: 0.5 } },
      themed('fade', 'button/fade', 'o30'),
      themed('lead', 'body/leading', 'lh'),
      themed('scrim', 'overlay/scrim', 'half'),
    ],
  } as TokenGraph
  const inlined = buildPackage(graph, { emitNative: true, inlinePrimitives: true, flattenAliases: true }).files
  const hidden = buildPackage(graph, { emitNative: true, inlinePrimitives: true, flattenAliases: true, collectionRoles: 'Primitives: hidden' }).files

  assert.match(hidden['tokens.css'], /--button-fade: 0\.3;\n  --body-leading: 1\.5;\n  --overlay-scrim: 0\.5;/)
  assert.match(hidden['Tokens.kt'], /val buttonFade = 0\.3f\n    val bodyLeading = 1\.5f\n    val overlayScrim = 0\.5f/)
  for (const name of ['tokens.css', 'Tokens.swift', 'Tokens.kt']) assert.equal(hidden[name], inlined[name], name)
})

test('an aliased colour reaches the catalogue and the resources however the stylesheet ships aliases', () => {
  // Uninlined, every themed colour is an alias, and an alias is no colour `parseColor` can read:
  // the whole theme layer used to fall out of the native files without a word.
  for (const settings of ALIAS_SETTINGS) {
    const { files } = buildPackage(ALIASED, { emitNative: true, ...settings })
    const label = JSON.stringify(settings)
    for (const name of ['surface-bg', 'card-bg']) {
      const set = JSON.parse(files[`Assets.xcassets/${name}.colorset/Contents.json`] ?? 'null')
      assert.ok(set, `${name}.colorset ${label}`)
      assert.equal(set.colors.length, 2, `${name} has a dark appearance ${label}`)
      assert.equal(set.colors[1].color.components.red, '0', label)
    }
    assert.match(files['res/values/colors.xml'], /<color name="card_bg">#FFFFFFFF<\/color>/, label)
    assert.match(files['res/values-night/colors.xml'], /<color name="card_bg">#FF000000<\/color>/, label)
    assert.match(files['Tokens.swift'], /public enum Dark \{[\s\S]*cardBg = Color\(\.sRGB, red: 0, green: 0, blue: 0, opacity: 1\)/, label)
    assert.match(files['Tokens.kt'], /object Dark \{[\s\S]*val cardBg = Color\(0xFF000000\)/, label)
  }
})

test('an alias nothing in the export resolves is left out of the constants, as an unreadable colour is', () => {
  // A library variable the read did not carry: `"var(--x)"` in Swift is CSS in a String.
  const tree: TokenTree = {
    button: { gap: { $type: 'number', $value: '{library.space.16}', $extensions: { modes: { Light: '{library.space.16}' } } } },
    spacing: { md: { $type: 'number', $value: 16, $extensions: { modes: { Light: 16 } } } },
  }
  const swift = toTokensSwift(tree, ['Light'])
  const kotlin = toTokensKotlin(tree, ['Light'])
  assert.doesNotMatch(swift, /buttonGap/)
  assert.doesNotMatch(kotlin, /buttonGap/)
  assert.match(swift, /spacingMd = CGFloat\(16\)/)
})

test('a token identical in every theme is declared once, above the themes', () => {
  // Half a palette is primitives that do not move with the theme; repeating them per theme
  // invites a consumer to believe they might.
  const swift = toTokensSwift(TREE, ORDERED)
  const occurrences = swift.split('spacingMd').length - 1

  assert.equal(occurrences, 1)
  assert.ok(swift.indexOf('spacingMd') < swift.indexOf('public enum Light'))
})

test('a theme name that is not an identifier still becomes one', () => {
  const tree: TokenTree = {
    a: { $type: 'color', $value: '#000', $extensions: { modes: { 'Light Theme': '#000', 'Dark Theme': '#fff' } } },
  }
  const kotlin = toTokensKotlin(tree, ['Light Theme', 'Dark Theme'])

  assert.match(kotlin, /object LightTheme \{/)
  assert.match(kotlin, /object DarkTheme \{/)
})

test('the native file set is the platform layout, whatever the file themes', () => {
  const files = toNativeFiles(TREE, ORDERED, 'Light')
  const names = Object.keys(files)

  assert.ok(names.includes('Tokens.swift'))
  assert.ok(names.includes('Tokens.kt'))
  assert.ok(names.includes('res/values/colors.xml'))
  assert.ok(names.some((name) => name.endsWith('.colorset/Contents.json')))
})

test('an appearance entry is written only where the colour actually changes', () => {
  // A duplicate dark entry claims the token responds to the appearance; a night resource file
  // that repeats an unchanged colour has to be edited twice forever.
  const tree: TokenTree = {
    fixed: { $type: 'color', $value: '#FB5B0A', $extensions: { modes: { Light: '#FB5B0A', Dark: '#FB5B0A' } } },
    moving: { $type: 'color', $value: '#111118', $extensions: { modes: { Light: '#111118', Dark: '#ffffff' } } },
  }

  const fixed = JSON.parse(toColorSets(tree, ORDERED, 'Light')['Assets.xcassets/fixed.colorset/Contents.json'])
  const moving = JSON.parse(toColorSets(tree, ORDERED, 'Light')['Assets.xcassets/moving.colorset/Contents.json'])
  assert.equal(fixed.colors.length, 1)
  assert.equal(moving.colors.length, 2)

  const android = toAndroidColors(tree, ORDERED, 'Light')
  assert.match(android['res/values/colors.xml'], /name="fixed"/)
  assert.doesNotMatch(android['res/values-night/colors.xml'], /name="fixed"/)
  assert.match(android['res/values-night/colors.xml'], /name="moving">#FFFFFFFF</)
})
