/**
 * `figma.po` emitter (T6.2, docs/research/03-i18n-figma-django.md §3.3): serializes the T4.1
 * `ExtractedEntry[]` catalog into a gettext `.po` file for the export pipeline's `locale/figma.po`.
 * Hand-rolled (no `gettext-parser` dependency) to stay symmetric with `import.ts`'s hand-rolled
 * reader — every field this writes is one `import.ts`'s `parseTranslations('po', ...)` reads back.
 * `msgstr` is always `""`: this file is a source-language extraction (a de-facto `.pot`), not a
 * translation — filling `msgstr` per locale and merging into `django.po` is T4.3's `msgmerge` step.
 */

import type { ExtractedEntry } from './extract.ts'

const HEADER = [
  'msgid ""',
  'msgstr ""',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"',
].join('\n')

function escapePoString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function quoted(value: string): string {
  return `"${escapePoString(value)}"`
}

/** One entry's PO block: `#.` extracted comment, `#:` references, optional `msgctxt`, `msgid`, empty `msgstr`. */
function emitEntry(entry: ExtractedEntry): string {
  const lines: string[] = []
  if (entry.comment) lines.push(`#. ${entry.comment}`)
  for (const reference of entry.references) lines.push(`#: ${reference}`)
  if (entry.msgctxt) lines.push(`msgctxt ${quoted(entry.msgctxt)}`)
  // Inline markup (docs §3.2) is the string a translator actually sees/edits in a blocktranslate
  // context — falls back to the plain msgid when the text carries a single style run.
  lines.push(`msgid ${quoted(entry.markup ?? entry.msgid)}`)
  lines.push('msgstr ""')
  return lines.join('\n')
}

/** Emits a complete `.po` file: catalog header, then one block per entry, in input order. */
export function emitPo(entries: readonly ExtractedEntry[]): string {
  return [HEADER, ...entries.map(emitEntry)].join('\n\n') + '\n'
}
