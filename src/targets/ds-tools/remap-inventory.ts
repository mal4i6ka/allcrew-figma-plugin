/**
 * What colors this document actually holds — the input side of a remap.
 *
 * The inventory is always the whole document, never the current page or the selection. A
 * mapping built from one screen is a mapping built from a sample, and it would be applied to
 * everything regardless: variables are global, so a partial reading produces a confident
 * table that is wrong about the rest of the file. Application scope can be narrowed later;
 * the reading cannot.
 *
 * One walk pays for four things at once — how often each token is used (which name survives a
 * clash), which colors touch on canvas (which duplicates need pulling apart, and what the
 * contrast audit measures afterwards), which colors are not tokens at all, and which come
 * from a library and therefore cannot be written from here.
 *
 * Two shapes of site come out of it. Named things — variables, paint styles, effect styles —
 * are inventoried one row each, because that is how a human recognises them. Everything loose
 * on canvas is aggregated *per distinct color* instead: a hex used on four hundred layers is
 * one decision, not four hundred rows, and it maps identically everywhere by construction.
 *
 * Alias-valued variable modes are deliberately absent: a semantic token pointing at a
 * primitive follows it automatically, so writing it would be redundant at best and a
 * divergence at worst. Only literal values are sites.
 */

import type { AdjacencyPair } from '../../tokens/remap/audit.ts'
import type { ColorSite } from '../../tokens/remap/plan.ts'
import { loadAllPagesAsync, yieldToHost } from '../../utils/tree.ts'

export interface ModeInfo {
  id: string
  name: string
  collection: string
  collectionId: string
}

export interface RemapInventory {
  sites: ColorSite[]
  /** Site id pairs whose colors touch on canvas. */
  adjacency: AdjacencyPair[]
  modes: ModeInfo[]
  /** Mode whose family assignment drives renaming. */
  primaryModeId: string | null
  stats: {
    variables: number
    libraryVariables: number
    collections: number
    paintStyles: number
    effectStyles: number
    /** Distinct colors found loose on canvas. */
    looseColors: number
    /** Paints, gradient stops and shadows those colors were found on. */
    loosePlaces: number
    nodes: number
    /** Instances read as single layers rather than descended into. */
    instances: number
  }
  warnings: string[]
}

export type Progress = (label: string) => void

/**
 * Ceilings on what one reading may accumulate.
 *
 * A design system with tens of thousands of layers produces a combinatorial number of
 * adjacent-colour pairs and can hold thousands of distinct loose colours; both feed structures
 * the plugin VM has to hold in memory and then hand across the sandbox boundary, and enough of
 * either kills the plugin outright rather than slowing it down. Both caps are on *extras* —
 * duplicate separation and the contrast audit degrade, nothing is mis-mapped.
 */
const MAX_ADJACENT_PAIRS = 20000
const MAX_LOOSE_COLORS = 400

/** A file past this many nodes is read as far as it went, rather than not at all. */
const MAX_NODES = 200000

/* ------------------------------------------------------------------ site addressing */

/** Variables live per mode, so a site is a variable *and* a mode. */
export const siteId = (variableId: string, modeId: string): string => `${variableId}|${modeId}`

/** A color inside a style: `style:S#paints:0` or, for a gradient, `style:S#paints:0.2`. */
export const styleSiteId = (styleId: string, property: 'paints' | 'effects', index: number, stop?: number): string =>
  `style:${styleId}#${property}:${index}${stop === undefined ? '' : `.${stop}`}`

/** Everything loose on canvas is addressed by its color, because that is all it is. */
export const looseSiteId = (hex: string, alpha: number): string => `loose:${hex}:${alpha.toFixed(3)}`

export const isLooseSite = (id: string): boolean => id.slice(0, 6) === 'loose:'

/* ------------------------------------------------------------------ color helpers */

const isAlias = (value: VariableValue): value is VariableAlias =>
  typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS'

const isRgb = (value: VariableValue): value is RGB | RGBA =>
  typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value

export const withAlpha = (color: RGB | RGBA): { r: number; g: number; b: number; a: number } => ({
  r: color.r,
  g: color.g,
  b: color.b,
  a: 'a' in color ? color.a : 1,
})

export const hexOf = (color: { r: number; g: number; b: number }): string =>
  '#' +
  [color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')
    )
    .join('')

const GRADIENTS = ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']
export const isGradient = (paint: Paint): paint is GradientPaint => GRADIENTS.indexOf(paint.type) !== -1
export const isShadow = (effect: Effect): effect is DropShadowEffect | InnerShadowEffect =>
  effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'

/* ------------------------------------------------------------------ document walk */

interface LooseColor {
  hex: string
  alpha: number
  rgba: { r: number; g: number; b: number; a: number }
  count: number
}

interface WalkResult {
  /** Distinct loose colours seen after the cap was reached. */
  looseDropped: number
  /** Instance subtrees left unread — their colours belong to a main component. */
  instances: number
  /** True when the walk stopped early. */
  truncated: boolean
  /** Variable id → how many bindings point at it. */
  usage: Map<string, number>
  /** Style id → how many nodes wear it. */
  styleUsage: Map<string, number>
  /** Variable ids that came from a library rather than this file. */
  foreign: Set<string>
  loose: Map<string, LooseColor>
  /** Deduped; refs are variable ids or loose site ids. */
  neighbours: Map<string, AdjacencyPair>
  nodes: number
  loosePlaces: number
}

const boundIdsOf = (value: unknown): string[] => {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((entry) => (entry && typeof entry === 'object' ? (entry as VariableAlias).id : null))
    .filter((id): id is string => typeof id === 'string')
}

export const paintsOf = (node: SceneNode, property: 'fills' | 'strokes'): readonly Paint[] => {
  const value = (node as unknown as Record<string, unknown>)[property]
  return Array.isArray(value) ? (value as Paint[]) : []
}

export const styleIdOf = (node: SceneNode, property: 'fills' | 'strokes' | 'effects'): string => {
  const key = property === 'fills' ? 'fillStyleId' : property === 'strokes' ? 'strokeStyleId' : 'effectStyleId'
  const value = (node as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/** Node-level bindings, as a list indexed the same way the paints are. */
export const nodeLevelBindings = (node: SceneNode, property: 'fills' | 'strokes'): unknown[] => {
  const bound = 'boundVariables' in node ? (node.boundVariables as Record<string, unknown> | undefined) : undefined
  return Array.isArray(bound?.[property]) ? (bound[property] as unknown[]) : []
}

function noteLoose(walk: WalkResult, color: { r: number; g: number; b: number; a: number }): string {
  const hex = hexOf(color)
  const id = looseSiteId(hex, color.a)
  const existing = walk.loose.get(id)
  if (existing) existing.count++
  else if (walk.loose.size < MAX_LOOSE_COLORS) walk.loose.set(id, { hex, alpha: color.a, rgba: color, count: 1 })
  else walk.looseDropped++
  walk.loosePlaces++
  return id
}

/**
 * The colors a node contributes, as refs the adjacency map can pair: a bound paint is its
 * variable id, an unbound one is its own color. A node wearing a style contributes nothing —
 * the style is inventoried in its own right, and counting it here would pair it with itself.
 */
function colorRefs(node: SceneNode, property: 'fills' | 'strokes', walk: WalkResult): string[] {
  if (styleIdOf(node, property) !== '') return []

  const refs: string[] = []
  const nodeLevel = nodeLevelBindings(node, property)

  for (const [index, paint] of paintsOf(node, property).entries()) {
    if (paint.visible === false) continue

    const bound = [
      ...boundIdsOf((paint as { boundVariables?: { color?: unknown } }).boundVariables?.color),
      ...boundIdsOf(nodeLevel[index]),
    ]
    if (bound.length > 0) {
      refs.push(...bound)
      continue
    }

    if (paint.type === 'SOLID') {
      refs.push(noteLoose(walk, { ...paint.color, a: paint.opacity ?? 1 }))
      continue
    }
    if (isGradient(paint)) {
      // A gradient has no single color to pair with a neighbour, but every stop is still a
      // color the remap has to move.
      for (const stop of paint.gradientStops) noteLoose(walk, withAlpha(stop.color))
    }
  }
  return refs
}

/**
 * The variable ids a node's paints point at, and nothing else.
 *
 * For an instance this is the only safe thing to read: a binding is information (it tells us a
 * token is in use, and whether it came from a library), while a loose colour would be a promise
 * — the apply pass refuses to write inside instances, so inventorying one would put a row in
 * the table that Apply then silently ignores.
 */
function boundRefsOnly(node: SceneNode, noteVariable: (id: string) => void): void {
  for (const property of ['fills', 'strokes'] as const) {
    if (styleIdOf(node, property) !== '') continue
    const nodeLevel = nodeLevelBindings(node, property)
    for (const [index, paint] of paintsOf(node, property).entries()) {
      if (paint.visible === false) continue
      for (const id of boundIdsOf((paint as { boundVariables?: { color?: unknown } }).boundVariables?.color)) {
        noteVariable(id)
      }
      for (const id of boundIdsOf(nodeLevel[index])) noteVariable(id)
    }
  }
  if (styleIdOf(node, 'effects') !== '' || !('effects' in node) || !Array.isArray(node.effects)) return
  for (const effect of node.effects) {
    if (!isShadow(effect) || effect.visible === false) continue
    for (const id of boundIdsOf((effect as { boundVariables?: { color?: unknown } }).boundVariables?.color)) {
      noteVariable(id)
    }
  }
}

function noteEffects(node: SceneNode, walk: WalkResult, noteVariable: (id: string) => void): void {
  if (styleIdOf(node, 'effects') !== '') return
  if (!('effects' in node) || !Array.isArray(node.effects)) return
  for (const effect of node.effects) {
    if (!isShadow(effect) || effect.visible === false) continue
    const bound = boundIdsOf((effect as { boundVariables?: { color?: unknown } }).boundVariables?.color)
    if (bound.length > 0) {
      for (const id of bound) noteVariable(id)
      continue
    }
    noteLoose(walk, withAlpha(effect.color))
  }
}

const pairKey = (a: string, b: string, text: boolean): string =>
  (a < b ? `${a} ${b}` : `${b} ${a}`) + (text ? ' t' : ' n')

async function walkDocument(localIds: ReadonlySet<string>, progress?: Progress): Promise<WalkResult> {
  const walk: WalkResult = {
    usage: new Map(),
    styleUsage: new Map(),
    foreign: new Set(),
    loose: new Map(),
    neighbours: new Map(),
    nodes: 0,
    loosePlaces: 0,
    looseDropped: 0,
    instances: 0,
    truncated: false,
  }

  const noteVariable = (id: string): void => {
    walk.usage.set(id, (walk.usage.get(id) ?? 0) + 1)
    if (!localIds.has(id)) walk.foreign.add(id)
  }
  const notePair = (a: string, b: string, text: boolean): void => {
    if (walk.neighbours.size >= MAX_ADJACENT_PAIRS) return
    const key = pairKey(a, b, text)
    if (!walk.neighbours.has(key)) walk.neighbours.set(key, { a, b, text })
  }

  figma.skipInvisibleInstanceChildren = true
  try {
    for (const page of figma.root.children) {
      progress?.(`reading ${page.name}…`)
      const stack: BaseNode[] = [...page.children]
      /** What each container paints behind its children, so a text can be paired with it. */
      const backdrop = new Map<string, string[]>()

      while (stack.length > 0) {
        if (walk.nodes >= MAX_NODES) {
          walk.truncated = true
          break
        }
        const node = stack.pop() as SceneNode
        walk.nodes++

        // An instance mirrors its main component, which this same walk reads on its own page.
        // Descending would re-count every sublayer of every copy — on a real design system the
        // difference between thousands of nodes and millions — and would read colours the
        // *apply* pass deliberately refuses to write, so the table would promise changes that
        // never happen. Bindings are still noted: those are information, not a promise.
        if (node.type === 'INSTANCE') {
          walk.instances++
          boundRefsOnly(node, noteVariable)
          continue
        }

        for (const property of ['fills', 'strokes', 'effects'] as const) {
          const styleId = styleIdOf(node, property)
          if (styleId !== '') walk.styleUsage.set(styleId, (walk.styleUsage.get(styleId) ?? 0) + 1)
        }

        const fills = colorRefs(node, 'fills', walk)
        const strokes = colorRefs(node, 'strokes', walk)
        noteEffects(node, walk, noteVariable)
        for (const ref of [...fills, ...strokes]) if (!isLooseSite(ref)) noteVariable(ref)

        // A fill and a stroke on one node are as adjacent as two colors get.
        for (const fill of fills) for (const stroke of strokes) if (fill !== stroke) notePair(fill, stroke, false)

        const behind = backdrop.get(node.parent?.id ?? '') ?? []
        const isText = node.type === 'TEXT'
        for (const own of isText ? fills : [...fills, ...strokes]) {
          for (const parent of behind) if (own !== parent) notePair(own, parent, isText)
        }

        if ('children' in node && node.children.length > 0) {
          // An unpainted container passes whatever is behind it through to its children; when
          // there is nothing to pass, storing an entry per container is pure memory.
          const passes = fills.length > 0 ? fills : behind
          if (passes.length > 0) backdrop.set(node.id, passes)
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
        }

        if (walk.nodes % 500 === 0) {
          progress?.(`reading ${page.name}… ${walk.nodes} nodes`)
          await yieldToHost()
        }
      }
    }
  } finally {
    figma.skipInvisibleInstanceChildren = false
  }

  return walk
}

/* ------------------------------------------------------------------ styles */

async function readStyles(walk: WalkResult, sites: ColorSite[]): Promise<{ paints: number; effects: number }> {
  let paintStyles = 0
  let effectStyles = 0

  try {
    for (const style of await figma.getLocalPaintStylesAsync()) {
      paintStyles++
      const usage = walk.styleUsage.get(style.id) ?? 0
      for (const [index, paint] of style.paints.entries()) {
        if (paint.visible === false) continue
        if (paint.type === 'SOLID') {
          sites.push({
            id: styleSiteId(style.id, 'paints', index),
            groupId: style.id,
            kind: 'style',
            name: style.name,
            modeId: null,
            modeName: null,
            rgba: { ...paint.color, a: paint.opacity ?? 1 },
            usage,
            editable: !style.remote,
            primitive: false,
          })
          continue
        }
        if (!isGradient(paint)) continue
        for (const [stopIndex, stop] of paint.gradientStops.entries()) {
          sites.push({
            id: styleSiteId(style.id, 'paints', index, stopIndex),
            groupId: style.id,
            kind: 'gradient-stop',
            name: `${style.name} · stop ${stopIndex + 1}`,
            modeId: null,
            modeName: null,
            rgba: withAlpha(stop.color),
            usage,
            editable: !style.remote,
            primitive: false,
          })
        }
      }
    }
  } catch {
    /* paint styles unreadable — the rest of the inventory still stands */
  }

  try {
    for (const style of await figma.getLocalEffectStylesAsync()) {
      effectStyles++
      const usage = walk.styleUsage.get(style.id) ?? 0
      for (const [index, effect] of style.effects.entries()) {
        if (!isShadow(effect) || effect.visible === false) continue
        sites.push({
          id: styleSiteId(style.id, 'effects', index),
          groupId: style.id,
          kind: 'effect',
          name: `${style.name} · ${effect.type === 'DROP_SHADOW' ? 'shadow' : 'inner shadow'} ${index + 1}`,
          modeId: null,
          modeName: null,
          rgba: withAlpha(effect.color),
          usage,
          editable: !style.remote,
          primitive: false,
        })
      }
    }
  } catch {
    /* effect styles unreadable — same */
  }

  return { paints: paintStyles, effects: effectStyles }
}

/* ------------------------------------------------------------------ entry point */

export async function readRemapInventory(progress?: Progress): Promise<RemapInventory> {
  const warnings: string[] = []

  progress?.('reading variables…')
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const variables = await figma.variables.getLocalVariablesAsync('COLOR')
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]))
  const localIds = new Set(variables.map((variable) => variable.id))

  const modes: ModeInfo[] = []
  for (const collection of collections) {
    for (const mode of collection.modes) {
      modes.push({ id: mode.modeId, name: mode.name, collection: collection.name, collectionId: collection.id })
    }
  }

  try {
    await loadAllPagesAsync()
  } catch {
    warnings.push('some pages could not be loaded — their colors are missing from this reading')
  }

  const walk = await walkDocument(localIds, progress)
  progress?.('building the inventory…')

  const sites: ColorSite[] = []
  const modesByVariable = new Map<string, string[]>()

  for (const variable of variables) {
    const collection = collectionById.get(variable.variableCollectionId)
    if (!collection) continue

    const values = Object.entries(variable.valuesByMode)
    // The engine's definition, read from the Figma side: a value that varies by mode or points
    // at another token is the themeable layer; everything else is the primitive layer.
    const themed = collection.modes.length >= 2 || values.some(([, value]) => isAlias(value))
    const usage = walk.usage.get(variable.id) ?? 0
    const owned: string[] = []

    for (const mode of collection.modes) {
      const value = variable.valuesByMode[mode.modeId]
      if (value === undefined || isAlias(value) || !isRgb(value)) continue
      sites.push({
        id: siteId(variable.id, mode.modeId),
        groupId: variable.id,
        kind: 'variable',
        name: variable.name,
        modeId: mode.modeId,
        modeName: mode.name,
        rgba: withAlpha(value),
        usage,
        editable: true,
        primitive: !themed,
      })
      owned.push(mode.modeId)
    }
    if (owned.length > 0) modesByVariable.set(variable.id, owned)
  }

  // Library variables the file consumes: read, reported, never written.
  let libraryVariables = 0
  for (const id of walk.foreign) {
    const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null)
    if (!variable || variable.resolvedType !== 'COLOR') continue
    libraryVariables++
    const collection = await figma.variables
      .getVariableCollectionByIdAsync(variable.variableCollectionId)
      .catch(() => null)
    const owned: string[] = []
    for (const mode of collection?.modes ?? []) {
      const value = variable.valuesByMode[mode.modeId]
      if (value === undefined || isAlias(value) || !isRgb(value)) continue
      sites.push({
        id: siteId(variable.id, mode.modeId),
        groupId: variable.id,
        kind: 'variable',
        name: variable.name,
        modeId: mode.modeId,
        modeName: mode.name,
        rgba: withAlpha(value),
        usage: walk.usage.get(id) ?? 0,
        editable: false,
        primitive: false,
      })
      owned.push(mode.modeId)
    }
    if (owned.length > 0) modesByVariable.set(variable.id, owned)
  }

  const styles = await readStyles(walk, sites)

  for (const [id, color] of walk.loose) {
    sites.push({
      id,
      groupId: id,
      kind: 'detached',
      name: color.hex + (color.alpha < 0.999 ? ` ${Math.round(color.alpha * 100)}%` : ''),
      modeId: null,
      modeName: null,
      rgba: color.rgba,
      usage: color.count,
      editable: true,
      primitive: false,
    })
  }

  // Adjacency is discovered between refs but consumed between sites. A variable ref means one
  // site per mode, and a pair only collides inside one mode — comparing a light value against
  // a dark one means nothing. A loose color has no mode and pairs with all of them.
  const adjacency: AdjacencyPair[] = []
  const expand = (ref: string): string[] =>
    isLooseSite(ref) ? [ref] : (modesByVariable.get(ref) ?? []).map((mode) => siteId(ref, mode))
  const modeOf = (site: string): string | null => (isLooseSite(site) ? null : site.slice(site.lastIndexOf('|') + 1))

  for (const pair of walk.neighbours.values()) {
    for (const a of expand(pair.a)) {
      for (const b of expand(pair.b)) {
        const modeA = modeOf(a)
        const modeB = modeOf(b)
        if (modeA !== null && modeB !== null && modeA !== modeB) continue
        adjacency.push({ a, b, text: pair.text })
      }
    }
  }

  const primaryCollection = collections
    .map((collection) => ({
      collection,
      count: variables.filter((variable) => variable.variableCollectionId === collection.id).length,
    }))
    .sort((a, b) => b.count - a.count)[0]

  if (sites.length === 0) warnings.push('this file holds no colors this tool can remap')
  if (walk.looseDropped > 0) {
    warnings.push(
      `${walk.looseDropped} rarely used loose color(s) beyond the first ${MAX_LOOSE_COLORS} were left out of ` +
        'this reading — they stay as they are'
    )
  }
  if (walk.instances > 0) {
    warnings.push(
      `${walk.instances} instance(s) were skipped — their colors belong to a main component, which is read ` +
        'and written on its own; a color overridden by hand on one instance stays as it is'
    )
  }
  if (walk.truncated) {
    warnings.push(
      `this file is larger than one pass can read (stopped at ${MAX_NODES} nodes) — variables and styles ` +
        'are complete, but loose colors on layers beyond that point are missing'
    )
  }
  if (walk.neighbours.size >= MAX_ADJACENT_PAIRS) {
    warnings.push(
      `this file has more touching colour pairs than one pass can hold — duplicate separation and the ` +
        `contrast audit ran on the first ${MAX_ADJACENT_PAIRS}`
    )
  }

  return {
    sites,
    adjacency,
    modes,
    primaryModeId: primaryCollection?.collection.defaultModeId ?? null,
    stats: {
      variables: variables.length,
      libraryVariables,
      collections: collections.length,
      paintStyles: styles.paints,
      effectStyles: styles.effects,
      looseColors: walk.loose.size,
      loosePlaces: walk.loosePlaces,
      nodes: walk.nodes,
      instances: walk.instances,
    },
    warnings,
  }
}
