/**
 * The pure decisions of a rebind: which library variable a thing moves onto, and whether a
 * binding is allowed at all.
 *
 * A rebind is the second half of a migration. The first half — the remap — changes what
 * colors things *are*; this half changes what they *point at*, so that the file sits on the
 * reference library instead of merely resembling it. The two halves share one map: the plan.
 *
 * Two rules carry everything:
 *
 * - **The map is per variable, and a variable that disagrees with itself does not move.**
 *   A plan entry exists per (variable, mode); the modes almost always land on one library
 *   token, but when they genuinely diverge there is no single answer to "what does this
 *   variable become", and guessing one would silently flatten a theme.
 * - **An alias takes the target's value whole — alpha included.** So a binding is only
 *   created where the landing color equals the library variable's own value byte for byte;
 *   anything translucent that disagrees stays a literal, which the repaint has already set.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import type { Rgba } from './color-literal.ts'
import type { RemapPlan } from './plan.ts'

/** Where one local (or foreign) variable moves: the library variable's key, or a refusal. */
export interface RebindTarget {
  key: string
  /** Name of the palette entry the key belongs to, for reports. */
  toName: string | null
}

export interface RebindTargets {
  /** Variable id → the one library key all its modes agree on. */
  byVariable: Map<string, RebindTarget>
  /** Variables whose modes land on different library tokens — reported, never guessed. */
  divergent: string[]
}

const variableIdOf = (siteId: string): string | null => {
  const separator = siteId.lastIndexOf('|')
  return separator <= 0 ? null : siteId.slice(0, separator)
}

/**
 * Collapses the plan's per-mode entries into one rebind target per variable.
 *
 * Excluded entries are out of everything a run writes, so a variable with any excluded mode
 * keeps only its included modes' opinion — and if the human struck out every mode, the
 * variable does not move at all.
 */
export function rebindTargets(plan: RemapPlan): RebindTargets {
  const keys = new Map<string, Map<string, string | null>>()
  for (const entry of plan.entries) {
    if (entry.site.kind !== 'variable') continue
    if (entry.flags.includes('excluded')) continue
    const variableId = variableIdOf(entry.site.id) ?? entry.site.id
    const perMode = keys.get(variableId) ?? new Map<string, string | null>()
    perMode.set(entry.site.modeId ?? '', entry.toVariableKey)
    keys.set(variableId, perMode)
  }

  const byVariable = new Map<string, RebindTarget>()
  const divergent: string[] = []
  const names = new Map(
    plan.entries
      .filter((entry) => entry.toVariableKey !== null)
      .map((entry) => [entry.toVariableKey as string, entry.toName])
  )

  for (const [variableId, perMode] of keys) {
    const distinct = new Set(perMode.values())
    distinct.delete(null)
    if (distinct.size === 0) continue
    if (distinct.size > 1) {
      divergent.push(variableId)
      continue
    }
    const key = [...distinct][0] as string
    byVariable.set(variableId, { key, toName: names.get(key) ?? null })
  }

  return { byVariable, divergent }
}

/** Byte-equality on the 8-bit grid, alpha included — the only ground a new binding may stand on. */
export function sameRgba(a: Rgba, b: Rgba): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1 / 512
  return close(a.r, b.r) && close(a.g, b.g) && close(a.b, b.b) && close(a.a, b.a)
}

/** What a rebind run touched, for the report and the panel. */
export interface RebindCounts {
  /** Local variables whose alias moved onto a library token. */
  aliases: number
  /** Local variables whose literal value was byte-equal to a library token and became an alias. */
  literalsBound: number
  /** Node paints, gradient stops and effects rebound. */
  nodes: number
  /** Of those, inside instances — written only where the instance genuinely overrides. */
  instanceOverrides: number
  /** Style paints and effects rebound. */
  styles: number
  /** Bindings that pointed at another library and now point at the reference. */
  thirdParty: number
  skipped: {
    /** Translucent values whose alpha disagrees with the library token's own. */
    alphaMismatch: number
    /** Things bound to a variable the plan has no landing for. */
    noTarget: number
    /** Variables whose modes land on different library tokens. */
    divergent: number
    /** Already aliased to the reference library — nothing to do. */
    already: number
  }
}

export const emptyCounts = (): RebindCounts => ({
  aliases: 0,
  literalsBound: 0,
  nodes: 0,
  instanceOverrides: 0,
  styles: 0,
  thirdParty: 0,
  skipped: { alphaMismatch: 0, noTarget: 0, divergent: 0, already: 0 },
})

/** One line a human can read in the footer. */
export function describeRebind(counts: RebindCounts): string {
  const parts = [
    `${counts.aliases + counts.literalsBound} variable(s)`,
    `${counts.styles} style color(s)`,
    `${counts.nodes} canvas binding(s)` + (counts.instanceOverrides > 0 ? ` (${counts.instanceOverrides} in instances)` : ''),
  ]
  if (counts.thirdParty > 0) parts.push(`${counts.thirdParty} from other libraries`)
  const skips =
    counts.skipped.alphaMismatch + counts.skipped.noTarget + counts.skipped.divergent
  return parts.join(' · ') + (skips > 0 ? ` · ${skips} left as-is` : '')
}
