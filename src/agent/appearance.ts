/**
 * Agent listener — what a layer LOOKS like, in nobody's language.
 *
 * `design.ir` hands over structure: stacks, sizing, text, interactions. It has never carried a
 * colour. The reason is honest and, for the web, correct — the CSS emitter reads paint, strokes,
 * radii, shadows, opacity and rotation off the live Figma node at emit time (`css-emitter.ts`
 * `getCSSAsync`), so putting them in the tree would be dead weight on the only path that ships
 * today.
 *
 * It is not correct for anything else. A SwiftUI or Compose generator runs after the plugin
 * window has closed; it cannot re-read the node. The plugin's own documentation already made this
 * argument for typography ("a web target can afford reading the live node and a SwiftUI one
 * cannot") and acted on it for exactly that one property family. This is the rest of them.
 *
 * Two rules the shape follows:
 *
 * 1. **Token first, literal beside it.** Every value is `{ token?, value }`. A generator that
 *    finds a token emits `Tokens.spacingMd` and never looks at the number; one that finds none
 *    has the number and knows it is looking at a hard-coded value — which is itself the answer a
 *    linting build wants. `#F2F4F5` alone leaves a consumer guessing which variable to reach for.
 * 2. **Roles, not CSS properties.** `bound-tokens.ts` maps Figma's fields onto CSS property
 *    names, which is right for diffing a stylesheet and wrong as a platform-neutral contract:
 *    `border-width` means nothing to Compose. The field names here are Figma's own, which every
 *    target has to map anyway, and which round-trip back through `node.bind`.
 *
 * Nothing here is filled on the export path. `serializeNode` leaves `appearance` absent and the
 * Django/React emitters never read it; only `annotateAppearance`, called from `design.ir` when the
 * caller asks for it, populates the field. So the web output is byte-identical with this file in
 * the build, and the payload is only paid for by the consumer that needs it.
 */

import { describePaint, type PaintSummary } from './paints.ts'
import { readEffects } from '../canvas/effect-reader.ts'
import { typeStyleOf, type TypeStyle } from './ir-mobile.ts'
import type { IrNode } from '../targets/django/ir.ts'

/* -------------------------------------------------------------------- shapes */

/** A number the design system may or may not have a name for. `token` absent is not a defect —
 * it is a literal, and saying so is the point. */
export interface IrValue {
  /** The variable's full Figma name (`spacing/md`), never the CSS mangling of it. */
  token?: string
  value: number
}

/** Per-corner and per-side values, each independently bindable in Figma. */
export interface IrCorners {
  topLeft: IrValue
  topRight: IrValue
  bottomRight: IrValue
  bottomLeft: IrValue
}

export interface IrSides {
  top: IrValue
  right: IrValue
  bottom: IrValue
  left: IrValue
}

export interface IrAppearance {
  /** Bottom-to-top, the same order and the same shape `paints.stack` reports — a layer painted
   * with three fills is a stack, and a reading that keeps only the top one is a different
   * picture. Absent when the layer has no fills at all; `[]` when it explicitly has none, which
   * on an instance is a designer's decision rather than an absence. */
  fills?: readonly PaintSummary[]
  strokes?: readonly PaintSummary[]
  /** One number when every side agrees, four when they do not. Figma binds each side
   * separately, so a uniform weight with one bound side is still four values. */
  strokeWeight?: IrValue | IrSides
  strokeAlign?: string
  dashPattern?: readonly number[]
  strokeCap?: string
  strokeJoin?: string
  /** One radius when every corner agrees, four when they do not. */
  radius?: IrValue | IrCorners
  /** Figma's squircle factor, 0..1. Absent when 0 — a plain rounded corner. */
  cornerSmoothing?: number
  /** Shadows, blurs, noise, texture, glass and shader effects, in `readEffects`' shape. Left as
   * `unknown[]` for the same reason `EffectSummary` is: effects are read in one place. */
  effects?: readonly unknown[]
  /** Layer opacity, distinct from a paint's own. Absent when 1. */
  opacity?: IrValue
  /** Absent when NORMAL. */
  blendMode?: string
  /** Degrees, counter-clockwise, as Figma reports it. Absent when 0. */
  rotation?: number
  /** This layer masks its siblings. `type` is ALPHA, VECTOR, LUMINANCE or a future one. */
  mask?: { type: string }
  /** Token names on the numbers the layout already carries. The layout itself is in the tree as
   * plain pixels — correct, since a generator needs the number — but a build that wants to emit
   * `Tokens.spacingMd` instead of `16.dp` has nowhere to read that from. Keyed by Figma's own
   * field name (`itemSpacing`, `paddingLeft`, `width`, …). */
  layoutTokens?: Readonly<Record<string, string>>
  /** TEXT layers: family, size, weight, leading, tracking, and the token behind each. The
   * grouped `type` table `design.ir` already returns is the right answer for building a type
   * scale; this is the right one for building ONE label, and a generator needs both. */
  typography?: TypeStyle
}

/* ------------------------------------------------------------------ bindings */

/** Fields whose binding is a single number this file reports a token for. Paint fields are
 * deliberately absent: a paint's token lives on the PAINT (`describePaint` reads
 * `paint.boundVariables.color`), and the node-level `fills` alias list is a flat bag that
 * nothing in the API promises lines up with the stack — zipping them named the wrong colour. */
const SCALAR_TOKEN_FIELDS: readonly string[] = [
  'topLeftRadius',
  'topRightRadius',
  'bottomRightRadius',
  'bottomLeftRadius',
  'strokeWeight',
  'strokeTopWeight',
  'strokeRightWeight',
  'strokeBottomWeight',
  'strokeLeftWeight',
  'opacity',
]

/** Layout fields: in the tree as numbers, reported here as names. */
const LAYOUT_TOKEN_FIELDS: readonly string[] = [
  'itemSpacing',
  'counterAxisSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
]

/** Resolves a variable id to its Figma name. `variableNameResolver()` in `bound-tokens.ts` is
 * the cached implementation; a test passes its own. */
export type ResolveToken = (id: string) => Promise<string | null>

interface BindingHolder {
  readonly boundVariables?: Record<string, unknown> | null
}

function bindingId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const id = (entry as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Token name per Figma field, for the fields asked about. One lookup per distinct id thanks to
 * the caller's resolver cache. */
async function tokensByField(
  node: BindingHolder,
  fields: readonly string[],
  resolve: ResolveToken
): Promise<Record<string, string>> {
  const bound = node.boundVariables
  if (!bound || typeof bound !== 'object') return {}
  const out: Record<string, string> = {}
  for (const field of fields) {
    const id = bindingId((bound as Record<string, unknown>)[field])
    if (!id) continue
    const name = await resolve(id)
    if (name) out[field] = name
  }
  return out
}

/* -------------------------------------------------------------------- values */

function value(raw: unknown, token?: string): IrValue | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return token ? { token, value: round(raw) } : { value: round(raw) }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Four values collapsed to one when they agree AND carry the same token. A uniform 8px radius
 * with `radius/sm` on one corner only is four values: collapsing it would claim a binding the
 * other three corners do not have. */
function collapse<K extends string>(
  parts: ReadonlyArray<readonly [K, IrValue | undefined]>
): IrValue | Record<K, IrValue> | undefined {
  const present = parts.filter((entry): entry is readonly [K, IrValue] => entry[1] !== undefined)
  if (present.length === 0) return undefined
  if (present.length === parts.length) {
    const first = present[0][1]
    const uniform = present.every(
      (entry) => entry[1].value === first.value && entry[1].token === first.token
    )
    if (uniform) return first
  }
  const out = {} as Record<K, IrValue>
  for (const [key, entry] of present) out[key] = entry
  return out
}

/* ---------------------------------------------------------------- appearance */

/** Enough of a `SceneNode` to describe. Structural so a fixture works and so the node types
 * Figma keeps adding do not each need a branch. */
export interface AppearanceSource extends BindingHolder {
  readonly type?: string
  readonly fills?: unknown
  readonly strokes?: unknown
  readonly strokeWeight?: unknown
  readonly strokeTopWeight?: unknown
  readonly strokeRightWeight?: unknown
  readonly strokeBottomWeight?: unknown
  readonly strokeLeftWeight?: unknown
  readonly strokeAlign?: unknown
  readonly dashPattern?: unknown
  readonly strokeCap?: unknown
  readonly strokeJoin?: unknown
  readonly cornerRadius?: unknown
  readonly topLeftRadius?: unknown
  readonly topRightRadius?: unknown
  readonly bottomRightRadius?: unknown
  readonly bottomLeftRadius?: unknown
  readonly cornerSmoothing?: unknown
  readonly effects?: unknown
  readonly opacity?: unknown
  readonly blendMode?: unknown
  readonly rotation?: unknown
  readonly isMask?: unknown
  readonly maskType?: unknown
}

/** `figma.mixed` and anything else that is not a usable number. A mixed radius is reported per
 * corner instead, which is what Figma means by it. */
function plain(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * Blend modes that mean "nothing was decided here".
 *
 * A NODE defaults to `PASS_THROUGH` and a PAINT defaults to `NORMAL`, and they are not
 * interchangeable — checking only `NORMAL` reported `PASS_THROUGH` on every layer of a real
 * 1465-layer screen, which is 752 fields claiming a decision nobody made and a reader having to
 * learn to ignore one. Both are listed because `appearanceOf` is handed nodes and paints alike.
 */
const DEFAULT_BLEND_MODES: ReadonlySet<string> = new Set(['NORMAL', 'PASS_THROUGH'])

/** Which text properties can carry a variable — Figma's own keys, same list `ir-mobile.ts` uses. */
const TYPE_TOKEN_FIELDS: readonly string[] = [
  'fontFamily',
  'fontStyle',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
]

async function typeTokenNames(
  node: BindingHolder,
  resolve: ResolveToken
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>()
  const bound = node.boundVariables
  if (!bound || typeof bound !== 'object') return out
  for (const field of TYPE_TOKEN_FIELDS) {
    const raw = (bound as Record<string, unknown>)[field]
    const id = bindingId(Array.isArray(raw) ? raw[0] : raw)
    if (!id || out.has(id)) continue
    const name = await resolve(id)
    if (name) out.set(id, name)
  }
  return out
}

async function paints(raw: unknown, resolve: ResolveToken): Promise<readonly PaintSummary[] | undefined> {
  if (!Array.isArray(raw)) return undefined
  const out: PaintSummary[] = []
  // The caller's resolver, not `describePaint`'s own `figma` lookup: one subtree asks about the
  // same handful of tokens on every layer, and a library variable read is a network round trip.
  for (let index = 0; index < raw.length; index++) {
    out.push(await describePaint(raw[index], index, undefined, resolve))
  }
  return out
}

/**
 * Everything about how one layer is painted, or `undefined` when it is painted in no way worth
 * reporting — a plain GROUP with no fills, no strokes, no effects and default everything.
 *
 * `text` is the live text node when this is a TEXT layer, so the typography can be read the same
 * way the grouped `type` table reads it. Kept as a separate argument rather than sniffed off
 * `source.type` so a caller can skip the work.
 */
export async function appearanceOf(
  source: AppearanceSource,
  resolve: ResolveToken,
  text?: Parameters<typeof typeStyleOf>[0]
): Promise<IrAppearance | undefined> {
  const out: IrAppearance = {}

  const scalars = await tokensByField(source, SCALAR_TOKEN_FIELDS, resolve)
  const layout = await tokensByField(source, LAYOUT_TOKEN_FIELDS, resolve)

  const fills = await paints(source.fills, resolve)
  if (fills) out.fills = fills
  const strokes = await paints(source.strokes, resolve)
  if (strokes && strokes.length > 0) out.strokes = strokes

  // Stroke geometry only matters when there is a stroke to have geometry.
  if (strokes && strokes.length > 0) {
    const weight = collapse([
      ['top', value(plain(source.strokeTopWeight) ?? plain(source.strokeWeight), scalars.strokeTopWeight ?? scalars.strokeWeight)],
      ['right', value(plain(source.strokeRightWeight) ?? plain(source.strokeWeight), scalars.strokeRightWeight ?? scalars.strokeWeight)],
      ['bottom', value(plain(source.strokeBottomWeight) ?? plain(source.strokeWeight), scalars.strokeBottomWeight ?? scalars.strokeWeight)],
      ['left', value(plain(source.strokeLeftWeight) ?? plain(source.strokeWeight), scalars.strokeLeftWeight ?? scalars.strokeWeight)],
    ])
    if (weight) out.strokeWeight = weight as IrValue | IrSides
    if (typeof source.strokeAlign === 'string') out.strokeAlign = source.strokeAlign
    if (Array.isArray(source.dashPattern) && source.dashPattern.length > 0) {
      out.dashPattern = (source.dashPattern as number[]).map(round)
    }
    // A cap only reads as a decision on an open path; a rectangle reports NONE and means nothing.
    if (typeof source.strokeCap === 'string' && source.strokeCap !== 'NONE') out.strokeCap = source.strokeCap
    if (typeof source.strokeJoin === 'string' && source.strokeJoin !== 'MITER') out.strokeJoin = source.strokeJoin
  }

  const uniform = plain(source.cornerRadius)
  const radius = collapse([
    ['topLeft', value(plain(source.topLeftRadius) ?? uniform, scalars.topLeftRadius)],
    ['topRight', value(plain(source.topRightRadius) ?? uniform, scalars.topRightRadius)],
    ['bottomRight', value(plain(source.bottomRightRadius) ?? uniform, scalars.bottomRightRadius)],
    ['bottomLeft', value(plain(source.bottomLeftRadius) ?? uniform, scalars.bottomLeftRadius)],
  ])
  // A zero radius on every corner with no token on any of them says nothing.
  if (radius && !(isValue(radius) && radius.value === 0 && radius.token === undefined)) {
    out.radius = radius as IrValue | IrCorners
  }
  const smoothing = plain(source.cornerSmoothing)
  if (smoothing !== undefined && smoothing > 0) out.cornerSmoothing = round(smoothing)

  const effects = await readEffects(source.effects)
  if (effects && effects.length > 0) out.effects = effects

  const opacity = plain(source.opacity)
  if ((opacity !== undefined && opacity < 1) || scalars.opacity) {
    const described = value(opacity ?? 1, scalars.opacity)
    if (described) out.opacity = described
  }
  if (typeof source.blendMode === 'string' && !DEFAULT_BLEND_MODES.has(source.blendMode)) {
    out.blendMode = source.blendMode
  }
  const rotation = plain(source.rotation)
  if (rotation !== undefined && round(rotation) !== 0) out.rotation = round(rotation)
  if (source.isMask === true) out.mask = { type: typeof source.maskType === 'string' ? source.maskType : 'ALPHA' }

  if (Object.keys(layout).length > 0) out.layoutTokens = layout

  // `typeStyleOf` wants an id→name map, and the cached resolver is the one authority on that
  // lookup (it reaches library variables a local-only map has never heard of). Six fields, so
  // building the map per text layer costs nothing the resolver has not already paid for.
  if (text) out.typography = typeStyleOf(text, await typeTokenNames(text, resolve))

  return Object.keys(out).length > 0 ? out : undefined
}

function isValue(candidate: IrValue | Record<string, IrValue>): candidate is IrValue {
  return typeof (candidate as IrValue).value === 'number'
}

/* ------------------------------------------------------------------ the pass */

function walk(node: IrNode, into: IrNode[] = []): IrNode[] {
  into.push(node)
  const children = (node as { children?: readonly IrNode[] }).children
  if (Array.isArray(children)) for (const child of children) walk(child, into)
  return into
}

/**
 * Fills `appearance` in on every node of the tree that has a live Figma node behind it.
 *
 * A node the index cannot find is left untouched rather than given an empty appearance: an
 * export-flattened subtree really has no single layer behind it, and claiming default paint for
 * it would be a plausible wrong answer.
 *
 * Returns how many nodes were annotated and how many had no source, because an agent that asked
 * for appearance and silently got a tree without it cannot tell which happened.
 */
export async function annotateAppearance(
  roots: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, AppearanceSource>,
  resolve: ResolveToken
): Promise<{ annotated: number; unmatched: number }> {
  let annotated = 0
  let unmatched = 0
  for (const root of roots) {
    for (const node of walk(root)) {
      const source = sceneNodesById.get(node.id)
      if (!source) {
        unmatched++
        continue
      }
      const isText = node.type === 'text'
      const appearance = await appearanceOf(
        source,
        resolve,
        isText ? (source as unknown as Parameters<typeof typeStyleOf>[0]) : undefined
      )
      if (appearance) {
        node.appearance = appearance
        annotated++
      }
    }
  }
  return { annotated, unmatched }
}
