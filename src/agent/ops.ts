/**
 * Agent listener — the read-only op registry.
 *
 * These are the questions a CLI agent can ask about the open file: what pages and frames
 * exist, what a node looks like, which components are available and what variants they take,
 * and how the prototype wires frames together. That is the discovery half of "assemble a flow
 * from components" — an agent has to be able to *name* the frames and components it wants
 * before it can be trusted to touch any of them.
 *
 * Nothing in *this* file writes — the mutating ops live in `write-ops.ts` and are gated
 * separately, so the read surface stays reviewable on its own.
 *
 * `documentAccess: "dynamic-page"` rules apply throughout: pages must be `loadAsync`'d before
 * their subtree is readable, and node lookup goes through `getNodeByIdAsync`.
 */

import { lintScopeAsync, type LintFinding } from '../targets/django/lint/index.ts'
import { findAllWithCriteria, loadAllPagesAsync } from '../utils/tree.ts'
import { readAllVariables, readLocalVariables, resolveVariableValue } from '../variables.ts'
import { describeColor, type Rgba } from './values.ts'
import type { OpDef } from './protocol.ts'
import { CONTEXT_OPS } from './context-ops.ts'
import { TRANSITION_OPS } from './transition-ops.ts'
import { WRITE_OPS } from './write-ops.ts'

/* ------------------------------------------------------------- serializers */

export interface ReactionSummary {
  trigger: string
  action: string
  destinationId?: string
  navigation?: string
}

export interface NodeSummary {
  id: string
  name: string
  type: string
  visible?: boolean
  x?: number
  y?: number
  width?: number
  height?: number
  layout?: {
    mode: string
    itemSpacing?: number
    padding?: [number, number, number, number]
    primaryAxisAlign?: string
    counterAxisAlign?: string
  }
  /** Corner radii, and Figma's squircle smoothing — which no CSS property expresses, so an
   * implementation has to know it is there rather than discover the shape is subtly wrong. */
  corners?: {
    radius?: number
    /** Top-left, top-right, bottom-right, bottom-left — present when the corners differ. */
    perCorner?: [number, number, number, number]
    /** 0..1. Above 0 the shape is a squircle and `border-radius` alone cannot reproduce it. */
    smoothing?: number
  }
  /** Field → the token bound to it. `mismatch` is set when the layer renders something else.
   * A paint field appears per index (`fills[0]`) when the node carries several. */
  bindings?: Record<
    string,
    {
      token: string
      value?: number | string
      rendered?: number | string
      /** The layer renders something the token does not say. */
      mismatch?: boolean
      /** Same text, different capitalisation or spacing. Reported apart from `mismatch` so a
       * systemic naming quirk cannot bury the handful of real defects. */
      caseOnly?: boolean
      /** Set when the token is authored in different units than the property it drives, so
       * `value` and `rendered` can disagree numerically and still be the same thing. */
      unit?: 'percent'
      /** The collection the token lives in — local or imported. */
      collection?: string
      /** True when the token came from another file. A binding onto a remote variable is a
       * live dependency; onto a local one it is not. Reported because the two look identical
       * in Figma and behave completely differently when the upstream library changes. */
      remote?: boolean
    }
  >
  /** TEXT only, truncated — an agent wants the gist, not the copy deck. */
  text?: string
  /** INSTANCE only. */
  instanceOf?: { id: string | null; name: string | null; properties?: Record<string, unknown> }
  reactions?: ReactionSummary[]
  childCount?: number
  children?: NodeSummary[]
}

/** Figma geometry is float-noisy; two decimals is past anything a layout decision turns on. */
function round2(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined
}

/** Normalizes both reaction shapes: the current `actions[]` array and the legacy single
 * `action`. Pure so the mapping is testable without a document. */
export function summarizeReactions(raw: unknown): ReactionSummary[] {
  if (!Array.isArray(raw)) return []
  const out: ReactionSummary[] = []
  for (const reaction of raw) {
    if (!reaction || typeof reaction !== 'object') continue
    const entry = reaction as Record<string, any>
    const trigger = entry.trigger?.type ?? 'UNKNOWN'
    const actions: any[] = Array.isArray(entry.actions) ? entry.actions : entry.action ? [entry.action] : []
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue
      out.push({
        trigger,
        action: action.type ?? 'UNKNOWN',
        ...(typeof action.destinationId === 'string' ? { destinationId: action.destinationId } : {}),
        ...(typeof action.navigation === 'string' ? { navigation: action.navigation } : {}),
      })
    }
  }
  return out
}

/** Flattens `componentProperties` (`{ Size: { type, value } }`) to `{ Size: 'Large' }`. */
export function summarizeComponentProperties(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(raw as Record<string, any>)) {
    out[key] = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const MAX_TEXT = 160

/** Node → summary, minus anything that needs an await (reactions, main component). Pure. */
export function summarizeNode(node: any): NodeSummary {
  const summary: NodeSummary = { id: node.id, name: node.name, type: node.type }
  if (node.visible === false) summary.visible = false

  const x = round2(node.x)
  const y = round2(node.y)
  const width = round2(node.width)
  const height = round2(node.height)
  if (x !== undefined) summary.x = x
  if (y !== undefined) summary.y = y
  if (width !== undefined) summary.width = width
  if (height !== undefined) summary.height = height

  if (typeof node.layoutMode === 'string' && node.layoutMode !== 'NONE') {
    summary.layout = {
      mode: node.layoutMode,
      ...(round2(node.itemSpacing) !== undefined ? { itemSpacing: round2(node.itemSpacing) } : {}),
      padding: [
        round2(node.paddingTop) ?? 0,
        round2(node.paddingRight) ?? 0,
        round2(node.paddingBottom) ?? 0,
        round2(node.paddingLeft) ?? 0,
      ],
      ...(node.primaryAxisAlignItems ? { primaryAxisAlign: node.primaryAxisAlignItems } : {}),
      ...(node.counterAxisAlignItems ? { counterAxisAlign: node.counterAxisAlignItems } : {}),
    }
  }

  const corners: NonNullable<NodeSummary['corners']> = {}
  const radius = round2(node.cornerRadius)
  if (radius !== undefined) corners.radius = radius
  const perCorner: Array<number | undefined> = [
    round2(node.topLeftRadius),
    round2(node.topRightRadius),
    round2(node.bottomRightRadius),
    round2(node.bottomLeftRadius),
  ]
  // `cornerRadius` reads as `figma.mixed` when the four differ, and a summary that reported
  // only that would hide the whole shape. List them whenever they are not all equal.
  if (perCorner.every((value) => value !== undefined) && new Set(perCorner).size > 1) {
    corners.perCorner = perCorner as [number, number, number, number]
  }
  const smoothing = round2(node.cornerSmoothing)
  if (smoothing !== undefined && smoothing > 0) corners.smoothing = smoothing
  if (Object.keys(corners).length > 0) summary.corners = corners

  if (node.type === 'TEXT' && typeof node.characters === 'string') {
    summary.text =
      node.characters.length > MAX_TEXT ? node.characters.slice(0, MAX_TEXT) + '…' : node.characters
  }

  if (Array.isArray(node.children)) summary.childCount = node.children.length

  return summary
}

/** Paint fields: the binding is per paint, so the array index is part of the field name. */
const PAINT_FIELDS: Readonly<Record<string, 'fills' | 'strokes'>> = { fills: 'fills', strokes: 'strokes' }

/** A solid paint's effective colour. Figma keeps the alpha in the paint's `opacity`, not in
 * `color`, so a comparison that read `color` alone would call every translucent token a match. */
export function paintColor(paint: unknown): Rgba | null {
  const entry = paint as { type?: string; color?: { r: number; g: number; b: number }; opacity?: number } | null
  if (!entry || entry.type !== 'SOLID' || !entry.color) return null
  return {
    r: entry.color.r,
    g: entry.color.g,
    b: entry.color.b,
    a: typeof entry.opacity === 'number' ? entry.opacity : 1,
  }
}

function asColor(value: unknown): Rgba | null {
  const entry = value as { r?: unknown; g?: unknown; b?: unknown; a?: unknown } | null
  if (!entry || typeof entry.r !== 'number' || typeof entry.g !== 'number' || typeof entry.b !== 'number') {
    return null
  }
  return { r: entry.r, g: entry.g, b: entry.b, a: typeof entry.a === 'number' ? entry.a : 1 }
}

/** Half a byte per channel — below what 8-bit colour can even represent, so float noise from
 * Figma never reads as a real difference. */
export function sameColor(a: Rgba, b: Rgba): boolean {
  return (['r', 'g', 'b', 'a'] as const).every((channel) => Math.abs(a[channel] - b[channel]) < 0.002)
}

/**
 * What a bound field actually renders, in a form comparable with the token's own value. Figma
 * hands the same idea back in three shapes: a plain number, a `{ value, unit }` pair for
 * line-height and letter-spacing, and a `fontName` object whose halves are bound separately.
 * Anything it cannot state exactly — mixed formatting, `AUTO` line-height, a percentage where
 * the token is in pixels — returns undefined, because a wrong comparison is worse than none.
 */
export function renderedValue(node: any, field: string): number | string | undefined {
  if (field === 'fontFamily' || field === 'fontStyle') {
    const font = node.fontName
    if (!font || font === figma.mixed || typeof font !== 'object') return undefined
    const value = field === 'fontFamily' ? font.family : font.style
    return typeof value === 'string' ? value : undefined
  }

  const raw = node[COMPARABLE[field] ?? field]
  if (raw === undefined || raw === null || raw === figma.mixed) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return round2(raw)
  if (typeof raw === 'object' && 'unit' in raw) {
    const entry = raw as { value?: unknown; unit?: unknown }
    // A PERCENT line-height against a pixel token is not a mismatch, it is a different kind of
    // number; AUTO has none at all. Both are reported as uncomparable rather than as drift.
    if (entry.unit === 'PIXELS' && typeof entry.value === 'number') return round2(entry.value)
    return undefined
  }
  return undefined
}

/**
 * Two strings that differ only in capitalisation or spacing. Figma's font styles are canonical
 * ("Semi Bold") while a token holding them is often written the way a designer types it
 * ("semi bold"), and dozens of those would drown the one binding that is genuinely wrong.
 */
export function differsOnlyByCase(a: string, b: string): boolean {
  const normalise = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
  return a !== b && normalise(a) === normalise(b)
}

/**
 * Fields whose bound variable is authored in percent while the node property is a 0..1
 * fraction. Figma binds `opacity` this way and says so nowhere: a variable of 30 renders as
 * 0.3, which means a token written as 0.5 renders as half a percent and the layer vanishes.
 * That asymmetry cost a wrong diagnosis and a broken component set to find, so it lives in a
 * named table rather than in a comment somewhere.
 */
const PERCENT_BOUND: ReadonlySet<string> = new Set(['opacity'])

/** The token's value in the property's own units, for comparison. */
export function comparableTokenValue(field: string, value: number): number {
  return PERCENT_BOUND.has(field) ? value / 100 : value
}

/** Scalar fields whose rendered value can be compared against the token bound to them. */
const COMPARABLE: Readonly<Record<string, string>> = {
  topLeftRadius: 'topLeftRadius',
  topRightRadius: 'topRightRadius',
  bottomRightRadius: 'bottomRightRadius',
  bottomLeftRadius: 'bottomLeftRadius',
  itemSpacing: 'itemSpacing',
  paddingLeft: 'paddingLeft',
  paddingRight: 'paddingRight',
  paddingTop: 'paddingTop',
  paddingBottom: 'paddingBottom',
  strokeWeight: 'strokeWeight',
  fontSize: 'fontSize',
  fontWeight: 'fontWeight',
  lineHeight: 'lineHeight',
  letterSpacing: 'letterSpacing',
  paragraphSpacing: 'paragraphSpacing',
  paragraphIndent: 'paragraphIndent',
  characters: 'characters',
  width: 'width',
  height: 'height',
  opacity: 'opacity',
}

/**
 * What this node binds, by token name — and, for numeric fields, whether the layer actually
 * renders what the token says. A binding that disagrees with its own token is invisible in
 * Figma and lethal in generated code: the emitter writes `var(--radius-x-large, 21.76px)` and
 * whoever reads it cannot tell whether the design means 21.76 or the token's own value. Both
 * numbers are reported so the answer is not a guess.
 */
async function describeBindings(node: any, summary: NodeSummary): Promise<NodeSummary['bindings']> {
  const bound = node.boundVariables
  if (!bound || typeof bound !== 'object') return undefined

  const out: NonNullable<NodeSummary['bindings']> = {}
  for (const [field, entry] of Object.entries(bound as Record<string, any>)) {
    if (field in PAINT_FIELDS) {
      const aliases = Array.isArray(entry) ? entry : [entry]
      const paints = node[field]
      for (const [index, alias] of aliases.entries()) {
        const record = await describePaintBinding(alias, Array.isArray(paints) ? paints[index] : undefined)
        if (record) out[aliases.length > 1 ? `${field}[${index}]` : field] = record
      }
      continue
    }

    const alias = Array.isArray(entry) ? entry[0] : entry
    const id = alias?.id
    if (typeof id !== 'string') continue

    let variable: Variable | null = null
    try {
      variable = await figma.variables.getVariableByIdAsync(id)
    } catch {
      /* an unresolvable id is still worth reporting as a binding — just unnamed */
    }
    const record: NonNullable<NodeSummary['bindings']>[string] = { token: variable?.name ?? id }
    if (variable?.remote) record.remote = true

    const rendered = renderedValue(node, field)
    if (variable && rendered !== undefined) {
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
      if (collection) record.collection = collection.name
      const modeId = collection?.defaultModeId
      if (modeId) {
        try {
          // Most semantic tokens are aliases onto a primitive — `radius/x-large` points at
          // `scale/16` — so reading `valuesByMode` alone yields an alias object and no
          // comparison at all. Chasing the chain is what makes the check apply to the tokens
          // a design system actually uses.
          const resolved = await resolveVariableValue(variable, modeId)
          if (typeof resolved.value === 'number' && typeof rendered === 'number') {
            const percent = PERCENT_BOUND.has(field)
            // `value` stays what the token actually holds — reporting a converted number would
            // hide the very asymmetry the reader needs to know about. `unit` explains why 30
            // and 0.3 are the same answer.
            record.value = Math.round(resolved.value * 100) / 100
            record.rendered = rendered
            if (percent) record.unit = 'percent'
            const comparable = comparableTokenValue(field, resolved.value)
            if (Math.abs(comparable - rendered) > 0.01) record.mismatch = true
          } else if (typeof resolved.value === 'string' && typeof rendered === 'string') {
            record.value = resolved.value
            record.rendered = rendered
            if (differsOnlyByCase(resolved.value, rendered)) record.caseOnly = true
            else if (resolved.value !== rendered) record.mismatch = true
          }
        } catch {
          /* a circular or unreadable alias is reported as a binding without a comparison */
        }
      }
    }
    out[field] = record
  }
  // Radii repeat per corner; a mismatch on any of them is the interesting bit, and the corner
  // summary already says what the shape is.
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * One paint binding: the token, the colour it resolves to, and the colour the layer actually
 * paints. A colour that has drifted from its token is the failure this whole plugin exists to
 * catch, and it is the one a screenshot will never show — two greys a byte apart look
 * identical and behave differently the moment the token moves.
 */
async function describePaintBinding(
  alias: unknown,
  paint: unknown
): Promise<NonNullable<NodeSummary['bindings']>[string] | null> {
  const id = (alias as { id?: unknown } | null)?.id
  if (typeof id !== 'string') return null

  let variable: Variable | null = null
  try {
    variable = await figma.variables.getVariableByIdAsync(id)
  } catch {
    /* unnamed binding is still a binding */
  }
  const record: NonNullable<NodeSummary['bindings']>[string] = { token: variable?.name ?? id }
  if (variable?.remote) record.remote = true

  const rendered = paintColor(paint)
  if (!variable || !rendered) return record
  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
  if (!collection) return record
  record.collection = collection.name
  try {
    const resolved = await resolveVariableValue(variable, collection.defaultModeId)
    const tokenColor = asColor(resolved.value)
    if (!tokenColor) return record
    record.value = describeColor(tokenColor)
    record.rendered = describeColor(rendered)
    if (!sameColor(tokenColor, rendered)) record.mismatch = true
  } catch {
    /* circular or unreadable alias — report the binding without a comparison */
  }
  return record
}

/** Full description of one node: `summarizeNode` plus the awaited bits, recursing `depth`
 * levels of children. Depth is capped by the op's param spec, so the payload stays bounded. */
async function describeNode(node: any, depth: number): Promise<NodeSummary> {
  const summary = summarizeNode(node)

  const bindings = await describeBindings(node, summary)
  if (bindings) summary.bindings = bindings

  if (typeof node.getReactionsAsync === 'function' || Array.isArray(node.reactions)) {
    const raw =
      typeof node.getReactionsAsync === 'function' ? await node.getReactionsAsync() : node.reactions
    const reactions = summarizeReactions(raw)
    if (reactions.length > 0) summary.reactions = reactions
  }

  if (node.type === 'INSTANCE') {
    let main: any = null
    try {
      main = typeof node.getMainComponentAsync === 'function' ? await node.getMainComponentAsync() : null
    } catch {
      /* main component lives in an unloaded library — report the instance without it */
    }
    summary.instanceOf = {
      id: main?.id ?? null,
      name: main?.name ?? null,
      ...(summarizeComponentProperties(node.componentProperties)
        ? { properties: summarizeComponentProperties(node.componentProperties) }
        : {}),
    }
  }

  if (depth > 0 && Array.isArray(node.children)) {
    summary.children = []
    for (const child of node.children) summary.children.push(await describeNode(child, depth - 1))
  }

  return summary
}

/* ---------------------------------------------------------------- scoping */

async function resolvePage(pageId?: unknown): Promise<PageNode> {
  if (typeof pageId !== 'string' || pageId === '') return figma.currentPage
  const page = await figma.getNodeByIdAsync(pageId)
  if (!page || page.type !== 'PAGE') throw new Error(`no page with id ${pageId}`)
  await page.loadAsync()
  return page
}

/** Resolves the search root for the `scope` param shared by `node.find` / `components.list`. */
async function resolveScope(scope: string): Promise<BaseNode> {
  if (scope === 'document') {
    await loadAllPagesAsync()
    return figma.root
  }
  return figma.currentPage
}

/* -------------------------------------------------------------------- ops */

export const READ_OPS: readonly OpDef[] = [
  {
    name: 'document.info',
    summary: 'File name, editor type, current page and the list of pages.',
    mutates: false,
    params: {},
    async run() {
      return {
        fileName: figma.root.name,
        editorType: figma.editorType,
        currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
        pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })),
      }
    },
  },

  {
    name: 'page.frames',
    summary: 'Top-level frames, sections and components on a page — the addressable surfaces.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Page id. Defaults to the page the designer is on.' },
    },
    async run(params) {
      const page = await resolvePage(params.pageId)
      return {
        page: { id: page.id, name: page.name },
        nodes: page.children
          .filter((node) =>
            node.type === 'FRAME' ||
            node.type === 'SECTION' ||
            node.type === 'COMPONENT' ||
            node.type === 'COMPONENT_SET'
          )
          .map((node) => summarizeNode(node)),
      }
    },
  },

  {
    name: 'node.get',
    summary: 'One node by id: geometry, auto-layout, text, instance bindings, children.',
    mutates: false,
    params: {
      nodeId: { type: 'string', description: 'Node id, e.g. "12:345".', required: true },
      depth: {
        type: 'number',
        description: 'Levels of children to include (0 = the node alone).',
        default: 1,
        min: 0,
        max: 5,
      },
    },
    async run(params) {
      const node = await figma.getNodeByIdAsync(params.nodeId as string)
      if (!node) throw new Error(`no node with id ${params.nodeId}`)
      return describeNode(node, params.depth as number)
    },
  },

  {
    name: 'node.find',
    summary: 'Search nodes by name substring and/or type within a page or the whole document.',
    mutates: false,
    params: {
      name: { type: 'string', description: 'Case-insensitive substring of the node name.' },
      types: {
        type: 'string[]',
        description: 'Node types to keep, e.g. ["FRAME","INSTANCE"]. Omit for any type.',
      },
      scope: {
        type: 'string',
        description: 'Where to search.',
        enum: ['page', 'document'],
        default: 'page',
      },
      limit: { type: 'number', description: 'Max matches returned.', default: 50, min: 1, max: 500 },
    },
    async run(params) {
      const needle = typeof params.name === 'string' ? params.name.toLowerCase() : null
      const types = (params.types as string[] | undefined) ?? null
      const root = await resolveScope(params.scope as string)
      const matches = await findAllWithCriteria(root, (node): node is SceneNode => {
        if (types && !types.includes(node.type)) return false
        if (needle && !node.name.toLowerCase().includes(needle)) return false
        return true
      })
      const limit = params.limit as number
      return {
        total: matches.length,
        truncated: matches.length > limit,
        nodes: matches.slice(0, limit).map((node) => summarizeNode(node)),
      }
    },
  },

  {
    name: 'selection.get',
    summary: "What the designer has selected right now — the handoff point for 'this frame'.",
    mutates: false,
    params: {
      depth: { type: 'number', description: 'Levels of children per selected node.', default: 0, min: 0, max: 5 },
    },
    async run(params) {
      const depth = params.depth as number
      const nodes: NodeSummary[] = []
      for (const node of figma.currentPage.selection) nodes.push(await describeNode(node, depth))
      return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, nodes }
    },
  },

  {
    name: 'components.list',
    summary: 'Local components and component sets with their property/variant definitions.',
    mutates: false,
    params: {
      scope: { type: 'string', description: 'Where to look.', enum: ['page', 'document'], default: 'document' },
      name: { type: 'string', description: 'Case-insensitive substring of the component name.' },
      limit: { type: 'number', description: 'Max components returned.', default: 100, min: 1, max: 500 },
    },
    async run(params) {
      const needle = typeof params.name === 'string' ? params.name.toLowerCase() : null
      const root = await resolveScope(params.scope as string)
      const found = await findAllWithCriteria(root, (node): node is ComponentNode | ComponentSetNode => {
        if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') return false
        if (needle && !node.name.toLowerCase().includes(needle)) return false
        // A variant inside a set is reachable through its parent — listing both is noise.
        return !(node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET')
      })
      const limit = params.limit as number
      return {
        total: found.length,
        truncated: found.length > limit,
        components: found.slice(0, limit).map((node) => ({
          id: node.id,
          key: node.key,
          name: node.name,
          type: node.type,
          description: node.description || undefined,
          properties: node.componentPropertyDefinitions ?? undefined,
          variants:
            node.type === 'COMPONENT_SET'
              ? node.children.map((child) => ({ id: child.id, name: child.name }))
              : undefined,
        })),
      }
    },
  },

  {
    name: 'styles.list',
    summary: 'Local text, paint, effect and grid styles.',
    mutates: false,
    params: {},
    async run() {
      const [text, paint, effect, grid] = await Promise.all([
        figma.getLocalTextStylesAsync(),
        figma.getLocalPaintStylesAsync(),
        figma.getLocalEffectStylesAsync(),
        figma.getLocalGridStylesAsync(),
      ])
      const base = (style: BaseStyle) => ({
        id: style.id,
        key: style.key,
        name: style.name,
        description: style.description || undefined,
      })
      return {
        text: text.map((style) => ({
          ...base(style),
          fontFamily: style.fontName.family,
          fontStyle: style.fontName.style,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        })),
        paint: paint.map((style) => ({ ...base(style), paints: style.paints.map((p) => p.type) })),
        effect: effect.map((style) => ({ ...base(style), effects: style.effects.map((e) => e.type) })),
        grid: grid.map(base),
      }
    },
  },

  {
    name: 'variables.get',
    summary: 'Variable collections, modes and values — the same snapshot the token export reads.',
    mutates: false,
    params: {
      library: {
        type: 'boolean',
        default: false,
        description:
          'Include variables from enabled libraries. Off by default: that sweep imports every variable ' +
          'of every enabled collection one by one and can take minutes on a large file. Use ' +
          '`library.collections` + `library.variables` to read one library collection instead.',
      },
      collection: {
        type: 'string',
        description: 'Only this collection, by name or id. Omitted returns them all.',
      },
      limit: { type: 'number', default: 2000, min: 1, max: 20000, description: 'Cap on variables returned.' },
    },
    async run(params) {
      const snapshot = params.library === true ? await readAllVariables() : await readLocalVariables()
      const wanted = typeof params.collection === 'string' ? params.collection.toLowerCase() : null
      const collections = wanted
        ? snapshot.collections.filter(
            (entry) => entry.id === params.collection || entry.name.toLowerCase() === wanted
          )
        : snapshot.collections
      if (wanted && collections.length === 0) {
        throw new Error(
          `no collection "${params.collection}" — this file has: ${snapshot.collections.map((c) => c.name).join(', ')}`
        )
      }
      const keep = new Set(collections.map((entry) => entry.id))
      const variables = snapshot.variables.filter((entry) => keep.has(entry.collectionId))
      const limit = params.limit as number
      return {
        collections,
        total: variables.length,
        truncated: variables.length > limit,
        variables: variables.slice(0, limit),
      }
    },
  },

  {
    name: 'flow.map',
    summary: 'Prototype graph of a page: starting points plus every reaction edge between frames.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Page id. Defaults to the page the designer is on.' },
    },
    async run(params) {
      const page = await resolvePage(params.pageId)
      const named = new Map<string, string>()
      for (const node of page.children) named.set(node.id, node.name)

      const edges: Array<{ from: string; fromName: string; to: string; toName: string | null; trigger: string; action: string }> = []
      const withReactions = await findAllWithCriteria(
        page,
        (node): node is SceneNode => 'reactions' in node || 'getReactionsAsync' in node
      )
      for (const node of withReactions) {
        const anyNode = node as any
        const raw =
          typeof anyNode.getReactionsAsync === 'function' ? await anyNode.getReactionsAsync() : anyNode.reactions
        for (const reaction of summarizeReactions(raw)) {
          if (!reaction.destinationId) continue
          edges.push({
            from: node.id,
            fromName: node.name,
            to: reaction.destinationId,
            toName: named.get(reaction.destinationId) ?? null,
            trigger: reaction.trigger,
            action: reaction.action,
          })
        }
      }

      return {
        page: { id: page.id, name: page.name },
        // `flowStartingPoints` is the designer's own declaration of where a flow begins —
        // better ground truth than guessing from in-degree.
        startingPoints: page.flowStartingPoints.map((point) => ({
          nodeId: point.nodeId,
          name: point.name,
        })),
        frames: page.children
          .filter((node) => node.type === 'FRAME')
          .map((node) => ({ id: node.id, name: node.name })),
        edges,
      }
    },
  },

  {
    name: 'library.collections',
    summary: 'Variable collections published by libraries enabled in this file — the other file’s tokens.',
    mutates: false,
    params: {},
    async run() {
      // Deliberately unguarded: when this throws, that *is* the answer (the library is not
      // enabled here, or the plugin lacks the teamlibrary permission), and swallowing it would
      // report "no libraries" for a file that simply never asked.
      const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
      return collections.map((collection) => ({
        key: collection.key,
        name: collection.name,
        libraryName: collection.libraryName,
      }))
    },
  },

  {
    name: 'library.variables',
    summary: 'Variables inside one library collection, with their values — read a palette from another file.',
    mutates: false,
    params: {
      collectionKey: {
        type: 'string',
        required: true,
        description: 'Library collection key, from `library.collections`.',
      },
      values: {
        type: 'boolean',
        default: true,
        description: 'Import each variable to read its per-mode values. Off returns names and types only.',
      },
      limit: { type: 'number', default: 400, min: 1, max: 2000, description: 'Cap on variables returned.' },
    },
    async run(params) {
      const key = params.collectionKey as string
      const entries = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(key)
      const capped = entries.slice(0, params.limit as number)
      if (params.values === false) {
        return {
          collectionKey: key,
          total: entries.length,
          variables: capped.map((entry) => ({ key: entry.key, name: entry.name, resolvedType: entry.resolvedType })),
        }
      }

      const variables: Array<Record<string, unknown>> = []
      let modes: Array<{ modeId: string; name: string }> = []
      let collectionName: string | null = null
      for (const entry of capped) {
        try {
          const imported = await figma.variables.importVariableByKeyAsync(entry.key)
          if (modes.length === 0) {
            const collection = await figma.variables.getVariableCollectionByIdAsync(imported.variableCollectionId)
            if (collection) {
              collectionName = collection.name
              modes = collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
            }
          }
          variables.push({
            key: imported.key,
            id: imported.id,
            name: imported.name,
            resolvedType: imported.resolvedType,
            valuesByMode: imported.valuesByMode,
          })
        } catch (err) {
          variables.push({ key: entry.key, name: entry.name, error: String((err as Error)?.message || err) })
        }
      }
      return { collectionKey: key, collectionName, modes, total: entries.length, variables }
    },
  },

  {
    name: 'lint.colors',
    summary: 'Layers painted with a raw colour instead of a variable — exactly what a recolor cannot reach.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Page id. Defaults to the page the designer is on.' },
      scope: {
        type: 'string',
        default: 'page',
        enum: ['page', 'document'],
        description: 'Where to look. `document` walks every page and is slow on a big file.',
      },
      limit: { type: 'number', default: 300, min: 1, max: 5000, description: 'Cap on findings returned.' },
    },
    async run(params) {
      const pages: PageNode[] =
        params.scope === 'document'
          ? (await loadAllPagesAsync(), figma.root.children.slice())
          : [await resolvePage(params.pageId)]

      const findings: Array<LintFinding & { page: string }> = []
      for (const page of pages) {
        const roots = page.children.filter((node): node is SceneNode => 'visible' in node)
        for (const finding of await lintScopeAsync(roots)) {
          if (finding.rule !== 'unbound-fill' && finding.rule !== 'unbound-stroke') continue
          findings.push({ ...finding, page: page.name })
        }
      }

      const byRule: Record<string, number> = {}
      for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1
      return {
        scope: params.scope,
        pages: pages.map((page) => page.name),
        total: findings.length,
        byRule,
        findings: findings.slice(0, params.limit as number),
      }
    },
  },

  {
    name: 'sandbox.capabilities',
    summary: 'What this plugin runtime allows — including whether it can evaluate code at all.',
    mutates: false,
    params: {},
    async run() {
      // Whether the Figma sandbox evaluates code decides whether a general "run this against
      // the Plugin API" op is even buildable, or whether full coverage has to come from named
      // ops. Cheaper to ask the runtime than to argue about it.
      const probe = (label: string, run: () => unknown) => {
        try {
          return { [label]: run() === 2 }
        } catch (err) {
          return { [label]: String((err as Error)?.message || err) }
        }
      }
      return {
        apiVersion: figma.apiVersion,
        editorType: figma.editorType,
        fileName: figma.root.name,
        fileKey: figma.fileKey ?? null,
        ...probe('eval', () => (0, eval)('1 + 1')),
        ...probe('newFunction', () => new Function('return 1 + 1')()),
      }
    },
  },
]

export const ALL_OPS: readonly OpDef[] = [...READ_OPS, ...CONTEXT_OPS, ...TRANSITION_OPS, ...WRITE_OPS]

export const OPS_BY_NAME: ReadonlyMap<string, OpDef> = new Map(ALL_OPS.map((op) => [op.name, op]))
