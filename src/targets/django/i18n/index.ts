/**
 * Single entry point for translation import (T4.4): PO/JSON -> node lookup -> text substitution
 * -> overflow report. Wiring this into an actual "Import translations" UI action/file picker is
 * T6.1's job; this module only implements the pipeline that command will call.
 */

import { parseTranslations, type ImportFormat } from './import.ts'
import { buildNodeIndex } from './node-index.ts'
import { applyTranslations, type ApplyResult } from './apply.ts'
import { detectOverflows, type OverflowReport } from './overflow-report.ts'

export type { TranslationEntry, ImportFormat } from './import.ts'
export type { NodeIndex } from './node-index.ts'
export type { AppliedTranslation, SkippedTranslation, ApplyResult } from './apply.ts'
export type { OverflowReport } from './overflow-report.ts'

export interface ImportTranslationsResult extends ApplyResult {
  overflows: OverflowReport[]
}

export async function importTranslations(
  content: string,
  format: ImportFormat,
  textNodes: readonly TextNode[]
): Promise<ImportTranslationsResult> {
  const entries = parseTranslations(content, format)
  const index = buildNodeIndex(textNodes)
  const { applied, skipped } = await applyTranslations(entries, index)
  const overflows = detectOverflows(applied.map((a) => a.node))
  return { applied, skipped, overflows }
}
