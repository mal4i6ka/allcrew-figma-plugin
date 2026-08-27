/**
 * Normalization for palette settings.
 *
 * Settings arrive from two untrusted places — the UI iframe and `clientStorage` written by an
 * older build — so every field is coerced against the defaults before the engine sees it,
 * the same contract `normalizeExportOptions` follows in src/settings.ts.
 */

import {
  DEFAULT_NEUTRAL_STEPS,
  DEFAULT_PALETTE_SETTINGS,
  DEFAULT_STEPS,
  type PaletteFix,
  type PaletteFormula,
  type PaletteSettings,
  type SpectrumSpec,
} from './palette.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/** Accepts an array or a `50, 100, 200` string — the UI edits scales as free text. */
export function parseSteps(value: unknown, fallback: number[]): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/).filter(Boolean)
      : null
  if (!raw) return fallback

  const steps = Array.from(
    new Set(
      raw
        .map((entry) => (typeof entry === 'string' ? Number(entry.trim()) : entry))
        .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
        .map((entry) => Math.round(entry))
    )
  ).sort((a, b) => a - b)

  return steps.length >= 2 ? steps : fallback
}

function normalizeSpectrum(value: unknown, index: number): SpectrumSpec | null {
  if (!isRecord(value)) return null
  const label = text(value.label, '')
  if (label === '') return null

  const neutral = flag(value.neutral, false)
  const steps = value.steps === undefined ? undefined : parseSteps(value.steps, [])
  const spec: SpectrumSpec = {
    id: text(value.id, `spectrum-${index}`),
    label,
    prefix: text(value.prefix, '').toUpperCase() || undefined,
    keyHex: text(value.keyHex, '#808080'),
    anchorStep: number(value.anchorStep, neutral ? 500 : 500, 0, 100000),
    neutral,
  }
  if (steps && steps.length >= 2) spec.steps = steps
  if (typeof value.lightStep === 'number') spec.lightStep = value.lightStep
  if (typeof value.darkStep === 'number') spec.darkStep = value.darkStep
  if (value.hueTorsion !== undefined && value.hueTorsion !== 'auto') {
    spec.hueTorsion = number(value.hueTorsion, 0, -60, 60)
  }
  return spec
}

/** Validates a fix posted from the UI; returns null for anything unrecognized. */
export function normalizePaletteFix(value: unknown): PaletteFix | null {
  if (!isRecord(value)) return null
  if (value.kind === 'anchor-step') {
    const spectrumId = text(value.spectrumId, '')
    if (spectrumId === '' || typeof value.step !== 'number' || !Number.isFinite(value.step)) return null
    return { kind: 'anchor-step', spectrumId, step: Math.round(value.step) }
  }
  if (value.kind === 'reset-steps') return { kind: 'reset-steps', neutral: flag(value.neutral, false) }
  if (value.kind === 'rename-duplicates') return { kind: 'rename-duplicates' }
  if (value.kind === 'split-dark-theme') return { kind: 'split-dark-theme' }
  return null
}

export function normalizePaletteSettings(value: unknown): PaletteSettings {
  const defaults = DEFAULT_PALETTE_SETTINGS
  if (!isRecord(value)) return { ...defaults, spectra: defaults.spectra.map((s) => ({ ...s })) }

  const rawSpectra = Array.isArray(value.spectra) ? value.spectra : null
  const spectra = rawSpectra
    ? rawSpectra.map(normalizeSpectrum).filter((spec): spec is SpectrumSpec => spec !== null)
    : []

  const lightnessMax = number(value.lightnessMax, defaults.lightnessMax, 0.5, 1)
  const lightnessMin = number(value.lightnessMin, defaults.lightnessMin, 0, 0.5)

  return {
    formula: (value.formula === 'mix' ? 'mix' : 'oklch') as PaletteFormula,
    steps: parseSteps(value.steps, DEFAULT_STEPS),
    neutralSteps: parseSteps(value.neutralSteps, DEFAULT_NEUTRAL_STEPS),
    lightnessMax,
    // A collapsed or inverted range would flatten every ramp into one shade.
    lightnessMin: lightnessMin < lightnessMax - 0.1 ? lightnessMin : defaults.lightnessMin,
    lightnessCurve: number(value.lightnessCurve, defaults.lightnessCurve, 0.6, 2.5),
    chromaCurve: number(value.chromaCurve, defaults.chromaCurve, 0, 1),
    hueTorsion: value.hueTorsion === 'auto' ? 'auto' : number(value.hueTorsion, 0, -60, 60),
    neutralChroma: number(value.neutralChroma, defaults.neutralChroma, 0, 1),
    // An empty list is a choice: the operator cleared the board to build their own set, and
    // quietly refilling it with the default three makes the preview show ramps that no
    // longer exist. The defaults return only when the field is missing entirely or every
    // entry is corrupt — settings from an older build, not a deliberate empty state.
    spectra:
      rawSpectra === null || (rawSpectra.length > 0 && spectra.length === 0)
        ? defaults.spectra.map((s) => ({ ...s }))
        : spectra,
  }
}
