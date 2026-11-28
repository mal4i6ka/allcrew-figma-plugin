/**
 * How a file's themes become attributes — the spec behind the panel's theme axes picker.
 *
 * A theme is whatever the export reads as one mode of the tokens. Two layouts reach the same
 * grid of product × theme:
 *
 * - **Modes.** One collection whose modes ARE the grid (`One Light`, `Business Dark`). An axis
 *   value is a word in those names; a cell the names do not spell can be set by hand (`cells`),
 *   and a cell no mode fills can show another one (`sameAs`).
 * - **Collections.** A collection per product, each with the theme modes (a design system's One and
 *   Business, both Light/Dark). The product axis lists the collections; `foldThemeSources`
 *   merges them at export time into one collection whose modes are the grid, the way
 *   `collections.merge` would in Figma — but on every export, so a merged copy can never go stale.
 *
 * Pure module: no Figma APIs, and no runtime import of the engine (which imports this).
 */

import type { TokenGraph, TokenGraphCollection, TokenGraphVariable } from './engine.ts'

export interface ThemeAxisValue {
  /** The word that names this value — in the mode names, the collection names or the variable
   * names, depending on the axis's source. */
  label: string
  /** What the attribute says; the label's slug when omitted. */
  value?: string
  /** The value every other one inherits a missing token from. The first when none is marked. */
  base?: boolean
  /** Shows another value of the same axis in every cell — Platform before it has a palette. */
  sameAs?: string
  /** Collections axis: the collections that hold this value, when their names do not contain
   * the label (`Colors` is Light beside `Colors Dark`). */
  collections?: string[]
}

export interface ThemeAxisSpec {
  attribute: string
  /** May be set again on any subtree (a dark card in a light page). One axis at most. */
  nested?: boolean
  /**
   * Where the values come from:
   * - `modes` (default): a word in the mode names — a paid plan's way (Professional: up to 10
   *   modes per collection, Organization: 20).
   * - `collections`: a word in the collection names, one collection per value — the free plan's
   *   way, where a collection has one mode, and the way to go past a plan's mode limit.
   * - `names`: a segment of the variable names (`dark/bg/base` is `bg/base` in Dark) — themes
   *   kept in one single-mode collection. A variable with no such segment holds for every value.
   */
  source?: 'modes' | 'collections' | 'names'
  values: ThemeAxisValue[]
  /** Collections axis: collections that belong to no value (a `Shared` collection) — every value
   * gets their tokens. */
  shared?: string[]
}

export interface ThemeAxesSpec {
  axes: ThemeAxisSpec[]
  /** The collections themes are read from when no axis takes collections — the ones whose
   * variable names carry a `names` axis's markers, when omitted. */
  collections?: string[]
  /** `outer label|inner label` → mode name, for names that do not spell their cell. */
  cells?: Record<string, string>
  /** `outer label|inner label` → another cell, for a cell no mode fills. */
  sameAs?: Record<string, string>
}

/** One axis of the string form: `data-product: One, Business`. */
export interface ThemeAxis {
  attribute: string
  values: string[]
}

/**
 * The string form of the setting: `data-product: One, Business, Platform; data-theme: Light, Dark`.
 * Axes are separated by `;` or a new line, values by `,`. The last axis is the nested one.
 */
export function parseThemeAxes(raw: string | undefined): ThemeAxis[] {
  const axes: ThemeAxis[] = []
  for (const part of String(raw ?? '').split(/[;\n]+/)) {
    const separator = part.search(/[:=]/)
    if (separator === -1) continue
    const attribute = cleanAttribute(part.slice(0, separator))
    const values = part
      .slice(separator + 1)
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '')
    if (attribute && values.length > 0) axes.push({ attribute, values })
  }
  return axes
}

function cleanAttribute(raw: string): string {
  return String(raw).trim().replace(/[^A-Za-z0-9_-]/g, '')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The setting in either form — the string a person types, or the object the picker writes — as
 * one spec, with what was wrong in it. `null` when it says nothing: one attribute per mode, the
 * plugin's behaviour before axes.
 */
export function normalizeThemeAxesSpec(raw: unknown): { spec: ThemeAxesSpec | null; problems: string[] } {
  const problems: string[] = []
  if (raw === undefined || raw === null || raw === '') return { spec: null, problems }
  if (typeof raw === 'string') {
    const axes = parseThemeAxes(raw)
    if (axes.length === 0) return { spec: null, problems: raw.trim() ? ['theme axes read as "attribute: value, value; …" — nothing parsed'] : [] }
    return {
      spec: { axes: axes.map((axis, i) => ({ attribute: axis.attribute, ...(i === axes.length - 1 ? { nested: true } : {}), values: axis.values.map((label) => ({ label })) })) },
      problems,
    }
  }
  if (!isObject(raw) || !Array.isArray(raw.axes)) return { spec: null, problems: ['theme axes must be a string or { axes: [...] }'] }
  const axes: ThemeAxisSpec[] = []
  for (const [i, entry] of (raw.axes as unknown[]).entries()) {
    if (!isObject(entry)) {
      problems.push(`axes[${i}] must be an object`)
      continue
    }
    const attribute = cleanAttribute(String(entry.attribute ?? ''))
    if (!attribute) problems.push(`axes[${i}] needs an attribute`)
    const source = entry.source === 'collections' || entry.source === 'names' ? entry.source : entry.source === undefined || entry.source === 'modes' ? 'modes' : null
    if (source === null) problems.push(`axes[${i}].source must be "modes", "collections" or "names"`)
    const values: ThemeAxisValue[] = []
    for (const [j, v] of (Array.isArray(entry.values) ? entry.values : []).entries()) {
      const value = typeof v === 'string' ? { label: v } : isObject(v) ? v : null
      const label = value && typeof value.label === 'string' ? value.label.trim() : ''
      if (!label) {
        problems.push(`axes[${i}].values[${j}] needs a label`)
        continue
      }
      values.push({
        label,
        ...(typeof value!.value === 'string' && value!.value.trim() ? { value: value!.value.trim() } : {}),
        ...(value!.base === true ? { base: true } : {}),
        ...(typeof value!.sameAs === 'string' && value!.sameAs.trim() ? { sameAs: value!.sameAs.trim() } : {}),
        ...(Array.isArray(value!.collections) && value!.collections.some((c) => typeof c === 'string' && c.trim())
          ? { collections: (value!.collections as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim()) }
          : {}),
      })
    }
    if (values.length === 0) problems.push(`axes[${i}] (${attribute || '?'}) has no values`)
    const shared = Array.isArray(entry.shared) ? (entry.shared as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []
    axes.push({
      attribute,
      ...(entry.nested === true ? { nested: true } : {}),
      ...(source === 'collections' || source === 'names' ? { source } : {}),
      values,
      ...(shared.length > 0 ? { shared } : {}),
    })
  }
  if (axes.length < 1 || axes.length > 2) problems.push(`theme axes take one or two attributes, ${axes.length} given`)
  if (axes.filter((axis) => axis.nested).length > 1) problems.push('only one attribute can be switched inside the page')
  const pairs = (key: 'cells' | 'sameAs') => {
    const out: Record<string, string> = {}
    if (raw[key] === undefined) return undefined
    if (!isObject(raw[key])) {
      problems.push(`"${key}" must be an object`)
      return undefined
    }
    for (const [k, v] of Object.entries(raw[key] as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
      else problems.push(`${key}["${k}"] must be a string`)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  const cells = pairs('cells')
  const sameAs = pairs('sameAs')
  const collections = Array.isArray(raw.collections) ? (raw.collections as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim()) : []
  if (problems.length > 0) return { spec: null, problems }
  return { spec: { axes, ...(collections.length > 0 ? { collections } : {}), ...(cells ? { cells } : {}), ...(sameAs ? { sameAs } : {}) }, problems }
}

/** The nested axis (switchable on a subtree) and the other one, which is set once. */
export function orderAxes(spec: ThemeAxesSpec): { outer?: ThemeAxisSpec; inner: ThemeAxisSpec } {
  const inner = spec.axes.find((axis) => axis.nested) ?? spec.axes[spec.axes.length - 1]
  const outer = spec.axes.find((axis) => axis !== inner)
  return { outer, inner }
}

export const cellKey = (outer: string, inner: string) => `${outer}|${inner}`

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export interface FoldedAxis {
  graph: TokenGraph
  /** The collection the fold made: its modes are the grid, and it is the themes collection. */
  collection: string
  /** Every cell, by labels, to the mode of `collection` that holds it. */
  cells: Record<string, string>
  /** The collections the fold consumed (they no longer exist in `graph`). */
  consumed: string[]
  /** Per attribute, per value: where its tokens were found — collections, modes, or how many
   * variables carry its marker. What the picker shows beside each value. */
  found: Record<string, Record<string, string[]>>
  notes: string[]
}

const slugWords = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '')
const holdsWords = (name: string, label: string) => {
  const words = slugWords(name)
  const wanted = slugWords(label)
  return wanted.length > 0 && wanted.every((w) => words.includes(w))
}
const sameSlug = (a: string, b: string) => slugWords(a).join('-') === slugWords(b).join('-')

/**
 * Merges every place a theme can live into one collection whose modes are the grid — run on
 * every export, so no merged copy in the file can go stale. A cell (product × theme) is filled
 * from wherever the spec's sources point:
 *
 * - `collections`: a collection whose name contains the value (`One`, `One Light`, `Colors Dark`),
 *   or the ones a value lists; a `shared` collection holds every value of that axis;
 * - `modes`: a mode whose name contains the value; a single-mode collection holds every value;
 * - `names`: a variable whose path has the value as a segment, removed from the token's name
 *   (`dark/bg/base` is `bg/base` in Dark); a variable without one holds every value.
 *
 * The most specific instance of a token wins, then inheritance: the base value of the outer axis
 * in the same theme (Business takes One's token), any other value in the same theme (One takes a
 * Business-only token), the base theme, anything. A value marked `sameAs` copies another. Every
 * alias in the graph that pointed at a merged variable now points at the merged one of the same
 * name, so it resolves in the cell it is read in — what `collections.merge` does in Figma.
 *
 * Returns `null` when every axis reads modes (the themes collection's modes are the grid as they
 * stand), or `problems` when the file does not hold what the spec names.
 */
export function foldThemeSources(graph: TokenGraph, spec: ThemeAxesSpec): FoldedAxis | { problems: string[] } | null {
  if (spec.axes.every((axis) => (axis.source ?? 'modes') === 'modes')) return null
  const { outer, inner } = orderAxes(spec)
  const axes = outer ? [outer, inner] : [inner]
  const collections = graph.collections ?? []
  const variables = graph.variables ?? []
  const problems: string[] = []
  const realOf = (axis: ThemeAxisSpec) => axis.values.filter((v) => !v.sameAs)
  const baseOf = (axis: ThemeAxisSpec) => realOf(axis).find((v) => v.base) ?? realOf(axis)[0]
  const markerIn = (axis: ThemeAxisSpec, name: string) => name.split('/').findIndex((seg) => realOf(axis).some((v) => sameSlug(seg, v.label)))
  const found: FoldedAxis['found'] = Object.fromEntries(axes.map((axis) => [axis.attribute, Object.fromEntries(axis.values.map((v) => [v.label, [] as string[]]))]))

  // 1. The collections that take part, and the value each holds on each collections axis.
  const collAxes = axes.filter((axis) => axis.source === 'collections')
  const nameAxes = axes.filter((axis) => axis.source === 'names')
  const held = new Map<TokenGraphCollection, Map<ThemeAxisSpec, string>>()
  if (collAxes.length > 0) {
    for (const c of collections) {
      const at = new Map<ThemeAxisSpec, string>()
      for (const axis of collAxes) {
        if ((axis.shared ?? []).some((n) => same(n, c.name))) {
          at.set(axis, '*')
          continue
        }
        const hits = realOf(axis).filter((v) => (v.collections ? v.collections.some((n) => same(n, c.name)) : holdsWords(c.name, v.label)))
        // `Dark Contrast` contains `Dark`: the value that spells more of the name is the one meant.
        const longest = hits.filter((h) => slugWords(h.label).length === Math.max(...hits.map((x) => slugWords(x.label).length)))
        if (longest.length > 1) problems.push(`the collection "${c.name}" matches more than one value of ${axis.attribute} (${longest.map((h) => h.label).join(', ')})`)
        if (longest.length === 1) at.set(axis, longest[0].label)
      }
      if (at.size === collAxes.length) held.set(c, at)
    }
    for (const axis of collAxes) {
      for (const name of [...(axis.shared ?? []), ...realOf(axis).flatMap((v) => v.collections ?? [])]) {
        if (!collections.some((c) => same(c.name, name))) problems.push(`no collection is named "${name}"`)
      }
      for (const v of realOf(axis)) {
        const holders = [...held].filter(([, at]) => at.get(axis) === v.label).map(([c]) => c.name)
        if (holders.length === 0 && !(v.collections ?? []).length) problems.push(`no collection's name contains "${v.label}" (${axis.attribute})`)
        found[axis.attribute][v.label] = holders
      }
    }
  } else {
    const named = spec.collections?.length ? spec.collections : null
    for (const name of named ?? []) if (!collections.some((c) => same(c.name, name))) problems.push(`no collection is named "${name}"`)
    for (const c of collections) {
      const takes = named
        ? named.some((n) => same(n, c.name))
        : variables.some((v) => v.collectionId === c.id && nameAxes.some((axis) => markerIn(axis, v.name) !== -1))
      if (takes) held.set(c, new Map())
    }
  }
  if (problems.length === 0 && held.size === 0) problems.push('no collection holds these themes')
  if (problems.length > 0) return { problems: [...new Set(problems)] }

  // 2. Every variable of every mode of those collections, at its coordinates in the grid.
  interface Instance { key: string; coords: string[]; value: unknown; type: string; scopes?: readonly string[]; codeSyntax?: TokenGraphVariable['codeSyntax'] }
  const instances = new Map<string, Instance[]>()
  const collectionId = 'axis:themes'
  const mergedId = (key: string) => `${collectionId}:${key}`
  const repoint = new Map<string, string>()
  const outside: string[] = []
  for (const [c, at] of held) {
    const own = variables.filter((v) => v.collectionId === c.id)
    for (const m of c.modes) {
      const fixed = axes.map((axis): string | null | undefined => {
        if (axis.source === 'collections') return at.get(axis)
        if (axis.source === 'names') return null
        const hits = realOf(axis).filter((v) => holdsWords(m.name, v.label))
        if (hits.length === 1) {
          found[axis.attribute][hits[0].label].push(`${c.name} / ${m.name}`)
          return hits[0].label
        }
        return c.modes.length === 1 ? '*' : undefined
      })
      if (fixed.some((x) => x === undefined)) {
        outside.push(`${c.name} / ${m.name}`)
        continue
      }
      for (const v of own) {
        let segments = v.name.split('/')
        const coords = fixed.map((x, n) => {
          if (x !== null) return x as string
          const axis = axes[n]
          const k = segments.findIndex((seg) => realOf(axis).some((val) => sameSlug(seg, val.label)))
          if (k === -1) return '*'
          const label = realOf(axis).find((val) => sameSlug(segments[k], val.label))!.label
          segments = segments.filter((_, j) => j !== k)
          return label
        })
        if (segments.length === 0) continue
        const key = segments.join('/')
        if (!instances.has(key)) instances.set(key, [])
        instances.get(key)!.push({ key, coords, value: v.valuesByMode[m.modeId], type: v.resolvedType, ...(v.scopes ? { scopes: v.scopes } : {}), ...(v.codeSyntax ? { codeSyntax: v.codeSyntax } : {}) })
        repoint.set(v.id, mergedId(key))
      }
    }
  }
  // A value nothing holds would silently show its base: Dim as a copy of Light. Said instead.
  for (const axis of axes.filter((a) => (a.source ?? 'modes') === 'modes')) {
    for (const v of realOf(axis)) {
      if (found[axis.attribute][v.label].length === 0) problems.push(`no mode's name contains "${v.label}" (${axis.attribute})`)
    }
  }
  for (const axis of nameAxes) {
    for (const v of realOf(axis)) {
      const marked = variables.filter((x) => [...held.keys()].some((c) => c.id === x.collectionId) && x.name.split('/').some((seg) => sameSlug(seg, v.label))).length
      // The base needs no marker of its own: an unmarked variable holds for every value, so
      // `bg/base` beside `dark/bg/base` is Light's — the way a one-mode file usually reads.
      const base = v === baseOf(axis)
      found[axis.attribute][v.label] = marked > 0 ? [`${marked} variable(s) marked "${v.label}"`] : base ? ['the unmarked variables'] : []
      if (marked === 0 && !base) problems.push(`no variable's name has "${v.label}" as a segment (${axis.attribute})`)
    }
  }
  if (problems.length > 0) return { problems }

  // 3. The cells: the most specific instance, else inheritance along the base values.
  const resolve = (axis: ThemeAxisSpec, label: string): string => {
    const seen = new Set<string>()
    let current = label
    while (!seen.has(current)) {
      seen.add(current)
      const value = axis.values.find((v) => v.label === current)
      if (!value?.sameAs) return current
      current = axis.values.find((v) => same(v.label, value.sameAs!))?.label ?? current
    }
    return current
  }
  const outerLabels = outer ? outer.values.map((v) => v.label) : ['_']
  const innerLabels = inner.values.map((v) => v.label)
  const outerReal = outer ? realOf(outer).map((v) => v.label) : ['_']
  const innerReal = realOf(inner).map((v) => v.label)
  const outerBase = outer ? baseOf(outer).label : '_'
  const innerBase = baseOf(inner).label
  const pick = (list: Instance[], o: string, i: string): Instance | undefined => {
    let best: Instance | undefined
    let score = -1
    for (const inst of list) {
      const [co, ci] = outer ? inst.coords : ['_', inst.coords[0]]
      if ((co !== o && co !== '*') || (ci !== i && ci !== '*')) continue
      const here = (co === o ? 1 : 0) + (ci === i ? 1 : 0)
      if (here > score) {
        best = inst
        score = here
      }
    }
    return best
  }
  const lookup = (list: Instance[], o: string, i: string) => {
    const chain: Array<[string, string]> = [
      [o, i],
      [outerBase, i],
      ...outerReal.map((x): [string, string] => [x, i]),
      [o, innerBase],
      [outerBase, innerBase],
      ...outerReal.flatMap((x) => innerReal.map((y): [string, string] => [x, y])),
    ]
    for (const [x, y] of chain) {
      const inst = pick(list, x, y)
      if (inst) return inst
    }
    return undefined
  }
  const modeName = (o: string, i: string) => (outer ? `${o} ${i}` : i)
  const modeId = (o: string, i: string) => `${collectionId}:${modeName(o, i)}`
  const conflicts: string[] = []
  const aim = (value: unknown): unknown => {
    if (isObject(value) && value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string' && repoint.has(value.id)) return { ...value, id: repoint.get(value.id) }
    if (isObject(value) && ('color' in value || 'opacity' in value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, aim(v)]))
    return value
  }
  const merged: TokenGraphVariable[] = []
  for (const [key, list] of instances) {
    const types = new Set(list.map((inst) => inst.type))
    if (types.size > 1) {
      conflicts.push(key)
      continue
    }
    const valuesByMode: Record<string, unknown> = {}
    for (const o of outerLabels) {
      for (const i of innerLabels) {
        const inst = lookup(list, outer ? resolve(outer, o) : '_', resolve(inner, i))
        if (inst) valuesByMode[modeId(o, i)] = aim(inst.value)
      }
    }
    const first = list[0]
    merged.push({ id: mergedId(key), name: key, collectionId, resolvedType: first.type, valuesByMode, ...(first.scopes ? { scopes: first.scopes } : {}), ...(first.codeSyntax ? { codeSyntax: first.codeSyntax } : {}) })
  }

  // 4. The merged collection, the base cell first and the default.
  const taken = new Set(collections.filter((c) => !held.has(c)).map((c) => c.name.toLowerCase()))
  let name = 'Themes'
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Themes ${n}`
  const orderedOuter = [outerBase, ...outerLabels.filter((o) => o !== outerBase)]
  const orderedInner = [innerBase, ...innerLabels.filter((i) => i !== innerBase)]
  const mergedCollection: TokenGraphCollection = {
    id: collectionId,
    name,
    defaultModeId: modeId(outerBase, innerBase),
    modes: orderedOuter.flatMap((o) => orderedInner.map((i) => ({ modeId: modeId(o, i), name: modeName(o, i) }))),
  }
  const gone = new Set([...held.keys()].map((c) => c.id))
  const kept = variables
    .filter((v) => !gone.has(v.collectionId))
    .map((v) => ({ ...v, valuesByMode: Object.fromEntries(Object.entries(v.valuesByMode).map(([id, value]) => [id, aim(value)])) }))
  const textStyles = graph.textStyles?.map((style) =>
    style.boundVariables
      ? { ...style, boundVariables: Object.fromEntries(Object.entries(style.boundVariables).map(([k, id]) => [k, repoint.get(id) ?? id])) }
      : style
  )
  const cells: Record<string, string> = {}
  for (const o of outerLabels) for (const i of innerLabels) cells[cellKey(o, i)] = modeName(o, i)
  const notes: string[] = []
  if (outside.length > 0) notes.push(`modes outside the grid, left out: ${outside.join(', ')}`)
  if (conflicts.length > 0) notes.push(`left out, a different type in different themes: ${conflicts.join(', ')}`)
  return {
    graph: {
      ...graph,
      collections: [...collections.filter((c) => !gone.has(c.id)), mergedCollection],
      variables: [...kept, ...merged],
      ...(textStyles ? { textStyles } : {}),
    },
    collection: name,
    cells,
    consumed: [...held.keys()].map((c) => c.name),
    found,
    notes,
  }
}

/* ------------------------------------------------------------------ detection */

export interface CollectionSummary {
  name: string
  modes: string[]
  variables: number
  /** The variable names, when the caller has them — what a marker in the names is found by. */
  names?: string[]
}

const THEME_WORD = /^(light|dark|night|day|dim|contrast|high|low|default)$/i
const SHARED_NAME = /(^|\W)(shared|common|global|base)(\W|$)/i

const wordsOf = (name: string) => name.split(/[\s_\-–—/()]+/).filter((w) => w !== '')

/** A mode name list read as a grid of two word positions — `One Light` … `Platform Dark` is
 * 3 × 2 — or null when the words do not multiply out to exactly the modes. */
function modeGrid(modes: readonly string[]): [string[], string[]] | null {
  const split = modes.map(wordsOf)
  if (modes.length < 4 || split.some((w) => w.length !== 2)) return null
  const first = [...new Set(split.map((w) => w[0]))]
  const second = [...new Set(split.map((w) => w[1]))]
  const pairs = new Set(split.map((w) => `${w[0]}|${w[1]}`))
  return first.length > 1 && second.length > 1 && first.length * second.length === modes.length && pairs.size === modes.length ? [first, second] : null
}

const themeish = (values: readonly string[]) => values.filter((v) => wordsOf(v).some((w) => THEME_WORD.test(w))).length * 2 >= values.length

/**
 * A starting point for the picker, read off the file — never applied on its own. The first that
 * fits, from the richest layout to the plainest:
 *
 * 1. Collections that share a set of theme modes (One and Business, both Light/Dark): products as
 *    collections, the biggest as the base, shared/common/global ones for every product.
 * 2. One-mode collections named for their cell (`One Light` … `Business Dark`): both attributes
 *    from the collection names — the free plan's product × theme.
 * 3. One-mode collections named for a theme beside a plain one (`Colors` + `Colors Dark`): the
 *    theme from the collection names, the plain one as the base.
 * 4. One collection whose mode names multiply out to a grid (`One Light` … `Platform Dark`).
 * 5. Theme words as a segment of the variable names (`dark/bg/base`): a marker, unmarked = base.
 * 6. The themes collection's modes as one attribute.
 */
export function detectThemeAxes(collections: readonly CollectionSummary[], themesRole?: string): { spec: ThemeAxesSpec; why: string } | null {
  const multi = collections.filter((c) => c.modes.length >= 2 && !/^breakpoints?$/i.test(c.name.trim()))
  const single = collections.filter((c) => c.modes.length === 1)
  // The theme always comes last, so it is the inner attribute without being marked nested: a
  // suggestion puts every attribute on one element, the plain stylesheet; nesting is asked for.
  const themeAxis = (labels: string[], extra: Partial<ThemeAxisSpec> = {}): ThemeAxisSpec => ({ attribute: 'data-theme', ...extra, values: labels.map((label) => ({ label })) })

  // 1. Products as collections with theme modes.
  const bySet = new Map<string, CollectionSummary[]>()
  for (const c of multi) {
    const key = c.modes.map((m) => m.toLowerCase()).sort().join('|')
    bySet.set(key, [...(bySet.get(key) ?? []), c])
  }
  const families = [...bySet.values()].filter((group) => group.length >= 2 && themeish(group[0].modes))
  if (families.length > 0) {
    const family = families.sort((a, b) => b.length - a.length)[0]
    const shared = family.filter((c) => SHARED_NAME.test(c.name))
    const products = family.filter((c) => !shared.includes(c)).sort((a, b) => b.variables - a.variables)
    if (products.length >= 2) {
      return {
        spec: {
          axes: [
            {
              attribute: 'data-product',
              source: 'collections',
              values: products.map((c, n) => ({ label: c.name, ...(n === 0 ? { base: true } : {}) })),
              ...(shared.length > 0 ? { shared: shared.map((c) => c.name) } : {}),
            },
            themeAxis(family[0].modes),
          ],
        },
        why: `${products.map((c) => c.name).join(', ')} share the modes ${family[0].modes.join(', ')} — a product each`,
      }
    }
  }

  // 2. One-mode collections named for their cell.
  const cellNamed = modeGrid(single.map((c) => c.name))
  if (cellNamed) {
    const [a, b] = themeish(cellNamed[0]) && !themeish(cellNamed[1]) ? [cellNamed[1], cellNamed[0]] : cellNamed
    if (themeish(b)) {
      return {
        spec: { axes: [{ attribute: 'data-product', source: 'collections', values: a.map((label) => ({ label })) }, themeAxis(b, { source: 'collections' })] },
        why: `one-mode collections named ${a.length} × ${b.length} (${a[0]} ${b[0]} …) — product and theme from their names`,
      }
    }
  }

  // 3. A plain collection beside the same name with a theme word.
  for (const plain of single) {
    const stem = slugWords(plain.name)
    const variants = single.filter((c) => {
      if (c === plain) return false
      const words = slugWords(c.name)
      const extra = words.filter((w) => !stem.includes(w))
      return stem.every((w) => words.includes(w)) && extra.length > 0 && extra.every((w) => THEME_WORD.test(w))
    })
    if (variants.length === 0) continue
    const labels = variants.map((c) => c.name.split(/\s+/).filter((w) => THEME_WORD.test(w)).join(' ') || c.name)
    const baseLabel = labels.some((l) => /light/i.test(l)) ? 'Default' : 'Light'
    return {
      spec: { axes: [{ attribute: 'data-theme', source: 'collections', values: [{ label: baseLabel, collections: [plain.name], base: true }, ...labels.map((label) => ({ label }))] }] },
      why: `${plain.name} beside ${variants.map((c) => c.name).join(', ')} — a theme per collection`,
    }
  }

  // 4. One collection of combined modes.
  const role = themesRole ? multi.find((c) => c.name.trim().toLowerCase() === themesRole.trim().toLowerCase()) : undefined
  for (const c of role ? [role, ...multi.filter((m) => m !== role)] : multi) {
    const grid = modeGrid(c.modes)
    if (!grid) continue
    const [a, b] = themeish(grid[0]) && !themeish(grid[1]) ? [grid[1], grid[0]] : grid
    return {
      spec: {
        axes: [
          { attribute: 'data-product', values: a.map((label) => ({ label })) },
          themeAxis(b),
        ],
      },
      why: `the ${c.modes.length} modes of ${c.name} read as ${a.length} × ${b.length}`,
    }
  }

  // 5. Theme words as a segment of the variable names.
  for (const c of collections) {
    const marks = new Map<string, number>()
    for (const name of c.names ?? []) {
      for (const seg of name.split('/')) if (THEME_WORD.test(seg.trim())) marks.set(seg.trim().toLowerCase(), (marks.get(seg.trim().toLowerCase()) ?? 0) + 1)
    }
    if (marks.size === 0) continue
    const words = [...marks.keys()].map((w) => w[0].toUpperCase() + w.slice(1)).filter((w) => !/^light$/i.test(w))
    const labels = ['Light', ...words]
    return {
      spec: { collections: [c.name], axes: [{ ...themeAxis(labels, { source: 'names' }), values: labels.map((label, n) => ({ label, ...(n === 0 ? { base: true } : {}) })) }] },
      why: `variables in ${c.name} carry ${words.join(', ')} in their names — unmarked ones are ${labels[0]}`,
    }
  }

  // 6. One attribute: the themes collection's modes.
  const themes = role ?? [...multi].sort((x, y) => y.variables - x.variables)[0]
  if (!themes) return null
  return {
    spec: { axes: [themeAxis(themes.modes)] },
    why: `the modes of ${themes.name} as one attribute`,
  }
}
