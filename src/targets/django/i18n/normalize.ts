/**
 * Whitespace normalization shared by string extraction (T4.1, export) and translation import
 * (T4.4): collapses Figma's paragraph separators and layout-driven soft wraps so the same
 * source text produces the same lookup key on both sides of the round-trip.
 * See docs/research/03-i18n-figma-django.md, section 3.1.
 */

/** U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR, as seen in pasted Figma text content. */
const FIGMA_LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g')

export function normalize(characters: string): string {
  return characters
    .replace(FIGMA_LINE_SEPARATORS, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Gettext's own msgctxt/msgid separator inside compiled catalogs (ASCII EOT), reused as the join char. */
const CONTEXT_SEPARATOR = String.fromCharCode(0x04)

/** Composite lookup key matching the Definition of Done's `(msgctxt, normalize(characters))` fallback tier. */
export function translationKey(msgctxt: string, characters: string): string {
  return `${msgctxt}${CONTEXT_SEPARATOR}${normalize(characters)}`
}
