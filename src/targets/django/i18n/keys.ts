/**
 * Key derivation for string extraction (T4.2): decides a node's `(msgid, msgctxt)` — and
 * `msgidPlural` when annotated — from Figma's own key mechanisms, in the priority order
 * docs/research/03-i18n-figma-django.md §3.1 lays out:
 *
 *   1. `boundVariables.characters` (a bound STRING variable) — its name is a ready-made key;
 *      the source-locale mode's value becomes msgid (§1.4).
 *   2. manual `pluginData('i18nKey')` annotation (the T4.2 annotation panel) — the node's own
 *      text becomes msgid (or the plural forms, if annotated), the context becomes msgctxt.
 *   3. default — msgid is the node's normalized text, no msgctxt.
 *
 * Consumed by string extraction (T4.1) and PO export (T4.3); this module only derives the key
 * per node, it does not walk the tree or write PO.
 */

import { getAnnotation, type PlaceholderAnnotation } from './annotation.ts'
import { normalize } from './normalize.ts'

export type KeySource = 'variable' | 'manual' | 'text'

export interface ResolvedKey {
  msgid: string
  msgctxt: string
  msgidPlural?: string
  source: KeySource
  /** Set only when `source === 'variable'`: the bound variable's full name, for `#.` comments. */
  variableName?: string
}

/** Splits a `context/name` variable-name convention into its msgctxt part; `''` when absent. */
function contextFromVariableName(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash >= 0 ? name.slice(0, slash) : ''
}

/** Replaces annotated ranges of `text` with gettext placeholders: `%(name)s`. */
export function applyPlaceholders(text: string, placeholders: readonly PlaceholderAnnotation[] | undefined): string {
  if (!placeholders || placeholders.length === 0) return text

  const sorted = [...placeholders].sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  for (const ph of sorted) {
    result += text.slice(cursor, ph.start)
    result += `%(${ph.name})s`
    cursor = ph.end
  }
  result += text.slice(cursor)
  return result
}

function resolveManualKey(node: TextNode): ResolvedKey {
  const annotation = getAnnotation(node)
  const msgctxt = annotation?.context ?? ''

  if (annotation?.plural) {
    return {
      msgid: normalize(annotation.plural.one),
      msgidPlural: normalize(annotation.plural.other),
      msgctxt,
      source: msgctxt ? 'manual' : 'text',
    }
  }

  const msgid = applyPlaceholders(normalize(node.characters), annotation?.placeholders)
  return { msgid, msgctxt, source: msgctxt ? 'manual' : 'text' }
}

async function resolveVariableKey(alias: VariableAlias, sourceLocale: string): Promise<ResolvedKey | null> {
  const variable = await figma.variables.getVariableByIdAsync(alias.id)
  if (!variable || variable.resolvedType !== 'STRING') return null

  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
  const mode = collection?.modes.find((m) => m.name === sourceLocale) ?? collection?.modes[0]
  const rawValue = mode ? variable.valuesByMode[mode.modeId] : undefined

  return {
    msgid: typeof rawValue === 'string' ? normalize(rawValue) : '',
    msgctxt: contextFromVariableName(variable.name),
    source: 'variable',
    variableName: variable.name,
  }
}

export interface ResolveKeyOptions {
  /** Name of the variable-collection mode treated as the source-of-truth locale. Default `'en'`. */
  sourceLocale?: string
}

export async function resolveKey(node: TextNode, options: ResolveKeyOptions = {}): Promise<ResolvedKey> {
  const alias = node.boundVariables?.characters
  if (alias) {
    const variableKey = await resolveVariableKey(alias, options.sourceLocale ?? 'en')
    if (variableKey) return variableKey
  }

  return resolveManualKey(node)
}
