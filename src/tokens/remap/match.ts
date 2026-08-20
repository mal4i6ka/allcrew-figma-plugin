/**
 * Deciding what replaces what: families to families, then stops within a matched pair.
 *
 * Family assignment is solved globally rather than greedily. Greedy nearest-neighbour lets
 * the first family take the target a later one needed more, and the damage is not local —
 * a whole ramp ends up in the wrong hue because of the order the families happened to be
 * read in. The Hungarian algorithm minimises the total instead, so one family accepting a
 * slightly worse target to free a much better one for another is exactly what it does.
 *
 * Shrinking a palette (eight families to five) is a legitimate redesign, not an error, so
 * whatever the optimal 1:1 matching cannot place is assigned afterwards to its own cheapest
 * target. Those are marked, never dropped.
 *
 * Stops obey one rule with one exception: keep the step number when the new scale has it,
 * otherwise land on the step whose lightness is closest. Both branches choose from the steps
 * the designer actually shipped — *no step number is ever invented*, because the point of the
 * exercise is to move onto their ladder, not to negotiate a third one.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { rgbToOklch } from '../color.ts'
import type { Rgba } from './color-literal.ts'
import { familyKey } from './token-name.ts'
import { hueDistance, type InferredSpectrum, type SpectrumStop } from './spectrum.ts'

/* ------------------------------------------------------------------ distance */

/**
 * Perceptual distance between two colors, on a scale where ~1 is a just-noticeable
 * difference and ~2 matches the tolerance the linter's near-token snapping already uses
 * (`SNAP_DELTA_E` in targets/django/lint/fix.ts). Euclidean in OKLab rather than CIE76 Lab:
 * same familiar magnitudes, better behaviour on saturated colors.
 *
 * Alpha is not part of it — a translucent color is a different token, not a near match, so
 * callers compare alpha separately.
 */
export function deltaE(a: Rgba, b: Rgba): number {
  const first = rgbToOklch(a)
  const second = rgbToOklch(b)
  const ax = first.c * Math.cos((first.h * Math.PI) / 180)
  const ay = first.c * Math.sin((first.h * Math.PI) / 180)
  const bx = second.c * Math.cos((second.h * Math.PI) / 180)
  const by = second.c * Math.sin((second.h * Math.PI) / 180)
  const dl = first.l - second.l
  return 100 * Math.sqrt(dl * dl + (ax - bx) ** 2 + (ay - by) ** 2)
}

/** Closest candidate by color alone — the fallback for colors that belong to no ramp. */
export function nearestByColor<T extends { rgba: Rgba }>(candidates: readonly T[], color: Rgba): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = deltaE(candidate.rgba, color)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/* ------------------------------------------------------------------ family cost */

/** Hue is the dominant term; everything else only breaks ties between plausible targets. */
const WEIGHT_STOP_COUNT = 0.15

/**
 * A gray ramp and a colored ramp are never the same family. The penalty is larger than the
 * worst possible hue distance, so such a pair is only ever chosen when nothing else is left.
 */
const NEUTRAL_MISMATCH = 2

const EXACT_NAME_BONUS = 0.5
const PARTIAL_NAME_BONUS = 0.2

/**
 * Both sides calling a family by the same name settles what it is.
 *
 * Neutrality is measured, and the measurement is a threshold on relative chroma — which means
 * a muted ramp falls on the gray side of it. A real one: a `teal` running #F3F8F9 → #1A2527
 * holds a rock-steady 207° hue at every step and never rises above 0.36 of the chroma sRGB
 * allows, so it reads as gray to the arithmetic and as teal to everyone else. Ruling it
 * incompatible with the new palette's `teal` sends a whole ramp into the grays, and the file
 * comes out looking normalised rather than remapped.
 *
 * A shared name is not a hint here, it is the author of both palettes saying these are the
 * same family, and it outranks a threshold either ramp may sit near.
 */
export const sameFamilyName = (from: InferredSpectrum, to: InferredSpectrum): boolean =>
  familyKey(from.family) === familyKey(to.family)

export function familyCost(from: InferredSpectrum, to: InferredSpectrum): number {
  const named = sameFamilyName(from, to)

  let cost: number
  if (from.neutral && to.neutral) cost = 0
  // A gray ramp and a colored one are only the same family when both were given the same name.
  else if (from.neutral !== to.neutral) cost = named ? 0 : NEUTRAL_MISMATCH
  else cost = hueDistance(from.hue, to.hue) / 180

  const fromCount = from.stops.length
  const toCount = to.stops.length
  cost += (Math.abs(fromCount - toCount) / Math.max(fromCount, toCount)) * WEIGHT_STOP_COUNT

  const toKey = familyKey(to.family)
  const fromKey = familyKey(from.family)
  if (named) cost -= EXACT_NAME_BONUS
  else if (fromKey.includes(toKey) || toKey.includes(fromKey)) cost -= PARTIAL_NAME_BONUS

  return cost
}

/* ------------------------------------------------------------------ hungarian */

/**
 * Optimal assignment for a rectangular cost matrix with `rows <= cols`; returns the column
 * chosen for each row. The classic O(n³) shortest-augmenting-path formulation with
 * potentials — small matrices here (families, not colors), but the whole point is that the
 * answer is optimal rather than order-dependent.
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length
  if (rows === 0) return []
  const cols = cost[0].length
  if (cols < rows) throw new Error('hungarian: rows must not exceed cols')

  const u = new Array<number>(rows + 1).fill(0)
  const v = new Array<number>(cols + 1).fill(0)
  const match = new Array<number>(cols + 1).fill(0)
  const way = new Array<number>(cols + 1).fill(0)

  for (let row = 1; row <= rows; row++) {
    match[0] = row
    let col = 0
    const minimum = new Array<number>(cols + 1).fill(Infinity)
    const used = new Array<boolean>(cols + 1).fill(false)

    do {
      used[col] = true
      const currentRow = match[col]
      let delta = Infinity
      let nextCol = 0
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue
        const value = cost[currentRow - 1][j - 1] - u[currentRow] - v[j]
        if (value < minimum[j]) {
          minimum[j] = value
          way[j] = col
        }
        if (minimum[j] < delta) {
          delta = minimum[j]
          nextCol = j
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[match[j]] += delta
          v[j] -= delta
        } else {
          minimum[j] -= delta
        }
      }
      col = nextCol
    } while (match[col] !== 0)

    do {
      const previous = way[col]
      match[col] = match[previous]
      col = previous
    } while (col !== 0)
  }

  const assignment = new Array<number>(rows).fill(-1)
  for (let j = 1; j <= cols; j++) if (match[j] > 0) assignment[match[j] - 1] = j - 1
  return assignment
}

/* ------------------------------------------------------------------ family assignment */

export interface FamilyAssignment {
  from: InferredSpectrum
  to: InferredSpectrum
  cost: number
  /** The target takes more than one old family — the palette shrank here. */
  shared: boolean
  /** Placed by the overflow pass because the optimal matching had no target left. */
  overflow: boolean
}

export interface FamilyAssignmentResult {
  assignments: FamilyAssignment[]
  /** New families nothing landed on — the designer added colors the file never had. */
  unused: InferredSpectrum[]
}

/**
 * A gray ramp is never a coloured one, whichever way the arithmetic leans.
 *
 * The optimal matching is over *pairs*, and when the file has more families than the palette
 * the solve runs the other way round so every target gets its best source — which quietly
 * means every target gets *a* source, whether or not one belongs to it. On a file that is
 * mostly grays against a palette that is mostly colours, that is how red and orange end up
 * holding the gray ramps, at a distance of thirty. A target does not need a source.
 */
const compatible = (from: InferredSpectrum, to: InferredSpectrum): boolean =>
  from.neutral === to.neutral || sameFamilyName(from, to)

export function assignFamilies(
  from: readonly InferredSpectrum[],
  to: readonly InferredSpectrum[]
): FamilyAssignmentResult {
  if (from.length === 0 || to.length === 0) return { assignments: [], unused: [...to] }

  const matrix = from.map((source) => to.map((target) => familyCost(source, target)))
  const assignments: FamilyAssignment[] = []
  const placed = new Set<number>()

  const take = (row: number, column: number, overflow: boolean): void => {
    if (!compatible(from[row], to[column])) return
    placed.add(row)
    assignments.push({ from: from[row], to: to[column], cost: matrix[row][column], shared: false, overflow })
  }

  if (from.length <= to.length) {
    for (const [index, column] of hungarian(matrix).entries()) if (column >= 0) take(index, column, false)
  } else {
    // More old families than new ones: solve it the other way round so every *target* gets its
    // best source, then let the leftovers pile on.
    const transposed = to.map((_, column) => from.map((_source, row) => matrix[row][column]))
    for (const [column, row] of hungarian(transposed).entries()) if (row >= 0) take(row, column, false)
  }

  // Anything the solve could not place — or placed somewhere it does not belong — takes its own
  // cheapest *compatible* target instead. A family with no compatible target keeps none: its
  // colours are matched one by one, which is the honest answer when the palette has nothing of
  // that kind.
  for (const [index, source] of from.entries()) {
    if (placed.has(index)) continue
    let best = -1
    for (let column = 0; column < to.length; column++) {
      if (!compatible(source, to[column])) continue
      if (best < 0 || matrix[index][column] < matrix[index][best]) best = column
    }
    if (best >= 0) take(index, best, true)
  }

  const perTarget = new Map<string, number>()
  for (const assignment of assignments) {
    perTarget.set(assignment.to.key, (perTarget.get(assignment.to.key) ?? 0) + 1)
  }
  for (const assignment of assignments) {
    if ((perTarget.get(assignment.to.key) ?? 0) > 1) assignment.shared = true
  }

  const used = new Set(assignments.map((assignment) => assignment.to.key))
  const order = new Map(from.map((spectrum, index) => [spectrum.key, index]))
  assignments.sort((a, b) => (order.get(a.from.key) ?? 0) - (order.get(b.from.key) ?? 0))

  return { assignments, unused: to.filter((spectrum) => !used.has(spectrum.key)) }
}

/* ------------------------------------------------------------------ stops */

export interface StopMatch {
  from: SpectrumStop
  to: SpectrumStop
  /**
   * `step` when the new scale carried the same number, `lightness` when it had to interpolate,
   * `stretched` when the whole family was rescaled because the old ladder had more steps.
   */
  via: 'step' | 'lightness' | 'stretched'
  /** How far the landing lightness sits from the original, 0…1. */
  lightnessShift: number
}

/** The stop whose lightness is closest to `l`. */
export function nearestByLightness(stops: readonly SpectrumStop[], l: number): SpectrumStop | null {
  let best: SpectrumStop | null = null
  let bestDistance = Infinity
  for (const stop of stops) {
    const distance = Math.abs(stop.l - l)
    if (distance < bestDistance) {
      bestDistance = distance
      best = stop
    }
  }
  return best
}

/**
 * Maps every stop of one family onto the other.
 *
 * Scales of different lengths are the normal case, not an edge case — ten steps onto twelve,
 * or a named scale onto one that arrived as bare hexes with no numbers at all. Both are
 * handled by the same two branches, and both only ever return a stop that exists in `to`.
 */
/** A lightness break this wide is a step that means something else, not a bumpy ramp. */
const LADDER_BREAK = 0.15

/**
 * Steps whose number cannot be trusted, because they break their own family's ladder.
 *
 * A scale is only comparable to another scale if a step number means the same *kind* of thing
 * in both. Real systems break that: a palette whose `10` is the brand colour and whose
 * `50…900` are tints of it has a `10` sitting far outside its own monotone run, and matching
 * an old light `10` onto it by number turns every pale background into a saturated fill. The
 * number is right and the result is absurd, which is exactly the case worth detecting.
 *
 * Such a stop is excluded from *exact* matching only. It stays available as a lightness
 * target, because as a colour it is perfectly real.
 */
export function ladderOutliers(spectrum: InferredSpectrum): Set<number> {
  const ladder = spectrum.stops
    .filter((stop): stop is SpectrumStop & { step: number } => stop.step !== null)
    .sort((a, b) => a.step - b.step)
  const outliers = new Set<number>()
  if (ladder.length < 4) return outliers

  let up = 0
  let down = 0
  for (let i = 1; i < ladder.length; i++) {
    const delta = ladder[i].l - ladder[i - 1].l
    if (delta > 0.01) up++
    else if (delta < -0.01) down++
  }
  const direction = down > up ? -1 : up > down ? 1 : 0
  if (direction === 0) return outliers

  /** Does this pair run the way the ladder as a whole runs? */
  const follows = (earlier: number, later: number): boolean =>
    direction < 0 ? earlier >= later - LADDER_BREAK : earlier <= later + LADDER_BREAK

  for (let i = 0; i < ladder.length; i++) {
    const previous = ladder[i - 1]
    const next = ladder[i + 1]
    const breaksBefore = previous !== undefined && !follows(previous.l, ladder[i].l)
    const breaksAfter = next !== undefined && !follows(ladder[i].l, next.l)
    // An end only has one neighbour to disagree with; an interior stop has to disagree with
    // both, or it is the *next* stop that is out of place rather than this one.
    const isEnd = previous === undefined || next === undefined
    if (isEnd ? breaksBefore || breaksAfter : breaksBefore && breaksAfter) outliers.add(ladder[i].step)
  }

  return outliers
}

/**
 * Fitting one ladder onto another. Three rules, in order of authority:
 *
 * 1. **A shared number is law.** A rung whose number the new ladder has lands on that number,
 *    and nothing displaces it.
 * 2. **A rung without a number fits between the anchors around it**, on whichever position —
 *    free slot or shared anchor — is nearest its own lightness. Order is preserved: it can
 *    collapse onto a neighbour, it can never leapfrog one.
 * 3. **The proportional stretch exists only for ladders with no numbers in common**, where
 *    index position is the only structure there is.
 *
 * Collapsing two old shades onto one new rung is the honest outcome of a palette that shrank;
 * inventing an off-by-one landing to avoid the collapse is how a whole ramp drifts.
 *
 * Only numbered rungs take part. A `pumpkin` or a `900 less saturated` sitting in the same
 * family is a one-off colour, not a position on the ladder, and counting it as a rung shifts
 * everything else by one.
 */
function fitLadder(
  source: readonly SpectrumStop[],
  target: readonly SpectrumStop[],
  anchorOf: (stop: SpectrumStop) => SpectrumStop | null,
  allowProportional: boolean
): Map<SpectrumStop, SpectrumStop> {
  const assigned = new Map<SpectrumStop, SpectrumStop>()
  const span = source.length - 1
  const reach = target.length - 1

  const indexOf = new Map(target.map((stop, index) => [stop, index]))
  const at = (stop: SpectrumStop | null): number => (stop === null ? -1 : (indexOf.get(stop) ?? -1))
  const anchors = source.map((stop) => at(anchorOf(stop)))

  // The proportional stretch is for ladders with nothing in common — ten unnumbered rungs
  // onto twelve, where index position is the only structure there is. With even one exact
  // step match it is the wrong tool: spreading a twelve-rung violet over an eleven-rung blue
  // by index lands `200` on `250` and shifts everything below by one, when `50…900` matched
  // number for number and only the two tails had nowhere to go. Anchors are structure; when
  // they exist, the anchored fit below runs instead and the tails share their nearest rung.
  if (source.length > target.length && !anchors.some((index) => index >= 0)) {
    if (!allowProportional) return assigned
    for (const [index, stop] of source.entries()) {
      assigned.set(stop, target[span === 0 ? 0 : Math.round((index * reach) / span)])
    }
    return assigned
  }

  // Anchors are law. A rung whose number exists in the new ladder lands on that number, full
  // stop — no unanchored neighbour may displace it, however good that neighbour's own claim
  // looks. The one time this tool let a stray rung push a ladder "just a little" (a budgeted
  // shift of up to three anchors), a `grey/10` shoved the whole top of a gray ramp: `50`
  // ended up on `150`, a step its own number says it is not. The operator's rule is simpler
  // and better: the reference is 1:1; whatever has no number of its own fits into the gaps,
  // and when there is no gap it collapses onto the nearest existing rung.
  //
  // The unanchored rungs between two anchors are placed *together*, as one monotone
  // assignment minimizing total lightness shift. Placing them one at a time with reserved
  // slots was tried and refuted: the reservation could strand the very slot it was holding —
  // a rung two steps from a near-white slot got the far anchor instead, and the slot went to
  // nobody. The joint assignment cannot make that mistake, and collapsing (two rungs sharing
  // a landing) stays legal because the mapping is non-decreasing, not strictly increasing.
  let floor = -1
  let index = 0
  while (index < source.length) {
    if (anchors[index] >= 0) {
      assigned.set(source[index], target[anchors[index]])
      floor = Math.max(floor, anchors[index])
      index++
      continue
    }

    let end = index
    while (end < source.length && anchors[end] < 0) end++
    const nextAnchor = end < source.length ? anchors[end] : -1

    // Candidate positions for this run: the anchor below (shared), every free slot between
    // the anchors, the anchor above (shared).
    const positions: number[] = []
    if (floor >= 0) positions.push(floor)
    const upper = nextAnchor >= 0 ? nextAnchor - 1 : reach
    for (let position = floor + 1; position <= upper; position++) positions.push(position)
    if (nextAnchor >= 0) positions.push(nextAnchor)
    if (positions.length === 0) positions.push(Math.max(0, Math.min(floor, reach)))

    // Non-decreasing assignment of run rungs to positions, minimum total |Δl| — a prefix-min
    // dynamic program over a handful of rungs and slots.
    const run = source.slice(index, end)
    const width = positions.length
    let previous = new Array<number>(width).fill(0)
    const picks: number[][] = []
    for (const stop of run) {
      const current = new Array<number>(width).fill(Infinity)
      const pick = new Array<number>(width).fill(-1)
      let bestBefore = Infinity
      let bestAt = -1
      for (let p = 0; p < width; p++) {
        if (previous[p] < bestBefore) {
          bestBefore = previous[p]
          bestAt = p
        }
        current[p] = bestBefore + Math.abs(target[positions[p]].l - stop.l)
        pick[p] = bestAt
      }
      picks.push(pick)
      previous = current
    }
    let at = 0
    for (let p = 1; p < width; p++) if (previous[p] < previous[at]) at = p
    const chosen = new Array<number>(run.length)
    for (let i = run.length - 1; i >= 0; i--) {
      chosen[i] = at
      at = picks[i][at]
    }
    for (const [i, stop] of run.entries()) {
      const position = positions[chosen[i]]
      assigned.set(stop, target[position])
      floor = Math.max(floor, position)
    }
    index = end
  }
  return assigned
}

const byStepAscending = (a: SpectrumStop, b: SpectrumStop): number => (a.step ?? 0) - (b.step ?? 0)

export function matchStops(from: InferredSpectrum, to: InferredSpectrum): StopMatch[] {
  const untrusted = ladderOutliers(to)
  const byStep = new Map<number, SpectrumStop>()
  for (const stop of to.stops) {
    if (stop.step === null || untrusted.has(stop.step) || byStep.has(stop.step)) continue
    byStep.set(stop.step, stop)
  }

  // For rungs of a fitted ladder the number is law and this function never decides. It only
  // decides for the thin-evidence cases — families too short to fit, and one-off colours —
  // and there a number that grossly contradicts the colour's own lightness is not trusted: a
  // two-stop `toxic` family's `50` is a dark olive, and sending it to a near-white `green/50`
  // because the numerals match would invert the pair it came with.
  const preferred = (stop: SpectrumStop): SpectrumStop | null => {
    const byNumber = stop.step === null ? undefined : byStep.get(stop.step)
    const byLight = nearestByLightness(to.stops, stop.l)
    if (!byNumber) return byLight
    if (
      byLight &&
      Math.abs(byNumber.l - stop.l) > LADDER_BREAK &&
      Math.abs(byLight.l - stop.l) < Math.abs(byNumber.l - stop.l)
    ) {
      return byLight
    }
    return byNumber
  }

  const anchorOf = (stop: SpectrumStop): SpectrumStop | null =>
    (stop.step === null ? undefined : byStep.get(stop.step)) ?? null

  // Neutrals are never *stretched*: backgrounds and text live on them, a shift in lightness
  // shows there first, and a palette whose neutrals reach pure white and black would pull every
  // pale surface to #FFFFFF. They are still fitted, though — a gray ramp that comes out
  // inverted at the top is wrong whichever colours it is made of.
  const sourceLadder = from.stops.filter((stop) => stop.step !== null)
  const targetLadder = to.stops.filter((stop) => stop.step !== null && !untrusted.has(stop.step))
  const fitted =
    sourceLadder.length >= 3 && targetLadder.length >= 2
      ? fitLadder(
          [...sourceLadder].sort(byStepAscending),
          [...targetLadder].sort(byStepAscending),
          anchorOf,
          !from.neutral && !to.neutral
        )
      : new Map<SpectrumStop, SpectrumStop>()

  const matches: StopMatch[] = []
  for (const stop of from.stops) {
    const placed = fitted.get(stop)
    const target = placed ?? preferred(stop)
    if (!target) continue
    const kept = stop.step !== null && target.step === stop.step
    matches.push({
      from: stop,
      to: target,
      via: kept ? 'step' : placed ? 'stretched' : 'lightness',
      lightnessShift: Math.abs(target.l - stop.l),
    })
  }
  return matches
}
