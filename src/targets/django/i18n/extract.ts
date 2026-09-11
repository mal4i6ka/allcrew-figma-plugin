/**
 * String extraction (T4.1): walks TEXT nodes and derives one or more catalog entries per node,
 * dedupes by `(msgctxt, text)`, and carries node metadata (figma-URL, layer path, layer name) as
 * PO `#:`/`#.` comment material for the T4.3 exporter. See docs/research/03-i18n-figma-django.md
 * §1.1-1.2, §3.1-3.2.
 *
 * A node's style runs decide the shape:
 *
 * - Exactly one run (no paragraph break, one style range): `resolveKey` (keys.ts) derives the
 *   whole node's key — a bound STRING variable, a manual `pluginData('i18nKey')` annotation
 *   (context/placeholders/plural), or the plain normalized text. This is the one `{% translate %}`
 *   /`{% blocktranslate %}` tag `html-emitter.ts`'s `renderTextBlock` emits for that shape.
 * - More than one run (bold/link spans, and/or a hard line break): `html-emitter.ts`'s
 *   `renderSegmentSpan` wraps EACH run in its own `{% translate %}` tag, so extraction emits one
 *   plain-text entry per run too — a single combined entry (this module used to build one with
 *   inline `<strong>`/`<a>` markup) would carry text the templates never actually render as one
 *   string. Rich multi-run text is out of scope for `resolveKey`'s variable/placeholder/plural
 *   machinery (those are whole-string concepts); only the node's own manual `msgctxt`, if any,
 *   carries over to every run.
 */

import { findAllWithCriteria } from '../../../utils/tree.ts'
import { TEXT_SEGMENT_FIELDS, splitTextParagraphs, type TextStyleSegment } from '../text-styles.ts'
import { getAnnotation } from './annotation.ts'
import { resolveKey } from './keys.ts'
import { translationKey } from './normalize.ts'
import { normalizeSegmentText } from './segment-text.ts'

export interface ExtractedEntry {
  msgid: string
  /** `''` when the node carries no `pluginData('i18nKey')` context. */
  msgctxt: string
  /** Plural "other" form — present only for a single-run node with a manual plural annotation
   * (`keys.ts`'s `resolveKey`). */
  msgidPlural?: string
  /** Inline markup a hand-authored `ExtractedEntry` may carry for `po.ts`'s benefit; extraction
   * itself never populates this — see the module doc for why a combined multi-run string no
   * longer matches what the templates render. */
  markup: string | null
  /** `#:` reference comments: one `figma://<fileKey>?node-id=<id> <layer path>` per source node. */
  references: string[]
  /** `#.` extracted comment for translators: the distinct layer name(s) behind this entry. */
  comment: string
  /** Source node ids, for round-trip matching (T4.4). */
  nodeIds: string[]
}

export interface ExtractStringsOptions {
  /** Passed through to `resolveKey` for bound STRING variables — the variable-collection mode
   * name treated as the source-of-truth locale. Default `'en'`. */
  sourceLocale?: string
}

interface NodeEntry {
  msgid: string
  msgctxt: string
  msgidPlural?: string
  dedupeKey: string
}

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

/** Every `(paragraph × style-run)` slice `getStyledTextSegments(TEXT_SEGMENT_FIELDS)` +
 * `splitTextParagraphs` produces — the same split `html-emitter.ts` renders one `{% translate %}`
 * tag per, whether or not the node is "multi-block" (a single paragraph with several style runs
 * still gets one tag per run; see `renderTextBlock`/`renderTextSpans`). */
function styleRuns(node: TextNode): TextStyleSegment[] {
  const segments = node.getStyledTextSegments([...TEXT_SEGMENT_FIELDS]) as unknown as TextStyleSegment[]
  const paragraphs = splitTextParagraphs(segments)
  const runs: TextStyleSegment[] = []
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) runs.push(run.segment)
  }
  return runs
}

async function extractNodeEntries(node: TextNode, sourceLocale: string): Promise<NodeEntry[]> {
  const runs = styleRuns(node)

  if (runs.length <= 1) {
    const key = await resolveKey(node, { sourceLocale })
    if (!key.msgid) return []
    return [{ msgid: key.msgid, msgctxt: key.msgctxt, msgidPlural: key.msgidPlural, dedupeKey: translationKey(key.msgctxt, key.msgid) }]
  }

  const msgctxt = getAnnotation(node)?.context ?? ''
  const entries: NodeEntry[] = []
  for (const run of runs) {
    const msgid = normalizeSegmentText(run.characters)
    if (!msgid) continue
    entries.push({ msgid, msgctxt, dedupeKey: translationKey(msgctxt, msgid) })
  }
  return entries
}

export async function extractStrings(root: BaseNode, options: ExtractStringsOptions = {}): Promise<ExtractedEntry[]> {
  const sourceLocale = options.sourceLocale ?? 'en'
  const textNodes = await findAllWithCriteria(root, isTextNode)
  const catalog = new Map<string, ExtractedEntry>()

  for (const node of textNodes) {
    const nodeEntries = await extractNodeEntries(node, sourceLocale)
    if (nodeEntries.length === 0) continue

    const ref = reference(node)
    for (const nodeEntry of nodeEntries) {
      const existing = catalog.get(nodeEntry.dedupeKey)
      if (existing) {
        if (!existing.references.includes(ref)) existing.references.push(ref)
        if (!existing.nodeIds.includes(node.id)) existing.nodeIds.push(node.id)
        if (!existing.comment.includes(node.name)) existing.comment += `; ${node.name}`
        continue
      }

      catalog.set(nodeEntry.dedupeKey, {
        msgid: nodeEntry.msgid,
        msgctxt: nodeEntry.msgctxt,
        ...(nodeEntry.msgidPlural ? { msgidPlural: nodeEntry.msgidPlural } : {}),
        markup: null,
        references: [ref],
        comment: node.name,
        nodeIds: [node.id],
      })
    }
  }

  return [...catalog.values()]
}

