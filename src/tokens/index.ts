/**
 * Token orchestrator — bridges VariableSnapshot → token engine.
 * Ported from allcrew-channel-django src/tokens/index.ts, adapted for the ds engine.
 */

import type { VariableSnapshot } from '../variables'
import type { ExportStructure, ThemeAxesSpec, ThemeGrid, TokenGraph, TokenTree } from './engine.ts'
import {
  applyThemeAxesSources,
  placeThemes,
  inlinePrimitivesTree,
  leaves,
  parseCollectionModes,
  prepareRoleGraph,
  shapeForCode,
  orderedThemes,
  slugGridThemes,
  axesLayers,
  toAxesModuleFiles,
  toStylesheet,
  uniqueVarNames,
  toTokensJson,
  variablesToW3CMultiMode,
  type RenameMap,
} from './engine.ts'
import type { ExportOptions } from '../settings.ts'
import { detectThemeAxes, normalizeThemeAxesSpec, orderAxes, type CollectionSummary } from './theme-axes.ts'
import { materializeStructure, migrateStructure, normalizeStructure, packageAxes, type Placement } from './structure.ts'
import { resolveThemeAttribute } from '../settings.ts'

export interface TokenEmitOptions {
  inlinePrimitives: boolean
  flattenAliases: boolean
  themeAttribute: string
  /** Names a colour remap rewrote, so the export can keep the old keys resolving. */
  renames?: RenameMap
  /** The `Collection roles` setting (`Primitives: hidden`, `Breakpoints: breakpoints`). */
  collectionRoles?: string
  /** Theme names as selector slugs — see `prepareRoleGraph`. */
  slugThemes?: boolean
  /** How themes become attributes — see `theme-axes.ts`. */
  themeAxes?: string | ThemeAxesSpec
  /** The export structure — supersedes the four settings above when set. See `structure.ts`. */
  structure?: ExportStructure | null
}

export interface TokenArtifacts {
  css: string
  json: string
  themes: string[]
  defaultTheme: string
  source: TokenTree
  /** The tree `css` was emitted from (primitives inlined per options) — the exact variable set
   * the stylesheet declares. `source` keeps the un-inlined tree for JSON/re-import. */
  emitted: TokenTree
  /** Why theme axes that were asked for were not used, and what the fold did. */
  notes: string[]
  /** The grid the stylesheet was written for, when theme axes applied. */
  grid?: ThemeGrid
}

export function tokenEmitOptionsFrom(options: ExportOptions, renames?: RenameMap): TokenEmitOptions {
  return {
    inlinePrimitives: options.tokens.inlinePrimitives,
    flattenAliases: options.tokens.flattenAliases,
    themeAttribute: resolveThemeAttribute(options),
    renames,
    collectionRoles: options.tokens.collectionRoles,
    slugThemes: options.tokens.slugThemes,
    themeAxes: options.tokens.themeAxes,
    ...(options.tokens.structure ? { structure: options.tokens.structure } : {}),
  }
}

export function emitTokenArtifacts(snapshot: VariableSnapshot, options: TokenEmitOptions): TokenArtifacts {
  // The same reading of the roles the panel's package uses, so both name the same themes and
  // claim the same token names (see prepareRoleGraph) — after theme axes folded any product
  // collections into one.
  const sources = applyThemeAxesSources(snapshot as unknown as TokenGraph, parseCollectionModes(options.collectionRoles), options.themeAxes, options.structure)
  const roles = sources.roles
  const prepared = prepareRoleGraph(sources.graph, roles, { slugThemes: options.slugThemes })
  const graph = prepared.graph
  const source = shapeForCode(graph, variablesToW3CMultiMode(graph), roles)
  const { ordered, defaultTheme } = orderedThemes(leaves(source), prepared.themeDefault)
  const unique = uniqueVarNames(options.inlinePrimitives ? inlinePrimitivesTree(source, options.flattenAliases) : source)
  const cssTree = unique.tree
  const sheet = toStylesheet(cssTree, ordered, defaultTheme, {
    themeAttr: options.themeAttribute,
    themeAxes: options.themeAxes,
    renames: options.renames,
    cells: sources.cells,
    problem: sources.problem,
    grid: slugGridThemes(sources.grid, !!options.slugThemes),
  })
  return {
    css: sheet.css,
    notes: [...sources.notes, ...prepared.notes, ...unique.dropped, ...(sheet.note ? [sheet.note] : [])],
    ...(sheet.grid ? { grid: sheet.grid } : {}),
    json: toTokensJson(source, options.renames),
    themes: ordered,
    defaultTheme,
    source,
    emitted: cssTree,
  }
}

/** What the export ships, in the few words the Tokens screen shows under the mapping: the
 * attributes and their values, the one each defaults to, the `<html>` that sets it, how big the
 * stylesheet is, and the parts it is cut into — each also a module file — with one part's text
 * when the screen asks to open it. */
export interface ExportSummary {
  attributes: Array<{ attribute: string; values: string[]; default: string }>
  html: string
  blocks: number
  tokens: number
  notes: string[]
  /** `tokens.css` first, then its layers (`base`, each theme, each product) when themes are
   * attributes: what a developer finds in the package, with what each holds. */
  files: Array<{ name: string; title: string; tokens: number; bytes: number }>
  /** The text of the file `file` named, when it is one of `files`. */
  preview?: { name: string; text: string }
}

const declaredNames = (css: string) => new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1])).size
/** Size on disk: UTF-8, where the em dash in a layer's comment is three bytes, not one. */
const utf8Bytes = (text: string) => {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

export function summarizeExport(snapshot: VariableSnapshot, options: TokenEmitOptions, file?: string, cssModulesGlobal = false): ExportSummary {
  const artifacts = emitTokenArtifacts(snapshot, options)
  const grid = artifacts.grid
  const attributes = grid
    ? grid.axes.map((axis, n) => ({ attribute: axis.attribute, values: axis.values, default: grid.defaults[n] }))
    : artifacts.themes.length > 1
      ? [{ attribute: options.themeAttribute, values: artifacts.themes, default: artifacts.defaultTheme }]
      : []
  const texts: Record<string, string> = { 'tokens.css': artifacts.css }
  const files: ExportSummary['files'] = [{ name: 'tokens.css', title: 'everything, for runtime switching', tokens: declaredNames(artifacts.css), bytes: utf8Bytes(artifacts.css) }]
  if (grid) {
    const modules = toAxesModuleFiles(artifacts.emitted, grid, cssModulesGlobal, options.renames)
    axesLayers(artifacts.emitted, grid).forEach((layer, n) => {
      const name = Object.keys(modules)[n]
      if (!name) return
      texts[name] = modules[name]
      files.push({ name, title: layer.title.replace(/^[^—]*— /, ''), tokens: declaredNames(modules[name]), bytes: utf8Bytes(modules[name]) })
    })
  }
  return {
    attributes,
    html: attributes.length > 0 ? `<html ${attributes.map((a) => `${a.attribute}="${a.default}"`).join(' ')}>` : '',
    blocks: (artifacts.css.match(/\{\s*$/gm) ?? []).length,
    tokens: declaredNames(artifacts.css),
    notes: artifacts.notes,
    files,
    ...(file && texts[file] !== undefined ? { preview: { name: file, text: texts[file] } } : {}),
  }
}

/** What the panel's theme axes picker draws: the file's collections and modes to pick from, the
 * spec as the export reads it, every cell of its grid and how it was filled, and the stylesheet
 * it would produce — computed by the export's own code path, so the picker cannot promise what
 * the export then does differently. */
export interface ThemeAxesPreview {
  spec: ThemeAxesSpec | null
  /** Why the axes would not be used. Empty when they would. */
  problems: string[]
  notes: string[]
  suggestion?: { spec: ThemeAxesSpec; why: string }
  collections: CollectionSummary[]
  /** The themes as the export names them — what a cell can be set to. */
  themes: string[]
  /** Every collection has one mode — a Starter (free) file, or one kept that way: themes then
   * come from collections or from markers in the variable names. */
  oneModeOnly: boolean
  /** Per attribute, per value: where its tokens were found (collections, modes, marked variables). */
  found?: Record<string, Record<string, string[]>>
  grid?: {
    outer?: { attribute: string; labels: string[] }
    inner: { attribute: string; labels: string[] }
    cells: Array<{ outer: string; inner: string; theme?: string; how?: string }>
  }
  html?: string
  blocks: Array<{ selector: string; tokens: number }>
}

export function previewThemeAxes(snapshot: VariableSnapshot, options: TokenEmitOptions & { detect?: boolean }): ThemeAxesPreview {
  const graph = snapshot as unknown as TokenGraph
  const collections: CollectionSummary[] = (graph.collections ?? []).map((c) => ({
    name: c.name,
    modes: c.modes.map((m) => m.name),
    variables: (graph.variables ?? []).filter((v) => v.collectionId === c.id).length,
    names: (graph.variables ?? []).filter((v) => v.collectionId === c.id).map((v) => v.name),
  }))
  const roles = parseCollectionModes(options.collectionRoles)
  const checked = normalizeThemeAxesSpec(options.themeAxes)
  const spec = checked.spec
  const suggestion = options.detect || !spec ? detectThemeAxes(collections, roles.themes[0]) ?? undefined : undefined
  const artifacts = emitTokenArtifacts(snapshot, options)
  const blocks = [...artifacts.css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim().split(/,\s*/).join(', '),
    tokens: (m[2].match(/--[\w-]+:/g) ?? []).length,
  }))
  const preview: ThemeAxesPreview = {
    spec,
    problems: [...checked.problems],
    notes: artifacts.notes.filter((note) => !note.startsWith('Theme axes not used')),
    ...(suggestion ? { suggestion } : {}),
    collections: collections.map(({ names: _names, ...summary }) => summary),
    themes: artifacts.themes,
    oneModeOnly: collections.length > 0 && collections.every((c) => c.modes.length <= 1),
    blocks,
  }
  if (!spec) return preview
  const sources = applyThemeAxesSources(graph, roles, spec)
  if (sources.problem) {
    preview.problems.push(sources.problem)
    return preview
  }
  if (sources.found) preview.found = sources.found
  const placed = placeThemes(artifacts.themes, spec, sources.cells)
  preview.problems.push(...placed.problems)
  if (placed.problems.length === 0 && !artifacts.grid) {
    const why = artifacts.notes.find((note) => note.startsWith('Theme axes not used'))
    if (why) preview.problems.push(why.replace(/^Theme axes not used — /, '').replace(/; tokens\.css has .*$/, ''))
  }
  const { outer, inner } = orderAxes(spec)
  const outerLabels = outer ? outer.values.map((v) => v.label) : ['_']
  preview.grid = {
    ...(outer ? { outer: { attribute: outer.attribute, labels: outerLabels } } : {}),
    inner: { attribute: inner.attribute, labels: inner.values.map((v) => v.label) },
    cells: outerLabels.flatMap((o) =>
      inner.values.map((i) => {
        const key = `${o}|${i.label}`
        return { outer: o, inner: i.label, ...(placed.cells[key] ? { theme: placed.cells[key], how: placed.how[key] } : {}) }
      })
    ),
  }
  const grid = artifacts.grid
  if (grid) {
    const attrs = grid.axes.map((axis, n) => `${axis.attribute}="${axis.values.find((v) => v !== grid.defaults[n]) ?? grid.defaults[n]}"`)
    preview.html = `<html ${attrs.join(' ')}>`
  }
  return preview
}

/* ------------------------------------------------------------- the structure editor */

/** A group of the file's tree: a path segment, its variables, its groups. */
export interface FileGroup {
  name: string
  /** `navigation/content` — what a source rule names. */
  path: string
  variables: number
  groups: FileGroup[]
}

export interface FileCollection {
  name: string
  modes: Array<{ name: string; default: boolean }>
  variables: number
  groups: FileGroup[]
}

/** What the structure editor draws: the file as a tree, the structure as the export reads it,
 * where every piece landed, the problems, and the stylesheet it would produce — all from the
 * export's own code path. */
export interface StructurePreview {
  file: FileCollection[]
  /** The structure in force: the pinned one, else the four old settings read as one. */
  structure: ExportStructure
  /** True when `structure` was migrated from the old settings rather than set. */
  migrated: boolean
  axes: Array<{ attribute: string; values: string[]; labels: string[]; base: string; nested: boolean }>
  placement: Placement
  problems: string[]
  notes: string[]
  themes: string[]
  html?: string
  blocks: Array<{ selector: string; tokens: number }>
  files: string[]
}

function fileTree(graph: TokenGraph): FileCollection[] {
  return (graph.collections ?? []).map((c) => {
    const own = (graph.variables ?? []).filter((v) => v.collectionId === c.id)
    const root: FileGroup = { name: '', path: '', variables: 0, groups: [] }
    for (const v of own) {
      const segments = v.name.split('/').map((x) => x.trim()).filter((x) => x !== '')
      let at = root
      for (const seg of segments.slice(0, -1)) {
        let next = at.groups.find((g) => g.name === seg)
        if (!next) {
          next = { name: seg, path: at.path ? `${at.path}/${seg}` : seg, variables: 0, groups: [] }
          at.groups.push(next)
        }
        next.variables++
        at = next
      }
    }
    return {
      name: c.name,
      modes: c.modes.map((m) => ({ name: m.name, default: m.modeId === c.defaultModeId })),
      variables: own.length,
      groups: root.groups,
    }
  })
}

export function previewStructure(snapshot: VariableSnapshot, options: TokenEmitOptions): StructurePreview {
  const graph = snapshot as unknown as TokenGraph
  const checked = normalizeStructure(options.structure)
  const migrated = !checked.structure
  const structure = checked.structure ?? migrateStructure(graph, { collectionRoles: options.collectionRoles, themeAttribute: options.themeAttribute, slugThemes: options.slugThemes, themeAxes: options.themeAxes })
  const made = materializeStructure(graph, structure)
  const artifacts = emitTokenArtifacts(snapshot, { ...options, structure })
  const blocks = [...artifacts.css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim().split(/,\s*/).join(', '),
    tokens: (m[2].match(/--[\w-]+:/g) ?? []).length,
  }))
  const preview: StructurePreview = {
    file: fileTree(graph),
    structure,
    migrated,
    axes: packageAxes(structure).map((a) => ({ attribute: a.attribute, values: a.values, labels: a.labels, base: a.base, nested: a.nested })),
    placement: made.placement,
    problems: [...checked.problems, ...made.problems],
    notes: artifacts.notes,
    themes: artifacts.themes,
    blocks,
    files: structure.collections.filter((c) => c.as === 'files').flatMap((c) => (c.axes ?? []).find((a) => a.attribute === (c.filesBy ?? c.axes?.[0]?.attribute))?.values.map((v) => `${(v.value ?? v.label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.css`) ?? []),
  }
  const grid = artifacts.grid
  if (grid) preview.html = `<html ${grid.axes.map((axis, n) => `${axis.attribute}="${axis.values.find((v) => v !== grid.defaults[n]) ?? grid.defaults[n]}"`).join(' ')}>`
  return preview
}
