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
 */

export type ImportFormat = 'po' | 'json'

export interface TranslationEntry {
  /** Present only when the source carried a `figma://...node-id=...` PO reference. */
  nodeId?: string
  /** `''` when the entry has no explicit context. */
  msgctxt: string
  /** Original text (`.po` `msgid`, normalized). `''` for flat JSON entries. */
  msgid: string
  msgstr: string
}

const NODE_ID_REFERENCE = /figma:\/\/[^?]*\?node-id=([^\s]+)/

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

function parsePoBlock(block: string): TranslationEntry | null {
  const lines = block.split('\n')
  let msgctxt = ''
  let msgid = ''
  let msgstr = ''
  let nodeId: string | undefined
  let field: 'msgctxt' | 'msgid' | 'msgstr' | null = null

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
      // Plural forms are out of scope for T4.4's identity round-trip; skip their lines.
      field = null
      continue
    }
    if (trimmed.startsWith('msgid ')) {
      msgid = parseQuoted(trimmed)
      field = 'msgid'
      continue
    }
    if (trimmed.startsWith('msgstr[')) {
      field = null
      continue
    }
    if (trimmed.startsWith('msgstr ')) {
      msgstr = parseQuoted(trimmed)
      field = 'msgstr'
      continue
    }
    if (trimmed.startsWith('"') && field) {
      const continuation = parseQuoted(trimmed)
      if (field === 'msgctxt') msgctxt += continuation
      else if (field === 'msgid') msgid += continuation
      else msgstr += continuation
    }
  }

  // The header record (empty msgid, no context) carries catalog metadata, not a translation.
  if (msgid === '' && msgctxt === '') return null

  return { nodeId, msgctxt, msgid, msgstr }
}

function parsePo(content: string): TranslationEntry[] {
  return content
    .split(/\r?\n\s*\r?\n/)
    .map(parsePoBlock)
    .filter((entry): entry is TranslationEntry => entry !== null)
}

function parseJson(content: string): TranslationEntry[] {
  const data = JSON.parse(content) as Record<string, string>
  return Object.entries(data).map(([msgctxt, msgstr]) => ({ msgctxt, msgid: '', msgstr }))
}

export function parseTranslations(content: string, format: ImportFormat): TranslationEntry[] {
  return format === 'po' ? parsePo(content) : parseJson(content)
}
