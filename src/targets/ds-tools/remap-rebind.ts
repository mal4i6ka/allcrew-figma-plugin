/**
 * Rebinding the open file onto the reference library.
 *
 * After the remap has repainted values, everything here still *points* at local (or foreign)
 * variables. This pass moves the pointers: semantic aliases onto the library's primitives,
 * node and style bindings onto the same, so the file genuinely sits on the reference instead
 * of resembling it. Values were the first half; provenance is this half.
 *
 * The shape is scan → ops → write. The scan builds the full list of operations without
 * touching anything, which is also the preview and the undo-budget check; the write then
 * executes exactly that list. One list, three truths: what the panel promises, what Apply
 * does, and what the snapshot lets Revert undo.
 *
 * Instances are written into — the operator chose full coverage — but only at nodes whose
 * fields the instance genuinely overrides. An inherited binding is the master's business:
 * the master is rebound by the same pass, and writing the inherited copy would only mint an
 * override where none existed.
 */

import type { RemapPlan } from '../../tokens/remap/plan.ts'
import { describeRebind, emptyCounts, rebindTargets, sameRgba, type RebindCounts } from '../../tokens/remap/rebind.ts'
import { loadAllPagesAsync, yieldToHost } from '../../utils/tree.ts'
import { isGradient } from './remap-inventory.ts'
import { scopeRoots, type RemapScope } from './remap-apply.ts'

type Progress = (label: string) => void

export interface RebindOptions {
  /**
   * What the canvas pass covers. Variables and styles are file-global — a "selection" does
   * not own its semantic tokens — so they move only on a whole-document run; a narrower
   * scope rebinds the bindings inside it and says what it left alone.
   */
  scope: RemapScope
}

export const DEFAULT_REBIND_OPTIONS: RebindOptions = { scope: 'document' }

/* ------------------------------------------------------------------ ops */

/** `old` is the previous alias/binding target id, or channels for a literal that became an alias. */
export type RebindOp =
  | { kind: 'variable'; variableId: string; modeId: string; old: string | readonly number[]; key: string }
  | {
      kind: 'style'
      styleId: string
      property: 'paints' | 'effects'
      index: number
      stop: number
      old: string
      key: string
    }
  | {
      kind: 'node'
      nodeId: string
      property: 'fills' | 'strokes' | 'effects'
      index: number
      stop: number
      old: string
      key: string
      instance: boolean
    }

export interface RebindScan {
  ops: RebindOp[]
  counts: RebindCounts
  warnings: string[]
}

export interface RebindReport {
  counts: RebindCounts
  summary: string
  warnings: string[]
}

/* ------------------------------------------------------------------ storage */

const SNAPSHOT_KEY = 'altery-rebind-snapshot'
const SNAPSHOT_COUNT_KEY = 'altery-rebind-snapshot-chunks'
const CHUNK_BYTES = 80_000
const MAX_CHUNKS = 12
export const REBIND_BUDGET_BYTES = CHUNK_BYTES * MAX_CHUNKS

/**
 * The snapshot is the ops list itself: each op already carries the previous target, so undo
 * is replaying the list backwards with `old` in place of `key`.
 */
interface RebindSnapshot {
  version: 1
  ops: RebindOp[]
}

function writeChunked(text: string): void {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_BYTES) chunks.push(text.slice(i, i + CHUNK_BYTES))
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(`the rebind snapshot needs ${chunks.length} slots, more than the ${MAX_CHUNKS} available`)
  }
  const previous = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  for (const [index, chunk] of chunks.entries()) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, chunk)
  for (let index = chunks.length; index < previous; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, '')
  figma.root.setPluginData(SNAPSHOT_COUNT_KEY, String(chunks.length))
}

function readChunked(): string {
  const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  let text = ''
  for (let index = 0; index < count; index++) text += figma.root.getPluginData(`${SNAPSHOT_KEY}-${index}`)
  return text
}

function clearChunked(): void {
  const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  for (let index = 0; index < count; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, '')
  figma.root.setPluginData(SNAPSHOT_COUNT_KEY, '0')
}

export const hasRebindSnapshot = (): boolean => Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0') > 0

/* ------------------------------------------------------------------ scan */

const isAliasValue = (value: VariableValue | undefined): value is VariableAlias =>
  typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS'

const isRgbValue = (value: VariableValue | undefined): value is RGB | RGBA =>
  typeof value === 'object' && value !== null && 'r' in (value as object)

const alphaOf = (value: RGB | RGBA): number => ('a' in value ? value.a : 1)

const boundColorId = (holder: unknown): string | null => {
  const alias = (holder as { boundVariables?: { color?: VariableAlias } })?.boundVariables?.color
  return alias && alias.type === 'VARIABLE_ALIAS' ? alias.id : null
}

/**
 * Walks the whole document and every local variable, and returns the operations a rebind
 * would perform. Nothing is written: this is the preview, the plan and the undo budget in
 * one list.
 */
export async function scanRebind(
  plan: RemapPlan,
  options: RebindOptions = DEFAULT_REBIND_OPTIONS,
  progress?: Progress
): Promise<RebindScan> {
  const { byVariable, divergent } = rebindTargets(plan)
  const counts = emptyCounts()
  counts.skipped.divergent = divergent.length
  const warnings: string[] = []
  const ops: RebindOp[] = []

  if (byVariable.size === 0) {
    return { ops, counts, warnings: ['the plan carries no library keys — read the new palette from a library'] }
  }

  // Which of the plan's landings are *already* the reference: importing every distinct key
  // once gives their local ids, so an alias already pointing at the reference is recognised
  // rather than rewritten, and every later write reuses the same import.
  const importedByKey = new Map<string, Variable>()
  const importedIds = new Set<string>()
  const keys = new Set([...byVariable.values()].map((target) => target.key))
  let fetched = 0
  for (const key of keys) {
    if (++fetched % 25 === 0) {
      progress?.(`importing library tokens… ${fetched}/${keys.size}`)
      await yieldToHost()
    }
    const variable = await figma.variables.importVariableByKeyAsync(key).catch(() => null)
    if (variable) {
      importedByKey.set(key, variable)
      importedIds.add(variable.id)
    }
  }
  if (importedByKey.size < keys.size) {
    warnings.push(`${keys.size - importedByKey.size} library token(s) could not be imported and keep their bindings`)
  }

  /** The library value a key resolves to, from its own collection's default mode. */
  const valueOfKey = async (key: string): Promise<{ rgba: RGBA; id: string } | null> => {
    const variable = importedByKey.get(key)
    if (!variable) return null
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId).catch(() => null)
    const mode = collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0]
    const value = mode === undefined ? undefined : variable.valuesByMode[mode]
    if (!isRgbValue(value)) return null
    return { rgba: { r: value.r, g: value.g, b: value.b, a: alphaOf(value) }, id: variable.id }
  }

  const foreignIds = new Set<string>()
  const divergentIds = new Set(divergent)

  /** The rebind decision for one existing binding: an op, or a skip counted by its reason. */
  const rebindOf = (oldId: string): { key: string; foreign: boolean } | 'already' | 'no-target' => {
    if (importedIds.has(oldId)) return 'already'
    const target = byVariable.get(oldId)
    // A key that failed to import is a landing that does not exist here: promising it in the
    // preview would store an op the apply can never perform.
    if (!target || !importedByKey.has(target.key)) return 'no-target'
    return { key: target.key, foreign: foreignIds.has(oldId) }
  }

  /* ---- local variables: aliases move, byte-equal literals may bind ---- */

  progress?.('reading local variables…')
  const locals = await figma.variables.getLocalVariablesAsync('COLOR')
  const localIds = new Set(locals.map((variable) => variable.id))
  for (const id of byVariable.keys()) if (!localIds.has(id)) foreignIds.add(id)

  const wholeFile = options.scope === 'document'
  if (!wholeFile) {
    warnings.push('variables and styles are file-global — they move only on a whole-document rebind')
  }

  const planBySite = new Map(plan.entries.map((entry) => [entry.site.id, entry]))

  for (const [index, variable] of wholeFile ? locals.entries() : ([] as Array<[number, Variable]>)) {
    if (index % 50 === 0) await yieldToHost()
    for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
      if (isAliasValue(value)) {
        const decision = rebindOf(value.id)
        if (decision === 'already') {
          counts.skipped.already++
          continue
        }
        if (decision === 'no-target') {
          counts.skipped.noTarget++
          continue
        }
        ops.push({ kind: 'variable', variableId: variable.id, modeId, old: value.id, key: decision.key })
        counts.aliases++
        if (decision.foreign) counts.thirdParty++
        continue
      }
      if (!isRgbValue(value)) continue
      // A literal only becomes an alias when it is byte-equal to the library token the plan
      // lands it on — an alias takes the target's value whole, alpha included. And a variable
      // whose modes disagree about the landing does not move by this door either: the refusal
      // in the report has to be the refusal in the writes.
      if (divergentIds.has(variable.id)) continue
      const entry = planBySite.get(`${variable.id}|${modeId}`)
      if (!entry || entry.toVariableKey === null || entry.flags.includes('excluded')) continue
      const landing = await valueOfKey(entry.toVariableKey)
      if (!landing) continue
      const current = { r: value.r, g: value.g, b: value.b, a: alphaOf(value) }
      const target = { ...entry.to }
      if (!sameRgba(target, landing.rgba)) {
        if (sameRgba({ ...target, a: landing.rgba.a }, landing.rgba)) counts.skipped.alphaMismatch++
        continue
      }
      // Only once the repaint has actually happened (or the value already matches): binding a
      // stale literal would repaint it as a side effect, and that is Apply's job, not ours.
      if (!sameRgba(current, landing.rgba)) continue
      ops.push({
        kind: 'variable',
        variableId: variable.id,
        modeId,
        old: [current.r, current.g, current.b, current.a],
        key: entry.toVariableKey,
      })
      counts.literalsBound++
    }
  }

  /* ---- styles ---- */

  progress?.('reading styles…')
  const paintStyles = wholeFile ? await figma.getLocalPaintStylesAsync() : []
  for (const style of paintStyles) {
    for (const [index, paint] of style.paints.entries()) {
      if (paint.type === 'SOLID') {
        const oldId = boundColorId(paint)
        if (!oldId) continue
        const decision = rebindOf(oldId)
        if (decision === 'already') counts.skipped.already++
        else if (decision === 'no-target') counts.skipped.noTarget++
        else {
          ops.push({ kind: 'style', styleId: style.id, property: 'paints', index, stop: -1, old: oldId, key: decision.key })
          counts.styles++
          if (decision.foreign) counts.thirdParty++
        }
        continue
      }
      if (!isGradient(paint)) continue
      for (const [stopIndex, stop] of paint.gradientStops.entries()) {
        const oldId = boundColorId(stop)
        if (!oldId) continue
        const decision = rebindOf(oldId)
        if (decision === 'already') counts.skipped.already++
        else if (decision === 'no-target') counts.skipped.noTarget++
        else {
          ops.push({
            kind: 'style',
            styleId: style.id,
            property: 'paints',
            index,
            stop: stopIndex,
            old: oldId,
            key: decision.key,
          })
          counts.styles++
          if (decision.foreign) counts.thirdParty++
        }
      }
    }
  }
  const effectStyles = wholeFile ? await figma.getLocalEffectStylesAsync() : []
  for (const style of effectStyles) {
    for (const [index, effect] of style.effects.entries()) {
      const oldId = boundColorId(effect)
      if (!oldId) continue
      const decision = rebindOf(oldId)
      if (decision === 'already') counts.skipped.already++
      else if (decision === 'no-target') counts.skipped.noTarget++
      else {
        ops.push({ kind: 'style', styleId: style.id, property: 'effects', index, stop: -1, old: oldId, key: decision.key })
        counts.styles++
        if (decision.foreign) counts.thirdParty++
      }
    }
  }

  /* ---- canvas ---- */

  if (wholeFile) await loadAllPagesAsync()
  const overridden = new Map<string, Set<string>>()

  const noteOverrides = (instance: InstanceNode): void => {
    let overrides: InstanceNode['overrides']
    try {
      overrides = instance.overrides
    } catch {
      return
    }
    for (const override of overrides) {
      const fields = overridden.get(override.id) ?? new Set<string>()
      for (const field of override.overriddenFields) fields.add(field)
      overridden.set(override.id, fields)
    }
  }

  const collectPaintOps = (
    node: SceneNode,
    property: 'fills' | 'strokes',
    inInstance: boolean
  ): void => {
    // A node wearing a style mirrors the style's paints, bindings included. The style is
    // rebound in its own pass; writing the mirror would detach the node from its style —
    // the one loss no Revert can restore.
    const styleId = (node as unknown as Record<string, unknown>)[property === 'fills' ? 'fillStyleId' : 'strokeStyleId']
    if (typeof styleId === 'string' && styleId !== '') return
    const paints = (node as unknown as Record<string, unknown>)[property]
    if (!Array.isArray(paints)) return
    if (inInstance && !overridden.get(node.id)?.has(property)) return
    // Older files carry the binding on the node (`boundVariables.fills[i]`) rather than on
    // the paint. Both are pointers at a variable; both move. The rewrite lands on the paint,
    // which is where Figma itself puts it today.
    const nodeLevel = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables?.[property]
    const nodeLevelIds = Array.isArray(nodeLevel)
      ? (nodeLevel as Array<VariableAlias | undefined>).map((alias) =>
          alias && alias.type === 'VARIABLE_ALIAS' ? alias.id : null
        )
      : []
    for (const [index, paint] of (paints as Paint[]).entries()) {
      if (paint.type === 'SOLID') {
        const oldId = boundColorId(paint) ?? nodeLevelIds[index] ?? null
        if (!oldId) continue
        const decision = rebindOf(oldId)
        if (decision === 'already') counts.skipped.already++
        else if (decision === 'no-target') counts.skipped.noTarget++
        else {
          ops.push({ kind: 'node', nodeId: node.id, property, index, stop: -1, old: oldId, key: decision.key, instance: inInstance })
          counts.nodes++
          if (inInstance) counts.instanceOverrides++
          if (decision.foreign) counts.thirdParty++
        }
        continue
      }
      if (!isGradient(paint)) continue
      for (const [stopIndex, stop] of paint.gradientStops.entries()) {
        const oldId = boundColorId(stop)
        if (!oldId) continue
        const decision = rebindOf(oldId)
        if (decision === 'already') counts.skipped.already++
        else if (decision === 'no-target') counts.skipped.noTarget++
        else {
          ops.push({ kind: 'node', nodeId: node.id, property, index, stop: stopIndex, old: oldId, key: decision.key, instance: inInstance })
          counts.nodes++
          if (inInstance) counts.instanceOverrides++
          if (decision.foreign) counts.thirdParty++
        }
      }
    }
  }

  const collectEffectOps = (node: SceneNode, inInstance: boolean): void => {
    const effectStyleId = (node as unknown as Record<string, unknown>).effectStyleId
    if (typeof effectStyleId === 'string' && effectStyleId !== '') return
    const effects = (node as unknown as Record<string, unknown>).effects
    if (!Array.isArray(effects)) return
    if (inInstance && !overridden.get(node.id)?.has('effects')) return
    for (const [index, effect] of (effects as Effect[]).entries()) {
      const oldId = boundColorId(effect)
      if (!oldId) continue
      const decision = rebindOf(oldId)
      if (decision === 'already') counts.skipped.already++
      else if (decision === 'no-target') counts.skipped.noTarget++
      else {
        ops.push({ kind: 'node', nodeId: node.id, property: 'effects', index, stop: -1, old: oldId, key: decision.key, instance: inInstance })
        counts.nodes++
        if (inInstance) counts.instanceOverrides++
        if (decision.foreign) counts.thirdParty++
      }
    }
  }

  figma.skipInvisibleInstanceChildren = true
  try {
    let visited = 0
    const rootSets: Array<{ label: string; roots: readonly SceneNode[] }> = wholeFile
      ? figma.root.children.map((page) => ({ label: page.name, roots: page.children }))
      : [{ label: options.scope, roots: await scopeRoots(options.scope) }]
    for (const { label, roots } of rootSets) {
      progress?.(`scanning ${label}…`)
      const stack: Array<{ node: SceneNode; inInstance: boolean }> = []
      for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], inInstance: false })
      while (stack.length > 0) {
        const { node, inInstance } = stack.pop() as { node: SceneNode; inInstance: boolean }
        if (++visited % 400 === 0) await yieldToHost()
        const isInstance = node.type === 'INSTANCE'
        if (isInstance) noteOverrides(node as InstanceNode)
        // The instance's own fills are as inherited as its children's: gate the root by its
        // own overrides too, or every top-level instance of a bound master gets an override
        // minted onto it — which Revert can rewrite but never un-mint.
        const gated = inInstance || isInstance
        collectPaintOps(node, 'fills', gated)
        collectPaintOps(node, 'strokes', gated)
        collectEffectOps(node, gated)
        if ('children' in node) {
          const inside = inInstance || isInstance
          const children = node.children
          for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], inInstance: inside })
        }
      }
    }
  } finally {
    figma.skipInvisibleInstanceChildren = false
  }

  return { ops, counts, warnings }
}

/* ------------------------------------------------------------------ write */

const aliasTo = (variable: Variable): VariableAlias => ({ type: 'VARIABLE_ALIAS', id: variable.id })

async function writePaintBinding(
  holder: { paints: readonly Paint[] } | SceneNode,
  property: 'paints' | 'fills' | 'strokes',
  index: number,
  stop: number,
  variable: Variable | null,
  restoreId?: string
): Promise<boolean> {
  const record = holder as unknown as Record<string, unknown>
  const paints = record[property]
  if (!Array.isArray(paints) || !paints[index]) return false
  const next = [...(paints as Paint[])]
  const paint = next[index]

  const target = variable ?? (restoreId ? await figma.variables.getVariableByIdAsync(restoreId).catch(() => null) : null)
  if (!target) return false

  if (stop < 0) {
    if (paint.type !== 'SOLID') return false
    next[index] = figma.variables.setBoundVariableForPaint(paint, 'color', target)
  } else {
    if (!isGradient(paint)) return false
    const stops = paint.gradientStops.map((gradientStop) => ({ ...gradientStop }))
    if (!stops[stop]) return false
    stops[stop] = { ...stops[stop], boundVariables: { color: aliasTo(target) } }
    next[index] = { ...paint, gradientStops: stops }
  }
  record[property] = next
  return true
}

async function writeEffectBinding(
  holder: { effects: readonly Effect[] } | SceneNode,
  index: number,
  variable: Variable
): Promise<boolean> {
  const record = holder as unknown as Record<string, unknown>
  const effects = record.effects
  if (!Array.isArray(effects) || !effects[index]) return false
  const next = [...(effects as Effect[])]
  next[index] = figma.variables.setBoundVariableForEffect(next[index], 'color', variable)
  record.effects = next
  return true
}

/** Executes one list of ops; `undo` replays with `old` targets instead of `key`. */
async function executeOps(ops: readonly RebindOp[], undo: boolean, progress?: Progress): Promise<RebindCounts> {
  const counts = emptyCounts()
  const importedByKey = new Map<string, Variable | null>()
  const importOf = async (key: string): Promise<Variable | null> => {
    if (!importedByKey.has(key)) {
      importedByKey.set(key, await figma.variables.importVariableByKeyAsync(key).catch(() => null))
    }
    return importedByKey.get(key) ?? null
  }

  for (const [index, op] of ops.entries()) {
    if (index % 25 === 0) {
      progress?.(`${undo ? 'restoring' : 'rebinding'}… ${index}/${ops.length}`)
      await yieldToHost()
    }

    if (op.kind === 'variable') {
      const variable = await figma.variables.getVariableByIdAsync(op.variableId).catch(() => null)
      if (!variable) continue
      if (undo) {
        if (typeof op.old === 'string') {
          const previous = await figma.variables.getVariableByIdAsync(op.old).catch(() => null)
          if (previous) variable.setValueForMode(op.modeId, aliasTo(previous))
        } else {
          const [r, g, b, a] = op.old
          variable.setValueForMode(op.modeId, { r, g, b, a })
        }
        counts.aliases++
        continue
      }
      const target = await importOf(op.key)
      if (!target) continue
      variable.setValueForMode(op.modeId, aliasTo(target))
      if (typeof op.old === 'string') counts.aliases++
      else counts.literalsBound++
      continue
    }

    const target = undo ? null : await importOf(op.key)
    if (!undo && !target) continue

    if (op.kind === 'style') {
      const style = await figma.getStyleByIdAsync(op.styleId).catch(() => null)
      if (!style) continue
      if (op.property === 'paints' && style.type === 'PAINT') {
        const done = await writePaintBinding(style as PaintStyle, 'paints', op.index, op.stop, target, undo ? op.old : undefined)
        if (done) counts.styles++
      } else if (op.property === 'effects' && style.type === 'EFFECT') {
        const restore = undo ? await figma.variables.getVariableByIdAsync(op.old).catch(() => null) : target
        if (restore && (await writeEffectBinding(style as EffectStyle, op.index, restore))) counts.styles++
      }
      continue
    }

    const node = (await figma.getNodeByIdAsync(op.nodeId).catch(() => null)) as SceneNode | null
    if (!node) continue
    if (op.property === 'effects') {
      const restore = undo ? await figma.variables.getVariableByIdAsync(op.old).catch(() => null) : target
      if (restore && (await writeEffectBinding(node, op.index, restore))) {
        counts.nodes++
        if (op.instance) counts.instanceOverrides++
      }
    } else {
      const done = await writePaintBinding(node, op.property, op.index, op.stop, target, undo ? op.old : undefined)
      if (done) {
        counts.nodes++
        if (op.instance) counts.instanceOverrides++
      }
    }
  }
  return counts
}

/* ------------------------------------------------------------------ entry points */

export async function previewRebind(
  plan: RemapPlan,
  options: RebindOptions = DEFAULT_REBIND_OPTIONS,
  progress?: Progress
): Promise<RebindReport> {
  const scan = await scanRebind(plan, options, progress)
  return { counts: scan.counts, summary: describeRebind(scan.counts), warnings: scan.warnings }
}

export async function applyRebind(
  plan: RemapPlan,
  options: RebindOptions = DEFAULT_REBIND_OPTIONS,
  progress?: Progress
): Promise<RebindReport> {
  const scan = await scanRebind(plan, options, progress)
  const snapshot: RebindSnapshot = { version: 1, ops: scan.ops }
  const serialized = JSON.stringify(snapshot)
  if (serialized.length > REBIND_BUDGET_BYTES) {
    throw new Error(
      `this rebind would touch ${scan.ops.length} places — more than one undo snapshot can hold. ` +
        'Run it scope by scope, or shrink the mapping.'
    )
  }

  // The snapshot goes down BEFORE the first write. It is exactly the scan list, and every op
  // addresses a unique site, so reverting an op that never got applied merely re-asserts the
  // old target that is still in place — while the opposite order turns a mid-apply failure
  // (a locked node, a closed plugin) into a half-rebound file with no way back.
  writeChunked(serialized)
  await executeOps(scan.ops, false, progress)
  // The report is the scan's: that is what the preview promised and what the ops encode. The
  // executor's own tally can only drift below it (a node deleted mid-run), never above.
  return { counts: scan.counts, summary: describeRebind(scan.counts), warnings: scan.warnings }
}

export async function revertRebind(progress?: Progress): Promise<RebindReport> {
  const raw = readChunked()
  if (raw === '') throw new Error('no rebind snapshot to revert')
  const snapshot = JSON.parse(raw) as RebindSnapshot
  if (snapshot.version !== 1 || !Array.isArray(snapshot.ops)) throw new Error('the rebind snapshot is unreadable')

  const counts = await executeOps(snapshot.ops, true, progress)
  clearChunked()
  return { counts, summary: describeRebind(counts), warnings: [] }
}
