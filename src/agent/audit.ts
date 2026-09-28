/**
 * Agent listener — did the build actually get what the design said?
 *
 * The best quality mechanism in this repo is `NODE_ROUNDTRIP`: read a node, build a copy from
 * ONLY what was read, read the copy, compare. It found sixty-nine divergences in its first hour,
 * all of one class, and it found them because the judge was the planner itself rather than a
 * second hand-written list of what ought to work.
 *
 * There has been no equivalent for *generated code*. An agent reads `design.ir`, emits SwiftUI or
 * Compose or TSX, and nothing ever checks the emitted values against the design — so the failure
 * mode is silent: a screen that is structurally right and painted from memory.
 *
 * This is that judge. The agent reports what it BUILT, per layer, in the channel's own property
 * vocabulary; the op compares that claim against what the channel holds. Three outcomes, named
 * apart because they are three different bugs in three different places:
 *
 * - **`dropped`** — the channel had the value and the build did not use it. A generator bug.
 * - **`diverged`** — both have it and they disagree. A mapping bug (a unit, a rounding, a mode).
 * - **`missing`** — the build needed a property and the channel cannot answer it. **An IR bug.**
 *
 * `missing` is the one that matters most, and it is why this exists. "The channel should reveal as
 * much of Figma as possible" is an instinct, and an instinct cannot be prioritised. `missing`
 * turns it into a list, ordered by a real screen: these are the properties a build actually
 * reached for and did not find. Everything else is speculation about what a generator might want.
 *
 * Deliberately NOT a linter. It never says a value is wrong in the abstract — only that the
 * design and the build disagree, and which side could not speak.
 */

import type { IrAppearance, IrCorners, IrSides, IrValue } from './appearance.ts'
import type { IrNode } from '../targets/django/ir.ts'

/* ------------------------------------------------------------------ claims */

/**
 * What a build says it emitted for one layer.
 *
 * Values are strings or numbers as the generator has them — a token name (`spacing/md`), a hex
 * (`#112233`), a number in the PLATFORM's unit. Not the channel's shape: a generator that had to
 * restate its output in this file's types would be reporting the translation rather than the
 * thing it shipped, which is the one measurement worth having.
 */
export interface BuiltLayer {
  /** The Figma node id this layer was generated from. */
  nodeId: string
  /** Property name → what was emitted. Keys are the channel's own vocabulary; see
   * `COMPARABLE`. An unrecognised key is reported as `unknown`, never silently ignored. */
  properties: Readonly<Record<string, string | number | boolean | null>>
}

export type Verdict = 'matched' | 'dropped' | 'diverged' | 'missing' | 'unknown'

export interface Finding {
  nodeId: string
  /** The layer's name, when the tree knows it — a node id alone is unreadable in a report. */
  name?: string
  property: string
  verdict: Verdict
  /** What the channel holds: the token when there is one, and the literal. Absent on `missing`
   * and `unknown`, which are the two cases where the channel has nothing to show. */
  design?: { token?: string; value?: string | number | boolean }
  /** What the build says it emitted. Absent on `dropped`. */
  built?: string | number | boolean | null
  /** One sentence, for the person reading the report. Never the whole answer — the verdict is. */
  note?: string
}

export interface AuditReport {
  /** Layers the build claimed, and how many of them the tree could be matched to. */
  layers: { claimed: number; matched: number; unmatched: number }
  /** One line per (layer, property) that is not a clean match. A clean run is an empty list. */
  findings: readonly Finding[]
  counts: Readonly<Record<Verdict, number>>
  /** The properties a build reached for that this channel cannot answer, most-wanted first.
   * This is the list that decides what the IR carries next. */
  wanted: ReadonlyArray<{ property: string; layers: number }>
  /** Divide-by, applied to every numeric comparison. 1 unless the artboard is a 2×/3× one. */
  scale: number
}

/* ------------------------------------------------------- the comparable set */

/**
 * Which claim keys this channel can answer, and where the answer comes from.
 *
 * `appearance` reads `design.ir`'s appearance annotation; `layout` reads the tree's own numbers;
 * `text` reads the characters. A key absent from here is `unknown` — a build that reports
 * `boxShadowSpread` is reporting in a vocabulary nothing here shares, and saying so beats
 * matching it against nothing and calling that a pass.
 *
 * `unit: true` means the value is a length and is divided by the reference density before
 * comparison. That is the whole reason the platform profile exists: a 2× artboard makes every
 * honest SwiftUI number half the Figma one, and without this the judge would report every single
 * length as diverged.
 */
const COMPARABLE: Readonly<Record<string, { from: 'appearance' | 'layout' | 'text'; unit?: true }>> = {
  fill: { from: 'appearance' },
  stroke: { from: 'appearance' },
  strokeWeight: { from: 'appearance', unit: true },
  radius: { from: 'appearance', unit: true },
  opacity: { from: 'appearance' },
  blendMode: { from: 'appearance' },
  rotation: { from: 'appearance' },
  effects: { from: 'appearance' },
  fontFamily: { from: 'appearance' },
  fontSize: { from: 'appearance', unit: true },
  fontWeight: { from: 'appearance' },
  lineHeight: { from: 'appearance' },
  letterSpacing: { from: 'appearance' },
  gap: { from: 'layout', unit: true },
  paddingTop: { from: 'layout', unit: true },
  paddingRight: { from: 'layout', unit: true },
  paddingBottom: { from: 'layout', unit: true },
  paddingLeft: { from: 'layout', unit: true },
  direction: { from: 'layout' },
  width: { from: 'layout', unit: true },
  height: { from: 'layout', unit: true },
  text: { from: 'text' },
  /* Added because the judge asked for them: auditing a real screen returned `unknown` for
   * `textTruncation` while `IrTextNode` was carrying `truncate` and `textAlign` all along. That
   * is the loop working — a build reached for something the tree held and the vocabulary did
   * not expose, and the fix is four lines rather than a guess about what a generator might
   * want. */
  textAlign: { from: 'text' },
  maxLines: { from: 'text' },
  noWrap: { from: 'text' },
}

export function comparableProperties(): readonly string[] {
  return Object.keys(COMPARABLE)
}

/* ----------------------------------------------------------- what the design says */

/** A value the channel holds for one property, or `null` when it holds nothing. */
type Held = { token?: string; value?: string | number | boolean } | null

function heldValue(value: IrValue | undefined): Held {
  if (!value) return null
  return value.token ? { token: value.token, value: value.value } : { value: value.value }
}

/** A radius or weight that is per-corner/per-side has no single value to compare; the FIRST is
 * not an answer, so it is reported as held-but-uncomparable via a `mixed` marker. A build that
 * emitted four corners individually is judged per corner by naming them per corner. */
function collapsedValue(value: IrValue | IrCorners | IrSides | undefined): Held {
  if (!value) return null
  if (typeof (value as IrValue).value === 'number') return heldValue(value as IrValue)
  return { value: 'mixed' }
}

function appearanceHolds(property: string, appearance: IrAppearance | undefined): Held {
  if (!appearance) return null
  switch (property) {
    case 'fill': {
      const paint = appearance.fills?.find((entry) => entry.visible !== false)
      if (!paint) return null
      // A paint's token is the answer when it has one; the hex is the answer when it does not.
      if (paint.bound) return { token: paint.bound, ...(paint.color ? { value: paint.color } : {}) }
      return paint.color ? { value: paint.color } : { value: paint.type }
    }
    case 'stroke': {
      const paint = appearance.strokes?.find((entry) => entry.visible !== false)
      if (!paint) return null
      if (paint.bound) return { token: paint.bound, ...(paint.color ? { value: paint.color } : {}) }
      return paint.color ? { value: paint.color } : { value: paint.type }
    }
    case 'strokeWeight':
      return collapsedValue(appearance.strokeWeight)
    case 'radius':
      return collapsedValue(appearance.radius)
    case 'opacity':
      return heldValue(appearance.opacity)
    case 'blendMode':
      return appearance.blendMode ? { value: appearance.blendMode } : null
    case 'rotation':
      return appearance.rotation === undefined ? null : { value: appearance.rotation }
    case 'effects':
      // Effects are a stack, not a value: the comparable fact is how many there are. A build
      // that emitted one shadow where the design has three is a divergence worth naming.
      return appearance.effects ? { value: appearance.effects.length } : null
    case 'fontFamily': {
      const type = appearance.typography
      return type ? { ...(type.tokens?.fontFamily ? { token: type.tokens.fontFamily } : {}), value: type.family } : null
    }
    case 'fontSize': {
      const type = appearance.typography
      return type ? { ...(type.tokens?.fontSize ? { token: type.tokens.fontSize } : {}), value: type.size } : null
    }
    case 'fontWeight': {
      const type = appearance.typography
      if (!type || type.weight === undefined) return null
      return { ...(type.tokens?.fontWeight ? { token: type.tokens.fontWeight } : {}), value: type.weight }
    }
    case 'lineHeight': {
      const type = appearance.typography
      // Kept as the string Figma reports (`24px`, `150%`, `auto`): collapsing a percentage to a
      // number would make a ratio and a length indistinguishable, which is the bug that puts
      // font metrics in `dp`.
      return type ? { ...(type.tokens?.lineHeight ? { token: type.tokens.lineHeight } : {}), value: type.lineHeight } : null
    }
    case 'letterSpacing': {
      const type = appearance.typography
      return type
        ? { ...(type.tokens?.letterSpacing ? { token: type.tokens.letterSpacing } : {}), value: type.letterSpacing }
        : null
    }
    default:
      return null
  }
}

function layoutHolds(property: string, node: IrNode): Held {
  const tokens = node.appearance?.layoutTokens
  const named = (field: string, value: number | undefined): Held => {
    if (value === undefined) return null
    const token = tokens?.[field]
    return token ? { token, value } : { value }
  }
  const layout = (node as { layout?: { kind?: string; direction?: string; gap?: number; padding?: Record<string, number> } })
    .layout
  switch (property) {
    case 'gap':
      return layout && layout.kind === 'flex' ? named('itemSpacing', layout.gap) : null
    case 'paddingTop':
      return named('paddingTop', layout?.padding?.top)
    case 'paddingRight':
      return named('paddingRight', layout?.padding?.right)
    case 'paddingBottom':
      return named('paddingBottom', layout?.padding?.bottom)
    case 'paddingLeft':
      return named('paddingLeft', layout?.padding?.left)
    case 'direction':
      return layout && layout.kind === 'flex' && layout.direction ? { value: layout.direction } : null
    case 'width': {
      const size = node.sizing?.width
      // `hug` and `fill` are real answers and are NOT numbers: comparing them to a pixel count
      // would report a correctly-intrinsic layer as diverged.
      if (!size) return null
      return size.mode === 'fixed' ? named('width', size.value) : { value: size.mode }
    }
    case 'height': {
      const size = node.sizing?.height
      if (!size) return null
      return size.mode === 'fixed' ? named('height', size.value) : { value: size.mode }
    }
    default:
      return null
  }
}

function textHolds(property: string, node: IrNode): Held {
  const text = node as {
    characters?: unknown
    textAlign?: unknown
    truncate?: { maxLines?: number | null }
    noWrap?: unknown
  }
  switch (property) {
    case 'text':
      return typeof text.characters === 'string' ? { value: text.characters } : null
    case 'textAlign':
      // Absent means `left` in the IR — the emitter only records a non-default alignment. A
      // build that emitted `left` is right, so the default is an ANSWER, not a gap.
      return typeof text.characters === 'string'
        ? { value: typeof text.textAlign === 'string' ? text.textAlign : 'left' }
        : null
    case 'maxLines':
      // `truncate` absent = the layer does not truncate; `maxLines: null` = it truncates with no
      // line cap. Three states, and collapsing two of them is how a clamp goes missing.
      if (typeof text.characters !== 'string') return null
      if (!text.truncate) return { value: 'none' }
      return { value: text.truncate.maxLines === null ? 'unbounded' : (text.truncate.maxLines ?? 'unbounded') }
    case 'noWrap':
      return typeof text.characters === 'string' ? { value: text.noWrap === true } : null
    default:
      return null
  }
}

/* --------------------------------------------------------------- comparison */

/** Two lengths that no consumer could tell apart. Figma stores floats; a generator rounds. */
const LENGTH_TOLERANCE = 0.51

function sameNumber(design: number, built: number): boolean {
  return Math.abs(design - built) <= LENGTH_TOLERANCE
}

/** A hex the same colour, whatever case or alpha spelling it arrived in. */
function sameColor(a: string, b: string): boolean {
  const norm = (hex: string) => hex.trim().toUpperCase().replace(/^#/, '').replace(/FF$/, '')
  return norm(a) === norm(b)
}

function agrees(
  design: NonNullable<Held>,
  built: string | number | boolean,
  unit: boolean,
  scale: number
): boolean {
  // A build that named the token agrees by definition — that is the whole point of carrying it,
  // and it is a BETTER answer than the literal, not an equivalent one.
  if (design.token !== undefined && String(built) === design.token) return true
  if (design.value === undefined) return false

  if (typeof design.value === 'number' && typeof built === 'number') {
    return sameNumber(unit ? design.value / scale : design.value, built)
  }
  if (typeof design.value === 'number') {
    const parsed = Number(String(built).replace(/[a-z%]+$/i, ''))
    if (Number.isFinite(parsed)) return sameNumber(unit ? design.value / scale : design.value, parsed)
    return false
  }
  const left = String(design.value)
  const right = String(built)
  if (/^#?[0-9a-f]{6,8}$/i.test(left) && /^#?[0-9a-f]{6,8}$/i.test(right)) return sameColor(left, right)
  return left.trim() === right.trim()
}

/* -------------------------------------------------------------------- judge */

function index(node: IrNode, into = new Map<string, IrNode>()): Map<string, IrNode> {
  into.set(node.id, node)
  const children = (node as { children?: readonly IrNode[] }).children
  if (Array.isArray(children)) for (const child of children) index(child, into)
  return into
}

export interface JudgeOptions {
  /** Figma pixels per platform unit — `unitProfile().scale`. Every length claim is compared
   * against `design / scale`, so a 2× artboard does not report every number as diverged. */
  scale?: number
  /** Properties to judge. Defaults to every comparable one. A build that only emitted colour
   * can ask about colour and not be told it dropped the whole type scale. */
  only?: readonly string[]
}

/**
 * Compares a build's own account of what it emitted against what the channel holds.
 *
 * Pure: no `figma`, no I/O. The tree carries everything, which is exactly the property that
 * makes this judgeable at all — and is the thing the appearance annotation was added for.
 */
export function judge(
  root: IrNode,
  built: readonly BuiltLayer[],
  options: JudgeOptions = {}
): AuditReport {
  const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1
  const asked = options.only && options.only.length > 0 ? new Set(options.only) : null
  const byId = index(root)

  const findings: Finding[] = []
  const counts: Record<Verdict, number> = { matched: 0, dropped: 0, diverged: 0, missing: 0, unknown: 0 }
  const wanted = new Map<string, Set<string>>()
  let matchedLayers = 0

  const record = (finding: Finding) => {
    counts[finding.verdict]++
    // A match is counted, not listed: a clean run should be an empty list, not a wall of
    // agreement nobody reads.
    if (finding.verdict !== 'matched') findings.push(finding)
  }

  for (const layer of built) {
    const node = byId.get(layer.nodeId)
    if (!node) {
      // Not a property problem: the build named a layer this tree does not contain. Usually an
      // export-flattened subtree, sometimes a stale id — either way not something to judge
      // property by property.
      findings.push({
        nodeId: layer.nodeId,
        property: '*',
        verdict: 'unknown',
        note: 'no layer with this id in the tree — an export-flattened subtree, or a stale id',
      })
      counts.unknown++
      continue
    }
    matchedLayers++

    const properties = layer.properties && typeof layer.properties === 'object' ? layer.properties : {}
    for (const [property, claim] of Object.entries(properties)) {
      if (asked && !asked.has(property)) continue
      const spec = COMPARABLE[property]
      if (!spec) {
        // The channel has no opinion, and saying so is the honest answer. Treating it as a pass
        // would let a whole vocabulary go unchecked while the report looked clean.
        record({
          nodeId: layer.nodeId,
          name: node.name,
          property,
          verdict: 'unknown',
          built: claim,
          note: 'not a property this channel describes — nothing to compare it against',
        })
        continue
      }

      const held =
        spec.from === 'appearance'
          ? appearanceHolds(property, node.appearance)
          : spec.from === 'layout'
            ? layoutHolds(property, node)
            : textHolds(property, node)

      if (held === null) {
        // THE bucket that decides what the IR carries next: a build reached for this and the
        // channel could not answer.
        record({
          nodeId: layer.nodeId,
          name: node.name,
          property,
          verdict: 'missing',
          built: claim,
          note:
            node.appearance === undefined && spec.from === 'appearance'
              ? 'no appearance on this layer — call design.ir with appearance: true'
              : 'the channel holds nothing for this property on this layer',
        })
        const layers = wanted.get(property) ?? new Set<string>()
        layers.add(layer.nodeId)
        wanted.set(property, layers)
        continue
      }

      if (claim === null || claim === undefined || claim === '') {
        record({
          nodeId: layer.nodeId,
          name: node.name,
          property,
          verdict: 'dropped',
          design: held,
          note: 'the design says this and the build emitted nothing',
        })
        continue
      }

      record({
        nodeId: layer.nodeId,
        name: node.name,
        property,
        verdict: agrees(held, claim, spec.unit === true, scale) ? 'matched' : 'diverged',
        design: held,
        built: claim,
        ...(spec.unit === true && scale !== 1
          ? { note: `lengths compared at 1/${scale} — the artboard is ${scale}×` }
          : {}),
      })
    }
  }

  return {
    layers: { claimed: built.length, matched: matchedLayers, unmatched: built.length - matchedLayers },
    findings,
    counts,
    wanted: [...wanted.entries()]
      .map(([property, layers]) => ({ property, layers: layers.size }))
      .sort((a, b) => b.layers - a.layers || a.property.localeCompare(b.property)),
    scale,
  }
}
