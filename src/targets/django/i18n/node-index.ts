/**
 * Reverse lookup over the document's TEXT nodes for translation import (T4.4): built once per
 * import so `apply.ts` can resolve each `TranslationEntry` without re-walking the tree per entry.
 * Three maps mirror the Definition of Done's fallback order (nodeId -> pluginData context ->
 * normalized text), see docs/research/03-i18n-figma-django.md §3.4.
 */

import { getPluginData, PluginDataKey } from '../../../utils/plugin-data.ts'
import { translationKey } from './normalize.ts'

export interface NodeIndex {
  byNodeId: ReadonlyMap<string, TextNode>
  byContext: ReadonlyMap<string, TextNode>
  byText: ReadonlyMap<string, TextNode>
}

export function buildNodeIndex(textNodes: readonly TextNode[]): NodeIndex {
  const byNodeId = new Map<string, TextNode>()
  const byContext = new Map<string, TextNode>()
  const byText = new Map<string, TextNode>()

  for (const node of textNodes) {
    byNodeId.set(node.id, node)

    const key = getPluginData<{ context?: string }>(node, PluginDataKey.I18N_KEY)
    const context = key?.context ?? ''
    if (context) byContext.set(context, node)

    byText.set(translationKey(context, node.characters), node)
  }

  return { byNodeId, byContext, byText }
}
