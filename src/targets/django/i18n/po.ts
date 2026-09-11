/**
 * PO catalog emitter (T6.2, docs/research/03-i18n-figma-django.md §3.3): serializes the T4.1
 * `ExtractedEntry[]` catalog into gettext `.po` files. Hand-rolled (no `gettext-parser`
 * dependency) to stay symmetric with `import.ts`'s hand-rolled reader — every field this writes
 * is one `import.ts`'s `parseTranslations('po', ...)` reads back.
 *
 * `emitPo` alone (no `options`) produces the source-language extraction — a de-facto `.pot`,
 * `msgstr` always `""` — for the export pipeline's `locale/figma.po`. `emitLocaleCatalogs` builds
 * on it to produce one blank, translator-ready catalog per target language under
 * `locale/<lang>/LC_MESSAGES/django.po`, each with a header whose `Plural-Forms` matches that
 * language's own grammar (not the source's) — `msgfmt`/`msgmerge` expect exactly that shape when
 * a translator later fills in `msgstr[n]`.
 */

import type { ExtractedEntry } from './extract.ts'
import { pluralFormsFor, pluralFormsHeaderLine, type PluralForms } from './plural-forms.ts'

export interface PoCatalogOptions {
  /** Target locale this catalog is for — becomes the header's `Language:` and drives which
   * language's `Plural-Forms` rule is emitted. */
  readonly language: string
  /** Locale the `msgid`/`msgid_plural` text is written in. Only used to pick a `Plural-Forms`
   * rule when `language` itself is absent (the plain `locale/figma.po` extraction case). */
  readonly sourceLanguage: string
}

function escapePoString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function quoted(value: string): string {
  return `"${escapePoString(value)}"`
}

/** The header fields `msgfmt --check` insists on. No real `POT-Creation-Date`/`PO-Revision-Date`
 * timestamp: it would make byte-identical re-exports impossible and nothing here reads it back —
 * the standard `YEAR-MO-DA HO:MI+ZONE` template placeholder satisfies the check instead, exactly
 * as `xgettext`'s own output does before a translator touches the file. */
function buildHeader(options: Partial<PoCatalogOptions> | undefined, forms: PluralForms): string {
  const language = options?.language ?? options?.sourceLanguage
  const lines = [
    'msgid ""',
    'msgstr ""',
    quoted('Project-Id-Version: Figma export\n'),
    quoted('PO-Revision-Date: YEAR-MO-DA HO:MI+ZONE\n'),
    quoted('Last-Translator: FULL NAME <EMAIL@ADDRESS>\n'),
    quoted(`Language-Team: ${language ?? 'LANGUAGE'} <LL@li.org>\n`),
  ]
  if (language) lines.push(quoted(`Language: ${language}\n`))
  lines.push(
    quoted('MIME-Version: 1.0\n'),
    quoted('Content-Type: text/plain; charset=UTF-8\n'),
    quoted('Content-Transfer-Encoding: 8bit\n'),
    quoted(`${pluralFormsHeaderLine(forms)}\n`)
  )
  return lines.join('\n')
}

/** One entry's PO block: `#.` extracted comment, `#:` references, optional `msgctxt`, `msgid`
 * (plus `msgid_plural`/indexed `msgstr[n]` when the entry carries a plural form), empty `msgstr`. */
function emitEntry(entry: ExtractedEntry, nplurals: number): string {
  const lines: string[] = []
  if (entry.comment) lines.push(`#. ${entry.comment}`)
  for (const reference of entry.references) lines.push(`#: ${reference}`)
  if (entry.msgctxt) lines.push(`msgctxt ${quoted(entry.msgctxt)}`)

  // Inline markup (docs §3.2) is the string a translator actually sees/edits in a blocktranslate
  // context — falls back to the plain msgid when the entry carries no such markup.
  lines.push(`msgid ${quoted(entry.markup ?? entry.msgid)}`)

  if (entry.msgidPlural) {
    lines.push(`msgid_plural ${quoted(entry.msgidPlural)}`)
    for (let index = 0; index < nplurals; index++) lines.push(`msgstr[${index}] ""`)
  } else {
    lines.push('msgstr ""')
  }

  return lines.join('\n')
}

/** Emits a complete `.po` file: catalog header, then one block per entry, in input order.
 * `options` is optional — omitted, this is the plain source-language extraction
 * (`locale/figma.po`); with `language` set, it's one of `emitLocaleCatalogs`'s per-locale files. */
export function emitPo(entries: readonly ExtractedEntry[], options?: Partial<PoCatalogOptions>): string {
  const forms = pluralFormsFor(options?.language ?? options?.sourceLanguage ?? 'en')
  const header = buildHeader(options, forms)
  return [header, ...entries.map((entry) => emitEntry(entry, forms.nplurals))].join('\n\n') + '\n'
}

/** Builds one blank, translator-ready catalog per target language (every entry from `entries`,
 * `msgstr`s empty) — every language in `languages` except `sourceLanguage` itself, which needs no
 * catalog since its strings already live in the templates. Keys are sorted so the output is
 * stable across runs regardless of `languages`' input order. */
export function emitLocaleCatalogs(
  entries: readonly ExtractedEntry[],
  languages: readonly string[],
  sourceLanguage: string
): Record<string, string> {
  const targets = [...new Set(languages)].filter((language) => language !== sourceLanguage).sort()
  const files: Record<string, string> = {}
  for (const language of targets) {
    files[`locale/${language}/LC_MESSAGES/django.po`] = emitPo(entries, { language, sourceLanguage })
  }
  return files
}
