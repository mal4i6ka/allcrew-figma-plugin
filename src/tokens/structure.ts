/**
 * The export structure: how a file's collections, groups and modes become the package.
 *
 * Figma gives every value three facets — the collection it is in, the path of groups in its
 * name, the mode it is for — and which facet carries what is an accident of the plan and the
 * designer. On a Starter seat a collection has one mode, so "Dark" is a second collection or a
 * `dark/` group; on Professional it is a mode; on Enterprise it may be an extended collection.
 * Code wants none of that: an output collection, the attributes that switch it, and a path.
 *
 * So a structure is a pivot. It lists OUTPUT collections, each with its axes (attribute →
 * values) and its sources: rules that take an input collection, or one group of it, and place
 * it in this collection at a point on the axes, optionally under another path. One rule type
 * covers every move the editor offers — a collection as a product, a group as a mode, a group
 * moved to the root, a group hidden, a mode placed by hand — and the most specific rule for a
 * variable (the longest group prefix) is the one that applies, so overrides need no exclusions.
 *
 * `materializeStructure` turns the file's graph into the graph the rest of the engine already
 * reads: one collection per output collection whose modes are the package grid — the cartesian
 * product of every axis a tokens collection declares — so the emitters, the inline step and the
 * native files need no new concept. Pure module: no Figma APIs.
 */

import type { TokenGraph, TokenGraphCollection, TokenGraphVariable } from './engine.ts'
import { varName } from './engine.ts'
import type { ThemeAxisValue } from './theme-axes.ts'

export type OutputKind = 'tokens' | 'hidden' | 'files' | 'breakpoints'

export interface StructureAxis {
  attribute: string
  /** May be set again on any subtree. At most one axis of the package. */
  nested?: boolean
  values: ThemeAxisValue[]
}

export interface StructureSource {
  /** The input collection, by name. */
  collection: string
  /** Only this group of it (`font`, `navigation/content`). Omitted: the whole collection. */
  group?: string
  /** The output path the group's prefix is replaced with (`''` = the root). Omitted: kept. */
  to?: string
  /** Fixed coordinates: attribute → value label. Axes not named here are read from the mode
   * names, or hold for every value when nothing in the name says. */
  at?: Record<string, string>
  /** Coordinates per mode name, for modes whose names do not spell them. */
  modes?: Record<string, Record<string, string>>
  /** This subtree is left out of the export. */
  hidden?: boolean
}

export interface OutputCollection {
  name: string
  as?: OutputKind
  axes?: StructureAxis[]
  /** With `as: 'files'`: the axis whose values become separate files. The first axis by default. */
  filesBy?: string
  /** DESIGN.md's role for tokens here that carry no scope (`spacing`, `radius`, …). */
  docRole?: string
  sources: StructureSource[]
}

export interface ExportStructure {
  version: 1
  collections: OutputCollection[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const cleanAttr = (raw: unknown) => String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '')
export const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
export const slug = (name: string) => varName([name]) || ''
const words = (name: string) => slug(name).split('-').filter((w) => w !== '')
/** Whether every word of `label` occurs in `name`, whole and in order (`One` in `One Light`, not in `Phone`). */
export function holds(name: string, label: string): boolean {
  const have = words(name)
  const want = words(label)
  if (want.length === 0) return false
  for (let at = 0; at + want.length <= have.length; at++) if (want.every((w, n) => have[at + n] === w)) return true
  return false
}
export const pathOf = (name: string) => name.split('/').map((s) => s.trim()).filter((s) => s !== '')
const underGroup = (segments: readonly string[], group: string) => {
  const prefix = pathOf(group)
  return prefix.length <= segments.length && prefix.every((seg, n) => same(seg, segments[n]))
}

/* ------------------------------------------------------------------ validation */

export function normalizeStructure(raw: unknown): { structure: ExportStructure | null; problems: string[] } {
  const problems: string[] = []
  if (raw === undefined || raw === null || raw === '') return { structure: null, problems }
  if (!isObject(raw) || !Array.isArray(raw.collections)) return { structure: null, problems: ['the export structure must be { version: 1, collections: [...] }'] }
  const collections: OutputCollection[] = []
  const seen = new Set<string>()
  for (const [i, entry] of (raw.collections as unknown[]).entries()) {
    if (!isObject(entry)) {
      problems.push(`collections[${i}] must be an object`)
      continue
    }
    const name = String(entry.name ?? '').trim()
    if (!name) problems.push(`collections[${i}] needs a name`)
    if (seen.has(name.toLowerCase())) problems.push(`two output collections are named "${name}"`)
    seen.add(name.toLowerCase())
    const as = entry.as === undefined ? undefined : (['tokens', 'hidden', 'files', 'breakpoints'] as const).find((k) => k === entry.as)
    if (entry.as !== undefined && !as) problems.push(`collections[${i}].as must be tokens, hidden, files or breakpoints`)
    const axes: StructureAxis[] = []
    for (const [j, axis] of (Array.isArray(entry.axes) ? (entry.axes as unknown[]) : []).entries()) {
      if (!isObject(axis)) {
        problems.push(`collections[${i}].axes[${j}] must be an object`)
        continue
      }
      const attribute = cleanAttr(axis.attribute)
      if (!attribute) problems.push(`collections[${i}].axes[${j}] needs an attribute`)
      const values: ThemeAxisValue[] = []
      for (const [k, v] of (Array.isArray(axis.values) ? (axis.values as unknown[]) : []).entries()) {
        const value = typeof v === 'string' ? { label: v } : isObject(v) ? v : null
        const label = value && typeof value.label === 'string' ? value.label.trim() : ''
        if (!label) {
          problems.push(`collections[${i}].axes[${j}].values[${k}] needs a label`)
          continue
        }
        values.push({
          label,
          ...(typeof value!.value === 'string' && value!.value.trim() ? { value: value!.value.trim() } : {}),
          ...(value!.base === true ? { base: true } : {}),
          ...(typeof value!.sameAs === 'string' && value!.sameAs.trim() ? { sameAs: value!.sameAs.trim() } : {}),
        })
      }
      if (values.length === 0) problems.push(`collections[${i}].axes[${j}] (${attribute || '?'}) has no values`)
      axes.push({ attribute, ...(axis.nested === true ? { nested: true } : {}), values })
    }
    const sources: StructureSource[] = []
    for (const [j, s] of (Array.isArray(entry.sources) ? (entry.sources as unknown[]) : []).entries()) {
      if (!isObject(s) || typeof s.collection !== 'string' || !s.collection.trim()) {
        problems.push(`collections[${i}].sources[${j}] needs a collection`)
        continue
      }
      const at: Record<string, string> = {}
      if (s.at !== undefined) {
        if (!isObject(s.at)) problems.push(`collections[${i}].sources[${j}].at must be an object`)
        else for (const [a, v] of Object.entries(s.at)) if (typeof v === 'string' && v.trim()) at[cleanAttr(a)] = v.trim()
      }
      const modes: Record<string, Record<string, string>> = {}
      if (s.modes !== undefined) {
        if (!isObject(s.modes)) problems.push(`collections[${i}].sources[${j}].modes must be an object`)
        else {
          for (const [mode, coords] of Object.entries(s.modes)) {
            if (!isObject(coords)) continue
            modes[mode] = {}
            for (const [a, v] of Object.entries(coords)) if (typeof v === 'string' && v.trim()) modes[mode][cleanAttr(a)] = v.trim()
          }
        }
      }
      sources.push({
        collection: s.collection.trim(),
        ...(typeof s.group === 'string' && s.group.trim() ? { group: pathOf(s.group).join('/') } : {}),
        ...(typeof s.to === 'string' ? { to: pathOf(s.to).join('/') } : {}),
        ...(Object.keys(at).length > 0 ? { at } : {}),
        ...(Object.keys(modes).length > 0 ? { modes } : {}),
        ...(s.hidden === true ? { hidden: true } : {}),
      })
    }
    collections.push({
      name,
      ...(as ? { as } : {}),
      ...(axes.length > 0 ? { axes } : {}),
      ...(typeof entry.filesBy === 'string' && entry.filesBy.trim() ? { filesBy: cleanAttr(entry.filesBy) } : {}),
      ...(typeof entry.docRole === 'string' && entry.docRole.trim() ? { docRole: entry.docRole.trim().toLowerCase() } : {}),
      sources,
    })
  }
  const nested = collections.flatMap((c) => (c.axes ?? []).filter((a) => a.nested).map((a) => a.attribute))
  if (new Set(nested).size > 1) problems.push(`only one attribute can be switched inside the page, ${[...new Set(nested)].join(' and ')} both are`)
  // The same attribute must mean the same values wherever it appears.
  const byAttr = new Map<string, string>()
  for (const c of collections) {
    for (const axis of c.axes ?? []) {
      const key = axis.values.map((v) => v.label.toLowerCase()).sort().join('|')
      const before = byAttr.get(axis.attribute)
      if (before !== undefined && before !== key) problems.push(`the attribute ${axis.attribute} has different values in different collections`)
      byAttr.set(axis.attribute, key)
    }
  }
  if (problems.length > 0) return { structure: null, problems }
  return { structure: { version: 1, collections }, problems }
}

/* ------------------------------------------------------------------ the package grid */

/** One axis: an attribute, what it says, which value is the base and which values copy another. */
export interface PackageAxis {
  attribute: string
  labels: string[]
  values: string[]
  base: string
  nested: boolean
  sameAs: Record<string, string>
}

function axisOf(axis: StructureAxis): PackageAxis {
  const real = axis.values.filter((v) => !v.sameAs)
  return {
    attribute: axis.attribute,
    labels: axis.values.map((v) => v.label),
    values: axis.values.map((v) => v.value?.replace(/[^A-Za-z0-9_-]/g, '') || slug(v.label)),
    base: (real.find((v) => v.base) ?? real[0] ?? axis.values[0]).label,
    nested: axis.nested === true,
    sameAs: Object.fromEntries(axis.values.filter((v) => v.sameAs).map((v) => [v.label, v.sameAs!])),
  }
}

/** The axes of the given collections, merged by attribute, the nested one last — so the grid's
 * mode names read `product-theme`. */
function mergedAxes(collections: readonly OutputCollection[]): PackageAxis[] {
  const axes = new Map<string, PackageAxis>()
  for (const c of collections) {
    for (const axis of c.axes ?? []) {
      const have = axes.get(axis.attribute)
      if (have) {
        if (axis.nested) have.nested = true
        continue
      }
      axes.set(axis.attribute, axisOf(axis))
    }
  }
  const list = [...axes.values()]
  const nested = list.find((a) => a.nested)
  return nested ? [...list.filter((a) => a !== nested), nested] : list
}

/** The axes every tokens or hidden collection declares: what `tokens.css` switches on. A
 * collection shipped as files or breakpoints keeps its axes to itself. */
export function packageAxes(structure: ExportStructure): PackageAxis[] {
  return mergedAxes(structure.collections.filter((c) => (c.as ?? 'tokens') === 'tokens' || c.as === 'hidden'))
}

/** Every cell of a grid, as label coordinates in axis order, the base cell first. */
export function gridCells(axes: readonly PackageAxis[]): string[][] {
  let cells: string[][] = [[]]
  for (const axis of axes) {
    const ordered = [axis.base, ...axis.labels.filter((l) => l !== axis.base)]
    cells = cells.flatMap((cell) => ordered.map((label) => [...cell, label]))
  }
  return cells
}

/** The mode name a cell has in the materialized graph: the attribute values joined (`one-light`). */
export function cellName(axes: readonly PackageAxis[], cell: readonly string[]): string {
  return axes.map((axis, n) => axis.values[axis.labels.findIndex((l) => same(l, cell[n]))] ?? slug(cell[n])).join('-') || 'default'
}

/* ------------------------------------------------------------------ materialization */

export interface Placement {
  /** Input collection → the output collection(s) it feeds, or ['unplaced']. */
  collections: Record<string, string[]>
  /** `collection / mode` → where it lands (`Business × Light`), or [] when it maps to no cell. */
  modes: Record<string, string[]>
  /** `collection / group` → what the rule did with it. */
  groups: Record<string, string>
}

export interface Materialized {
  graph: TokenGraph
  /** What `tokens.css` switches on. */
  axes: PackageAxis[]
  /** Collection roles the rest of the engine reads. */
  roles: { hidden: string[]; breakpoints: string[]; products: string[]; themes: string[] }
  /** Output collection → DESIGN.md role. */
  docRoles: Record<string, string>
  /** A collection shipped as a file (by name) → the axes its own stylesheet switches on. */
  fileAxes: Record<string, PackageAxis[]>
  placement: Placement
  notes: string[]
  problems: string[]
}

interface Instance {
  /** Label per coordinate axis, or '*' when the instance holds for every value. */
  coords: string[]
  value: unknown
  type: string
  /** The rule's group depth: a rule for `navigation/content` beats one for `navigation`. */
  specificity: number
  scopes?: readonly string[]
  codeSyntax?: TokenGraphVariable['codeSyntax']
}

/**
 * The structure applied to the file: every output collection materialized as one collection
 * whose modes are the package grid, every alias re-aimed at the merged variable it now means,
 * input collections the structure never names exported as they stand (said in a note), so a
 * collection added after the structure was set is not silently lost.
 */
export function materializeStructure(graph: TokenGraph, structure: ExportStructure): Materialized {
  const inputs = graph.collections ?? []
  const variables = graph.variables ?? []
  // Coordinates are read on every axis any collection declares; the package grid is narrower.
  const coordAxes = mergedAxes(structure.collections.filter((c) => (c.as ?? 'tokens') !== 'breakpoints'))
  const axes = packageAxes(structure)
  const problems: string[] = []
  const notes: string[] = []
  const placement: Placement = { collections: {}, modes: {}, groups: {} }
  const findInput = (name: string) => inputs.find((c) => same(c.name, name))
  const roles: Materialized['roles'] = { hidden: [], breakpoints: [], products: [], themes: [] }
  const docRoles: Record<string, string> = {}
  const fileAxes: Record<string, PackageAxis[]> = {}

  for (const out of structure.collections) {
    for (const s of out.sources) {
      if (!findInput(s.collection)) problems.push(`"${out.name}" reads the collection "${s.collection}", which this file does not have`)
      for (const [attr, label] of Object.entries(s.at ?? {})) {
        const axis = coordAxes.find((a) => a.attribute === attr)
        if (!axis) problems.push(`"${out.name}" places ${s.collection} on ${attr}, which no collection declares as an axis`)
        else if (!axis.labels.some((l) => same(l, label))) problems.push(`${attr} has no value "${label}" (it has ${axis.labels.join(', ')})`)
      }
    }
  }
  if (problems.length > 0) return { graph, axes, roles, docRoles, fileAxes, placement, notes, problems }

  const outCollections: TokenGraphCollection[] = []
  const outVariables: TokenGraphVariable[] = []
  const repoint = new Map<string, string>()
  const consumed = new Set<string>()
  // Variables keep the file's order: the tree, and so tokens.css and tokens.json, are built in
  // that order, and a merged variable takes the place of the first variable that feeds it.
  const inputIndex = new Map(variables.map((v, n) => [v.id, n]))
  const order = new Map<string, number>()
  const place = (id: string, index: number) => order.set(id, Math.min(order.get(id) ?? Infinity, index))

  /** Where one mode of an input collection lands under a rule, per coordinate axis, or null when
   * the mode names say nothing the rule does not fix — such a mode is left out and said. */
  const coordsOf = (s: StructureSource, input: TokenGraphCollection, modeName: string): string[] | null => {
    const explicit = Object.entries(s.modes ?? {}).find(([m]) => same(m, modeName))?.[1]
    let readAny = false
    let needsRead = false
    const out = coordAxes.map((axis) => {
      const fixed = s.at?.[axis.attribute]
      if (fixed) return axis.labels.find((l) => same(l, fixed)) ?? fixed
      const given = explicit?.[axis.attribute]
      if (given) {
        readAny = true
        return axis.labels.find((l) => same(l, given)) ?? given
      }
      if (input.modes.length < 2) return '*'
      needsRead = true
      const hits = axis.labels.filter((l) => holds(modeName, l))
      const longest = hits.filter((h) => words(h).length === Math.max(...hits.map((x) => words(x).length)))
      if (longest.length === 1) readAny = true
      return longest.length === 1 ? longest[0] : longest.length > 1 ? '?' : '*'
    })
    if (out.includes('?')) return null
    if (needsRead && !readAny) return null
    return out
  }

  /** The value a cell shows: the nearest instance — the cell itself, then each axis reset to its
   * base, one at a time and together, then anything the token has anywhere. */
  const fill = (list: Instance[], cell: readonly string[]): Instance | undefined => {
    const resolved = cell.map((label, n) => {
      const seen = new Set<string>()
      let at = label
      while (!seen.has(at) && coordAxes[n].sameAs[at]) {
        seen.add(at)
        at = coordAxes[n].sameAs[at]
      }
      return at
    })
    const matching = (target: readonly string[]) => {
      let best: Instance | undefined
      let score = -1
      for (const inst of list) {
        if (!inst.coords.every((c, n) => c === '*' || same(c, target[n]))) continue
        const s = inst.coords.filter((c) => c !== '*').length * 10 + inst.specificity
        if (s > score) {
          best = inst
          score = s
        }
      }
      return best
    }
    const candidates: string[][] = [resolved]
    for (let mask = 1; mask < 1 << coordAxes.length; mask++) candidates.push(resolved.map((c, n) => (mask & (1 << n) ? coordAxes[n].base : c)))
    for (const target of candidates) {
      const inst = matching(target)
      if (inst) return inst
    }
    return list[0]
  }

  for (const out of structure.collections) {
    const kind = out.as ?? 'tokens'
    if (out.docRole) docRoles[out.name] = out.docRole
    if (kind === 'breakpoints') {
      // Left as the file has it: the breakpoint reader wants the modes, or the `breakpoint/*`
      // variables, as they stand.
      for (const s of out.sources) {
        const input = findInput(s.collection)!
        if (consumed.has(input.id)) continue
        consumed.add(input.id)
        outCollections.push(input)
        outVariables.push(...variables.filter((v) => v.collectionId === input.id))
        for (const v of variables) if (v.collectionId === input.id) place(v.id, inputIndex.get(v.id)!)
        placement.collections[input.name] = [...(placement.collections[input.name] ?? []), `${out.name} (breakpoints)`]
        for (const m of input.modes) placement.modes[`${input.name} / ${m.name}`] = ['--bp-*']
        roles.breakpoints.push(input.name)
      }
      continue
    }

    const collectionId = `out:${slug(out.name)}`
    const instances = new Map<string, Instance[]>()
    const rulesFor = (input: TokenGraphCollection) =>
      out.sources.filter((s) => same(s.collection, input.name)).sort((a, b) => pathOf(b.group ?? '').length - pathOf(a.group ?? '').length)
    for (const input of [...new Set(out.sources.map((s) => findInput(s.collection)!))]) {
      consumed.add(input.id)
      placement.collections[input.name] = [...(placement.collections[input.name] ?? []), out.name]
      const rules = rulesFor(input)
      for (const v of variables.filter((x) => x.collectionId === input.id)) {
        const segments = pathOf(v.name)
        const rule = rules.find((s) => !s.group || underGroup(segments, s.group))
        if (!rule) continue
        const groupKey = `${input.name} / ${rule.group ?? ''}`
        if (rule.hidden) {
          if (rule.group) placement.groups[groupKey] = 'hidden'
          continue
        }
        const rest = rule.group ? segments.slice(pathOf(rule.group).length) : segments
        const path = rule.to !== undefined ? [...pathOf(rule.to), ...rest] : segments
        if (path.length === 0) continue
        if (rule.group) {
          placement.groups[groupKey] = `→ ${out.name}${rule.to !== undefined ? ' / ' + (rule.to || '(root)') : ''}${rule.at ? ' @ ' + Object.values(rule.at).join(' × ') : ''}`
        }
        const pathKey = path.join('/')
        for (const m of input.modes) {
          const coords = coordsOf(rule, input, m.name)
          const modeKey = `${input.name} / ${m.name}`
          if (!coords) {
            placement.modes[modeKey] = placement.modes[modeKey] ?? []
            continue
          }
          const where = coordAxes.length ? coordAxes.map((axis, n) => (coords[n] === '*' ? `any ${axis.attribute}` : coords[n])).join(' × ') : out.name
          if (!placement.modes[modeKey]?.includes(where)) placement.modes[modeKey] = [...(placement.modes[modeKey] ?? []), where]
          if (!instances.has(pathKey)) instances.set(pathKey, [])
          instances.get(pathKey)!.push({
            coords,
            value: v.valuesByMode[m.modeId],
            type: v.resolvedType,
            specificity: pathOf(rule.group ?? '').length,
            ...(v.scopes ? { scopes: v.scopes } : {}),
            ...(v.codeSyntax ? { codeSyntax: v.codeSyntax } : {}),
          })
        }
        repoint.set(v.id, `${collectionId}:${pathKey}`)
        place(`${collectionId}:${pathKey}`, inputIndex.get(v.id)!)
      }
      for (const m of input.modes) {
        const key = `${input.name} / ${m.name}`
        if (placement.modes[key]?.length === 0) notes.push(`${key} maps to no cell of ${out.name} — place it on an axis value, or it is left out`)
      }
    }

    const conflicts: string[] = []
    /** One materialized collection over `ownAxes` (a sub-grid of the coordinate axes); the
     * coordinate axes it lacks are read at their base. */
    const emit = (name: string, id: string, ownAxes: PackageAxis[], pin: Record<string, string>) => {
      const cells = gridCells(ownAxes)
      // A collection with no axis is constants: one mode, named as the file names it when one
      // collection feeds it, so tokens.json reads as before.
      const feeders = [...new Set(out.sources.map((s) => findInput(s.collection)!))]
      const feederDefault = feeders.length === 1 ? feeders[0].modes.find((m) => m.modeId === feeders[0].defaultModeId) ?? feeders[0].modes[0] : undefined
      const single = ownAxes.length === 0 && feederDefault ? feederDefault.name : undefined
      const modes = cells.map((cell) => ({ modeId: `${id}:${single ?? cellName(ownAxes, cell)}`, name: single ?? cellName(ownAxes, cell) }))
      // `product` is not set here: buildPackage marks the one it is building and makes the others
      // inlineOnly, and a collection carrying both would still claim names first.
      const collection: TokenGraphCollection = { id, name, defaultModeId: modes[0].modeId, modes }
      const vars: TokenGraphVariable[] = []
      for (const [pathKey, list] of instances) {
        if (new Set(list.map((i) => i.type)).size > 1) {
          if (!conflicts.includes(pathKey)) conflicts.push(pathKey)
          continue
        }
        const valuesByMode: Record<string, unknown> = {}
        cells.forEach((cell, n) => {
          const full = coordAxes.map((axis) => pin[axis.attribute] ?? cell[ownAxes.findIndex((a) => a.attribute === axis.attribute)] ?? axis.base)
          const inst = fill(list, full)
          if (inst) valuesByMode[modes[n].modeId] = inst.value
        })
        const first = list[0]
        vars.push({ id: `${id}:${pathKey}`, name: pathKey, collectionId: id, resolvedType: first.type, valuesByMode, ...(first.scopes ? { scopes: first.scopes } : {}), ...(first.codeSyntax ? { codeSyntax: first.codeSyntax } : {}) })
        place(`${id}:${pathKey}`, order.get(`${collectionId}:${pathKey}`) ?? Infinity)
        if (id !== collectionId) for (const [vid, target] of repoint) if (target === `${collectionId}:${pathKey}`) repoint.set(vid, `${id}:${pathKey}`)
      }
      outCollections.push(collection)
      outVariables.push(...vars)
    }

    if (kind === 'files') {
      // One collection per value of the splitting axis, the other axes as its modes — what the
      // product role already builds a file from. Every file holds the same keys.
      const own = mergedAxes([out])
      const by = own.find((a) => a.attribute === (out.filesBy ?? own[0]?.attribute))
      if (!by) {
        problems.push(`"${out.name}" ships as files but names no axis to split them by`)
        continue
      }
      for (const label of by.labels) {
        const rest = own.filter((a) => a !== by)
        emit(label, `${collectionId}:${slug(label)}`, rest, { [by.attribute]: label })
        roles.products.push(label)
        fileAxes[label] = rest
      }
    } else {
      // Themed collections take the whole package grid, so every theme reads them; a collection
      // with no axis of its own stays one mode — constants, the same in every theme.
      const own = mergedAxes([out])
      emit(out.name, collectionId, own.length > 0 ? axes : [], {})
      if (kind === 'hidden') roles.hidden.push(out.name)
      else if (own.length > 0) roles.themes.push(out.name)
    }
    if (conflicts.length > 0) notes.push(`${out.name}: left out, a different type in different sources — ${conflicts.join(', ')}`)
  }

  for (const input of inputs) {
    if (consumed.has(input.id)) continue
    placement.collections[input.name] = ['unplaced']
    outCollections.push(input)
    outVariables.push(...variables.filter((v) => v.collectionId === input.id))
    for (const v of variables) if (v.collectionId === input.id) place(v.id, inputIndex.get(v.id)!)
    if (input.modes.length > 1) notes.push(`${input.name} is not placed in the structure — exported as it is, read at its default mode`)
  }

  const aim = (value: unknown): unknown => {
    if (isObject(value) && value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string' && repoint.has(value.id)) return { ...value, id: repoint.get(value.id) }
    if (isObject(value) && ('color' in value || 'opacity' in value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, aim(v)]))
    return value
  }
  const aimed = outVariables
    .map((v) => ({ ...v, valuesByMode: Object.fromEntries(Object.entries(v.valuesByMode).map(([id, value]) => [id, aim(value)])) }))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  // Collections in the file's order too, each at the place of the first variable it holds.
  const collectionOrder = new Map<string, number>()
  for (const v of aimed) collectionOrder.set(v.collectionId, Math.min(collectionOrder.get(v.collectionId) ?? Infinity, order.get(v.id) ?? Infinity))
  outCollections.sort((a, b) => (collectionOrder.get(a.id) ?? Infinity) - (collectionOrder.get(b.id) ?? Infinity))
  const textStyles = graph.textStyles?.map((style) =>
    style.boundVariables ? { ...style, boundVariables: Object.fromEntries(Object.entries(style.boundVariables).map(([k, id]) => [k, repoint.get(id) ?? id])) } : style
  )
  return {
    graph: { ...graph, collections: outCollections, variables: aimed, ...(textStyles ? { textStyles } : {}) },
    axes,
    roles,
    docRoles,
    fileAxes,
    placement,
    notes,
    problems,
  }
}

/* ------------------------------------------------------------------ migration */

export interface LegacyTokenSettings {
  collectionRoles?: string
  themeAttribute?: string
  slugThemes?: boolean
  themeAxes?: unknown
  themeMerges?: { groups: Array<{ name: string; modes: Array<{ collection: string; name: string }> }> }
}

/** DESIGN.md roles a collection may be given in the `Collection roles` setting. Mirrors
 * `ROLE_INFO` in design-md/model.ts without importing it (that module reads this one's output). */
const DOC_ROLES = new Set(['spacing', 'radius', 'size', 'border-width', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'paragraph', 'surface', 'text', 'border', 'icon', 'opacity', 'z-index', 'duration', 'easing', 'color', 'breakpoint', 'shadow', 'blur', 'flag', 'other'])

/**
 * The four settings that came before the structure — collection roles, the theme-collections
 * table, the theme attribute and the theme axes — read as one structure over this file. What a
 * file pins today keeps producing the package it produced yesterday: the migrated structure of
 * a two-product file is checked against its old export by value.
 */
export function migrateStructure(graph: TokenGraph, settings: LegacyTokenSettings): ExportStructure {
  const inputs = graph.collections ?? []
  const roles: Record<string, string> = {}
  for (const pair of String(settings.collectionRoles ?? '').split(/[,;\n]+/)) {
    const at = pair.search(/[:=]/)
    if (at === -1) continue
    const name = pair.slice(0, at).trim()
    let role = pair.slice(at + 1).trim().toLowerCase()
    if (role === 'hide') role = 'hidden'
    if (role === 'breakpoint' || role === 'bp') role = 'breakpoints'
    if (role === 'theme') role = 'themes'
    if (name && role) roles[name.toLowerCase()] = role
  }
  const roleOf = (c: TokenGraphCollection) => roles[c.name.trim().toLowerCase()] ?? (/^breakpoints?$/i.test(c.name.trim()) ? 'breakpoints' : undefined)
  const attribute = cleanAttr(settings.themeAttribute) || 'data-theme-name'
  const themeValue = (mode: string) => (settings.slugThemes ? undefined : mode)
  const collections: OutputCollection[] = []
  const placed = new Set<string>()

  // The theme-collections table: single-mode collections that are one theme each.
  for (const group of settings.themeMerges?.groups ?? []) {
    const members = group.modes.filter((m) => inputs.some((c) => same(c.name, m.collection)))
    if (members.length === 0) continue
    collections.push({
      name: group.name,
      axes: [{ attribute, nested: true, values: members.map((m, n) => ({ label: m.name, ...(n === 0 ? { base: true } : {}), ...(themeValue(m.name) ? { value: themeValue(m.name) } : {}) })) }],
      sources: members.map((m) => ({ collection: inputs.find((c) => same(c.name, m.collection))!.name, at: { [attribute]: m.name } })),
    })
    for (const m of members) placed.add(m.collection.toLowerCase())
  }

  // Theme axes over the themes collection (or every multi-mode one), as the picker set them.
  const axesSpec = isObject(settings.themeAxes) && Array.isArray(settings.themeAxes.axes) ? (settings.themeAxes as { axes: Array<{ attribute: string; nested?: boolean; source?: string; values: Array<{ label: string; value?: string; base?: boolean; sameAs?: string; collections?: string[] }>; shared?: string[] }>; cells?: Record<string, string>; sameAs?: Record<string, string>; collections?: string[] }) : null
  const stringAxes = typeof settings.themeAxes === 'string' ? settings.themeAxes : ''
  const themesNamed = inputs.filter((c) => roleOf(c) === 'themes')
  const themed = themesNamed.length > 0 ? themesNamed : inputs.filter((c) => c.modes.length > 1 && !placed.has(c.name.toLowerCase()) && roleOf(c) !== 'breakpoints' && roleOf(c) !== 'hidden')
  const axes: StructureAxis[] = []
  if (axesSpec) {
    for (const a of axesSpec.axes) axes.push({ attribute: cleanAttr(a.attribute), ...(a.nested ? { nested: true } : {}), values: a.values.map((v) => ({ label: v.label, ...(v.value ? { value: v.value } : {}), ...(v.base ? { base: true } : {}), ...(v.sameAs ? { sameAs: v.sameAs } : {}) })) })
  } else if (stringAxes.trim()) {
    const parts = stringAxes.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)
    parts.forEach((part, n) => {
      const at = part.search(/[:=]/)
      if (at === -1) return
      axes.push({ attribute: cleanAttr(part.slice(0, at)), ...(n === parts.length - 1 ? { nested: true } : {}), values: part.slice(at + 1).split(',').map((v) => v.trim()).filter(Boolean).map((label) => ({ label })) })
    })
  }
  const collectionsAxis = axesSpec?.axes.find((a) => a.source === 'collections')
  const namesAxis = axesSpec?.axes.find((a) => a.source === 'names')
  if (collectionsAxis || namesAxis) {
    // Products as collections / a marker in the names: one output collection over all of them.
    const out: OutputCollection = { name: 'Themes', axes, sources: [] }
    if (collectionsAxis) {
      for (const v of collectionsAxis.values) {
        if (v.sameAs) continue
        const holders = v.collections?.length ? v.collections : inputs.filter((c) => holds(c.name, v.label)).map((c) => c.name)
        for (const name of holders) {
          const input = inputs.find((c) => same(c.name, name))
          if (!input) continue
          out.sources.push({ collection: input.name, at: { [collectionsAxis.attribute]: v.label } })
          placed.add(input.name.toLowerCase())
        }
      }
      for (const name of collectionsAxis.shared ?? []) {
        const input = inputs.find((c) => same(c.name, name))
        if (!input) continue
        out.sources.push({ collection: input.name })
        placed.add(input.name.toLowerCase())
      }
    }
    if (namesAxis) {
      const from = axesSpec?.collections?.length ? inputs.filter((c) => axesSpec.collections!.some((n) => same(n, c.name))) : inputs.filter((c) => !placed.has(c.name.toLowerCase()) && (graph.variables ?? []).some((v) => v.collectionId === c.id && pathOf(v.name).some((seg) => namesAxis.values.some((val) => same(seg, val.label)))))
      for (const input of from) {
        if (!out.sources.some((s) => same(s.collection, input.name))) out.sources.push({ collection: input.name })
        placed.add(input.name.toLowerCase())
        for (const v of namesAxis.values) {
          if (v.base || v.sameAs) continue
          out.sources.push({ collection: input.name, group: v.label.toLowerCase(), to: '', at: { [namesAxis.attribute]: v.label } })
        }
      }
    }
    collections.push(out)
  } else if (themed.length > 0) {
    for (const c of themed) {
      const ownAxes: StructureAxis[] = axes.length > 0 ? axes : [{ attribute, nested: true, values: c.modes.map((m, n) => ({ label: m.name, ...(m.modeId === c.defaultModeId || (n === 0 && !c.defaultModeId) ? { base: true } : {}), ...(themeValue(m.name) ? { value: themeValue(m.name) } : {}) })) }]
      const source: StructureSource = { collection: c.name }
      if (axesSpec?.cells) {
        source.modes = {}
        for (const [cell, mode] of Object.entries(axesSpec.cells)) {
          const [outer, inner] = cell.split('|')
          const attrs = ownAxes.map((a) => a.attribute)
          source.modes[mode] = attrs.length === 2 ? { [attrs[0]]: outer, [attrs[1]]: inner } : { [attrs[0]]: inner ?? outer }
        }
      }
      collections.push({ name: c.name, axes: ownAxes, sources: [source] })
      placed.add(c.name.toLowerCase())
      if (themesNamed.length === 0 && axes.length === 0) {
        // Without a themes collection every multi-mode collection shared one theme list, so they
        // all read the same attribute: keep them on the first one's axis.
        axes.push(...ownAxes)
      }
    }
  }

  for (const c of inputs) {
    if (placed.has(c.name.toLowerCase())) continue
    const role = roleOf(c)
    // A hidden collection with the theme modes follows the themes — unless a themes collection
    // is named, when every other collection was read at its default mode.
    const themeAxis = axes.find((a) => a.nested) ?? axes[axes.length - 1]
    const followsThemes = themesNamed.length === 0 && c.modes.length > 1 && themeAxis && c.modes.every((m) => themeAxis.values.some((v) => same(v.label, m.name)))
    if (role === 'breakpoints') collections.push({ name: c.name, as: 'breakpoints', sources: [{ collection: c.name }] })
    else if (role === 'hidden') collections.push({ name: c.name, as: 'hidden', ...(followsThemes ? { axes: [themeAxis] } : {}), sources: [{ collection: c.name }] })
    else if (role === 'product') collections.push({ name: c.name, as: 'files', axes: [{ attribute: cleanAttr(c.name) || 'data-file', values: [{ label: c.name }] }, ...(c.modes.length > 1 ? [{ attribute, nested: true, values: c.modes.map((m) => ({ label: m.name, ...(m.modeId === c.defaultModeId ? { base: true } : {}) })) }] : [])], filesBy: cleanAttr(c.name) || 'data-file', sources: [{ collection: c.name, at: { [cleanAttr(c.name) || 'data-file']: c.name } }] })
    else collections.push({ name: c.name, ...(role && DOC_ROLES.has(role) ? { docRole: role } : {}), sources: [{ collection: c.name }] })
    placed.add(c.name.toLowerCase())
  }
  // Doc roles on collections placed by the rules above.
  for (const out of collections) {
    if (out.docRole) continue
    const role = out.sources.length === 1 ? roles[out.sources[0].collection.toLowerCase()] : undefined
    if (role && DOC_ROLES.has(role)) out.docRole = role
  }
  return { version: 1, collections }
}

/** The legacy fields a structure stands for, for readers that still take a string: DESIGN.md's
 * collection roles and the theme attribute the Django target switches on. */
export function deriveLegacy(structure: ExportStructure): { collectionRoles: string; themeAttribute: string } {
  const pairs: string[] = []
  for (const c of structure.collections) {
    const kind = c.as ?? 'tokens'
    if (kind === 'hidden') pairs.push(`${c.name}: hidden`)
    else if (kind === 'breakpoints') pairs.push(`${c.name}: breakpoints`)
    else if (kind === 'files') pairs.push(`${c.name}: product`)
    if (c.docRole) pairs.push(`${c.name}: ${c.docRole}`)
  }
  const axes = packageAxes(structure)
  const nested = axes.find((a) => a.nested) ?? axes[axes.length - 1]
  return { collectionRoles: pairs.join(', '), themeAttribute: nested?.attribute ?? 'data-theme-name' }
}
