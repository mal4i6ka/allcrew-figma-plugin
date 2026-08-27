/**
 * Writing a remap plan into the document, reversibly.
 *
 * Values change in place and variables are never created, deleted or merged: a variable is
 * the thing an entire file binds to, so its id has to survive or every binding in the
 * document has to be repaired. That single rule is why a remap can touch a thousand tokens
 * and still be a safe operation.
 *
 * The snapshot is written *before* anything else and is the only reason Apply is safe to
 * press. It is also what makes preview possible at all — a variable has no page-local value,
 * so the only honest preview is to apply for real and offer Revert. If the snapshot cannot
 * be stored, Apply refuses rather than leaving a file that cannot be walked back.
 *
 * Loose colors on canvas are undone by address, not by reversing the mapping. A reverse map
 * would repaint every layer that merely *happens* to hold a color the remap also produced,
 * including ones it never touched, so each write records where it landed.
 *
 * Renames run in two passes through temporary names. Figma requires a variable's name to be
 * unique inside its collection, and a rename set that swaps or rotates names transiently
 * collides even when every final name is distinct.
 */

import type { RenameMap } from '../../tokens/engine.ts'
import { deltaE } from '../../tokens/remap/match.ts'
import type { RemapEntry, RemapPlan } from '../../tokens/remap/plan.ts'
import { yieldToHost } from '../../utils/tree.ts'
import {
  hexOf,
  isGradient,
  isShadow,
  looseSiteId,
  nodeLevelBindings,
  paintsOf,
  styleIdOf,
  withAlpha,
} from './remap-inventory.ts'

export type RemapScope = 'document' | 'page' | 'selection'

export interface RemapApplyOptions {
  /** Write the new color values into variables. */
  values: boolean
  /** Rewrite primitive names onto their new family. Only ever with `values`: a rename is a write. */
  rename: boolean
  /** Write paint styles, gradient stops inside them, and effect styles. */
  styles: boolean
  /** Write loose colors found on layers. */
  canvas: boolean
  /** Bind a loose color to the variable it turned out to be, instead of writing a literal. */
  bind: boolean
  scope: RemapScope
}

export const DEFAULT_REMAP_APPLY_OPTIONS: RemapApplyOptions = {
  values: true,
  rename: true,
  styles: true,
  canvas: true,
  bind: true,
  scope: 'document',
}

export interface RemapApplyReport {
  values: number
  renamed: number
  legacy: number
  styles: number
  paints: number
  bound: number
  /** Hand-made color overrides on instances, left untouched on purpose. */
  instanceOverrides: number
  skippedLibrary: number
  unchanged: number
  failed: number
  snapshotBytes: number
  warnings: string[]
}

export interface RemapRevertReport {
  values: number
  names: number
  styles: number
  paints: number
  warnings: string[]
}

/* ------------------------------------------------------------------ storage */

const SNAPSHOT_KEY = 'altery-remap-snapshot'
const SNAPSHOT_COUNT_KEY = 'altery-remap-snapshot-chunks'
const RENAME_KEY = 'altery-remap-renames'

/**
 * Figma caps a single plugin-data entry at 100 kB; a large file's snapshot does not fit in
 * one, so it is split. The chunk ceiling is what Apply checks before it touches anything.
 */
const CHUNK_BYTES = 80_000
const MAX_CHUNKS = 12

type Channels = [number, number, number, number]

interface SnapshotValue {
  /** Variable id. */
  v: string
  /** Mode id. */
  m: string
  c: Channels
}

interface SnapshotName {
  v: string
  n: string
}

interface SnapshotStyle {
  s: string
  p: 'paints' | 'effects'
  i: number
  /** Gradient stop index, when the color lived inside one. */
  j: number
  c: Channels
}

/** Compact on purpose: one tuple per painted place, and a big file has a lot of them. */
type SnapshotPaint = [
  /** node id */ string,
  /** 0 fills · 1 strokes · 2 effects */ number,
  /** paint index */ number,
  /** gradient stop index, -1 when none */ number,
  number,
  number,
  number,
  number,
  /** 1 when this write also added a variable binding that Revert has to remove */ number,
]

interface RemapSnapshot {
  version: 2
  values: SnapshotValue[]
  names: SnapshotName[]
  styles: SnapshotStyle[]
  paints: SnapshotPaint[]
}

/** Old exported key → the name that key resolves to now; the emitter reads the same shape. */
export type { RenameMap } from '../../tokens/engine.ts'

function writeChunked(text: string): number {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_BYTES) chunks.push(text.slice(i, i + CHUNK_BYTES))
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(`the undo snapshot needs ${chunks.length} slots, more than the ${MAX_CHUNKS} available`)
  }

  const previous = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  for (const [index, chunk] of chunks.entries()) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, chunk)
  for (let index = chunks.length; index < previous; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, '')
  figma.root.setPluginData(SNAPSHOT_COUNT_KEY, String(chunks.length))
  return text.length
}

function readChunked(): string {
  const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  let text = ''
  for (let index = 0; index < count; index++) text += figma.root.getPluginData(`${SNAPSHOT_KEY}-${index}`)
  return text
}

function clearSnapshot(): void {
  const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0')
  for (let index = 0; index < count; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, '')
  figma.root.setPluginData(SNAPSHOT_COUNT_KEY, '0')
}

export function hasRemapSnapshot(): boolean {
  return Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || '0') > 0
}

export function readRenameMap(): RenameMap {
  const raw = figma.root.getPluginData(RENAME_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as RenameMap) : {}
  } catch {
    return {}
  }
}

/**
 * Folds a round of renames into the stored map.
 *
 * Chains are collapsed rather than kept: after `blue-500 → violet-500 → teal-500` both old
 * keys point straight at the final name, so the emitted alias layer never becomes
 * `var(var(…))` and stays readable after any number of remaps.
 */
export function foldRenames(existing: RenameMap, applied: ReadonlyArray<{ from: string; to: string }>): RenameMap {
  const next: RenameMap = { ...existing }
  for (const { from, to } of applied) {
    for (const [key, value] of Object.entries(next)) if (value === from) next[key] = to
    if (from !== to) next[from] = to
  }
  // A key that ended up pointing at itself is not an alias.
  for (const [key, value] of Object.entries(next)) if (key === value) delete next[key]
  return next
}

function writeRenameMap(map: RenameMap): void {
  figma.root.setPluginData(RENAME_KEY, Object.keys(map).length === 0 ? '' : JSON.stringify(map))
}

/* ------------------------------------------------------------------ addressing */

/** Site ids are `<variable id>|<mode id>` — see remap-inventory. */
export function splitSiteId(id: string): { variableId: string; modeId: string } | null {
  const separator = id.lastIndexOf('|')
  if (separator <= 0) return null
  return { variableId: id.slice(0, separator), modeId: id.slice(separator + 1) }
}

export interface StyleAddress {
  styleId: string
  property: 'paints' | 'effects'
  index: number
  /** Gradient stop index, or null when the color is the paint's own. */
  stop: number | null
}

/** `style:S#paints:0` or `style:S#paints:0.2` or `style:S#effects:1`. */
export function parseStyleSiteId(id: string): StyleAddress | null {
  if (id.slice(0, 6) !== 'style:') return null
  const hash = id.indexOf('#')
  if (hash < 0) return null
  const styleId = id.slice(6, hash)
  const [property, rest] = id.slice(hash + 1).split(':')
  if (property !== 'paints' && property !== 'effects') return null
  const [indexText, stopText] = rest.split('.')
  const index = Number(indexText)
  if (!Number.isFinite(index)) return null
  const stop = stopText === undefined ? null : Number(stopText)
  return { styleId, property, index, stop: stop === null || !Number.isFinite(stop) ? null : stop }
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000
const channelsOf = (color: { r: number; g: number; b: number; a?: number }): Channels => [
  round4(color.r),
  round4(color.g),
  round4(color.b),
  round4(color.a ?? 1),
]
const colorOf = (channels: Channels): RGBA => ({ r: channels[0], g: channels[1], b: channels[2], a: channels[3] })

const PROPERTY_CODES = ['fills', 'strokes', 'effects'] as const
type PaintProperty = (typeof PROPERTY_CODES)[number]

/* ------------------------------------------------------------------ variables */

/** Struck out by hand: planned and shown, never written. */
const kept = (entry: RemapEntry): boolean => !entry.flags.includes('excluded')

const writableVariable = (entry: RemapEntry): boolean =>
  kept(entry) &&
  entry.site.kind === 'variable' &&
  entry.site.editable &&
  !entry.flags.includes('library') &&
  !entry.flags.includes('unchanged')

const writableStyle = (entry: RemapEntry): boolean =>
  kept(entry) &&
  (entry.site.kind === 'style' || entry.site.kind === 'gradient-stop' || entry.site.kind === 'effect') &&
  entry.site.editable &&
  !entry.flags.includes('unchanged')

const writableLoose = (entry: RemapEntry): boolean =>
  kept(entry) && entry.site.kind === 'detached' && !entry.flags.includes('unchanged')

/* ------------------------------------------------------------------ apply */

interface Loader {
  variable(id: string): Promise<Variable | null>
}

function makeLoader(): Loader {
  const cache = new Map<string, Variable | null>()
  return {
    async variable(id) {
      if (cache.has(id)) return cache.get(id) ?? null
      const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null)
      cache.set(id, variable)
      return variable
    },
  }
}

/**
 * A loose color that turns out to be a token gets bound to it rather than repainted.
 *
 * The match is against the variable's *old* value — that is what a detached copy of the token
 * looks like — and the same just-noticeable tolerance the linter already snaps with, so a
 * color someone eyedropped a shade off still finds its way home. Everything else keeps a
 * literal: minting a token out of a one-off color is how files fill up with `auto/…` noise.
 */
const SNAP_DELTA_E = 2

function bindingCandidates(plan: RemapPlan): Map<string, string> {
  const byColor = new Map<string, string>()
  const entries = plan.entries.filter(writableVariable)

  for (const entry of entries) {
    const address = splitSiteId(entry.site.id)
    if (!address) continue
    const key = looseSiteId(hexOf(entry.from), entry.from.a)
    if (!byColor.has(key)) byColor.set(key, address.variableId)
  }
  return byColor
}

function nearestVariableFor(entry: RemapEntry, plan: RemapPlan): string | null {
  let bestId: string | null = null
  let bestDistance = SNAP_DELTA_E
  for (const candidate of plan.entries) {
    if (!writableVariable(candidate)) continue
    if (Math.abs(candidate.from.a - entry.from.a) > 0.01) continue
    const distance = deltaE(candidate.from, entry.from)
    if (distance < bestDistance) {
      bestDistance = distance
      const address = splitSiteId(candidate.site.id)
      if (address) bestId = address.variableId
    }
  }
  return bestId
}

async function applyStyles(
  plan: RemapPlan,
  snapshot: RemapSnapshot,
  report: RemapApplyReport
): Promise<void> {
  const byStyle = new Map<string, Array<{ entry: RemapEntry; address: StyleAddress }>>()
  for (const entry of plan.entries) {
    if (!writableStyle(entry)) continue
    const address = parseStyleSiteId(entry.site.id)
    if (!address) continue
    const group = byStyle.get(address.styleId)
    if (group) group.push({ entry, address })
    else byStyle.set(address.styleId, [{ entry, address }])
  }

  for (const [styleId, group] of byStyle) {
    const style = await figma.getStyleByIdAsync(styleId).catch(() => null)
    if (!style) {
      report.failed += group.length
      continue
    }

    try {
      if (style.type === 'PAINT') {
        const paints = (style as PaintStyle).paints.map((paint) => ({ ...paint })) as Paint[]
        for (const { entry, address } of group) {
          const paint = paints[address.index]
          if (!paint) continue
          if (address.stop === null && paint.type === 'SOLID') {
            snapshot.styles.push({ s: styleId, p: 'paints', i: address.index, j: -1, c: channelsOf({ ...paint.color, a: paint.opacity ?? 1 }) })
            paints[address.index] = { ...paint, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b }, opacity: entry.to.a }
            report.paints++
          } else if (address.stop !== null && isGradient(paint)) {
            const stops = paint.gradientStops.map((stop) => ({ ...stop }))
            const stop = stops[address.stop]
            if (!stop) continue
            snapshot.styles.push({ s: styleId, p: 'paints', i: address.index, j: address.stop, c: channelsOf(withAlpha(stop.color)) })
            stops[address.stop] = { ...stop, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } }
            paints[address.index] = { ...paint, gradientStops: stops }
            report.paints++
          }
        }
        ;(style as PaintStyle).paints = paints
      } else if (style.type === 'EFFECT') {
        const effects = (style as EffectStyle).effects.map((effect) => ({ ...effect })) as Effect[]
        for (const { entry, address } of group) {
          const effect = effects[address.index]
          if (!effect || !isShadow(effect)) continue
          snapshot.styles.push({ s: styleId, p: 'effects', i: address.index, j: -1, c: channelsOf(withAlpha(effect.color)) })
          effects[address.index] = { ...effect, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } }
          report.paints++
        }
        ;(style as EffectStyle).effects = effects
      } else {
        continue
      }
      report.styles++
    } catch (error) {
      report.failed += group.length
      report.warnings.push(`${style.name}: ${String((error as Error).message)}`)
    }
  }
}

/* ------------------------------------------------------------------ canvas */

async function scopeRoots(scope: RemapScope): Promise<readonly SceneNode[]> {
  if (scope === 'selection') return figma.currentPage.selection
  if (scope === 'page') return figma.currentPage.children
  const roots: SceneNode[] = []
  for (const page of figma.root.children) roots.push(...page.children)
  return roots
}

/**
 * Colors inside an instance are not written.
 *
 * A local instance mirrors its main component, and the main is visited by this same walk —
 * writing on the sublayer as well would either duplicate the work or, worse, freeze the layer
 * into a per-instance override it never had. A library instance's colors belong to the
 * library, exactly like a library variable's value does, so they are reported rather than
 * overridden. What that leaves behind is a real per-instance override a designer made by hand;
 * those are counted and named in the report instead of being silently rewritten.
 */
const COLOR_FIELDS = ['fills', 'strokes', 'effects']

function colorOverrideCount(instance: InstanceNode): number {
  try {
    return instance.overrides.filter((override) =>
      override.overriddenFields.some((field) => COLOR_FIELDS.indexOf(field as string) !== -1)
    ).length
  } catch {
    return 0
  }
}

interface CanvasContext {
  targets: Map<string, RemapEntry>
  bindTo: Map<string, Variable>
  snapshot: RemapSnapshot
  report: RemapApplyReport
  loader: Loader
  /** Nodes already written, so an instance and its main are never processed twice. */
  done: Set<string>
}

function rewritePaints(node: SceneNode, property: 'fills' | 'strokes', context: CanvasContext): boolean {
  if (styleIdOf(node, property) !== '') return false
  const paints = paintsOf(node, property)
  if (paints.length === 0) return false

  const nodeLevel = nodeLevelBindings(node, property)
  const next = paints.map((paint) => ({ ...paint })) as Paint[]
  const code = property === 'fills' ? 0 : 1
  let touched = false

  for (const [index, paint] of paints.entries()) {
    if (paint.visible === false) continue
    const paintBound = (paint as { boundVariables?: { color?: unknown } }).boundVariables?.color
    if (paintBound || nodeLevel[index]) continue

    if (paint.type === 'SOLID') {
      const alpha = paint.opacity ?? 1
      const entry = context.targets.get(looseSiteId(hexOf(paint.color), alpha))
      if (!entry) continue
      const variable = context.bindTo.get(entry.site.id)
      let replacement: SolidPaint = { ...paint, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b }, opacity: entry.to.a }
      if (variable) {
        replacement = figma.variables.setBoundVariableForPaint(replacement, 'color', variable)
        context.report.bound++
      }
      next[index] = replacement
      context.snapshot.paints.push([node.id, code, index, -1, ...channelsOf({ ...paint.color, a: alpha }), variable ? 1 : 0])
      context.report.paints++
      touched = true
      continue
    }

    if (!isGradient(paint)) continue
    const stops = paint.gradientStops.map((stop) => ({ ...stop }))
    let stopTouched = false
    for (const [stopIndex, stop] of paint.gradientStops.entries()) {
      const color = withAlpha(stop.color)
      const entry = context.targets.get(looseSiteId(hexOf(color), color.a))
      if (!entry) continue
      stops[stopIndex] = { ...stop, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } }
      context.snapshot.paints.push([node.id, code, index, stopIndex, ...channelsOf(color), 0])
      context.report.paints++
      stopTouched = true
    }
    if (stopTouched) {
      next[index] = { ...paint, gradientStops: stops }
      touched = true
    }
  }

  if (!touched) return false
  ;(node as unknown as Record<string, unknown>)[property] = next
  return true
}

function rewriteEffects(node: SceneNode, context: CanvasContext): boolean {
  if (styleIdOf(node, 'effects') !== '') return false
  if (!('effects' in node) || !Array.isArray(node.effects) || node.effects.length === 0) return false

  const next = node.effects.map((effect) => ({ ...effect })) as Effect[]
  let touched = false

  for (const [index, effect] of node.effects.entries()) {
    if (!isShadow(effect) || effect.visible === false) continue
    if ((effect as { boundVariables?: { color?: unknown } }).boundVariables?.color) continue
    const color = withAlpha(effect.color)
    const entry = context.targets.get(looseSiteId(hexOf(color), color.a))
    if (!entry) continue
    next[index] = { ...effect, color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } }
    context.snapshot.paints.push([node.id, 2, index, -1, ...channelsOf(color), 0])
    context.report.paints++
    touched = true
  }

  if (!touched) return false
  ;(node as unknown as Record<string, unknown> & { effects: Effect[] }).effects = next
  return true
}

async function applyCanvas(
  plan: RemapPlan,
  options: RemapApplyOptions,
  snapshot: RemapSnapshot,
  report: RemapApplyReport,
  loader: Loader,
  progress?: (label: string) => void
): Promise<void> {
  const targets = new Map<string, RemapEntry>()
  for (const entry of plan.entries) if (writableLoose(entry)) targets.set(entry.site.id, entry)
  if (targets.size === 0) return

  const bindTo = new Map<string, Variable>()
  if (options.bind) {
    const exact = bindingCandidates(plan)
    for (const entry of targets.values()) {
      const variableId = exact.get(entry.site.id) ?? nearestVariableFor(entry, plan)
      if (!variableId) continue
      const variable = await loader.variable(variableId)
      if (variable) bindTo.set(entry.site.id, variable)
    }
  }

  const context: CanvasContext = { targets, bindTo, snapshot, report, loader, done: new Set() }
  const roots = await scopeRoots(options.scope)

  figma.skipInvisibleInstanceChildren = true
  try {
    const stack: SceneNode[] = [...roots]
    let visited = 0
    while (stack.length > 0) {
      const node = stack.pop() as SceneNode
      visited++

      if (node.type === 'INSTANCE') {
        report.instanceOverrides += colorOverrideCount(node)
        continue
      }

      rewritePaints(node, 'fills', context)
      rewritePaints(node, 'strokes', context)
      rewriteEffects(node, context)

      if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])

      if (visited % 200 === 0) {
        progress?.(`repainting… ${report.paints} places`)
        await yieldToHost()
      }
    }
  } finally {
    figma.skipInvisibleInstanceChildren = false
  }

  if (report.instanceOverrides > 0) {
    report.warnings.push(
      `${report.instanceOverrides} hand-made color override${report.instanceOverrides === 1 ? '' : 's'} on instances ` +
        'kept the old color — an override belongs to that one instance, not to the system, so it is left for a human'
    )
  }
}

/* ------------------------------------------------------------------ budget */

/** Rough JSON cost of one snapshot record of each kind, measured against real output. */
const BYTES = { value: 90, name: 70, style: 70, paint: 60 }

/**
 * Whether the undo record will fit, decided *before* anything is written.
 *
 * The style and canvas passes only learn a color's previous value while they are overwriting
 * it, so their snapshot cannot be stored up front — which means a size check afterwards would
 * come too late to refuse. The count is knowable in advance though: every loose entry carries
 * how many places wear it. The estimate is an upper bound (application scope can only narrow
 * it), and it is deliberately conservative.
 */
export function estimateSnapshotBytes(plan: RemapPlan, options: RemapApplyOptions): number {
  const values = options.values ? plan.entries.filter(writableVariable).length : 0
  const names = options.rename ? plan.renames.length : 0
  const styles = options.styles ? plan.entries.filter(writableStyle).length : 0
  const paints = options.canvas
    ? plan.entries.filter(writableLoose).reduce((total, entry) => total + Math.max(1, entry.site.usage), 0)
    : 0
  return values * BYTES.value + names * BYTES.name + styles * BYTES.style + paints * BYTES.paint
}

export const SNAPSHOT_BUDGET_BYTES = CHUNK_BYTES * MAX_CHUNKS

/* ------------------------------------------------------------------ entry point */

export async function applyRemap(
  plan: RemapPlan,
  options: RemapApplyOptions = DEFAULT_REMAP_APPLY_OPTIONS,
  progress?: (label: string) => void
): Promise<RemapApplyReport> {
  const warnings: string[] = []
  const report: RemapApplyReport = {
    values: 0,
    renamed: 0,
    legacy: 0,
    styles: 0,
    paints: 0,
    bound: 0,
    instanceOverrides: 0,
    skippedLibrary: plan.entries.filter((entry) => entry.flags.includes('library')).length,
    unchanged: plan.entries.filter((entry) => entry.flags.includes('unchanged')).length,
    failed: 0,
    snapshotBytes: 0,
    warnings,
  }

  const valueTargets = options.values ? plan.entries.filter(writableVariable) : []
  // Renaming a variable is writing to it. Letting the two come apart is how a run that was
  // asked only to draw a board on canvas ended up renaming the palette and parking the
  // collisions in legacy/.
  const renames = options.rename && options.values ? plan.renames : []
  const hasStyles = options.styles && plan.entries.some(writableStyle)
  const hasCanvas = options.canvas && plan.entries.some(writableLoose)
  if (valueTargets.length === 0 && renames.length === 0 && !hasStyles && !hasCanvas) {
    warnings.push('nothing to write')
    return report
  }

  const estimate = estimateSnapshotBytes(plan, options)
  if (estimate > SNAPSHOT_BUDGET_BYTES) {
    throw new Error(
      `This remap would need about ${Math.round(estimate / 1024)} kB of undo data, more than the ` +
        `${Math.round(SNAPSHOT_BUDGET_BYTES / 1024)} kB a Figma file can hold for a plugin. Nothing was written — ` +
        'narrow the scope, or turn off repainting loose layers and run that pass on its own.'
    )
  }

  progress?.('loading variables…')
  const loader = makeLoader()
  const snapshot: RemapSnapshot = { version: 2, values: [], names: [], styles: [], paints: [] }

  // The snapshot is taken from the live document, not from the plan, so Revert restores what
  // was really there even if the plan was built against a slightly older reading.
  for (const entry of valueTargets) {
    const address = splitSiteId(entry.site.id)
    if (!address) continue
    const variable = await loader.variable(address.variableId)
    if (!variable) continue
    const current = variable.valuesByMode[address.modeId]
    if (current === undefined || typeof current !== 'object' || !('r' in current)) continue
    snapshot.values.push({ v: address.variableId, m: address.modeId, c: channelsOf(current as RGBA) })
  }
  for (const rename of renames) {
    const address = splitSiteId(rename.siteId)
    if (!address) continue
    const variable = await loader.variable(address.variableId)
    if (variable) snapshot.names.push({ v: address.variableId, n: variable.name })
  }

  // Styles and canvas snapshot themselves as they are written — their old values are only
  // knowable while walking them — so those passes run before the snapshot is stored.
  if (hasStyles) {
    progress?.('writing styles…')
    await applyStyles(plan, snapshot, report)
  }
  if (hasCanvas) {
    progress?.('repainting layers…')
    await applyCanvas(plan, options, snapshot, report, loader, progress)
  }

  progress?.('storing the snapshot…')
  try {
    report.snapshotBytes = writeChunked(JSON.stringify(snapshot))
  } catch (error) {
    // The pre-flight estimate should have caught this; if it did not, the styles and layers are
    // already changed, so say exactly that rather than implying the file is untouched.
    clearSnapshot()
    warnings.push(
      `${String((error as Error).message)}. ${report.paints} painted places changed before this was known ` +
        'and cannot be reverted from here — use Figma version history if you need them back.'
    )
  }

  let written = 0
  for (const entry of valueTargets) {
    const address = splitSiteId(entry.site.id)
    const variable = address ? await loader.variable(address.variableId) : null
    if (!address || !variable) {
      report.failed++
      continue
    }
    try {
      variable.setValueForMode(address.modeId, { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a })
      report.values++
    } catch (error) {
      report.failed++
      warnings.push(`${entry.site.name}: ${String((error as Error).message)}`)
    }
    if (++written % 100 === 0) {
      progress?.(`writing values… ${written}/${valueTargets.length}`)
      await yieldToHost()
    }
  }

  if (renames.length > 0) {
    progress?.('renaming…')
    const applied: Array<{ from: string; to: string }> = []
    const staged: Array<{ variable: Variable; to: string; from: string; legacy: boolean }> = []

    // Pass one: park every rename on a name nothing can collide with.
    for (const [index, rename] of renames.entries()) {
      const address = splitSiteId(rename.siteId)
      const variable = address ? await loader.variable(address.variableId) : null
      if (!variable) {
        report.failed++
        continue
      }
      const from = variable.name
      try {
        variable.name = `__altery-remap-${index}`
        staged.push({ variable, to: rename.to, from, legacy: rename.legacy })
      } catch (error) {
        report.failed++
        warnings.push(`${from}: ${String((error as Error).message)}`)
      }
    }

    // Pass two: settle on the final names, now that none of the old ones are in the way.
    for (const item of staged) {
      try {
        item.variable.name = item.to
        applied.push({ from: item.from, to: item.to })
        report.renamed++
        if (item.legacy) report.legacy++
      } catch (error) {
        item.variable.name = item.from
        report.failed++
        warnings.push(`${item.from} → ${item.to}: ${String((error as Error).message)}`)
      }
    }

    writeRenameMap(foldRenames(readRenameMap(), applied))
  }

  return report
}

/* ------------------------------------------------------------------ unparking */

export interface UnparkReport {
  restored: number
  blocked: string[]
  warnings: string[]
}

/**
 * Puts back the names this plugin moved into the legacy group.
 *
 * Only those: the stored rename map says which variables *this tool* renamed and where to, so
 * a `legacy/` group the team curated by hand is never touched. A name that something else has
 * taken since is reported rather than forced, because forcing it would just move the collision
 * somewhere else.
 */
export async function unparkLegacyNames(legacyGroup = 'legacy'): Promise<UnparkReport> {
  const map = readRenameMap()
  const parked = Object.entries(map).filter(([, to]) => to.startsWith(`${legacyGroup}/`))
  if (parked.length === 0) return { restored: 0, blocked: [], warnings: ['this plugin has parked no names in this file'] }

  const variables = await figma.variables.getLocalVariablesAsync('COLOR')
  const byName = new Map<string, Variable>()
  for (const variable of variables) byName.set(variable.name, variable)

  const report: UnparkReport = { restored: 0, blocked: [], warnings: [] }
  const remaining: RenameMap = { ...map }

  for (const [original, current] of parked) {
    const variable = byName.get(current)
    if (!variable) {
      report.blocked.push(`${current} is not in this file any more`)
      continue
    }
    if (byName.has(original)) {
      report.blocked.push(`${original} is taken — ${current} stays where it is`)
      continue
    }
    try {
      variable.name = original
      byName.delete(current)
      byName.set(original, variable)
      delete remaining[original]
      report.restored++
    } catch (error) {
      report.blocked.push(`${current}: ${String((error as Error).message)}`)
    }
  }

  writeRenameMap(remaining)
  return report
}

/* ------------------------------------------------------------------ revert */

async function revertStyles(snapshot: RemapSnapshot, warnings: string[]): Promise<number> {
  const byStyle = new Map<string, SnapshotStyle[]>()
  for (const entry of snapshot.styles) {
    const group = byStyle.get(entry.s)
    if (group) group.push(entry)
    else byStyle.set(entry.s, [entry])
  }

  let restored = 0
  for (const [styleId, group] of byStyle) {
    const style = await figma.getStyleByIdAsync(styleId).catch(() => null)
    if (!style) continue
    try {
      if (style.type === 'PAINT') {
        const paints = (style as PaintStyle).paints.map((paint) => ({ ...paint })) as Paint[]
        for (const entry of group) {
          const paint = paints[entry.i]
          if (!paint) continue
          const color = colorOf(entry.c)
          if (entry.j < 0 && paint.type === 'SOLID') {
            paints[entry.i] = { ...paint, color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }
          } else if (entry.j >= 0 && isGradient(paint)) {
            const stops = paint.gradientStops.map((stop) => ({ ...stop }))
            if (!stops[entry.j]) continue
            stops[entry.j] = { ...stops[entry.j], color }
            paints[entry.i] = { ...paint, gradientStops: stops }
          }
          restored++
        }
        ;(style as PaintStyle).paints = paints
      } else if (style.type === 'EFFECT') {
        const effects = (style as EffectStyle).effects.map((effect) => ({ ...effect })) as Effect[]
        for (const entry of group) {
          const effect = effects[entry.i]
          if (!effect || !isShadow(effect)) continue
          effects[entry.i] = { ...effect, color: colorOf(entry.c) }
          restored++
        }
        ;(style as EffectStyle).effects = effects
      }
    } catch (error) {
      warnings.push(`${style.name}: ${String((error as Error).message)}`)
    }
  }
  return restored
}

async function revertPaints(
  snapshot: RemapSnapshot,
  warnings: string[],
  progress?: (label: string) => void
): Promise<number> {
  const byNode = new Map<string, SnapshotPaint[]>()
  for (const entry of snapshot.paints) {
    const group = byNode.get(entry[0])
    if (group) group.push(entry)
    else byNode.set(entry[0], [entry])
  }

  let restored = 0
  let handled = 0
  for (const [nodeId, group] of byNode) {
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null)
    if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') continue
    const scene = node as SceneNode

    try {
      for (const property of ['fills', 'strokes'] as const) {
        const code = property === 'fills' ? 0 : 1
        const mine = group.filter((entry) => entry[1] === code)
        if (mine.length === 0) continue
        const paints = paintsOf(scene, property).map((paint) => ({ ...paint })) as Paint[]
        for (const entry of mine) {
          const paint = paints[entry[2]]
          if (!paint) continue
          const color = colorOf([entry[4], entry[5], entry[6], entry[7]])
          if (entry[3] < 0 && paint.type === 'SOLID') {
            let restoredPaint: SolidPaint = { ...paint, color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }
            // Undo the binding this run added, or the color would snap straight back.
            if (entry[8] === 1) restoredPaint = figma.variables.setBoundVariableForPaint(restoredPaint, 'color', null)
            paints[entry[2]] = restoredPaint
          } else if (entry[3] >= 0 && isGradient(paint)) {
            const stops = paint.gradientStops.map((stop) => ({ ...stop }))
            if (!stops[entry[3]]) continue
            stops[entry[3]] = { ...stops[entry[3]], color }
            paints[entry[2]] = { ...paint, gradientStops: stops }
          }
          restored++
        }
        ;(scene as unknown as Record<string, unknown>)[property] = paints
      }

      const shadows = group.filter((entry) => entry[1] === 2)
      if (shadows.length > 0 && 'effects' in scene && Array.isArray(scene.effects)) {
        const effects = scene.effects.map((effect) => ({ ...effect })) as Effect[]
        for (const entry of shadows) {
          const effect = effects[entry[2]]
          if (!effect || !isShadow(effect)) continue
          effects[entry[2]] = { ...effect, color: colorOf([entry[4], entry[5], entry[6], entry[7]]) }
          restored++
        }
        ;(scene as unknown as Record<string, unknown> & { effects: Effect[] }).effects = effects
      }
    } catch (error) {
      warnings.push(`${scene.name}: ${String((error as Error).message)}`)
    }

    if (++handled % 100 === 0) {
      progress?.(`restoring layers… ${handled}/${byNode.size}`)
      await yieldToHost()
    }
  }
  return restored
}

export async function revertRemap(progress?: (label: string) => void): Promise<RemapRevertReport> {
  const warnings: string[] = []
  const empty = { values: 0, names: 0, styles: 0, paints: 0 }
  const raw = readChunked()
  if (raw === '') return { ...empty, warnings: ['there is nothing to revert'] }

  let snapshot: RemapSnapshot
  try {
    snapshot = JSON.parse(raw) as RemapSnapshot
  } catch {
    clearSnapshot()
    return { ...empty, warnings: ['the stored snapshot is unreadable and has been discarded'] }
  }

  const loader = makeLoader()

  // Names first: a name parked under legacy/ has to come home before anything else can claim
  // it back, and the two-pass dance is needed here for the same reason as in Apply.
  let names = 0
  const staged: Array<{ variable: Variable; to: string }> = []
  for (const [index, entry] of (snapshot.names ?? []).entries()) {
    const variable = await loader.variable(entry.v)
    if (!variable) continue
    try {
      variable.name = `__altery-revert-${index}`
      staged.push({ variable, to: entry.n })
    } catch (error) {
      warnings.push(`${entry.n}: ${String((error as Error).message)}`)
    }
  }
  for (const item of staged) {
    try {
      item.variable.name = item.to
      names++
    } catch (error) {
      warnings.push(`${item.to}: ${String((error as Error).message)}`)
    }
  }

  let values = 0
  for (const [index, entry] of (snapshot.values ?? []).entries()) {
    const variable = await loader.variable(entry.v)
    if (!variable) continue
    try {
      variable.setValueForMode(entry.m, colorOf(entry.c))
      values++
    } catch (error) {
      warnings.push(`${variable.name}: ${String((error as Error).message)}`)
    }
    if ((index + 1) % 100 === 0) {
      progress?.(`restoring values… ${index + 1}/${snapshot.values.length}`)
      await yieldToHost()
    }
  }

  const styles = snapshot.styles ? await revertStyles(snapshot, warnings) : 0
  const paints = snapshot.paints ? await revertPaints(snapshot, warnings, progress) : 0

  clearSnapshot()
  // The aliases described a rename that no longer exists.
  const restored = new Set((snapshot.names ?? []).map((entry) => entry.n))
  const map = readRenameMap()
  for (const key of Object.keys(map)) if (restored.has(key)) delete map[key]
  writeRenameMap(map)

  return { values, names, styles, paints, warnings }
}
