/**
 * The exact text transform `html-emitter.ts`'s `wrapTranslatable` applies to a styled-text run
 * before wrapping it in `{% translate %}`/`{% blocktranslate %}`: collapse Figma's embedded line
 * separators to a single space, without touching ordinary spacing. Extracted here so
 * `extract.ts` can compute a per-run msgid that is byte-identical to the string the template
 * actually carries — deliberately NOT `normalize()` (normalize.ts), which also trims the ends
 * and collapses repeated spaces. Trimming would desync neighboring run boundaries: a node whose
 * runs are `"Read "` + `"docs"` needs that trailing space kept, or the two adjacent `<span>`s
 * render back-to-back with no gap between them.
 *
 * `html-emitter.ts` (owned by Main) must import this instead of re-implementing the regex, so
 * the two sides can never drift apart again.
 */

const LINE_SEPARATOR_RUN = /\s*[\r\n\u2028\u2029]+\s*/g

export function normalizeSegmentText(characters: string): string {
  return characters.replace(LINE_SEPARATOR_RUN, ' ')
}
