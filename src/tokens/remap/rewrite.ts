/**
 * Rewriting colors in a developer's files from a `mapping.json`.
 *
 * The rule the whole exercise rests on: **keys never change, values do.** A stylesheet keeps
 * `--color-primary`, a token file keeps `colors.blue.500`; only what they resolve to moves.
 * That is what makes a palette migration something a team can accept — the diff touches
 * colors and nothing else.
 *
 * Two ways to find what to change, because a repository holds both situations:
 *
 * - **By literal.** Any color the file holds that matches a color the design file used to
 *   have. Works everywhere — CSS, SCSS, JSON, SVG, a Tailwind config — because it does not
 *   care about structure. This is the pass that catches hard-coded colors, which is the
 *   reason the whole thing exists.
 * - **By name.** A declaration whose *key* is a token name gets the new value whatever it
 *   currently holds. This is the one that survives drift: a `--color-primary` somebody nudged
 *   by hand no longer matches any old literal, but it is still that token.
 *
 * Replacements are written back in the notation they were found in — a hex stays a hex, an
 * `rgba()` stays an `rgba()`, a keyword stays a keyword when one exists for the new color —
 * and alpha always comes from the file, never from the mapping.
 *
 * Pure module: no filesystem, no Figma APIs, so it runs under `node --test`.
 */

import { varName } from '../engine.ts'
import { findColorLiterals, formatColorLiteral, toHex, type ColorLiteral, type Rgba } from './color-literal.ts'
import type { MappingFile, MappingRecord } from './contract.ts'
import { deltaE } from './match.ts'
import { parseHex } from '../color.ts'

export interface RewriteOptions {
  /**
   * How far off a literal may be and still count as the token's color, on the ΔE scale the
   * plugin snaps with. 0 means exact matches only.
   */
  snap: number
  /** Which mode's colors to take, when the mapping holds more than one. */
  mode?: string | null
  /** Also rewrite declarations whose key is a token name, whatever value they hold. */
  byName: boolean
}

export const DEFAULT_REWRITE_OPTIONS: RewriteOptions = { snap: 2, mode: null, byName: false }

export interface Replacement {
  /** 1-based, for a report a human reads next to their editor. */
  line: number
  column: number
  from: string
  to: string
  /** Which pass claimed it. */
  via: 'literal' | 'name'
  /** True when the file's color was near the token's rather than equal to it. */
  snapped: boolean
}

export interface RewriteResult {
  text: string
  replacements: Replacement[]
  /** Colors the file holds that no mapping entry claimed — the honest measure of coverage. */
  untouched: number
  warnings: string[]
}

/* ------------------------------------------------------------------ lookup */

interface Target {
  rgb: Rgba
  hex: string
}

interface Lookup {
  byHex: Map<string, Target>
  /** The same targets as a list, for the near-match scan. */
  all: Array<{ from: Rgba; target: Target }>
  byName: Map<string, Target>
  warnings: string[]
}

const rgbaOf = (hex: string, alpha: number): Rgba | null => {
  const rgb = parseHex(hex)
  return rgb ? { ...rgb, a: alpha } : null
}

/** `colors/Blue/500`, `colors.blue.500` and `--colors-blue-500` all key the same token. */
const nameKey = (name: string): string => varName(name.split(/[/.]/))

function buildLookup(mapping: MappingFile, options: RewriteOptions): Lookup {
  const byHex = new Map<string, Target>()
  const byName = new Map<string, Target>()
  const all: Array<{ from: Rgba; target: Target }> = []
  const conflicting = new Set<string>()
  const warnings: string[] = []

  const records = mapping.records.filter(
    (record: MappingRecord) => options.mode == null || record.mode === null || record.mode === options.mode
  )

  for (const record of records) {
    const to = rgbaOf(record.to, 1)
    if (!to) continue
    const target: Target = { rgb: to, hex: record.to }

    // A key is a name, so it can be rewritten even when its value drifted; the *current* name
    // is what a repository's stylesheet holds after stage 3's aliases, but the old one is what
    // it holds before, so both point at the new value.
    for (const name of [record.name, record.newName]) {
      if (name) byName.set(nameKey(name), target)
    }

    if (record.from === record.to) continue
    const existing = byHex.get(record.from)
    if (existing && existing.hex !== record.to) {
      conflicting.add(record.from)
      continue
    }
    byHex.set(record.from, target)
  }

  for (const hex of conflicting) {
    byHex.delete(hex)
    warnings.push(
      `${hex} maps to more than one new color in this file — pass --mode to say which theme this repository is`
    )
  }

  for (const [hex, target] of byHex) {
    const from = rgbaOf(hex, 1)
    if (from) all.push({ from, target })
  }

  return { byHex, all, byName, warnings }
}

function matchLiteral(literal: ColorLiteral, lookup: Lookup, snap: number): { target: Target; snapped: boolean } | null {
  const hex = toHex(literal.rgba)
  const exact = lookup.byHex.get(hex)
  if (exact) return { target: exact, snapped: false }
  if (snap <= 0) return null

  let best: Target | null = null
  let bestDistance = snap
  for (const candidate of lookup.all) {
    const distance = deltaE(candidate.from, literal.rgba)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate.target
    }
  }
  return best ? { target: best, snapped: true } : null
}

/* ------------------------------------------------------------------ edits */

interface Edit {
  start: number
  end: number
  to: string
  from: string
  via: Replacement['via']
  snapped: boolean
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

/** Applies edits back to front, so every offset still describes the text it was measured in. */
function applyEdits(text: string, edits: readonly Edit[]): { text: string; replacements: Replacement[] } {
  const ordered = [...edits].sort((a, b) => a.start - b.start)
  const kept: Edit[] = []
  let reach = -1
  for (const edit of ordered) {
    // The name pass and the literal pass can both claim one value; the first one wins rather
    // than the second one corrupting the text it half-rewrote.
    if (edit.start < reach) continue
    kept.push(edit)
    reach = edit.end
  }

  const replacements = kept.map((edit) => ({
    ...positionOf(text, edit.start),
    from: edit.from,
    to: edit.to,
    via: edit.via,
    snapped: edit.snapped,
  }))

  let out = text
  for (let i = kept.length - 1; i >= 0; i--) {
    const edit = kept[i]
    out = out.slice(0, edit.start) + edit.to + out.slice(edit.end)
  }
  return { text: out, replacements }
}

/* ------------------------------------------------------------------ by name */

/** `--colors-blue-500: #2563EB;` and `"colors.blue.500": "#2563EB"`. */
const CSS_DECLARATION_RE = /(--[\w-]+)(\s*:\s*)([^;{}\n]+)/g
const JSON_DECLARATION_RE = /("([^"\\]+)"\s*:\s*")([^"\\]*)(")/g

function nameEdits(text: string, lookup: Lookup): Edit[] {
  const edits: Edit[] = []

  const claim = (name: string, valueStart: number, value: string): void => {
    const target = lookup.byName.get(nameKey(name))
    if (!target) return
    const literals = findColorLiterals(value)
    // Only a declaration that is *entirely* one color is safe to rewrite by name: a shorthand
    // like `1px solid #ccc` names a border, not a color token.
    if (literals.length !== 1 || literals[0].source.trim() !== value.trim()) return
    const literal = literals[0]
    const to = formatColorLiteral({ ...target.rgb, a: literal.rgba.a }, literal.notation)
    if (to === literal.source) return
    edits.push({
      start: valueStart + literal.start,
      end: valueStart + literal.end,
      from: literal.source,
      to,
      via: 'name',
      snapped: false,
    })
  }

  for (const match of text.matchAll(CSS_DECLARATION_RE)) {
    claim(match[1].slice(2), match.index + match[1].length + match[2].length, match[3])
  }
  for (const match of text.matchAll(JSON_DECLARATION_RE)) {
    claim(match[2], match.index + match[1].length, match[3])
  }

  return edits
}

/* ------------------------------------------------------------------ entry point */

export function rewriteColors(
  text: string,
  mapping: MappingFile,
  options: Partial<RewriteOptions> = {}
): RewriteResult {
  const settings = { ...DEFAULT_REWRITE_OPTIONS, ...options }
  const lookup = buildLookup(mapping, settings)

  const edits: Edit[] = settings.byName ? nameEdits(text, lookup) : []
  let untouched = 0

  for (const literal of findColorLiterals(text)) {
    const matched = matchLiteral(literal, lookup, settings.snap)
    if (!matched) {
      untouched++
      continue
    }
    // The file decides the transparency; the mapping only ever decides the color.
    const to = formatColorLiteral({ ...matched.target.rgb, a: literal.rgba.a }, literal.notation)
    if (to === literal.source) continue
    edits.push({
      start: literal.start,
      end: literal.end,
      from: literal.source,
      to,
      via: 'literal',
      snapped: matched.snapped,
    })
  }

  const applied = applyEdits(text, edits)
  return { ...applied, untouched, warnings: lookup.warnings }
}
