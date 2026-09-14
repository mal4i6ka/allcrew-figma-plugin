/**
 * Agent listener — states & breakpoints (Contract §4). Two things the plugin already computes
 * elsewhere but only ever hands out as generated CSS text, never as data an agent (or the site
 * importer) can act on:
 *
 * `node.states` answers "what changes on this node at hover/press/click/timeout, and on its
 * variant-set siblings that carry a State property (`State=Hover`, `State=Active` — the vocabulary
 * the Tabs chips at 819:95708 are drawn with)". `interactions.ts` already diffs exactly this for
 * the stylesheet it emits; this op reuses the same CSS-diff core (`state-diff.ts`) and the same
 * name+path layer matcher (`smart-animate/match-layers.ts`) but returns a property list instead of
 * a `:hover` rule, so the site importer can store the delta on a CMS block instead of re-parsing
 * generated CSS to recover it.
 *
 * `frames.compare` answers "what differs between two arbitrary frames" — no `<slug>/mobile|375`
 * naming convention required, unlike `breakpoint-frames.ts`'s `detectBreakpointGroups` (which
 * exists to find frame PAIRS across a whole page by name; here the caller already knows which two
 * frames to compare, e.g. a "Guides / Desktop" and "Guides / Mobile" pair that share no naming
 * convention at all — 53 of 91 pages in the working file are exactly this shape and currently
 * unreachable by the importer). It reuses the same layer matcher for the structural diff, but its
 * own reorder detection is NOT `breakpoint-frames.ts`'s `computeFlexOrderOverrides` — that
 * function is fused to the breakpoint MERGE (it needs `idAliases` from splicing narrower frames
 * into the widest one, and IR nodes' `layout.kind` to know which parents are even flex). This op
 * has neither a merge nor an IR tree, only two live nodes, so it computes its own, simpler
 * common-sibling-order comparison (see `detectReordered` below) — same idea (ignore siblings only
 * one side has before deciding anything moved), independently applicable to two arbitrary trees.
 */

import type { OpDef } from './protocol.ts'
import { diffCssProperties } from '../targets/django/state-diff.ts'
import { motionCurve, type MotionCurve } from '../targets/django/easing/index.ts'
import { boundTokensByCssProperty, variableNameResolver } from './bound-tokens.ts'
import { getNodeByIdTimed } from './loading.ts'
import { matchLayers } from '../targets/django/smart-animate/match-layers.ts'
import type { DiffableNode } from '../targets/django/smart-animate/types.ts'

/* ------------------------------------------------------------------- shared node duck type */

/** The live-node shape both ops read — a real Figma `SceneNode`/`ComponentNode`/`InstanceNode`
 * satisfies this structurally, and so does a plain test fixture (same duck type `interactions.ts`
 * tests use for its own descendant walk). */
export interface LiveNode {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly children?: readonly LiveNode[]
  readonly parent?: LiveNode | null
  getCSSAsync?: () => Promise<Record<string, string>>
  reactions?: unknown
  getReactionsAsync?: () => Promise<unknown>
  readonly variantProperties?: Record<string, string> | null
  readonly mainComponent?: LiveNode | null
  getMainComponentAsync?: () => Promise<LiveNode | null>
  readonly width?: number
  readonly height?: number
  readonly paddingTop?: number
  readonly paddingRight?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly itemSpacing?: number
  readonly fontSize?: unknown
  /** Read for the token behind a changed value - see `bound-tokens.ts`. */
  readonly boundVariables?: Record<string, unknown> | null
}

async function cssOf(node: LiveNode): Promise<Record<string, string>> {
  return typeof node.getCSSAsync === 'function' ? await node.getCSSAsync() : {}
}

/** `DiffableNode` needs only name/type/children for `matchLayers` (it reads nothing else — see
 * match-layers.ts) — geometry is irrelevant to a name+path match, so every other field is a cheap
 * placeholder, exactly like `interactions.ts`'s own `toLiveDiffableTree`. */
function toNameTypeDiffable(node: LiveNode): DiffableNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: (node.children ?? []).map(toNameTypeDiffable),
  }
}

function indexById(root: LiveNode): Map<string, LiveNode> {
  const map = new Map<string, LiveNode>()
  const walk = (node: LiveNode): void => {
    map.set(node.id, node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return map
}

/* --------------------------------------------------------------------------- node.states */

export type StateTrigger = 'ON_HOVER' | 'ON_PRESS' | 'ON_CLICK' | 'AFTER_TIMEOUT'

export interface StateChange {
  /** `''` for the trigger node's own change; `name#dupIndex/…` (match-layers.ts's path) for a
   * descendant — the SAME address a matched/removed/added entry carries in its output. */
  readonly path: string
  readonly property: string
  readonly from: string
  readonly to: string
  /** The design token each side's value came from, when the layer binds one. `from`/`to` are
   * `getCSSAsync`'s answer, which for a bound value is `var(--Base-orange-O500---Main, #FB5B0A)` —
   * a name mangled for CSS and therefore not one a consumer can look back up. These name the
   * variable itself, so a state can be implemented against the design system rather than a hex. */
  readonly fromToken?: string
  readonly toToken?: string
}

export interface StateTransition {
  readonly type: string
  /** Milliseconds — Figma stores seconds on the raw reaction, converted here for the same reason
   * `ir.ts`'s `IrInteraction.durationMs` is: every other duration this bridge reports is ms. */
  readonly duration: number
  /** Figma's own name for the easing (`EASE_OUT`, `CUSTOM_SPRING`, …) — kept because it is what
   * the designer picked in the panel and what a bug report will quote. */
  readonly easing: string
  /** The easing as numbers: bezier control points, or a spring's ζ/ω₀/response/stiffness/settle
   * time. `easing` alone is a name a consumer cannot animate with — `CUSTOM_CUBIC_BEZIER` used to
   * arrive with its control points thrown away, and `CUSTOM_SPRING` with its physics gone.
   * Absent when this module cannot name the easing (a variable alias, or a preset newer than it). */
  readonly curve?: MotionCurve
}

export interface NodeState {
  readonly trigger: StateTrigger
  readonly from: { readonly id: string; readonly name: string }
  readonly to: { readonly id: string; readonly name: string }
  readonly transition: StateTransition | null
  readonly changes: readonly StateChange[]
}

const REACTION_TRIGGERS: Readonly<Record<string, true>> = {
  ON_HOVER: true,
  ON_PRESS: true,
  ON_CLICK: true,
  AFTER_TIMEOUT: true,
}

/** Diffs `from` against `to` at the root AND every matched descendant (name+path — the same
 * algorithm Smart Animate itself uses), returning one flat change list addressed by path. A
 * descendant that exists on only one side (revealed/hidden by the state, exactly what
 * `interactions.ts`'s `descendantRules` calls `added`/`removed`) gets one `presence` change
 * instead of being silently dropped — there is no CSS property to name for "this layer doesn't
 * exist here", but the fact itself is real state and the importer needs to know about it. */
export async function diffNodeSubtrees(
  from: LiveNode,
  to: LiveNode,
  resolveToken: (id: string) => Promise<string | null> = variableNameResolver()
): Promise<StateChange[]> {
  const changes: StateChange[] = []
  /** One layer pair's diff, with the token behind each changed value where the layer binds one. */
  const diffPair = async (path: string, a: LiveNode, b: LiveNode): Promise<void> => {
    const [aCss, bCss, aTokens, bTokens] = await Promise.all([
      cssOf(a),
      cssOf(b),
      boundTokensByCssProperty(a, resolveToken),
      boundTokensByCssProperty(b, resolveToken),
    ])
    for (const d of diffCssProperties(aCss, bCss)) {
      changes.push({
        path,
        property: d.property,
        from: d.from,
        to: d.to,
        ...(aTokens[d.property] ? { fromToken: aTokens[d.property] } : {}),
        ...(bTokens[d.property] ? { toToken: bTokens[d.property] } : {}),
      })
    }
  }

  await diffPair('', from, to)

  const { matched, removed, added } = matchLayers(toNameTypeDiffable(from), toNameTypeDiffable(to))
  const byIdFrom = indexById(from)
  const byIdTo = indexById(to)

  for (const pair of matched) {
    const a = pair.a.id ? byIdFrom.get(pair.a.id) : undefined
    const b = pair.b.id ? byIdTo.get(pair.b.id) : undefined
    if (!a || !b) continue
    await diffPair(pair.path, a, b)
  }
  for (const entry of removed) changes.push({ path: entry.path, property: 'presence', from: 'present', to: 'removed' })
  for (const entry of added) changes.push({ path: entry.path, property: 'presence', from: 'absent', to: 'added' })
  return changes
}

async function reactionsOf(node: LiveNode): Promise<unknown[]> {
  const raw = typeof node.getReactionsAsync === 'function' ? await node.getReactionsAsync() : node.reactions
  return Array.isArray(raw) ? raw : []
}

/** A raw Figma `Transition` reduced to the three fields `node.states` reports — no CSS timing-
 * function synthesis (that's `easing-adapter.ts`'s job for the export pipeline): this is a read op
 * naming what Figma itself stored, for a caller that wants the raw shape, not a stylesheet. */
function transitionOf(raw: unknown): StateTransition | null {
  if (!raw || typeof raw !== 'object') return null
  // Figma's raw `Transition` shape — narrowed the same minimal way `ops.ts`'s
  // `summarizeReactions` reads a raw `Reaction`, since the full type lives in
  // `@figma/plugin-typings` and this op only ever reads these three fields off it.
  const transition = raw as {
    type?: string
    duration?: number
    easing?: {
      type?: string
      easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number }
      easingFunctionSpring?: { bounce?: number; mass?: number; stiffness?: number; damping?: number; initialVelocity?: number }
    }
  }
  if (!transition.type) return null
  const curve = motionCurve(transition.easing, transition.duration)
  return {
    type: transition.type,
    duration: Math.round((transition.duration ?? 0) * 1000),
    easing: transition.easing?.type ?? 'LINEAR',
    ...(curve ? { curve } : {}),
  }
}

/** States sourced from ON_HOVER/ON_PRESS/ON_CLICK/AFTER_TIMEOUT reactions with a NODE/CHANGE_TO
 * action — the same reaction shape `interactions.ts`'s `emitInteractions` reads, minus the CSS
 * emission. A destination the resolver can't find (off the exported page, or plain deleted) is
 * skipped rather than thrown — a node.states caller wants what IS reachable, not a hard failure
 * over one dangling reaction, matching `emitInteractions`'s own warn-and-skip on the same case. */
async function reactionStates(node: LiveNode, resolve: (id: string) => Promise<LiveNode | null>): Promise<NodeState[]> {
  const states: NodeState[] = []
  for (const reaction of await reactionsOf(node)) {
    if (!reaction || typeof reaction !== 'object') continue
    // Figma's raw `Reaction` shape (both the current `actions[]` array and the legacy single
    // `action` are handled below) — same minimal narrowing `ops.ts`'s `summarizeReactions` uses.
    const entry = reaction as { trigger?: { type?: string }; actions?: unknown[]; action?: unknown }
    const trigger = entry.trigger?.type
    if (!trigger || !REACTION_TRIGGERS[trigger]) continue
    const actions = Array.isArray(entry.actions) ? entry.actions : entry.action ? [entry.action] : []
    for (const rawAction of actions) {
      if (!rawAction || typeof rawAction !== 'object') continue
      // Figma's raw `Action` shape — only the NODE/CHANGE_TO fields this op reads.
      const action = rawAction as { type?: string; navigation?: string; destinationId?: string; transition?: unknown }
      if (action.type !== 'NODE' || action.navigation !== 'CHANGE_TO' || typeof action.destinationId !== 'string') continue
      const dest = await resolve(action.destinationId)
      if (!dest) continue
      states.push({
        trigger: trigger as StateTrigger,
        from: { id: node.id, name: node.name },
        to: { id: dest.id, name: dest.name },
        transition: transitionOf(action.transition),
        changes: await diffNodeSubtrees(node, dest),
      })
    }
  }
  return states
}

/** Recognized state-property values, mapped onto the same trigger vocabulary the reaction path
 * uses — so a caller never has to know whether a given chip encodes its states with a prototype
 * reaction or a `State=Hover` variant property, the answer shape is identical either way. Values
 * outside this table ("Default", "Disabled", "Standart" itself) are the rest state, not a
 * trigger — they are the `from` side, never a `to`. */
const STATE_VALUE_TRIGGERS: Readonly<Record<string, StateTrigger>> = {
  hover: 'ON_HOVER',
  hovered: 'ON_HOVER',
  press: 'ON_PRESS',
  pressed: 'ON_PRESS',
  active: 'ON_PRESS',
  focus: 'ON_CLICK',
  focused: 'ON_CLICK',
  selected: 'ON_CLICK',
  click: 'ON_CLICK',
  clicked: 'ON_CLICK',
}

/** The first variant property whose NAME contains "state" (`State`, `Interaction State`, …) —
 * Figma variant property names are designer-chosen free text, so this matches by substring the
 * same way the rest of this vocabulary (Bootstrap component naming, etc.) tolerates spelling. */
function stateEntryOf(props: Record<string, string> | null | undefined): { key: string; value: string } | null {
  if (!props) return null
  for (const [key, value] of Object.entries(props)) {
    if (/state/i.test(key)) return { key, value }
  }
  return null
}

/** States sourced from a component SET's own State-variant siblings (`State=Hover`, `State=
 * Active`, …) rather than a prototype reaction — the Tabs chip case (819:95708): its Hover/Active
 * look was authored as variant members, not a CHANGE_TO reaction, and nothing in the export
 * pipeline surfaced that split until now. `node` may be the variant COMPONENT itself or an
 * INSTANCE of one (its main component's set is resolved either way). */
async function variantStates(node: LiveNode): Promise<NodeState[]> {
  let self: LiveNode | null = null
  if (node.type === 'COMPONENT') {
    self = node
  } else if (node.type === 'INSTANCE') {
    // `getMainComponentAsync` over `.mainComponent` — required under `documentAccess: "dynamic-
    // page"` (this listener's access mode throughout, per ops.ts's own module doc), where an
    // instance's main component is not guaranteed to already be loaded synchronously.
    self = typeof node.getMainComponentAsync === 'function' ? await node.getMainComponentAsync() : (node.mainComponent ?? null)
  }
  if (!self) return []
  const set = self.parent && self.parent.type === 'COMPONENT_SET' ? self.parent : null
  if (!set) return []
  const ownState = stateEntryOf(self.variantProperties)
  if (!ownState) return []

  const states: NodeState[] = []
  for (const sibling of set.children ?? []) {
    if (sibling.id === self.id) continue
    const siblingProps = sibling.variantProperties
    if (!siblingProps) continue
    // A true state-only variant: every OTHER variant property (Size, Icon, …) must match, or the
    // diff would attribute a size-variant's own delta to "what hover changes".
    const sameElsewhere = Object.entries(self.variantProperties ?? {}).every(
      ([key, value]) => key === ownState.key || siblingProps[key] === value
    )
    if (!sameElsewhere) continue
    const siblingValue = siblingProps[ownState.key]
    const trigger = STATE_VALUE_TRIGGERS[(siblingValue ?? '').toLowerCase()]
    if (!trigger) continue // "Default"/"Disabled"/etc. — not a trigger this vocabulary models.

    states.push({
      trigger,
      from: { id: node.id, name: node.name },
      to: { id: sibling.id, name: sibling.name },
      transition: null, // a pure variant swap carries no reaction-authored easing.
      changes: await diffNodeSubtrees(node, sibling),
    })
  }
  return states
}

export interface NodeStatesResult {
  readonly states: readonly NodeState[]
  /** Set when the call was addressed to a component SET and answered about one of its members -
   * the id `components.list` hands out is the set's, and answering `states: []` to it (which is
   * what happened before) reads as "this component has no states". */
  readonly resolvedFrom?: { readonly id: string; readonly name: string }
}

/** The member a SET's states are read from: the variant every axis default points at, or its
 * first child when the set has no such combination. A set has no states of its own - the hover
 * lives on the reactions of a member, or between members - so answering about the set means
 * answering about that one. */
function defaultMemberOf(set: LiveNode): LiveNode | null {
  const members = set.children ?? []
  if (members.length === 0) return null
  const resting = members.find((member) => {
    const values = Object.values(member.variantProperties ?? {})
    // Nothing declares which member rests without the set's property definitions, which this
    // module deliberately does not read (`componentPropertyDefinitions` throws on a broken set -
    // see ops.ts). A member whose state axis is a resting value is the honest heuristic here.
    return values.some((value) => /^(default|standart|standard|idle|normal|rest|enabled)$/i.test(value))
  })
  return resting ?? members[0]
}

export async function computeNodeStates(node: LiveNode, resolve: (id: string) => Promise<LiveNode | null>): Promise<NodeStatesResult> {
  if (node.type === 'COMPONENT_SET') {
    const member = defaultMemberOf(node)
    if (!member) return { states: [] }
    const [fromReactions, fromVariants] = await Promise.all([reactionStates(member, resolve), variantStates(member)])
    return { states: [...fromReactions, ...fromVariants], resolvedFrom: { id: member.id, name: member.name } }
  }
  const [fromReactions, fromVariants] = await Promise.all([reactionStates(node, resolve), variantStates(node)])
  return { states: [...fromReactions, ...fromVariants] }
}

/* ------------------------------------------------------------------------- frames.compare */

function round2(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface FrameSnapshot {
  readonly width: number
  readonly height: number
  /** `"top right bottom left"` px shorthand — absent on a node without auto-layout padding. */
  readonly padding?: string
  readonly gap?: number
  readonly fontSize?: number
}

export interface FrameDelta {
  readonly width?: { readonly from: number; readonly to: number }
  readonly height?: { readonly from: number; readonly to: number }
  readonly padding?: { readonly from: string; readonly to: string }
  readonly gap?: { readonly from: number; readonly to: number }
  readonly fontSize?: { readonly from: number; readonly to: number }
  /** Position among the siblings BOTH frames share at this parent (see `detectReordered`) — not
   * a raw child-array index, which a merely added/removed sibling would shift for free. */
  readonly order?: { readonly from: number; readonly to: number }
}

export interface MatchedFrameLayer {
  readonly path: string
  readonly a: FrameSnapshot
  readonly b: FrameSnapshot
  readonly deltas: FrameDelta
}

export interface FramesCompareResult {
  readonly a: { readonly id: string; readonly name: string; readonly width: number }
  readonly b: { readonly id: string; readonly name: string; readonly width: number }
  readonly matched: readonly MatchedFrameLayer[]
  readonly onlyInA: readonly { readonly path: string; readonly name: string }[]
  readonly onlyInB: readonly { readonly path: string; readonly name: string }[]
  readonly reordered: readonly { readonly path: string; readonly from: number; readonly to: number }[]
}

/** A `DiffableNode` carrying exactly the fields `frames.compare`'s snapshot/delta need
 * (width/height/padding/gap/fontSize — `matchLayers` itself reads only name/type/children, same
 * as `node.states`'s tree above). Parent links are tracked alongside in `parents` (keyed by
 * object identity) because `DiffableNode` itself has none — `detectReordered` needs a child's own
 * position among its siblings, which nothing else here computes. */
function buildFrameDiffable(node: LiveNode, parents: Map<DiffableNode, DiffableNode>): DiffableNode {
  const hasPadding =
    numberOrUndefined(node.paddingTop) !== undefined ||
    numberOrUndefined(node.paddingRight) !== undefined ||
    numberOrUndefined(node.paddingBottom) !== undefined ||
    numberOrUndefined(node.paddingLeft) !== undefined
  const itemSpacing = numberOrUndefined(node.itemSpacing)
  const fontSize = numberOrUndefined(node.fontSize)
  // Children are built BEFORE the parent literal (rather than mutating `.children` after — it is
  // `readonly` on `DiffableNode`) so `parents` can be populated by iterating the finished array,
  // with no forward reference to an object that doesn't exist yet.
  const children = (node.children ?? []).map((child) => buildFrameDiffable(child, parents))

  const diffable: DiffableNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: 0,
    y: 0,
    width: round2(node.width),
    height: round2(node.height),
    ...(hasPadding
      ? {
          paddingTop: round2(node.paddingTop),
          paddingRight: round2(node.paddingRight),
          paddingBottom: round2(node.paddingBottom),
          paddingLeft: round2(node.paddingLeft),
        }
      : {}),
    ...(itemSpacing !== undefined ? { itemSpacing: round2(itemSpacing) } : {}),
    ...(fontSize !== undefined ? { fontSize: round2(fontSize) } : {}),
    children,
  }
  for (const child of children) parents.set(child, diffable)
  return diffable
}

function snapshotOf(node: DiffableNode): FrameSnapshot {
  const snapshot: FrameSnapshot = { width: node.width, height: node.height }
  if (node.paddingTop !== undefined) {
    return {
      ...snapshot,
      padding: `${node.paddingTop} ${node.paddingRight ?? 0} ${node.paddingBottom ?? 0} ${node.paddingLeft ?? 0}`,
      ...(typeof node.itemSpacing === 'number' ? { gap: node.itemSpacing } : {}),
      ...(typeof node.fontSize === 'number' ? { fontSize: node.fontSize } : {}),
    }
  }
  return {
    ...snapshot,
    ...(typeof node.itemSpacing === 'number' ? { gap: node.itemSpacing } : {}),
    ...(typeof node.fontSize === 'number' ? { fontSize: node.fontSize } : {}),
  }
}

/** Position among the siblings the TWO frames share at this level — restricted to the common set
 * before comparing sequences, for the same reason `breakpoint-frames.ts`'s flex `order` override
 * restricts to `commonMergedIds` before deciding anything moved: a sibling only one side has
 * (mobile hides a column) shifts every LATER sibling's raw array index, and a raw-index compare
 * would call every one of them "reordered" for no reason. Rank is 0-based among the common set
 * only, in each side's own order — a child neither side matched never enters this pass at all
 * (it is already reported via `onlyInA`/`onlyInB`). */
function detectReordered(
  matched: readonly { path: string; a: DiffableNode; b: DiffableNode }[],
  parentsA: ReadonlyMap<DiffableNode, DiffableNode>,
  parentsB: ReadonlyMap<DiffableNode, DiffableNode>
): Map<DiffableNode, { from: number; to: number }> {
  const matchedBByA = new Map(matched.map((pair) => [pair.a, pair.b] as const))

  const byParentA = new Map<DiffableNode | undefined, DiffableNode[]>()
  for (const pair of matched) {
    const parentA = parentsA.get(pair.a)
    const siblings = byParentA.get(parentA) ?? []
    siblings.push(pair.a)
    byParentA.set(parentA, siblings)
  }

  const result = new Map<DiffableNode, { from: number; to: number }>()
  for (const commonA of byParentA.values()) {
    // `commonA` is already in A's own order (matched[] preserves indexTree's DFS order, which
    // walks `children` in array order) restricted to the common set (only matched pairs entered
    // `byParentA` at all) — exactly the two properties the rank comparison below needs.
    const bRaw = commonA.map((a) => {
      const bNode = matchedBByA.get(a)!
      const parentB = parentsB.get(bNode)
      return parentB ? (parentB.children ?? []).indexOf(bNode) : 0
    })
    const rankOfAIndexInB = [...bRaw.keys()].sort((i, j) => bRaw[i] - bRaw[j])
    const bRankByAIndex = new Array<number>(commonA.length)
    rankOfAIndexInB.forEach((aIndex, bRank) => {
      bRankByAIndex[aIndex] = bRank
    })
    commonA.forEach((a, aIndex) => {
      const bRank = bRankByAIndex[aIndex]
      if (bRank !== aIndex) result.set(a, { from: aIndex, to: bRank })
    })
  }
  return result
}

/** Compares two arbitrary frames (desktop/mobile, any pair — no naming convention). Pure, so it
 * is directly testable against plain fixtures the way `interactions.test.ts`'s `liveNode` and
 * `spec-ops.test.ts`'s `layer` fixtures already are for their own modules. */
export function compareFrames(a: LiveNode, b: LiveNode): FramesCompareResult {
  const parentsA = new Map<DiffableNode, DiffableNode>()
  const parentsB = new Map<DiffableNode, DiffableNode>()
  const treeA = buildFrameDiffable(a, parentsA)
  const treeB = buildFrameDiffable(b, parentsB)
  const { matched, removed, added } = matchLayers(treeA, treeB)
  const orderDeltas = detectReordered(matched, parentsA, parentsB)

  const matchedLayers: MatchedFrameLayer[] = matched.map((pair) => {
    const snapA = snapshotOf(pair.a)
    const snapB = snapshotOf(pair.b)
    const order = orderDeltas.get(pair.a)
    const deltas: FrameDelta = {
      ...(snapA.width !== snapB.width ? { width: { from: snapA.width, to: snapB.width } } : {}),
      ...(snapA.height !== snapB.height ? { height: { from: snapA.height, to: snapB.height } } : {}),
      ...((snapA.padding ?? snapB.padding) !== undefined && snapA.padding !== snapB.padding
        ? { padding: { from: snapA.padding ?? '', to: snapB.padding ?? '' } }
        : {}),
      ...((snapA.gap ?? snapB.gap) !== undefined && snapA.gap !== snapB.gap
        ? { gap: { from: snapA.gap ?? 0, to: snapB.gap ?? 0 } }
        : {}),
      ...((snapA.fontSize ?? snapB.fontSize) !== undefined && snapA.fontSize !== snapB.fontSize
        ? { fontSize: { from: snapA.fontSize ?? 0, to: snapB.fontSize ?? 0 } }
        : {}),
      ...(order ? { order } : {}),
    }
    return { path: pair.path, a: snapA, b: snapB, deltas }
  })

  return {
    a: { id: a.id, name: a.name, width: round2(a.width) },
    b: { id: b.id, name: b.name, width: round2(b.width) },
    matched: matchedLayers,
    onlyInA: removed.map((entry) => ({ path: entry.path, name: entry.node.name })),
    onlyInB: added.map((entry) => ({ path: entry.path, name: entry.node.name })),
    reordered: matchedLayers.filter((layer) => layer.deltas.order).map((layer) => ({ path: layer.path, ...layer.deltas.order! })),
  }
}

/* ------------------------------------------------------------------------------------- ops */

async function resolveLiveNode(ref: unknown): Promise<LiveNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await getNodeByIdTimed(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as unknown as LiveNode
}

export const STATE_OPS: readonly OpDef[] = [
  {
    name: 'node.states',
    summary: 'What changes on a node at hover/press/click/timeout — property deltas by layer path, not generated CSS.',
    agent:
      'Reads BOTH sources the plugin already computes: prototype reactions (ON_HOVER/ON_PRESS/ON_CLICK CHANGE_TO, ' +
      'AFTER_TIMEOUT) and component-set State-variant siblings (`State=Hover`, `State=Active`, the Tabs-chip pattern). ' +
      '`changes[].path` is `""` for the node itself and a `name#dupIndex/…` address for a descendant — do not assume ' +
      'every property in `getCSSAsync` changed, this is already filtered to what actually differs and excludes layout-' +
      'owned properties (position/display/flex algorithm) that a state must never touch. Use this to populate a CMS ' +
      'block\'s hover/press styling instead of hand-diffing two `node.get` calls. A state\'s ' +
      '`transition` carries `easing` (Figma\'s name for it) and `curve` (the same easing as numbers: bezier ' +
      'control points, or a spring\'s damping ratio, stiffness and solved settle time) - animate from `curve`, ' +
      'because the name alone is not something any platform can play.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        required: true,
        description: 'The rest-state node: an instance/frame carrying reactions, or a component-set variant member.',
      },
    },
    async run(params) {
      const node = await resolveLiveNode(params.nodeId)
      const resolve = async (id: string): Promise<LiveNode | null> => (await figma.getNodeByIdAsync(id)) as unknown as LiveNode | null
      return await computeNodeStates(node, resolve)
    },
  },
  {
    name: 'frames.compare',
    summary: 'What differs between two arbitrary frames (e.g. a desktop/mobile pair) — no naming convention required.',
    agent:
      'Give it two frame ids directly (however they are named — "Guides / Desktop" and "Guides / Mobile" work exactly ' +
      'as well as a `<slug>/mobile` pair). `matched[]` is every layer present in both, addressed by the same path a ' +
      'and b share, with `deltas` naming only the properties that actually differ (width/height/padding/gap/fontSize/ ' +
      'order). `onlyInA`/`onlyInB` are layers one side dropped or added; `reordered` is layers that moved among the ' +
      'siblings both frames share. Use this before hand-writing a mobile override — it names the exact delta instead ' +
      'of a visual "looks different".',
    mutates: false,
    params: {
      a: { type: 'string', required: true, description: 'First frame (conventionally the desktop/base frame).' },
      b: { type: 'string', required: true, description: 'Second frame (conventionally the narrower/mobile frame).' },
    },
    async run(params) {
      const a = await resolveLiveNode(params.a)
      const b = await resolveLiveNode(params.b)
      return compareFrames(a, b)
    },
  },
]
