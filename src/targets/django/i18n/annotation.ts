/**
 * Manual i18n annotations (T4.2): the data a designer/developer attaches to a TEXT node through
 * the annotation UI panel (`plugin/src/annotation-panel.ts`) — context, plural forms, and
 * placeholder ranges. Stored under the same `pluginData('i18nKey')` blob `node-index.ts` already
 * reads for `context` (docs/research/03-i18n-figma-django.md §1.5/§3.1), so this module only adds
 * validated read/write helpers and the plural/placeholder fields on top of that existing shape.
 */

import { getPluginData, setPluginData, PluginDataKey } from '../../../utils/plugin-data.ts'

export interface PlaceholderAnnotation {
  /** Start offset into `node.characters`, inclusive. */
  start: number
  /** End offset into `node.characters`, exclusive. */
  end: number
  /** Becomes the gettext placeholder name: `%(name)s`. */
  name: string
}

export interface PluralAnnotation {
  /** English singular form, e.g. `"%(count)d item"`. */
  one: string
  /** English plural form, e.g. `"%(count)d items"`. */
  other: string
}

export interface I18nAnnotation {
  /** Manual `msgctxt`, disambiguating homonyms (docs §2.1's `pgettext`). */
  context?: string
  plural?: PluralAnnotation
  placeholders?: PlaceholderAnnotation[]
}

const PLACEHOLDER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function getAnnotation(node: BaseNode): I18nAnnotation | null {
  return getPluginData<I18nAnnotation>(node, PluginDataKey.I18N_KEY)
}

/** Throws on invalid placeholder names/ranges or an incomplete plural pair, rather than storing bad data. */
export function validateAnnotation(annotation: I18nAnnotation, textLength: number): void {
  if (annotation.plural) {
    if (!annotation.plural.one || !annotation.plural.other) {
      throw new Error('plural annotation requires both "one" and "other" forms')
    }
  }

  if (annotation.placeholders) {
    const sorted = [...annotation.placeholders].sort((a, b) => a.start - b.start)
    let cursor = 0
    for (const ph of sorted) {
      if (!PLACEHOLDER_NAME.test(ph.name)) {
        throw new Error(`invalid placeholder name "${ph.name}"`)
      }
      if (ph.start < 0 || ph.end > textLength || ph.start >= ph.end) {
        throw new Error(`placeholder "${ph.name}" has an out-of-range offset`)
      }
      if (ph.start < cursor) {
        throw new Error(`placeholder "${ph.name}" overlaps a preceding placeholder`)
      }
      cursor = ph.end
    }
  }
}

export function setAnnotation(node: TextNode, annotation: I18nAnnotation): void {
  validateAnnotation(annotation, node.characters.length)
  setPluginData(node, PluginDataKey.I18N_KEY, annotation)
}
