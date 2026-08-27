/**
 * What the remap cost in readability.
 *
 * Nothing blocks an Apply — that was decided deliberately, and it is the right default when a
 * file holds hundreds of colors nobody wants to approve one by one. The price of that choice
 * is that an accessibility regression can land silently, so the pairs that actually sit on top
 * of each other in the document are re-measured afterwards and the losses are named.
 *
 * The pairs come from the same document walk that built the inventory, so this costs nothing
 * extra: a fill and its stroke, a text and the surface behind it. Only real combinations are
 * judged — a report about token pairs that never meet on canvas is noise dressed as rigour.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

import { contrastRatio } from '../color.ts'
import type { RemapEntry, RemapPlan } from './plan.ts'

export interface AdjacencyPair {
  a: string
  b: string
  /** One side is a text node, so the pair is judged against the text thresholds. */
  text: boolean
}

export type ContrastVerdict = 'broken' | 'weakened' | 'improved'

export interface ContrastFinding {
  aName: string
  bName: string
  mode: string | null
  before: number
  after: number
  text: boolean
  /**
   * `broken` — it used to pass the threshold for this pair and no longer does.
   * `weakened` — it failed before too, but the remap made it worse.
   * `improved` — reported only in the totals, never as a row to act on.
   */
  verdict: ContrastVerdict
}

export interface ContrastAudit {
  findings: ContrastFinding[]
  checked: number
  improved: number
}

/** WCAG 2.x AA: 4.5 for body text, 3 for large text and non-text boundaries. */
export const TEXT_CONTRAST_MIN = 4.5
export const NON_TEXT_CONTRAST_MIN = 3

const round = (value: number): number => Math.round(value * 100) / 100

/** Below this the change is rounding, not a regression anybody can see. */
const MEANINGFUL_DROP = 0.1

export function auditContrast(plan: RemapPlan, pairs: readonly AdjacencyPair[]): ContrastAudit {
  const byId = new Map<string, RemapEntry>(plan.entries.map((entry) => [entry.site.id, entry]))
  const findings: ContrastFinding[] = []
  const seen = new Set<string>()
  let checked = 0
  let improved = 0

  for (const pair of pairs) {
    const a = byId.get(pair.a)
    const b = byId.get(pair.b)
    if (!a || !b) continue

    const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`
    if (seen.has(key)) continue
    seen.add(key)
    checked++

    const before = contrastRatio(a.from, b.from)
    const after = contrastRatio(a.to, b.to)
    if (after > before + MEANINGFUL_DROP) {
      improved++
      continue
    }
    if (before - after < MEANINGFUL_DROP) continue

    const threshold = pair.text ? TEXT_CONTRAST_MIN : NON_TEXT_CONTRAST_MIN
    if (after >= threshold) continue

    findings.push({
      aName: a.site.name,
      bName: b.site.name,
      mode: a.site.modeName ?? b.site.modeName,
      before: round(before),
      after: round(after),
      text: pair.text,
      verdict: before >= threshold ? 'broken' : 'weakened',
    })
  }

  // Worst first, and a pair that used to pass outranks one that never did — the first is a
  // regression this remap caused, the second is a pre-existing problem it made worse.
  findings.sort(
    (first, second) =>
      Number(second.verdict === 'broken') - Number(first.verdict === 'broken') ||
      first.after - second.after ||
      second.before - first.before
  )

  return { findings, checked, improved }
}

/** One line per finding, for the panel and for the notification. */
export function describeContrast(finding: ContrastFinding): string {
  const kind = finding.text ? 'text' : 'boundary'
  const verb = finding.verdict === 'broken' ? 'fell below' : 'dropped further below'
  const threshold = finding.text ? TEXT_CONTRAST_MIN : NON_TEXT_CONTRAST_MIN
  return (
    `${finding.aName} on ${finding.bName}` +
    (finding.mode ? ` (${finding.mode})` : '') +
    `: ${kind} contrast ${finding.before} → ${finding.after}, ${verb} ${threshold}`
  )
}
