/**
 * Text substitution step (T4.4): resolves each `TranslationEntry` to a live TextNode via
 * `node-index`'s tiered lookup (nodeId -> pluginData context -> normalized text), pre-loads
 * fonts before writing (docs/research/03-i18n-figma-django.md §1.3), and backs up the
 * pre-translation text so a later locale switch can restore the original.
 */

import { getPluginData, setPluginData, PluginDataKey } from '../../../utils/plugin-data.ts'
import { translationKey } from './normalize.ts'
import type { TranslationEntry } from './import.ts'
import type { NodeIndex } from './node-index.ts'

export interface AppliedTranslation {
  nodeId: string
  node: TextNode
}

export interface SkippedTranslation {
  entry: TranslationEntry
  reason: 'not-found' | 'missing-font'
}

export interface ApplyResult {
  applied: AppliedTranslation[]
  skipped: SkippedTranslation[]
}

function resolveNode(entry: TranslationEntry, index: NodeIndex): TextNode | undefined {
  if (entry.nodeId) {
    const byId = index.byNodeId.get(entry.nodeId)
    if (byId) return byId
  }
  if (entry.msgctxt) {
    const byContext = index.byContext.get(entry.msgctxt)
    if (byContext) return byContext
  }
  if (entry.msgid) {
    return index.byText.get(translationKey(entry.msgctxt, entry.msgid))
  }
  return undefined
}

export async function applyTranslations(entries: readonly TranslationEntry[], index: NodeIndex): Promise<ApplyResult> {
  const applied: AppliedTranslation[] = []
  const skipped: SkippedTranslation[] = []

  for (const entry of entries) {
    const node = resolveNode(entry, index)
    if (!node) {
      skipped.push({ entry, reason: 'not-found' })
      continue
    }
    if (node.hasMissingFont) {
      skipped.push({ entry, reason: 'missing-font' })
      continue
    }

    const fonts = node.getRangeAllFontNames(0, node.characters.length)
    await Promise.all(fonts.map((font) => figma.loadFontAsync(font)))

    if (getPluginData<string>(node, PluginDataKey.I18N_ORIGINAL) === null) {
      setPluginData(node, PluginDataKey.I18N_ORIGINAL, node.characters)
    }
    node.characters = entry.msgstr

    applied.push({ nodeId: node.id, node })
  }

  return { applied, skipped }
}
