/**
 * Translation import parsers (T4.4): turns a `.po` or `.json` file's contents into a flat list
 * of `TranslationEntry` records that `apply.ts` matches back onto TEXT nodes. Two source shapes:
 *
 * - `.po` — standard gettext catalog. `msgid` carries the original (English) text, so entries
 *   parsed here support the `(msgctxt, normalize(characters))` fallback match. A `#:` reference
 *   comment of the form `figma://<file>?node-id=<id>` (docs/research/03-i18n-figma-django.md
 *   §3.2/§3.3) is parsed into `nodeId` when the exporter wrote one.
 * - `.json` — flat `{ [i18nKey context]: translation }`, the shape produced once a string has an
 *   explicit `pluginData('i18nKey')` context (T4.2). There is no source text to fall back on, so
 *   these entries only resolve via nodeId/context matching.
 *
 * Plural entries (`msgid_plural`/`msgstr[0..nplurals-1]`) round-trip through a single `msgstr`:
 * a Figma TEXT node's `characters` is one fixed string, not a runtime count-aware choice, so the
 * form matching `n = 1` (evaluated against the catalog header's own `Plural-Forms` expression,
 * falling back to the English `nplurals=2; plural=(n != 1);` rule when the header carries none)
 * is the one written back. Any other count a real user sees at runtime is Django's own
 * `{% blocktranslate count %}` lookup against the compiled catalog — this only affects what the
 * Figma canvas itself shows for round-trip preview/editing purposes.
 */

import { evaluatePluralIndex, parsePluralFormsHeader, type PluralForms } from './plural-forms.ts'

export type ImportFormat = 'po' | 'json'

export interface TranslationEntry {
  /** Present only when the source carried a `figma://...node-id=...` PO reference. */
  nodeId?: string
  /** `''` when the entry has no explicit context. */
  msgctxt: string
  /** Original text (`.po` `msgid`, normalized). `''` for flat JSON entries. */
  msgid: string
  msgstr: string
  /** Present only when the source PO block carried `msgid_plural` — kept for reference; `msgstr`
   * is already resolved to the `n = 1` form (see module doc). */
  msgidPlural?: string
}

const NODE_ID_REFERENCE = /figma:\/\/[^?]*\?node-id=([^\s]+)/
const FALLBACK_PLURAL_FORMS: PluralForms = { nplurals: 2, expression: '(n != 1)' }

function unescapePoString(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default:
        return ch
    }
  })
}

/** Extracts a `"..."` string literal (with its escapes resolved) from a PO line's tail. */
function parseQuoted(line: string): string {
  const match = line.match(/"((?:[^"\\]|\\.)*)"/)
  return match ? unescapePoString(match[1]) : ''
}

interface ParsedBlock {
  isHeader: boolean
  nodeId?: string
  msgctxt: string
  msgid: string
  msgidPlural?: string
  msgstr: string
  pluralMsgstrs?: string[]
}

type ActiveField = 'msgctxt' | 'msgid' | 'msgid_plural' | 'msgstr' | number | null

function parsePoBlock(block: string): ParsedBlock | null {
  const lines = block.split('\n')
  let msgctxt = ''
  let msgid = ''
  let msgidPlural: string | undefined
  let msgstr = ''
  let nodeId: string | undefined
  const pluralMsgstrs: string[] = []
  let field: ActiveField = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    if (trimmed.startsWith('#:')) {
      const ref = trimmed.match(NODE_ID_REFERENCE)
      if (ref) nodeId = ref[1]
      field = null
      continue
    }
    if (trimmed.startsWith('#')) {
      field = null
      continue
    }
    if (trimmed.startsWith('msgctxt ')) {
      msgctxt = parseQuoted(trimmed)
      field = 'msgctxt'
      continue
    }
    if (trimmed.startsWith('msgid_plural')) {
      msgidPlural = parseQuoted(trimmed)
      field = 'msgid_plural'
      continue
    }
    if (trimmed.startsWith('msgid ')) {
      msgid = parseQuoted(trimmed)
      field = 'msgid'
      continue
    }
    const pluralForm = trimmed.match(/^msgstr\[(\d+)\]\s*(.*)$/)
    if (pluralForm) {
      const index = Number(pluralForm[1])
      pluralMsgstrs[index] = parseQuoted(trimmed)
      field = index
      continue
    }
    if (trimmed.startsWith('msgstr ')) {
      msgstr = parseQuoted(trimmed)
      field = 'msgstr'
      continue
    }
    if (trimmed.startsWith('"') && field !== null) {
      const continuation = parseQuoted(trimmed)
      if (field === 'msgctxt') msgctxt += continuation
      else if (field === 'msgid') msgid += continuation
      else if (field === 'msgid_plural') msgidPlural = (msgidPlural ?? '') + continuation
      else if (field === 'msgstr') msgstr += continuation
      else if (typeof field === 'number') pluralMsgstrs[field] = (pluralMsgstrs[field] ?? '') + continuation
    }
  }

  // The header record (empty msgid, no context, no plural) carries catalog metadata — its own
  // `Plural-Forms` line, not a translation — so it's returned tagged rather than dropped outright.
  const isHeader = msgid === '' && msgctxt === '' && msgidPlural === undefined
  if (isHeader) return { isHeader: true, nodeId, msgctxt, msgid, msgstr }

  return { isHeader: false, nodeId, msgctxt, msgid, msgidPlural, msgstr, ...(pluralMsgstrs.length > 0 ? { pluralMsgstrs } : {}) }
}

function parsePo(content: string): TranslationEntry[] {
  const blocks = content.split(/\r?\n\s*\r?\n/)
  let pluralForms: PluralForms | null = null
  const entries: TranslationEntry[] = []

  for (const block of blocks) {
    const parsed = parsePoBlock(block)
    if (!parsed) continue

    if (parsed.isHeader) {
      pluralForms = parsePluralFormsHeader(parsed.msgstr)
      continue
    }

    const { nodeId, msgctxt, msgid, msgidPlural, msgstr, pluralMsgstrs } = parsed
    if (pluralMsgstrs && msgidPlural !== undefined) {
      const forms = pluralForms ?? FALLBACK_PLURAL_FORMS
      const formIndex = evaluatePluralIndex(forms.expression, 1)
      const resolved = pluralMsgstrs[formIndex] ?? pluralMsgstrs[0] ?? ''
      entries.push({ nodeId, msgctxt, msgid, msgstr: resolved, msgidPlural })
      continue
    }

    entries.push({ nodeId, msgctxt, msgid, msgstr })
  }

  return entries
}

function parseJson(content: string): TranslationEntry[] {
  const data = JSON.parse(content) as Record<string, string>
  return Object.entries(data).map(([msgctxt, msgstr]) => ({ msgctxt, msgid: '', msgstr }))
}

export function parseTranslations(content: string, format: ImportFormat): TranslationEntry[] {
  return format === 'po' ? parsePo(content) : parseJson(content)
}
