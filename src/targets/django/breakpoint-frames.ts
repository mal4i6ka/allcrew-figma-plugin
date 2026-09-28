/**
 * Breakpoint frames → media queries (M4b, docs/1TO1-FIDELITY.md §M4b): several top-level frames
 * named for the same page at different widths (`Home/desktop` + `Home/mobile`, or width-suffixed
 * `Home/1920` + `Home/375`) collapse into ONE Django template whose CSS carries `@media
 * (max-width: …)` blocks. The widest frame is the base (unconditional) layout; `mergeBreakpointVariants`
 * additionally splices every node that exists ONLY in a narrower frame (a mobile burger, a
 * stacked CTA) into its matched parent's position in that base tree, so it reaches the rendered
 * DOM instead of being dropped — hidden by default (`display: none`) and revealed inside the
 * `@media` block for the breakpoint(s) it belongs to.
 *
 * Cross-frame node identity reuses the Smart-Animate layer matcher (`matchLayers`, by name +
 * nesting path): a node matched between the widest frame and a narrower one shares the widest
 * node's CSS class, so the narrower frame's rule overrides the base rule of the same DOM element.
 * A node present in the widest frame but absent from a narrower one is hidden (`display: none`)
 * inside that frame's media block.
 */

import type { IrContainerNode, IrInstanceRefNode, IrLayout, IrNode } from './ir.ts'
import { matchLayers, type DiffableNode, type LayerMatchResult } from './smart-animate/index.ts'
import { emitCss, layoutDeclarations, toClassName, type DjangoNodeSource } from './css-emitter.ts'
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
  /** The raw name-suffix this frame was parsed from (`'mobile'`, `'tablet'`, `'768'`, …) — the
   * tag `mergeBreakpointVariants` stamps onto a narrow-only node's `breakpointOnly`. */
  readonly breakpoint: string
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
): { slug: string; width: number; breakpoint: string } | null {
  const match = /^(.*)\/([^/]+)$/.exec(name.trim())
  if (!match) return null
  const slug = match[1].trim()
  if (!slug) return null
  const suffix = match[2].trim().toLowerCase()
  if (suffix in namedWidths) return { slug, width: namedWidths[suffix], breakpoint: suffix }
  const width = /^(\d+)\s*(?:px)?$/.exec(suffix)
  if (width) return { slug, width: Number(width[1]), breakpoint: suffix }
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
    bySlug.get(key)!.frames.push({ width: parsed.width, breakpoint: parsed.breakpoint, node: root })
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

type ParentNode = IrContainerNode | IrInstanceRefNode

/** One node in a real IR tree, indexed the same way `matchLayers`' internal `indexTree` indexes
 * `DiffableNode`s (name#dupIndex path segments) — so a `DiffableNode` path found by `matchLayers`
 * resolves straight back to the real node (with its real, un-flattened subtree) at that path. */
interface RealTreeEntry {
  readonly node: IrNode
  readonly parent: ParentNode | null
  readonly indexInParent: number
  readonly path: string
}

/** Indexes every descendant of `root` by its `name#dupIndex/…` path (see `RealTreeEntry`) and by
 * id, mirroring `match-layers.ts`'s private `indexTree` exactly so paths line up with
 * `matchLayers`' output. Rebuilding this fresh for the merged tree before each narrower frame's
 * diff keeps splice targets and dedup checks accurate as earlier frames' splices land. */
function indexRealTree(root: IrNode): { byPath: Map<string, RealTreeEntry>; byId: Map<string, RealTreeEntry> } {
  const byPath = new Map<string, RealTreeEntry>()
  const byId = new Map<string, RealTreeEntry>()
  const walk = (node: IrNode, prefix: string): void => {
    if (!('children' in node)) return
    const seen = new Map<string, number>()
    node.children.forEach((child, indexInParent) => {
      const dupIndex = seen.get(child.name) ?? 0
      seen.set(child.name, dupIndex + 1)
      const path = `${prefix}${child.name}#${dupIndex}`
      const entry: RealTreeEntry = { node: child, parent: node as ParentNode, indexInParent, path }
      byPath.set(path, entry)
      byId.set(child.id, entry)
      walk(child, `${path}/`)
    })
  }
  walk(root, '')
  return { byPath, byId }
}

/** The path of `path`'s parent — everything before the last `/`, or `''` for a direct root child
 * (matching `matchLayers`' root-relative path convention, which has no leading segment for it). */
function parentPathOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * For every flex-parent container shared between the merged tree and `frameRoot`, compares the
 * two trees' flow-child order (children with `absoluteInLayout !== true`, restricted to the
 * common set matched by `idAliases`). A differing sequence means the narrower frame reordered
 * its children (docs: a stacked mobile CTA moved above the copy) — CSS `order` cannot express
 * "these two swapped" in isolation (an un-annotated sibling defaults to `order: 0` and would
 * jump to the front), so EVERY flow child of that parent gets an explicit `order` pinned to the
 * frame's own sequence, not just the ones that moved. Absolute/grid parents are skipped — `order`
 * only affects flex layout, so setting it there would be a silent no-op with no cascade value.
 */
function computeFlexOrderOverrides(
  frameRoot: IrContainerNode,
  beforeIndex: { readonly byPath: ReadonlyMap<string, RealTreeEntry> },
  frameIndex: { readonly byPath: ReadonlyMap<string, RealTreeEntry> },
  idAliases: ReadonlyMap<string, string>
): Map<string, number> {
  const overrides = new Map<string, number>()
  const consideredParents = new Set<string>()

  for (const entry of beforeIndex.byPath.values()) {
    if (!entry.parent || consideredParents.has(entry.parent.id)) continue
    const parentLayout = 'layout' in entry.parent ? entry.parent.layout : null
    if (parentLayout?.kind !== 'flex') continue
    consideredParents.add(entry.parent.id)

    const parentPath = parentPathOf(entry.path)
    const frameParent = parentPath === '' ? frameRoot : frameIndex.byPath.get(parentPath)?.node
    if (!frameParent || !('children' in frameParent)) continue

    const mergedFlow = entry.parent.children.filter((c) => c.absoluteInLayout !== true)
    const frameFlow = frameParent.children.filter((c) => c.absoluteInLayout !== true)

    const frameIdToMergedId = new Map<string, string>()
    for (const child of frameFlow) {
      const mergedId = idAliases.get(child.id)
      if (mergedId) frameIdToMergedId.set(child.id, mergedId)
    }
    const commonMergedIds = new Set(frameIdToMergedId.values())
    const mergedOrder = mergedFlow.map((c) => c.id).filter((id) => commonMergedIds.has(id))
    const frameOrder = frameFlow.map((c) => frameIdToMergedId.get(c.id)).filter((id): id is string => Boolean(id))

    if (mergedOrder.length < 2 || mergedOrder.join('|') === frameOrder.join('|')) continue

    // Sequence differs — pin every flow child (matched or freshly spliced-in this frame) to the
    // frame's own order. A freshly spliced child has no merged-id alias yet (it's about to be
    // added at exactly this position), so it keeps its own id, which becomes its merged id too.
    frameFlow.forEach((child, index) => {
      overrides.set(frameIdToMergedId.get(child.id) ?? child.id, index)
    })
  }

  return overrides
}

/** The `display` value a node reveals to when its `breakpointOnly` media block turns it back on
 * — reuses `layoutDeclarations`' own flex/grid/line-clamp/image-block rules (so a mobile-only flex
 * row reveals as `flex`, not `block`) with `block` as the CSS default fallback for anything else
 * (a plain leaf/absolute container), matching the same default the browser already applies to a
 * `<div>`/`<p>`. Computed once over the FINAL merged tree since a node's own display never
 * depends on which frame is asking. */
function computeRevealDisplay(root: IrContainerNode, ids: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (node: IrNode, parentLayout: IrLayout | null): void => {
    if (ids.has(node.id)) result.set(node.id, layoutDeclarations(node, parentLayout)['display'] ?? 'block')
    if ('children' in node) {
      const layout = 'layout' in node ? node.layout : null
      for (const child of node.children) walk(child, layout)
    }
  }
  walk(root, null)
  return result
}

/**
 * M4b missing-tablet interpolation (docs §M4b "missing-tablet reality"): a group with only a
 * desktop and a mobile frame has no design for the gap between the mobile threshold and the
 * desktop width — the mobile block's `max-width` has no lower bound (see `emitBreakpointCss`'s
 * doc comment), so without this, mobile's cramped fixed-px layout would stretch across that whole
 * gap. The one interpolation this function makes is conservative by construction: a CONTAINER
 * whose own width is a fixed px EQUAL to the desktop frame's width (typically the page root, or a
 * full-bleed section) becomes fluid (`width: 100%; max-width: <px>`) instead — identical to the
 * original fixed value at ≥ desktop width, and never wider than the viewport below it. No other
 * layout property is touched, so nothing beyond overflow-safety is invented for the gap.
 */
function collectFixedWidthInterpolationIds(root: IrContainerNode, desktopWidth: number): string[] {
  const ids: string[] = []
  const walk = (node: IrNode): void => {
    if (
      (node.type === 'container' || node.type === 'instance-ref') &&
      node.sizing.width.mode === 'fixed' &&
      node.sizing.width.value === desktopWidth
    ) {
      ids.push(node.id)
    }
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(root)
  return ids.sort()
}

/** Per-narrower-frame CSS inputs computed by `mergeBreakpointGroup` — everything
 * `emitBreakpointCss` needs to format one `@media` block without re-diffing. */
interface MergedFrameDiff {
  readonly frame: BreakpointFrame
  readonly nextWiderWidth: number
  /** Frame node id → merged node id, for `emitCss`'s `idAliases` (M4b overrides). */
  readonly idAliases: ReadonlyMap<string, string>
  /** Merged ids spliced into the tree AT this frame — `display: <real>` reveals them here. */
  readonly revealedIds: readonly string[]
  /** Merged ids present before this frame but absent from it — `display: none` here. */
  readonly hiddenIds: readonly string[]
  /** Merged/own id → `order` value, for flex parents whose child sequence this frame reorders. */
  readonly orderByClassId: ReadonlyMap<string, number>
}

interface MergedBreakpointResult {
  readonly root: IrContainerNode
  /** Every `breakpointOnly`-tagged node — `display: none` in the unconditional base CSS. */
  readonly baseHiddenIds: readonly string[]
  /** M4b missing-tablet interpolation targets (`collectFixedWidthInterpolationIds`) — empty
   * unless the group has exactly a desktop and a mobile frame with nothing in between. */
  readonly interpolatedFixedWidthIds: readonly string[]
  /** Narrower frames' diffs, widest-first (so `emitBreakpointCss` emits blocks in that order). */
  readonly frames: readonly MergedFrameDiff[]
  readonly revealDisplayById: ReadonlyMap<string, string>
}

/** Deep copy of an IR subtree. `structuredClone` is a host API — the Figma plugin sandbox does not
 * define it, so calling it would throw at export time on the only machine that matters; the IR is
 * plain JSON data, so a serialize/parse round trip is an exact copy. A shallow copy is not an
 * option: the merge splices narrow-only subtrees into the widest frame's own children arrays and
 * would mutate the frame it cloned from. */
function cloneIr<T extends IrNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T
}

/**
 * The shared merge+diff pass behind both `mergeBreakpointVariants` (the DOM) and
 * `emitBreakpointCss` (the CSS) — computed once per group so the two stay in lockstep.
 *
 * Frames are folded into the merged tree widest-to-narrowest, and each narrower frame is diffed
 * against the CURRENT merged tree (not the original widest frame) rather than independently
 * against the widest frame alone. This matters for a 3+ frame group: a node introduced by the
 * tablet frame (absent from desktop) that also exists in the mobile frame is diffed as MATCHED at
 * the mobile step (it's already in the merged tree from the tablet splice), not re-added as a
 * second, duplicate mobile-only copy — and its `breakpointOnly` tag widens to cover both.
 */
function mergeBreakpointGroup(group: BreakpointGroup): MergedBreakpointResult {
  const [widest, ...narrower] = group.frames
  const merged = cloneIr(widest.node) as IrContainerNode
  const baseHiddenIds = new Set<string>()
  const frames: MergedFrameDiff[] = []

  for (let i = 0; i < narrower.length; i++) {
    const frame = narrower[i]
    const nextWiderWidth = i === 0 ? widest.width : narrower[i - 1].width

    const beforeIndex = indexRealTree(merged)
    const frameIndex = indexRealTree(frame.node)
    const diffResult: LayerMatchResult = matchLayers(toDiffable(merged), toDiffable(frame.node))

    const idAliases = new Map<string, string>([[frame.node.id, merged.id]])
    for (const pair of diffResult.matched) {
      if (pair.a.id && pair.b.id) idAliases.set(pair.b.id, pair.a.id)
    }
    const revealedIds: string[] = []

    // A merged node that already carries `breakpointOnly` (spliced by an EARLIER, wider narrow
    // frame) and is ALSO present here belongs to this breakpoint too — widen its tag AND reveal
    // it again in this frame's own block. The reveal is redundant with the wider frame's block
    // cascading down (max-width has no lower bound — see `emitBreakpointCss`), but keeping one
    // self-contained `display` rule per breakpoint the node belongs to means a later block never
    // has to be trusted to carry it, and no block ever declares two conflicting rules for it.
    for (const pair of diffResult.matched) {
      if (!pair.a.id) continue
      const entry = beforeIndex.byId.get(pair.a.id)
      if (!entry || !entry.parent) continue
      const existing = entry.node.breakpointOnly
      if (existing && existing.length > 0) {
        revealedIds.push(pair.a.id)
        if (!existing.includes(frame.breakpoint)) {
          entry.parent.children[entry.indexInParent] = { ...entry.node, breakpointOnly: [...existing, frame.breakpoint] }
        }
      }
    }

    const orderByClassId = computeFlexOrderOverrides(frame.node, beforeIndex, frameIndex, idAliases)

    // Splice every top-level narrow-only subtree (present in this frame, absent from the merged
    // tree so far) into its matched parent. `beforeIndex.byPath.has(entry.path)` excludes a
    // type-mismatch (same path, different node type in matchLayers' removed+added pairing) —
    // that degrades to "hidden" (below) against the widest-frame node already at that path,
    // rather than splicing a conflicting second node into the same slot.
    const addedRoots = diffResult.added.filter((entry) => {
      if (beforeIndex.byPath.has(entry.path)) return false
      const parentPath = parentPathOf(entry.path)
      return parentPath === '' || beforeIndex.byPath.has(parentPath)
    })
    const sortedAdded = [...addedRoots].sort(
      (x, y) => frameIndex.byPath.get(x.path)!.indexInParent - frameIndex.byPath.get(y.path)!.indexInParent
    )
    const insertedCountByParent = new Map<string, number>()
    for (const added of sortedAdded) {
      const real = frameIndex.byPath.get(added.path)
      if (!real) continue
      const parentPath = parentPathOf(added.path)
      const parentNode: ParentNode = parentPath === '' ? merged : (beforeIndex.byPath.get(parentPath)!.node as ParentNode)
      if (!('children' in parentNode)) continue
      const already = insertedCountByParent.get(parentNode.id) ?? 0
      const insertAt = Math.min(real.indexInParent + already, parentNode.children.length)
      const spliced: IrNode = { ...cloneIr(real.node), breakpointOnly: [frame.breakpoint] }
      parentNode.children.splice(insertAt, 0, spliced)
      insertedCountByParent.set(parentNode.id, already + 1)
      baseHiddenIds.add(spliced.id)
      revealedIds.push(spliced.id)
    }

    // `removed` = present in the merged tree before this frame, absent (or type-changed) here —
    // hidden in this frame's block. Covers both original widest-frame nodes AND nodes an earlier
    // narrower frame spliced in that this frame doesn't have (e.g. tablet-only, gone by mobile).
    const hiddenIds = diffResult.removed
      .map((entry) => entry.node.id)
      .filter((id): id is string => Boolean(id))

    frames.push({ frame, nextWiderWidth, idAliases, revealedIds, hiddenIds, orderByClassId })
  }

  const interpolatedFixedWidthIds =
    group.frames.length === 2 ? collectFixedWidthInterpolationIds(merged, widest.width) : []
  const revealDisplayById = computeRevealDisplay(merged, baseHiddenIds)

  return { root: merged, baseHiddenIds: [...baseHiddenIds].sort(), interpolatedFixedWidthIds, frames, revealDisplayById }
}

/**
 * Merges a breakpoint group's frames into ONE IR tree (M4b): the widest frame's tree, with every
 * node that exists only in a narrower frame spliced into its matched parent at that frame's
 * sibling position, tagged `breakpointOnly` with the breakpoint(s) it belongs to. Callers render
 * THIS tree instead of the raw widest frame — `emitBreakpointCss` (same group) supplies the CSS
 * that hides each spliced node outside its breakpoint(s) and reveals it inside them.
 */
export function mergeBreakpointVariants(group: BreakpointGroup): IrContainerNode {
  return mergeBreakpointGroup(group).root
}

/**
 * Emits the `@media (max-width: …)` blocks for one breakpoint group's narrower frames — the
 * widest frame is the base layout and is emitted by the caller's ordinary `emitCss` pass over
 * the rendered roots (over `mergeBreakpointVariants`'s merged tree, once the caller has swapped
 * it in — see that function's doc comment). Blocks come out widest-first (descending threshold)
 * so the narrowest frame's rules win the cascade where two thresholds overlap.
 *
 * A frame's design applies from ITS OWN width up to just below the NEXT WIDER frame's width —
 * so each block's threshold is `nextWiderWidth - 1`, not the frame's own width. (With own-width
 * thresholds, a 375px viewport would render the 768 design: the 375 block would only match
 * at ≤374px, one frame off across the whole cascade.) Because `max-width` has no lower bound,
 * a frame's declarations also apply to every viewport narrower than its own threshold UNLESS a
 * still-narrower frame's block (emitted after it) redeclares that property — the intended
 * cascade for a 3+ frame group, but a leak for a 2-frame (desktop+mobile, no tablet) group: the
 * lone mobile block's `max-width` runs all the way to `desktop.width - 1`, so mobile's fixed-px
 * layout would otherwise stretch across the whole desktop↔mobile gap. `collectFixedWidthInterpolationIds`'s
 * fluid replacement is protected from that leak by its own guard, emitted LAST as
 * `@media (min-width: mobile.width)` — same specificity as mobile's block, later in the
 * stylesheet, so it wins the `width`/`max-width` properties for those nodes everywhere at or
 * above mobile's own width, while mobile's actual (narrower) design still applies unmodified
 * below it.
 *
 * For each narrower frame: matched nodes (by name + nesting path against the merged tree so
 * far) re-key their CSS onto the merged node's class via `idAliases`, so the block overrides the
 * base rule of the same DOM element; the frame's own root aliases onto the merged root the same
 * way. Nodes absent from this frame get `display: none`; nodes this frame introduces (spliced by
 * `mergeBreakpointVariants`) get `display: <real>` to undo the unconditional base hide. Flex
 * parents whose flow-child order this frame changes get an `order` declaration per child.
 */
export async function emitBreakpointCss(
  group: BreakpointGroup,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string> = new Map()
): Promise<string> {
  const merged = mergeBreakpointGroup(group)

  const baseParts: string[] = []
  if (merged.baseHiddenIds.length > 0) {
    const selector = merged.baseHiddenIds.map((id) => `.${toClassName(id)}`).join(',\n')
    baseParts.push(`${selector} {\n  display: none;\n}`)
  }

  const blocks: string[] = []
  for (const fr of merged.frames) {
    const overrides = await emitCss([fr.frame.node], sceneNodesById, variableNamesById, {
      idAliases: fr.idAliases,
      preamble: false,
    })
    const revealed = [...fr.revealedIds]
      .sort()
      .map((id) => `.${toClassName(id)} {\n  display: ${merged.revealDisplayById.get(id) ?? 'block'};\n}`)
    const hidden = [...fr.hiddenIds].sort().map((id) => `.${toClassName(id)} {\n  display: none;\n}`)
    const orders = [...fr.orderByClassId.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, order]) => `.${toClassName(id)} {\n  order: ${order};\n}`)

    const body = [overrides, ...revealed, ...hidden, ...orders].filter((part) => part.length > 0).join('\n\n')
    if (body.length === 0) continue
    blocks.push(`@media (max-width: ${fr.nextWiderWidth - 1}px) {\n${indent(body)}\n}`)
  }

  // Missing-tablet gap guard (see doc comment above) — placed after every max-width block so it
  // wins the width/max-width properties for the interpolated nodes across the whole gap.
  if (merged.interpolatedFixedWidthIds.length > 0) {
    const mobileWidth = group.frames[group.frames.length - 1].width
    const px = group.frames[0].width
    const selector = merged.interpolatedFixedWidthIds.map((id) => `.${toClassName(id)}`).join(',\n')
    blocks.push(
      `/* M4b missing-tablet interpolation: no frame exists between desktop and mobile, so a\n` +
        `   desktop-width fixed container is bounded-fluid instead of showing mobile's cramped\n` +
        `   design across the whole gap (see emitBreakpointCss's doc comment). */\n` +
        `@media (min-width: ${mobileWidth}px) {\n${indent(`${selector} {\n  width: 100%;\n  max-width: ${px}px;\n}`)}\n}`
    )
  }

  return [...baseParts, ...blocks].join('\n\n')
}

// ── Breakpoint collection generator (forum-recommended modes-as-breakpoints pattern) ──────

/** Private pluginData key that marks a "Breakpoints" collection as generated by this plugin,
 * so re-generation can find and replace it cleanly (same pattern as the typography generator
 * in allcrew-channel, which uses `TYPO_COLLECTION_PLUGIN_KEY`). The value stores the ISO
 * timestamp of the last regeneration for diagnostics. */
export const BREAKPOINT_COLLECTION_PLUGIN_KEY = 'allcrewChannelBreakpointsGenerated'

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
  widthVar.description = 'Breakpoint viewport width (px) per mode. Generated by AllCrew Channel plugin.'
  widthVar.hiddenFromPublishing = false
  for (let i = 0; i < steps.length; i++) {
    widthVar.setValueForMode(modeIds[i], steps[i].width)
  }

  // STRING variable "Layout" — holds the mode name itself per mode (e.g. Desktop mode →
  // "Desktop", Mobile mode → "Mobile"). Case-sensitive. Useful for conditional logic in
  // prototypes / component variants that key off a string label rather than a px width.
  const layoutVar = figma.variables.createVariable('Layout', collection, 'STRING')
  layoutVar.description = 'Breakpoint layout label (mode name) per mode. Generated by AllCrew Channel plugin.'
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
