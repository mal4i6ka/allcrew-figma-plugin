/**
 * The designer's new palette, however they pasted it.
 *
 * There is no format to agree on here — a designer sends whatever their tool exported: a
 * JSON dump, a two-column CSV, or sixty lines copied out of a spreadsheet. Refusing any of
 * those would just move the work to a human retyping colors, so the parser is deliberately
 * permissive and reports what it could not read instead of failing.
 *
 * What it will not do is guess silently: every dropped line becomes a warning the UI shows
 * next to the parsed result.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { isRecord } from '../../utils/type-guards.ts'

import { toHex, findColorLiterals, type Rgba } from './color-literal.ts'
import { parseTokenName } from './token-name.ts'

export interface ParsedSwatch {
  /** `#RRGGBB` — alpha is carried separately so it survives every downstream step. */
  hex: string
  alpha: number
  rgba: Rgba
  /** Whatever the row called it; empty when the paste had no names. */
  name: string
  /** Family read off the name, or null when the name carries none. */
  family: string | null
  step: number | null
  /** Library variable key when the palette came from one — lets a board swatch carry the real token. */
  variableKey?: string | null
}

export interface PaletteInput {
  swatches: ParsedSwatch[]
  warnings: string[]
  format: 'json' | 'text'
}

/* ------------------------------------------------------------------ shared */

const NAME_KEYS = ['name', 'token', 'key', 'id', 'label', 'title']
const VALUE_KEYS = ['$value', 'value', 'hex', 'color', 'colour', 'rgb', 'fill']

function swatchFrom(text: string, name: string): ParsedSwatch | null {
  const literals = findColorLiterals(text)
  if (literals.length !== 1) return null
  const { rgba } = literals[0]
  const parsed = parseTokenName(name)
  return {
    hex: toHex(rgba),
    alpha: rgba.a,
    rgba,
    name: name.trim(),
    family: parsed.family,
    step: parsed.step,
  }
}

const joinName = (prefix: string, key: string): string => (prefix === '' ? key : `${prefix}/${key}`)

/* ------------------------------------------------------------------ json */

function readJsonNode(node: unknown, prefix: string, out: ParsedSwatch[], warnings: string[]): void {
  if (typeof node === 'string') {
    const swatch = swatchFrom(node, prefix)
    if (swatch) out.push(swatch)
    else if (prefix !== '') warnings.push(`${prefix}: "${node}" is not a color`)
    return
  }

  if (Array.isArray(node)) {
    // `{ "violet": ["#f5f3ff", …] }` — the key is the family and the order is the ramp, but
    // there are no step numbers. Recording the family without inventing steps `1…n` leaves
    // the ladder to be inferred from lightness, which is what actually happened here.
    const family = prefix === '' ? null : parseTokenName(prefix).leaf
    for (const entry of node) {
      if (typeof entry !== 'string') {
        readJsonNode(entry, prefix, out, warnings)
        continue
      }
      const swatch = swatchFrom(entry, prefix)
      if (swatch) out.push({ ...swatch, family: family ?? swatch.family })
      else if (entry.trim() !== '') warnings.push(`${prefix || 'entry'}: "${entry}" is not a color`)
    }
    return
  }

  if (!isRecord(node)) return

  const valueKey = VALUE_KEYS.find((key) => typeof node[key] === 'string')
  if (valueKey) {
    const nameKey = NAME_KEYS.find((key) => typeof node[key] === 'string')
    const name = nameKey ? String(node[nameKey]) : prefix
    const swatch = swatchFrom(String(node[valueKey]), name)
    if (swatch) {
      const family = typeof node.family === 'string' ? node.family : typeof node.group === 'string' ? node.group : null
      const step = typeof node.step === 'number' ? node.step : null
      out.push({ ...swatch, family: family ?? swatch.family, step: step ?? swatch.step })
    } else {
      warnings.push(`${name || 'entry'}: "${node[valueKey]}" is not a color`)
    }
    return
  }

  for (const [key, value] of Object.entries(node)) {
    // W3C token files wrap metadata in `$…` keys; only `$value` carries a color.
    if (key.startsWith('$') && key !== '$value') continue
    readJsonNode(value, joinName(prefix, key), out, warnings)
  }
}

/* ------------------------------------------------------------------ text */

/** Strips the separators a CSV or a pasted table leaves around a name. */
function cleanName(text: string): string {
  return text
    .replace(/["'`]/g, ' ')
    .replace(/[,;\t|]+/g, ' ')
    .replace(/[:=]+/g, ' ')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function readTextLine(line: string, index: number, out: ParsedSwatch[], warnings: string[]): void {
  const literals = findColorLiterals(line)
  if (literals.length === 0) {
    if (line.trim() !== '') warnings.push(`line ${index + 1}: no color found — "${line.trim().slice(0, 40)}"`)
    return
  }

  if (literals.length === 1) {
    const literal = literals[0]
    const name = cleanName(line.slice(0, literal.start) + ' ' + line.slice(literal.end))
    const swatch = swatchFrom(literal.source, name)
    if (swatch) out.push(swatch)
    return
  }

  // Several colors on one line — a row of swatches with no way to tell which name belongs to
  // which. Take the colors, drop the names, and say so.
  warnings.push(`line ${index + 1}: ${literals.length} colors on one line — names ignored`)
  for (const literal of literals) {
    const swatch = swatchFrom(literal.source, '')
    if (swatch) out.push(swatch)
  }
}

/* ------------------------------------------------------------------ entry point */

/** Same color under the same name twice — a paste artefact, not two tokens. */
function dedupe(swatches: ParsedSwatch[], warnings: string[]): ParsedSwatch[] {
  const seen = new Set<string>()
  const kept: ParsedSwatch[] = []
  let dropped = 0
  for (const swatch of swatches) {
    const key = `${swatch.hex}|${swatch.alpha.toFixed(4)}|${swatch.name.toLowerCase()}`
    if (seen.has(key)) {
      dropped++
      continue
    }
    seen.add(key)
    kept.push(swatch)
  }
  if (dropped > 0) warnings.push(`${dropped} duplicate ${dropped === 1 ? 'row' : 'rows'} dropped`)
  return kept
}

export function parsePaletteInput(raw: string): PaletteInput {
  const text = String(raw ?? '')
  const warnings: string[] = []
  const swatches: ParsedSwatch[] = []

  const trimmed = text.trim()
  if (trimmed === '') return { swatches: [], warnings: [], format: 'text' }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      readJsonNode(JSON.parse(trimmed), '', swatches, warnings)
      return { swatches: dedupe(swatches, warnings), warnings, format: 'json' }
    } catch {
      warnings.push('looks like JSON but does not parse — read line by line instead')
    }
  }

  for (const [index, line] of text.split(/\r?\n/).entries()) readTextLine(line, index, swatches, warnings)
  return { swatches: dedupe(swatches, warnings), warnings, format: 'text' }
}
