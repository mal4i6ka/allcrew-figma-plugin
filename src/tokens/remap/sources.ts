/**
 * Turning the other things a new palette can arrive as into swatches.
 *
 * A pasted list is the general case and the one that always works, but it is also the lossiest:
 * a designer who typed sixty hexes has thrown away the structure they were thinking in, and the
 * parser has to guess it back. Every other source knows more than the paste does — the
 * generator knows exactly which family and step each color is, a library knows the names its
 * own team agreed on — and handing that structure to the matcher directly is worth more than
 * any amount of inference.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`. The sources that need the
 * document live in targets/ds-tools/remap-sources.ts and produce the same shape.
 */

import { parseHex } from '../color.ts'
import type { ParsedSwatch } from './input.ts'
import type { Palette } from '../palette.ts'
import { parseTokenName } from './token-name.ts'

/** A swatch built from a color that already knows what it is. */
export function swatchOf(hex: string, name: string, family: string | null, step: number | null): ParsedSwatch | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  return { hex: hex.toUpperCase(), alpha: 1, rgba: { ...rgb, a: 1 }, name, family, step }
}

/**
 * The generator's own output, with its families and steps intact.
 *
 * This is the highest-fidelity source there is: the ladder the ramps were built on is the
 * ladder the matcher then maps onto, so every step number lands exactly and nothing has to be
 * interpolated. The `Main`/`Light`/`Dark` aliases are left out — they point at steps that are
 * already in the list, and a duplicate color would only compete with itself.
 */
export function swatchesFromPalette(palette: Palette): ParsedSwatch[] {
  const swatches: ParsedSwatch[] = []
  for (const spectrum of palette.spectra) {
    for (const swatch of spectrum.swatches) {
      const parsed = swatchOf(swatch.hex, `${spectrum.label}/${swatch.step}`, spectrum.label, swatch.step)
      if (parsed) swatches.push(parsed)
    }
  }
  return swatches
}

/**
 * Colors read off named things — canvas layers, library variables.
 *
 * The name is trusted the same way a pasted `Violet/500` is: whatever family and step it
 * carries are read off it, and a name that carries neither simply leaves the clustering to
 * work it out. Identical colors collapse, because a swatch board repeats the same fill on a
 * label and its frame more often than not.
 *
 * Which of the collapsed names survives decides what the *palette* is, not merely what one
 * row is called, so it cannot be whichever came first. A board that draws `background/base`
 * before the `neutral/0` it aliases would otherwise leave the new neutral ramp with no `0` at
 * all — and then every white in the file, having nothing white left to land on, moves to the
 * lightest gray the ramp still has. A name carrying a family and a step is a rung and outranks
 * a name carrying only a family, which outranks a name carrying neither.
 */
const describes = (family: string | null, step: number | null): number =>
  family !== null && step !== null ? 2 : family !== null ? 1 : 0

export function swatchesFromNamedColors(
  entries: ReadonlyArray<{ hex: string; alpha?: number; name: string }>
): { swatches: ParsedSwatch[]; duplicates: number } {
  const at = new Map<string, number>()
  const swatches: ParsedSwatch[] = []
  let duplicates = 0

  for (const entry of entries) {
    const rgb = parseHex(entry.hex)
    if (!rgb) continue
    const alpha = entry.alpha ?? 1
    const key = `${entry.hex.toUpperCase()}|${alpha.toFixed(3)}`
    const parsed = parseTokenName(entry.name)

    const existing = at.get(key)
    if (existing !== undefined) {
      duplicates++
      const held = swatches[existing]
      if (describes(parsed.family, parsed.step) > describes(held.family, held.step)) {
        swatches[existing] = { ...held, name: entry.name, family: parsed.family, step: parsed.step }
      }
      continue
    }

    at.set(key, swatches.length)
    swatches.push({
      hex: entry.hex.toUpperCase(),
      alpha,
      rgba: { ...rgb, a: alpha },
      name: entry.name,
      family: parsed.family,
      step: parsed.step,
    })
  }

  return { swatches, duplicates }
}
