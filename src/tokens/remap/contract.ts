/**
 * `mapping.json` — the record of a remap, and the contract between its two executors.
 *
 * The Figma side writes it; the repository side (`altery-dj remap`) reads it and rewrites
 * developer files. Because those two live in different languages and different repositories,
 * the record is deliberately rich rather than minimal: variable id, both names, both colors
 * per mode, family, step and flags. A file that only carried `old hex → new hex` would work
 * exactly until someone wanted to match by token name instead, and then the format would
 * have to break. Here the strategy is the caller's choice and the file never changes.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { toHex } from './color-literal.ts'
import type { RemapEntry, RemapFlag, RemapPlan, SiteKind } from './plan.ts'

export const MAPPING_FORMAT = 'altery-color-remap'
export const MAPPING_VERSION = 1

export interface MappingRecord {
  kind: SiteKind
  /** Figma id of the variable, style or node this color lived on. */
  id: string
  name: string
  /** New name when the remap renamed it, else null. */
  newName: string | null
  /** Mode name, for variables that have modes. */
  mode: string | null
  from: string
  fromAlpha: number
  to: string
  toAlpha: number
  fromFamily: string | null
  fromStep: number | null
  toFamily: string | null
  toStep: number | null
  /** How the landing was chosen — `step`, `lightness` or `nearest`. */
  via: RemapEntry['via']
  deltaE: number
  flags: RemapFlag[]
}

export interface MappingFile {
  format: typeof MAPPING_FORMAT
  version: number
  generatedAt: string | null
  source: { file: string | null; palette: string | null }
  families: Array<{ from: string; to: string; mode: string | null; shared: boolean }>
  renames: Array<{ from: string; to: string; legacy: boolean }>
  records: MappingRecord[]
  warnings: string[]
}

export interface MappingMeta {
  /** Figma file name, when the caller knows it. */
  file?: string | null
  /** Where the new palette came from — `paste`, a file name, a library name. */
  palette?: string | null
  /** ISO timestamp; omitted rather than invented so tests and diffs stay stable. */
  generatedAt?: string | null
}

const round = (value: number, places = 3): number => {
  const factor = Math.pow(10, places)
  return Math.round(value * factor) / factor
}

export function buildMappingFile(plan: RemapPlan, meta: MappingMeta = {}): MappingFile {
  const renamedById = new Map(plan.renames.map((rename) => [rename.siteId, rename.to]))

  return {
    format: MAPPING_FORMAT,
    version: MAPPING_VERSION,
    generatedAt: meta.generatedAt ?? null,
    source: { file: meta.file ?? null, palette: meta.palette ?? null },
    families: plan.families.map((family) => ({
      from: family.fromLabel,
      to: family.toLabel,
      mode: family.modeId,
      shared: family.shared,
    })),
    renames: plan.renames.map((rename) => ({ from: rename.from, to: rename.to, legacy: rename.legacy })),
    records: plan.entries.map((entry) => ({
      kind: entry.site.kind,
      id: entry.site.id,
      name: entry.site.name,
      newName: renamedById.get(entry.site.id) ?? null,
      mode: entry.site.modeName,
      from: toHex(entry.from),
      fromAlpha: round(entry.from.a),
      to: toHex(entry.to),
      toAlpha: round(entry.to.a),
      fromFamily: entry.fromFamily,
      fromStep: entry.fromStep,
      toFamily: entry.toFamily,
      toStep: entry.toStep,
      via: entry.via,
      deltaE: round(entry.deltaE, 2),
      flags: entry.flags,
    })),
    warnings: plan.warnings,
  }
}

/* ------------------------------------------------------------------ csv */

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const CSV_COLUMNS = [
  'kind',
  'name',
  'newName',
  'mode',
  'from',
  'fromAlpha',
  'to',
  'toAlpha',
  'fromFamily',
  'fromStep',
  'toFamily',
  'toStep',
  'via',
  'deltaE',
  'flags',
] as const

/** The same records as a spreadsheet, for reading and for review outside a code editor. */
export function toCsv(mapping: MappingFile): string {
  const rows = mapping.records.map((record) =>
    CSV_COLUMNS.map((column) => csvCell(column === 'flags' ? record.flags.join(' ') : record[column])).join(',')
  )
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n'
}

/* ------------------------------------------------------------------ literal strategy */

export interface ColorReplacements {
  /** `#RRGGBB` (upper case) → `#RRGGBB`. Alpha is never part of the key: it is preserved. */
  replacements: Map<string, string>
  /** Old colors that map to more than one new color — usually different modes disagreeing. */
  conflicts: string[]
}

/**
 * The `match by literal` view of a mapping, for rewriting values in developer files.
 *
 * A conflict is not resolved here: one old hex asked to become two different new ones is a
 * question about which mode the repository's stylesheet represents, and answering it silently
 * would rewrite half a theme into the other. The caller decides — usually by passing the mode
 * it wants.
 */
export function colorReplacements(mapping: MappingFile, mode?: string | null): ColorReplacements {
  const replacements = new Map<string, string>()
  const conflicting = new Set<string>()

  for (const record of mapping.records) {
    if (mode !== undefined && mode !== null && record.mode !== mode) continue
    // A pair struck out in the panel was struck out of the migration, not only out of Figma.
    if (record.flags.includes('excluded')) continue
    if (record.from === record.to) continue
    const existing = replacements.get(record.from)
    if (existing && existing !== record.to) {
      conflicting.add(record.from)
      continue
    }
    replacements.set(record.from, record.to)
  }

  for (const hex of conflicting) replacements.delete(hex)
  return { replacements, conflicts: [...conflicting].sort() }
}

/** Reads a `mapping.json` back, rejecting anything that is not one. */
export function parseMappingFile(raw: unknown): MappingFile {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (typeof value !== 'object' || value === null) throw new Error('mapping: not an object')
  const file = value as Partial<MappingFile>
  if (file.format !== MAPPING_FORMAT) throw new Error(`mapping: unknown format "${String(file.format)}"`)
  if (typeof file.version !== 'number' || file.version > MAPPING_VERSION) {
    throw new Error(`mapping: version ${String(file.version)} is newer than this build understands`)
  }
  if (!Array.isArray(file.records)) throw new Error('mapping: records missing')
  return {
    format: MAPPING_FORMAT,
    version: file.version,
    generatedAt: file.generatedAt ?? null,
    source: file.source ?? { file: null, palette: null },
    families: file.families ?? [],
    renames: file.renames ?? [],
    records: file.records,
    warnings: file.warnings ?? [],
  }
}
