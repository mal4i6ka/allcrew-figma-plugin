/**
 * Property diff (T5.6, docs/research/05-smart-animate-css-diff.md §1.2/§1.5): reduces a matched
 * pair of nodes to exactly the ~6 property groups Smart Animate interpolates — position,
 * size, rotation, opacity, fill, corner radius. `figma.mixed` (represented here as the local
 * `MIXED` sentinel, see `types.ts`) always short-circuits a comparison, matching Figma's own
 * behavior of not interpolating a property it can't read a single value for.
 */

import { matchLayers } from './match-layers.ts'
import { MIXED } from './types.ts'
import type { DiffableNode, NodePath } from './types.ts'

export type PropertyChange =
  | { readonly prop: 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'; readonly from: number; readonly to: number }
  | { readonly prop: 'cornerRadius'; readonly from: number; readonly to: number }
  | {
      readonly prop: 'cornerRadii'
      readonly from: readonly [number, number, number, number]
      readonly to: readonly [number, number, number, number]
    }
  | {
      readonly prop: 'fillColor'
      readonly from: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
      readonly to: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }
    }

const EPS = 0.01

function neq(a: number, b: number): boolean {
  return Math.abs(a - b) > EPS
}

function cornerRadii(node: DiffableNode): readonly [number, number, number, number] | null {
  if (typeof node.cornerRadius === 'number') {
    return [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius]
  }
  if (
    node.cornerRadius === MIXED &&
    node.topLeftRadius !== undefined &&
    node.topRightRadius !== undefined &&
    node.bottomRightRadius !== undefined &&
    node.bottomLeftRadius !== undefined
  ) {
    return [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius]
  }
  return null
}

/** Diffs one matched pair of nodes across position/size/rotation/opacity/fill/radius. */
export function diffProperties(a: DiffableNode, b: DiffableNode): PropertyChange[] {
  const out: PropertyChange[] = []

  if (neq(a.x, b.x)) out.push({ prop: 'x', from: a.x, to: b.x })
  if (neq(a.y, b.y)) out.push({ prop: 'y', from: a.y, to: b.y })
  if (neq(a.width, b.width)) out.push({ prop: 'width', from: a.width, to: b.width })
  if (neq(a.height, b.height)) out.push({ prop: 'height', from: a.height, to: b.height })
  if (a.rotation !== undefined && b.rotation !== undefined && neq(a.rotation, b.rotation)) {
    out.push({ prop: 'rotation', from: a.rotation, to: b.rotation })
  }
  if (a.opacity !== undefined && b.opacity !== undefined && neq(a.opacity, b.opacity)) {
    out.push({ prop: 'opacity', from: a.opacity, to: b.opacity })
  }

  if (a.fills !== undefined && b.fills !== undefined && a.fills !== MIXED && b.fills !== MIXED) {
    const fa = a.fills
    const fb = b.fills
    if (
      fa.length === 1 &&
      fb.length === 1 &&
      fa[0].type === 'SOLID' &&
      fb[0].type === 'SOLID' &&
      fa[0].color &&
      fb[0].color &&
      JSON.stringify(fa[0]) !== JSON.stringify(fb[0])
    ) {
      out.push({
        prop: 'fillColor',
        from: { ...fa[0].color, a: fa[0].opacity ?? 1 },
        to: { ...fb[0].color, a: fb[0].opacity ?? 1 },
      })
    }
  }

  const ra = cornerRadii(a)
  const rb = cornerRadii(b)
  if (ra && rb && ra.some((v, i) => neq(v, rb[i]))) {
    const aUniform = ra.every((v) => v === ra[0])
    const bUniform = rb.every((v) => v === rb[0])
    out.push(
      aUniform && bUniform ? { prop: 'cornerRadius', from: ra[0], to: rb[0] } : { prop: 'cornerRadii', from: ra, to: rb }
    )
  }

  return out
}

export interface StateDiff {
  readonly pairs: ReadonlyArray<{ readonly path: NodePath; readonly changes: readonly PropertyChange[] }>
  /** Present only in `base` (or type-mismatched) — fade out. */
  readonly fadeOut: readonly NodePath[]
  /** Present only in `target` (or type-mismatched) — fade in. */
  readonly fadeIn: readonly NodePath[]
}

/** Matches layers between two states, then diffs every matched pair. */
export function diffStates(base: DiffableNode, target: DiffableNode): StateDiff {
  const { matched, removed, added } = matchLayers(base, target)
  return {
    pairs: matched
      .map(({ path, a, b }) => ({ path, changes: diffProperties(a, b) }))
      .filter((pair) => pair.changes.length > 0),
    fadeOut: removed.map((r) => r.path),
    fadeIn: added.map((r) => r.path),
  }
}
