/**
 * Breakpoint frames → media queries (M4b, docs/1TO1-FIDELITY.md §M4b): several top-level frames
 * named for the same page at different widths (`Home/desktop` + `Home/mobile`, or width-suffixed
 * `Home/1920` + `Home/375`) collapse into ONE Django template whose CSS carries `@media
 * (max-width: …)` blocks. The widest frame is the base (unconditional) layout and provides the
 * rendered DOM; each narrower frame becomes a media block that overrides its matched nodes.
 *
 * Cross-frame node identity reuses the Smart-Animate layer matcher (`matchLayers`, by name +
 * nesting path): a node matched between the widest frame and a narrower one shares the widest
 * node's CSS class, so the narrower frame's rule overrides the base rule of the same DOM element.
 * A node present in the widest frame but absent from a narrower one is hidden (`display: none`)
 * inside that frame's media block; a node that exists only in a narrower frame has no element in
 * the rendered DOM and is dropped.
 */

import type { IrContainerNode, IrNode } from './ir.ts'
import { matchLayers, type DiffableNode } from './smart-animate/index.ts'
import { emitCss, toClassName, type DjangoNodeSource } from './css-emitter.ts'
import type { VariableSnapshot } from '../../variables.ts'

/** Canonical widths for the named-breakpoint convention (`<slug>/desktop|tablet|mobile`).
 * Used as the fallback when no "Breakpoints" variable collection exists in the Figma file. */
const NAMED_WIDTHS: Record<string, number> = { desktop: 1280, tablet: 768, mobile: 375 }

/** Token-driven breakpoint widths extracted from a Figma "Breakpoints" variable collection.
 * Keyed by the last segment of each variable name (lowercased) → px width. */
export type BreakpointTokenMap = ReadonlyMap<string, number>

/**
 * Extracts breakpoint widths from a Figma "Breakpoints" variable collection (if present).
 *
 * Supports two authoring conventions (the forum-recommended mode-based form takes priority):
 *
 * 1. Mode-based (recommended): the collection has one mode per breakpoint — e.g. modes
 *    "Desktop", "Tablet", "Mobile" — and a single FLOAT variable (e.g. "Width" or
 *    "breakpoint/width") whose value differs per mode. Each mode's value becomes the
 *    breakpoint width for that mode name (lowercased). This is the pattern the forum
 *    thread and Figma docs recommend for responsive breakpoints-as-modes, because the
 *    designer switches the collection's mode to preview each viewport, and the single
 *    variable drives the width.
 *
 * 2. Variable-based (legacy/fallback): the collection contains several FLOAT variables
 *    whose names' last path segment is the breakpoint key — e.g. variable
 *    "breakpoint/desktop" → key "desktop" → width 1280. Values are read from the
 *    collection's default mode. This is the original M4b convention and stays supported
 *    for files already authored this way.
 *
 * Returns a Map keyed by the breakpoint name (lowercased mode or variable segment) → px width.
 * Returns an empty Map when no matching collection exists (caller falls back to NAMED_WIDTHS).
 */
export function extractBreakpointTokens(snapshot: VariableSnapshot | undefined): Map<string, number> {
  if (!snapshot) return new Map()
  const collection = snapshot.collections.find(
    (c) => c.name.trim().toLowerCase() === 'breakpoints'
  )
  if (!collection) return new Map()

  // 1. Mode-based: one FLOAT variable with a value per mode → mode name is the breakpoint key.
  //    Only applies when the collection has ≥2 modes whose names look like breakpoints
  //    (desktop/tablet/mobile or numeric), so a collection that just happens to have a
  //    couple of theme modes doesn't accidentally get interpreted as breakpoints.
  const breakpointModeNames = new Set(['desktop', 'tablet', 'mobile', 'xl', 'lg', 'md', 'sm', 'xs'])
  const modeKeys = collection.modes.map((m) => m.name.trim().toLowerCase())
  const looksModeBased =
    collection.modes.length >= 2 &&
    modeKeys.every((k) => breakpointModeNames.has(k) || /^\d{3,5}$/.test(k))

  if (looksModeBased) {
    const tokens = new Map<string, number>()
    for (const v of snapshot.variables) {
      if (v.collectionId !== collection.id) continue
      if (v.resolvedType !== 'FLOAT') continue
      // Read the value for each mode — mode name → breakpoint key.
      for (const mode of collection.modes) {
        const value = v.valuesByMode[mode.modeId]
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
        const key = mode.name.trim().toLowerCase()
        if (key) {
          // Keep the first (widest) value per key — a single variable is expected, but if
          // several FLOAT variables exist, the one with the largest value wins per key
          // so the designer's "Width" variable isn't silently overridden by a stray token.
          const existing = tokens.get(key)
          if (existing === undefined || value > existing) tokens.set(key, Math.round(value))
        }
      }
    }
    if (tokens.size > 0) return tokens
    // Fall through to the variable-based convention if no mode had a valid value.
  }

  // 2. Variable-based: each FLOAT variable's last path segment is the breakpoint key.
  const tokens = new Map<string, number>()
  for (const v of snapshot.variables) {
    if (v.collectionId !== collection.id) continue
    if (v.resolvedType !== 'FLOAT') continue
    const value = v.valuesByMode[collection.defaultModeId]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    const key = v.name.split('/').pop()!.trim().toLowerCase()
    if (key) tokens.set(key, Math.round(value))
  }
  return tokens
}

export interface BreakpointFrame {
  /** The frame's design width — its `@media` threshold input (widest is the base layout). */
  readonly width: number
  readonly node: IrContainerNode
}

export interface BreakpointGroup {
  /** The shared page name (the part before the `/breakpoint` suffix). */
  readonly slug: string
  /** The group's frames, widest first. */
  readonly frames: readonly BreakpointFrame[]
}

/** Merges Figma "Breakpoints" token overrides onto the hardcoded NAMED_WIDTHS fallback. */
function resolveNamedWidths(overrides: ReadonlyMap<string, number> | undefined): Record<string, number> {
  if (!overrides || overrides.size === 0) return NAMED_WIDTHS
  return { ...NAMED_WIDTHS, ...Object.fromEntries(overrides) }
}

/**
 * Parses a top-level frame name against the two breakpoint conventions:
 *   - `<slug>/(desktop|tablet|mobile)` → the canonical width for that keyword;
 *   - `<slug>/<number>` with an optional `px` unit (`Home/1920`, `One Main / 1920px`) → the
 *     number parsed as a px width.
 * Returns `null` for any other name (the frame is a standalone page, not a breakpoint).
 *
 * `namedWidths` overrides the canonical widths for keyword suffixes, sourced from the
 * Figma "Breakpoints" variable collection when present. Falls back to NAMED_WIDTHS.
 */
export function parseBreakpointName(
  name: string,
  namedWidths: Record<string, number> = NAMED_WIDTHS
): { slug: string; width: number } | null {
  const match = /^(.*)\/([^/]+)$/.exec(name.trim())
  if (!match) return null
  const slug = match[1].trim()
  if (!slug) return null
  const suffix = match[2].trim().toLowerCase()
  if (suffix in namedWidths) return { slug, width: namedWidths[suffix] }
  const width = /^(\d+)\s*(?:px)?$/.exec(suffix)
  if (width) return { slug, width: Number(width[1]) }
  return null
}

/**
 * Partitions top-level page roots into breakpoint groups (≥2 frames sharing a slug via the
 * naming convention) and the roots that render unchanged. `rendered` keeps the original root
 * order, substituting each group with only its widest frame — the single page/DOM the group
 * collapses into. A lone breakpoint-named frame (slug with one frame) is left standalone, so
 * single-frame exports are unaffected.
 *
 * `namedWidthsOverrides` lets the caller supply token-driven widths (from the Figma "Breakpoints"
 * collection); falls back to the hardcoded NAMED_WIDTHS when absent/empty.
 */
export function detectBreakpointGroups(
  roots: readonly IrContainerNode[],
  namedWidthsOverrides?: ReadonlyMap<string, number>
): {
  rendered: IrContainerNode[]
  groups: BreakpointGroup[]
} {
  const namedWidths = resolveNamedWidths(namedWidthsOverrides)
  // Group by a whitespace/case-normalized key so "One Main / 375px" still joins
  // "One main / 1920px"; the first-seen spelling stays the group's display slug.
  const bySlug = new Map<string, { slug: string; frames: BreakpointFrame[] }>()
  const keyOrder: string[] = []
  for (const root of roots) {
    const parsed = parseBreakpointName(root.name, namedWidths)
    if (!parsed) continue
    const key = parsed.slug.replace(/\s+/g, ' ').toLowerCase()
    if (!bySlug.has(key)) {
      bySlug.set(key, { slug: parsed.slug, frames: [] })
      keyOrder.push(key)
    }
    bySlug.get(key)!.frames.push({ width: parsed.width, node: root })
  }

  const groups: BreakpointGroup[] = []
  const groupedIds = new Set<string>()
  const widestIds = new Set<string>()
  for (const key of keyOrder) {
    const { slug, frames } = bySlug.get(key)!
    if (frames.length < 2) continue
    const sorted = [...frames].sort((a, b) => b.width - a.width)
    groups.push({ slug, frames: sorted })
    for (const frame of sorted) groupedIds.add(frame.node.id)
    widestIds.add(sorted[0].node.id)
  }

  const rendered = roots.filter((root) => !groupedIds.has(root.id) || widestIds.has(root.id))
  return { rendered, groups }
}

/** Adapts an IR node to the `DiffableNode` shape `matchLayers` reads (name + nesting path + type),
 * carrying the node `id` so a matched pair can be traced back to the class it should share. */
function toDiffable(node: IrNode): DiffableNode {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    x: node.position.x,
    y: node.position.y,
    width: node.sizing.width.mode === 'fixed' ? node.sizing.width.value : 0,
    height: node.sizing.height.mode === 'fixed' ? node.sizing.height.value : 0,
    children: 'children' in node ? node.children.map(toDiffable) : undefined,
  }
}

/** Indents every line of `block` by two spaces so nested `@media` bodies stay readable. */
function indent(block: string): string {
  return block.replace(/^/gm, '  ')
}

/**
 * Emits the `@media (max-width: …)` blocks for one breakpoint group's narrower frames — the
 * widest frame is the base layout and is emitted by the caller's ordinary `emitCss` pass over
 * the rendered roots. Blocks come out widest-first (descending threshold) so the narrowest
 * frame's rules win the cascade where two thresholds overlap.
 *
 * A frame's design applies from ITS OWN width up to just below the NEXT WIDER frame's width —
 * so each block's threshold is `nextWiderWidth - 1`, not the frame's own width. (With own-width
 * thresholds, a 375px viewport would render the 768 design: the 375 block would only match
 * at ≤374px, one frame off across the whole cascade.)
 *
 * For each narrower frame: matched nodes (by name + nesting path against the widest frame)
 * re-key their CSS onto the widest node's class via `idAliases`, so the block overrides the
 * base rule of the same DOM element; the frame's own root aliases onto the widest root the
 * same way. Widest-frame nodes with no match in this frame get `display: none` inside the block.
 */
export async function emitBreakpointCss(
  group: BreakpointGroup,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string> = new Map()
): Promise<string> {
  const [widest, ...narrower] = group.frames
  const widestDiffable = toDiffable(widest.node)

  const blocks: string[] = []
  for (let index = 0; index < narrower.length; index++) {
    const frame = narrower[index]
    const nextWiderWidth = index === 0 ? widest.width : narrower[index - 1].width
    const result = matchLayers(widestDiffable, toDiffable(frame.node))

    // The frame's root maps onto the widest root (both are the single page container); matched
    // descendants map narrow-id → widest-id.
    const idAliases = new Map<string, string>([[frame.node.id, widest.node.id]])
    for (const pair of result.matched) {
      if (pair.a.id && pair.b.id) idAliases.set(pair.b.id, pair.a.id)
    }

    const overrides = await emitCss([frame.node], sceneNodesById, variableNamesById, {
      idAliases,
      preamble: false,
    })
    // `removed` = present in the widest frame, absent (or type-changed) in this one → hide it here.
    const hidden = result.removed
      .map((entry) => entry.node.id)
      .filter((id): id is string => Boolean(id))
      .map((id) => `.${toClassName(id)} {\n  display: none;\n}`)

    const body = [overrides, ...hidden].filter((part) => part.length > 0).join('\n\n')
    blocks.push(`@media (max-width: ${nextWiderWidth - 1}px) {\n${indent(body)}\n}`)
  }

  return blocks.join('\n\n')
}

// ── Breakpoint collection generator (forum-recommended modes-as-breakpoints pattern) ──────

/** Private pluginData key that marks a "Breakpoints" collection as generated by this plugin,
 * so re-generation can find and replace it cleanly (same pattern as the typography generator
 * in altery-figma-ds, which uses `TYPO_COLLECTION_PLUGIN_KEY`). The value stores the ISO
 * timestamp of the last regeneration for diagnostics. */
export const BREAKPOINT_COLLECTION_PLUGIN_KEY = 'alteryBreakpointsGenerated'

/** Default breakpoint steps used when the generator is invoked without explicit overrides.
 * Matches the forum/official-docs recommendation: Desktop → Tablet → Mobile as collection
 * modes, each holding a px width for a single "Width" FLOAT variable. */
export const DEFAULT_BREAKPOINTS: Record<string, number> = {
  Desktop: 1440,
  Tablet: 834,
  Mobile: 390,
}

/** A breakpoint step the generator creates: a mode name + the px width that the "Width"
 * variable takes in that mode. Capitalised mode names match Figma's convention. */
export interface BreakpointStep {
  mode: string
  width: number
}

/** The result of a generate/regenerate pass — surfaced to the UI as a report. */
export interface GenerateBreakpointResult {
  collectionName: string
  regenerated: boolean
  modes: string[]
  variableName: string
  widths: Record<string, number>
}

/** Normalises an arbitrary { mode → width } map into the ordered, validated list of steps
 * the generator creates. Invalid widths (non-finite, ≤0) are dropped; the canonical
 * Desktop/Tablet/Mobile order is preserved when the defaults are used. Pure — tested. */
export function planBreakpointSteps(
  breakpoints: Record<string, number> = DEFAULT_BREAKPOINTS,
): BreakpointStep[] {
  const entries = Object.entries(breakpoints)
  const steps: BreakpointStep[] = []
  for (const [mode, width] of entries) {
    const name = mode.trim()
    if (!name) continue
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) continue
    steps.push({ mode: name, width: Math.round(width) })
  }
  return steps
}

/**
 * Creates (or re-creates) a "Breakpoints" variable collection using the forum-recommended
 * modes-as-breakpoints pattern: one mode per breakpoint step (Desktop / Tablet / Mobile …)
 * and a single FLOAT variable "Width" whose value differs per mode. Designers switch the
 * collection's mode to preview each viewport; the plugin reads the per-mode values to drive
 * frame resizing and media-query thresholds.
 *
 * Re-generation: if a "Breakpoints" collection already exists AND is marked with this
 * plugin's `BREAKPOINT_COLLECTION_PLUGIN_KEY` pluginData, it is removed first and a fresh
 * collection is created — so a designer can tweak the step widths in the UI and regenerate
 * without leaving stale modes/variables behind. A pre-existing "Breakpoints" collection that
 * is NOT plugin-marked (i.e. hand-authored by the designer) is left untouched and a new
 * collection is NOT created; the generator reports `regenerated: false` and returns the
 * existing collection's mode/width snapshot so the UI can show the conflict.
 *
 * Runs in the Figma plugin sandbox — calls `figma.variables.*` directly. Not unit-tested;
 * the pure planning step (`planBreakpointSteps`) is.
 */
export async function generateBreakpointCollection(
  breakpoints: Record<string, number> = DEFAULT_BREAKPOINTS,
): Promise<GenerateBreakpointResult> {
  const steps = planBreakpointSteps(breakpoints)
  if (steps.length === 0) {
    throw new Error('No valid breakpoint steps — all widths were missing or non-positive.')
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const existing = collections.find((c) => c.name.trim().toLowerCase() === 'breakpoints')
  const isOurs =
    existing && existing.getPluginData(BREAKPOINT_COLLECTION_PLUGIN_KEY) !== ''

  if (existing && !isOurs) {
    // Hand-authored collection — don't clobber it. Report what's there so the UI can guide
    // the designer to edit it directly or rename it first.
    return snapshotExistingCollection(existing)
  }

  if (existing && isOurs) {
    existing.remove()
  }

  // Create the collection + one mode per breakpoint step.
  const collection = figma.variables.createVariableCollection('Breakpoints')
  // The freshly-created collection has one default mode ("Mode 1" / "Default"); rename it
  // to the first step, then add the rest. Keeping the default mode preserves the collection's
  // defaultModeId so existing mode-bindings don't dangle after a regenerate.
  const [first, ...rest] = steps
  collection.renameMode(collection.defaultModeId, first.mode)
  const modeIds: string[] = [collection.defaultModeId]
  for (const step of rest) {
    modeIds.push(collection.addMode(step.mode))
  }

  // FLOAT variable "Width" — the px viewport width per mode (the single source of truth the
  // designer edits; extractBreakpointTokens reads it back keyed by mode name).
  const widthVar = figma.variables.createVariable('Width', collection, 'FLOAT')
  widthVar.description = 'Breakpoint viewport width (px) per mode. Generated by Altery plugin.'
  widthVar.hiddenFromPublishing = false
  for (let i = 0; i < steps.length; i++) {
    widthVar.setValueForMode(modeIds[i], steps[i].width)
  }

  // STRING variable "Layout" — holds the mode name itself per mode (e.g. Desktop mode →
  // "Desktop", Mobile mode → "Mobile"). Case-sensitive. Useful for conditional logic in
  // prototypes / component variants that key off a string label rather than a px width.
  const layoutVar = figma.variables.createVariable('Layout', collection, 'STRING')
  layoutVar.description = 'Breakpoint layout label (mode name) per mode. Generated by Altery plugin.'
  layoutVar.hiddenFromPublishing = false
  for (let i = 0; i < steps.length; i++) {
    layoutVar.setValueForMode(modeIds[i], steps[i].mode)
  }

  collection.setPluginData(BREAKPOINT_COLLECTION_PLUGIN_KEY, new Date().toISOString())

  const widths: Record<string, number> = {}
  for (const step of steps) widths[step.mode] = step.width

  return {
    collectionName: collection.name,
    regenerated: Boolean(existing && isOurs),
    modes: steps.map((s) => s.mode),
    variableName: widthVar.name,
    widths,
  }
}

/** Reads a hand-authored (not plugin-marked) "Breakpoints" collection and returns its
 * mode → width snapshot, so the UI can show the designer what already exists instead of
 * silently overwriting it. Best-effort: widths come from the first FLOAT variable found. */
async function snapshotExistingCollection(
  collection: VariableCollection,
): Promise<GenerateBreakpointResult> {
  const modes = collection.modes.map((m) => m.name)
  const widths: Record<string, number> = {}
  // Find the first FLOAT variable in this collection to read per-mode widths.
  for (const varId of collection.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(varId)
    if (!v || v.resolvedType !== 'FLOAT') continue
    for (const mode of collection.modes) {
      const value = v.valuesByMode[mode.modeId]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        widths[mode.name] = Math.round(value)
      }
    }
    break
  }
  return {
    collectionName: collection.name,
    regenerated: false,
    modes,
    variableName: '',
    widths,
  }
}
