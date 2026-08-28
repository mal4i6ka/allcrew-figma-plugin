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
import { parseHex } from '../color.ts'
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
  /** Library variable key of the landing, when the palette is a published collection. */
  toVariable: string | null
  /** How the landing was chosen — `exact`, `step`, `lightness` or `nearest`. */
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
      toVariable: entry.toVariableKey,
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
/**
 * The inverse of `buildMappingFile`: a mapping read back as a plan.
 *
 * The file was always rich enough for this — every record carries both colors, both names,
 * family, step, `via` and flags — but nothing read it back, so the only correspondence the
 * plugin could show was one it had just computed itself from a palette. That is the wrong
 * limit: the structural matcher is right for ramps and has nothing to say about, for instance,
 * which semantic token replaces which. Those correspondences come from somewhere else — an
 * agent, a spreadsheet, a person — and this is how they get in.
 *
 * Two fields do not survive the round trip, and neither is a loss the board can see: `usage`
 * (bindings per site, which only the inventory knows) and a family's `cost`/`stops`, which
 * describe how the matcher chose, not what it chose. Both come back as zero.
 */
export function planFromMappingFile(file: MappingFile): RemapPlan {
  const siteIdByName = new Map<string, string>()
  for (const record of file.records) if (!siteIdByName.has(record.name)) siteIdByName.set(record.name, record.id)

  return {
    entries: file.records.map((record, index) => entryFromRecord(record, index)),
    // Renames are per entity, so they are addressed by the site id the name belonged to.
    renames: file.renames.map((rename) => ({
      siteId: siteIdByName.get(rename.from) ?? rename.from,
      from: rename.from,
      to: rename.to,
      legacy: rename.legacy,
    })),
    families: file.families.map((family) => ({
      fromKey: family.from,
      fromLabel: family.from,
      toLabel: family.to,
      modeId: family.mode,
      shared: family.shared,
      cost: 0,
      stops: 0,
    })),
    unusedFamilies: [],
    warnings: file.warnings,
  }
}

function entryFromRecord(record: MappingRecord, index: number): RemapEntry {
  const from = rgbaOf(record.from, record.fromAlpha, `records[${index}].from`)
  const to = rgbaOf(record.to, record.toAlpha, `records[${index}].to`)

  return {
    site: {
      id: record.id,
      kind: record.kind,
      name: record.name,
      modeId: null,
      modeName: record.mode,
      rgba: from,
      usage: 0,
      // A mapping is a document about someone else's file. Nothing here decides whether a
      // write is allowed — that is the inventory's job — so the permissive defaults only ever
      // reach the renderer.
      editable: true,
      primitive: false,
    },
    from,
    to,
    toName: null,
    toVariableKey: record.toVariable,
    fromFamily: record.fromFamily,
    toFamily: record.toFamily,
    fromStep: record.fromStep,
    toStep: record.toStep,
    via: record.via,
    deltaE: record.deltaE,
    flags: record.flags,
  }
}

function rgbaOf(hex: string, alpha: number, where: string): { r: number; g: number; b: number; a: number } {
  const rgb = parseHex(hex)
  if (!rgb) throw new Error(`mapping: ${where} is not a hex color ("${hex}")`)
  return { ...rgb, a: typeof alpha === 'number' && alpha >= 0 && alpha <= 1 ? alpha : 1 }
}

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
