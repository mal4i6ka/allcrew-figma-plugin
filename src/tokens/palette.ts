/**
 * Palette generation — turns key colors into harmonious ramps.
 *
 * The harmony guarantee comes from one shared *lightness ladder*: every spectrum places its
 * step i at the same perceptual L, so `O500` and `B500` carry the same visual weight and can
 * be swapped in a component without re-tuning anything around them. That is also what makes a
 * light/dark theme mechanical rather than hand-made — mirroring the ladder mirrors every hue
 * at once (the tone-based approach Material 3's HCT palettes use).
 *
 * Two departures from a naive "same L, same C, rotate H" ramp, both perceptual:
 *
 * - **Chroma bell.** Chroma peaks mid-ramp and falls off toward both ends. The extremes have
 *   little gamut room anyway, and near-white/near-black steps read as dirty when they hold
 *   full chroma.
 * - **Hue torsion.** Perceived hue drifts as luminance changes (Bezold–Brücke; the Abney
 *   effect is its saturation-side twin), so a ramp held at one hue angle looks like it bends.
 *   Rotating hue slightly across the ramp cancels that — darks lean red for warm hues, purple
 *   for blues, which is why hand-tuned ramps like Radix's are never hue-constant.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import {
  BLACK,
  WHITE,
  clampToGamut,
  contrastRatio,
  formatHex,
  hexToOklch,
  maxChroma,
  mixRgb,
  oklchToHex,
  oklchToRgb,
  parseHex,
  readableInk,
  type Oklch,
  type Rgb,
} from './color.ts'

export type PaletteFormula = 'oklch' | 'mix'

export interface SpectrumSpec {
  id: string
  /** Group name in the `colors` collection, e.g. `Orange`. */
  label: string
  /** Variable-name prefix, e.g. `O` → `O500`. Derived from the label when empty. */
  prefix?: string
  keyHex: string
  /** The step the key color lands on — exactly, without distortion. */
  anchorStep: number
  /** Neutral ramps run white → black and hold only a trace of the key's chroma. */
  neutral?: boolean
  /** Step aliased as `Light`; defaults to two steps lighter than the anchor. */
  lightStep?: number
  /** Step aliased as `Dark`; defaults to two steps darker than the anchor. */
  darkStep?: number
  /** Overrides the global step list for this spectrum. */
  steps?: number[]
  /** Overrides the global hue torsion, in degrees across the whole ramp. */
  hueTorsion?: number
}

export interface PaletteSettings {
  formula: PaletteFormula
  steps: number[]
  neutralSteps: number[]
  /** L of the lightest step on the shared ladder. */
  lightnessMax: number
  /** L of the darkest step on the shared ladder. */
  lightnessMin: number
  /**
   * Shape of the ladder between those ends. 1 spaces the steps evenly; above 1 holds the
   * light half up and drops faster through the dark half, which is how real scales are built
   * — a 500 stays a vivid mid-tone even when 900 runs almost to black.
   */
  lightnessCurve: number
  /** 0 = flat chroma across the ramp, 1 = full bell (near-gray at both ends). */
  chromaCurve: number
  /** Degrees of hue rotation across the ramp, or `auto` for a per-hue-family default. */
  hueTorsion: number | 'auto'
  /** Share of the key's chroma a neutral ramp keeps, 0…1. */
  neutralChroma: number
  spectra: SpectrumSpec[]
}

export interface Swatch {
  step: number
  /** `O500` — prefix + step. */
  name: string
  hex: string
  /** Black or white, whichever is readable on this swatch. */
  inkHex: string
  isMain: boolean
  isLight: boolean
  isDark: boolean
  contrastWhite: number
  contrastBlack: number
}

/**
 * A settings edit that resolves a warning.
 *
 * Warnings already name a concrete correction ("step 300 would sit flush"), so they carry the
 * edit itself rather than leaving the reader to translate advice into clicks.
 */
export type PaletteFix =
  | { kind: 'anchor-step'; spectrumId: string; step: number }
  | { kind: 'reset-steps'; neutral: boolean }
  | { kind: 'rename-duplicates' }
  /** Not a settings edit — re-runs the write with the dark theme in a companion collection. */
  | { kind: 'split-dark-theme' }

export interface PaletteWarning {
  message: string
  /** Button text for the one-click correction. Absent when the advice needs a human. */
  fixLabel?: string
  fix?: PaletteFix
}

export interface Spectrum {
  id: string
  label: string
  prefix: string
  keyHex: string
  anchorStep: number
  neutral: boolean
  swatches: Swatch[]
  /** Step whose ladder lightness sits closest to the key — the least-warping anchor. */
  suggestedAnchorStep: number
  warnings: PaletteWarning[]
}

export interface Palette {
  spectra: Spectrum[]
  warnings: PaletteWarning[]
}

/* ------------------------------------------------------------------ defaults */

/** Matches the reference board: 50 → 900, denser at the light end. */
export const DEFAULT_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

/** 12 steps, N0 = pure white through N1000 = pure black. */
export const DEFAULT_NEUTRAL_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]

export const DEFAULT_PALETTE_SETTINGS: PaletteSettings = {
  formula: 'oklch',
  steps: DEFAULT_STEPS,
  neutralSteps: DEFAULT_NEUTRAL_STEPS,
  lightnessMax: 0.975,
  lightnessMin: 0.19,
  lightnessCurve: 1.55,
  chromaCurve: 0.55,
  hueTorsion: 'auto',
  neutralChroma: 0.06,
  spectra: [
    { id: 'orange', label: 'Orange', prefix: 'O', keyHex: '#FB5B0A', anchorStep: 500 },
    { id: 'neutral', label: 'Neutral', prefix: 'N', keyHex: '#8A8A8A', anchorStep: 500, neutral: true },
    { id: 'blue', label: 'Blue', prefix: 'B', keyHex: '#2364AA', anchorStep: 500 },
  ],
}

/* ------------------------------------------------------------------ ladder */

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/**
 * Hue rotation across the ramp, in degrees, picked from the hue family.
 *
 * Sign convention: positive rotates the dark end toward higher hue angles. Warm hues get a
 * negative torsion (darks lean red), blues a positive one (darks lean purple) — the direction
 * the Bezold–Brücke shift moves perceived hue as luminance drops.
 */
export function autoHueTorsion(hue: number): number {
  const h = ((hue % 360) + 360) % 360
  if (h >= 20 && h < 110) return -10 // red → yellow
  if (h >= 110 && h < 190) return 8 // yellow-green → green
  if (h >= 190 && h < 290) return 10 // cyan → blue
  return -6 // magenta → red
}

/**
 * The shared ladder: step i of n sits at a fixed point between the two extremes, so every
 * spectrum places its step i at the same lightness.
 *
 * `curve` bends the spacing. At 1 the steps are perceptually even, but that puts the middle
 * step halfway between white and near-black — far darker than where designers actually place
 * a 500. Above 1 the light half stays open and the dark half compresses, which both matches
 * conventional scales and lets a vivid brand color anchor at 500 without warping the ramp.
 */
function baseLadder(count: number, lightnessMax: number, lightnessMin: number, curve: number): number[] {
  if (count === 1) return [(lightnessMax + lightnessMin) / 2]
  const gamma = curve > 0 ? curve : 1
  return Array.from({ length: count }, (_, i) => {
    const t = Math.pow(i / (count - 1), gamma)
    return lightnessMax + (lightnessMin - lightnessMax) * t
  })
}

/**
 * Bends the ladder so index `anchor` hits `keyL` exactly while both endpoints stay put.
 *
 * Keeping the endpoints shared is what preserves cross-spectrum harmony: only the interior
 * stretches, so the lightest and darkest steps of every ramp still line up.
 */
function warpLadder(base: number[], anchor: number, keyL: number): number[] {
  const last = base.length - 1
  if (last <= 0) return [keyL]
  const top = base[0]
  const bottom = base[last]

  return base.map((l, i) => {
    if (i === anchor) return keyL
    if (i < anchor) {
      const span = base[anchor] - top
      if (Math.abs(span) < 1e-6) return l
      return top + (l - top) * ((keyL - top) / span)
    }
    const span = base[anchor] - bottom
    if (Math.abs(span) < 1e-6) return l
    return bottom + (l - bottom) * ((keyL - bottom) / span)
  })
}

/** Bell envelope: 1 at mid-ramp, falling toward both ends by `curve`. */
function chromaEnvelope(t: number, curve: number): number {
  const bell = 1 - Math.pow(Math.abs(2 * t - 1), 1.6)
  return 1 - curve + curve * bell
}

/* ------------------------------------------------------------------ naming */

const sanitizeLabel = (label: string): string => label.trim().replace(/[/]/g, '-') || 'Color'

/** `Orange` → `O`. Collisions (Blue/Black/Brown) widen to 2, then 3 characters. */
export function derivePrefixes(labels: string[]): string[] {
  const used = new Set<string>()
  return labels.map((raw) => {
    const label = sanitizeLabel(raw).replace(/[^A-Za-z0-9]/g, '')
    for (let width = 1; width <= Math.max(1, label.length); width++) {
      const candidate = (label.slice(0, width) || 'C').toUpperCase()
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
    let n = 2
    let candidate = `${(label.slice(0, 1) || 'C').toUpperCase()}${n}`
    while (used.has(candidate)) candidate = `${(label.slice(0, 1) || 'C').toUpperCase()}${++n}`
    used.add(candidate)
    return candidate
  })
}

/* ------------------------------------------------------------------ generation */

const normalizeSteps = (steps: number[]): number[] =>
  Array.from(new Set(steps.filter((s) => Number.isFinite(s)))).sort((a, b) => a - b)

function indexOfStep(steps: number[], step: number): number {
  const exact = steps.indexOf(step)
  if (exact !== -1) return exact
  // An anchor that no longer exists in the step list falls back to the nearest one.
  let best = 0
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - step) < Math.abs(steps[best] - step)) best = i
  }
  return best
}

function rampByMixing(key: Rgb, count: number, anchor: number): Rgb[] {
  return Array.from({ length: count }, (_, i) => {
    if (i === anchor) return key
    const t = count === 1 ? 0 : i / (count - 1)
    const tAnchor = count === 1 ? 0 : anchor / (count - 1)
    if (i < anchor) return mixRgb(key, WHITE, tAnchor === 0 ? 0 : (tAnchor - t) / tAnchor)
    return mixRgb(key, BLACK, tAnchor === 1 ? 0 : (t - tAnchor) / (1 - tAnchor))
  })
}

function rampByOklch(
  key: Oklch,
  ladder: number[],
  anchor: number,
  chromaCurve: number,
  torsion: number,
  neutralChroma: number | null
): Oklch[] {
  const count = ladder.length
  const tOf = (i: number) => (count === 1 ? 0.5 : i / (count - 1))
  const tAnchor = tOf(anchor)
  // A near-zero envelope at the anchor would blow the whole ramp up to full chroma; floor it.
  const anchorEnvelope = Math.max(chromaEnvelope(tAnchor, chromaCurve), 0.15)
  const keyChroma = neutralChroma === null ? key.c : key.c * neutralChroma

  return ladder.map((l, i) => {
    if (i === anchor && neutralChroma === null) return { l, c: key.c, h: key.h }
    const t = tOf(i)
    const chroma = keyChroma * (chromaEnvelope(t, chromaCurve) / anchorEnvelope)
    const hue = key.h + torsion * (t - tAnchor)
    return clampToGamut({ l, c: Math.min(chroma, maxChroma(l, hue)), h: hue })
  })
}

function buildSwatches(
  colors: Rgb[],
  steps: number[],
  prefix: string,
  marks: { main: number; light: number; dark: number }
): Swatch[] {
  return colors.map((rgb, i) => ({
    step: steps[i],
    name: `${prefix}${steps[i]}`,
    hex: formatHex(rgb),
    inkHex: formatHex(readableInk(rgb)),
    isMain: i === marks.main,
    isLight: i === marks.light,
    isDark: i === marks.dark,
    contrastWhite: Math.round(contrastRatio(rgb, WHITE) * 100) / 100,
    contrastBlack: Math.round(contrastRatio(rgb, BLACK) * 100) / 100,
  }))
}

function generateSpectrum(spec: SpectrumSpec, settings: PaletteSettings, prefix: string): Spectrum {
  const warnings: PaletteWarning[] = []
  const neutral = spec.neutral === true
  const steps = normalizeSteps(spec.steps ?? (neutral ? settings.neutralSteps : settings.steps))
  const safeSteps = steps.length > 0 ? steps : neutral ? DEFAULT_NEUTRAL_STEPS : DEFAULT_STEPS
  if (steps.length === 0) {
    warnings.push({
      message: 'Step list was empty — fell back to the default scale.',
      fixLabel: 'Restore the default scale',
      fix: { kind: 'reset-steps', neutral },
    })
  }

  const keyRgb = parseHex(spec.keyHex)
  // No fix offered: only the designer knows which color was meant.
  if (!keyRgb) warnings.push({ message: `"${spec.keyHex}" is not a valid hex — used #808080 instead.` })
  const key = keyRgb ?? { r: 0.5, g: 0.5, b: 0.5 }
  const keyOklch = hexToOklch(formatHex(key)) ?? { l: 0.5, c: 0, h: 0 }

  const anchor = indexOfStep(safeSteps, spec.anchorStep)
  if (safeSteps[anchor] !== spec.anchorStep) {
    warnings.push({
      message: `Step ${spec.anchorStep} is not in the scale — the key was anchored at ${safeSteps[anchor]}.`,
      fixLabel: `Anchor at ${safeSteps[anchor]}`,
      fix: { kind: 'anchor-step', spectrumId: spec.id, step: safeSteps[anchor] },
    })
  }

  // Neutrals span the full range so N0 lands on pure white and the last step on pure black.
  const lightnessMax = neutral ? 1 : settings.lightnessMax
  const lightnessMin = neutral ? 0 : settings.lightnessMin
  const base = baseLadder(safeSteps.length, lightnessMax, lightnessMin, settings.lightnessCurve)

  let suggested = 0
  for (let i = 1; i < base.length; i++) {
    if (Math.abs(base[i] - keyOklch.l) < Math.abs(base[suggested] - keyOklch.l)) suggested = i
  }
  const drift = Math.abs(keyOklch.l - base[anchor])
  if (drift > 0.12 && safeSteps[suggested] !== safeSteps[anchor]) {
    warnings.push({
      message:
        `The key is much ${keyOklch.l > base[anchor] ? 'lighter' : 'darker'} than step ${safeSteps[anchor]} ` +
        `on the shared ladder, so this ramp is stretched. Step ${safeSteps[suggested]} would sit flush with the other spectra.`,
      fixLabel: `Move Main to ${safeSteps[suggested]}`,
      fix: { kind: 'anchor-step', spectrumId: spec.id, step: safeSteps[suggested] },
    })
  }

  const torsion = spec.hueTorsion ?? (settings.hueTorsion === 'auto' ? autoHueTorsion(keyOklch.h) : settings.hueTorsion)

  let colors: Rgb[]
  if (settings.formula === 'mix') {
    colors = rampByMixing(key, safeSteps.length, anchor)
    if (neutral) {
      // Pin the ends so a neutral still reaches pure white and pure black.
      colors[0] = WHITE
      colors[colors.length - 1] = BLACK
    }
  } else {
    const ladder = warpLadder(base, anchor, neutral ? base[anchor] : keyOklch.l)
    const oklchRamp = rampByOklch(
      keyOklch,
      ladder,
      anchor,
      settings.chromaCurve,
      torsion,
      neutral ? clamp(settings.neutralChroma, 0, 1) : null
    )
    colors = oklchRamp.map(oklchToRgb)
  }

  // Light/Dark sit two steps out from the key. Running off the end drops the mark rather than
  // clamping it onto Main — a neutral anchored at black has no room for a Dark, and the
  // reference board leaves it off.
  const markIndex = (step: number | undefined, fallback: number): number => {
    if (step === undefined) return fallback >= 0 && fallback < safeSteps.length ? fallback : -1
    const index = indexOfStep(safeSteps, step)
    return index === anchor ? -1 : index
  }
  const lightIndex = markIndex(spec.lightStep, anchor - 2)
  const darkIndex = markIndex(spec.darkStep, anchor + 2)

  return {
    id: spec.id,
    label: sanitizeLabel(spec.label),
    prefix,
    keyHex: formatHex(key),
    anchorStep: safeSteps[anchor],
    neutral,
    swatches: buildSwatches(colors, safeSteps, prefix, { main: anchor, light: lightIndex, dark: darkIndex }),
    suggestedAnchorStep: safeSteps[suggested],
    warnings,
  }
}

export function generatePalette(settings: PaletteSettings): Palette {
  const prefixes = derivePrefixes(settings.spectra.map((s) => (s.prefix?.trim() ? s.prefix.trim() : s.label)))
  const spectra = settings.spectra.map((spec, i) => generateSpectrum(spec, settings, prefixes[i]))

  const warnings: PaletteWarning[] = []
  const labels = spectra.map((s) => s.label.toLowerCase())
  const duplicates = labels.filter((label, i) => labels.indexOf(label) !== i)
  if (duplicates.length > 0) {
    warnings.push({
      message: `Duplicate spectrum names (${Array.from(new Set(duplicates)).join(', ')}) will merge into one group.`,
      fixLabel: 'Rename the duplicates',
      fix: { kind: 'rename-duplicates' },
    })
  }

  return { spectra, warnings }
}

/* ------------------------------------------------------------------ fixes */

/**
 * Keeps an explicit Light/Dark the same distance from Main as the anchor moves.
 *
 * Only explicit marks travel — an `undefined` mark is on auto and re-derives itself from the
 * new anchor. A mark pushed off the end of the scale falls back to auto rather than clamping
 * onto a neighbour it was never meant to share.
 */
function shiftMark(steps: number[], step: number | undefined, delta: number): number | undefined {
  if (step === undefined) return undefined
  const moved = indexOfStep(steps, step) + delta
  return moved >= 0 && moved < steps.length ? steps[moved] : undefined
}

/** Applies the correction a warning carries, returning fresh settings. */
export function applyPaletteFix(settings: PaletteSettings, fix: PaletteFix): PaletteSettings {
  const spectra = settings.spectra.map((spec) => ({ ...spec }))

  switch (fix.kind) {
    case 'anchor-step': {
      for (const spec of spectra) {
        if (spec.id !== fix.spectrumId) continue
        const steps = normalizeSteps(spec.steps ?? (spec.neutral ? settings.neutralSteps : settings.steps))
        if (steps.length === 0) continue
        const from = indexOfStep(steps, spec.anchorStep)
        const to = indexOfStep(steps, fix.step)
        spec.anchorStep = steps[to]
        spec.lightStep = shiftMark(steps, spec.lightStep, to - from)
        spec.darkStep = shiftMark(steps, spec.darkStep, to - from)
      }
      return { ...settings, spectra }
    }
    case 'reset-steps':
      return fix.neutral
        ? { ...settings, neutralSteps: [...DEFAULT_NEUTRAL_STEPS], spectra }
        : { ...settings, steps: [...DEFAULT_STEPS], spectra }
    case 'rename-duplicates': {
      const seen = new Map<string, number>()
      for (const spec of spectra) {
        const key = spec.label.trim().toLowerCase()
        const taken = seen.get(key) ?? 0
        seen.set(key, taken + 1)
        if (taken > 0) spec.label = `${spec.label.trim()} ${taken + 1}`
      }
      return { ...settings, spectra }
    }
    // Not a settings edit — the caller re-runs the write with `splitDarkTheme` instead.
    case 'split-dark-theme':
      return { ...settings, spectra }
  }
}

/* ------------------------------------------------------------------ harmonious suggestion */

/**
 * Hue names by OKLCH angle. Measured from the reference colors of common palettes rather
 * than assumed — OKLCH hue angles are nothing like HSL's (pure red sits near 23°, not 0°).
 */
const HUE_NAMES: Array<{ upTo: number; name: string }> = [
  { upTo: 20, name: 'Rose' },
  { upTo: 32, name: 'Red' },
  { upTo: 55, name: 'Orange' },
  { upTo: 88, name: 'Amber' },
  { upTo: 112, name: 'Yellow' },
  { upTo: 140, name: 'Lime' },
  { upTo: 172, name: 'Green' },
  { upTo: 198, name: 'Teal' },
  { upTo: 226, name: 'Cyan' },
  { upTo: 245, name: 'Sky' },
  { upTo: 266, name: 'Blue' },
  { upTo: 285, name: 'Indigo' },
  { upTo: 298, name: 'Violet' },
  { upTo: 313, name: 'Purple' },
  { upTo: 338, name: 'Magenta' },
  { upTo: 360, name: 'Pink' },
]

export function hueName(hue: number): string {
  const h = ((hue % 360) + 360) % 360
  for (const entry of HUE_NAMES) if (h < entry.upTo) return entry.name
  return 'Pink'
}

/**
 * Classic harmony intervals, in degrees from the reference hue.
 *
 * These are the relationships colour theory has used since Itten's wheel — complement,
 * split-complement, triad, square, and the analogous pair. Rotating in OKLCH rather than HSL
 * matters: an HSL rotation changes perceived lightness along with hue, so a "triad" comes out
 * with one member visibly heavier than the others.
 */
const HARMONY_OFFSETS = [180, 150, 210, 120, 240, 90, 270, 30, 330]

/** Shortest distance between two hue angles, 0…180. */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 360) % 360)
  return diff > 180 ? 360 - diff : diff
}

/** Enough separation that the two ramps read as different colors rather than a near-miss. */
const MIN_HUE_SEPARATION = 25

/**
 * Picks a new key color that sits in harmony with the spectra already defined.
 *
 * Harmony here is two things at once: the hue lands on a classic interval from the existing
 * key, and the lightness and chroma match what the other keys carry — so the new ramp occupies
 * the same rung of the shared ladder instead of arriving heavier or lighter than its siblings.
 */
export function suggestHarmoniousSpectrum(
  settings: PaletteSettings,
  random: () => number = Math.random
): SpectrumSpec {
  const colored = settings.spectra.filter((spec) => !spec.neutral)
  const keys = colored
    .map((spec) => hexToOklch(spec.keyHex))
    .filter((color): color is NonNullable<typeof color> => color !== null && color.c > 0.02)

  const takenLabels = new Set(settings.spectra.map((spec) => spec.label.trim().toLowerCase()))
  const anchorStep = colored[0]?.anchorStep ?? settings.steps[Math.floor(settings.steps.length / 2)]

  let lightness: number
  let chroma: number
  let hue: number

  if (keys.length === 0) {
    // Nothing to harmonize with — start anywhere on the wheel, at a weight that suits a key.
    lightness = 0.66
    chroma = 0.16
    hue = random() * 360
  } else {
    lightness = keys.reduce((sum, key) => sum + key.l, 0) / keys.length
    chroma = keys.reduce((sum, key) => sum + key.c, 0) / keys.length

    const base = keys[0].h
    const candidates = HARMONY_OFFSETS.map((offset) => (base + offset) % 360).filter((candidate) =>
      keys.every((key) => hueDistance(candidate, key.h) >= MIN_HUE_SEPARATION)
    )
    // Every interval already taken means the wheel is crowded; fall back to the widest gap.
    hue = candidates.length > 0 ? candidates[Math.floor(random() * candidates.length) % candidates.length] : widestGapHue(keys.map((key) => key.h))
  }

  // Chroma varies enormously by hue in sRGB — a yellow cannot hold a violet's chroma. Take
  // what fits rather than letting the clamp silently decide.
  const fitted = Math.min(chroma, maxChroma(lightness, hue) * 0.95)
  const keyHex = oklchToHex({ l: lightness, c: fitted, h: hue })

  const base = hueName(hue)
  let label = base
  let suffix = 2
  while (takenLabels.has(label.toLowerCase())) label = `${base} ${suffix++}`

  return {
    id: `spectrum-${Math.round(hue)}-${settings.spectra.length}`,
    label,
    keyHex,
    anchorStep,
  }
}

/** The hue with the most room around it — the least-crowded place left on the wheel. */
function widestGapHue(hues: number[]): number {
  const sorted = [...hues].map((h) => ((h % 360) + 360) % 360).sort((a, b) => a - b)
  let best = (sorted[0] + 180) % 360
  let widest = -1
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[(i + 1) % sorted.length]
    const gap = i === sorted.length - 1 ? next + 360 - sorted[i] : next - sorted[i]
    if (gap > widest) {
      widest = gap
      best = (sorted[i] + gap / 2) % 360
    }
  }
  return best
}

/* ------------------------------------------------------------------ theme roles */

export interface ThemeRole {
  /** Variable name inside the `theme` collection, e.g. `bg/canvas`. */
  name: string
  /** `colors` variable each mode points at, e.g. `Neutral/N0`. */
  light: string
  dark: string
}

const stepAt = (spectrum: Spectrum, index: number): string =>
  spectrum.swatches[clamp(index, 0, spectrum.swatches.length - 1)].name

const pathOf = (spectrum: Spectrum, name: string): string => `${spectrum.label}/${name}`

/**
 * Semantic roles for a two-mode `theme` collection, aliasing into `colors`.
 *
 * Neutral roles mirror across the ladder (light mode counts in from the white end, dark mode
 * from the black end). Accent roles do not mirror: a dark surface needs a *lighter* accent to
 * hold contrast, which is the same move Material 3 makes when it swaps tone 40 for tone 80.
 */
export function themeRoles(palette: Palette): ThemeRole[] {
  const neutral = palette.spectra.find((s) => s.neutral) ?? palette.spectra[0]
  const roles: ThemeRole[] = []
  if (!neutral) return roles

  const last = neutral.swatches.length - 1
  const mirror = (index: number): { light: string; dark: string } => ({
    light: pathOf(neutral, stepAt(neutral, index)),
    dark: pathOf(neutral, stepAt(neutral, last - index)),
  })

  roles.push({ name: 'bg/canvas', ...mirror(0) })
  roles.push({ name: 'bg/surface', ...mirror(1) })
  roles.push({ name: 'bg/raised', ...mirror(2) })
  roles.push({ name: 'border/subtle', ...mirror(3) })
  roles.push({ name: 'border/default', ...mirror(4) })
  roles.push({ name: 'text/muted', ...mirror(last - 3) })
  roles.push({ name: 'text/secondary', ...mirror(last - 2) })
  roles.push({ name: 'text/primary', ...mirror(last - 1) })

  for (const spectrum of palette.spectra) {
    if (spectrum.neutral) continue
    const main = spectrum.swatches.findIndex((s) => s.isMain)
    const light = spectrum.swatches.findIndex((s) => s.isLight)
    const dark = spectrum.swatches.findIndex((s) => s.isDark)
    const key = spectrum.label.toLowerCase()
    roles.push({
      name: `accent/${key}/base`,
      light: pathOf(spectrum, stepAt(spectrum, main)),
      dark: pathOf(spectrum, stepAt(spectrum, light === -1 ? main : light)),
    })
    roles.push({
      name: `accent/${key}/hover`,
      light: pathOf(spectrum, stepAt(spectrum, dark === -1 ? main : dark)),
      dark: pathOf(spectrum, stepAt(spectrum, main)),
    })
    roles.push({
      name: `accent/${key}/subtle`,
      light: pathOf(spectrum, stepAt(spectrum, 1)),
      dark: pathOf(spectrum, stepAt(spectrum, spectrum.swatches.length - 2)),
    })
  }

  return roles
}
