/**
 * Figma-side audit for DESIGN.md's guardrails section.
 *
 * The value of a generated spec is not the token list (tokens.json already has it) — it is the
 * set of hard constraints, and those come from what the Figma file actually looks like. This
 * module reads the token graph (variables, collections, text styles) and reports the hygiene
 * facts a coding agent must know: detached text styles, modes a variable never got a value in,
 * collections that cannot theme.
 *
 * Scene-level findings (unbound fills, missing Auto Layout …) come from the linter instead —
 * see `src/targets/django/lint/index.ts`; only the Django target walks the canvas.
 */

import type { TokenGraph } from '../../tokens/engine.ts'

export interface AuditCollection {
  name: string
  modes: string[]
  variableCount: number
  generated: boolean
}

export interface TokenAudit {
  textStyleCount: number
  /** Text styles with no typography field bound to a variable at all. */
  detachedTextStyles: number
  /** Text styles where only some fields are bound — the rest are baked literals. */
  partiallyBoundTextStyles: number
  collections: AuditCollection[]
  /** Collections carrying exactly one mode — they cannot participate in theming. */
  singleModeCollections: string[]
  /** `<variable name> in <mode>` pairs that never got a value. */
  missingModeValues: string[]
  hasTypographyCollection: boolean
  hasGeneratedTypographyCollection: boolean
  hasBreakpointCollection: boolean
}

const TYPO_FIELDS = ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'letterSpacing', 'lineHeight']

/** How many of a text style's typography fields are bound to variables. */
function boundFieldCount(boundVariables: Record<string, string> | undefined): number {
  if (!boundVariables) return 0
  return TYPO_FIELDS.filter((field) => typeof boundVariables[field] === 'string' && boundVariables[field]).length
}

/** Fields that exist on the style at all — an unset field isn't a binding gap. */
function presentFieldCount(style: { fontName?: unknown; fontSize?: unknown; lineHeight?: unknown; letterSpacing?: unknown }): number {
  let count = 0
  if (style.fontName) count += 2 // family + style
  if (typeof style.fontSize === 'number') count += 1
  if (style.lineHeight) count += 1
  if (style.letterSpacing) count += 1
  return count
}

const MAX_MISSING_REPORTED = 12

export function buildTokenAudit(graph: TokenGraph): TokenAudit {
  const collections = (graph.collections ?? []).map((collection) => ({
    name: collection.name,
    modes: (collection.modes ?? []).map((mode) => mode.name),
    variableCount: (graph.variables ?? []).filter((variable) => variable.collectionId === collection.id).length,
    generated: collection.generated === true,
  }))

  const textStyles = graph.textStyles ?? []
  let detached = 0
  let partial = 0
  for (const style of textStyles) {
    const bound = boundFieldCount(style.boundVariables)
    if (bound === 0) detached++
    else if (bound < presentFieldCount(style)) partial++
  }

  const missingModeValues: string[] = []
  const collectionById = new Map((graph.collections ?? []).map((collection) => [collection.id, collection]))
  for (const variable of graph.variables ?? []) {
    const collection = collectionById.get(variable.collectionId)
    if (!collection) continue
    for (const mode of collection.modes ?? []) {
      if (Object.prototype.hasOwnProperty.call(variable.valuesByMode ?? {}, mode.modeId)) continue
      if (missingModeValues.length < MAX_MISSING_REPORTED) missingModeValues.push(`${variable.name} · ${mode.name}`)
    }
  }

  const named = (name: string) => collections.some((collection) => collection.name.trim().toLowerCase() === name)

  return {
    textStyleCount: textStyles.length,
    detachedTextStyles: detached,
    partiallyBoundTextStyles: partial,
    collections,
    singleModeCollections: collections.filter((collection) => collection.modes.length === 1).map((collection) => collection.name),
    missingModeValues,
    hasTypographyCollection: named('typography'),
    hasGeneratedTypographyCollection: collections.some((collection) => collection.generated),
    hasBreakpointCollection: named('breakpoints'),
  }
}

/** Audit → guardrail sentences. Empty when the file is clean, which is itself worth saying. */
export function auditGuardrails(audit: TokenAudit): string[] {
  const rules: string[] = []
  if (audit.textStyleCount > 0 && audit.detachedTextStyles > 0) {
    rules.push(
      `**WARNING — ${audit.detachedTextStyles}/${audit.textStyleCount} Figma text styles are not bound ` +
        'to variables.** Their font values were read off the style and frozen into the tokens below. ' +
        'Use the `typography/*` tokens as the source of truth; never hand-tune a font value in CSS.'
    )
  }
  if (audit.partiallyBoundTextStyles > 0) {
    rules.push(
      `${audit.partiallyBoundTextStyles} text style(s) are only partially bound to variables — some ` +
        'axes are literals. Treat every emitted typography token as authoritative anyway; do not ' +
        'mix token references with literal font values in one rule.'
    )
  }
  if (audit.missingModeValues.length > 0) {
    rules.push(
      `${audit.missingModeValues.length}${audit.missingModeValues.length >= 12 ? '+' : ''} variable/mode ` +
        `pair(s) have no value (${audit.missingModeValues.slice(0, 3).join(', ')}…) and fall back to the ` +
        'default mode. Do not rely on those tokens differing per theme.'
    )
  }
  if (!audit.hasTypographyCollection && audit.textStyleCount > 0) {
    rules.push(
      'There is no `Typography` variable collection — the type scale is derived from Figma text ' +
        'styles. Adding a font value that is not in the scale below breaks that derivation.'
    )
  }
  if (!audit.hasBreakpointCollection) {
    rules.push(
      'There is no `Breakpoints` variable collection — responsive widths are not tokenized. Use the ' +
        'breakpoints listed in this file (or the project defaults) and never introduce a new one.'
    )
  }
  return rules
}
