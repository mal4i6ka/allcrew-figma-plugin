/**
 * REFORM phase 11 / B4+: pure LAYOUT decisions for the design-kit "sticker sheet" — where each
 * component cluster (title + subtitle + variant set) sits on the page, and how a set's variants
 * arrange into a labeled grid. The Figma glue (kit.ts) measures the built sets and calls these;
 * `figma`-free and Node-testable.
 */

import type { ComponentPlan } from './plan.ts'

export interface Size {
  w: number
  h: number
}
export interface Placed {
  x: number
  y: number
}

/** Shelf-packs cluster boxes left-to-right, wrapping to a new row when the current one would
 * exceed `maxWidth`. Row height = the tallest box in that row. Produces a tidy sticker-sheet grid
 * of variably-sized clusters. */
export function packShelves(sizes: readonly Size[], maxWidth: number, gapX: number, gapY: number): Placed[] {
  const placed: Placed[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const size of sizes) {
    if (x > 0 && x + size.w > maxWidth) {
      x = 0
      y += rowHeight + gapY
      rowHeight = 0
    }
    placed.push({ x, y })
    x += size.w + gapX
    rowHeight = Math.max(rowHeight, size.h)
  }
  return placed
}

/** Grid cell (col,row) for each variant of a plan. Rows = the FIRST variant prop's options (colors
 * stacked vertically), columns = the Cartesian product of the remaining props (size×state across).
 * 0–1 variant props → a single column, one variant per row. */
export function variantCells(plan: ComponentPlan): Placed[] {
  const variantProps = plan.componentDef.properties.filter((prop) => prop.type === 'VARIANT')
  const total = plan.variants.length
  if (variantProps.length <= 1) {
    return plan.variants.map((_, i) => ({ x: 0, y: i }))
  }
  const firstCount = variantProps[0].variantOptions?.length ?? 1
  const restCount = Math.max(1, Math.round(total / firstCount))
  // plan.variants is Cartesian with the FIRST prop varying slowest, so index → (row, col):
  return plan.variants.map((_, i) => ({ x: i % restCount, y: Math.floor(i / restCount) }))
}

/** Column/row counts for a plan's variant grid (mirrors `variantCells`). */
export function gridDims(plan: ComponentPlan): { cols: number; rows: number } {
  const cells = variantCells(plan)
  let cols = 1
  let rows = 1
  for (const c of cells) {
    cols = Math.max(cols, c.x + 1)
    rows = Math.max(rows, c.y + 1)
  }
  return { cols, rows }
}

/** A one-line subtitle summarizing a component's variant axes + count — shown under each cluster
 * title so a designer sees the prop matrix at a glance. */
export function clusterSubtitle(plan: ComponentPlan): string {
  const props = plan.componentDef.properties
  const axes = props.filter((p) => p.type === 'VARIANT').map((p) => `${p.name} (${p.variantOptions?.length ?? 0})`)
  const bools = props.filter((p) => p.type === 'BOOLEAN').map((p) => p.name)
  const n = plan.variants.length
  const parts: string[] = []
  parts.push(axes.length ? axes.join(' · ') : 'single frame')
  parts.push(`${n} ${n === 1 ? 'variant' : 'variants'}`)
  if (bools.length) parts.push(`bool: ${bools.join(', ')}`)
  return parts.join('  ·  ')
}
