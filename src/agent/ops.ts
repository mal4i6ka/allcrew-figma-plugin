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
import { findAllByTypes, findAllWithCriteria, loadAllPagesAsync, walkSceneNodes } from '../utils/tree.ts'
import { readAllVariables, readLocalVariables, resolveVariableValue } from '../variables.ts'
import { describeColor, type Rgba } from './values.ts'
import { formatHex, parseHex, type Rgb } from '../tokens/color.ts'
import type { OpDef } from './protocol.ts'
import { styledRuns } from '../canvas/text-runs.ts'
import { readEffects } from '../canvas/effect-reader.ts'
import {
  describePaint,
  describeShader,
  imagePlacement,
  type PaintStopSummary,
  type PaintSummary,
  type ShaderPropertySummary,
  type ShaderSummary,
} from './paints.ts'
import { transitionSummary } from '../canvas/link-reader.ts'
import { componentApi } from './component-api.ts'
import { getNodeByIdTimed, isWarm, markWarm, noteLoad, warmPages } from './loading.ts'
import { CONTEXT_OPS } from './context-ops.ts'
import { EXPORT_OPS, EXPORT_PLAN_OPS } from './export-ops.ts'
import { IR_OPS } from './ir-ops.ts'
import { GUIDES } from './guides.ts'
import { SPEC_OPS } from './spec-ops.ts'
import { STATE_OPS } from './state-ops.ts'
import { TRANSITION_OPS } from './transition-ops.ts'
import { TEXT_OPS } from './text-ops.ts'
import { TOKENS_OPS } from './tokens-ops.ts'
import { WRITE_OPS } from './write-ops.ts'
import { PLUGIN_OPS } from './plugin-ops.ts'
import { MODULE_OPS } from './module-ops.ts'
import { COMPONENT_READ_OPS, COMPONENT_WRITE_OPS } from './component-ops.ts'
import { ADMIN_OPS } from './admin-ops.ts'

/* ------------------------------------------------------------- serializers */

export interface ReactionSummary {
  trigger: string
  action: string
  destinationId?: string
  /** The destination's own name, when a resolver could look it up. Absent — not null — when
   * none was given: `summarizeReactions` stays callable with no document at all (a test), and a
   * caller without one gets the id back rather than a name it cannot possibly have found. */
  destinationName?: string
  navigation?: string
  /** NODE actions only: the transition Figma actually plays — duration and easing, not just its
   * name. `null` when the action carries no transition. Reuses `transitionSummary` from
   * `link-reader.ts` so a read and the link a write would recreate from it never disagree. */
  transition?: { type: string; duration: number; easing: unknown } | null
}


/** One effect — shadow, blur, noise, texture, glass, or a shader effect — in the shape
 * `readEffects` produces. Left as `unknown`, matching `readEffects` itself: effects are read
 * once, in `effect-reader.ts`, and modelling the shape a second time here would drift from it. */
export type EffectSummary = unknown

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
  /** Blurs, shadows, noise, texture, glass — opt-in via `effects: true`. Off by default: most
   * callers never touch these, and the array roughly doubles the size of a heavily effected
   * layer. `readEffects` (`effect-reader.ts`) is the one place that knows how to read one. */
  effects?: EffectSummary[]
  /** The paints as they actually are, opt-in via `paints: true`. `bindings` answers "which
   * token is on this field" and says nothing at all about a field with no token — so a layer
   * flagged by `lint.colors` reads back as bare geometry, and the colour that has to be
   * replaced is unobtainable from the very op meant to inspect it. Off by default because most
   * callers want the token, not the pixel. */
  paints?: {
    fills?: PaintSummary[]
    /** The style the fills come from, or null when the layer carries its own. A detached
     * gradient and a styled one look identical stop for stop, so without this there is no way
     * to tell a layer that follows the design system from one that merely resembles it — and
     * the layer's *name* is no guide: a swatch can keep the name of a style it no longer uses. */
    fillStyle?: string | null
    strokes?: PaintSummary[]
    strokeStyle?: string | null
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
      /** The published key, when the token has one. Identity across files: two variables with
       * the same name in two libraries are two variables, and only the key says which. */
      key?: string
      /** True when the token came from another file. A binding onto a remote variable is a
       * live dependency; onto a local one it is not. Reported because the two look identical
       * in Figma and behave completely differently when the upstream library changes. */
      remote?: boolean
      /** Paint fields only: the node reaches this variable through `fills`/`strokes`, but no
       * paint in the stack carries it — a shader paint's settings are bound this way. Keyed
       * `fills[*0]`, `fills[*1]`, … so it can never be mistaken for `fills[0]`. */
      unattributed?: boolean
    }
  >
  /** TEXT only. Truncated to 160 characters unless the call passed `fullText: true` — an agent
   * usually wants the gist, not the copy deck, but a legal disclaimer or a long paragraph is
   * sometimes exactly what is being asked for. */
  text?: string
  /** TEXT only: how many characters `characters` actually holds, reported whether or not `text`
   * was cut — the only way a caller can tell a full paragraph from a truncated one without
   * re-fetching with `fullText: true`. */
  textLength?: number
  /** TEXT only: the text style this run follows, by name. A heading's level (H1/H2/H3/body) is
   * a naming decision the design system made once, in the style; reconstructing it from font
   * size and nesting depth is wrong exactly where the two disagree. `figma.mixed` — several
   * styles across one text range — is reported as such (`id: 'mixed'`) rather than picked for.
   * Absent when the run carries no shared style at all, which is the cue to fall back to a
   * heuristic instead of trusting a name that was never there. */
  textStyle?: { id: string; name: string | null; remote: boolean }
  /** INSTANCE only. `id`/`name` are the VARIANT the instance points at ("Device=Desktop");
   * `setId`/`setName` are the component set that variant lives in — the identity everything else
   * (`components.list`, Code Connect, the design system's own names) is keyed by. A lone
   * component with no variants has no set, and those two fields are then absent. */
  instanceOf?: {
    id: string | null
    name: string | null
    setId?: string
    setName?: string
    properties?: Record<string, unknown>
    /** Figma refused to describe the properties — the instance's set is broken in the file. */
    propertiesError?: string
  }
  reactions?: ReactionSummary[]
  /** Variable modes on this node. `explicit` — pinned right here (Figma's per-collection mode
   * picker; "Auto" leaves the entry out), reported for every node of a read because a pin is a
   * decision and it can sit anywhere: in this file the theme is pinned on the Figma page
   * ("Redesign One" → Light) and frames inherit it, but a section forced to its own mode is a
   * thing designers do. `resolved` — what actually applies, inherited pins included; reported on
   * the root only, since it repeats identically down the whole tree. */
  modes?: { explicit?: VariableModeSummary[]; resolved?: VariableModeSummary[] }
  childCount?: number
  children?: NodeSummary[]
}

export interface VariableModeSummary {
  collectionId: string
  /** Collection name, or null when the collection is not reachable from this file. */
  collection: string | null
  modeId: string
  /** Mode name — `Light`, `Dark`, `Mobile` … — or null when the collection is unreachable. */
  mode: string | null
  /** The collection lives in another file. */
  remote?: boolean
}

/** Figma geometry is float-noisy; two decimals is past anything a layout decision turns on. */
function round2(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined
}

/** Normalizes both reaction shapes: the current `actions[]` array and the legacy single
 * `action`. `resolveDestinationName` looks a NODE action's destination up by id — a call this
 * function has no document to make on its own, so it is asked in; a caller with no document (a
 * test) simply omits it and gets the id back without a name instead of nothing at all. */
export async function summarizeReactions(
  raw: unknown,
  resolveDestinationName?: (id: string) => Promise<string | null>
): Promise<ReactionSummary[]> {
  if (!Array.isArray(raw)) return []
  const out: ReactionSummary[] = []
  for (const reaction of raw) {
    if (!reaction || typeof reaction !== 'object') continue
    const entry = reaction as Record<string, any>
    const trigger = entry.trigger?.type ?? 'UNKNOWN'
    const actions: any[] = Array.isArray(entry.actions) ? entry.actions : entry.action ? [entry.action] : []
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue
      const destinationId = typeof action.destinationId === 'string' ? action.destinationId : undefined
      const destinationName =
        destinationId && resolveDestinationName ? await resolveDestinationName(destinationId) : null
      out.push({
        trigger,
        action: action.type ?? 'UNKNOWN',
        ...(destinationId ? { destinationId } : {}),
        ...(typeof action.navigation === 'string' ? { navigation: action.navigation } : {}),
        ...(destinationName ? { destinationName } : {}),
        // Only a NODE navigation carries a transition at all — reporting `null` on every
        // click/hover/timeout trigger a file has would be noise, not signal.
        ...(action.type === 'NODE' ? { transition: transitionSummary(action.transition ?? null) } : {}),
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

/** Node → summary, minus anything that needs an await (bindings, modes, reactions, main
 * component, text style). Pure. `fullText` skips the 160-character truncation — off by default
 * so a deep read of many text nodes stays small, on when the whole copy is the point. */
export function summarizeNode(node: any, fullText = false): NodeSummary {
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
    summary.textLength = node.characters.length
    summary.text =
      !fullText && node.characters.length > MAX_TEXT ? node.characters.slice(0, MAX_TEXT) + '…' : node.characters
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

/**
 * `UNPUBLISHED` / `CURRENT` / `CHANGED` — what a consumer of this library can actually see.
 * `CHANGED` is the interesting one: the thing exists downstream, but not as it is here, which
 * is invisible in the file and the reason a fix can look applied and not be.
 */
async function publishStatusOf(node: { getPublishStatusAsync(): Promise<PublishStatus> }): Promise<string> {
  try {
    return await node.getPublishStatusAsync()
  } catch (err) {
    return `unknown (${String((err as Error)?.message || err)})`
  }
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
export async function describeBindings(node: any, summary: NodeSummary): Promise<NodeSummary['bindings']> {
  const bound = node.boundVariables
  if (!bound || typeof bound !== 'object') return undefined

  const out: NonNullable<NodeSummary['bindings']> = {}
  for (const [field, entry] of Object.entries(bound as Record<string, any>)) {
    if (field in PAINT_FIELDS) {
      // The binding of a paint is the one the PAINT carries: `boundVariables.color`, and only
      // a SOLID has the field at all. The node-level `boundVariables.fills` is a flat list of
      // every variable the field reaches — nothing in the API says it lines up with `fills`,
      // and on a layer whose stack holds a shader it plainly does not: the aliases there are
      // the shader's own gradient stops. Zipping the two lists named the wrong paint and
      // invented a mismatch on a paint that renders exactly what its token says.
      const paints = Array.isArray(node[field]) ? (node[field] as unknown[]) : []
      const claimed = new Set<string>()
      for (const [index, paint] of paints.entries()) {
        const alias = (paint as { boundVariables?: { color?: { id?: string } } })?.boundVariables?.color
        if (typeof alias?.id !== 'string') continue
        const record = await describePaintBinding(alias, paint)
        if (!record) continue
        out[paints.length > 1 ? `${field}[${index}]` : field] = record
        claimed.add(alias.id)
      }

      // What is left is real — the field does reach these variables — but belongs to no single
      // paint: a shader's settings arrive this way. Reported apart, and marked, so a token
      // census still counts them and nobody reads them as the colour of a layer.
      let spare = 0
      for (const alias of Array.isArray(entry) ? entry : [entry]) {
        const id = (alias as { id?: unknown } | null)?.id
        if (typeof id !== 'string' || claimed.has(id)) continue
        const record = await describePaintBinding(alias, undefined)
        if (!record) continue
        record.unattributed = true
        out[`${field}[*${spare}]`] = record
        spare += 1
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
    if (variable?.key) record.key = variable.key
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
  if (variable?.key) record.key = variable.key
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


/** The style behind a paint field, by name. `figma.mixed` means several styles across a text
 * range — reported as such rather than flattened to one of them. */
async function paintStyleName(node: any, field: 'fillStyleId' | 'strokeStyleId'): Promise<string | null> {
  const id = node[field]
  if (id === figma.mixed) return 'mixed'
  if (typeof id !== 'string' || id === '') return null
  const style = await figma.getStyleByIdAsync(id)
  return style ? style.name : id
}

/**
 * The shader catalogue, fetched at most once per call and only if a shader turns up.
 *
 * `listAvailableShaders()` is a round trip and answers empty on most files, so paying for it
 * on every `node.get` would be a cost with no return. The holder threads one answer through a
 * whole recursion without making every caller know the shader API exists.
 */
export type ShaderCatalogue = { map?: Map<string, Shader> }

export async function shadersFor(catalogue: ShaderCatalogue): Promise<Map<string, Shader>> {
  if (!catalogue.map) {
    const map = new Map<string, Shader>()
    try {
      for (const shader of await figma.listAvailableShaders()) map.set(shader.id, shader)
    } catch {
      /* a sandbox without the shader API: the ids on the paints are then the whole answer */
    }
    catalogue.map = map
  }
  return catalogue.map
}

const hasShader = (paints: unknown): boolean =>
  Array.isArray(paints) && paints.some((paint) => (paint as { type?: string })?.type === 'SHADER')

async function describePaints(
  node: any,
  catalogue: ShaderCatalogue = {}
): Promise<NodeSummary['paints'] | null> {
  const out: NonNullable<NodeSummary['paints']> = {}
  const shaders = hasShader(node.fills) || hasShader(node.strokes) ? await shadersFor(catalogue) : undefined
  if (Array.isArray(node.fills)) {
    out.fills = []
    for (const [index, paint] of node.fills.entries()) out.fills.push(await describePaint(paint, index, shaders))
    out.fillStyle = await paintStyleName(node, 'fillStyleId')
  }
  if (Array.isArray(node.strokes)) {
    out.strokes = []
    for (const [index, paint] of node.strokes.entries()) out.strokes.push(await describePaint(paint, index, shaders))
    out.strokeStyle = await paintStyleName(node, 'strokeStyleId')
  }
  return out.fills || out.strokes ? out : null
}

/** Collection id → collection, shared across one read so a deep walk pays each fetch once.
 * Every node of a page tends to inherit the same handful of collections; a per-node cache would
 * refetch them per node instead. */
type CollectionCache = Map<string, VariableCollection | null>

/** Names for a node's variable modes.
 *
 * `explicit` is what the designer pinned ON THIS NODE — the "force this frame to Dark" switch in
 * the variables picker; `resolved` is what actually applies, pins inherited from ancestors
 * included. They answer different questions, and only `explicit` says "a person decided this
 * here": in this file the theme is pinned on the Figma PAGE ("Redesign One" → Light, "Redesign
 * Business" → Dark) and every frame merely inherits it.
 */
async function describeVariableModes(
  node: any,
  collections: CollectionCache,
  withResolved: boolean
): Promise<NodeSummary['modes'] | null> {
  const explicit: Record<string, string> = node.explicitVariableModes ?? {}
  const resolved: Record<string, string> = withResolved ? (node.resolvedVariableModes ?? {}) : {}
  if (Object.keys(explicit).length === 0 && Object.keys(resolved).length === 0) return null

  const describe = async (collectionId: string, modeId: string): Promise<VariableModeSummary> => {
    if (!collections.has(collectionId)) {
      let collection: VariableCollection | null = null
      try {
        collection = await figma.variables.getVariableCollectionByIdAsync(collectionId)
      } catch {
        /* a collection from a library this file no longer subscribes to — report the ids */
      }
      collections.set(collectionId, collection)
    }
    const collection = collections.get(collectionId) ?? null
    return {
      collectionId,
      collection: collection?.name ?? null,
      modeId,
      mode: collection?.modes.find((mode) => mode.modeId === modeId)?.name ?? null,
      ...(collection?.remote ? { remote: true } : {}),
    }
  }

  const out: NonNullable<NodeSummary['modes']> = {}
  if (Object.keys(explicit).length > 0) {
    out.explicit = []
    for (const [collectionId, modeId] of Object.entries(explicit)) out.explicit.push(await describe(collectionId, modeId))
  }
  if (Object.keys(resolved).length > 0) {
    out.resolved = []
    for (const [collectionId, modeId] of Object.entries(resolved)) out.resolved.push(await describe(collectionId, modeId))
  }
  return out
}
/** Style id → style, shared across one read the same way `CollectionCache` shares collections —
 * most TEXT nodes in a section repeat a handful of styles, and a per-node cache would pay for
 * each one again. */
type StyleCache = Map<string, BaseStyle | null>

/** A TEXT node's style, by name — the signal a consumer needs to tell an H1 from a paragraph
 * without guessing from font size and nesting depth, the same way `paintStyleName` names a fill
 * or stroke style. `figma.mixed` (several styles across one text range) is reported as such
 * (`id: 'mixed'`) rather than flattened to one of them; a run with no style at all reports
 * nothing, which is the caller's cue to fall back to its own heuristic. */
async function describeTextStyle(node: any, styles: StyleCache): Promise<NodeSummary['textStyle'] | undefined> {
  const id = node.textStyleId
  if (id === figma.mixed) return { id: 'mixed', name: null, remote: false }
  if (typeof id !== 'string' || id === '') return undefined
  if (!styles.has(id)) {
    let style: BaseStyle | null = null
    try {
      style = await figma.getStyleByIdAsync(id)
    } catch {
      /* a style from a library this file no longer subscribes to */
    }
    styles.set(id, style)
  }
  const style = styles.get(id) ?? null
  return { id, name: style?.name ?? null, remote: style?.remote === true }
}

/** Full description of one node: `summarizeNode` plus everything that needs an await —
 * bindings, modes, paints, effects, text style, reactions, main component — recursing `depth`
 * levels of children. `paints`/`effects`/`fullText` stay off unless a caller asks; the caches
 * (`catalogue`, `collections`, `styles`, `destinationNames`) are built once by the top-level call
 * and threaded down, so a deep walk pays each fetch once rather than once per node. */
interface DescribeOptions {
  paints?: boolean
  effects?: boolean
  fullText?: boolean
  root?: boolean
  catalogue?: ShaderCatalogue
  collections?: CollectionCache
  styles?: StyleCache
  destinationNames?: Map<string, string | null>
}

async function describeNode(node: any, depth: number, options: DescribeOptions = {}): Promise<NodeSummary> {
  const {
    paints = false,
    effects = false,
    fullText = false,
    root = true,
    catalogue = {},
    collections = new Map(),
    styles = new Map(),
    destinationNames = new Map(),
  } = options
  const summary = summarizeNode(node, fullText)

  const bindings = await describeBindings(node, summary)
  if (bindings) summary.bindings = bindings

  /* A pin is a decision, and it can sit on any node — a section forced to Light inside a dark
   * page is a thing designers do. Reporting `explicit` only for the node the call named hid every
   * such decision below it, and a consumer reading a whole page could not see one at all. The
   * inherited picture (`resolved`) stays on the root: it repeats down the entire tree, and on a
   * page with fifteen subscribed collections it is fifteen rows per node of the same answer. */
  const modes = await describeVariableModes(node, collections, root)
  if (modes) summary.modes = modes

  if (paints) {
    const described = await describePaints(node, catalogue)
    if (described) summary.paints = described
  }

  if (effects) {
    const described = await readEffects(node.effects)
    if (described && described.length > 0) summary.effects = described
  }

  if (node.type === 'TEXT') {
    const textStyle = await describeTextStyle(node, styles)
    if (textStyle) summary.textStyle = textStyle
  }

  if (typeof node.getReactionsAsync === 'function' || Array.isArray(node.reactions)) {
    const raw =
      typeof node.getReactionsAsync === 'function' ? await node.getReactionsAsync() : node.reactions
    // One lookup per destination id, shared across the whole walk — a "Back to top" link
    // repeated on every section of a page would otherwise pay for its name once per section.
    const resolveDestinationName = async (id: string): Promise<string | null> => {
      if (!destinationNames.has(id)) {
        let name: string | null = null
        try {
          const target = await figma.getNodeByIdAsync(id)
          name = target && 'name' in target ? target.name : null
        } catch {
          /* the destination no longer exists, or lives outside what this call can reach */
        }
        destinationNames.set(id, name)
      }
      return destinationNames.get(id) ?? null
    }
    const reactions = await summarizeReactions(raw, resolveDestinationName)
    if (reactions.length > 0) summary.reactions = reactions
  }

  if (node.type === 'INSTANCE') {
    let main: any = null
    try {
      main = typeof node.getMainComponentAsync === 'function' ? await node.getMainComponentAsync() : null
    } catch {
      /* main component lives in an unloaded library — report the instance without it */
    }
    /* `main` is the VARIANT ("Device=Desktop", `823:97861`), and nothing downstream is keyed by a
     * variant: `components.list`, Code Connect mappings and the design system's own vocabulary all
     * name the SET (`Tittle_text`, `823:97862`). Reporting only the variant forces every consumer
     * to make a second call per instance just to learn what it is an instance OF. */
    const set = main?.parent?.type === 'COMPONENT_SET' ? main.parent : null
    /* `componentProperties` is a getter that throws when the instance's set is broken in the file
     * ("Component set for node has existing errors"). One such instance used to abort the whole
     * read: a `node.get` over a page with a single broken set answered nothing at all instead of
     * the other 250 nodes. The instance keeps its identity; only its properties are lost, and the
     * refusal is reported where it happened. */
    let properties: Record<string, unknown> | undefined
    let propertiesError: string | undefined
    try {
      properties = summarizeComponentProperties(node.componentProperties) ?? undefined
    } catch (error) {
      propertiesError = error instanceof Error ? error.message : String(error)
    }
    summary.instanceOf = {
      id: main?.id ?? null,
      name: main?.name ?? null,
      ...(set ? { setId: set.id, setName: set.name } : {}),
      ...(properties ? { properties } : {}),
      ...(propertiesError ? { propertiesError } : {}),
    }
  }

  if (depth > 0 && Array.isArray(node.children)) {
    summary.children = []
    for (const child of node.children) {
      summary.children.push(
        await describeNode(child, depth - 1, {
          paints,
          effects,
          fullText,
          root: false,
          catalogue,
          collections,
          styles,
          destinationNames,
        })
      )
    }
  }

  return summary
}

/* ---------------------------------------------------------------- scoping */

/**
 * What a scan should walk: one subtree, one page, or the whole document. `nodeId` is the
 * sharding escape hatch — a page too big for one bridge call (this file's "-- Main" is 22k
 * nodes) cannot be split by `pageId`, but it can be split by its top-level frames, and the
 * per-shard answers sum exactly like the per-page ones do.
 */
async function resolveWalkRoots(params: Record<string, unknown>): Promise<{ roots: BaseNode[]; labels: string[] }> {
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const found = await getNodeByIdTimed(params.nodeId)
    if (!found || found.type === 'DOCUMENT') throw new Error(`no node with id ${params.nodeId}`)
    if (found.type === 'PAGE') {
      await (found as PageNode).loadAsync()
      return { roots: [found], labels: [found.name] }
    }
    let page: BaseNode | null = found.parent
    while (page && page.type !== 'PAGE') page = page.parent
    if (page) await (page as PageNode).loadAsync()
    return { roots: [found], labels: [`${found.name} (subtree)`] }
  }
  /* An explicit pageId IS the scope. The old contract — pageId honored only next to
   * scope:"page" — turned one forgotten field into a silent document-wide walk, the single
   * most expensive and sandbox-hostile interpretation of the call (a peer session killed the
   * Mobile DS VM with exactly this). Ambiguity resolves toward the cheaper read. */
  if (params.scope === 'page' || (typeof params.pageId === 'string' && params.pageId !== '')) {
    const page = await resolvePage(params.pageId)
    return { roots: [page], labels: [page.name] }
  }
  await loadAllPagesAsync()
  const pages = figma.root.children.slice()
  return { roots: pages, labels: pages.map((one) => one.name) }
}

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

/** `componentPropertyDefinitions` is a getter that THROWS — "Component set has existing errors"
 * on a set Figma cannot resolve, and a different refusal on a variant read outside its parent.
 * A document-wide inventory that lets one broken set through loses every other component with it
 * (observed live: 500 components, zero returned). The failure is reported per component instead,
 * because "this set is broken in the file" is an answer a designer can act on. */
function readPropertyDefinitions(node: ComponentNode | ComponentSetNode): {
  properties?: ComponentPropertyDefinitions
  propertiesError?: string
} {
  try {
    return { properties: node.componentPropertyDefinitions ?? undefined }
  } catch (error) {
    return { propertiesError: error instanceof Error ? error.message : String(error) }
  }
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
        /* `warm` per page, not just the count: under dynamic page loading the first touch of a
         * page is the expensive one, and the only lever a caller has is the ORDER it works in.
         * A map lets it start where the bill is already paid — or call `page.warm` on purpose. */
        pages: figma.root.children.map((page) => ({ id: page.id, name: page.name, warm: isWarm(page.id) })),
        /* How many pages this plugin session has already reached into. Under
         * `documentAccess: "dynamic-page"` the first touch of a page costs tens of seconds on a
         * big file and nothing at all afterwards, so a caller planning a sweep wants to know
         * how much of that bill is already paid - see `loading.ts`. */
        warmPages: warmPages(),
      }
    },
  },

  {
    name: 'page.warm',
    summary: 'Load a page on purpose, and report what that cost — the wait moved to where you asked for it.',
    agent:
      'Under `documentAccess: "dynamic-page"` the FIRST read that touches a page loads it: measured at ~40 s on a ' +
      'heavy page of a real file and milliseconds on every read after. While that load runs, nothing in the plugin ' +
      'sandbox gets a turn — not even the ops\' own budget timers — so a cold page can take a working call past the ' +
      'bridge ceiling and kill it with nothing to show. Call this first and the wait happens under a name that ' +
      'explains it. `document.info` says which pages are already warm.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Page to load. Defaults to the page the designer is on.' },
      nodeId: { type: 'string', description: 'Or name a node, and the page it lives on is loaded.' },
    },
    async run(params) {
      let page: BaseNode | null = null
      if (typeof params.nodeId === 'string' && params.nodeId !== '') {
        let cursor = await getNodeByIdTimed(params.nodeId)
        while (cursor && cursor.type !== 'PAGE') cursor = cursor.parent ?? null
        if (!cursor) throw new Error(`no node with id ${params.nodeId}`)
        page = cursor
      } else if (typeof params.pageId === 'string' && params.pageId !== '') {
        // Deliberately NOT `resolvePage`: that helper loads the page itself, so the load would
        // happen before the clock starts and this op would report a cold page as instant.
        const found = await figma.getNodeByIdAsync(params.pageId)
        if (!found || found.type !== 'PAGE') throw new Error(`no page with id ${params.pageId}`)
        page = found
      } else {
        page = figma.currentPage
      }
      const target = page as PageNode
      const already = isWarm(target.id)
      const started = Date.now()
      await target.loadAsync()
      const ms = Date.now() - started
      markWarm(target.id)
      noteLoad(target.name, ms)
      return {
        page: { id: target.id, name: target.name },
        ms,
        // A page already paid for answers in single digits; saying which case this was stops a
        // caller reading a fast answer as "the file is small".
        alreadyWarm: already,
        warmPages: warmPages(),
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
    summary:
      'One node by id: geometry, auto-layout, text (with its style and full length), instance bindings, effects, reactions, children.',
    agent:
      'bindings answer "which token"; paints: true adds raw colours and per-paint/stop bindings — what acting on a lint finding needs. ' +
      'effects: true adds shadows/blurs/textures the layer actually renders. TEXT nodes always carry textStyle — the design ' +
      "system's own name for the level (H1/H2/H3/body), not a guess from font size — and textLength; fullText: true stops the " +
      '160-character truncation when the whole copy, not the gist, is what is needed. A NODE reaction carries destinationName ' +
      "and the transition's duration/easing, the timing a Smart Animate needs to be reproduced rather than merely named.",
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
      paints: {
        type: 'boolean',
        default: false,
        description:
          'Also report the raw fills and strokes — colour, index and whether each paint is bound. ' +
          'What `bindings` cannot answer: a field with no token is simply absent from it, so an ' +
          'unbound layer reads back as bare geometry. Needed to act on a `lint.colors` finding.',
      },
      effects: {
        type: 'boolean',
        default: false,
        description:
          'Also report shadows, blurs, noise, texture and glass effects. Off by default — most ' +
          'callers never touch these, and the array roughly doubles the size of a heavily effected layer.',
      },
      fullText: {
        type: 'boolean',
        default: false,
        description:
          "Report a TEXT node's whole `characters` instead of truncating at 160. `textLength` is " +
          'reported either way, so a caller can tell whether the text was cut without asking twice.',
      },
    },
    async run(params) {
      const node = await getNodeByIdTimed(params.nodeId as string)
      if (!node) throw new Error(`no node with id ${params.nodeId}`)
      return describeNode(node, params.depth as number, {
        paints: params.paints === true,
        effects: params.effects === true,
        fullText: params.fullText === true,
      })
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
      // A type list lets the native, index-backed search do the walk; without one it has nothing
      // to narrow by, so the hand-rolled DFS (which can filter on name alone) takes over.
      const matches =
        types && types.length > 0
          ? (await findAllByTypes<SceneNode>(root, types)).filter(
              (node) => !needle || node.name.toLowerCase().includes(needle)
            )
          : await findAllWithCriteria(
              root,
              (node): node is SceneNode => !needle || node.name.toLowerCase().includes(needle)
            )
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
    agent:
      'Same shape as `node.get` per selected node: pass effects/fullText for the same reason you ' +
      'would on a `node.get` call — both are off by default here too.',
    mutates: false,
    params: {
      depth: { type: 'number', description: 'Levels of children per selected node.', default: 0, min: 0, max: 5 },
      effects: {
        type: 'boolean',
        default: false,
        description: 'Also report shadows, blurs, noise, texture and glass effects on each selected node.',
      },
      fullText: {
        type: 'boolean',
        default: false,
        description: "Report each TEXT node's whole `characters` instead of truncating at 160.",
      },
    },
    async run(params) {
      const depth = params.depth as number
      const options = { effects: params.effects === true, fullText: params.fullText === true }
      const nodes: NodeSummary[] = []
      for (const node of figma.currentPage.selection) nodes.push(await describeNode(node, depth, options))
      return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, nodes }
    },
  },

  {
    name: 'components.list',
    summary: 'Local components and component sets with their property/variant definitions.',
    agent:
      'Variant property names and values are exact — use them verbatim, with each component\'s own description and links.',
    mutates: false,
    params: {
      scope: { type: 'string', description: 'Where to look.', enum: ['page', 'document'], default: 'document' },
      name: { type: 'string', description: 'Case-insensitive substring of the component name.' },
      limit: { type: 'number', description: 'Max components returned.', default: 100, min: 1, max: 500 },
      publishStatus: {
        type: 'boolean',
        default: false,
        description:
          'Also report UNPUBLISHED / CURRENT / CHANGED per component. One extra call each, so ' +
          'off unless you are asking what consumers of this library can actually see.',
      },
    },
    async run(params) {
      const needle = typeof params.name === 'string' ? params.name.toLowerCase() : null
      const root = await resolveScope(params.scope as string)
      const found = (
        await findAllByTypes<ComponentNode | ComponentSetNode>(root, ['COMPONENT', 'COMPONENT_SET'])
      ).filter((node) => {
        if (needle && !node.name.toLowerCase().includes(needle)) return false
        // A variant inside a set is reachable through its parent — listing both is noise.
        return !(node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET')
      })
      const limit = params.limit as number
      const wantStatus = params.publishStatus === true
      const components = []
      for (const node of found.slice(0, limit)) {
        components.push({
          id: node.id,
          key: node.key,
          name: node.name,
          type: node.type,
          description: node.description || undefined,
          /* Only when it differs from the plain projection: `descriptionMarkdown` normally holds
           * the same words, so echoing both would double every component in the payload for
           * nothing. When they DO differ, the difference is the formatting — which is the half
           * `component.describe` writes and the plain field cannot show. */
          descriptionMarkdown:
            typeof (node as { descriptionMarkdown?: string }).descriptionMarkdown === 'string' &&
            (node as { descriptionMarkdown?: string }).descriptionMarkdown !== node.description
              ? (node as { descriptionMarkdown?: string }).descriptionMarkdown || undefined
              : undefined,
          // Where a team keeps the real documentation. An agent that has it stops guessing the
          // intent from the layer names.
          documentationLinks:
            node.documentationLinks && node.documentationLinks.length > 0
              ? node.documentationLinks.map((link) => link.uri)
              : undefined,
          ...readPropertyDefinitions(node),
          variants:
            node.type === 'COMPONENT_SET'
              ? node.children.map((child) => ({ id: child.id, name: child.name }))
              : undefined,
          ...(wantStatus ? { publishStatus: await publishStatusOf(node) } : {}),
        })
      }
      return { total: found.length, truncated: found.length > limit, components }
    },
  },

  {
    name: 'component.api',
    summary: 'One component set as an API: axes with their options and defaults, and what each option changes.',
    agent:
      'The op for declaring a component in a language. `components.list` gives the signature for every component in ' +
      'the file; this gives one component in full, and the half that was missing: what a variant value actually DOES. ' +
      'Each axis option carries the id of the variant that isolates it (that value, every other axis at its default) ' +
      'and `changes` - the property deltas against the default variant, by layer path, with the TOKEN behind each ' +
      'value where the layer binds one, so a Secondary button is built from `Text/Primary` rather than from #111. ' +
      'A `presence` change is a layer that exists in only one of the two - that is how "this variant has an icon" ' +
      'arrives. Non-variant properties (BOOLEAN/TEXT/INSTANCE_SWAP) cannot be diffed - they act inside every ' +
      'variant - so each reports `targets`: the layers it drives and the field it drives on them (`visible` for a ' +
      'boolean toggle, `characters` for text, `mainComponent` for a swap). Pass the SET id; a member or an instance ' +
      'resolves to its set. `changes: false` skips every diff when you only need the enum.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        required: true,
        description: 'A COMPONENT_SET - or any variant member/instance of one, which resolves to it.',
      },
      changes: {
        type: 'boolean',
        default: true,
        description: 'Diff each isolated variant against the default. Off is the signature alone, and much cheaper.',
      },
      budgetMs: {
        type: 'number',
        default: 60_000,
        min: 5_000,
        max: 170_000,
        description:
          'Stop diffing after this long and answer with the options measured so far. One option is a ' +
          'getCSSAsync walk of two subtrees; a wide set is minutes, and the signature half should not ' +
          'be lost with it.',
      },
    },
    async run(params) {
      const found = await getNodeByIdTimed(params.nodeId as string)
      if (!found) throw new Error(`no node with id ${params.nodeId}`)
      // An agent holding an instance id, or the id of one variant, means the component - and the
      // set is where the definitions live. Resolving beats making the caller walk up.
      let set: BaseNode | null = found
      if (set.type === 'INSTANCE') {
        const main = await (set as InstanceNode).getMainComponentAsync()
        set = main?.parent?.type === 'COMPONENT_SET' ? main.parent : main
      }
      if (set && set.type === 'COMPONENT' && set.parent?.type === 'COMPONENT_SET') set = set.parent
      if (!set || (set.type !== 'COMPONENT_SET' && set.type !== 'COMPONENT')) {
        throw new Error(`${found.type} is not a component, a variant or an instance of one`)
      }
      const { properties, propertiesError } = readPropertyDefinitions(set as ComponentNode | ComponentSetNode)
      return await componentApi(
        set as unknown as Parameters<typeof componentApi>[0],
        properties as Parameters<typeof componentApi>[1],
        propertiesError,
        { changes: params.changes !== false, budgetMs: params.budgetMs as number }
      )
    },
  },

  {
    name: 'styles.list',
    summary: 'Local text, paint, effect and grid styles.',
    agent:
      'paints: true shows per-stop bindings (a gradient binds per stop; its paint-level bound is null however tokenised). consumers: true says whether anything uses a style at all.',
    mutates: false,
    params: {
      paints: {
        type: 'boolean',
        default: false,
        description:
          'Describe each paint of every paint style — colour, and the token it is bound to. For a ' +
          'gradient, every stop with its position. Without this a style reports only its paint ' +
          'types, so "the styles use our tokens" is a guess: a style named after a token can just ' +
          'as easily hold hardcoded hex, and nothing in the answer would say so.',
      },
      consumers: {
        type: 'boolean',
        default: false,
        description:
          'List the layers actually using each style. Answers the question a style inventory ' +
          'otherwise cannot: whether a style is applied anywhere at all. A tidied style nobody ' +
          'consumes and a style the whole product depends on look the same in every other field. ' +
          'One extra document walk per style, so off by default.',
      },
    },
    async run(params) {
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

      /* The same describer `node.get` uses — see describePaint. A style's paints and a layer's
       * paints are the same shape of question, so they get the same answer. */
      const paintDetail = new Map<string, unknown[]>()
      if (params.paints === true) {
        for (const style of paint) {
          const described = []
          for (const [index, one] of style.paints.entries()) described.push(await describePaint(one, index))
          paintDetail.set(style.id, described)
        }
      }

      const consumerDetail = new Map<string, unknown>()
      if (params.consumers === true) {
        for (const style of [...text, ...paint, ...effect, ...grid]) {
          try {
            const users = await style.getStyleConsumersAsync()
            consumerDetail.set(style.id, {
              count: users.length,
              nodes: users.map((user) => ({ id: user.node.id, name: user.node.name, fields: user.fields })),
            })
          } catch (err) {
            consumerDetail.set(style.id, { error: String((err as Error)?.message || err) })
          }
        }
      }

      const withConsumers = <T extends { id: string }>(style: BaseStyle, row: T) =>
        consumerDetail.has(style.id) ? { ...row, consumers: consumerDetail.get(style.id) } : row

      return {
        text: text.map((style) => ({
          ...base(style),
          fontFamily: style.fontName.family,
          fontStyle: style.fontName.style,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        })),
        paint: paint.map((style) =>
          withConsumers(style, {
            ...base(style),
            paints: paintDetail.get(style.id) ?? style.paints.map((one) => one.type),
          })
        ),
        effect: effect.map((style) => ({ ...base(style), effects: style.effects.map((e) => e.type) })),
        grid: grid.map(base),
      }
    },
  },

  {
    name: 'variables.get',
    summary: 'Variable collections, modes and values — the same snapshot the token export reads.',
    agent:
      'resolve: true follows alias chains per mode — a semantic token differs between Light and Dark; never collapse the modes. ' +
      '`library: true` imports every variable of every enabled library one at a time - minutes on a big file. Name a ' +
      '`collection` and only that one is imported; otherwise page it with `budgetMs` and the `nextOffset` it hands back. ' +
      'Either way the call comes back inside its budget instead of dying at the bridge ceiling with nothing.',
    mutates: false,
    params: {
      library: {
        type: 'boolean',
        default: false,
        description:
          'Include variables from enabled libraries. Off by default: that sweep imports every variable ' +
          'of every enabled collection one by one and can take minutes on a large file. With ' +
          '`collection` it imports only that one, and `budgetMs`/`offset` page the rest.',
      },
      collection: {
        type: 'string',
        description:
          'Only this collection, by name or id. With `library: true` the filter runs BEFORE the ' +
          'import sweep, so asking for one palette costs one palette rather than every library.',
      },
      budgetMs: {
        type: 'number',
        default: 60_000,
        min: 5_000,
        max: 170_000,
        description:
          'Library sweeps only. Stop importing after this long and answer with what was read plus ' +
          '`nextOffset` — measured at 48 s for 213 library variables on a good connection and past ' +
          '400 s on a bad one, which is how a token sync dies at the call ceiling with nothing.',
      },
      offset: {
        type: 'number',
        default: 0,
        min: 0,
        description: 'Library sweeps only: resume where a previous call stopped, from its `nextOffset`.',
      },
      limit: { type: 'number', default: 2000, min: 1, max: 20000, description: 'Cap on variables returned.' },
      publishStatus: {
        type: 'boolean',
        default: false,
        description:
          'Also report UNPUBLISHED / CURRENT / CHANGED per variable — whether a change made here ' +
          'has reached the files that consume it. One extra call each, so off by default.',
      },
      resolve: {
        type: 'boolean',
        default: false,
        description:
          'Follow alias chains and add `resolved` per mode — the value the variable actually ' +
          'renders. Semantic collections are mostly aliases onto a primitive ramp, so without ' +
          'this a caller matching a colour to a token has to walk the chains itself.',
      },
    },
    async run(params) {
      /* The collection filter travels INTO the sweep, not just around its result: the cost of
       * `library: true` is the import of every variable of every enabled library, and a caller
       * that named one collection should not pay for the other eight. */
      const snapshot =
        params.library === true
          ? await readAllVariables({
              ...(typeof params.collection === 'string' ? { collection: params.collection } : {}),
              budgetMs: params.budgetMs as number,
              offset: params.offset as number,
            })
          : await readLocalVariables()
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
      const page = variables.slice(0, limit)
      const wantStatus = params.publishStatus === true
      const wantResolved = params.resolve === true
      // What the sweep itself could not finish, alongside what the page cut off: two different
      // kinds of "there is more", and a caller resumes them differently.
      const progress = {
        ...('nextOffset' in snapshot && snapshot.nextOffset !== undefined ? { nextOffset: snapshot.nextOffset } : {}),
        ...('stoppedOn' in snapshot && snapshot.stoppedOn !== undefined ? { stoppedOn: snapshot.stoppedOn } : {}),
      }
      if (!wantStatus && !wantResolved) {
        return { collections, total: variables.length, truncated: variables.length > limit, ...progress, variables: page }
      }
      const modesOf = new Map(collections.map((entry) => [entry.id, entry.modes]))
      const enriched = []
      for (const entry of page) {
        const variable = await figma.variables.getVariableByIdAsync(entry.id)
        const extra: Record<string, unknown> = {}
        if (wantStatus) {
          extra.publishStatus = variable ? await publishStatusOf(variable) : 'unknown (variable not found)'
        }
        if (wantResolved && variable) {
          /* Per mode, because that is the unit a value has: a semantic token is one alias with a
           * different destination in Light and Dark, and collapsing that to one number would be
           * the wrong answer in exactly the case the caller is asking about. A broken or
           * circular chain is reported on the mode it belongs to rather than failing the batch. */
          const resolved: Record<string, unknown> = {}
          for (const mode of modesOf.get(entry.collectionId) ?? []) {
            try {
              resolved[mode.modeId] = await resolveVariableValue(variable, mode.modeId)
            } catch (err) {
              resolved[mode.modeId] = { error: String((err as Error)?.message || err) }
            }
          }
          extra.resolved = resolved
        }
        enriched.push({ ...entry, ...extra })
      }
      return { collections, total: variables.length, truncated: variables.length > limit, ...progress, variables: enriched }
    },
  },

  {
    name: 'instances.external',
    summary: 'Which foreign components are instantiated here, and how many external bindings each drags in.',
    agent:
      'Class B of a migration: bindings inside foreign components have no local main to fix — swap or detach the instances, then rebind.',
    mutates: false,
    params: {
      scope: { type: 'string', default: 'document', enum: ['page', 'document'], description: 'Where to look.' },
      pageId: { type: 'string', description: 'Which page to walk — giving it implies scope: "page". Defaults to the current page when scope is "page".' },
      nodeId: { type: 'string', description: 'Walk just this subtree. Overrides scope and pageId.' },
      limit: { type: 'number', default: 5, min: 0, max: 100, description: 'Sample instances listed per component; counts are complete.' },
    },
    async run(params) {
      /* The other half of the dependency story. `variables.external` counts bindings but cannot
       * say which ones are fixable by a rebind: a binding inside an instance of a FOREIGN
       * component has no local main to fix — the dependency is the component itself, and the
       * only cures are swapping it or detaching it. This op produces that decision table. */
      const tLoad = Date.now()
      const { roots, labels } = await resolveWalkRoots(params)
      const loadMs = Date.now() - tLoad

      const tWalk = Date.now()
      const tops: InstanceNode[] = []
      let visited = 0
      for (const root of roots) {
        const walked = await walkSceneNodes(root, (node, insideInstance) => {
          if (!insideInstance && node.type === 'INSTANCE') tops.push(node as InstanceNode)
        })
        visited += walked.visited
      }

      const groups = new Map<
        string,
        { main: string | null; key: string | null; instances: Array<{ id: string; name: string }>; idCounts: Map<string, number> }
      >()
      for (const instance of tops) {
        let main: ComponentNode | null = null
        try {
          main = await instance.getMainComponentAsync()
        } catch {
          main = null
        }
        /* A local main means every binding below is class A — fixed at the main by a rebind.
         * Only foreign (and unresolvable) mains belong in this table. */
        if (main && !main.remote) continue
        const groupKey = main ? main.key : `unresolved:${instance.name}`
        let group = groups.get(groupKey)
        if (!group) {
          group = { main: main?.name ?? null, key: main?.key ?? null, instances: [], idCounts: new Map() }
          groups.set(groupKey, group)
        }
        group.instances.push({ id: instance.id, name: instance.name })
        await walkSceneNodes(instance, (node) => {
          const holder = node as unknown as Record<string, unknown>
          const push = (id: unknown) => {
            if (typeof id === 'string') group.idCounts.set(id, (group.idCounts.get(id) ?? 0) + 1)
          }
          const bound = holder.boundVariables as Record<string, unknown> | undefined
          if (bound) {
            for (const [field, value] of Object.entries(bound)) {
              if (field === 'fills' || field === 'strokes') continue // the paints loop below owns these
              if (Array.isArray(value)) value.forEach((entry) => push((entry as { id?: string })?.id))
              else push((value as { id?: string })?.id)
            }
          }
          for (const prop of ['fills', 'strokes'] as const) {
            const paints = holder[prop]
            if (!Array.isArray(paints)) continue
            for (const paint of paints as any[]) {
              push(paint?.boundVariables?.color?.id)
              if (Array.isArray(paint?.gradientStops)) {
                for (const stop of paint.gradientStops) push(stop?.boundVariables?.color?.id)
              }
            }
          }
        })
      }
      const walkMs = Date.now() - tWalk

      const tResolve = Date.now()
      const distinct = new Set<string>()
      for (const group of groups.values()) for (const id of group.idCounts.keys()) distinct.add(id)
      const remoteCollection = new Map<string, string>()
      const collectionNames = new Map<string, string>()
      for (const id of distinct) {
        const variable = await figma.variables.getVariableByIdAsync(id)
        if (!variable || !variable.remote) continue
        if (!collectionNames.has(variable.variableCollectionId)) {
          const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
          collectionNames.set(variable.variableCollectionId, collection ? collection.name : variable.variableCollectionId)
        }
        remoteCollection.set(id, collectionNames.get(variable.variableCollectionId) as string)
      }
      const resolveMs = Date.now() - tResolve

      const out = [...groups.values()]
        .map((group) => {
          let bindings = 0
          const collections = new Set<string>()
          for (const [id, count] of group.idCounts) {
            const collection = remoteCollection.get(id)
            if (collection) {
              bindings += count
              collections.add(collection)
            }
          }
          return {
            main: group.main,
            key: group.key,
            instances: group.instances.length,
            externalBindings: bindings,
            collections: [...collections].sort(),
            sample: group.instances.slice(0, params.limit as number),
          }
        })
        .sort((a, b) => b.externalBindings - a.externalBindings)

      return {
        walked: { pages: labels, nodes: visited },
        ms: { load: loadMs, walk: walkMs, resolve: resolveMs },
        foreignComponents: out.length,
        foreignInstances: out.reduce((sum, group) => sum + group.instances, 0),
        groups: out,
      }
    },
  },

  {
    name: 'variables.external',
    summary: 'Which variables this file binds to that it does not own — the dependency a library inherits.',
    agent:
      'The self-containment audit. A collection listed here but absent from enabledLibraryCollections is a dependency with no live subscription — resolvable, never updatable.',
    mutates: false,
    params: {
      scope: {
        type: 'string',
        default: 'document',
        enum: ['page', 'document'],
        description: 'Where to walk. A page-scoped answer cannot say "this file is self-contained".',
      },
      pageId: { type: 'string', description: 'Which page to walk — giving it implies scope: "page". Defaults to the current page when scope is "page".' },
      nodeId: {
        type: 'string',
        description:
          'Walk just this subtree. The sharding escape hatch: a page too big for one call splits ' +
          'by its top-level frames, and the shard answers sum exactly like per-page answers do. ' +
          'Overrides scope and pageId.',
      },
      instances: {
        type: 'string',
        default: 'deep',
        enum: ['deep', 'shallow'],
        description:
          'shallow does not descend into instances. Their sublayers mirror the main component, ' +
          'which a document walk counts where it lives — but an override that adds a NEW binding ' +
          'on a sublayer is missed, so shallow is the fast answer, not the exhaustive one. ' +
          'walked.insideInstances from a deep walk says exactly how much shallow would save.',
      },

      styles: { type: 'boolean', default: true, description: 'Also check local styles for external bindings.' },
      limit: { type: 'number', default: 10, min: 0, max: 200, description: 'Sites listed per variable; counts are complete.' },
    },
    async run(params) {
      /* The question this answers is not "which libraries are enabled" — that is
       * `library.collections`, and it can be empty while the file is still full of external
       * references. A binding to a remote variable survives the library being switched off: it
       * keeps resolving, it just stops being updatable from here. For a file about to become the
       * one everything else depends on, that is the difference between a root and a link in a
       * chain — and nothing in the UI adds it up. */
      /* Two passes on purpose. The first version awaited a variable lookup for every binding of
       * every node; on a 22k-node page that is hundreds of thousands of awaits and it took the
       * plugin's connection down with it. Collecting ids is pure synchronous work, and the number
       * of DISTINCT ids is small — a few dozen — so the resolution that actually costs anything
       * happens once per variable instead of once per reference. */
      const seen = new Map<string, { count: number; sites: unknown[] }>()
      const cap = params.limit as number

      const consider = (id: unknown, site: () => unknown) => {
        if (typeof id !== 'string') return
        let bucket = seen.get(id)
        if (!bucket) {
          bucket = { count: 0, sites: [] }
          seen.set(id, bucket)
        }
        bucket.count += 1
        if (bucket.sites.length < cap) bucket.sites.push(site())
      }

      const scanBoundMap = (bound: unknown, site: (detail: string) => unknown) => {
        if (!bound || typeof bound !== 'object') return
        for (const [field, value] of Object.entries(bound as Record<string, unknown>)) {
          if (field === 'fills' || field === 'strokes') continue // scanPaints owns paints — counting both doubles every paint site
          if (Array.isArray(value)) {
            value.forEach((alias, index) => consider((alias as { id?: string })?.id, () => site(`${field}[${index}]`)))
          } else {
            consider((value as { id?: string })?.id, () => site(field))
          }
        }
      }

      const scanPaints = (paints: unknown, site: (detail: string) => unknown) => {
        if (!Array.isArray(paints)) return
        ;(paints as any[]).forEach((paint, index) => {
          consider(paint?.boundVariables?.color?.id, () => site(`paint[${index}]`))
          if (Array.isArray(paint?.gradientStops)) {
            for (const stop of paint.gradientStops) {
              consider(stop?.boundVariables?.color?.id, () => site(`paint[${index}] stop p${Math.round(stop.position * 100)}`))
            }
          }
        })
      }

      const tLoad = Date.now()
      const { roots, labels } = await resolveWalkRoots(params)
      const loadMs = Date.now() - tLoad

      const tWalk = Date.now()
      let visited = 0
      let insideInstances = 0
      for (const root of roots) {
        const walked = await walkSceneNodes(
          root,
          (node) => {
            const holder = node as unknown as Record<string, unknown>
            const site = (detail: string) => ({ id: node.id, name: node.name, type: node.type, field: detail })
            scanBoundMap(holder.boundVariables, site)
            scanPaints(holder.fills, site)
            scanPaints(holder.strokes, site)
            /* Mixed-fill TEXT: paints are the mixed sentinel, invisible to scanPaints — the
             * segment aliases in boundVariables are the only view of those bindings. */
            const mixedBound = holder.boundVariables as Record<string, unknown> | undefined
            if (mixedBound) {
              for (const prop of ['fills', 'strokes'] as const) {
                if (!Array.isArray(holder[prop]) && Array.isArray(mixedBound[prop])) {
                  ;(mixedBound[prop] as unknown[]).forEach((entry, index) =>
                    consider((entry as { id?: string })?.id, () => site(`${prop}[${index}] (segment)`))
                  )
                }
              }
            }
          },
          { skipInstanceChildren: params.instances === 'shallow' }
        )
        visited += walked.visited
        insideInstances += walked.insideInstances
      }
      const walkMs = Date.now() - tWalk

      if (params.styles !== false) {
        const [text, paint, effect, grid] = await Promise.all([
          figma.getLocalTextStylesAsync(),
          figma.getLocalPaintStylesAsync(),
          figma.getLocalEffectStylesAsync(),
          figma.getLocalGridStylesAsync(),
        ])
        for (const style of paint) {
          const site = (detail: string) => ({ style: style.name, type: 'PAINT', field: detail })
          scanPaints(style.paints, site)
          scanBoundMap((style as unknown as Record<string, unknown>).boundVariables, site)
        }
        for (const style of [...text, ...effect, ...grid]) {
          const site = (detail: string) => ({ style: style.name, type: style.type, field: detail })
          scanBoundMap((style as unknown as Record<string, unknown>).boundVariables, site)
        }
      }

      /* Local aliases pointing OUT are the quietest dependency of the lot: a semantic token of
       * this file whose value is someone else's variable. Nothing on the canvas shows it, and it
       * travels with every component that uses the token. */
      const snapshot = await readLocalVariables()
      for (const entry of snapshot.variables) {
        for (const [modeId, value] of Object.entries(entry.valuesByMode ?? {})) {
          const alias = value as { type?: string; id?: string }
          if (alias?.type === 'VARIABLE_ALIAS' && alias.id) {
            consider(alias.id, () => ({ alias: entry.name, mode: modeId }))
          }
        }
      }

      /* Pass two: one lookup per distinct id. */
      const tResolve = Date.now()
      const collectionNames = new Map<string, string>()
      const collectionModes = new Map<string, ReadonlyArray<{ modeId: string; name: string }>>()
      const found = new Map<
        string,
        { variable: Variable; collection: string; count: number; sites: unknown[]; values: Record<string, unknown> }
      >()
      for (const [id, bucket] of seen) {
        const variable = await figma.variables.getVariableByIdAsync(id)
        if (!variable || !variable.remote) continue
        if (!collectionNames.has(variable.variableCollectionId)) {
          const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
          collectionNames.set(
            variable.variableCollectionId,
            collection ? collection.name : variable.variableCollectionId
          )
          collectionModes.set(variable.variableCollectionId, collection ? collection.modes : [])
        }
        /* Resolved per mode of ITS collection — this is what makes the report a migration input
         * rather than a list of names: a local replacement has to be created with these exact
         * values, or the rebind that follows repaints the file. */
        const values: Record<string, unknown> = {}
        for (const mode of collectionModes.get(variable.variableCollectionId) ?? []) {
          try {
            values[mode.name] = (await resolveVariableValue(variable, mode.modeId)).value
          } catch (err) {
            values[mode.name] = { error: String((err as Error)?.message || err) }
          }
        }
        found.set(id, {
          variable,
          collection: collectionNames.get(variable.variableCollectionId) as string,
          count: bucket.count,
          sites: bucket.sites,
          values,
        })
      }

      const byCollection = new Map<string, { collection: string; variables: unknown[]; bindings: number }>()
      for (const bucket of found.values()) {
        let group = byCollection.get(bucket.collection)
        if (!group) {
          group = { collection: bucket.collection, variables: [], bindings: 0 }
          byCollection.set(bucket.collection, group)
        }
        group.bindings += bucket.count
        group.variables.push({
          token: bucket.variable.name,
          key: bucket.variable.key,
          id: bucket.variable.id,
          type: bucket.variable.resolvedType,
          values: bucket.values,
          bindings: bucket.count,
          sites: bucket.sites,
        })
      }

      const enabled = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync().catch(() => [])
      const groups = [...byCollection.values()].sort((a, b) => b.bindings - a.bindings)
      const resolveMs = Date.now() - tResolve

      return {
        scope: params.scope ?? 'document',
        walked: { pages: labels, nodes: visited, insideInstances },
        ms: { load: loadMs, walk: walkMs, resolve: resolveMs },
        selfContained: groups.length === 0,
        distinctVariablesSeen: seen.size,
        externalCollections: groups.length,
        externalVariables: found.size,
        externalBindings: groups.reduce((sum, group) => sum + group.bindings, 0),
        /* Both halves, because their disagreement is the finding. A collection listed here but
         * absent from `enabledLibraryCollections` is a dependency with no live subscription: the
         * values still resolve and can never be updated from this file again. */
        enabledLibraryCollections: enabled.map((one) => one.name),
        results: groups,
      }
    },
  },

  {
    name: 'variables.usage',
    summary: 'How many things actually use each token — layers, styles and gradient stops, counted.',
    agent:
      'Layers, styles and aliases are counted separately — a token nothing paints may still hold the ramp up via aliases. Zero covers THIS file only.',
    mutates: false,
    params: {
      variables: {
        type: 'string[]',
        description: 'Only these tokens, by id, key or name. Omitted counts every local variable.',
      },
      collection: { type: 'string', description: 'Only tokens from this collection, by name or id.' },
      pageId: {
        type: 'string',
        description:
          'Which page to walk — giving it implies scope: "page". Defaults to the designer\'s page when scope is "page". ' +
          'The way to cover a document too big for one call: walk it page by page and add the ' +
          'counts up, which is exactly as correct and finishes.',
      },
      nodeId: {
        type: 'string',
        description:
          'Walk just this subtree. The sharding escape hatch: a page too big for one call splits ' +
          'by its top-level frames, and the shard answers sum exactly like per-page answers do. ' +
          'Overrides scope and pageId.',
      },
      instances: {
        type: 'string',
        default: 'deep',
        enum: ['deep', 'shallow'],
        description:
          'shallow does not descend into instances. Their sublayers mirror the main component, ' +
          'which a document walk counts where it lives — but an override that adds a NEW binding ' +
          'on a sublayer is missed, so shallow is the fast answer, not the exhaustive one. ' +
          'walked.insideInstances from a deep walk says exactly how much shallow would save.',
      },

      scope: {
        type: 'string',
        default: 'document',
        enum: ['page', 'document'],
        description:
          'Where to walk. Unlike `lint.colors` this defaults to `document`, because a page-scoped ' +
          'usage count answers a question nobody asked: "unused on this page" reads as "unused" and ' +
          'is the one wrong conclusion that gets a token deleted. Beware the cost: a whole document ' +
          'can outrun the bridge call timeout — raise ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS, or pass pageId ' +
          'and sum the pages.',
      },
      styles: {
        type: 'boolean',
        default: true,
        description:
          'Count styles as consumers, not just layers. On by default and it matters: a token bound ' +
          'into a paint style has no layer consumers at all, so a layers-only walk reports it ' +
          'unused while the whole library depends on it.',
      },
      limit: { type: 'number', default: 20, min: 0, max: 500, description: 'Consumers listed per token; counts are always complete.' },
    },
    async run(params) {
      const snapshot = await readLocalVariables()
      const wantedCollection = typeof params.collection === 'string' ? params.collection.toLowerCase() : null
      const collections = wantedCollection
        ? snapshot.collections.filter(
            (entry) => entry.id === params.collection || entry.name.toLowerCase() === wantedCollection
          )
        : snapshot.collections
      const keepCollection = new Set(collections.map((entry) => entry.id))

      const asked = (Array.isArray(params.variables) ? (params.variables as unknown[]) : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      const askedLower = new Set(asked.map((entry) => entry.toLowerCase()))
      const tracked = snapshot.variables.filter(
        (entry) =>
          keepCollection.has(entry.collectionId) &&
          (askedLower.size === 0 ||
            askedLower.has(entry.id.toLowerCase()) ||
            askedLower.has(entry.key.toLowerCase()) ||
            askedLower.has(entry.name.toLowerCase()))
      )
      if (asked.length > 0 && tracked.length === 0) throw new Error(`no local variable matched: ${asked.join(', ')}`)

      const byId = new Map(
        tracked.map((entry) => [
          entry.id,
          {
            entry,
            layers: [] as unknown[],
            styles: [] as unknown[],
            aliases: [] as unknown[],
            layerCount: 0,
            styleCount: 0,
            aliasCount: 0,
          },
        ])
      )
      const note = (id: unknown, where: 'layers' | 'styles' | 'aliases', what: unknown) => {
        if (typeof id !== 'string') return
        const bucket = byId.get(id)
        if (!bucket) return
        if (where === 'layers') bucket.layerCount += 1
        else if (where === 'styles') bucket.styleCount += 1
        else bucket.aliasCount += 1
        const list = bucket[where]
        if (list.length < (params.limit as number)) list.push(what)
      }

      /* A primitive is usually referenced by no layer at all: the semantic token aliases it and
       * the layer binds the semantic one. Counting only layers and styles therefore reports a
       * whole palette ramp as dead — and "unused" is the word that gets a token deleted. So an
       * alias counts as a use, and is counted separately, because it is a different kind of use:
       * a rung nothing aliases and nothing paints is genuinely free, one that a live semantic
       * token points at is load-bearing however few layers name it. */
      for (const entry of snapshot.variables) {
        for (const value of Object.values(entry.valuesByMode ?? {})) {
          const alias = value as { type?: string; id?: string }
          if (alias?.type === 'VARIABLE_ALIAS' && alias.id) {
            note(alias.id, 'aliases', { token: entry.name, collection: entry.collectionId })
          }
        }
      }

      /** Every place a colour binding can hide on one paint: the paint itself, and — for a
       * gradient — each stop separately. A gradient's tokens are never on the paint, which is why
       * a walk that only reads paint-level bindings sees a fully tokenised gradient as raw. */
      const scanPaints = (paints: unknown, where: 'layers' | 'styles', label: (detail: string) => unknown) => {
        if (!Array.isArray(paints)) return
        paints.forEach((paint: any, index: number) => {
          const direct = paint?.boundVariables?.color?.id
          if (direct) note(direct, where, label(`paint[${index}]`))
          if (Array.isArray(paint?.gradientStops)) {
            paint.gradientStops.forEach((stop: any) => {
              const id = stop?.boundVariables?.color?.id
              if (id) note(id, where, label(`paint[${index}] stop p${Math.round(stop.position * 100)}`))
            })
          }
        })
      }

      /** The node-level map: `{ width: alias }` for scalars, `{ fills: [alias, …] }` for paints. */
      const scanBoundMap = (bound: unknown, where: 'layers' | 'styles', label: (detail: string) => unknown) => {
        if (!bound || typeof bound !== 'object') return
        for (const [field, value] of Object.entries(bound as Record<string, unknown>)) {
          /* One binding, two mirrors: a bound paint shows up BOTH as boundVariables.fills[i] and
           * as paint.boundVariables.color. Counting both doubled every paint site this op ever
           * reported. scanPaints owns paints — including the instance-sublayer case where the
           * node-level map is empty and the paint view is the only one. */
          if (field === 'fills' || field === 'strokes') continue
          if (Array.isArray(value)) {
            value.forEach((alias: any, index: number) => note(alias?.id, where, label(`${field}[${index}]`)))
          } else {
            note((value as { id?: string })?.id, where, label(field))
          }
        }
      }

      const tLoad = Date.now()
      const { roots, labels } = await resolveWalkRoots(params)
      const loadMs = Date.now() - tLoad

      const tWalk = Date.now()
      let visited = 0
      let insideInstances = 0
      for (const root of roots) {
        const walked = await walkSceneNodes(
          root,
          (node) => {
            const holder = node as unknown as Record<string, unknown>
            const label = (detail: string) => ({ id: node.id, name: node.name, type: node.type, field: detail })
            scanBoundMap(holder.boundVariables, 'layers', label)
            /* Paint-level and stop-level bindings sit outside `boundVariables`, so they have to be
             * read separately — and on an instance sublayer they are the ONLY place the inherited
             * binding shows up. */
            scanPaints(holder.fills, 'layers', label)
            scanPaints(holder.strokes, 'layers', label)
            /* Mixed-fill TEXT is the one case the paint pass cannot see (node.fills is the mixed
             * sentinel, not an array) — there the per-segment aliases in boundVariables are the
             * only view, and skipping them wholesale blinded the audit to bound text colours. */
            const mixedBound = holder.boundVariables as Record<string, unknown> | undefined
            if (mixedBound) {
              for (const prop of ['fills', 'strokes'] as const) {
                if (!Array.isArray(holder[prop]) && Array.isArray(mixedBound[prop])) {
                  ;(mixedBound[prop] as unknown[]).forEach((entry, index) =>
                    note((entry as { id?: string })?.id, 'layers', label(`${prop}[${index}] (segment)`))
                  )
                }
              }
            }
          },
          { skipInstanceChildren: params.instances === 'shallow' }
        )
        visited += walked.visited
        insideInstances += walked.insideInstances
      }
      const walkMs = Date.now() - tWalk

      let styleCount = 0
      if (params.styles !== false) {
        const [text, paint, effect, grid] = await Promise.all([
          figma.getLocalTextStylesAsync(),
          figma.getLocalPaintStylesAsync(),
          figma.getLocalEffectStylesAsync(),
          figma.getLocalGridStylesAsync(),
        ])
        styleCount = text.length + paint.length + effect.length + grid.length
        for (const style of paint) {
          const label = (detail: string) => ({ style: style.name, type: 'PAINT', field: detail })
          scanPaints(style.paints, 'styles', label)
          scanBoundMap((style as unknown as Record<string, unknown>).boundVariables, 'styles', label)
        }
        for (const style of [...text, ...effect, ...grid]) {
          const label = (detail: string) => ({ style: style.name, type: style.type, field: detail })
          scanBoundMap((style as unknown as Record<string, unknown>).boundVariables, 'styles', label)
          scanPaints((style as unknown as Record<string, unknown>).effects, 'styles', label)
        }
      }

      const results = [...byId.values()]
        .map((bucket) => ({
          token: bucket.entry.name,
          collection: collections.find((one) => one.id === bucket.entry.collectionId)?.name ?? bucket.entry.collectionId,
          key: bucket.entry.key,
          /* Deliberately NOT layers + styles + aliases. A layer wearing a style carries that
           * style's bindings, so it is counted as a layer AND the style is counted — the two are
           * one reference seen twice, and adding them up would inflate every styled token. What
           * the caller almost always wants is the yes/no below. */
          used: bucket.layerCount + bucket.styleCount + bucket.aliasCount > 0,
          /** Rendered occurrences. A component and each of its instances count separately, which
           * is the honest answer to "how much of the file would change" and the wrong one for
           * "how many places would I have to edit". */
          layers: bucket.layerCount,
          styles: bucket.styleCount,
          /** Other variables pointing at this one. */
          aliases: bucket.aliasCount,
          ...(bucket.layers.length > 0 ? { usedByLayers: bucket.layers } : {}),
          ...(bucket.styles.length > 0 ? { usedByStyles: bucket.styles } : {}),
          ...(bucket.aliases.length > 0 ? { aliasedBy: bucket.aliases } : {}),
        }))
        .sort(
          (a, b) =>
            b.layers + b.styles + b.aliases - (a.layers + a.styles + a.aliases) || a.token.localeCompare(b.token)
        )

      return {
        scope: params.scope ?? 'document',
        // Named, so a page-by-page sweep can be added up without the caller having to remember
        // which slice each answer covered.
        walked: { pages: labels, nodes: visited, insideInstances, styles: styleCount },
        ms: { load: loadMs, walk: walkMs },
        tokens: results.length,
        unused: results.filter((row) => !row.used).length,
        /* Said out loud because the number invites the wrong conclusion. Zero here means "nothing
         * in THIS file", and no Plugin API call can widen that: variables have no consumer
         * enumeration at all, and even styles' `getStyleConsumersAsync` stops at the file edge. A
         * published token read as unused is the deletion nobody meant to make. */
        caveat: 'counts cover this file only — a token consumed by another file reports zero here',
        results,
      }
    },
  },

  {
    name: 'variables.match',
    summary: 'Which token is this colour — exactly, or nearest, and whether the answer is ambiguous.',
    agent:
      'ambiguous: true means one colour is several tokens — choosing between them is a decision about meaning, never automatable.',
    mutates: false,
    params: {
      colors: {
        type: 'string[]',
        required: true,
        description: 'Hex colours to look up, e.g. ["#191919", "#FB5B0A"]. Alpha is ignored.',
      },
      collection: { type: 'string', description: 'Only match against this collection. Omitted searches them all.' },
      nearest: {
        type: 'number',
        default: 3,
        min: 0,
        max: 20,
        description: 'How many near misses to return per colour when there is no exact match. 0 for none.',
      },
    },
    async run(params) {
      const wanted = (Array.isArray(params.colors) ? (params.colors as unknown[]) : [])
        .filter((entry): entry is string => typeof entry === 'string')
      if (wanted.length === 0) throw new Error('"colors" must be a non-empty array of hex strings')

      const snapshot = await readLocalVariables()
      const filter = typeof params.collection === 'string' ? params.collection.toLowerCase() : null
      const collections = filter
        ? snapshot.collections.filter((entry) => entry.id === params.collection || entry.name.toLowerCase() === filter)
        : snapshot.collections
      const modesOf = new Map(collections.map((entry) => [entry.id, entry]))

      /* Every token, resolved per mode, flattened to one list. A semantic token is an alias with
       * a different destination in each mode, so it belongs here once per mode — the same colour
       * can be `content/primary` in Light and something unrelated in Dark. */
      const rungs: Array<{ token: string; collection: string; mode: string; hex: string; rgb: Rgb; alpha: number }> = []
      for (const entry of snapshot.variables) {
        if (entry.resolvedType !== 'COLOR') continue
        const owner = modesOf.get(entry.collectionId)
        if (!owner) continue
        const variable = await figma.variables.getVariableByIdAsync(entry.id)
        if (!variable) continue
        for (const mode of owner.modes) {
          try {
            const resolved = await resolveVariableValue(variable, mode.modeId)
            const value = resolved.value as { r?: number; g?: number; b?: number; a?: number } | undefined
            if (!value || typeof value.r !== 'number') continue
            const rgb = { r: value.r, g: value.g!, b: value.b! }
            const alpha = typeof value.a === 'number' ? value.a : 1
            rungs.push({ token: entry.name, collection: owner.name, mode: mode.name, hex: formatHex(rgb), rgb, alpha })
          } catch {
            /* a broken or circular chain is not a match — skip the mode, keep the sweep */
          }
        }
      }

      const distance = (a: Rgb, b: Rgb) =>
        Math.sqrt(((a.r - b.r) * 255) ** 2 + ((a.g - b.g) * 255) ** 2 + ((a.b - b.b) * 255) ** 2)

      /* Alpha is part of the identity, not a detail. An alpha ramp — `alpha/orange/10 … /72`, or
       * the tail of a gradient fading `#FB5B0A` to nothing — is one RGB triple at a dozen
       * opacities, so matching on RGB alone reports every rung as an exact hit and buries the one
       * that is actually the layer's colour. Input alpha may be given as a trailing byte
       * (`#FB5B0A40`); omitted means opaque. */
      const withAlpha = (value: string) => {
        const raw = value.trim().replace(/^#/, '')
        const rgb = parseHex(raw.length === 8 ? raw.slice(0, 6) : raw)
        if (!rgb) return null
        const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1
        return { rgb, alpha }
      }
      const sameAlpha = (a: number, b: number) => Math.abs(a - b) < 0.004

      const results = wanted.map((input) => {
        const parsed = withAlpha(input)
        if (!parsed) return { color: input, error: 'not a hex colour' }
        const { rgb, alpha } = parsed
        const hex = formatHex(rgb)
        const exact = rungs.filter((rung) => rung.hex === hex && sameAlpha(rung.alpha, alpha))
        const seen = new Set(exact.map((rung) => rung.token))
        const near = rungs
          .filter((rung) => !(rung.hex === hex && sameAlpha(rung.alpha, alpha)))
          .map((rung) => ({ ...rung, delta: distance(rgb, rung.rgb) }))
          .sort((a, b) => a.delta - b.delta)
          .slice(0, params.nearest as number)
        const show = ({ token, collection, mode, alpha: at }: { token: string; collection: string; mode: string; alpha: number }) => ({
          token,
          collection,
          mode,
          ...(at < 0.999 ? { alpha: Math.round(at * 1000) / 1000 } : {}),
        })
        return {
          color: alpha < 0.999 ? `${hex} ${Math.round(alpha * 100)}%` : hex,
          exact: exact.map(show),
          /* The flag that stops a caller automating this. A colour does not determine a token:
           * one hex is routinely `accent/primary` AND `action/primary/background`, and picking
           * between them is a decision about meaning that no distance can make. Say so, rather
           * than returning the first and letting it look settled. */
          ambiguous: seen.size > 1,
          ...(exact.length === 0
            ? { nearest: near.map((rung) => ({ ...show(rung), hex: rung.hex, delta: Math.round(rung.delta * 100) / 100 })) }
            : {}),
        }
      })

      return { searched: rungs.length, collections: collections.map((entry) => entry.name), results }
    },
  },

  {
    name: 'flow.map',
    summary: 'Prototype graph of a page: starting points plus every reaction edge, with the timing on each.',
    agent:
      'Read before proposing navigation: extend the existing prototype instead of inventing a parallel one. ' +
      'An edge carries the navigation kind and the transition it animates with - duration, the easing Figma ' +
      'named, and `curve`: the same easing as numbers (bezier control points, or a spring\'s damping ratio, ' +
      'stiffness and solved settle time). Build the transition from `curve`, not from the CSS string beside ' +
      'it - `PUSH` from the right at 300ms is a native navigation transition, and the numbers for it are here.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Page id. Defaults to the page the designer is on.' },
    },
    async run(params) {
      const page = await resolvePage(params.pageId)
      const named = new Map<string, string>()
      for (const node of page.children) named.set(node.id, node.name)

      /* An edge used to be five strings. The navigation KIND and the transition were already
       * computed by `summarizeReactions` below and dropped on the floor - and they are the half a
       * build needs: "PUSH from the RIGHT, 0.3s, EASE_OUT" is a SwiftUI `NavigationTransition` or
       * a Compose `AnimatedContentTransitionScope`, while "ON_HOVER → that node" is only a graph. */
      const edges: Array<{
        from: string
        fromName: string
        to: string
        toName: string | null
        trigger: string
        action: string
        navigation?: string
        transition?: unknown
      }> = []
      const withReactions = await findAllWithCriteria(
        page,
        (node): node is SceneNode => 'reactions' in node || 'getReactionsAsync' in node
      )
      for (const node of withReactions) {
        const anyNode = node as any
        const raw =
          typeof anyNode.getReactionsAsync === 'function' ? await anyNode.getReactionsAsync() : anyNode.reactions
        for (const reaction of await summarizeReactions(raw, async (id) => named.get(id) ?? null)) {
          if (!reaction.destinationId) continue
          edges.push({
            from: node.id,
            fromName: node.name,
            to: reaction.destinationId,
            toName: named.get(reaction.destinationId) ?? null,
            trigger: reaction.trigger,
            action: reaction.action,
            ...(reaction.navigation ? { navigation: reaction.navigation } : {}),
            ...(reaction.transition ? { transition: reaction.transition } : {}),
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
    agent:
      'Every variable here is a separate round trip to Figma\'s team-library service: measured at ' +
      '48 s for 213 of them on a good afternoon and past 400 s on a bad one, which is how a token ' +
      'sync ends up failing at the call ceiling with nothing to show. So this pages: it answers ' +
      'inside `budgetMs` with what it read and hands back `nextOffset` — pass it to continue. ' +
      '`values: false` skips the imports entirely and answers in a second when names and types ' +
      'are all you need, and `resolve: true` follows the alias chains a theme collection is made of.',
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
      resolve: {
        type: 'boolean',
        default: false,
        description:
          'Follow alias chains and add `resolved` per mode — the same option `variables.get` has. ' +
          'A theme collection is mostly aliases onto a primitive ramp, so without this a caller ' +
          'reading a library palette gets `{type: "VARIABLE_ALIAS", id}` where it asked for a colour.',
      },
      limit: { type: 'number', default: 200, min: 1, max: 2000, description: 'Cap on variables returned in one call.' },
      offset: {
        type: 'number',
        default: 0,
        min: 0,
        description: 'Where to resume — the `nextOffset` a previous call handed back.',
      },
      budgetMs: {
        type: 'number',
        default: 60_000,
        min: 5_000,
        max: 170_000,
        description:
          'Stop importing after this long and answer with what was read. Each variable is a ' +
          'separate round trip to the team-library service, and a big collection can outrun any ' +
          'call ceiling — a partial answer with `nextOffset` beats a call that dies with nothing.',
      },
    },
    async run(params) {
      const key = params.collectionKey as string
      const entries = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(key)
      const offset = Math.min(Number(params.offset) || 0, entries.length)
      const capped = entries.slice(offset, offset + (params.limit as number))
      if (params.values === false) {
        // Names and types come from the collection listing itself — no imports, no budget to
        // run out of, which is why this path answers in a second on a collection that takes
        // minutes to read in full.
        const done = offset + capped.length
        return {
          collectionKey: key,
          total: entries.length,
          offset,
          ...(done < entries.length ? { nextOffset: done } : {}),
          variables: capped.map((entry) => ({ key: entry.key, name: entry.name, resolvedType: entry.resolvedType })),
        }
      }

      const variables: Array<Record<string, unknown>> = []
      let modes: Array<{ modeId: string; name: string }> = []
      let collectionName: string | null = null
      /* Measured on a real file: one library variable is one round trip to Figma's team-library
       * service, and 213 of them took 48 seconds on a good afternoon and over 400 on a bad one.
       * Whatever the ceiling of the day is, the call must come back inside it with what it read
       * and say where to resume — the same contract `assets.export` already keeps. */
      const deadline = Date.now() + (params.budgetMs as number)
      let read = 0
      let ranOut = false
      for (const entry of capped) {
        if (Date.now() > deadline) {
          ranOut = true
          break
        }
        read += 1
        try {
          const imported = await figma.variables.importVariableByKeyAsync(entry.key)
          if (modes.length === 0) {
            const collection = await figma.variables.getVariableCollectionByIdAsync(imported.variableCollectionId)
            if (collection) {
              collectionName = collection.name
              modes = collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
            }
          }
          const resolved: Record<string, unknown> = {}
          if (params.resolve === true) {
            // Per mode, for the same reason `variables.get` does it that way: one alias points
            // somewhere different in Light and Dark, and one number would be the wrong answer in
            // exactly the case the caller is asking about.
            for (const mode of modes) {
              try {
                resolved[mode.modeId] = await resolveVariableValue(imported, mode.modeId)
              } catch (err) {
                resolved[mode.modeId] = { error: String((err as Error)?.message || err) }
              }
            }
          }
          variables.push({
            key: imported.key,
            id: imported.id,
            name: imported.name,
            resolvedType: imported.resolvedType,
            valuesByMode: imported.valuesByMode,
            ...(params.resolve === true ? { resolved } : {}),
          })
        } catch (err) {
          variables.push({ key: entry.key, name: entry.name, error: String((err as Error)?.message || err) })
        }
      }
      const done = offset + read
      return {
        collectionKey: key,
        collectionName,
        modes,
        total: entries.length,
        offset,
        ...(done < entries.length ? { nextOffset: done } : {}),
        ...(ranOut ? { stoppedOn: 'budgetMs' } : {}),
        variables,
      }
    },
  },

  {
    name: 'lint.colors',
    summary: 'Layers painted with a raw colour instead of a variable — exactly what a recolor cannot reach.',
    agent:
      'Findings carry value and paintIndex — node.bind\'s exact arguments. ignore takes brand hexes out of the debt count, and the report names them back.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'Which page to walk — giving it implies scope: "page". Defaults to the current page when scope is "page".' },
      scope: {
        type: 'string',
        default: 'page',
        enum: ['page', 'document'],
        description: 'Where to look. `document` walks every page and is slow on a big file.',
      },
      limit: { type: 'number', default: 300, min: 1, max: 5000, description: 'Cap on findings returned.' },
      ignore: {
        type: 'string[]',
        description:
          'Colours to leave alone, as hex. For values that are deliberately outside the design ' +
          'system — payment-scheme brand colours, a partner logo — which cannot be tokenised and ' +
          'should not be counted as debt. Without this the totals stay permanently non-zero and ' +
          'stop working as a health number. Case-insensitive; alpha is ignored.',
      },
    },
    async run(params) {
      /* Compared on the six hex digits only. A brand colour is that colour whether or not the
       * layer carrying it happens to sit at 40% — matching alpha too would let one stray opacity
       * put the finding back, which is exactly the noise this is here to remove. */
      const ignored = new Set(
        (Array.isArray(params.ignore) ? (params.ignore as unknown[]) : [])
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim().replace(/^#/, '').slice(0, 6).toLowerCase())
      )
      /* Same contract as resolveWalkRoots: an explicit pageId IS the scope, even beside
       * scope:"document" — a declared param that gets silently ignored is how one stray field
       * used to buy the most expensive walk in the file. */
      const wantsPage = typeof params.pageId === 'string' && params.pageId !== ''
      const pages: PageNode[] =
        params.scope === 'document' && !wantsPage
          ? (await loadAllPagesAsync(), figma.root.children.slice())
          : [await resolvePage(params.pageId)]

      const findings: Array<LintFinding & { page: string }> = []
      for (const page of pages) {
        const roots = page.children.filter((node): node is SceneNode => 'visible' in node)
        for (const finding of await lintScopeAsync(roots)) {
          if (finding.rule !== 'unbound-fill' && finding.rule !== 'unbound-stroke') continue
          if (
            ignored.size > 0 &&
            typeof finding.value === 'string' &&
            ignored.has(finding.value.replace(/^#/, '').slice(0, 6).toLowerCase())
          ) {
            continue
          }
          findings.push({ ...finding, page: page.name })
        }
      }

      const byRule: Record<string, number> = {}
      for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1
      return {
        // The scope that actually ran, not the one passed — pageId may have narrowed it.
        scope: wantsPage ? 'page' : params.scope,
        pages: pages.map((page) => page.name),
        total: findings.length,
        byRule,
        // Named back, so a total that dropped is explained by the answer itself rather than by
        // remembering what was passed in. A filter nobody can see is a filter that misleads.
        ...(ignored.size > 0 ? { ignored: [...ignored].map((hex) => `#${hex}`) } : {}),
        findings: findings.slice(0, params.limit as number),
      }
    },
  },

  {
    name: 'text.segments',
    summary: 'The styled runs of one TEXT node — ranges, characters, and per-run variable bindings.',
    agent:
      'The X-ray for a binding no write seems to reach: shows which styled run owns it — or that none does.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'A TEXT node id.' },
    },
    async run(params) {
      const found = await figma.getNodeByIdAsync(params.nodeId as string)
      if (!found || found.type !== 'TEXT') throw new Error(`${found ? found.type : 'nothing'} — need a TEXT node`)
      const text = found as TextNode
      /* Exists because three write strategies in a row "succeeded" against one invisible run and
       * the re-read said otherwise — guessing at run structure from outside cost more than one
       * read op. Newlines are escaped so a paragraph mark is visible instead of being one. */
      const raw = (text.getStyledTextSegments(['boundVariables', 'fills']) as unknown as Array<{
        start: number
        end: number
        characters: string
        boundVariables?: Record<string, unknown>
        fills?: Paint[]
      }>)
      // The bindings this op exists for, and beside them the STYLE of each run in the words the
      // write vocabulary takes — asking for two of the twenty-six fields answered "uniform" for
      // every text that was not.
      const styles = await styledRuns(text)
      const segments = raw.map((segment) => ({
        start: segment.start,
        end: segment.end,
        characters: segment.characters.replace(/\n/g, '\\n'),
        boundVariables: segment.boundVariables ?? {},
        fills: (segment.fills ?? []).map((paint) => ({
          type: paint.type,
          bound:
            (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? null,
        })),
      }))
      return {
        node: { id: text.id, name: text.name },
        length: text.characters.length,
        characters: text.characters.replace(/\n/g, '\\n'),
        nodeBound: (text as unknown as { boundVariables?: Record<string, unknown> }).boundVariables ?? {},
        segments,
        // Sendable as it stands: this is `runs` in the shape NODE_SET takes.
        runs: styles,
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

  {
    name: 'guide.list',
    summary: 'Playbooks: named tasks with the ops they take, in order. Start here on an unfamiliar file.',
    agent:
      'The manifest says what each op does; a playbook says which five to call and in what order to get a screen ' +
      'built, a design system extracted, motion implemented or a build checked against the file. Read this first ' +
      'and guide.get the one that matches the task — it is cheaper than discovering the sequence by trial.',
    mutates: false,
    params: {},
    async run() {
      return GUIDES.map((guide) => ({
        id: guide.id,
        title: guide.title,
        goal: guide.goal,
        when: guide.when,
        steps: guide.steps.length,
      }))
    },
  },

  {
    name: 'guide.get',
    summary: 'One playbook in full — its steps, example params, what to check, and what each op it names does.',
    agent:
      'Serves the op summaries and guidance alongside the steps, so a playbook is one call rather than one plus five ' +
      'lookups. `why` on a step is about sequencing; what the op itself does comes from the op.',
    mutates: false,
    params: {
      id: { type: 'string', required: true, description: 'Playbook id from guide.list, e.g. screen.build.' },
    },
    async run(params) {
      const guide = GUIDES.find((entry) => entry.id === params.id)
      if (!guide) {
        throw new Error(`no playbook "${params.id}" — guide.list names them: ${GUIDES.map((g) => g.id).join(', ')}`)
      }
      return {
        ...guide,
        steps: guide.steps.map((step) => {
          const op = OPS_BY_NAME.get(step.op)
          return {
            ...step,
            // A playbook that names a renamed op is caught by test; this is the runtime half of
            // the same promise — the agent sees which step lost its op rather than a silent gap.
            ...(op
              ? { summary: op.summary, mutates: op.mutates, ...(op.agent ? { agent: op.agent } : {}) }
              : { missing: true }),
          }
        }),
      }
    },
  },
]

// `PLUGIN_OPS` last, and deliberately not folded into either half: it is the doorway onto the
// plugin's own command surface, which contains reads and writes both, and decides which gate
// it needs per call rather than per op.
export const ALL_OPS: readonly OpDef[] = [
  ...READ_OPS,
  ...COMPONENT_READ_OPS,
  ...CONTEXT_OPS,
  ...EXPORT_OPS,
  ...TEXT_OPS,
  ...EXPORT_PLAN_OPS,
  ...TOKENS_OPS,
  ...IR_OPS,
  ...SPEC_OPS,
  ...STATE_OPS,
  ...TRANSITION_OPS,
  ...COMPONENT_WRITE_OPS,
  ...ADMIN_OPS,
  ...WRITE_OPS,
  ...MODULE_OPS,
  ...PLUGIN_OPS,
]

export const OPS_BY_NAME: ReadonlyMap<string, OpDef> = new Map(ALL_OPS.map((op) => [op.name, op]))
