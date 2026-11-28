/**
 * The plan of a merge of collections into one, as data — shared by `collections.merge`, which
 * writes it into the file, and the token engine, which applies it at export time when a theme
 * axis takes its values from collections (`foldCollectionAxis`). Pure: no Figma APIs.
 */

/**
 * Product themes that must share their keys belong in ONE collection, one mode per product and
 * theme: Figma then makes "same key, different value" true by construction. A file that keeps
 * them as separate collections — one product's 149 variables beside another's 40, 31 names shared —
 * cannot have code written against one product's tokens switched to the other's.
 * `collections.merge` builds that collection out of the separate ones.
 */
export interface MergeSourceVar {
  id: string
  name: string
  type: string
  /** Value per SOURCE mode name. */
  values: Record<string, unknown>
  scopes?: readonly string[]
  description?: string
  hiddenFromPublishing?: boolean
  codeSyntax?: Record<string, string>
}
export interface MergeSource {
  name: string
  /** source mode name → target mode name */
  modes: Record<string, string>
  variables: readonly MergeSourceVar[]
}
export type CellOrigin = 'source' | 'fill' | 'seed'
export interface MergeRow {
  name: string
  type: string
  cells: Record<string, { value: unknown; origin: CellOrigin; from?: string }>
  sourceIds: string[]
  meta: Pick<MergeSourceVar, 'scopes' | 'description' | 'hiddenFromPublishing' | 'codeSyntax'>
}
export interface MergePlan {
  modes: string[]
  rows: MergeRow[]
  filled: Array<{ name: string; mode: string; from: string }>
  seeded: number
  holes: Array<{ name: string; mode: string }>
  conflicts: Array<{ name: string; types: Record<string, string> }>
  scopeDiffs: string[]
}

/**
 * The whole merge as data, before anything is written. `fill` names, per target mode, the target
 * mode a key missing from its product borrows from (Business Light ← One Light); filled cells
 * are listed one by one, because each is a value a designer did not choose. `seed` starts a mode
 * as a copy of another (Platform has no tokens yet). A name with two types is a conflict and is
 * left out rather than guessed.
 */
export function planMerge(sources: readonly MergeSource[], options: { fill?: Record<string, string>; seed?: ReadonlyArray<{ mode: string; from: string }> } = {}): MergePlan {
  const modes: string[] = []
  for (const source of sources) {
    for (const target of Object.values(source.modes)) {
      if (modes.some((m) => m.toLowerCase() === target.toLowerCase())) throw new Error(`target mode "${target}" is mapped twice`)
      modes.push(target)
    }
  }
  for (const seed of options.seed ?? []) {
    if (modes.some((m) => m.toLowerCase() === seed.mode.toLowerCase())) throw new Error(`seed mode "${seed.mode}" already exists`)
    if (!modes.includes(seed.from)) throw new Error(`seed "${seed.mode}" copies "${seed.from}", which is not a target mode — have: ${modes.join(', ')}`)
  }
  for (const [mode, from] of Object.entries(options.fill ?? {})) {
    if (!modes.includes(mode)) throw new Error(`fill names "${mode}", which is not a target mode`)
    if (!modes.includes(from)) throw new Error(`fill for "${mode}" borrows from "${from}", which is not a target mode`)
  }

  const byName = new Map<string, Array<{ source: MergeSource; variable: MergeSourceVar }>>()
  for (const source of sources) {
    for (const variable of source.variables) {
      if (!byName.has(variable.name)) byName.set(variable.name, [])
      byName.get(variable.name)!.push({ source, variable })
    }
  }

  const rows: MergeRow[] = []
  const conflicts: MergePlan['conflicts'] = []
  const scopeDiffs: string[] = []
  for (const [name, entries] of byName) {
    const types = new Set(entries.map((e) => e.variable.type))
    if (types.size > 1) {
      conflicts.push({ name, types: Object.fromEntries(entries.map((e) => [e.source.name, e.variable.type])) })
      continue
    }
    const cells: MergeRow['cells'] = {}
    for (const { source, variable } of entries) {
      for (const [sourceMode, targetMode] of Object.entries(source.modes)) {
        if (sourceMode in variable.values) cells[targetMode] = { value: variable.values[sourceMode], origin: 'source' }
      }
    }
    const first = entries[0].variable
    const scopeSets = new Set(entries.map((e) => JSON.stringify([...(e.variable.scopes ?? [])].sort())))
    if (scopeSets.size > 1) scopeDiffs.push(name)
    rows.push({
      name,
      type: first.type,
      cells,
      sourceIds: entries.map((e) => e.variable.id),
      meta: { scopes: first.scopes, description: first.description || entries.find((e) => e.variable.description)?.variable.description, hiddenFromPublishing: first.hiddenFromPublishing, codeSyntax: first.codeSyntax },
    })
  }

  const filled: MergePlan['filled'] = []
  let seeded = 0
  for (const row of rows) {
    // Fill only from what a product really has — a fill of a fill would hide where a value came from.
    for (const [mode, from] of Object.entries(options.fill ?? {})) {
      if (row.cells[mode] || row.cells[from]?.origin !== 'source') continue
      row.cells[mode] = { value: row.cells[from].value, origin: 'fill', from }
      filled.push({ name: row.name, mode, from })
    }
    for (const seed of options.seed ?? []) {
      if (!row.cells[seed.from]) continue
      row.cells[seed.mode] = { value: row.cells[seed.from].value, origin: 'seed', from: seed.from }
      seeded += 1
    }
  }
  const allModes = [...modes, ...(options.seed ?? []).map((s) => s.mode)]
  const holes: MergePlan['holes'] = []
  for (const row of rows) for (const mode of allModes) if (!row.cells[mode]) holes.push({ name: row.name, mode })
  return { modes: allModes, rows, filled, seeded, holes, conflicts, scopeDiffs }
}
