/**
 * How a file's variables become code — the mapping the Tokens settings screen shows and edits.
 *
 * Designers think in Figma's terms: collections, the columns (modes) of each, the names of the
 * tokens. Code wants attributes it can switch on. The mapping declares those attributes — any
 * name: `data-product`, `data-theme`, `data-brand`, `data-density` — and binds every value of each
 * to something that exists in the file: collections, columns, or a marker in the token names.
 * Collections no attribute uses get a role of their own (a palette written into the tokens,
 * breakpoints, shipped as is, or left out).
 *
 * It is stored in the file (file-config.ts) in exactly this shape, so what a person reads on the
 * screen and what an agent writes through tokens.configure are the same words — a two-product
 * design system's export reads:
 *
 *   { "version": 1,
 *     "attributes": [
 *       { "name": "data-product", "from": "collections", "shared": ["Shared"], "values": [
 *           { "value": "one", "collections": ["One"], "base": true },
 *           { "value": "business", "collections": ["Business"] },
 *           { "value": "platform", "sameAs": "business" } ] },
 *       { "name": "data-theme", "from": "columns", "nested": true, "values": [
 *           { "value": "light", "columns": ["Light"] },
 *           { "value": "dark", "columns": ["Dark"] } ] } ],
 *     "collections": { "Colors": "palette", "Breakpoints": "breakpoints", "Product": "skip", "Sizes": "skip" } }
 *
 * The export does not read it directly: `mappingToSettings` turns it into the settings the engine
 * has always understood (collection roles and theme axes, theme-axes.ts), so a mapping ships
 * exactly the stylesheet those settings shipped. The engine combines at most two attributes, so
 * a mapping declares at most two.
 *
 * Pure module: no Figma APIs.
 */

import type { VariableSnapshot, CollectionEntry, VariableEntry } from '../variables'
import { parseCollectionModes, varName } from './engine.ts'
import { detectThemeAxes, normalizeThemeAxesSpec, type CollectionSummary, type ThemeAxesSpec, type ThemeAxisSpec, type ThemeAxisValue } from './theme-axes.ts'

/**
 * Where an attribute's values come from — and so which Figma plan a layout fits:
 * - `columns`: modes of a collection (`Light`, `Dark`) — Professional allows 10 per collection,
 *   Organization 20, Enterprise any number;
 * - `collections`: a collection per value (`One`, `Business`), or several (`One Light`,
 *   `One Dark`) — the free plan's way, with one column per collection, and the way past a plan's
 *   column limit; an Enterprise extended collection is a value on top of its parent's;
 * - `names`: a marker segment in the token names (`dark/bg/base`) — themes kept in one
 *   single-column collection; tokens with no marker hold for every value.
 */
export type AttributeSource = 'collections' | 'columns' | 'names'

export const ATTRIBUTE_SOURCES: readonly AttributeSource[] = ['collections', 'columns', 'names']

export interface AttributeValue {
  /** What the attribute says in code: `data-product="one"`. */
  value: string
  /** `collections`: the collections holding this value's tokens. */
  collections?: string[]
  /** `columns`: the columns (mode names) that are this value. */
  columns?: string[]
  /** `names`: the name segment marking this value's tokens — the value itself when omitted. */
  marker?: string
  /** The value every other one starts from: a token another value lacks is this one's. */
  base?: boolean
  /** Another value of the same attribute this one shows, for a value with no tokens yet. */
  sameAs?: string
}

export interface MappedAttribute {
  /** The attribute in code: `data-product`. */
  name: string
  from: AttributeSource
  /** `columns` with no attribute taking collections or names: the one collection whose columns
   * these are. `names`: the collections whose token names carry the markers (any that do, when
   * omitted). */
  collections?: string[]
  values: AttributeValue[]
  /** `collections`: collections every value gets (a `Shared` collection). */
  shared?: string[]
  /** May be set again inside the page — a dark card in a light page. One attribute at most. */
  nested?: boolean
}

/** What a collection no attribute uses is. */
export type CollectionRole = 'palette' | 'breakpoints' | 'export' | 'skip'

export const COLLECTION_ROLES: readonly CollectionRole[] = ['export', 'palette', 'skip', 'breakpoints']

/** What each role is called on the screen — and in this module's answers to an agent. The words
 * are Tokens Studio's set statuses: enabled, source ("values only": resolved into the tokens that
 * use them, never shipped as their own), disabled. */
export const ROLE_LABELS: Readonly<Record<CollectionRole, string>> = {
  export: 'Export',
  palette: 'Values only',
  skip: 'Off',
  breakpoints: 'Breakpoints (--bp-*)',
}

export interface TokenMapping {
  version: 1
  /** The attributes code switches on — none, one or two. */
  attributes: MappedAttribute[]
  /** Collections no attribute uses, by name. One not named here is exported as is. */
  collections?: Record<string, CollectionRole>
}

/** A label as a value in code: `Business Light` → `business-light`. */
export function codeValue(label: string): string {
  return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const cleanAttribute = (raw: unknown) => String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '')
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const strings = (raw: unknown): string[] =>
  typeof raw === 'string' && raw.trim() ? [raw.trim()] : Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))] : []

/** The collections the attributes name — the ones whose role the attributes decide. */
export function collectionsUsedBy(mapping: TokenMapping): Set<string> {
  const used = new Set<string>()
  for (const attribute of mapping.attributes) {
    for (const v of attribute.values) for (const name of v.collections ?? []) used.add(name)
    for (const name of [...(attribute.shared ?? []), ...(attribute.collections ?? [])]) used.add(name)
  }
  return used
}

/* --------------------------------------------------------------------------- validation */

/**
 * The mapping as stored, checked. Values are slugged (`One` → `one`), a missing base becomes the
 * first value with tokens of its own, and everything that cannot be shipped is a problem rather
 * than a guess — the rule for every pinned setting: a typo in a contract is worse than no
 * contract. `collection: "One"` is read as `collections: ["One"]`, the way a person writes it.
 */
export function normalizeMapping(raw: unknown): { mapping: TokenMapping | null; problems: string[] } {
  const problems: string[] = []
  if (raw === undefined || raw === null) return { mapping: null, problems }
  if (!isRecord(raw)) return { mapping: null, problems: ['the mapping must be an object'] }
  if (raw.version !== undefined && raw.version !== 1) problems.push(`mapping version ${String(raw.version)} is not one this plugin reads (1)`)
  if (raw.attributes !== undefined && !Array.isArray(raw.attributes)) return { mapping: null, problems: [...problems, '"attributes" must be a list'] }

  const attributes: MappedAttribute[] = []
  for (const [n, entry] of ((raw.attributes as unknown[] | undefined) ?? []).entries()) {
    if (!isRecord(entry)) {
      problems.push(`attribute ${n + 1} must be an object`)
      continue
    }
    const name = cleanAttribute(entry.name)
    const label = name || `attribute ${n + 1}`
    if (!name) problems.push(`${label} needs a name in code (data-theme, data-product…)`)
    if (!ATTRIBUTE_SOURCES.includes(entry.from as AttributeSource)) {
      problems.push(`${label}: "from" must be one of ${ATTRIBUTE_SOURCES.join(', ')}`)
      continue
    }
    const from = entry.from as AttributeSource
    const values: AttributeValue[] = []
    for (const rawValue of Array.isArray(entry.values) ? entry.values : []) {
      if (!isRecord(rawValue)) continue
      const value = codeValue(typeof rawValue.value === 'string' ? rawValue.value : '')
      if (!value) {
        problems.push(`${label}: every value needs a name in code`)
        continue
      }
      const out: AttributeValue = { value }
      if (typeof rawValue.sameAs === 'string' && codeValue(rawValue.sameAs)) {
        out.sameAs = codeValue(rawValue.sameAs)
      } else if (from === 'collections') {
        const collections = strings(rawValue.collections ?? rawValue.collection)
        if (collections.length > 0) out.collections = collections
        else problems.push(`${label} = ${value}: say which collection holds it, or which value it is the same as`)
      } else if (from === 'columns') {
        const columns = strings(rawValue.columns ?? rawValue.column)
        if (columns.length > 0) out.columns = columns
        else problems.push(`${label} = ${value}: say which columns it is, or which value it is the same as`)
      } else if (typeof rawValue.marker === 'string' && rawValue.marker.trim() && codeValue(rawValue.marker) !== value) {
        out.marker = rawValue.marker.trim()
      }
      if (rawValue.base === true && !out.sameAs) out.base = true
      values.push(out)
    }
    if (values.length === 0) problems.push(`${label} has no values`)
    const twice = values.map((v) => v.value).filter((v, i, all) => all.indexOf(v) !== i)
    if (twice.length > 0) problems.push(`${label} has the value "${twice[0]}" twice`)
    for (const v of values) {
      if (!v.sameAs) continue
      const target = values.find((t) => t.value === v.sameAs)
      if (!target || target.sameAs) problems.push(`${label} = ${v.value} is the same as "${v.sameAs}", which is not a value with tokens of its own`)
    }
    const held = values.filter((v) => !v.sameAs)
    const bases = held.filter((v) => v.base)
    if (bases.length > 1) problems.push(`${label}: one base value, not ${bases.length}`)
    if (held.length > 0 && bases.length === 0) held[0].base = true
    const attribute: MappedAttribute = { name, from, values }
    const collections = strings(entry.collections ?? entry.collection)
    if (from !== 'collections' && collections.length > 0) attribute.collections = collections
    const shared = strings(entry.shared)
    if (from === 'collections' && shared.length > 0) attribute.shared = shared
    if (entry.nested === true) attribute.nested = true
    attributes.push(attribute)
  }

  if (attributes.length > 2) problems.push(`the export combines two attributes at most, not ${attributes.length}`)
  const names = attributes.map((a) => a.name).filter(Boolean)
  if (new Set(names).size !== names.length) problems.push('two attributes have the same name')
  if (attributes.filter((a) => a.nested).length > 1) problems.push('only one attribute can be set again inside the page')
  const columnsOnly = attributes.length > 0 && attributes.every((a) => a.from === 'columns')
  if (columnsOnly) {
    const holders = [...new Set(attributes.flatMap((a) => a.collections ?? []))]
    if (holders.length === 0) problems.push(`say which collection's columns ${attributes.map((a) => a.name).join(' and ')} come from`)
    if (holders.length > 1) problems.push(`the columns come from one collection, not ${holders.join(' and ')}`)
    if (attributes.length === 1 && attributes[0].values.some((v) => (v.columns?.length ?? 0) > 1)) problems.push(`${attributes[0].name}: each value is one column`)
  } else {
    // Beside collections or names, a column value is found by its name in every collection.
    for (const a of attributes.filter((x) => x.from === 'columns')) {
      if (a.values.some((v) => (v.columns?.length ?? 0) > 1)) problems.push(`${a.name}: each value is one column name, found in every collection that has it`)
    }
  }
  if (attributes.some((a) => a.from === 'names') && attributes.some((a) => a.from === 'collections') && attributes.some((a) => a.from === 'names' && a.collections?.length)) {
    problems.push('with an attribute taken from collections, the marked names are read in those collections — drop "collections" from the names attribute')
  }

  const collections: Record<string, CollectionRole> = {}
  if (isRecord(raw.collections)) {
    for (const [name, role] of Object.entries(raw.collections)) {
      if (typeof role === 'string' && COLLECTION_ROLES.includes(role as CollectionRole)) collections[name] = role as CollectionRole
      else problems.push(`"${name}": the role must be one of ${COLLECTION_ROLES.join(', ')}`)
    }
  }
  const mapping: TokenMapping = { version: 1, attributes }
  // A collection an attribute uses is that attribute's: a role beside it would be a second answer.
  const used = collectionsUsedBy(mapping)
  for (const name of Object.keys(collections)) if (used.has(name)) delete collections[name]
  if (Object.keys(collections).length > 0) mapping.collections = collections
  return { mapping, problems }
}

/**
 * What a well-formed mapping names that this file does not hold: a collection renamed or deleted
 * since, or a column its collections never had. `normalizeMapping` cannot see the file; this is
 * the check a save has to pass, so a mapping pointing at nothing (a theme read off "Light"
 * and "Dark" columns of a collection whose columns are "One Light" … "Platform Dark") is refused
 * instead of quietly exporting every collection as it stands.
 */
export function mappingFileProblems(snapshot: VariableSnapshot, mapping: TokenMapping): string[] {
  const own = snapshot.collections.filter((c) => !c.inlineOnly)
  const byName = new Map(own.map((c) => [c.name, c]))
  const problems: string[] = []
  const absent = [...collectionsUsedBy(mapping), ...Object.keys(mapping.collections ?? {})].filter((name, i, all) => all.indexOf(name) === i && !byName.has(name))
  if (absent.length > 0) problems.push(`the file has no collection ${absent.map((n) => `"${n}"`).join(', ')}`)
  for (const attribute of mapping.attributes) {
    if (attribute.from !== 'columns') continue
    // Where the columns live: the attribute's own collections, else the ones the other attribute
    // reads (One and Business hold Light and Dark), else any collection of the file.
    const others = mapping.attributes.filter((a) => a !== attribute).flatMap((a) => [...a.values.flatMap((v) => v.collections ?? []), ...(a.shared ?? []), ...(a.collections ?? [])])
    const scope = (attribute.collections?.length ? attribute.collections : others.length ? others : own.map((c) => c.name)).map((name) => byName.get(name)).filter((c): c is NonNullable<typeof c> => !!c)
    if (scope.length === 0) continue
    const have = new Set(scope.flatMap((c) => c.modes.map((m) => m.name)))
    const lacking = attribute.values.flatMap((v) => v.columns ?? []).filter((column, i, all) => all.indexOf(column) === i && !have.has(column))
    if (lacking.length > 0) {
      problems.push(`${attribute.name}: ${scope.map((c) => c.name).join(', ')} ${scope.length === 1 ? 'has' : 'have'} no column ${lacking.map((n) => `"${n}"`).join(', ')}`)
    }
  }
  return problems
}

/* ---------------------------------------------------------------- mapping → engine */

export interface MappedSettings {
  collectionRoles: string
  themeAxes: ThemeAxesSpec | ''
  themeAttribute: string
  slugThemes: true
}

/** The settings the export engine reads, from a mapping. Every layout a mapping can declare is
 * one the engine already ships (theme-axes.ts `foldThemeSources`): collections, columns and
 * marked names in any combination of two, or both attributes read off one collection's columns. */
export function mappingToSettings(mapping: TokenMapping): MappedSettings {
  const roles: string[] = []
  for (const [name, role] of Object.entries(mapping.collections ?? {})) {
    if (role === 'palette' || role === 'skip') roles.push(`${name}: hidden`)
    else if (role === 'breakpoints') roles.push(`${name}: breakpoints`)
  }
  const attributes = mapping.attributes
  let themeAxes: ThemeAxesSpec | '' = ''

  /** The word the engine finds a value by: its column, its marker, its one collection. */
  const labelOf = (a: MappedAttribute, v: AttributeValue): string => {
    if (v.sameAs) return v.value
    if (a.from === 'columns') return v.columns?.[0] ?? v.value
    if (a.from === 'names') return v.marker ?? v.value
    return v.collections?.length === 1 ? v.collections[0] : v.value
  }
  const axisOf = (a: MappedAttribute, label: (v: AttributeValue) => string): ThemeAxisSpec => ({
    attribute: a.name,
    ...(a.from === 'columns' ? {} : { source: a.from }),
    ...(a.nested ? { nested: true } : {}),
    values: a.values.map((v): ThemeAxisValue => {
      const target = v.sameAs ? a.values.find((t) => t.value === v.sameAs) : undefined
      return {
        label: label(v),
        value: v.value,
        ...(a.from === 'collections' && v.collections ? { collections: v.collections } : {}),
        ...(v.base ? { base: true } : {}),
        ...(target ? { sameAs: label(target) } : {}),
      }
    }),
    ...(a.from === 'collections' && a.shared && a.shared.length > 0 ? { shared: a.shared } : {}),
  })

  if (attributes.length > 0 && attributes.every((a) => a.from === 'columns')) {
    const holder = attributes.flatMap((a) => a.collections ?? [])[0]
    if (holder) roles.push(`${holder}: themes`)
    if (attributes.length === 1) {
      themeAxes = { axes: [axisOf(attributes[0], (v) => labelOf(attributes[0], v))] }
    } else {
      // Two attributes over one collection's columns: a cell is the column both values name.
      const [outer, inner] = attributes
      const cells: Record<string, string> = {}
      for (const a of outer.values) for (const b of inner.values) {
        const column = (a.columns ?? []).find((c) => (b.columns ?? []).includes(c))
        if (column) cells[`${a.value}|${b.value}`] = column
      }
      themeAxes = { axes: [axisOf(outer, (v) => v.value), axisOf(inner, (v) => v.value)], cells }
    }
  } else if (attributes.length > 0) {
    const markedIn = attributes.find((a) => a.from === 'names' && a.collections?.length)?.collections
    themeAxes = {
      axes: attributes.map((a) => axisOf(a, (v) => labelOf(a, v))),
      ...(markedIn && !attributes.some((a) => a.from === 'collections') ? { collections: markedIn } : {}),
    }
  }
  return { collectionRoles: roles.join(', '), themeAxes, themeAttribute: attributes[attributes.length - 1]?.name || 'data-theme', slugThemes: true }
}

/* ---------------------------------------------------- the file's own setup, as a mapping */

/** A collection is a palette when every value in it is a literal and other collections alias it. */
function palettes(snapshot: VariableSnapshot): Set<string> {
  const collectionOf = new Map(snapshot.variables.map((v) => [v.id, v.collectionId]))
  const aliased = new Set<string>()
  const hasAlias = new Set<string>()
  for (const v of snapshot.variables) {
    for (const value of Object.values(v.valuesByMode)) {
      if (isAlias(value)) {
        hasAlias.add(v.collectionId)
        const target = collectionOf.get(value.id)
        if (target && target !== v.collectionId) aliased.add(target)
      }
    }
  }
  return new Set(snapshot.collections.filter((c) => aliased.has(c.id) && !hasAlias.has(c.id)).map((c) => c.name))
}

function isAlias(value: unknown): value is { type: 'VARIABLE_ALIAS'; id: string } {
  return isRecord(value) && value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string'
}

const wordsOf = (name: string) => name.split(/[\s_\-–—/()]+/).filter((w) => w !== '').map((w) => w.toLowerCase())
const holdsWords = (name: string, label: string) => {
  const words = wordsOf(name)
  const wanted = wordsOf(label)
  return wanted.length > 0 && wanted.every((w) => words.includes(w))
}
const valueOf = (v: ThemeAxisValue) => (v.value ? codeValue(v.value) : codeValue(v.label))

/**
 * The older settings (collection roles + theme axes) read as a mapping, so a file set up before
 * the mapping existed opens on the screen as it exports. Null when the settings say nothing
 * about themes, or something the file does not hold.
 */
export function mappingFromSettings(
  settings: { collectionRoles?: string; themeAxes?: unknown; themeAttribute?: string },
  snapshot: VariableSnapshot
): TokenMapping | null {
  const roles = parseCollectionModes(settings.collectionRoles)
  const spec = normalizeThemeAxesSpec(settings.themeAxes).spec
  const palette = palettes(snapshot)
  const own = snapshot.collections.filter((c) => !c.inlineOnly)
  const collections: Record<string, CollectionRole> = {}
  for (const c of own) {
    if (roles.hidden.some((n) => same(n, c.name))) collections[c.name] = palette.has(c.name) ? 'palette' : 'skip'
    else if (roles.breakpoints.some((n) => same(n, c.name))) collections[c.name] = 'breakpoints'
  }
  const byName = (name: string) => own.find((c) => same(c.name, name))
  const axes = (spec?.axes ?? []).slice(0, 2)
  const sameAsOf = (axis: ThemeAxisSpec, v: ThemeAxisValue) => {
    const target = axis.values.find((t) => same(t.label, v.sameAs!))
    return target ? valueOf(target) : codeValue(v.sameAs!)
  }
  const finish = (attributes: MappedAttribute[]) => {
    const normalized = normalizeMapping({ version: 1, attributes, collections })
    return normalized.problems.length === 0 ? normalized.mapping : null
  }

  if (axes.some((a) => a.source === 'collections' || a.source === 'names')) {
    const attributes: MappedAttribute[] = []
    for (const axis of axes) {
      const values: AttributeValue[] = []
      for (const v of axis.values) {
        if (v.sameAs) {
          values.push({ value: valueOf(v), sameAs: sameAsOf(axis, v) })
          continue
        }
        const base = v.base ? { base: true } : {}
        if (axis.source === 'collections') {
          const named = (v.collections ?? []).map(byName).filter(Boolean) as CollectionEntry[]
          const found = named.length > 0 ? named : own.filter((c) => holdsWords(c.name, v.label))
          if (found.length === 0) return null
          values.push({ value: valueOf(v), collections: found.map((c) => c.name), ...base })
        } else if (axis.source === 'names') {
          values.push({ value: valueOf(v), ...(codeValue(v.label) !== valueOf(v) ? { marker: v.label } : {}), ...base })
        } else {
          values.push({ value: valueOf(v), columns: [v.label], ...base })
        }
      }
      const shared = (axis.shared ?? []).map(byName).filter(Boolean).map((c) => c!.name)
      const markedIn = axis.source === 'names' ? (spec?.collections ?? []).map(byName).filter(Boolean).map((c) => c!.name) : []
      attributes.push({
        name: axis.attribute,
        from: axis.source === 'collections' ? 'collections' : axis.source === 'names' ? 'names' : 'columns',
        ...(axis.nested ? { nested: true } : {}),
        values,
        ...(shared.length > 0 ? { shared } : {}),
        ...(markedIn.length > 0 ? { collections: markedIn } : {}),
      })
    }
    return finish(attributes)
  }

  const holder = roles.themes.map(byName).find(Boolean)
  if (!holder) return null
  const modes = holder.modes.map((m) => m.name)
  if (axes.length === 0) {
    return finish([{ name: settings.themeAttribute || 'data-theme-name', from: 'columns', collections: [holder.name], values: modes.map((m) => ({ value: codeValue(m), columns: [m] })) }])
  }
  /** The columns an axis value covers: those a hand-placed cell names, else those spelling it. */
  const columnsOf = (part: number, v: ThemeAxisValue) =>
    modes.filter((mode) => {
      const cell = Object.entries(spec?.cells ?? {}).find(([, m]) => same(m, mode))
      if (cell && axes.length >= 2) return same(cell[0].split('|')[part] ?? '', v.label)
      return same(mode, v.label) || holdsWords(mode, v.label)
    })
  const nestedAt = axes.findIndex((a) => a.nested)
  return finish(
    axes.map((axis, part): MappedAttribute => ({
      name: axis.attribute,
      from: 'columns',
      collections: [holder.name],
      ...(part === (nestedAt === -1 ? axes.length - 1 : nestedAt) && axes.length >= 2 ? { nested: true } : {}),
      values: axis.values.map((v) => (v.sameAs ? { value: valueOf(v), sameAs: sameAsOf(axis, v) } : { value: valueOf(v), columns: columnsOf(part, v) })),
    }))
  )
}

/**
 * A starting mapping read off the file, for a file nobody has mapped: the theme layout the
 * engine's own detector finds — whatever the plan made of it: products as collections beside
 * theme columns, one-column collections per cell, themes marked in names, one collection's
 * columns — palettes and breakpoints by what they hold and are called, and a second copy of the
 * themed tokens (a merged collection beside the ones it was merged from) left out, so the first
 * export is not every token twice. A two-product design system reads as its two attributes.
 */
export function suggestMapping(snapshot: VariableSnapshot): TokenMapping {
  const own = snapshot.collections.filter((c) => !c.inlineOnly)
  const summaries: CollectionSummary[] = own.map((c) => ({
    name: c.name,
    modes: c.modes.map((m) => m.name),
    variables: count(snapshot, c),
    names: snapshot.variables.filter((v) => v.collectionId === c.id).map((v) => v.name),
  }))
  const palette = palettes(snapshot)
  const roles: string[] = []
  for (const c of own) {
    if (/breakpoint/i.test(c.name)) roles.push(`${c.name}: breakpoints`)
    else if (palette.has(c.name)) roles.push(`${c.name}: hidden`)
  }
  const detected = detectThemeAxes(summaries)
  let mapping: TokenMapping | null = null
  if (detected) {
    const fromModesOnly = detected.spec.axes.every((a) => (a.source ?? 'modes') === 'modes')
    const grid = fromModesOnly ? own.filter((c) => c.modes.length >= 2).find((c) => detected.spec.axes.every((axis) => axis.values.every((v) => c.modes.some((m) => holdsWords(m.name, v.label))))) : undefined
    mapping = mappingFromSettings({ collectionRoles: [...roles, ...(grid ? [`${grid.name}: themes`] : [])].join(', '), themeAxes: detected.spec }, snapshot)
  }
  if (!mapping) {
    const multi = [...own].filter((c) => c.modes.length >= 2 && !/breakpoint/i.test(c.name)).sort((a, b) => count(snapshot, b) - count(snapshot, a))[0]
    mapping = (multi ? mappingFromSettings({ collectionRoles: [...roles, `${multi.name}: themes`].join(', '), themeAxes: '', themeAttribute: 'data-theme' }, snapshot) : null)
      ?? normalizeMapping({ version: 1, attributes: [], collections: Object.fromEntries(own.filter((c) => palette.has(c.name) || /breakpoint/i.test(c.name)).map((c) => [c.name, palette.has(c.name) ? 'palette' : 'breakpoints'])) }).mapping!
  }
  // A collection no attribute uses that repeats names the themed tokens already have would ship
  // them twice, under one name or beside it: a merged copy (Product beside One and Business), or
  // a legacy scale whose `spacing/xs` is 4 where the products' is 8 (Sizes). Left out.
  const used = collectionsUsedBy(mapping)
  const themedNames = new Set(snapshot.variables.filter((v) => used.has(snapshot.collections.find((c) => c.id === v.collectionId)?.name ?? '')).map((v) => v.name))
  for (const c of own) {
    if (used.has(c.name) || mapping.collections?.[c.name] || themedNames.size === 0) continue
    if (snapshot.variables.some((v) => v.collectionId === c.id && themedNames.has(v.name))) mapping.collections = { ...(mapping.collections ?? {}), [c.name]: 'skip' }
  }
  return mapping
}

const count = (snapshot: VariableSnapshot, c: CollectionEntry) => snapshot.variables.filter((v) => v.collectionId === c.id).length

/* -------------------------------------------------------------------- what the screen draws */

export interface MappingCell {
  /** What Figma shows in the cell: the token it points at, or the value. */
  text: string
  /** The colour it resolves to, for a swatch. */
  color?: string
}

export interface MappingRow {
  name: string
  /** The custom property it ships as. */
  code: string
  cells: MappingCell[]
  /** In a collection on top of a base one: how this token relates to the base collection's. */
  status?: 'override' | 'same' | 'base'
}

export interface MappingCollectionView {
  name: string
  tokens: number
  modes: string[]
  /** `attribute` when an attribute uses it; else its role. */
  role: CollectionRole | 'attribute'
  /** What it is in code, in a few words: `data-product = business · on top of One`. */
  line: string
}

export interface MappingView {
  collections: MappingCollectionView[]
  /** Collections the mapping names that the file does not have (renamed or deleted since). */
  missing: string[]
  /** How the file keeps its themes, which is what the plan allowed: the most columns any
   * collection has. 1 everywhere is the free plan's shape (or a file kept that way). */
  maxColumns: number
  /** Columns of a collection whose columns ARE the values that no value takes — the engine
   * ships every column of such a collection, so each needs a value (`Product / One Dark`). */
  unbound: string[]
  /** The segments the file's token names are made of, most used first — what a `names`
   * attribute's marker can be, offered as a choice rather than typed (`dark` in `dark/bg/base`). */
  markers: Array<{ segment: string; tokens: number }>
  table?: {
    collection: string
    /** Each column, with the attribute values it is in code. */
    columns: Array<{ mode: string; bindings: Array<{ attribute: string; value: string }> }>
    rows: MappingRow[]
    /** Rows not sent, past the limit. */
    more: number
    /** The collection this one is layered on: it holds a value of the first attribute taken from
     * collections, and the base value is another collection. */
    base?: string
  }
}

/** `resolve`: variables the file reaches only through aliases (deleted ones keep their ids,
 * library ones are read by id) — used to show what a cell resolves to, never counted or listed as
 * the file's own. */
export function describeMapping(snapshot: VariableSnapshot, mapping: TokenMapping, options: { collection?: string; limit?: number; resolve?: VariableSnapshot } = {}): MappingView {
  const own = snapshot.collections.filter((c) => !c.inlineOnly)
  const layered = mapping.attributes.find((a) => a.from === 'collections')
  const baseValue = layered?.values.find((v) => v.base)
  const baseName = baseValue?.collections?.length === 1 ? baseValue.collections[0] : undefined
  const lineOf = (name: string): { role: MappingCollectionView['role']; line: string } => {
    const parts: string[] = []
    for (const a of mapping.attributes) {
      if (a.from === 'collections') {
        const v = a.values.find((x) => x.collections?.includes(name))
        if (v) parts.push(`${a.name} = ${v.value}${a === layered ? (v.base ? ' · base' : baseName && baseName !== name ? ` · on top of ${baseName}` : '') : ''}`)
        else if (a.shared?.includes(name)) parts.push(`in every ${a.name}`)
      } else if (a.from === 'columns' && a.collections?.includes(name)) {
        parts.push(`${a.name} in its columns`)
      } else if (a.from === 'names' && a.collections?.includes(name)) {
        parts.push(`${a.name} marked in its names`)
      }
    }
    if (parts.length > 0) return { role: 'attribute', line: parts.join(' · ') }
    const role = mapping.collections?.[name] ?? 'export'
    return { role, line: ROLE_LABELS[role] }
  }
  const view: MappingView = {
    collections: own.map((c) => ({ name: c.name, tokens: count(snapshot, c), modes: c.modes.map((m) => m.name), ...lineOf(c.name) })),
    missing: [...collectionsUsedBy(mapping), ...Object.keys(mapping.collections ?? {})].filter((name, i, all) => all.indexOf(name) === i && !own.some((c) => c.name === name)),
    maxColumns: Math.max(0, ...own.map((c) => c.modes.length)),
    unbound: [],
    markers: markersOf(snapshot, own),
  }
  if (mapping.attributes.length > 0 && mapping.attributes.every((a) => a.from === 'columns')) {
    const holder = own.find((c) => mapping.attributes.some((a) => a.collections?.includes(c.name)))
    for (const m of holder?.modes ?? []) {
      if (mapping.attributes.some((a) => !a.values.some((v) => v.columns?.includes(m.name)))) view.unbound.push(`${holder!.name} / ${m.name}`)
    }
  }

  const selected = own.find((c) => c.name === options.collection)
  if (!selected) return view
  const limit = Math.max(1, options.limit ?? 300)
  const byId = new Map([...(options.resolve?.variables ?? []), ...snapshot.variables].map((v) => [v.id, v]))
  const collectionById = new Map([...(options.resolve?.collections ?? []), ...snapshot.collections].map((c) => [c.id, c]))
  const varsOf = (c: CollectionEntry) => snapshot.variables.filter((v) => v.collectionId === c.id)

  /** The final value of `v` in the column called `mode`; an alias into another collection reads
   * that collection's column of the same name, else its default — how the export resolves it. */
  const resolve = (v: VariableEntry, mode: string, depth = 0): unknown => {
    const c = collectionById.get(v.collectionId)
    const m = c?.modes.find((x) => x.name === mode) ?? c?.modes.find((x) => x.modeId === c.defaultModeId)
    const value = m ? v.valuesByMode[m.modeId] : undefined
    if (isAlias(value)) {
      const target = byId.get(value.id)
      return target && depth < 16 ? resolve(target, mode, depth + 1) : undefined
    }
    return value
  }
  const cellOf = (v: VariableEntry, mode: string): MappingCell => {
    const c = collectionById.get(v.collectionId)
    const m = c?.modes.find((x) => x.name === mode) ?? c?.modes.find((x) => x.modeId === c.defaultModeId)
    const value = m ? v.valuesByMode[m.modeId] : undefined
    const final = resolve(v, mode)
    const color = colorOf(final)
    if (isAlias(value)) return { text: byId.get(value.id)?.name ?? 'missing token', ...(color ? { color } : {}) }
    return { text: color ?? (final === undefined ? '—' : String(final)), ...(color ? { color } : {}) }
  }
  const fingerprint = (v: VariableEntry, mode: string) => JSON.stringify(resolve(v, mode) ?? null)

  const modes = selected.modes.map((m) => m.name)
  const onTop = layered?.values.some((v) => !v.base && v.collections?.includes(selected.name)) && baseName && baseName !== selected.name
  const base = onTop ? own.find((c) => c.name === baseName) : undefined
  const baseByName = new Map(base ? varsOf(base).map((v) => [v.name, v]) : [])
  const rows: MappingRow[] = []
  for (const v of varsOf(selected)) {
    const twin = baseByName.get(v.name)
    const status = base ? (twin && modes.every((mode) => fingerprint(v, mode) === fingerprint(twin, mode)) ? 'same' : 'override') : undefined
    rows.push({ name: v.name, code: `--${varName(v.name.split('/'))}`, cells: modes.map((mode) => cellOf(v, mode)), ...(status ? { status } : {}) })
  }
  if (base) {
    const mine = new Set(varsOf(selected).map((v) => v.name))
    for (const v of varsOf(base)) if (!mine.has(v.name)) rows.push({ name: v.name, code: `--${varName(v.name.split('/'))}`, cells: modes.map((mode) => cellOf(v, mode)), status: 'base' })
  }
  const used = collectionsUsedBy(mapping)
  const columnsHere = (a: MappedAttribute) => a.from === 'columns' && (a.collections?.length ? a.collections.includes(selected.name) : used.has(selected.name))
  view.table = {
    collection: selected.name,
    columns: modes.map((mode) => ({
      mode,
      bindings: mapping.attributes.filter(columnsHere).flatMap((a) => a.values.filter((v) => v.columns?.includes(mode)).map((v) => ({ attribute: a.name, value: v.value }))),
    })),
    rows: rows.slice(0, limit),
    more: Math.max(0, rows.length - limit),
    ...(base ? { base: base.name } : {}),
  }
  return view
}

/** Every segment of every token name in these collections, with how many tokens carry it — the
 * leaf (`base` in `background/base`) is the token itself, not a marker, so only the segments
 * before it count. Most used first, capped: a marker is a segment many tokens share. */
function markersOf(snapshot: VariableSnapshot, collections: readonly CollectionEntry[], limit = 80): Array<{ segment: string; tokens: number }> {
  const ids = new Set(collections.map((c) => c.id))
  const counts = new Map<string, number>()
  for (const v of snapshot.variables) {
    if (!ids.has(v.collectionId)) continue
    for (const segment of new Set(v.name.split('/').slice(0, -1).map((x) => x.trim()).filter(Boolean))) counts.set(segment, (counts.get(segment) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([segment, tokens]) => ({ segment, tokens }))
}

function colorOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.r !== 'number' || typeof value.g !== 'number' || typeof value.b !== 'number') return undefined
  const hex = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')
  const a = typeof value.a === 'number' ? value.a : 1
  return `#${hex(value.r)}${hex(value.g)}${hex(value.b)}${a < 1 ? hex(a) : ''}`
}
