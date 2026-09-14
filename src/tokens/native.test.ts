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
import type { TokenTree } from './engine.ts'

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
