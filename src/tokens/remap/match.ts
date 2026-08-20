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

export function familyCost(from: InferredSpectrum, to: InferredSpectrum): number {
  let cost: number
  if (from.neutral && to.neutral) cost = 0
  else if (from.neutral !== to.neutral) cost = NEUTRAL_MISMATCH
  else cost = hueDistance(from.hue, to.hue) / 180


  const fromCount = from.stops.length
  const toCount = to.stops.length
  cost += (Math.abs(fromCount - toCount) / Math.max(fromCount, toCount)) * WEIGHT_STOP_COUNT

  const fromKey = familyKey(from.label)
  const toKey = familyKey(to.label)
  if (fromKey === toKey) cost -= EXACT_NAME_BONUS
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
const compatible = (from: InferredSpectrum, to: InferredSpectrum): boolean => from.neutral === to.neutral

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
 * Fitting one ladder onto another, ends pinned.
 *
 * The tails are the whole problem. An old ramp that starts at `10` where the new one starts at
 * `50` has a rung with nowhere to go, so it lands on the new `50` — which the old `50` also
 * took, and the lightest tint stops being distinguishable from the one beside it. That is the
 * end where it shows: a pale background and its border become one colour.
 *
 * So the ends are pinned and the crowding is pushed inward, which is the same idea in both of
 * the two cases that can arise:
 *
 * - **There is room** (the new ladder has at least as many rungs). Each old rung keeps its own
 *   number where the new ladder has it, and where that rung is already taken the assignment
 *   walks inward to the next free one. The shift stops at the first gap, so most of the ramp
 *   never moves.
 * - **There is not** (the old ladder is longer). Some rungs must share, so the ends are pinned
 *   and the rest spaced proportionally — the sharing lands in the middle, where neighbouring
 *   steps are furthest apart and losing one costs least.
 *
 * Only numbered rungs take part. A `pumpkin` or a `900 less saturated` sitting in the same
 * family is a one-off colour, not a position on the ladder, and counting it as a rung shifts
 * everything else by one.
 */
function fitLadder(
  source: readonly SpectrumStop[],
  target: readonly SpectrumStop[],
  preferred: (stop: SpectrumStop) => SpectrumStop | null,
  anchorOf: (stop: SpectrumStop) => SpectrumStop | null,
  allowProportional: boolean
): Map<SpectrumStop, SpectrumStop> {
  const assigned = new Map<SpectrumStop, SpectrumStop>()
  const span = source.length - 1
  const reach = target.length - 1

  if (source.length > target.length) {
    if (!allowProportional) return assigned
    for (const [index, stop] of source.entries()) {
      assigned.set(stop, target[span === 0 ? 0 : Math.round((index * reach) / span)])
    }
    return assigned
  }

  const indexOf = new Map(target.map((stop, index) => [stop, index]))
  const at = (stop: SpectrumStop | null): number => (stop === null ? -1 : (indexOf.get(stop) ?? -1))
  const anchors = source.map((stop) => at(anchorOf(stop)))
  const wanted = source.map((stop) => at(preferred(stop)))

  let floor = -1
  for (const [index, stop] of source.entries()) {
    if (anchors[index] >= 0) {
      const settled = Math.min(Math.max(anchors[index], floor + 1), reach)
      assigned.set(stop, target[settled])
      floor = settled
      continue
    }

    // A rung whose number the new ladder does not have has to fit *between* the rungs whose
    // numbers it does. Without that, an old `10` takes the rung nearest its lightness — which
    // is the one the old `50` is about to claim by name — and the ramp comes out inverted at
    // the top: 10 darker than 50. Room is reserved for every unanchored rung still to come
    // before the next anchor, so they cannot pile onto it either.
    let nextAnchor = reach + 1
    let waiting = 0
    for (let ahead = index + 1; ahead < source.length; ahead++) {
      if (anchors[ahead] >= 0) {
        nextAnchor = anchors[ahead]
        break
      }
      waiting++
    }
    const ceiling = Math.min(reach, nextAnchor - 1 - waiting)
    const settled = Math.min(Math.max(wanted[index] < 0 ? floor + 1 : wanted[index], floor + 1), Math.max(ceiling, floor + 1))
    assigned.set(stop, target[Math.min(settled, reach)])
    floor = Math.min(settled, reach)
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

  const preferred = (stop: SpectrumStop): SpectrumStop | null =>
    (stop.step === null ? undefined : byStep.get(stop.step)) ?? nearestByLightness(to.stops, stop.l)

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
          preferred,
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
