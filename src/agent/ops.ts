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
import { readAllVariables, readLocalVariables } from '../variables.ts'
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

  if (node.type === 'TEXT' && typeof node.characters === 'string') {
    summary.text =
      node.characters.length > MAX_TEXT ? node.characters.slice(0, MAX_TEXT) + '…' : node.characters
  }

  if (Array.isArray(node.children)) summary.childCount = node.children.length

  return summary
}

/** Full description of one node: `summarizeNode` plus the awaited bits, recursing `depth`
 * levels of children. Depth is capped by the op's param spec, so the payload stays bounded. */
async function describeNode(node: any, depth: number): Promise<NodeSummary> {
  const summary = summarizeNode(node)

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
