/**
 * REFORM phase 10b / B4: pure helpers for the design-kit builder. The raw `figma.createComponent`
 * / `combineAsVariants` / `setBoundVariable` calls live in the sandbox glue (src/code.ts); the
 * DECISIONS that glue makes — where each set sits on the page, which token a variant's fill binds
 * to, what the report says — are here, `figma`-free and Node-testable.
 */

import { DEFAULT_BOOTSTRAP_MAP } from '../bootstrap/map.ts'
import { varName } from '../../../tokens/engine.ts'
import type { ComponentPlan } from './plan.ts'

export interface GridCell {
  x: number
  y: number
}

/** Row-major grid positions for `count` sets/variants — the builder places nodes on the kit page. */
export function gridPositions(
  count: number,
  columns: number,
  cellWidth: number,
  cellHeight: number,
  gap: number
): GridCell[] {
  const cols = Math.max(1, columns)
  const cells: GridCell[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    cells.push({ x: col * (cellWidth + gap), y: row * (cellHeight + gap) })
  }
  return cells
}

/** The Bootstrap variable a variant value colors: `Primary` → `--bs-primary`, `Danger` →
 * `--bs-danger`. Only the role-color values map; sizes/states/etc. return null. */
export function bootstrapVarForVariantValue(value: string): string | null {
  const slug = value.trim().toLowerCase()
  const bsVar = `--bs-${slug}`
  return DEFAULT_BOOTSTRAP_MAP.some((entry) => entry.bsVar === bsVar) ? bsVar : null
}

/** Which design-token path a variant's fill should bind to — the token whose role matches the
 * variant value (`Primary` → the `--bs-primary` candidate present in the file). `availablePaths`
 * are canonical dotted token paths (`color.primary`); returns the first matching one, or null when
 * the file has no such token (the builder then falls back to a literal color). */
export function variantFillTokenPath(variantValue: string, availablePaths: readonly string[]): string | null {
  const bsVar = bootstrapVarForVariantValue(variantValue)
  if (!bsVar) return null
  const entry = DEFAULT_BOOTSTRAP_MAP.find((candidate) => candidate.bsVar === bsVar)
  if (!entry) return null
  const bySlug = new Map<string, string>()
  for (const path of availablePaths) {
    const slug = varName(path.split('.'))
    if (!bySlug.has(slug)) bySlug.set(slug, path)
  }
  for (const candidate of entry.candidates) {
    const path = bySlug.get(candidate)
    if (path) return path
  }
  return null
}

export interface KitReport {
  components: number
  variants: number
  /** Variants whose fill bound to a design token. */
  bound: number
  /** Recognized-but-token-less variants (fell back to a literal Bootstrap default). */
  unbound: number
  /** Container slots created + wired (editable content regions with preferred inserts). */
  slots: number
}

/** Rolls the plans + per-variant binding outcomes into the report the UI shows after generation. */
export function buildReport(plans: readonly ComponentPlan[], boundVariants: number, slots = 0): KitReport {
  const variants = plans.reduce((sum, plan) => sum + plan.variants.length, 0)
  return {
    components: plans.length,
    variants,
    bound: boundVariants,
    unbound: variants - boundVariants,
    slots,
  }
}
