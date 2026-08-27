/**
 * Color literals as they appear in text — scanning, parsing, and writing back.
 *
 * Two consumers with one requirement in common: a color found in text must be replaceable
 * *in its own notation*. The pasted-palette parser needs to recognise whatever a designer
 * copied out of their tool; the repository rewriter (phase 2) must put the new value back
 * as a hex where it found a hex and as an `rgba()` where it found an `rgba()`, or every
 * diff turns into a notation churn nobody asked for.
 *
 * Alpha is carried through untouched everywhere: a remap moves RGB, never transparency.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { formatHex, parseHex, type Rgb } from '../color.ts'

export interface Rgba extends Rgb {
  /** 0…1. */
  a: number
}

/** How the literal was written, so a replacement can be emitted the same way. */
export type ColorNotation = 'hex3' | 'hex4' | 'hex6' | 'hex8' | 'rgb' | 'hsl'

export interface ColorLiteral {
  rgba: Rgba
  notation: ColorNotation
  /** The exact matched text. */
  source: string
  /** Index of `source` in the scanned string. */
  start: number
  end: number
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/* ------------------------------------------------------------------ hsl */

/** CSS `hsl()` — h in degrees, s and l as 0…1. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60
  const chroma = (1 - Math.abs(2 * l - 1)) * clamp01(s)
  const second = chroma * (1 - Math.abs((hue % 2) - 1))
  const [r, g, b] =
    hue < 1
      ? [chroma, second, 0]
      : hue < 2
        ? [second, chroma, 0]
        : hue < 3
          ? [0, chroma, second]
          : hue < 4
            ? [0, second, chroma]
            : hue < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const match = clamp01(l) - chroma / 2
  return { r: r + match, g: g + match, b: b + match }
}

export function rgbToHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const r = clamp01(rgb.r)
  const g = clamp01(rgb.g)
  const b = clamp01(rgb.b)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const delta = max - min
  if (delta < 1e-9) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  const h =
    max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  return { h: ((h % 360) + 360) % 360, s, l }
}

/* ------------------------------------------------------------------ scanning */

/**
 * `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`.
 *
 * The trailing boundary matters: without it `#aabbccdd` would also match as `#aabbcc`
 * followed by junk, and a rewrite would corrupt the alpha.
 */
const HEX_RE = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g

/** `rgb(…)` / `rgba(…)` / `hsl(…)` / `hsla(…)`, comma or space separated, with optional `/ alpha`. */
const FUNC_RE = /\b(rgba?|hsla?)\(\s*([^()]*)\)/gi

/** `50%` → 0.5, `128` → 128, `.5` → 0.5. Percent-awareness is the caller's job. */
function parseComponent(raw: string): { value: number; percent: boolean } | null {
  const text = raw.trim()
  if (text === '') return null
  const percent = text.endsWith('%')
  const value = Number(percent ? text.slice(0, -1) : text)
  return Number.isFinite(value) ? { value, percent } : null
}

function splitArguments(body: string): string[] {
  const slash = body.split('/')
  const head = slash[0].trim().split(/[\s,]+/).filter(Boolean)
  const tail = slash.length > 1 ? [slash.slice(1).join('/').trim()] : []
  return [...head, ...tail]
}

function parseFunctional(fn: string, body: string): Rgba | null {
  const parts = splitArguments(body).map(parseComponent)
  if (parts.length < 3 || parts.slice(0, 3).some((part) => part === null)) return null
  const [first, second, third, fourth] = parts as Array<{ value: number; percent: boolean } | undefined>
  const alpha = fourth ? clamp01(fourth.percent ? fourth.value / 100 : fourth.value) : 1

  if (fn === 'rgb') {
    const channel = (part: { value: number; percent: boolean }): number =>
      clamp01(part.percent ? part.value / 100 : part.value / 255)
    return { r: channel(first!), g: channel(second!), b: channel(third!), a: alpha }
  }

  // hsl: hue is an angle (never a percentage), saturation and lightness are percentages.
  const rgb = hslToRgb(first!.value, second!.percent ? second!.value / 100 : second!.value, third!.percent ? third!.value / 100 : third!.value)
  return { ...rgb, a: alpha }
}

function parseHexLiteral(digits: string): { rgba: Rgba; notation: ColorNotation } | null {
  const expand = (hex: string): string => hex.split('').map((char) => char + char).join('')
  if (digits.length === 3 || digits.length === 6) {
    const rgb = parseHex(digits)
    return rgb ? { rgba: { ...rgb, a: 1 }, notation: digits.length === 3 ? 'hex3' : 'hex6' } : null
  }
  const short = digits.length === 4
  if (!short && digits.length !== 8) return null
  const full = short ? expand(digits) : digits
  const rgb = parseHex(full.slice(0, 6))
  if (!rgb) return null
  return {
    rgba: { ...rgb, a: parseInt(full.slice(6, 8), 16) / 255 },
    notation: short ? 'hex4' : 'hex8',
  }
}

/**
 * Every color literal in `text`, in source order.
 *
 * Overlaps cannot happen — the two patterns are disjoint (`#` versus a function name), and
 * a hex inside a function body is not valid CSS anyway.
 */
export function findColorLiterals(text: string): ColorLiteral[] {
  const found: ColorLiteral[] = []

  for (const match of text.matchAll(HEX_RE)) {
    const parsed = parseHexLiteral(match[1])
    if (!parsed) continue
    found.push({
      rgba: parsed.rgba,
      notation: parsed.notation,
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(FUNC_RE)) {
    const fn = match[1].toLowerCase()
    // `rgba()` and `hsla()` are the same function as their alpha-less spelling; which of the
    // two a replacement is written back as depends on the alpha, not on what was found.
    const kind: FunctionalKind = fn.startsWith('rgb') ? 'rgb' : fn.startsWith('hsl') ? 'hsl' : (fn as FunctionalKind)
    const rgba = parseFunctional(kind, match[2])
    if (!rgba) continue
    found.push({
      rgba,
      notation: kind,
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(NAMED_RE)) {
    const hex = NAMED_COLORS[match[1].toLowerCase()]
    if (hex === undefined) continue
    if (!inValuePosition(text, match.index, match.index + match[0].length)) continue
    const rgb = parseHex(hex)
    if (!rgb) continue
    found.push({
      rgba: { ...rgb, a: 1 },
      notation: 'named',
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return found.sort((a, b) => a.start - b.start)
}

/** The single literal in `text`, or null when there is none or more than one. */
export function parseColorLiteral(text: string): ColorLiteral | null {
  const found = findColorLiterals(text)
  return found.length === 1 ? found[0] : null
}

/* ------------------------------------------------------------------ writing */

const round = (value: number, places = 4): number => {
  const factor = Math.pow(10, places)
  return Math.round(value * factor) / factor
}

const hexPair = (value: number): string =>
  Math.round(clamp01(value) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')

/**
 * Writes `rgba` back in the notation the original was written in.
 *
 * A notation that cannot carry the alpha is upgraded rather than silently dropping it:
 * `hex3`/`hex6` become `hex8` when the color is translucent. Downgrading never happens —
 * an opaque color found as `hex8` stays `hex8`, because the file's author chose that width.
 */
export function formatColorLiteral(rgba: Rgba, notation: ColorNotation): string {
  const opaque = rgba.a >= 1 - 1e-6

  switch (notation) {
    case 'hex3':
    case 'hex6':
      return opaque ? formatHex(rgba) : formatHex(rgba) + hexPair(rgba.a)
    case 'hex4':
    case 'hex8':
      return formatHex(rgba) + hexPair(rgba.a)
    case 'rgb': {
      const channel = (value: number): number => Math.round(clamp01(value) * 255)
      const parts = [channel(rgba.r), channel(rgba.g), channel(rgba.b)]
      return opaque ? `rgb(${parts.join(', ')})` : `rgba(${parts.join(', ')}, ${round(rgba.a)})`
    }
    case 'hsl': {
      const { h, s, l } = rgbToHsl(rgba)
      const parts = [`${round(h, 2)}`, `${round(s * 100, 2)}%`, `${round(l * 100, 2)}%`]
      return opaque ? `hsl(${parts.join(', ')})` : `hsla(${parts.join(', ')}, ${round(rgba.a)})`
    }
    case 'hwb': {
      const { h, w, b } = rgbToHwb(rgba)
      const body = `${round(h, 2)} ${round(w * 100, 2)}% ${round(b * 100, 2)}%`
      return opaque ? `hwb(${body})` : `hwb(${body} / ${round(rgba.a)})`
    }
    case 'oklch': {
      const { l, c, h } = rgbToOklch(rgba)
      const body = `${round(l, 4)} ${round(c, 4)} ${round(h, 2)}`
      return opaque ? `oklch(${body})` : `oklch(${body} / ${round(rgba.a)})`
    }
    case 'oklab': {
      const { l, c, h } = rgbToOklch(rgba)
      const radians = (h * Math.PI) / 180
      const body = `${round(l, 4)} ${round(c * Math.cos(radians), 4)} ${round(c * Math.sin(radians), 4)}`
      return opaque ? `oklab(${body})` : `oklab(${body} / ${round(rgba.a)})`
    }
    case 'named': {
      // A keyword can only be replaced by another keyword when one exists for the new color;
      // otherwise the honest replacement is a hex, which every stylesheet accepts anyway.
      const name = opaque ? namedColorFor(rgba) : null
      if (name) return name
      return opaque ? formatHex(rgba) : formatHex(rgba) + hexPair(rgba.a)
    }
  }
}

/** `#RRGGBB`, the canonical form the mapping table and `mapping.json` speak. */
export const toHex = (rgba: Rgb): string => formatHex(rgba)

/** Same color to within a rounding step of 8-bit sRGB, alpha included. */
export function rgbaEquals(a: Rgba, b: Rgba, epsilon = 1 / 512): boolean {
  return (
    Math.abs(a.r - b.r) < epsilon &&
    Math.abs(a.g - b.g) < epsilon &&
    Math.abs(a.b - b.b) < epsilon &&
    Math.abs(a.a - b.a) < epsilon
  )
}
