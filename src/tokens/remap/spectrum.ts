/**
 * Finding the ramps in a set of colors — on both sides of a remap.
 *
 * Matching families to families only means anything if "family" is recoverable from a real
 * file, and real files are half-tidy: some colors sit in `colors/Orange/O500`, some are a
 * pasted list of hexes, some are one-off fills nobody ever named. So structure is read in
 * two passes, names first and geometry second, because a name records what the author meant
 * while a hue angle only records what the color happens to be.
 *
 * A named group is not taken at face value, though. `text/primary`, `text/secondary`,
 * `text/inverse` share a group and are not a ramp — near-black, gray and white with no step
 * numbers. Treating that as a spectrum would put it in the assignment problem competing with
 * actual ramps, so a named group has to *look* like a ramp (carry step numbers, or hold one
 * hue) before it is trusted; otherwise its members fall through to clustering.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { maxChroma, rgbToOklch } from '../color.ts'
import type { Rgba } from './color-literal.ts'
import { familyKey } from './token-name.ts'

export interface SpectrumMember {
  /** The caller's identity for this color — a variable id, a paste row index, anything. */
  ref: string
  name: string
  rgba: Rgba
  /** Family read off the name, when the name carried one. */
  family: string | null
  /** Step read off the name, when the name carried one. */
  step: number | null
}

/** Below this a color is translucent, and translucency is an axis of its own. */
export const OPAQUE = 0.999

export interface SpectrumStop extends SpectrumMember {
  /** OKLCH lightness, 0…1. */
  l: number
  /** OKLCH chroma. */
  c: number
  /** OKLCH hue in degrees. */
  h: number
  /** Chroma as a share of what sRGB allows at this lightness and hue, 0…1. */
  saturation: number
}

export interface InferredSpectrum {
  key: string
  label: string
  /** Every member is see-through — an alpha ramp, not a lightness ramp. */
  translucent: boolean
  /** `named` when the file said so, `clustered` when hue geometry had to say it. */
  source: 'named' | 'clustered'
  neutral: boolean
  /** Chroma-weighted mean hue, in degrees. */
  hue: number
  /** Widest hue distance between any two members, in degrees. */
  hueRange: number
  /**
   * True when a clustered family spans more hue than one ramp plausibly does — the signal
   * that two adjacent families (a blue and an indigo, say) were merged because nothing in
   * the geometry separates them. The UI surfaces it so a human can split the group.
   */
  crowded: boolean
  /** Light → dark. */
  stops: SpectrumStop[]
}

export interface SpectrumInference {
  spectra: InferredSpectrum[]
  /** Colors that join no ramp — one-off fills, mapped individually by nearest neighbour. */
  loose: SpectrumStop[]
  warnings: string[]
}

/**
 * Below this share of the chroma sRGB allows at a color's own lightness, it reads as gray.
 *
 * The measure has to be relative, because an absolute chroma cut gets this exactly backwards
 * at the light end: a blue ramp's lightest tint (#EFF6FF, C=0.014) carries *less* chroma than
 * a deliberately blue-tinted gray (#64748B, C=0.041), so an absolute threshold files the tint
 * as neutral and the gray as blue. Against the gamut ceiling the two separate cleanly —
 * measured across real ramps, colored ones hold 0.53…1.00 of the available chroma at every
 * step while tinted gray ramps peak at 0.43.
 */
export const NEUTRAL_SATURATION = 0.5

/**
 * Hue gap that ends a cluster.
 *
 * Measured against real ramps rather than picked: consecutive steps inside one ramp sit
 * within ~5° of each other (Tailwind blue's widest internal step is 5.2°, and this repo's
 * own generator spreads at most 10° of torsion across a whole ramp), while *adjacent
 * families* can be as little as 6° apart (blue 260° → indigo 277°, nearest members 266°
 * → 272°). No threshold separates those two cases, so this one is set to hold ramps
 * together and `crowded` flags the clusters where that choice may have merged two families.
 */
const HUE_GAP = 12

/** A cluster spreading wider than one ramp plausibly does is probably several families. */
const CROWDED_SPREAD = 25

/** A named group whose members spread wider than this in hue is not one ramp. */
const NAMED_HUE_SPREAD = 45

/* ------------------------------------------------------------------ hue vocabulary */

interface HueSector {
  from: number
  label: string
}

/**
 * Names for hue sectors of the OKLCH wheel, in the vocabulary designers already use.
 * Only ever applied to families that arrived unnamed — a name in the file always wins.
 *
 * Boundaries are the midpoints between the measured OKLCH hues of a widely known palette's
 * mid-tones, so a color a designer calls violet lands in Violet and not in Indigo (the two
 * anchors are only 16° apart, which is closer than intuition suggests).
 */
const HUE_SECTORS: readonly HueSector[] = [
  { from: 0, label: 'Pink' },
  { from: 5, label: 'Rose' },
  { from: 21, label: 'Red' },
  { from: 37, label: 'Orange' },
  { from: 59, label: 'Amber' },
  { from: 78, label: 'Yellow' },
  { from: 109, label: 'Lime' },
  { from: 141, label: 'Green' },
  { from: 156, label: 'Emerald' },
  { from: 173, label: 'Teal' },
  { from: 199, label: 'Cyan' },
  { from: 226, label: 'Sky' },
  { from: 249, label: 'Blue' },
  { from: 269, label: 'Indigo' },
  { from: 285, label: 'Violet' },
  { from: 299, label: 'Purple' },
  { from: 313, label: 'Fuchsia' },
  { from: 338, label: 'Pink' },
]

export function hueName(hue: number): string {
  const h = ((hue % 360) + 360) % 360
  let label = HUE_SECTORS[HUE_SECTORS.length - 1].label
  for (const sector of HUE_SECTORS) if (h >= sector.from) label = sector.label
  return label
}

/* ------------------------------------------------------------------ geometry */

const toStop = (member: SpectrumMember): SpectrumStop => {
  const { l, c, h } = rgbToOklch(member.rgba)
  // At the very ends of the lightness axis only gray exists, so nothing there is colored.
  const ceiling = maxChroma(l, h)
  return { ...member, l, c, h, saturation: ceiling > 1e-6 ? Math.min(1, c / ceiling) : 0 }
}

/** Shortest distance between two hue angles, 0…180. */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360) + 360) % 360
  return diff > 180 ? 360 - diff : diff
}

const isNeutral = (stop: SpectrumStop): boolean => stop.saturation < NEUTRAL_SATURATION

const isOpaque = (stop: SpectrumStop): boolean => stop.rgba.a >= OPAQUE

/** Chroma-weighted so near-gray ends of a ramp do not drag the family's hue around. */
function meanHue(stops: readonly SpectrumStop[]): number {
  let x = 0
  let y = 0
  for (const stop of stops) {
    const radians = (stop.h * Math.PI) / 180
    x += Math.cos(radians) * stop.c
    y += Math.sin(radians) * stop.c
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 0
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

/** Widest hue distance between any two colored members — the arc the family covers. */
function hueRange(stops: readonly SpectrumStop[]): number {
  const colored = stops.filter((stop) => !isNeutral(stop))
  let widest = 0
  for (let i = 0; i < colored.length; i++) {
    for (let j = i + 1; j < colored.length; j++) {
      widest = Math.max(widest, hueDistance(colored[i].h, colored[j].h))
    }
  }
  return widest
}

const byLightness = (a: SpectrumStop, b: SpectrumStop): number => b.l - a.l

/* ------------------------------------------------------------------ named pass */

/**
 * Does this named group behave like a ramp?
 *
 * Step numbers are proof enough — an author who wrote `500` meant a scale. Without them the
 * group has to at least hold one hue (or be uniformly gray), which is what separates a color
 * ramp from a bag of semantic roles that happen to share a folder.
 */
function looksLikeRamp(stops: readonly SpectrumStop[]): boolean {
  if (stops.length < 2) return false
  const withStep = stops.filter((stop) => stop.step !== null).length
  if (withStep >= 2) return true
  if (stops.every(isNeutral)) return true
  return hueRange(stops) <= NAMED_HUE_SPREAD
}

/* ------------------------------------------------------------------ clustering pass */

/**
 * Splits colored stops into families by walking the hue circle and cutting at every gap
 * wider than `HUE_GAP`. Starting the walk after the *largest* gap makes the cut set
 * rotation-invariant, so a palette straddling 0° clusters the same as one that does not.
 */
function clusterByHue(stops: readonly SpectrumStop[]): SpectrumStop[][] {
  if (stops.length === 0) return []
  const sorted = [...stops].sort((a, b) => a.h - b.h)
  if (sorted.length === 1) return [sorted]

  let widestAt = 0
  let widest = 360 - sorted[sorted.length - 1].h + sorted[0].h
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].h - sorted[i - 1].h
    if (gap > widest) {
      widest = gap
      widestAt = i
    }
  }

  const rotated = [...sorted.slice(widestAt), ...sorted.slice(0, widestAt)]
  const clusters: SpectrumStop[][] = [[rotated[0]]]
  for (let i = 1; i < rotated.length; i++) {
    const gap = hueDistance(rotated[i].h, rotated[i - 1].h)
    if (gap > HUE_GAP) clusters.push([rotated[i]])
    else clusters[clusters.length - 1].push(rotated[i])
  }
  return clusters
}

/* ------------------------------------------------------------------ entry point */

function makeSpectrum(
  stops: SpectrumStop[],
  source: 'named' | 'clustered',
  label: string,
  usedKeys: Set<string>
): InferredSpectrum {
  const sorted = [...stops].sort(byLightness)
  const neutral = sorted.every(isNeutral)
  const translucent = !sorted.some(isOpaque)
  const range = hueRange(sorted)

  let key = familyKey(label)
  let suffix = 2
  while (usedKeys.has(key)) key = `${familyKey(label)}-${suffix++}`
  usedKeys.add(key)

  return {
    key,
    label,
    source,
    neutral,
    translucent,
    hue: neutral ? 0 : meanHue(sorted),
    hueRange: range,
    crowded: source === 'clustered' && !neutral && range > CROWDED_SPREAD,
    stops: sorted,
  }
}

/**
 * Groups colors into ramps.
 *
 * Ramps of one are not ramps: a lone color joins `loose`, where the mapping falls back to
 * plain nearest neighbour. Everything is returned — nothing is dropped on the floor.
 */
export function inferSpectra(members: readonly SpectrumMember[]): SpectrumInference {
  const stops = members.map(toStop)
  const usedKeys = new Set<string>()
  const spectra: InferredSpectrum[] = []
  const unnamed: SpectrumStop[] = []

  // Translucency is not a rung and not a family — it is a property of one colour. A palette's
  // `alpha/orange/10` is a tenth-opacity orange whose "10" is a percentage: file it beside the
  // opaque orange ramp and it hands that ramp a step 10 it does not have. Group the translucent
  // ones together instead and they compare by *hue*, so a see-through black lands on a
  // see-through white because both are neutral. Neither is a ladder. Each is matched on the
  // colour it is, by nearest neighbour, and keeps its own alpha — which is what the rest of the
  // tool already promises about alpha everywhere else.
  const loose: SpectrumStop[] = []
  const named = new Map<string, { label: string; stops: SpectrumStop[] }>()
  for (const stop of stops) {
    if (!isOpaque(stop)) {
      loose.push(stop)
      continue
    }
    if (stop.family === null || stop.family.trim() === '') {
      unnamed.push(stop)
      continue
    }
    const key = familyKey(stop.family)
    const entry = named.get(key) ?? { label: stop.family, stops: [] }
    entry.stops.push(stop)
    named.set(key, entry)
  }

  for (const { label, stops: group } of named.values()) {
    if (looksLikeRamp(group)) spectra.push(makeSpectrum(group, 'named', label, usedKeys))
    else unnamed.push(...group)
  }

  const grays = unnamed.filter(isNeutral)
  const colored = unnamed.filter((stop) => !isNeutral(stop))

  if (grays.length >= 2) spectra.push(makeSpectrum(grays, 'clustered', 'Neutral', usedKeys))
  else loose.push(...grays)

  for (const cluster of clusterByHue(colored)) {
    if (cluster.length < 2) {
      loose.push(...cluster)
      continue
    }
    spectra.push(makeSpectrum(cluster, 'clustered', hueName(meanHue(cluster)), usedKeys))
  }

  spectra.sort((a, b) => Number(a.neutral) - Number(b.neutral) || a.hue - b.hue)

  const warnings = spectra
    .filter((spectrum) => spectrum.crowded)
    .map(
      (spectrum) =>
        `"${spectrum.label}" was grouped from color alone and spans ${Math.round(spectrum.hueRange)}° — ` +
        'it may be two families; split it in the table if so'
    )

  return { spectra, loose: loose.sort(byLightness), warnings }
}

/** The step numbers a spectrum actually carries, ascending — the ladder a remap may land on. */
export function spectrumSteps(spectrum: InferredSpectrum): number[] {
  const steps = spectrum.stops
    .map((stop) => stop.step)
    .filter((step): step is number => step !== null)
  return Array.from(new Set(steps)).sort((a, b) => a - b)
}
