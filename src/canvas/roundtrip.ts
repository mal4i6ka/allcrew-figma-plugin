/**
 * Does a reading survive being sent back?
 *
 * The channel's whole contract is that what you read you can write: the property vocabulary is
 * one vocabulary, not two. Every audit this season found the same defect wearing a different
 * coat — `"var:surface/l0"` refused as a colour, `sizing` accepted only under `layout`, a font
 * read as `"Inter Regular"` and written as `{ family, style }` — and each was found by hand, one
 * screen at a time, which is not a way to know anything.
 *
 * So the check is a machine. Read a node, build a create-spec out of nothing but the reading,
 * make the copy, read the copy, and compare. Three things can go wrong and each is named
 * separately, because they mean different things:
 *
 *   DROPPED   the reading holds a property the write does not accept. The reading is not
 *             sendable, and the planner itself says so — no separate list of "what is writable"
 *             is kept here, because a second list is a second thing to be wrong.
 *   FAILED    the write accepted the property and Figma refused it.
 *   DIVERGED  it went through and the copy came back different.
 *
 * A property that is not a value — `"mixed"` on a text with two fonts — is not a defect: it is
 * the read saying "look at the runs". Those are listed apart, as `notValues`, so a real
 * divergence never hides behind one.
 */

import { planProps } from './props.ts'
import type { CreateSpec } from './create.ts'

/** Node type → the word `NODE_CREATE` takes for it. */
const KIND_OF: Readonly<Record<string, string>> = {
  FRAME: 'frame',
  COMPONENT: 'component',
  INSTANCE: 'instance',
  TEXT: 'text',
  TEXT_PATH: 'textPath',
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  SECTION: 'section',
  VECTOR: 'vector',
  STAR: 'star',
  POLYGON: 'polygon',
}

export const kindOf = (type: string): string | null => KIND_OF[type] ?? null

/**
 * What a reading says about the node rather than about its properties.
 *
 * These are not candidates for the write and their absence is not a finding: an id is the node's
 * own, `parent` says where it sits, `component` and `key` describe what an instance points at.
 */
const NOT_PROPERTIES = new Set([
  'id',
  'name',
  'type',
  'parent',
  'childCount',
  'component',
  'key',
  'variantOf',
  'description',
  'documentation',
  'timelines',
  'devLinks',
  'annotations',
  // A slot is a fact about the component, not a value this instance can be told.
  'slots',
])

/**
 * Readings that are summaries rather than values.
 *
 * `network` reads as "13 point(s), 13 segment(s), 1 region(s)" because dumping every vertex into
 * every node read would drown the ordinary case. That is the right call for a read and it does
 * mean a copied vector comes out empty — a real limit, named here so it is counted once as a
 * known summary instead of fifteen times as a fresh defect.
 */
const SUMMARIES = new Set(['network', 'brush', 'shader'])

/**
 * Where a node sits is its parent's business, so position is compared and never sent.
 *
 * Size is sent. Leaving it out looked tidy — "size follows from the layout" — and a fixed 390×844
 * screen came back as Figma's default 100 wide, which is a defect in the instrument reported as a
 * defect in the vocabulary. The planner already knows what to do with a size on a hugging frame:
 * FIXED lands before the resize and HUG after it.
 */
const NOT_SENT = new Set(['x', 'y'])

export interface RoundTripFinding {
  property: string
  /** What the original read said. */
  was?: unknown
  /** What the copy read said, when it differs. */
  became?: unknown
  why?: string
}

export interface RoundTripReport {
  same: string[]
  diverged: RoundTripFinding[]
  dropped: RoundTripFinding[]
  notValues: string[]
}

/**
 * The properties of a reading that can be sent, and the ones that cannot — decided by the planner,
 * which is the only thing that knows.
 */
export function sendable(props: Record<string, unknown>): {
  props: Record<string, unknown>
  dropped: RoundTripFinding[]
  notValues: string[]
} {
  const dropped: RoundTripFinding[] = []
  const notValues: string[] = []
  const candidate: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (NOT_PROPERTIES.has(key) || NOT_SENT.has(key)) continue
    // A line has no height and a column no width. Sending a zero is refused — `height must be
    // >= 0.01` — for a shape whose reading is perfectly true.
    if ((key === 'width' || key === 'height') && value === 0) continue
    // `figma.mixed` reaches a reading as the word "mixed": an answer, not a value, and the runs
    // beside it carry what it stands for.
    if (value === 'mixed') {
      notValues.push(key)
      continue
    }
    if (SUMMARIES.has(key)) {
      notValues.push(`${key} (summary)`)
      continue
    }
    candidate[key] = value
  }

  // One plan, then the problems tell us which keys to take out. Planning key by key would answer
  // a different question — several properties are only meaningful together.
  let plan = planProps(candidate)
  let guard = 0
  while (plan.problems.length > 0 && guard++ < 40) {
    const blamed = new Set<string>()
    for (const problem of plan.problems) {
      const named = /(?:unknown property |^|[\s.])"?([A-Za-z][A-Za-z0-9]*)"?(?::| must| is not| cannot)/.exec(problem)
      const key = /unknown property "([^"]+)"/.exec(problem)?.[1] ?? named?.[1]
      if (key && key in candidate) blamed.add(key)
    }
    if (blamed.size === 0) {
      // A complaint we cannot pin on a key: the whole reading is unsendable and saying which
      // property to blame would be a guess.
      for (const problem of plan.problems) dropped.push({ property: '(reading)', why: problem })
      return { props: {}, dropped, notValues }
    }
    for (const key of blamed) {
      dropped.push({ property: key, was: candidate[key], why: plan.problems.find((one) => one.includes(key)) })
      delete candidate[key]
    }
    plan = planProps(candidate)
  }

  return { props: candidate, dropped, notValues }
}

/** The create-spec a reading amounts to, or null when the node type cannot be made at all. */
export function specFrom(
  reading: Record<string, unknown>,
  children: CreateSpec[],
  /** For an instance: the component to make. The reading names it, but a name is not an id. */
  of?: string | null
): { spec: CreateSpec; dropped: RoundTripFinding[]; notValues: string[] } | null {
  const kind = kindOf(String(reading.type))
  if (!kind) return null
  const { props, dropped, notValues } = sendable((reading.props ?? {}) as Record<string, unknown>)
  if (kind === 'instance' && !of) {
    return { spec: { kind: 'instance', props }, dropped: [...dropped, { property: '(instance)', why: 'the main component is unavailable, so the copy cannot be made' }], notValues }
  }
  const spec: CreateSpec = {
    kind: kind as CreateSpec['kind'],
    props: { ...props, name: reading.name },
    // An instance's children come from its component; sending them again would build a second
    // copy of everything inside it.
    ...(kind !== 'instance' && children.length > 0 ? { children } : {}),
    ...(of ? { of } : {}),
  }
  return { spec, dropped, notValues }
}

/** What the two readings disagree about, property by property. */
export function compare(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: ReadonlySet<string>
): { same: string[]; diverged: RoundTripFinding[] } {
  const same: string[] = []
  const diverged: RoundTripFinding[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  // A shape that could not travel takes its size with it: a vector whose `network` is a summary
  // comes out empty, and reporting the height as a second finding says the same thing twice while
  // hiding what a real size difference would mean.
  const shaped = [...keys].some((key) => SUMMARIES.has(key) && before[key] !== undefined)

  for (const key of keys) {
    if (NOT_PROPERTIES.has(key) || ignore.has(key)) continue
    // A summary cannot travel by design, and it is already reported as one. Comparing it too
    // would count the same known limit twice and hide a real divergence behind it.
    if (SUMMARIES.has(key)) continue
    if (shaped && (key === 'width' || key === 'height')) continue
    // Where the copy sits is not what is being tested; how big it came out is.
    if (key === 'x' || key === 'y') continue
    const left = JSON.stringify(before[key] ?? null)
    const right = JSON.stringify(after[key] ?? null)
    if (left === right) same.push(key)
    else diverged.push({ property: key, was: before[key] ?? null, became: after[key] ?? null })
  }
  return { same: same.sort(), diverged }
}
