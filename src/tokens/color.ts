/**
 * Color math for palette generation.
 *
 * Everything perceptual runs through OKLab/OKLCH (Ottosson 2020): equal L means equal
 * perceived lightness across hues, which is what lets ramps of different hues sit on one
 * shared ladder and stay interchangeable in components. HSL cannot do this — an HSL yellow
 * and an HSL blue at the same "lightness" differ wildly in perceived brightness.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Oklch {
  /** Perceptual lightness, 0…1. */
  l: number
  /** Chroma, 0…~0.4 in sRGB. */
  c: number
  /** Hue angle in degrees, 0…360. */
  h: number
}

/* ------------------------------------------------------------------ hex */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/** Parses `#rgb`, `#rrggbb` (with or without `#`). Returns null on anything else. */
export function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
    }
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    }
  }
  return null
}

const channelToHex = (value: number): string => {
  const byte = Math.round(clamp01(value) * 255)
  return byte.toString(16).toUpperCase().padStart(2, '0')
}

export function formatHex(rgb: Rgb): string {
  return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`
}

/* ------------------------------------------------------------------ transfer function */

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

/* ------------------------------------------------------------------ OKLab */

interface Oklab {
  l: number
  a: number
  b: number
}

function rgbToOklab(rgb: Rgb): Oklab {
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

/** Unclamped — channels may fall outside 0…1 when the color is out of the sRGB gamut. */
function oklabToLinearRgb(lab: Oklab): Rgb {
  const l_ = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b
  const m_ = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b
  const s_ = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

/* ------------------------------------------------------------------ OKLCH */

export function rgbToOklch(rgb: Rgb): Oklch {
  const lab = rgbToOklab(rgb)
  const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
  // Hue is meaningless at zero chroma; report 0 so gray round-trips predictably.
  const h = c < 1e-7 ? 0 : ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360
  return { l: lab.l, c, h }
}

function oklchToLinearRgb(color: Oklch): Rgb {
  const rad = (color.h * Math.PI) / 180
  return oklabToLinearRgb({ l: color.l, a: color.c * Math.cos(rad), b: color.c * Math.sin(rad) })
}

const GAMUT_EPSILON = 1e-4

function inGamut(linear: Rgb): boolean {
  return (
    linear.r >= -GAMUT_EPSILON &&
    linear.r <= 1 + GAMUT_EPSILON &&
    linear.g >= -GAMUT_EPSILON &&
    linear.g <= 1 + GAMUT_EPSILON &&
    linear.b >= -GAMUT_EPSILON &&
    linear.b <= 1 + GAMUT_EPSILON
  )
}

/**
 * Largest chroma that still fits in sRGB at this lightness and hue.
 *
 * Chroma-reduction rather than naive per-channel clipping: clipping shifts hue and lightness
 * (a clipped saturated blue drifts purple), while holding L and H and backing off C keeps the
 * ramp on its ladder — the same approach CSS Color 4 specifies for gamut mapping.
 */
export function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0
  let low = 0
  let high = 0.4
  if (inGamut(oklchToLinearRgb({ l, c: high, h }))) return high
  for (let i = 0; i < 28; i++) {
    const mid = (low + high) / 2
    if (inGamut(oklchToLinearRgb({ l, c: mid, h }))) low = mid
    else high = mid
  }
  return low
}

/** Clamps chroma into the sRGB gamut, preserving lightness and hue. */
export function clampToGamut(color: Oklch): Oklch {
  const l = clamp01(color.l)
  const linear = oklchToLinearRgb({ ...color, l })
  if (inGamut(linear)) return { ...color, l }
  return { l, c: Math.min(color.c, maxChroma(l, color.h)), h: color.h }
}

export function oklchToRgb(color: Oklch): Rgb {
  const linear = oklchToLinearRgb(clampToGamut(color))
  return {
    r: clamp01(linearToSrgb(linear.r)),
    g: clamp01(linearToSrgb(linear.g)),
    b: clamp01(linearToSrgb(linear.b)),
  }
}

export const hexToOklch = (hex: string): Oklch | null => {
  const rgb = parseHex(hex)
  return rgb ? rgbToOklch(rgb) : null
}

export const oklchToHex = (color: Oklch): string => formatHex(oklchToRgb(color))

/* ------------------------------------------------------------------ mixing */

/**
 * Classic tint/shade mixing, done in gamma-encoded sRGB — the same space Sass `mix()` and
 * CSS `color-mix(in srgb, …)` use, so results match what designers expect from that formula.
 */
export function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = clamp01(amount)
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

export const WHITE: Rgb = { r: 1, g: 1, b: 1 }
export const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/* ------------------------------------------------------------------ contrast */

function relativeLuminance(rgb: Rgb): number {
  const r = srgbToLinear(clamp01(rgb.r))
  const g = srgbToLinear(clamp01(rgb.g))
  const b = srgbToLinear(clamp01(rgb.b))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio, 1…21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Whichever of black/white text is more readable on this background. */
export function readableInk(background: Rgb): Rgb {
  return contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? BLACK : WHITE
}
