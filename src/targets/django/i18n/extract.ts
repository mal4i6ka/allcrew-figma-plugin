/**
 * String extraction (T4.1): walks TEXT nodes, normalizes whitespace, dedupes by
 * `(msgctxt, text)`, turns `getStyledTextSegments` runs into inline `<strong>`/`<a>` markup,
 * and carries node metadata (figma-URL, layer path, layer name) as PO `#:`/`#.` comment
 * material for the T4.3 exporter. See docs/research/03-i18n-figma-django.md §1.1-1.2, §3.1-3.2.
 */

import { findAllWithCriteria } from '../../../utils/tree.ts'
import { getPluginData, PluginDataKey } from '../../../utils/plugin-data.ts'
import { normalize, translationKey } from './normalize.ts'

export interface ExtractedEntry {
  msgid: string
  /** `''` when the node carries no `pluginData('i18nKey')` context. */
  msgctxt: string
  /** Inline `<strong>`/`<a>` markup built from `getStyledTextSegments`; `null` for a single style run. */
  markup: string | null
  /** `#:` reference comments: one `figma://<fileKey>?node-id=<id> <layer path>` per source node. */
  references: string[]
  /** `#.` extracted comment for translators: the distinct layer name(s) behind this entry. */
  comment: string
  /** Source node ids, for round-trip matching (T4.4). */
  nodeIds: string[]
}

const MARKUP_SEGMENT_FIELDS = ['fontWeight', 'hyperlink'] as const

function isTextNode(node: SceneNode): node is TextNode {
  return node.type === 'TEXT'
}

function nodePath(node: BaseNode): string {
  const parts: string[] = []
  let cur: BaseNode | null = node
  while (cur && cur.type !== 'DOCUMENT') {
    parts.unshift(cur.name)
    cur = 'parent' in cur ? cur.parent : null
  }
  return parts.join('/')
}

function reference(node: TextNode): string {
  const fileKey = figma.fileKey
  return `figma://${fileKey ?? ''}?node-id=${node.id} ${nodePath(node)}`
}

function buildMarkup(node: TextNode): { markup: string | null; hasInlineStyles: boolean } {
  const segments = node.getStyledTextSegments([...MARKUP_SEGMENT_FIELDS])
  if (segments.length <= 1) return { markup: null, hasInlineStyles: false }

  const baseWeight = Math.min(...segments.map((s) => s.fontWeight))
  let markup = ''
  for (const segment of segments) {
    let chunk = segment.characters
    if (segment.hyperlink?.type === 'URL') {
      chunk = `<a href="${segment.hyperlink.value}">${chunk}</a>`
    } else if (segment.fontWeight > baseWeight) {
      chunk = `<strong>${chunk}</strong>`
    }
    markup += chunk
  }
  return { markup: normalize(markup), hasInlineStyles: true }
}

export async function extractStrings(root: BaseNode): Promise<ExtractedEntry[]> {
  const textNodes = await findAllWithCriteria(root, isTextNode)
  const catalog = new Map<string, ExtractedEntry>()

  for (const node of textNodes) {
    const msgid = normalize(node.characters)
    if (!msgid) continue

    const key = getPluginData<{ context?: string }>(node, PluginDataKey.I18N_KEY)
    const msgctxt = key?.context ?? ''
    const dedupeKey = translationKey(msgctxt, node.characters)

    const existing = catalog.get(dedupeKey)
    if (existing) {
      existing.references.push(reference(node))
      existing.nodeIds.push(node.id)
      if (!existing.comment.includes(node.name)) existing.comment += `; ${node.name}`
      continue
    }

    const { markup } = buildMarkup(node)
    catalog.set(dedupeKey, {
      msgid,
      msgctxt,
      markup,
      references: [reference(node)],
      comment: node.name,
      nodeIds: [node.id],
    })
  }

  return [...catalog.values()]
}
