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
 * work it out. Identical colors collapse, keeping the first name, because a swatch board
 * repeats the same fill on a label and its frame more often than not.
 */
export function swatchesFromNamedColors(
  entries: ReadonlyArray<{ hex: string; alpha?: number; name: string }>
): { swatches: ParsedSwatch[]; duplicates: number } {
  const seen = new Set<string>()
  const swatches: ParsedSwatch[] = []
  let duplicates = 0

  for (const entry of entries) {
    const rgb = parseHex(entry.hex)
    if (!rgb) continue
    const alpha = entry.alpha ?? 1
    const key = `${entry.hex.toUpperCase()}|${alpha.toFixed(3)}`
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    const parsed = parseTokenName(entry.name)
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
