/**
 * The same token tree, for the two platforms that do not read CSS.
 *
 * `tokens.css` and `tokens.ts` are the web's projection of the tree: custom properties, and a TS
 * object whose leaves are the *strings* `var(--text-primary)`. Handed to SwiftUI or Compose, the
 * second is worse than nothing - it type-checks and resolves to a colour no iOS runtime has ever
 * heard of. So the same leaves are emitted twice more, in the form each platform's own theming
 * actually consumes:
 *
 * - **An asset catalogue.** iOS does light/dark below the language: one `.colorset` per colour
 *   with an `appearances` entry, and `Color("text-primary")` picks the right one with no
 *   conditional in the app at all. This is why the colours come out as a directory of manifests
 *   rather than as Swift literals - a Swift constant cannot follow the system appearance.
 * - **`values/` and `values-night/`.** Android's equivalent, by resource qualifier.
 * - **Swift and Kotlin constants** for everything a catalogue cannot hold (spacing, radii, type
 *   scale) and for the colours too, since a build that themes in code rather than in assets needs
 *   the numbers.
 *
 * A token whose value is identical in every theme is emitted once, at the top: half a palette is
 * primitives that do not change with the theme, and repeating them per theme invites a consumer to
 * believe they might.
 */

import { cssValue, isLengthToken, leaves, valueForTheme, varName, type TokenTree, type TokenValue } from './engine.ts'

/* -------------------------------------------------------------------- colour */

export interface Rgba {
  /** 0-255. */
  readonly r: number
  readonly g: number
  readonly b: number
  /** 0-1. */
  readonly a: number
}

/**
 * The colour forms the token tree actually holds - `#rgb`, `#rrggbb`, `#rrggbbaa` and
 * `rgba(r, g, b, a)`, which is what `figmaColorToCss` produces. Anything else (a gradient, a
 * name, an unresolved alias) returns `null`, and the caller leaves that token out of the native
 * files rather than shipping black.
 */
export function parseColor(value: TokenValue): Rgba | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text)
  if (hex) {
    const digits = hex[1]
    const expand = (pair: string): number => parseInt(pair.length === 1 ? pair + pair : pair, 16)
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      }
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      }
    }
    return null
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (!rgb) return null
  const parts = rgb[1].split(/[,/\s]+/).filter((part) => part !== '')
  if (parts.length < 3) return null
  const channel = (raw: string): number => {
    const n = raw.endsWith('%') ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw)
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : NaN
  }
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  if ([r, g, b].some((n) => Number.isNaN(n))) return null
  const alpha = parts[3] === undefined ? 1 : Number(parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : parts[3])
  return { r, g, b, a: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1 }
}

/** Two colours a consumer could not tell apart at the precision this emitter writes. */
function sameColor(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && round(a.a) === round(b.a)
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** `#AARRGGBB`, Android's and Compose's byte order - not the web's `#RRGGBBAA`. */
export function toArgbHex(color: Rgba): string {
  const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase()
  return `#${byte(color.a * 255)}${byte(color.r)}${byte(color.g)}${byte(color.b)}`
}

/* --------------------------------------------------------------------- names */

/** `text/primary` → `textPrimary`. The CSS name is the shared spelling, so the two packages name
 * the same token the same way up to the language's own casing rule. */
export function camelIdentifier(path: readonly string[]): string {
  const kebab = varName(path as string[])
  const camel = kebab.replace(/-+([0-9a-z])/gi, (_, chr: string) => chr.toUpperCase())
  // An identifier cannot begin with a digit in either language; a token named `2xl` is common.
  return /^[0-9]/.test(camel) ? `_${camel}` : camel
}

/** Android resource names take `[a-z0-9_]` only, and a leading digit is invalid there too. */
export function resourceName(path: readonly string[]): string {
  const snake = varName(path as string[]).replace(/-+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '')
  return /^[0-9]/.test(snake) ? `_${snake}` : snake
}

/* --------------------------------------------------------------------- themes */

/** The theme a platform's dark appearance should take its values from. Figma theme modes are
 * designer-named free text (`Dark`, `Dark Theme`, `Night`), so this matches by substring - the same
 * tolerance the rest of this codebase applies to designer-chosen names. `null` when the file has
 * one theme, or none whose name says dark: a single-appearance catalogue is the right answer then,
 * not a duplicated one. */
export function darkThemeOf(ordered: readonly string[], defaultTheme: string): string | null {
  return ordered.find((theme) => theme !== defaultTheme && /dark|night/i.test(theme)) ?? null
}

interface Grouped {
  /** Tokens whose value is the same in every theme - emitted once. */
  readonly shared: Array<{ path: string[]; type: string; value: TokenValue }>
  /** Tokens that differ, with one value per theme. */
  readonly themed: Array<{ path: string[]; type: string; values: Record<string, TokenValue> }>
}

function group(tree: TokenTree, ordered: readonly string[]): Grouped {
  const shared: Grouped['shared'] = []
  const themed: Grouped['themed'] = []
  for (const leaf of leaves(tree)) {
    const values: Record<string, TokenValue> = {}
    for (const theme of ordered) values[theme] = valueForTheme(leaf.token, theme)
    const distinct = new Set(ordered.map((theme) => JSON.stringify(values[theme])))
    if (distinct.size <= 1) shared.push({ path: leaf.path, type: leaf.token.$type, value: values[ordered[0]] })
    else themed.push({ path: leaf.path, type: leaf.token.$type, values })
  }
  return { shared, themed }
}

/* ---------------------------------------------------------------- catalogues */

const HEADER = 'Generated by Altery Design System Export - edit the Figma variables, not this file.'

/**
 * One `.colorset` per colour token, with the dark appearance folded in where the file has a dark
 * theme. `Color("text-primary")` then resolves per appearance with nothing in the app deciding.
 *
 * `color-space: srgb` is stated rather than left out: Figma's variables ARE sRGB, and an
 * unqualified catalogue entry is interpreted in the display's own space, which shifts the hue on a
 * P3 screen - the one place this export could be silently wrong on real hardware.
 */
export function toColorSets(tree: TokenTree, ordered: readonly string[], defaultTheme: string): Record<string, string> {
  const dark = darkThemeOf(ordered, defaultTheme)
  const files: Record<string, string> = {}
  for (const leaf of leaves(tree)) {
    if (leaf.token.$type !== 'color') continue
    const light = parseColor(valueForTheme(leaf.token, defaultTheme))
    if (!light) continue
    const entry = (color: Rgba, appearance: 'dark' | null) => ({
      idiom: 'universal' as const,
      ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
      color: {
        'color-space': 'srgb',
        components: {
          red: `${round(color.r / 255)}`,
          green: `${round(color.g / 255)}`,
          blue: `${round(color.b / 255)}`,
          alpha: `${round(color.a)}`,
        },
      },
    })
    const colors = [entry(light, null)]
    const darkColor = dark ? parseColor(valueForTheme(leaf.token, dark)) : null
    // Only when it actually differs. A second entry with the same components claims the token
    // changes with the appearance, and a designer reading the catalogue would believe it.
    if (darkColor && !sameColor(light, darkColor)) colors.push(entry(darkColor, 'dark'))
    const name = varName(leaf.path)
    files[`Assets.xcassets/${name}.colorset/Contents.json`] = JSON.stringify(
      { colors, info: { author: 'altery-figma', version: 1 } },
      null,
      2
    )
  }
  return files
}

/**
 * `values/colors.xml` plus `values-night/colors.xml` - Android's appearance switch is the
 * qualifier on the directory, so the night file exists only when the file has a dark theme.
 *
 * The night file carries ONLY the colours that differ. A qualified resource file is an override
 * list, not a copy: repeating an unchanged colour there means every future edit has to be made
 * twice or the two silently disagree.
 */
export function toAndroidColors(tree: TokenTree, ordered: readonly string[], defaultTheme: string): Record<string, string> {
  const dark = darkThemeOf(ordered, defaultTheme)
  const rows = (theme: string, changedOnly = false): string[] => {
    const out: string[] = []
    for (const leaf of leaves(tree)) {
      if (leaf.token.$type !== 'color') continue
      const color = parseColor(valueForTheme(leaf.token, theme))
      if (!color) continue
      if (changedOnly) {
        const base = parseColor(valueForTheme(leaf.token, defaultTheme))
        if (base && sameColor(base, color)) continue
      }
      out.push(`    <color name="${resourceName(leaf.path)}">${toArgbHex(color)}</color>`)
    }
    return out
  }
  const document = (lines: readonly string[]): string =>
    `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${HEADER} -->\n<resources>\n${lines.join('\n')}\n</resources>\n`

  const light = rows(defaultTheme)
  if (light.length === 0) return {}
  const files: Record<string, string> = { 'res/values/colors.xml': document(light) }
  const night = dark ? rows(dark, true) : []
  if (night.length > 0) files['res/values-night/colors.xml'] = document(night)
  return files
}

/* ----------------------------------------------------------------- constants */

function swiftValue(type: string, value: TokenValue, path: readonly string[]): string | null {
  if (type === 'color') {
    const color = parseColor(value)
    if (!color) return null
    return `Color(.sRGB, red: ${round(color.r / 255)}, green: ${round(color.g / 255)}, blue: ${round(color.b / 255)}, opacity: ${round(color.a)})`
  }
  if (typeof value === 'number') return isLengthToken(value, path) ? `CGFloat(${round(value, 4)})` : `${round(value, 4)}`
  if (typeof value === 'boolean') return String(value)
  // A string token (a font family, a shadow) travels as the string it is - the CSS emitter's own
  // rendering, so the two packages agree on what a non-numeric token says.
  return JSON.stringify(cssValue(value, path))
}

function kotlinValue(type: string, value: TokenValue, path: readonly string[]): string | null {
  if (type === 'color') {
    const color = parseColor(value)
    if (!color) return null
    return `Color(0x${toArgbHex(color).slice(1)})`
  }
  if (typeof value === 'number') return isLengthToken(value, path) ? `${round(value, 4)}.dp` : `${round(value, 4)}f`
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(cssValue(value, path))
}

function block(
  indent: string,
  entries: ReadonlyArray<{ path: string[]; rendered: string }>,
  declare: (name: string, rendered: string) => string
): string[] {
  return entries.map((entry) => `${indent}${declare(camelIdentifier(entry.path), entry.rendered)}`)
}

/** Theme names as an identifier a nested type can take (`Dark Theme` → `DarkTheme`). */
function themeType(theme: string): string {
  const parts = theme.split(/[^0-9a-z]+/i).filter((part) => part !== '')
  const joined = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('')
  return /^[0-9]/.test(joined) || joined === '' ? `Theme${joined}` : joined
}

/**
 * `Tokens.swift` - the shared tokens at the top, one nested enum per theme for the rest.
 *
 * Colours are here as well as in the catalogue on purpose: a SwiftUI build that switches theme in
 * code (a preview, a `@Environment` override, a design-system package with no asset catalogue of
 * its own) needs the literal, and one that leans on the catalogue simply ignores these.
 */
export function toTokensSwift(tree: TokenTree, ordered: readonly string[]): string {
  const { shared, themed } = group(tree, ordered)
  const declare = (name: string, rendered: string) => `public static let ${name} = ${rendered}`
  const sharedLines = block(
    '    ',
    shared.flatMap((entry) => {
      const rendered = swiftValue(entry.type, entry.value, entry.path)
      return rendered ? [{ path: entry.path, rendered }] : []
    }),
    declare
  )
  const themeBlocks = ordered.map((theme) => {
    const lines = block(
      '        ',
      themed.flatMap((entry) => {
        const rendered = swiftValue(entry.type, entry.values[theme], entry.path)
        return rendered ? [{ path: entry.path, rendered }] : []
      }),
      declare
    )
    return `    public enum ${themeType(theme)} {\n${lines.join('\n')}\n    }`
  })
  return (
    `// ${HEADER}\nimport SwiftUI\n\npublic enum Tokens {\n` +
    (sharedLines.length > 0 ? `    // The same in every theme.\n${sharedLines.join('\n')}\n\n` : '') +
    themeBlocks.join('\n\n') +
    `\n}\n`
  )
}

/** `Tokens.kt` - the same shape in Compose's vocabulary: `Color(0xAARRGGBB)` and `Dp`. */
export function toTokensKotlin(tree: TokenTree, ordered: readonly string[]): string {
  const { shared, themed } = group(tree, ordered)
  const declare = (name: string, rendered: string) => `val ${name} = ${rendered}`
  const sharedLines = block(
    '    ',
    shared.flatMap((entry) => {
      const rendered = kotlinValue(entry.type, entry.value, entry.path)
      return rendered ? [{ path: entry.path, rendered }] : []
    }),
    declare
  )
  const themeBlocks = ordered.map((theme) => {
    const lines = block(
      '        ',
      themed.flatMap((entry) => {
        const rendered = kotlinValue(entry.type, entry.values[theme], entry.path)
        return rendered ? [{ path: entry.path, rendered }] : []
      }),
      declare
    )
    return `    object ${themeType(theme)} {\n${lines.join('\n')}\n    }`
  })
  return (
    `// ${HEADER}\nimport androidx.compose.ui.graphics.Color\nimport androidx.compose.ui.unit.dp\n\nobject Tokens {\n` +
    (sharedLines.length > 0 ? `    // The same in every theme.\n${sharedLines.join('\n')}\n\n` : '') +
    themeBlocks.join('\n\n') +
    `\n}\n`
  )
}

/** Every native file for one emitted tree - the set `buildPackage` adds when native output is on. */
export function toNativeFiles(tree: TokenTree, ordered: readonly string[], defaultTheme: string): Record<string, string> {
  // One theme and no dark mode still gets the catalogue and the constants: the platform layout is
  // the point, not the appearance switch.
  return {
    ...toColorSets(tree, ordered, defaultTheme),
    ...toAndroidColors(tree, ordered, defaultTheme),
    'Tokens.swift': toTokensSwift(tree, ordered),
    'Tokens.kt': toTokensKotlin(tree, ordered),
  }
}
