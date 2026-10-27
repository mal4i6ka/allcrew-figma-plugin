/**
 * Agent listener — components and the copies they left behind.
 *
 * `components.list` says what exists and `component.api` says what one of them takes. Neither
 * says the thing a designer actually asks before touching a component: **who is using it, how
 * many, and where**. Figma answers that in the UI and nowhere else — the Plugin API has
 * `ComponentNode.getInstancesAsync()`, and nothing that walks the other way for a main that is
 * no longer there.
 *
 * That gap is the whole reason this file exists. When a main component is deleted, Figma does
 * NOT break its instances: they keep rendering, keep their overrides, and keep pointing at a
 * main that has no page, no parent and no way back. The designer sees layers that look fine and
 * cannot be edited from a library; every read in this channel until now reported them as
 * ordinary instances. So:
 *
 *   - `component.instances` — the census: every copy of a component, which page and which frame
 *     it sits in, whether it is nested inside another instance, and the deep link to jump to it.
 *     With no target it inverts into an inventory: what is used how much, and what nothing uses.
 *   - `component.orphans` — the copies whose main is gone, grouped by the main that died, each
 *     group carrying the instances that are rich enough to rebuild it from.
 *   - `component.restore` — rebuild that main out of one of its orphans and relink the rest.
 *   - `instance.swap` — repoint instances onto another main, preserving overrides.
 *
 * The last two share one engine, and it is the point of the feature: `swapComponent` preserves
 * overrides "using the same heuristics as the Figma UI", which is a promise about *most* of
 * them, not all — and the failure mode is silent, a text layer quietly back to "Label" after a
 * repair nobody watched. So every swap here snapshots the overrides first, swaps, diffs the
 * result against the snapshot, writes back what the heuristics dropped, and reports per layer
 * what was kept, what was restored, and what could not be — named, never rounded off to "done".
 *
 * There is a second strategy for when the first one cannot run. In the editor a designer fixes
 * an unswappable copy by hand: place a fresh instance of the right main next to it, redo the
 * overrides on that one, cut it, select the broken one and ⌘⇧R (paste to replace). The Plugin
 * API has no clipboard and no "paste to replace" — but every step except the clipboard hop is
 * reachable, and the hop exists only because a person needs somewhere to hold the node.
 * `strategy: "rebuild"` is that same repair without it: instantiate the good main, replay the
 * snapshot onto the new copy, insert it at the old one's index with its geometry and layout
 * flags, then delete the old one. It is what runs when `swapComponent` refuses (Figma rejects
 * some swaps outright), and it is exact where the swap is heuristic — at the price of a NEW node
 * id, which prototype links pointing at the old node do not follow. Both facts are in the report.
 */

import { componentFor } from '../canvas/components.ts'
import { ParamError, type OpDef, type ParamSpec } from './protocol.ts'
import { findAllByTypes } from '../utils/tree.ts'
import { checkpoint, enforceDeadline } from '../utils/budget.ts'
import { pageOf } from './scope.ts'
import { openSweep, resolveSweepRoots, SWEEP_PARAMS, type Sweep, type SweepReport } from './sweep.ts'

/* ------------------------------------------------------------------ basics */



/** `?node-id=1-23` — the suffix `node.focus` hands back, so a row can be jumped to directly. */
function deepLink(id: string): string {
  return `?node-id=${id.replace(':', '-')}`
}

/** Names from the top-level frame down to the node's parent, plus whether an INSTANCE is in
 * that chain: a copy inside another copy is an override mirror, not a layer a designer placed. */
function ancestry(node: SceneNode): { path: string[]; nested: boolean } {
  const names: string[] = []
  let nested = false
  let walk: BaseNode | null = node.parent
  while (walk && walk.type !== 'PAGE' && walk.type !== 'DOCUMENT') {
    if (walk.type === 'INSTANCE') nested = true
    names.unshift(walk.name)
    walk = walk.parent
  }
  return { path: names, nested }
}

export interface InstanceRow {
  id: string
  name: string
  page: string | null
  pageId: string | null
  /** Frame chain from the page down to the parent, e.g. `Checkout / Summary / Row`. */
  path: string
  /** Inside another instance — an override mirror rather than a placed copy. */
  nested: boolean
  x?: number
  y?: number
  /** Fields the designer changed on this copy. Zero means it is the component as authored. */
  overrides: number
  /** Feed straight to `node.focus`, or paste after the file URL. */
  link: string
}

function describeInstance(instance: InstanceNode): InstanceRow {
  const page = pageOf(instance)
  const { path, nested } = ancestry(instance)
  let overrides = 0
  try {
    overrides = instance.overrides.length
  } catch {
    overrides = 0
  }
  return {
    id: instance.id,
    name: instance.name,
    page: page ? page.name : null,
    pageId: page ? page.id : null,
    path: path.join(' / '),
    nested,
    x: Number.isFinite(instance.x) ? Math.round(instance.x * 100) / 100 : undefined,
    y: Number.isFinite(instance.y) ? Math.round(instance.y * 100) / 100 : undefined,
    overrides,
    link: deepLink(instance.id),
  }
}

/* ------------------------------------------------------------ main identity */

export type MainStatus = 'live' | 'deleted' | 'missing'

export interface MainFacts {
  id: string | null
  key: string | null
  name: string | null
  remote: boolean
  setId?: string
  setName?: string
  status: MainStatus
  /** What the group is keyed by — the set when there is one, else the component, else the name
   * (a main Figma cannot resolve at all has no id to key on). */
  identity: string
}

/**
 * Pure half of the diagnosis, so the rule is testable without a document.
 *
 * `null` means Figma would not hand the main over at all — a library component whose file is
 * unreachable, or one deleted upstream. A main that IS handed over but sits on no page is the
 * interesting case: deleting a main in Figma does not delete the node, it unparents it, and the
 * instances go on rendering from a component nothing can reach. A REMOTE main is never on a page
 * of THIS file by definition, so the same test would call every library instance an orphan —
 * hence the `remote` branch.
 */
export function classifyMain(main: { removed?: boolean; remote?: boolean } | null, onPage: boolean): MainStatus {
  if (!main) return 'missing'
  if (main.removed === true) return 'deleted'
  if (main.remote === true) return 'live'
  return onPage ? 'live' : 'deleted'
}

async function readMain(instance: InstanceNode): Promise<MainFacts> {
  let main: ComponentNode | null = null
  try {
    main = await instance.getMainComponentAsync()
  } catch {
    main = null
  }
  if (!main) {
    return { id: null, key: null, name: null, remote: false, status: 'missing', identity: `name:${instance.name}` }
  }
  let removed = false
  try {
    removed = main.removed === true
  } catch {
    removed = false
  }
  const parent = main.parent
  const set = parent && parent.type === 'COMPONENT_SET' ? parent : null
  return {
    id: main.id,
    key: main.key || null,
    name: main.name,
    remote: main.remote === true,
    ...(set ? { setId: set.id, setName: set.name } : {}),
    status: classifyMain({ removed, remote: main.remote === true }, pageOf(main) !== null),
    identity: set ? set.id : main.id,
  }
}

/* -------------------------------------------------- override snapshot engine */

interface FieldHandler {
  read: (node: SceneNode) => unknown
  write: (node: SceneNode, value: unknown) => void | Promise<void>
}

/** A node addressed by a field name out of {@link FIELDS}. The cast is unchecked on purpose and
 * cannot be narrowed: the field names come from Figma's own `overriddenFields`, and every one of
 * them is a property this table already decided is readable and writable by plain assignment. */
function fields(node: SceneNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>
}

function assign(field: string): FieldHandler {
  return {
    read: (node) => fields(node)[field],
    write: (node, value) => {
      fields(node)[field] = value
    },
  }
}

/** Style ids are write-only through their async setter under `documentAccess: "dynamic-page"`;
 * the plain assignment still exists on older runtimes and in test doubles, so both are tried. */
function styleId(field: string, setter: string): FieldHandler {
  return {
    read: (node) => fields(node)[field],
    write: async (node, value) => {
      const holder = fields(node)
      const set = holder[setter]
      if (typeof set === 'function') await (set as (id: string) => Promise<void>).call(node, String(value ?? ''))
      else holder[field] = value
    },
  }
}

async function writeCharacters(node: SceneNode, value: unknown): Promise<void> {
  if (node.type !== 'TEXT') throw new Error(`characters is not writable on ${node.type}`)
  /* Every font in the node has to be loaded before a single character can be written, and a
   * text layer with mixed styling has several — `fontName` alone is `figma.mixed` there, which
   * is exactly the layer whose restore would otherwise fail after the swap already happened. */
  const fonts: FontName[] = []
  try {
    fonts.push(...node.getRangeAllFontNames(0, Math.max(node.characters.length, 1)))
  } catch {
    const single = node.fontName
    if (typeof single === 'object') fonts.push(single)
  }
  for (const font of fonts) await figma.loadFontAsync(font)
  node.characters = String(value ?? '')
}

function resizeTo(node: SceneNode, width: number, height: number): void {
  if (!('resizeWithoutConstraints' in node)) throw new Error(`${node.type} cannot be resized`)
  node.resizeWithoutConstraints(width, height)
}

/**
 * The fields a swap is allowed to carry over. Deliberately a list rather than "assign whatever
 * `overriddenFields` names": `parent`, `type` and `componentPropertyDefinitions` are also
 * NodeChangeProperty values, and writing those blind is how a repair turns into damage. Anything
 * outside this table is reported as `unsupported`, never silently dropped.
 */
const FIELDS: Readonly<Record<string, FieldHandler>> = {
  characters: { read: (node) => (node.type === 'TEXT' ? node.characters : undefined), write: writeCharacters },
  fontSize: assign('fontSize'),
  fontName: assign('fontName'),
  letterSpacing: assign('letterSpacing'),
  lineHeight: assign('lineHeight'),
  textCase: assign('textCase'),
  textDecoration: assign('textDecoration'),
  textAlignHorizontal: assign('textAlignHorizontal'),
  textAlignVertical: assign('textAlignVertical'),
  textAutoResize: assign('textAutoResize'),
  textTruncation: assign('textTruncation'),
  maxLines: assign('maxLines'),
  paragraphIndent: assign('paragraphIndent'),
  paragraphSpacing: assign('paragraphSpacing'),
  hyperlink: assign('hyperlink'),
  fills: assign('fills'),
  strokes: assign('strokes'),
  strokeWeight: assign('strokeWeight'),
  strokeAlign: assign('strokeAlign'),
  dashPattern: assign('dashPattern'),
  effects: assign('effects'),
  opacity: assign('opacity'),
  blendMode: assign('blendMode'),
  visible: assign('visible'),
  locked: assign('locked'),
  name: assign('name'),
  isMask: assign('isMask'),
  clipsContent: assign('clipsContent'),
  cornerRadius: assign('cornerRadius'),
  cornerSmoothing: assign('cornerSmoothing'),
  topLeftRadius: assign('topLeftRadius'),
  topRightRadius: assign('topRightRadius'),
  bottomLeftRadius: assign('bottomLeftRadius'),
  bottomRightRadius: assign('bottomRightRadius'),
  constraints: assign('constraints'),
  layoutAlign: assign('layoutAlign'),
  layoutGrow: assign('layoutGrow'),
  layoutPositioning: assign('layoutPositioning'),
  layoutMode: assign('layoutMode'),
  layoutWrap: assign('layoutWrap'),
  layoutSizingHorizontal: assign('layoutSizingHorizontal'),
  layoutSizingVertical: assign('layoutSizingVertical'),
  itemSpacing: assign('itemSpacing'),
  counterAxisSpacing: assign('counterAxisSpacing'),
  paddingLeft: assign('paddingLeft'),
  paddingRight: assign('paddingRight'),
  paddingTop: assign('paddingTop'),
  paddingBottom: assign('paddingBottom'),
  primaryAxisSizingMode: assign('primaryAxisSizingMode'),
  counterAxisSizingMode: assign('counterAxisSizingMode'),
  primaryAxisAlignItems: assign('primaryAxisAlignItems'),
  counterAxisAlignItems: assign('counterAxisAlignItems'),
  counterAxisAlignContent: assign('counterAxisAlignContent'),
  minWidth: assign('minWidth'),
  maxWidth: assign('maxWidth'),
  minHeight: assign('minHeight'),
  maxHeight: assign('maxHeight'),
  exportSettings: assign('exportSettings'),
  reactions: {
    read: (node) => ('reactions' in node ? node.reactions : undefined),
    write: async (node, value) => {
      const holder = fields(node)
      const set = holder.setReactionsAsync
      if (typeof set === 'function') await (set as (reactions: unknown) => Promise<void>).call(node, value)
      else holder.reactions = value
    },
  },
  fillStyleId: styleId('fillStyleId', 'setFillStyleIdAsync'),
  strokeStyleId: styleId('strokeStyleId', 'setStrokeStyleIdAsync'),
  textStyleId: styleId('textStyleId', 'setTextStyleIdAsync'),
  effectStyleId: styleId('effectStyleId', 'setEffectStyleIdAsync'),
  gridStyleId: styleId('gridStyleId', 'setGridStyleIdAsync'),
  width: { read: (node) => node.width, write: (node, value) => resizeTo(node, Number(value), node.height) },
  height: { read: (node) => node.height, write: (node, value) => resizeTo(node, node.width, Number(value)) },
}

/** Overridden fields worth no attempt at all: they describe where the node is, not what it is,
 * and a swap re-parents nothing. Listed so they never show up as `unsupported` noise. */
const IGNORED_FIELDS: Readonly<Record<string, true>> = {
  parent: true,
  type: true,
  pluginData: true,
  expanded: true,
  componentPropertyDefinitions: true,
  componentPropertyReferences: true,
}

export interface LayerSnapshot {
  /** Child indexes from the instance down to this node. Empty means the instance itself. */
  path: number[]
  name: string
  type: string
  fields: Record<string, unknown>
  /** Nested instances carry their own property values, which a swap resets to the new main's. */
  properties?: Record<string, string | boolean>
  /** Overridden fields this engine will not write back — named, because a silent drop is the
   * exact failure this whole op exists to prevent. */
  unsupported: string[]
}

export interface InstanceSnapshot {
  /** The instance's own component properties (variant axes, text props, booleans, swaps). */
  properties: Record<string, string | boolean>
  layers: LayerSnapshot[]
  /** Fields counted across every layer — what the report's `kept + restored + lost` sums to. */
  captured: number
}

function isMixed(value: unknown): boolean {
  return typeof figma !== 'undefined' && figma.mixed !== undefined && value === figma.mixed
}

/** Structural equality good enough for paints, effects and layout numbers. `figma.mixed` never
 * compares equal to anything, which is the honest answer for a value nobody can write back. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isMixed(a) || isMixed(b)) return false
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function readProperties(node: SceneNode): Record<string, string | boolean> | undefined {
  if (node.type !== 'INSTANCE') return undefined
  let props: ComponentProperties
  try {
    props = node.componentProperties
  } catch {
    return undefined
  }
  if (!props || typeof props !== 'object') return undefined
  const out: Record<string, string | boolean> = {}
  for (const [key, entry] of Object.entries(props)) {
    const value = entry?.value
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function pathFrom(instance: BaseNode, node: BaseNode): number[] | null {
  const path: number[] = []
  let walk: BaseNode = node
  while (walk.id !== instance.id) {
    const parent: BaseNode | null = walk.parent
    if (!parent || !('children' in parent)) return null
    const child = walk
    const index = parent.children.findIndex((one) => one.id === child.id)
    if (index < 0) return null
    path.unshift(index)
    walk = parent
  }
  return path
}

function nodeAt(instance: SceneNode, path: readonly number[]): SceneNode | null {
  let cursor: SceneNode = instance
  for (const index of path) {
    if (!('children' in cursor)) return null
    const child = cursor.children[index]
    if (!child) return null
    cursor = child
  }
  return cursor
}

function findByName(root: SceneNode, name: string, type: string): SceneNode | null {
  const queue: SceneNode[] = [root]
  while (queue.length > 0) {
    const node = queue.shift() as SceneNode
    if (node !== root && node.name === name && node.type === type) return node
    if ('children' in node) queue.push(...node.children)
  }
  return null
}

/**
 * Everything the designer changed on this copy, addressed by position rather than by node id:
 * the ids on the far side of a swap are new, so an id-keyed snapshot would be unusable exactly
 * when it is needed. `instance.overrides` names the layers and the fields; the values come from
 * the layers themselves, because the override table carries none.
 */
export async function captureOverrides(instance: InstanceNode): Promise<InstanceSnapshot> {
  const snapshot: InstanceSnapshot = { properties: readProperties(instance) ?? {}, layers: [], captured: 0 }
  let entries: ReadonlyArray<{ id: string; overriddenFields: readonly string[] }> = []
  try {
    entries = instance.overrides
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const found = await figma.getNodeByIdAsync(entry.id)
    if (!found || found.type === 'PAGE' || found.type === 'DOCUMENT') continue
    const node: SceneNode = found
    const path = pathFrom(instance, node)
    if (path === null) continue
    const values: Record<string, unknown> = {}
    const unsupported: string[] = []
    for (const field of entry.overriddenFields ?? []) {
      if (IGNORED_FIELDS[field]) continue
      if (field === 'componentProperties') continue // carried by `properties` below
      const handler = FIELDS[field]
      if (!handler) {
        unsupported.push(field)
        continue
      }
      try {
        const value = handler.read(node)
        if (value === undefined) continue
        if (isMixed(value)) unsupported.push(field)
        else values[field] = value
      } catch {
        unsupported.push(field)
      }
    }
    const properties = node.id === instance.id ? undefined : readProperties(node)
    if (Object.keys(values).length === 0 && !properties && unsupported.length === 0) continue
    snapshot.captured += Object.keys(values).length
    snapshot.layers.push({
      path,
      name: node.name,
      type: node.type,
      fields: values,
      ...(properties ? { properties } : {}),
      unsupported,
    })
  }
  return snapshot
}

export interface OverrideReport {
  captured: number
  /** Fields the swap carried over by itself — nothing to do. */
  kept: number
  /** Fields this op wrote back because the swap dropped them. */
  restored: Array<{ layer: string; path: number[]; fields: string[]; matchedBy: 'path' | 'name' }>
  /** Fields nobody could put back, with the reason — a layer the new main does not have, a
   * value the API will not write, or a write Figma refused. */
  lost: Array<{ layer: string; path: number[]; fields: string[]; reason: string }>
  properties: { kept: string[]; restored: string[]; dropped: string[] }
}

async function applyProperties(
  instance: InstanceNode,
  wanted: Record<string, string | boolean>
): Promise<{ kept: string[]; restored: string[]; dropped: string[] }> {
  const kept: string[] = []
  const restored: string[] = []
  const dropped: string[] = []
  const current = readProperties(instance) ?? {}
  /* `Label#12:3` and `Label#98:7` are the same property to a designer and different strings to
   * the API — two mains never share the suffix, so the base name is the only bridge across a
   * swap. Exact key first; the base name is the fallback. */
  const byBase: Record<string, string> = {}
  for (const key of Object.keys(current)) {
    const hash = key.lastIndexOf('#')
    byBase[hash > 0 ? key.slice(0, hash) : key] = key
  }

  const writes: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(wanted)) {
    const hash = key.lastIndexOf('#')
    const target = key in current ? key : byBase[hash > 0 ? key.slice(0, hash) : key]
    if (!target) {
      dropped.push(key)
      continue
    }
    if (current[target] === value) kept.push(target)
    else writes[target] = value
  }
  if (Object.keys(writes).length > 0) {
    try {
      instance.setProperties(writes)
      restored.push(...Object.keys(writes))
    } catch {
      /* One bad key refuses the whole call, so the batch is retried one key at a time: a variant
       * axis the new main does not have must not cost the text property that it does. */
      for (const [key, value] of Object.entries(writes)) {
        try {
          instance.setProperties({ [key]: value })
          restored.push(key)
        } catch {
          dropped.push(key)
        }
      }
    }
  }
  return { kept, restored, dropped }
}

/**
 * The repair pass. Runs AFTER the swap (or onto a freshly built copy), compares what the
 * instance renders now against the snapshot taken before, and writes back only what differs — so
 * a heuristic that already did the right thing is left alone, and one that dropped a value is
 * corrected.
 */
export async function restoreOverrides(instance: InstanceNode, snapshot: InstanceSnapshot): Promise<OverrideReport> {
  const report: OverrideReport = {
    captured: snapshot.captured,
    kept: 0,
    restored: [],
    lost: [],
    properties: await applyProperties(instance, snapshot.properties),
  }

  for (const layer of snapshot.layers) {
    const fieldNames = Object.keys(layer.fields)
    if (layer.unsupported.length > 0) {
      report.lost.push({
        layer: layer.name,
        path: layer.path,
        fields: layer.unsupported,
        reason: 'field is not writable through the Plugin API',
      })
    }
    if (fieldNames.length === 0 && !layer.properties) continue

    let target = layer.path.length === 0 ? instance : nodeAt(instance, layer.path)
    let matchedBy: 'path' | 'name' = 'path'
    if (!target || target.type !== layer.type || target.name !== layer.name) {
      const byName = findByName(instance, layer.name, layer.type)
      if (byName) {
        target = byName
        matchedBy = 'name'
      } else if (!target || target.type !== layer.type) {
        report.lost.push({
          layer: layer.name,
          path: layer.path,
          fields: fieldNames,
          reason: 'the new main has no layer at that position or by that name',
        })
        continue
      }
    }

    const written: string[] = []
    for (const [field, value] of Object.entries(layer.fields)) {
      const handler = FIELDS[field]
      if (!handler) continue
      let now: unknown
      try {
        now = handler.read(target)
      } catch {
        now = undefined
      }
      if (sameValue(now, value)) {
        report.kept += 1
        continue
      }
      try {
        await handler.write(target, value)
        if (sameValue(handler.read(target), value)) written.push(field)
        else report.lost.push({ layer: layer.name, path: layer.path, fields: [field], reason: 'the write did not stick' })
      } catch (err) {
        report.lost.push({
          layer: layer.name,
          path: layer.path,
          fields: [field],
          reason: String((err as Error)?.message || err),
        })
      }
    }
    if (layer.properties && target.type === 'INSTANCE') {
      const nested = await applyProperties(target, layer.properties)
      report.properties.kept.push(...nested.kept)
      report.properties.restored.push(...nested.restored)
      report.properties.dropped.push(...nested.dropped)
    }
    if (written.length > 0) report.restored.push({ layer: layer.name, path: layer.path, fields: written, matchedBy })
  }
  return report
}
function productReport(report: OverrideReport): {
  preserved: number
  kept: number
  restored: OverrideReport['restored']
  lost: OverrideReport['lost']
  unsupported: Array<{ layer: string; field: string }>
} {
  const unsupportedRows = report.lost.filter((row) => row.reason === 'field is not writable through the Plugin API')
  return {
    preserved: report.kept,
    kept: report.kept,
    restored: report.restored,
    lost: report.lost.filter((row) => row.reason !== 'field is not writable through the Plugin API'),
    unsupported: unsupportedRows.flatMap((row) => row.fields.map((field) => ({ layer: row.layer, field }))),
  }
}


/* ------------------------------------------------------- swap and rebuild */

export type SwapStrategy = 'auto' | 'swap' | 'rebuild'

export interface SwapOutcome {
  method: 'swap' | 'rebuild'
  /** Set by a rebuild: the replacement is a NEW node, and this is its id. */
  newId?: string
  overrides?: OverrideReport
  preserved?: number
  kept?: number
  restored?: OverrideReport['restored']
  lost?: OverrideReport['lost']
  unsupported?: Array<{ layer: string; field: string }>
  note?: string
  /** Why the rebuild ran, when `swapComponent` was tried first and refused. */
  fellBackBecause?: string
}

/** Geometry and layout the replacement has to inherit — they belong to the SLOT, not to the
 * component, so a fresh instance would otherwise land at the wrong size in the wrong place. */
const SLOT_FIELDS = [
  'visible',
  'locked',
  'opacity',
  'blendMode',
  'rotation',
  'constraints',
  'layoutAlign',
  'layoutGrow',
  'layoutPositioning',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'exportSettings',
] as const

/**
 * The editor's own repair, minus the clipboard: instantiate the good main, replay the snapshot
 * onto it, put it where the broken copy was, delete the broken copy. What a designer does with
 * ⌘⇧R, which no Plugin API call exposes — `figma.currentPage.selection` and paste-to-replace are
 * UI state, not API.
 *
 * Exact where `swapComponent` is heuristic, and the price is a new node id: prototype reactions
 * that pointed AT the old node (its own are copied) do not follow, and neither does anything
 * else keyed by id. Refused inside another instance, because nothing can be inserted into an
 * instance's subtree — there the swap is the only route.
 */
async function rebuildInPlace(
  instance: InstanceNode,
  main: ComponentNode,
  snapshot: InstanceSnapshot | null
): Promise<SwapOutcome> {
  const parent = instance.parent
  if (!parent || !('children' in parent)) throw new Error(`"${instance.name}" has no parent to insert a replacement into`)
  for (let walk: BaseNode | null = parent; walk && walk.type !== 'PAGE'; walk = walk.parent) {
    if (walk.type === 'INSTANCE') {
      throw new Error(
        `"${instance.name}" is nested inside an instance — nothing can be inserted there; strategy "swap" is the only route for it`
      )
    }
  }

  const index = parent.children.findIndex((child) => child.id === instance.id)
  const fresh = main.createInstance()
  parent.insertChild(index < 0 ? parent.children.length : index, fresh)

  try {
    fresh.name = instance.name
    const source = fields(instance)
    const replacement = fields(fresh)
    const horizontal = source.layoutSizingHorizontal
    const vertical = source.layoutSizingVertical
    try {
      replacement.layoutSizingHorizontal = 'FIXED'
      replacement.layoutSizingVertical = 'FIXED'
      if (Number.isFinite(instance.width) && Number.isFinite(instance.height)) fresh.resize(instance.width, instance.height)
    } catch {
      /* Auto-layout parents can own their children's size; the remaining slot fields still
       * preserve every value the replacement accepts. */
    }
    for (const field of SLOT_FIELDS) {
      if (field === 'layoutSizingHorizontal' || field === 'layoutSizingVertical') continue
      const value = source[field]
      if (value === undefined || isMixed(value)) continue
      try {
        replacement[field] = value
      } catch {
        /* A layout flag the new main refuses is the component's sizing decision. */
      }
    }
    if (horizontal !== undefined && !isMixed(horizontal)) replacement.layoutSizingHorizontal = horizontal
    if (vertical !== undefined && !isMixed(vertical)) replacement.layoutSizingVertical = vertical
    fresh.x = instance.x
    fresh.y = instance.y
    for (const key of instance.getPluginDataKeys()) fresh.setPluginData(key, instance.getPluginData(key))
    if ('reactions' in instance && 'setReactionsAsync' in fresh) {
      await fresh.setReactionsAsync(instance.reactions.slice())
    }

    const overrides = snapshot ? await restoreOverrides(fresh, snapshot) : undefined
    instance.remove()
    return {
      method: 'rebuild',
      newId: fresh.id,
      ...(overrides ? { overrides, ...productReport(overrides) } : {}),
      note: 'rebuilt in place — NEW node id; prototype links pointing at the old node, and anything else keyed by its id, do not follow',
    }
  } catch (error) {
    fresh.remove()
    throw error
  }
}

/** One instance repointed onto `main`. Shared by `instance.swap` and `component.restore`. */
async function repoint(
  instance: InstanceNode,
  main: ComponentNode,
  preserve: boolean,
  strategy: SwapStrategy
): Promise<SwapOutcome> {
  const snapshot = preserve ? await captureOverrides(instance) : null
  if (strategy === 'rebuild') return rebuildInPlace(instance, main, snapshot)

  try {
    instance.swapComponent(main)
  } catch (err) {
    const why = String((err as Error)?.message || err)
    /* Figma refuses some swaps outright. `auto` is what makes the op finish anyway: the same
     * repair a designer would do by hand with ⌘⇧R, driven from the snapshot already in hand. */
    if (strategy !== 'auto') throw err
    const rebuilt = await rebuildInPlace(instance, main, snapshot)
    return { ...rebuilt, fellBackBecause: why }
  }
  if (!snapshot) return { method: 'swap', note: 'overrides not preserved — preserveOverrides was false' }
  const overrides = await restoreOverrides(instance, snapshot)
  return { method: 'swap', overrides, ...productReport(overrides) }
}

/* -------------------------------------------------------------- the census */

type CensusGroup = {
  facts: MainFacts
  rows: InstanceRow[]
  total: number
  nested: number
  variants: Map<string, number>
  pages: Map<string, number>
}

type DetachedRow = {
  id: string
  name: string
  page: string | null
  was: string
  origin: 'local' | 'library'
  verified: boolean
  link: string
}

type SweepPhase = 'targets' | 'instances' | 'unused' | 'detached'

function phaseCursor(params: Record<string, unknown>): { phase: SweepPhase | null; cursor?: string } {
  if (typeof params.cursor !== 'string' || params.cursor === '') return { phase: null }
  const split = params.cursor.indexOf(':')
  const phase = params.cursor.slice(0, split) as SweepPhase
  if (split < 1 || !['targets', 'instances', 'unused', 'detached'].includes(phase)) {
    throw new ParamError('cursor is not a component census cursor; start over without it')
  }
  return { phase, cursor: params.cursor.slice(split + 1) }
}

function paramsForPhase(params: Record<string, unknown>, cursor?: string): Record<string, unknown> {
  return { ...params, cursor }
}

function reportForPhase(report: SweepReport, phase: SweepPhase): SweepReport {
  return report.cursor ? { ...report, cursor: `${phase}:${report.cursor}` } : report
}

function unfinished(report: SweepReport, labels: readonly string[], phase: SweepPhase): Record<string, unknown> {
  return {
    ...reportForPhase(report, phase),
    scope: { pages: labels },
    note: 'The sweep is not complete; call again with the same params plus `cursor`.',
  }
}

function countBy<T>(rows: readonly T[], key: (row: T) => string | null): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const name = key(row)
    if (name === null) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

async function targetIds(params: Record<string, unknown>): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof params.nodeId !== 'string' || params.nodeId === '') return ids
  const node = await figma.getNodeByIdAsync(params.nodeId)
  if (!node) throw new Error(`no node with id ${params.nodeId}`)
  if (node.type === 'INSTANCE') {
    const facts = await readMain(node)
    ids.add(facts.identity)
    if (facts.id) ids.add(facts.id)
  } else if (node.type === 'COMPONENT_SET') {
    ids.add(node.id)
    for (const child of node.children) ids.add(child.id)
  } else if (node.type === 'COMPONENT') {
    if (params.exact !== true && node.parent?.type === 'COMPONENT_SET') ids.add(node.parent.id)
    ids.add(node.id)
  } else {
    throw new Error(`${node.name} is a ${node.type} — name a component, a set, a variant or an instance`)
  }
  return ids
}

/* ------------------------------------------------------------------- reads */

export const COMPONENT_READ_OPS: readonly OpDef[] = [
  {
    name: 'component.instances',
    summary: 'Every copy of a component: how many, on which pages, and the link to jump to each.',
    agent:
      'The census a designer asks for before touching a component. With `nodeId` (a component, a ' +
      'set, a variant, or any instance of one) it answers for that component: total copies, the ' +
      'split by page and by variant, and a row per copy with its frame path, its override count ' +
      'and a `link` to hand to `node.focus`. With NO target it inverts into an inventory — every ' +
      'component ranked by how many copies it has, plus `unused`, the ones nothing instantiates. ' +
      'On `complete: false`, call again with the same params plus `cursor`; only the completing ' +
      'call contains aggregates. The target lookup, instance census, and unused inventory are ' +
      'separate cursor phases so no page-loading pass is silently skipped.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        description:
          'The component to count: a COMPONENT, a COMPONENT_SET, one variant, or an INSTANCE (which resolves to its own main). Leave it out for the whole-file inventory.',
      },
      name: { type: 'string', description: 'Name substring, when you have no id. Every matching component is reported.' },
      exact: {
        type: 'boolean',
        default: false,
        description: 'Count only the exact variant given, instead of the whole component set it belongs to.',
      },
      scope: { type: 'string', default: 'document', enum: ['page', 'document'], description: 'Where to look for copies.' },
      pageId: { type: 'string', description: 'Search one page — giving it implies scope: "page".' },
      limit: { type: 'number', default: 50, min: 0, max: 1000, description: 'Instance rows listed per component; counts are complete.' },
      components: { type: 'number', default: 40, min: 1, max: 500, description: 'Components listed in inventory mode.' },
      nested: { type: 'boolean', default: false, description: 'Also list copies nested inside other copies. They are always counted.' },
      unused: { type: 'boolean', default: true, description: 'Inventory mode: also list components nothing instantiates.' },
      ...SWEEP_PARAMS,
    },
    async run(params) {
      const started = Date.now()
      const incoming = phaseCursor(params)
      let phase = incoming.phase
      let cursor = incoming.cursor
      let targets: Set<string> | null = null

      if (phase === null || phase === 'targets') {
        const ids = await targetIds(params)
        if (typeof params.name === 'string' && params.name !== '') {
          const targetSweep = await openSweep({
            op: 'component.instances:targets',
            params: paramsForPhase(params, phase === 'targets' ? cursor : undefined),
            roots: () => resolveSweepRoots({ scope: params.scope, pageId: params.pageId }),
            state: () => ({ ids }),
            types: ['COMPONENT', 'COMPONENT_SET'],
          })
          const needle = params.name.toLowerCase()
          await targetSweep.walk((node) => {
            if (node.name.toLowerCase().includes(needle)) {
              if (node.type === 'COMPONENT' && params.exact !== true && node.parent?.type === 'COMPONENT_SET') {
                targetSweep.state.ids.add(node.parent.id)
              }
              targetSweep.state.ids.add(node.id)
            }
          })
          const report = targetSweep.report()
          if (!report.complete) return unfinished(report, targetSweep.labels, 'targets')
          if (targetSweep.state.ids.size === 0) throw new Error(`no component matches "${params.name}"`)
          targets = targetSweep.state.ids
        } else {
          targets = ids.size > 0 ? ids : null
        }
        phase = null
        cursor = undefined
      }

      type State = {
        targets: Set<string> | null
        groups: Map<string, CensusGroup>
        used: Set<string>
        walked: number
        orphans: number
        unused: Array<{ id: string; name: string; type: string; link: string }>
      }

      let state: State
      let labels: readonly string[]
      let report: SweepReport
      if (phase === 'unused') {
        const unusedSweep = await openSweep<State>({
          op: 'component.instances:unused',
          params: paramsForPhase(params, cursor),
          roots: () => resolveSweepRoots({}),
          state: () => {
            throw new Error('unused sweep state is missing')
          },
          types: ['COMPONENT', 'COMPONENT_SET'],
        })
        state = unusedSweep.state
        labels = unusedSweep.labels
        await unusedSweep.walk((node) => {
          if (state.used.has(node.id)) return
          if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') return
          if (node.type === 'COMPONENT_SET' && node.children.some((child) => state.used.has(child.id))) return
          state.unused.push({ id: node.id, name: node.name, type: node.type, link: deepLink(node.id) })
        })
        report = unusedSweep.report()
        if (!report.complete) return unfinished(report, labels, 'unused')
      } else {
        const instanceSweep = await openSweep<State>({
          op: 'component.instances:instances',
          params: paramsForPhase(params, phase === 'instances' ? cursor : undefined),
          roots: () => resolveSweepRoots({ scope: params.scope, pageId: params.pageId }),
          state: () => ({
            targets,
            groups: new Map(),
            used: new Set(),
            walked: 0,
            orphans: 0,
            unused: [],
          }),
          types: ['INSTANCE'],
          includeRoots: true,
        })
        state = instanceSweep.state
        labels = instanceSweep.labels
        await instanceSweep.walk(async (node) => {
          const instance = node as InstanceNode
          const facts = await readMain(instance)
          state.walked += 1
          if (facts.id) state.used.add(facts.id)
          if (facts.setId) state.used.add(facts.setId)
          if (facts.status !== 'live') state.orphans += 1
          if (state.targets && !state.targets.has(facts.identity) && !(facts.id && state.targets.has(facts.id))) return
          let group = state.groups.get(facts.identity)
          if (!group) {
            group = { facts, rows: [], total: 0, nested: 0, variants: new Map(), pages: new Map() }
            state.groups.set(facts.identity, group)
          }
          group.total += 1
          if (facts.name) group.variants.set(facts.name, (group.variants.get(facts.name) ?? 0) + 1)
          const row = describeInstance(instance)
          if (row.nested) group.nested += 1
          if (row.page) group.pages.set(row.page, (group.pages.get(row.page) ?? 0) + 1)
          if ((params.nested === true || !row.nested) && group.rows.length < (params.limit as number)) group.rows.push(row)
        })
        report = instanceSweep.report()
        if (!report.complete) return unfinished(report, labels, 'instances')

        const inventory = state.targets === null
        const pageScope = params.scope === 'page' || (typeof params.pageId === 'string' && params.pageId !== '')
        if (inventory && params.unused !== false && !pageScope) {
          const unusedSweep = await openSweep<State>({
            op: 'component.instances:unused',
            params: paramsForPhase(params),
            roots: () => resolveSweepRoots({}),
            state: () => state,
            types: ['COMPONENT', 'COMPONENT_SET'],
          })
          labels = unusedSweep.labels
          await unusedSweep.walk((node) => {
            if (state.used.has(node.id)) return
            if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') return
            if (node.type === 'COMPONENT_SET' && node.children.some((child) => state.used.has(child.id))) return
            state.unused.push({ id: node.id, name: node.name, type: node.type, link: deepLink(node.id) })
          })
          report = unusedSweep.report()
          if (!report.complete) return unfinished(report, labels, 'unused')
        }
      }

      const inventory = state.targets === null
      const ranked = [...state.groups.values()].sort((a, b) => b.total - a.total)
      const shown = inventory ? ranked.slice(0, params.components as number) : ranked
      const components = shown.map((group) => {
        const id = group.facts.setId ?? group.facts.id
        return {
          component: {
            id,
            name: group.facts.setName ?? group.facts.name,
            key: group.facts.key,
            remote: group.facts.remote,
            status: group.facts.status,
            link: id ? deepLink(id) : null,
          },
          instances: group.total,
          nested: group.nested,
          placed: group.total - group.nested,
          byPage: [...group.pages.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
          byVariant: [...group.variants.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
          rows: group.rows,
          truncated: group.rows.length < (params.nested === true ? group.total : group.total - group.nested),
        }
      })
      const hasUnused = inventory && params.unused !== false && !(params.scope === 'page' || params.pageId)
      return {
        ...report,
        mode: inventory ? 'inventory' : 'component',
        scope: { pages: labels },
        walked: { instances: state.walked, of: state.walked },
        totals: {
          instances: state.walked,
          components: state.groups.size,
          orphans: state.orphans,
          ...(inventory ? { listed: components.length, unused: hasUnused ? state.unused.length : null } : {}),
        },
        components,
        ...(hasUnused ? { unused: state.unused } : {}),
        focusWith: 'node.focus',
        ms: Date.now() - started,
      }
    },
  },

  {
    name: 'component.orphans',
    summary: 'Copies whose main component is gone — grouped by the master that died, with a source to rebuild it from.',
    agent:
      'Finds deleted or missing mains and ranks their surviving copies as restore sources. Detached ' +
      'frames are a second cursor phase so that pass is never silently omitted near a deadline. On ' +
      '`complete: false`, call again with the same params plus `cursor`; only the completing call ' +
      'contains groups and totals.',
    mutates: false,
    params: {
      scope: { type: 'string', default: 'document', enum: ['page', 'document'], description: 'Where to look.' },
      pageId: { type: 'string', description: 'One page — giving it implies scope: "page".' },
      nodeId: { type: 'string', description: 'Walk just this subtree. Overrides scope and pageId.' },
      limit: { type: 'number', default: 20, min: 0, max: 500, description: 'Instance rows listed per dead main; counts are complete.' },
      detached: { type: 'boolean', default: true, description: 'Also report detached frames whose original main is gone.' },
      ...SWEEP_PARAMS,
    },
    async run(params) {
      const started = Date.now()
      const incoming = phaseCursor(params)
      type State = {
        walked: number
        groups: Map<string, { facts: MainFacts; rows: Array<InstanceRow & { children: number }> }>
        detached: DetachedRow[]
      }
      let state: State
      let labels: readonly string[]
      let report: SweepReport

      if (incoming.phase === 'detached') {
        const detachedSweep = await openSweep<State>({
          op: 'component.orphans:detached',
          params: paramsForPhase(params, incoming.cursor),
          roots: () => resolveSweepRoots(params),
          state: () => {
            throw new Error('detached sweep state is missing')
          },
          types: ['FRAME'],
          includeRoots: true,
        })
        state = detachedSweep.state
        labels = detachedSweep.labels
        await walkDetached(detachedSweep, state)
        report = detachedSweep.report()
        if (!report.complete) return unfinished(report, labels, 'detached')
      } else {
        const instanceSweep = await openSweep<State>({
          op: 'component.orphans:instances',
          params: paramsForPhase(params, incoming.phase === 'instances' ? incoming.cursor : undefined),
          roots: () => resolveSweepRoots(params),
          state: () => ({ walked: 0, groups: new Map(), detached: [] }),
          types: ['INSTANCE'],
          includeRoots: true,
        })
        state = instanceSweep.state
        labels = instanceSweep.labels
        await instanceSweep.walk(async (node) => {
          const instance = node as InstanceNode
          const facts = await readMain(instance)
          state.walked += 1
          if (facts.status === 'live') return
          let group = state.groups.get(facts.identity)
          if (!group) {
            group = { facts, rows: [] }
            state.groups.set(facts.identity, group)
          }
          group.rows.push({ ...describeInstance(instance), children: instance.children.length })
        })
        report = instanceSweep.report()
        if (!report.complete) return unfinished(report, labels, 'instances')

        if (params.detached !== false) {
          const detachedSweep = await openSweep<State>({
            op: 'component.orphans:detached',
            params: paramsForPhase(params),
            roots: () => resolveSweepRoots(params),
            state: () => state,
            types: ['FRAME'],
            includeRoots: true,
          })
          labels = detachedSweep.labels
          await walkDetached(detachedSweep, state)
          report = detachedSweep.report()
          if (!report.complete) return unfinished(report, labels, 'detached')
        }
      }

      const groups = [...state.groups.values()]
        .map((group) => {
          const ranked = [...group.rows].sort((a, b) => b.children - a.children || a.overrides - b.overrides)
          return {
            main: {
              id: group.facts.id,
              key: group.facts.key,
              name: group.facts.name ?? group.rows[0]?.name ?? null,
              remote: group.facts.remote,
              set: group.facts.setName ?? null,
            },
            status: group.facts.status,
            keyedBy: group.facts.status === 'missing' ? 'name' : 'main',
            instances: group.rows.length,
            nested: group.rows.filter((row) => row.nested).length,
            pages: countBy(group.rows, (row) => row.page),
            restoreFrom: ranked.slice(0, 3).map((row) => ({
              id: row.id,
              name: row.name,
              page: row.page,
              children: row.children,
              overrides: row.overrides,
              nested: row.nested,
              link: row.link,
            })),
            rows: group.rows.slice(0, params.limit as number),
            truncated: group.rows.length > (params.limit as number),
          }
        })
        .sort((a, b) => b.instances - a.instances)
      const detached = params.detached === false ? undefined : state.detached
      return {
        ...report,
        scope: { pages: labels },
        walked: { instances: state.walked, of: state.walked },
        totals: {
          deadMains: groups.length,
          orphanInstances: groups.reduce((sum, group) => sum + group.instances, 0),
          detachedFrames: detached ? detached.filter((row) => row.verified).length : null,
          detachedUnverified: detached ? detached.filter((row) => !row.verified).length : null,
        },
        groups,
        ...(detached ? { detached } : {}),
        next: 'component.restore — rebuild the main from one of `restoreFrom` and relink the rest',
        ms: Date.now() - started,
      }
    },
  },
]

async function walkDetached(
  sweep: Sweep<{ detached: DetachedRow[] }>,
  state: { detached: DetachedRow[] }
): Promise<void> {
  await sweep.walk(async (node) => {
    const frame = node as FrameNode
    if (!('detachedInfo' in frame)) return
    const info = frame.detachedInfo
    if (!info) return
    const id = 'componentId' in info ? info.componentId : null
    if (id) {
      const main = await figma.getNodeByIdAsync(id)
      if (main && pageOf(main) !== null) return
    }
    state.detached.push({
      id: frame.id,
      name: frame.name,
      page: pageOf(frame)?.name ?? null,
      was: id ?? ('componentKey' in info ? info.componentKey : 'unknown'),
      origin: id ? 'local' : 'library',
      verified: id !== null,
      link: deepLink(frame.id),
    })
  })
}

/* ------------------------------------------------------------------ writes */

async function resolveInstance(id: unknown): Promise<InstanceNode> {
  if (typeof id !== 'string' || id === '') throw new Error('an instance node id is required')
  const node = await figma.getNodeByIdAsync(id)
  if (!node) throw new Error(`no node with id ${id}`)
  if (node.type !== 'INSTANCE') throw new Error(`${node.name} is a ${node.type} — only an INSTANCE can be repointed`)
  return node
}

/** Resolve the product's released target forms: `to`, or an exact `{ set, variant }` selector. */
async function resolveComponent(params: Record<string, unknown>): Promise<ComponentNode> {
  if (typeof params.to === 'string' && params.to !== '') return componentFor(params.to)
  if (typeof params.set !== 'string' || params.set === '') {
    throw new Error('"to" must be an id/key string, or "set" must identify a component set')
  }
  const base = await componentFor(params.set)
  const set = base.parent?.type === 'COMPONENT_SET' ? base.parent : null
  if (!set) throw new Error(`"${base.name}" is not in a component set`)
  if (params.variant === undefined) return set.defaultVariant ?? base
  if (!params.variant || typeof params.variant !== 'object' || Array.isArray(params.variant)) {
    throw new Error('"variant" must be an object of exact variant property names to values')
  }
  const wanted = params.variant as Record<string, unknown>
  const match = set.children.find((candidate): candidate is ComponentNode =>
    candidate.type === 'COMPONENT' &&
    Object.entries(wanted).every(([name, value]) => candidate.variantProperties?.[name] === value)
  )
  if (!match) throw new Error(`no variant in "${set.name}" matches ${JSON.stringify(wanted)}`)
  return match
}

/** Empty space to the right of everything already on the page, so a restored main never lands
 * on top of the work. */
function freeSpot(page: PageNode): { x: number; y: number } {
  let right = 0
  let top = 0
  let seen = false
  for (const child of page.children) {
    if (!Number.isFinite(child.x) || !Number.isFinite(child.width)) continue
    right = seen ? Math.max(right, child.x + child.width) : child.x + child.width
    top = seen ? Math.min(top, child.y) : child.y
    seen = true
  }
  return seen ? { x: right + 200, y: top } : { x: 0, y: 0 }
}

const STRATEGY: ParamSpec = {
  type: 'string',
  default: 'auto',
  enum: ['auto', 'swap', 'rebuild'],
  description:
    'How the copy is repointed. "swap" is Figma\'s own instance swap (override preservation by its UI heuristics, repaired from the snapshot afterwards). "rebuild" is the ⌘⇧R repair without a clipboard: a fresh instance of the new main, the snapshot replayed onto it, inserted at the old copy\'s index with its geometry, and the old copy deleted — exact, but a NEW node id. "auto" swaps, and rebuilds only when Figma refuses the swap.',
}

export const COMPONENT_WRITE_OPS: readonly OpDef[] = [
  {
    name: 'component.restore',
    summary: 'Rebuild a deleted main component out of one of its orphan copies, and relink the rest with their overrides intact.',
    agent:
      'The repair for a main somebody deleted. It clones ONE orphan copy, detaches the clone, ' +
      'turns that into a component, and then repoints every other orphan of the same dead main ' +
      "onto it — snapshotting each copy's overrides first and writing back whatever the repoint " +
      'dropped, so a screen keeps its own text, colours and variants instead of resetting to the ' +
      "source copy's. Read `component.orphans` first and pass one of its `restoreFrom` ids: " +
      'the restored main is that copy WITH ITS OVERRIDES BAKED IN, so picking the copy ' +
      'nobody customised matters. `dryRun: true` lists every copy that would be relinked without ' +
      'touching anything — show that first. When the dead main is `missing` (no id to match on) ' +
      'siblings are matched by NAME, and every row says which way it was matched. The restored ' +
      'component is a NEW component with a new key: consumer files that subscribed to the old ' +
      'library component still need this library published and accepted there.',
    mutates: true,
    params: {
      restoreFrom: {
        type: 'string',
        required: true,
        description: 'Instance id to rebuild the main from — take it from component.orphans `restoreFrom`.',
      },
      name: { type: 'string', description: "Name for the restored component. Defaults to the dead main's own name." },
      pageId: { type: 'string', description: "Page to put the restored main on. Defaults to the source copy's page." },
      x: { type: 'number', description: 'Where to put it. Defaults to clear space right of everything on the page.' },
      y: { type: 'number', description: "Where to put it. Defaults to the top of the page's content." },
      relink: { type: 'boolean', default: true, description: 'Repoint every other orphan of the same dead main onto the restored one.' },
      match: {
        type: 'string',
        default: 'auto',
        enum: ['auto', 'main', 'name'],
        description:
          "How siblings are found: by the dead main's id, by name, or auto (id when the dead main resolves, name when it does not).",
      },
      preserveOverrides: { type: 'boolean', default: true, description: "Snapshot each copy's overrides and write back what the repoint drops." },
      strategy: STRATEGY,
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Report the plan — the component, the page, and every copy that would be relinked — and write nothing.',
      },
    },
    async run(params) {
      const source = await resolveInstance(params.restoreFrom)
      const facts = await readMain(source)
      if (facts.status === 'live') {
        throw new Error(
          `"${source.name}" still has its main (${facts.name}) — nothing to restore. Use instance.swap to repoint it somewhere else.`
        )
      }
      const sourcePage = pageOf(source)
      let page = sourcePage ?? figma.currentPage
      if (typeof params.pageId === 'string' && params.pageId !== '') {
        const found = await figma.getNodeByIdAsync(params.pageId)
        if (!found || found.type !== 'PAGE') throw new Error(`no page with id ${params.pageId}`)
        await found.loadAsync()
        page = found
      }

      const name = typeof params.name === 'string' && params.name !== '' ? params.name : (facts.name ?? source.name)
      const matchBy = params.match === 'main' || params.match === 'name' ? params.match : facts.id ? 'main' : 'name'
      if (matchBy === 'main' && !facts.id) throw new Error('the dead main has no id to match on — use match: "name"')

      /* Siblings: every orphan pointing at the same dead main. `name` matching is the fallback
       * for a main Figma will not resolve at all, and it is reported per row rather than assumed
       * — repointing a copy that merely shares a name would be a silent mistake. */
      const siblings = await enforceDeadline(async () => {
        const found: Array<{ instance: InstanceNode; matchedBy: 'main' | 'name' }> = []
        await checkpoint()
        if (params.relink === false) {
          found.push({ instance: source, matchedBy: matchBy })
          return found
        }
        /* Collection is a read-only, all-or-nothing phase. Pages are loaded one at a time and
         * every candidate checks the enforced run deadline; mutation starts only after this
         * function returns with the complete sibling set. */
        for (const candidatePage of figma.root.children) {
          await checkpoint()
          await candidatePage.loadAsync()
          for (const candidate of await findAllByTypes<InstanceNode>(candidatePage, ['INSTANCE'])) {
            await checkpoint()
            const theirs = await readMain(candidate)
            if (theirs.status === 'live') continue
            if (matchBy === 'main') {
              const sameId = theirs.id !== null && theirs.id === facts.id
              const sameKey = theirs.key !== null && theirs.key === facts.key
              if (sameId || sameKey) found.push({ instance: candidate, matchedBy: 'main' })
            } else if ((theirs.name ?? candidate.name) === (facts.name ?? source.name)) {
              found.push({ instance: candidate, matchedBy: 'name' })
            }
          }
        }
        return found
      })

      const fallback = freeSpot(page)
      const spot = {
        x: typeof params.x === 'number' ? params.x : fallback.x,
        y: typeof params.y === 'number' ? params.y : fallback.y,
      }
      const plan = {
        source: describeInstance(source),
        dead: { id: facts.id, key: facts.key, name: facts.name, status: facts.status, matchedBy: matchBy },
        relink: siblings.map(({ instance, matchedBy }) => ({ ...describeInstance(instance), matchedBy })),
      }
      if (params.dryRun === true) {
        return {
          dryRun: true,
          ...plan,
          component: { name, page: page.name, pageId: page.id, x: spot.x, y: spot.y },
          restored: false,
          relinked: 0,
          note: "the restored main is the source copy WITH its overrides baked in — check `source.overrides` before running for real",
        }
      }

      if (figma.editorType && figma.editorType !== 'figma') {
        throw new Error(`component.restore makes a component, which only Figma Design can — this file is open in ${figma.editorType}`)
      }
      figma.commitUndo()
      /* Clone → detach → componentise. The clone is what keeps the source copy intact while it
       * becomes the new main's geometry; detaching is what makes it a plain frame Figma will
       * accept, since `createComponentFromNode` on a live instance would nest a copy inside. */
      const clone = source.clone()
      page.appendChild(clone)
      const frame = clone.detachInstance()
      const main = figma.createComponentFromNode(frame)
      main.name = name
      page.appendChild(main)
      main.x = spot.x
      main.y = spot.y

      const strategy = (typeof params.strategy === 'string' ? params.strategy : 'auto') as SwapStrategy
      const rows: Array<Record<string, unknown>> = []
      let relinked = 0
      for (const { instance, matchedBy } of siblings) {
        const row = describeInstance(instance)
        try {
          const outcome = await repoint(instance, main, params.preserveOverrides !== false, strategy)
          relinked += 1
          rows.push({ ...row, matchedBy, ok: true, repointed: true, ...outcome })
        } catch (err) {
          rows.push({ ...row, matchedBy, ok: false, repointed: false, error: String((err as Error)?.message || err) })
        }
      }

      return {
        dryRun: false,
        source: plan.source,
        dead: plan.dead,
        component: {
          id: main.id,
          name: main.name,
          key: main.key || null,
          page: page.name,
          pageId: page.id,
          x: main.x,
          y: main.y,
          link: deepLink(main.id),
        },
        restored: true,
        relinked,
        failed: rows.length - relinked,
        rows,
        note: 'new component, new key — a consumer file that subscribed to the deleted library component still needs this library published and accepted there',
      }
    },
  },

  {
    name: 'instance.swap',
    summary: 'Repoint instances onto another main component, keeping the overrides each copy carried.',
    agent:
      'The manual half of `component.restore`, and the op for any deliberate re-pointing: a copy ' +
      'moved onto a rebuilt main, a deprecated component retired, a local copy pointed back at ' +
      'the library one. `swapComponent` preserves overrides "with the same heuristics as the UI" ' +
      '— a promise about most of them — so this snapshots every override first, repoints, and ' +
      'writes back what was dropped. The report is the contract: `kept` is what survived on its ' +
      'own, `restored` names each layer and field written back, and `lost` names what nobody ' +
      'could put back and why. `to` takes a COMPONENT id, a 40-character library key, or a set id ' +
      'plus `variant`. When Figma refuses a swap outright, `strategy: "auto"` falls back to the ' +
      "⌘⇧R repair a designer does by hand — a fresh copy of the new main with the snapshot " +
      'replayed onto it, inserted where the old one was, old one deleted — which costs a NEW node ' +
      'id, reported as `newId`. `preserveOverrides: false` is the Figma-native behaviour: every ' +
      "copy back to the new main's defaults.",
    mutates: true,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Instance ids to repoint.' },
      to: {
        type: 'string',
        description: 'The new main: a COMPONENT id or 40-character library key.',
      },
      set: { type: 'string', description: 'Component-set id or key when selecting a variant.' },
      variant: { type: 'json', description: 'With set: exact variant property names to values.' },
      preserveOverrides: { type: 'boolean', default: true, description: 'Snapshot overrides before the repoint and write back whatever it drops.' },
      strategy: STRATEGY,
      dryRun: {
        type: 'boolean',
        default: false,
        description: "Report what would be repointed, and each copy's override count, without touching anything.",
      },
    },
    async run(params) {
      const ids = (Array.isArray(params.nodes) ? params.nodes : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      if (ids.length === 0) throw new Error('"nodes" must be a non-empty array of instance ids')
      const target = await resolveComponent(params)
      const dryRun = params.dryRun === true
      const strategy = (typeof params.strategy === 'string' ? params.strategy : 'auto') as SwapStrategy
      if (!dryRun) figma.commitUndo()

      const rows: Array<Record<string, unknown>> = []
      for (const id of ids) {
        try {
          const instance = await resolveInstance(id)
          const facts = await readMain(instance)
          const row = { ...describeInstance(instance), from: { id: facts.id, name: facts.name, status: facts.status } }
          if (dryRun) {
            rows.push({ ...row, ok: true, repointed: false })
            continue
          }
          const outcome = await repoint(instance, target, params.preserveOverrides !== false, strategy)
          rows.push({ ...row, ok: true, repointed: true, ...outcome })
        } catch (err) {
          rows.push({ node: id, ok: false, repointed: false, error: String((err as Error)?.message || err) })
        }
      }

      const ok = rows.filter((row) => row.ok === true)
      return {
        dryRun,
        to: { id: target.id, name: target.name, key: target.key || null, remote: target.remote === true },
        strategy,
        total: rows.length,
        repointed: dryRun ? 0 : ok.filter((row) => row.repointed === true).length,
        failed: rows.length - ok.length,
        rows,
      }
    },
  },
]
