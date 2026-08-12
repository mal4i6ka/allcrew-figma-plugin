/**
 * Auto-fixes for the design linter's findings (src/lint/index.ts):
 * - `unbound-fill` / `unbound-stroke` — binds each visible solid paint to a color variable with
 *   the same rendered value. Match order: tokens from the design-system libraries enabled for
 *   this file first, then local variables, and only when neither matches creates one in a local
 *   "Lint fixes" collection. Matching resolves alias chains (semantic → primitive), compares in
 *   the mode that actually renders at the node, ranks scope-compatible/publishable tokens first,
 *   and snaps imperceptibly-off colors (same alpha, ΔE ≤ SNAP_DELTA_E) to the nearest token
 *   instead of minting near-duplicate auto variables.
 * - `text-without-style` — applies a text style reproducing the node's full text look (font,
 *   size, line height, letter spacing): remote styles already used on the page first (the Plugin
 *   API has no listing for library styles, unlike variables), then local styles, creating a
 *   local one when nothing matches.
 * - `missing-auto-layout` — infers a best-effort Auto Layout (direction, spacing, padding,
 *   cross-axis alignment) from the children's current geometry and applies it only when the
 *   predicted layout keeps every child within AUTO_LAYOUT_DRIFT_TOLERANCE of its position.
 * - `excessive-nesting` — unwraps redundant single-child wrapper frames/groups above the flagged
 *   node (an absolute child keeps its exact position; an Auto Layout child inherits the wrapper's
 *   slot). If the node is trapped inside a component instance whose internals block the edit, the
 *   instance is detached first (the user's opt-in "break the component") and the node re-found.
 *
 * Nodes inside a component instance need care: their layout/structure can't change, but Figma
 * DOES allow per-instance *overrides* of fills, strokes and text styles on instance sublayers
 * (same as recoloring a nested layer in the editor). A fix on a *local* instance's sublayer
 * redirects to the counterpart in the main component (`resolveEditableTarget`) — one edit
 * propagates to every instance and survives a re-scan. A sublayer of a *remote* (library)
 * instance — whose source can't be edited from this file — gets the paint/text fix applied
 * directly on the sublayer as an override; only layout fixes stay skipped there.
 */

import type { LintFinding, LintRule } from './index.ts'
import { resolveVariableValue } from '../../../variables.ts'
import { yieldToHost } from '../../../utils/tree.ts'

export type LintFixStatus = 'fixed' | 'skipped' | 'failed'

export interface LintFixRequest {
  nodeId: string
  rule: LintRule
}

export interface LintFixResult {
  nodeId: string
  nodeName: string
  rule: LintRule
  status: LintFixStatus
  detail: string
}

export const FIXABLE_RULES: ReadonlyArray<LintRule> = [
  'unbound-fill',
  'unbound-stroke',
  'text-without-style',
  'missing-auto-layout',
  'excessive-nesting',
]

/** Name of the variable collection auto-created fills are grouped under. */
export const FIX_COLLECTION_NAME = 'Lint fixes'

/** Caches local variables/styles once per FIX_LINT batch so fixing 2000 findings doesn't
 * re-query (or re-create duplicates of) the same variable per finding. */
export interface FixContext {
  colorVariables: Variable[]
  /** COLOR variables from the design-system libraries enabled for this file, imported on the
   * first paint fix of the batch (importing a whole design system is wasted work for batches
   * without fill/stroke findings). `null` = not loaded yet. */
  libraryColorVariables: Variable[] | null
  /** Matching pool built from library + local variables on the first paint fix: values are
   * alias-resolved per mode, so a semantic token (`text/primary` → `base/black`) matches the
   * concrete color it renders as. Library candidates come first. `null` = not built yet. */
  colorCandidates: ColorCandidate[] | null
  /** collectionId → defaultModeId (`null` = collection unreadable), cached across candidates. */
  collectionDefaultMode: Map<string, string | null>
  textStyles: TextStyle[]
  /** Remote text styles already consumed somewhere on the current page — the only pool of
   * library text styles the Plugin API can enumerate. `null` = not harvested yet. */
  remoteTextStyles: TextStyle[] | null
  fixCollection: VariableCollection | null
  /** `<nodeId>/<fills|strokes>` keys this batch already bound. When several instances of the
   * same component are flagged, they all redirect to one main node — this lets the later ones
   * report `fixed` ("bound via shared component") instead of a confusing `skipped: nothing to bind`. */
  boundPaintKeys: Set<string>
  /** Optional live-status hook for the long preparation phases (importing a library's tokens can
   * take minutes on a big design system) — without it the UI looks frozen mid-batch. */
  progress?: (label: string) => void
}

export async function buildFixContext(progress?: (label: string) => void): Promise<FixContext> {
  return {
    colorVariables: await figma.variables.getLocalVariablesAsync('COLOR'),
    libraryColorVariables: null,
    colorCandidates: null,
    collectionDefaultMode: new Map(),
    textStyles: await figma.getLocalTextStylesAsync(),
    remoteTextStyles: null,
    fixCollection: null,
    boundPaintKeys: new Set<string>(),
    progress,
  }
}

// --- instance redirection: fixes on instance sublayers move to the main component ---

/** Nearest ancestor that is a component instance, or `null` when `node` is not inside one.
 * Paints/text styles CAN be overridden in place on instance sublayers, but a fix prefers the
 * main component (one edit propagates to every instance); layout/structure can't change on
 * sublayers at all. Exported for the scan post-pass in code.ts that marks unfixable findings. */
export function enclosingInstance(node: SceneNode): InstanceNode | null {
  let current: BaseNode | null = node.parent
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (current.type === 'INSTANCE') return current as InstanceNode
    current = current.parent
  }
  return null
}

/** The counterpart node id inside the (deepest) main component. Figma composes instance-sublayer
 * ids as `I<instance>;…;<mainNodeId>`; the segment after the last `;` is that main node. Returns
 * `null` for a plain (non-instance-sublayer) id. */
function mainComponentSubId(nodeId: string): string | null {
  const index = nodeId.lastIndexOf(';')
  return index === -1 ? null : nodeId.slice(index + 1)
}

export type EditableTarget =
  | { kind: 'node'; node: SceneNode; onMainComponent: boolean }
  | { kind: 'library' }

/** Resolves the node an auto-fix should ideally mutate. A node outside any instance is returned
 * as-is. A node inside a *local* instance resolves to its counterpart in the main component (so the
 * binding propagates to every instance and isn't reverted on the next scan). A node inside a
 * *remote/library* instance — or one whose counterpart can't be resolved — has no editable source
 * here (`kind: 'library'`); the caller applies paint/text fixes directly on the sublayer as
 * per-instance overrides, and skips layout fixes (structural, not overridable). */
export async function resolveEditableTarget(node: SceneNode): Promise<EditableTarget> {
  const instance = enclosingInstance(node)
  if (!instance) return { kind: 'node', node, onMainComponent: false }

  const main = await instance.getMainComponentAsync()
  if (!main || main.remote) return { kind: 'library' }

  const subId = mainComponentSubId(node.id)
  if (subId) {
    const counterpart = await figma.getNodeByIdAsync(subId)
    if (counterpart && counterpart.type !== 'PAGE' && counterpart.type !== 'DOCUMENT') {
      return { kind: 'node', node: counterpart as SceneNode, onMainComponent: true }
    }
  }
  return { kind: 'library' }
}

export function colorsMatch(a: RGB | RGBA, b: RGB | RGBA, epsilon = 0.001): boolean {
  const alphaOf = (c: RGB | RGBA) => ('a' in c ? c.a : 1)
  return (
    Math.abs(a.r - b.r) <= epsilon &&
    Math.abs(a.g - b.g) <= epsilon &&
    Math.abs(a.b - b.b) <= epsilon &&
    Math.abs(alphaOf(a) - alphaOf(b)) <= epsilon
  )
}

// --- perceptual color distance (CIE76 ΔE in Lab) for near-token snapping ---

function srgbToLab({ r, g, b }: RGB | RGBA): { L: number; a: number; b: number } {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  // sRGB (D65) → XYZ, normalized to the white point
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** CIE76 ΔE between two colors' RGB parts. Alpha never participates — Figma color tokens are
 * RGBA, so a translucent token is a different token, not a near match. */
export function colorDeltaE(a: RGB | RGBA, b: RGB | RGBA): number {
  const labA = srgbToLab(a)
  const labB = srgbToLab(b)
  return Math.hypot(labA.L - labB.L, labA.a - labB.a, labA.b - labB.b)
}

/** Fills whose color is imperceptibly off a token (eyedropper / anti-aliasing noise, e.g.
 * #020202 vs #000000) snap to that token instead of minting a near-duplicate auto variable.
 * ~2.3 is the classic just-noticeable difference; alpha must match within SNAP_ALPHA_EPSILON. */
export const SNAP_DELTA_E = 2
const SNAP_ALPHA_EPSILON = 0.01

function channelToHex(channel: number): string {
  return Math.round(channel * 255).toString(16).padStart(2, '0')
}

function cssHex(color: RGB | RGBA): string {
  return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`
}

/** `auto/ff5b0a` (plus `-a50` for 50% alpha) — a stable, readable name for created variables. */
export function autoVariableName(color: RGBA): string {
  const hex = `${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`
  return color.a >= 1 ? `auto/${hex}` : `auto/${hex}-a${Math.round(color.a * 100)}`
}

// --- missing-auto-layout: pure geometry inference (unit-testable without the figma global) ---

export interface ChildRect {
  x: number
  y: number
  width: number
  height: number
}

export interface InferredAutoLayout {
  layoutMode: 'HORIZONTAL' | 'VERTICAL'
  itemSpacing: number
  paddingLeft: number
  paddingRight: number
  paddingTop: number
  paddingBottom: number
  /** Cross-axis alignment (`counterAxisAlignItems`) that best reproduces the children's
   * current positions — a centered stack must not left-snap when Auto Layout is applied. */
  counterAlign: 'MIN' | 'CENTER' | 'MAX'
  /** Child indices sorted along the primary axis — Auto Layout lays children out in
   * child-list order, so the frame's children must be reordered to match. */
  order: number[]
}

function sortedIndices(rects: readonly ChildRect[], axis: 'x' | 'y'): number[] {
  return rects.map((_, i) => i).sort((a, b) => rects[a][axis] - rects[b][axis])
}

/** True when the rects, visited in `order`, never overlap along `axis` (1px tolerance). */
function nonOverlapping(rects: readonly ChildRect[], order: readonly number[], axis: 'x' | 'y'): boolean {
  const size = axis === 'x' ? 'width' : 'height'
  for (let i = 1; i < order.length; i++) {
    const prev = rects[order[i - 1]]
    if (rects[order[i]][axis] < prev[axis] + prev[size] - 1) return false
  }
  return true
}

function medianGap(rects: readonly ChildRect[], order: readonly number[], axis: 'x' | 'y'): number {
  const size = axis === 'x' ? 'width' : 'height'
  const gaps: number[] = []
  for (let i = 1; i < order.length; i++) {
    const prev = rects[order[i - 1]]
    gaps.push(rects[order[i]][axis] - (prev[axis] + prev[size]))
  }
  if (gaps.length === 0) return 0
  gaps.sort((a, b) => a - b)
  return Math.max(0, Math.round(gaps[Math.floor(gaps.length / 2)]))
}

/** Where Auto Layout would place each child (indexed like `children`), given the inferred
 * settings — lets the fixer verify the fix reproduces the current geometry before touching
 * the node, instead of trusting the inference and mangling irregular layouts. */
function predictedRects(
  children: readonly ChildRect[],
  frameWidth: number,
  frameHeight: number,
  layout: InferredAutoLayout
): ChildRect[] {
  const horizontal = layout.layoutMode === 'HORIZONTAL'
  const innerStart = horizontal ? layout.paddingTop : layout.paddingLeft
  const innerSize = horizontal
    ? frameHeight - layout.paddingTop - layout.paddingBottom
    : frameWidth - layout.paddingLeft - layout.paddingRight
  const out: ChildRect[] = children.map((rect) => ({ ...rect }))
  let primary = horizontal ? layout.paddingLeft : layout.paddingTop
  for (const index of layout.order) {
    const child = children[index]
    const childCross = horizontal ? child.height : child.width
    const cross =
      layout.counterAlign === 'MIN'
        ? innerStart
        : layout.counterAlign === 'CENTER'
          ? innerStart + (innerSize - childCross) / 2
          : innerStart + innerSize - childCross
    out[index] = horizontal
      ? { x: primary, y: cross, width: child.width, height: child.height }
      : { x: cross, y: primary, width: child.width, height: child.height }
    primary += (horizontal ? child.width : child.height) + layout.itemSpacing
  }
  return out
}

/** Max distance (px, per axis) any child would move if the inferred Auto Layout were applied. */
export function autoLayoutDrift(
  children: readonly ChildRect[],
  frameWidth: number,
  frameHeight: number,
  layout: InferredAutoLayout
): number {
  const predicted = predictedRects(children, frameWidth, frameHeight, layout)
  let max = 0
  for (let i = 0; i < children.length; i++) {
    max = Math.max(max, Math.abs(predicted[i].x - children[i].x), Math.abs(predicted[i].y - children[i].y))
  }
  return max
}

/** Applying the fix must not visibly rearrange the design: gaps are rounded to a median and
 * paddings to integers, so a couple of px is expected noise — anything above means the frame
 * isn't really a row/stack (irregular gaps, mixed alignment) and the fix skips. */
export const AUTO_LAYOUT_DRIFT_TOLERANCE = 2

/** Infers Auto Layout settings from the children's absolute-positioned geometry, or `null`
 * when the children overlap on both axes (a grid/collage Auto Layout would mangle). */
export function inferAutoLayout(
  children: readonly ChildRect[],
  frameWidth: number,
  frameHeight: number
): InferredAutoLayout | null {
  if (children.length === 0) {
    return { layoutMode: 'VERTICAL', itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, counterAlign: 'MIN', order: [] }
  }

  const byX = sortedIndices(children, 'x')
  const byY = sortedIndices(children, 'y')
  const rowFits = nonOverlapping(children, byX, 'x')
  const columnFits = nonOverlapping(children, byY, 'y')
  if (!rowFits && !columnFits) return null

  // When both directions fit (single child, or a diagonal arrangement) pick the axis the
  // children actually spread along — ties fall back to VERTICAL, the common page-section case.
  let layoutMode: 'HORIZONTAL' | 'VERTICAL'
  if (rowFits && columnFits) {
    const spanX = Math.max(...children.map((r) => r.x + r.width)) - Math.min(...children.map((r) => r.x))
    const spanY = Math.max(...children.map((r) => r.y + r.height)) - Math.min(...children.map((r) => r.y))
    layoutMode = spanX > spanY ? 'HORIZONTAL' : 'VERTICAL'
  } else {
    layoutMode = rowFits ? 'HORIZONTAL' : 'VERTICAL'
  }

  const axis = layoutMode === 'HORIZONTAL' ? 'x' : 'y'
  const order = layoutMode === 'HORIZONTAL' ? byX : byY
  const minX = Math.min(...children.map((r) => r.x))
  const minY = Math.min(...children.map((r) => r.y))
  const maxRight = Math.max(...children.map((r) => r.x + r.width))
  const maxBottom = Math.max(...children.map((r) => r.y + r.height))

  const base: InferredAutoLayout = {
    layoutMode,
    itemSpacing: medianGap(children, order, axis),
    paddingLeft: Math.max(0, Math.round(minX)),
    paddingTop: Math.max(0, Math.round(minY)),
    paddingRight: Math.max(0, Math.round(frameWidth - maxRight)),
    paddingBottom: Math.max(0, Math.round(frameHeight - maxBottom)),
    counterAlign: 'MIN',
    order,
  }

  // Pick the cross-axis alignment that moves the children least (a centered stack keeps its
  // centering). The 0.5px margin keeps MIN — Figma's default — on effective ties.
  let best = base
  let bestDrift = autoLayoutDrift(children, frameWidth, frameHeight, base)
  for (const counterAlign of ['CENTER', 'MAX'] as const) {
    const variant = { ...base, counterAlign }
    const drift = autoLayoutDrift(children, frameWidth, frameHeight, variant)
    if (drift < bestDrift - 0.5) {
      best = variant
      bestDrift = drift
    }
  }
  return best
}

// --- fixers ---

export type PaintUsage = 'fill' | 'stroke'

/** A color variable prepared for matching: values alias-resolved per mode, publish/scope
 * metadata extracted. Library candidates precede local ones in the pool, so the connected
 * design system wins over local variables at equal rank. */
interface ColorCandidate {
  variable: Variable
  library: boolean
  hidden: boolean
  scopes: readonly VariableScope[]
  collectionId: string
  defaultModeId: string
  valueByMode: Map<string, RGBA>
}

/** Whether the variable's scopes would offer this binding in Figma's own picker. Used as a
 * ranking tier, not a hard filter — a scope-mismatched exact match still beats minting a
 * duplicate auto variable. */
export function scopeAllows(scopes: readonly VariableScope[], usage: PaintUsage, nodeType: string): boolean {
  if (scopes.length === 0 || scopes.includes('ALL_SCOPES')) return true
  if (usage === 'stroke') return scopes.includes('STROKE_COLOR')
  if (scopes.includes('ALL_FILLS')) return true
  if (nodeType === 'TEXT') return scopes.includes('TEXT_FILL')
  if (nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'SECTION') {
    return scopes.includes('FRAME_FILL')
  }
  return scopes.includes('SHAPE_FILL')
}

async function defaultModeOf(collectionId: string, ctx: FixContext): Promise<string | null> {
  const cached = ctx.collectionDefaultMode.get(collectionId)
  if (cached !== undefined) return cached
  let modeId: string | null = null
  try {
    modeId = (await figma.variables.getVariableCollectionByIdAsync(collectionId))?.defaultModeId ?? null
  } catch {
    /* collection unreadable — the candidate falls back to its first mode */
  }
  ctx.collectionDefaultMode.set(collectionId, modeId)
  return modeId
}

async function toColorCandidate(variable: Variable, library: boolean, ctx: FixContext): Promise<ColorCandidate | null> {
  const valueByMode = new Map<string, RGBA>()
  for (const modeId of Object.keys(variable.valuesByMode)) {
    try {
      const { value } = await resolveVariableValue(variable, modeId)
      if (typeof value === 'object' && value !== null && 'r' in value) {
        const color = value as RGB | RGBA
        valueByMode.set(modeId, { ...color, a: 'a' in color ? color.a : 1 })
      }
    } catch {
      /* broken alias / cycle — this mode can't participate in matching */
    }
  }
  if (valueByMode.size === 0) return null
  return {
    variable,
    library,
    hidden: variable.hiddenFromPublishing === true,
    scopes: variable.scopes ?? [],
    collectionId: variable.variableCollectionId,
    defaultModeId: (await defaultModeOf(variable.variableCollectionId, ctx)) ?? [...valueByMode.keys()][0],
    valueByMode,
  }
}

async function loadColorCandidates(ctx: FixContext): Promise<ColorCandidate[]> {
  if (ctx.colorCandidates) return ctx.colorCandidates
  const pool: ColorCandidate[] = []
  const sources: Array<[Variable, boolean]> = [
    ...(await loadLibraryColorVariables(ctx)).map((variable): [Variable, boolean] => [variable, true]),
    ...ctx.colorVariables.map((variable): [Variable, boolean] => [variable, false]),
  ]
  for (let i = 0; i < sources.length; i++) {
    const [variable, library] = sources[i]
    const candidate = await toColorCandidate(variable, library, ctx)
    if (candidate) pool.push(candidate)
    if ((i + 1) % 100 === 0) {
      ctx.progress?.(`preparing token matches… ${i + 1}/${sources.length}`)
      await yieldToHost()
    }
  }
  ctx.colorCandidates = pool
  return pool
}

/** The candidate's value in the mode that actually renders at `consumer` — Figma's
 * `resolvedVariableModes` (explicit-on-node ∪ inherited) when present, else the collection's
 * default mode. Matching "any mode" would bind tokens that only coincide in the other theme,
 * visibly recoloring the node. */
function candidateValueFor(candidate: ColorCandidate, consumer: SceneNode): RGBA | undefined {
  const modes = (consumer as SceneNode & { resolvedVariableModes?: Record<string, string> }).resolvedVariableModes
  const modeId = modes?.[candidate.collectionId] ?? candidate.defaultModeId
  return candidate.valueByMode.get(modeId) ?? candidate.valueByMode.get(candidate.defaultModeId)
}

interface PickedVariable {
  variable: Variable
  library: boolean
  /** Original color, set when it was snapped to a near token rather than matched exactly. */
  snappedFrom?: string
}

function pickColorCandidate(
  pool: readonly ColorCandidate[],
  color: RGBA,
  consumer: SceneNode,
  usage: PaintUsage
): PickedVariable | null {
  // Exact pass: scope-compatible beats scope-mismatched, publishable beats hidden-from-publishing;
  // pool order (library before local) breaks remaining ties.
  let best: { candidate: ColorCandidate; tier: number } | null = null
  for (const candidate of pool) {
    const value = candidateValueFor(candidate, consumer)
    if (!value || !colorsMatch(value, color)) continue
    const tier = (scopeAllows(candidate.scopes, usage, consumer.type) ? 0 : 2) + (candidate.hidden ? 1 : 0)
    if (tier === 0) return { variable: candidate.variable, library: candidate.library }
    if (!best || tier < best.tier) best = { candidate, tier }
  }
  if (best) return { variable: best.candidate.variable, library: best.candidate.library }

  // Near pass: identical alpha, RGB within a just-noticeable ΔE — nearest candidate wins.
  let near: { candidate: ColorCandidate; delta: number } | null = null
  for (const candidate of pool) {
    const value = candidateValueFor(candidate, consumer)
    if (!value || Math.abs(value.a - color.a) > SNAP_ALPHA_EPSILON) continue
    const delta = colorDeltaE(value, color)
    if (delta > SNAP_DELTA_E) continue
    if (!near || delta < near.delta) near = { candidate, delta }
  }
  if (near) return { variable: near.candidate.variable, library: near.candidate.library, snappedFrom: cssHex(color) }
  return null
}

/** COLOR variables of every library enabled for this file, imported once per batch. Matching
 * needs `valuesByMode`, which only *imported* variables expose — so all color tokens are imported
 * up front. `figma.teamLibrary.*` throws when the running session's manifest lacks the
 * `teamlibrary` permission (see readLibraryVariables in src/variables.ts); every failure degrades
 * to "fewer candidates" instead of failing the fix. */
async function loadLibraryColorVariables(ctx: FixContext): Promise<Variable[]> {
  if (ctx.libraryColorVariables) return ctx.libraryColorVariables
  const imported: Variable[] = []
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
    for (const collection of collections) {
      try {
        ctx.progress?.(`reading library "${collection.libraryName}"…`)
        const candidates = (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key)).filter(
          (candidate) => candidate.resolvedType === 'COLOR'
        )
        // Chunked: importing a full design system is thousands of round-trips — surface progress
        // and yield between chunks so the plugin doesn't look frozen for minutes.
        for (let i = 0; i < candidates.length; i += 50) {
          const chunk = candidates.slice(i, i + 50)
          const results = await Promise.all(
            chunk.map((candidate) => figma.variables.importVariableByKeyAsync(candidate.key).catch(() => null))
          )
          for (const variable of results) if (variable) imported.push(variable)
          ctx.progress?.(
            `importing "${collection.name}" tokens… ${Math.min(i + 50, candidates.length)}/${candidates.length}`
          )
          await yieldToHost()
        }
      } catch {
        /* unreadable collection — keep matching against the others */
      }
    }
  } catch {
    /* teamlibrary permission missing in this session — match local variables only */
  }
  ctx.libraryColorVariables = imported
  return imported
}

async function findOrCreateColorVariable(
  color: RGBA,
  consumer: SceneNode,
  usage: PaintUsage,
  ctx: FixContext
): Promise<PickedVariable> {
  // The connected design system wins: a published token beats both a local variable (often a
  // previously auto-created `auto/…` one) and creating anything new in this file.
  const pool = await loadColorCandidates(ctx)
  const picked = pickColorCandidate(pool, color, consumer, usage)
  if (picked) return picked

  if (!ctx.fixCollection) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    ctx.fixCollection =
      collections.find((collection) => collection.name === FIX_COLLECTION_NAME) ??
      figma.variables.createVariableCollection(FIX_COLLECTION_NAME)
  }
  const variable = figma.variables.createVariable(autoVariableName(color), ctx.fixCollection, 'COLOR')
  const modeId = ctx.fixCollection.modes[0].modeId
  variable.setValueForMode(modeId, color)
  ctx.colorVariables.push(variable)
  pool.push({
    variable,
    library: false,
    hidden: false,
    scopes: [],
    collectionId: ctx.fixCollection.id,
    defaultModeId: modeId,
    valueByMode: new Map([[modeId, color]]),
  })
  return { variable, library: false }
}

function bindingLabel(picked: PickedVariable): string {
  const notes = [
    ...(picked.library ? ['library'] : []),
    ...(picked.snappedFrom ? [`snapped from ${picked.snappedFrom}`] : []),
  ]
  return notes.length > 0 ? `${picked.variable.name} (${notes.join(', ')})` : picked.variable.name
}

const PAINT_PROP: Record<PaintUsage, 'fills' | 'strokes'> = { fill: 'fills', stroke: 'strokes' }

async function fixUnboundPaints(
  node: SceneNode,
  usage: PaintUsage,
  ctx: FixContext
): Promise<{ status: LintFixStatus; detail: string }> {
  const prop = PAINT_PROP[usage]
  const batchKey = `${node.id}/${prop}`
  // Another instance of the same component already bound this main node earlier in the batch.
  if (ctx.boundPaintKeys.has(batchKey)) {
    return { status: 'fixed', detail: 'bound via shared main component' }
  }
  // Paints coming from a paint style are already tokenized — binding a variable on top would
  // silently break the style link (the linter skips these too; guard against stale findings).
  const styleId = (node as { fillStyleId?: unknown; strokeStyleId?: unknown })[
    usage === 'fill' ? 'fillStyleId' : 'strokeStyleId'
  ]
  if (styleId !== undefined && styleId !== '') {
    return { status: 'skipped', detail: `${prop} come from a paint style — already tokenized, re-scan the scope` }
  }
  const paints = (node as unknown as { [key in 'fills' | 'strokes']?: unknown })[prop]
  if (!Array.isArray(paints)) {
    return { status: 'failed', detail: `${prop} are unreadable on this node` }
  }
  const boundPaints =
    'boundVariables' in node
      ? (node.boundVariables as { fills?: unknown[]; strokes?: unknown[] } | undefined)?.[prop]
      : undefined
  const next = (paints as Paint[]).slice()
  const boundNames: string[] = []
  for (let i = 0; i < next.length; i++) {
    const paint = next[i]
    // A paint counts as bound when either view says so: the node-level boundVariables map or
    // the paint object itself (after a main-component fix propagates into an instance sublayer,
    // the paint-level view is what's visible there).
    const paintBound = (paint as { boundVariables?: { color?: unknown } }).boundVariables?.color
    if (paint.type !== 'SOLID' || paint.visible === false || paintBound || boundPaints?.[i]) continue
    const color: RGBA = { ...paint.color, a: paint.opacity ?? 1 }
    const picked = await findOrCreateColorVariable(color, node, usage, ctx)
    next[i] = figma.variables.setBoundVariableForPaint(paint, 'color', picked.variable)
    boundNames.push(bindingLabel(picked))
  }
  if (boundNames.length === 0) {
    return { status: 'skipped', detail: `no unbound solid ${usage} found — re-scan the scope` }
  }
  ;(node as unknown as { [key in 'fills' | 'strokes']: Paint[] })[prop] = next
  ctx.boundPaintKeys.add(batchKey)
  return { status: 'fixed', detail: `bound to ${boundNames.join(', ')}` }
}

/** Remote text styles already consumed somewhere on the current page — the Plugin API has no
 * listing for library styles (unlike `figma.teamLibrary` for variables), so styles the file
 * already uses are the only enumerable design-system pool. Harvested once per batch. */
async function loadRemoteTextStyles(ctx: FixContext): Promise<TextStyle[]> {
  if (ctx.remoteTextStyles) return ctx.remoteTextStyles
  const styles: TextStyle[] = []
  ctx.progress?.('collecting page text styles…')
  try {
    const seen = new Set<string>()
    for (const text of figma.currentPage.findAllWithCriteria({ types: ['TEXT'] })) {
      const styleId = text.textStyleId
      if (typeof styleId !== 'string' || styleId === '' || seen.has(styleId)) continue
      seen.add(styleId)
      const style = await figma.getStyleByIdAsync(styleId)
      if (style?.type === 'TEXT' && style.remote) styles.push(style as TextStyle)
    }
  } catch {
    /* page walk / style lookup failed — match local styles only */
  }
  ctx.remoteTextStyles = styles
  return styles
}

/** unit+value equality for LineHeight/LetterSpacing ({unit:'AUTO'} carries no value). */
function metricEquals(
  a: { unit: string; value?: number } | undefined,
  b: { unit: string; value?: number } | undefined
): boolean {
  if (!a || !b || a.unit !== b.unit) return false
  if (a.value === undefined && b.value === undefined) return true
  return Math.abs((a.value ?? 0) - (b.value ?? 0)) <= 0.01
}

interface TextLook {
  fontName: FontName
  fontSize: number
  /** `undefined` = the node's value is mixed — don't constrain the match on it (the
   * created-style path leaves it at its default too). */
  lineHeight?: LineHeight
  letterSpacing?: LetterSpacing
}

/** Finds a style reproducing the full text look — on font+size alone, applying the style would
 * visibly reflow the text. Design-system styles (remote, already used on this page) beat local
 * ones; when nothing matches, a local `auto/…` style is created. */
async function findOrCreateTextStyle(look: TextLook, ctx: FixContext): Promise<{ style: TextStyle; fromLibrary: boolean }> {
  const matches = (candidate: TextStyle) =>
    candidate.fontName?.family === look.fontName.family &&
    candidate.fontName?.style === look.fontName.style &&
    candidate.fontSize === look.fontSize &&
    (look.lineHeight === undefined || metricEquals(candidate.lineHeight, look.lineHeight)) &&
    (look.letterSpacing === undefined || metricEquals(candidate.letterSpacing, look.letterSpacing))

  const remote = (await loadRemoteTextStyles(ctx)).find(matches)
  if (remote) return { style: remote, fromLibrary: true }
  const local = ctx.textStyles.find(matches)
  if (local) return { style: local, fromLibrary: false }

  await figma.loadFontAsync(look.fontName)
  const style = figma.createTextStyle()
  style.fontName = look.fontName
  style.fontSize = look.fontSize
  if (look.lineHeight !== undefined) style.lineHeight = look.lineHeight
  if (look.letterSpacing !== undefined) style.letterSpacing = look.letterSpacing
  style.name = `auto/${look.fontName.family} ${look.fontName.style} ${look.fontSize}`
  ctx.textStyles.push(style)
  return { style, fromLibrary: false }
}

type MixedSegment = Pick<
  StyledTextSegment,
  'start' | 'end' | 'fontName' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'textStyleId'
>

/** Mixed fonts/sizes can't take one style, but each uniformly-styled run can take its own —
 * per-segment styles keep the render identical and satisfy the linter on re-scan. */
async function fixMixedTextSegments(node: TextNode, ctx: FixContext): Promise<{ status: LintFixStatus; detail: string }> {
  let segments: MixedSegment[]
  try {
    segments = node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textStyleId'])
  } catch (error) {
    return {
      status: 'failed',
      detail: `mixed fonts and unreadable segments — apply styles manually (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const applied = new Set<string>()
  for (const segment of segments) {
    if (segment.textStyleId) continue
    const { style, fromLibrary } = await findOrCreateTextStyle(segment, ctx)
    await node.setRangeTextStyleIdAsync(segment.start, segment.end, style.id)
    applied.add(fromLibrary ? `${style.name} (library)` : style.name)
  }
  if (applied.size === 0) {
    return { status: 'skipped', detail: 'every text segment already carries a style — re-scan the scope' }
  }
  return { status: 'fixed', detail: `applied per-segment styles: ${[...applied].join(', ')}` }
}

async function fixTextWithoutStyle(node: TextNode, ctx: FixContext): Promise<{ status: LintFixStatus; detail: string }> {
  const fontName = node.fontName
  const fontSize = node.fontSize
  if (fontName === figma.mixed || fontSize === figma.mixed) {
    return fixMixedTextSegments(node, ctx)
  }
  const lineHeight = node.lineHeight === figma.mixed ? undefined : node.lineHeight
  const letterSpacing = node.letterSpacing === figma.mixed ? undefined : node.letterSpacing
  const { style, fromLibrary } = await findOrCreateTextStyle({ fontName, fontSize, lineHeight, letterSpacing }, ctx)
  await node.setTextStyleIdAsync(style.id)
  return { status: 'fixed', detail: `applied text style "${style.name}"${fromLibrary ? ' (library)' : ''}` }
}

async function fixMissingAutoLayout(node: FrameNode): Promise<{ status: LintFixStatus; detail: string }> {
  if (node.layoutMode !== 'NONE') {
    return { status: 'skipped', detail: 'frame already has Auto Layout — re-scan the scope' }
  }
  const rects: ChildRect[] = node.children.map((child) => ({
    x: child.x,
    y: child.y,
    width: child.width,
    height: child.height,
  }))
  const inferred = inferAutoLayout(rects, node.width, node.height)
  if (!inferred) {
    return { status: 'failed', detail: 'children overlap on both axes — apply Auto Layout manually' }
  }
  // Pre-flight: reject the fix when the inferred layout wouldn't reproduce the current geometry
  // (irregular gaps, mixed alignment) — a "fix" that visibly rearranges the design is a bug.
  const drift = autoLayoutDrift(rects, node.width, node.height, inferred)
  if (drift > AUTO_LAYOUT_DRIFT_TOLERANCE) {
    return {
      status: 'skipped',
      detail: `children would shift up to ${Math.round(drift)}px (uneven gaps or alignment) — apply Auto Layout manually`,
    }
  }

  const { width, height } = node
  // Auto Layout lays children out in child-list order; re-append in visual order first.
  // (This also normalizes z-order to the visual order — acceptable for a best-effort fix.)
  const ordered = inferred.order.map((index) => node.children[index])
  for (const child of ordered) node.appendChild(child)

  node.layoutMode = inferred.layoutMode
  node.primaryAxisSizingMode = 'FIXED'
  node.counterAxisSizingMode = 'FIXED'
  node.counterAxisAlignItems = inferred.counterAlign
  node.itemSpacing = inferred.itemSpacing
  node.paddingLeft = inferred.paddingLeft
  node.paddingRight = inferred.paddingRight
  node.paddingTop = inferred.paddingTop
  node.paddingBottom = inferred.paddingBottom
  node.resize(width, height)
  return {
    status: 'fixed',
    detail: `${inferred.layoutMode.toLowerCase()} Auto Layout, spacing ${inferred.itemSpacing}px`,
  }
}

// --- excessive-nesting: unwrap redundant single-child wrapper frames/groups ---

function anyVisible(paints: unknown): boolean {
  return Array.isArray(paints) && paints.some((p) => (p as { visible?: boolean }).visible !== false)
}

/** `clipsContent` only *does* something when a child actually overflows the frame — Figma turns
 * it on by default, so treating it as a hard visual role would disqualify nearly every frame.
 * A frame that clips nothing renders identically without it. Unknown bounds (rotation, missing
 * absolute boxes — e.g. detached test mocks) stay conservative: clipping counts as a role. */
function clippingHasEffect(node: FrameNode): boolean {
  if (!node.clipsContent) return false
  if (node.rotation) return true
  const frame = node.absoluteBoundingBox
  if (!frame) return true
  for (const child of node.children) {
    if (child.visible === false) continue
    const bounds =
      ('absoluteRenderBounds' in child ? (child as SceneNode & { absoluteRenderBounds: Rect | null }).absoluteRenderBounds : null) ??
      child.absoluteBoundingBox
    if (!bounds) return true
    if (
      bounds.x < frame.x - 0.5 ||
      bounds.y < frame.y - 0.5 ||
      bounds.x + bounds.width > frame.x + frame.width + 0.5 ||
      bounds.y + bounds.height > frame.y + frame.height + 0.5
    ) {
      return true
    }
  }
  return false
}

/** True when a FRAME paints something of its own — a fill/stroke/effect, a corner radius,
 * effective clipping, reduced opacity, rotation, a non-normal blend, or a mask. Such a frame
 * can't be deleted without changing pixels no matter where its children go. Missing props (bare
 * test mocks / defaults) read as "no role". */
function frameHasPaintRole(node: FrameNode): boolean {
  if (anyVisible(node.fills) || anyVisible(node.strokes) || anyVisible(node.effects)) return true
  if (clippingHasEffect(node)) return true
  const radius = node.cornerRadius
  if (radius === figma.mixed || (typeof radius === 'number' && radius > 0)) return true
  if (typeof node.opacity === 'number' && node.opacity < 1) return true
  if (node.rotation) return true
  const blend = node.blendMode
  if (blend && blend !== 'PASS_THROUGH' && blend !== 'NORMAL') return true
  if (node.isMask) return true
  return false
}

/** Paint role plus a *layout* role (padding). Padding only matters when the wrapper's slot is
 * governed by an Auto Layout parent — in an absolute parent the unwrap snapshots the child's
 * rendered position, so padding is already baked in. */
function frameHasVisualRole(node: FrameNode): boolean {
  if (frameHasPaintRole(node)) return true
  if (node.paddingLeft || node.paddingRight || node.paddingTop || node.paddingBottom) return true
  return false
}

function parentIsAutoLayout(node: SceneNode): boolean {
  const parent = node.parent
  return (
    !!parent &&
    (parent.type === 'FRAME' || parent.type === 'COMPONENT' || parent.type === 'INSTANCE') &&
    (parent as FrameNode).layoutMode !== 'NONE'
  )
}

/** A frame/group that wraps exactly one child and adds nothing the unwrap can't reproduce —
 * lifting the child out and deleting it removes a nesting level without changing the render.
 * In an absolute parent only painted contributions block (padding / the wrapper's own Auto
 * Layout are baked into the position snapshot); in an Auto Layout parent the child takes over
 * the wrapper's slot, so padding must be empty too. */
export function isRedundantWrapper(node: SceneNode): boolean {
  if (!('children' in node) || node.children.length !== 1) return false
  if (node.type === 'GROUP') return true
  if (node.type !== 'FRAME') return false
  return parentIsAutoLayout(node) ? !frameHasVisualRole(node) : !frameHasPaintRole(node)
}

/** A wrapper the nesting fix may flatten: not the template root itself (a top-level frame must
 * never melt into the page), and either a single-child redundant wrapper, a dissolvable
 * multi-child one, or an Auto Layout wrapper its parent can absorb. */
export function isFlattenableWrapper(node: SceneNode): boolean {
  const parent = node.parent
  if (!parent || parent.type === 'PAGE' || parent.type === 'DOCUMENT') return false
  return isRedundantWrapper(node) || isDissolvableWrapper(node) || canMergeAutoLayoutWrapper(node)
}

/** The "padded container" case Auto Layout designs are full of: `node` is its Auto Layout
 * parent's ONLY child, is itself Auto Layout in the SAME direction, paints nothing, and exactly
 * spans the parent's content box. Then the parent can absorb the wrapper wholesale — spacing,
 * alignment, and padding (summed) — and adopt its children. Render-identical: since the wrapper
 * fills the content box, the parent's alignment had no freedom to place it anywhere else, and
 * the merged padding reproduces every child offset. */
export function canMergeAutoLayoutWrapper(node: SceneNode): boolean {
  if (node.type !== 'FRAME' || node.layoutMode === 'NONE') return false
  if (node.children.length === 0) return false
  if (frameHasPaintRole(node)) return false
  if (node.layoutPositioning === 'ABSOLUTE') return false
  const parent = node.parent
  if (!parent || (parent.type !== 'FRAME' && parent.type !== 'COMPONENT')) return false
  if (parent.layoutMode !== node.layoutMode) return false
  if (parent.children.length !== 1) return false
  const contentWidth = parent.width - parent.paddingLeft - parent.paddingRight
  const contentHeight = parent.height - parent.paddingTop - parent.paddingBottom
  return Math.abs(node.width - contentWidth) <= 1 && Math.abs(node.height - contentHeight) <= 1
}

/** Applies `canMergeAutoLayoutWrapper`: the parent takes over the wrapper's layout knobs, sums
 * the paddings, adopts the children, and the wrapper goes away. Sizing modes are untouched — the
 * direction is the same and the content box is unchanged, so hug/fixed both keep their size. */
function mergeAutoLayoutWrapper(wrapper: FrameNode): void {
  const parent = wrapper.parent as FrameNode
  const children = [...wrapper.children]
  parent.itemSpacing = wrapper.itemSpacing
  try {
    parent.layoutWrap = wrapper.layoutWrap
    if (wrapper.layoutWrap === 'WRAP') parent.counterAxisSpacing = wrapper.counterAxisSpacing
  } catch {
    /* wrap not supported here — spacing already covers the packed case */
  }
  parent.primaryAxisAlignItems = wrapper.primaryAxisAlignItems
  parent.counterAxisAlignItems = wrapper.counterAxisAlignItems
  parent.paddingLeft += wrapper.paddingLeft
  parent.paddingRight += wrapper.paddingRight
  parent.paddingTop += wrapper.paddingTop
  parent.paddingBottom += wrapper.paddingBottom
  for (const child of children) parent.appendChild(child)
  removeWrapperIfAlive(wrapper)
}

/** A *multi-child* wrapper whose children can all be hoisted into its slot without changing the
 * render: any GROUP, or a FRAME that paints nothing (its Auto Layout / padding, if any, is baked
 * into the children's positions — hoisting freezes them exactly where they render, same as
 * Figma's own ungroup). Only valid when the wrapper's own parent is NOT Auto Layout — there the
 * wrapper occupies one layout slot and hoisting N children would re-flow the whole container. */
export function isDissolvableWrapper(node: SceneNode): boolean {
  if (!('children' in node) || node.children.length < 2) return false
  const parent = node.parent
  if (!parent || !('children' in parent)) return false
  if (parentIsAutoLayout(node)) return false
  if (node.type === 'GROUP') return true
  if (node.type !== 'FRAME') return false
  return !frameHasPaintRole(node)
}

/** Reparents a redundant wrapper's single child into the wrapper's slot, then deletes the wrapper.
 * Absolute/group parents keep the child's exact rendered position (snapshotted from its current
 * x/y); Auto Layout parents get the wrapper's layout-participation props copied onto the child so
 * it occupies the same slot. Best-effort: every live write is guarded. */
function unwrapWrapper(wrapper: FrameNode | GroupNode): void {
  const parent = wrapper.parent
  if (!parent || !('children' in parent)) throw new Error('wrapper has no container parent')
  const child = wrapper.children[0] as SceneNode & LayoutMixin
  const index = parent.children.indexOf(wrapper)

  const parentAutoLayout =
    (parent.type === 'FRAME' || parent.type === 'COMPONENT' || parent.type === 'INSTANCE') &&
    (parent as FrameNode).layoutMode !== 'NONE'

  if (parentAutoLayout) {
    parent.insertChild(index, child)
    const w = wrapper as FrameNode
    for (const copy of [
      () => (child.layoutPositioning = w.layoutPositioning),
      () => (child.layoutGrow = w.layoutGrow),
      () => (child.layoutAlign = w.layoutAlign),
      () => (child.layoutSizingHorizontal = w.layoutSizingHorizontal),
      () => (child.layoutSizingVertical = w.layoutSizingVertical),
    ]) {
      try {
        copy()
      } catch {
        /* child type can't take this layout prop — leave its own value */
      }
    }
  } else {
    // Absolute/group parent: the child's position in the grandparent is wrapper + child — except
    // for GROUP wrappers, whose children are already in the container's space (the API quirk:
    // relativeTransform ignores group parents), so no offset applies.
    const x = wrapper.type === 'GROUP' ? child.x : wrapper.x + child.x
    const y = wrapper.type === 'GROUP' ? child.y : wrapper.y + child.y
    parent.insertChild(index, child)
    try {
      child.x = x
      child.y = y
    } catch {
      /* non-positionable child — leave as inserted */
    }
  }
  removeWrapperIfAlive(wrapper)
}

/** Removing the last child auto-deletes a GROUP in Figma — the explicit remove is best-effort. */
function removeWrapperIfAlive(wrapper: SceneNode): void {
  try {
    if (!wrapper.removed) wrapper.remove()
  } catch {
    /* already auto-removed */
  }
}

/** Hoists every child of a dissolvable multi-child wrapper into the wrapper's slot — z-order and
 * rendered positions preserved — then removes the wrapper. GROUP children are already in the
 * container's coordinate space; FRAME children shift by the frame's offset. */
function dissolveWrapper(wrapper: FrameNode | GroupNode): void {
  const parent = wrapper.parent
  if (!parent || !('children' in parent)) throw new Error('wrapper has no container parent')
  const index = parent.children.indexOf(wrapper)
  const isGroup = wrapper.type === 'GROUP'
  const offsetX = isGroup ? 0 : wrapper.x
  const offsetY = isGroup ? 0 : wrapper.y
  const children = [...wrapper.children] as Array<SceneNode & LayoutMixin>
  children.forEach((child, i) => {
    const x = child.x + offsetX
    const y = child.y + offsetY
    parent.insertChild(index + i, child)
    try {
      child.x = x
      child.y = y
    } catch {
      /* non-positionable child — leave as inserted */
    }
  })
  removeWrapperIfAlive(wrapper)
}

/** Child-index path from `ancestor` down to `descendant`, so a node can be re-found after a detach
 * (which mints new ids but preserves child order/structure). */
function indexPath(ancestor: BaseNode, descendant: SceneNode): number[] {
  const path: number[] = []
  let current: BaseNode | null = descendant
  while (current && current !== ancestor) {
    const parent: BaseNode | null = current.parent
    if (!parent || !('children' in parent)) break
    path.push((parent as ChildrenMixin).children.indexOf(current as SceneNode))
    current = parent
  }
  return path.reverse()
}

function nodeAtPath(root: SceneNode, path: readonly number[]): SceneNode | null {
  let current: SceneNode = root
  for (const index of path) {
    if (!('children' in current)) return null
    const next = (current as ChildrenMixin).children[index]
    if (!next) return null
    current = next as SceneNode
  }
  return current
}

/** Flattens every removable wrapper between `node` and its template-file boundary (an instance,
 * component, or the page — each of those renders as its own file): single-child redundant
 * wrappers are unwrapped, neutral multi-child groups/frames are dissolved. Returns how many
 * levels were removed. */
function unwrapRedundantAncestors(node: SceneNode): number {
  let removed = 0
  let current: BaseNode | null = node.parent
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (current.type === 'INSTANCE' || current.type === 'COMPONENT' || current.type === 'COMPONENT_SET') break
    const parent: BaseNode | null = current.parent
    try {
      if (isFlattenableWrapper(current as SceneNode)) {
        if (isRedundantWrapper(current as SceneNode)) unwrapWrapper(current as FrameNode | GroupNode)
        else if (isDissolvableWrapper(current as SceneNode)) dissolveWrapper(current as FrameNode | GroupNode)
        else mergeAutoLayoutWrapper(current as FrameNode)
        removed++
      }
    } catch {
      /* skip this wrapper, keep flattening higher ones */
    }
    current = parent
  }
  return removed
}

/** Read-only preview of fixExcessiveNesting: true when unwrapping would actually remove at
 * least one wrapper (directly, or after detaching the enclosing instance). Lets the scan mark
 * hopeless findings before offering a Fix that would just skip. */
export function canUnwrapNesting(node: SceneNode): boolean {
  const instance = enclosingInstance(node)
  if (instance) return countRedundantAncestorsWithin(node, instance) > 0
  let current: BaseNode | null = node.parent
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (current.type === 'INSTANCE' || current.type === 'COMPONENT' || current.type === 'COMPONENT_SET') break
    if (isFlattenableWrapper(current as SceneNode)) return true
    current = current.parent
  }
  return false
}

/** Scan post-pass: marks findings whose Fix is guaranteed to skip (`fixable: false`) so the UI
 * neither offers nor counts them in "Fix all". Every check is a read-only preview of the
 * corresponding fixer's own guard — keep them in sync. */
export async function annotateUnfixableFindings(
  findings: LintFinding[],
  nodeById: Map<string, SceneNode>
): Promise<void> {
  const remoteInstanceCache = new Map<string, boolean>()
  for (const finding of findings) {
    const node = nodeById.get(finding.nodeId)
    if (!node) continue

    if (finding.rule === 'excessive-nesting') {
      if (!canUnwrapNesting(node)) {
        finding.fixable = false
        finding.message += ' (no safely removable wrappers — every level adds visuals or layout; needs manual flattening)'
      }
      continue
    }

    if (finding.rule !== 'missing-auto-layout' || node.type !== 'FRAME') continue
    const instance = enclosingInstance(node)
    if (instance) {
      let remote = remoteInstanceCache.get(instance.id)
      if (remote === undefined) {
        const main = await instance.getMainComponentAsync().catch(() => null)
        remote = !main || main.remote
        remoteInstanceCache.set(instance.id, remote)
      }
      if (remote) {
        finding.fixable = false
        finding.message += ' (inside a library component — fix it in the source library)'
        continue
      }
    }
    const rects: ChildRect[] = node.children.map((child) => ({
      x: child.x,
      y: child.y,
      width: child.width,
      height: child.height,
    }))
    const inferred = inferAutoLayout(rects, node.width, node.height)
    if (!inferred) {
      finding.fixable = false
      finding.message += ' (children overlap on both axes — needs manual layout)'
      continue
    }
    const drift = autoLayoutDrift(rects, node.width, node.height, inferred)
    if (drift > AUTO_LAYOUT_DRIFT_TOLERANCE) {
      finding.fixable = false
      finding.message += ` (uneven gaps — auto-fix would shift children ~${Math.round(drift)}px)`
    }
  }
}

/** Read-only count of redundant wrappers between `node` and `boundary` — used to decide whether
 * detaching a component is worth it before actually doing it. */
function countRedundantAncestorsWithin(node: SceneNode, boundary: SceneNode): number {
  let count = 0
  let current: BaseNode | null = node.parent
  while (current && current !== boundary && 'children' in current) {
    if (isFlattenableWrapper(current as SceneNode)) count++
    current = current.parent
  }
  return count
}

/**
 * Fixes `excessive-nesting` by removing redundant single-child wrapper layers above the flagged
 * node. When the node lives inside a component instance (whose internals can't be restructured in
 * place), and there is something to gain, the instance is DETACHED first — the user opted into
 * "break the component if it blocks unwrapping" — then the node is re-found and flattened.
 */
async function fixExcessiveNesting(node: SceneNode): Promise<{ status: LintFixStatus; detail: string }> {
  const instance = enclosingInstance(node)
  if (!instance) {
    const removed = unwrapRedundantAncestors(node)
    return removed > 0
      ? { status: 'fixed', detail: `removed ${removed} redundant wrapper level(s)` }
      : { status: 'skipped', detail: 'no redundant wrapper layers to remove — flatten manually' }
  }

  // Don't detach a component unless flattening will actually help.
  if (countRedundantAncestorsWithin(node, instance) === 0) {
    return { status: 'skipped', detail: 'nesting is intrinsic to a component — flatten it in the main component' }
  }
  const path = indexPath(instance, node)
  let detached: FrameNode
  try {
    detached = instance.detachInstance()
  } catch (error) {
    return { status: 'failed', detail: `couldn't detach the blocking component: ${error instanceof Error ? error.message : String(error)}` }
  }
  const relocated = nodeAtPath(detached, path)
  if (!relocated) return { status: 'failed', detail: 'lost the node after detaching its component' }
  const removed = unwrapRedundantAncestors(relocated)
  return removed > 0
    ? { status: 'fixed', detail: `detached the blocking component and removed ${removed} redundant wrapper level(s)` }
    : { status: 'skipped', detail: 'detached the component but found no removable wrappers' }
}

/** Tags a fixed detail line so the user can see where the change actually landed: on the shared
 * main component (affects every instance) or as an override on this one library instance. */
function withTarget(
  result: { status: LintFixStatus; detail: string },
  onMainComponent: boolean,
  asOverride = false
): { status: LintFixStatus; detail: string } {
  if (result.status !== 'fixed') return result
  if (onMainComponent) return { status: 'fixed', detail: `${result.detail} (on main component)` }
  if (asOverride) return { status: 'fixed', detail: `${result.detail} (override on this instance)` }
  return result
}

/** Applies the auto-fix for one finding. Never throws — failures come back as `status: 'failed'`.
 * Even `node.id`/`node.name` are guarded: an earlier fix in the batch may have removed this node
 * (detachInstance / unwrap), and removed nodes throw on every property access. */
export async function applyLintFix(node: SceneNode, rule: LintRule, ctx: FixContext): Promise<LintFixResult> {
  let base: { nodeId: string; nodeName: string; rule: LintRule }
  try {
    base = { nodeId: node.id, nodeName: node.name, rule }
  } catch {
    return {
      nodeId: 'removed',
      nodeName: '(removed node)',
      rule,
      status: 'failed',
      detail: 'node was removed by an earlier fix in this batch — re-scan the scope',
    }
  }
  try {
    if (rule === 'excessive-nesting') {
      // Its own fixer handles instance detaching, so it runs before resolveEditableTarget.
      return { ...base, ...(await fixExcessiveNesting(node)) }
    }

    // Redirect fixes on local-instance sublayers to the main component. Sublayers of *library*
    // instances can't be fixed at the source from this file, but paints/text styles are legal
    // per-instance overrides — apply the fix right on the sublayer instead of skipping.
    const resolved = await resolveEditableTarget(node)
    let target: SceneNode = node
    let onMainComponent = false
    let asOverride = false
    if (resolved.kind === 'node') {
      target = resolved.node
      onMainComponent = resolved.onMainComponent
    } else if (rule === 'missing-auto-layout') {
      // Layout of instance sublayers is structural — not overridable, period.
      return { ...base, status: 'skipped', detail: 'layout inside a library component — fix it in the source library' }
    } else {
      asOverride = true
    }

    switch (rule) {
      case 'unbound-fill':
      case 'unbound-stroke': {
        const usage: PaintUsage = rule === 'unbound-fill' ? 'fill' : 'stroke'
        let result = withTarget(await fixUnboundPaints(target, usage, ctx), onMainComponent, asOverride)
        // A sublayer whose paint is overridden on THIS instance doesn't inherit the
        // main-component fix — bind the override too, or the finding comes back on re-scan.
        // Runs regardless of the main result: when the main component is ALREADY bound (fixed
        // in an earlier batch), the main fix reports "nothing to bind" but the flagged
        // override still needs its own binding.
        if (onMainComponent) {
          const echo = await fixUnboundPaints(node, usage, ctx)
          if (echo.status === 'fixed') {
            result =
              result.status === 'fixed'
                ? { status: 'fixed', detail: `${result.detail}; overridden ${PAINT_PROP[usage]} on this instance re-bound` }
                : { status: 'fixed', detail: `${echo.detail} (override on this instance; main component already bound)` }
          }
        }
        return { ...base, ...result }
      }
      case 'text-without-style': {
        if (target.type !== 'TEXT') return { ...base, status: 'failed', detail: 'not a text node' }
        let result = withTarget(await fixTextWithoutStyle(target, ctx), onMainComponent, asOverride)
        // Same as paints: text overridden on this instance keeps textStyleId '' after the main
        // component is styled — restyle the override with its own look.
        if (onMainComponent && node.type === 'TEXT' && node.textStyleId === '') {
          const echo = await fixTextWithoutStyle(node, ctx)
          if (echo.status === 'fixed') {
            result =
              result.status === 'fixed'
                ? { status: 'fixed', detail: `${result.detail}; overridden text on this instance restyled` }
                : { status: 'fixed', detail: `${echo.detail} (override on this instance; main component already styled)` }
          }
        }
        return { ...base, ...result }
      }
      case 'missing-auto-layout':
        if (target.type !== 'FRAME') return { ...base, status: 'failed', detail: 'not a frame' }
        return { ...base, ...withTarget(await fixMissingAutoLayout(target), onMainComponent) }
      case 'bootstrap-component-mismatch':
        // Renaming a variant prop is a design decision (docs/DESIGN-CONVENTIONS.md §6) — the UI
        // hides Fix for this rule (not in FIXABLE_RULES); this arm is a type-exhaustiveness guard.
        return { ...base, status: 'skipped', detail: 'rename the variant prop in Figma — not auto-fixable' }
    }
  } catch (error) {
    return { ...base, status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
