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

export function assignFamilies(
  from: readonly InferredSpectrum[],
  to: readonly InferredSpectrum[]
): FamilyAssignmentResult {
  if (from.length === 0 || to.length === 0) return { assignments: [], unused: [...to] }

  const matrix = from.map((source) => to.map((target) => familyCost(source, target)))
  const assignments: FamilyAssignment[] = []
  const placed = new Set<number>()

  if (from.length <= to.length) {
    const chosen = hungarian(matrix)
    for (const [index, column] of chosen.entries()) {
      if (column < 0) continue
      placed.add(index)
      assignments.push({ from: from[index], to: to[column], cost: matrix[index][column], shared: false, overflow: false })
    }
  } else {
    // More old families than new ones: solve it the other way round so every *target* gets
    // its best source, then let the leftovers pile on. That keeps the shrink deliberate —
    // each surviving family is the best representative of what merged into it.
    const transposed = to.map((_, column) => from.map((_source, row) => matrix[row][column]))
    const chosen = hungarian(transposed)
    for (const [column, row] of chosen.entries()) {
      if (row < 0) continue
      placed.add(row)
      assignments.push({ from: from[row], to: to[column], cost: matrix[row][column], shared: false, overflow: false })
    }
  }

  for (const [index, source] of from.entries()) {
    if (placed.has(index)) continue
    let bestColumn = 0
    for (let column = 1; column < to.length; column++) {
      if (matrix[index][column] < matrix[index][bestColumn]) bestColumn = column
    }
    assignments.push({
      from: source,
      to: to[bestColumn],
      cost: matrix[index][bestColumn],
      shared: true,
      overflow: true,
    })
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
  /** `step` when the new scale carried the same number, `lightness` when it had to interpolate. */
  via: 'step' | 'lightness'
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
export function matchStops(from: InferredSpectrum, to: InferredSpectrum): StopMatch[] {
  const byStep = new Map<number, SpectrumStop>()
  for (const stop of to.stops) if (stop.step !== null && !byStep.has(stop.step)) byStep.set(stop.step, stop)

  const matches: StopMatch[] = []
  for (const stop of from.stops) {
    const exact = stop.step === null ? undefined : byStep.get(stop.step)
    const target = exact ?? nearestByLightness(to.stops, stop.l)
    if (!target) continue
    matches.push({
      from: stop,
      to: target,
      via: exact ? 'step' : 'lightness',
      lightnessShift: Math.abs(target.l - stop.l),
    })
  }
  return matches
}
