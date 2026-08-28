/**
 * Turning a UI reply into something an agent can afford to read.
 *
 * The plugin's commands answer the *iframe*, which can hold a whole export in memory and hand
 * it to JSZip. An agent cannot: `CONFIRM_EXPORT` alone replies with every generated file, and
 * `SCAN_TOKENS` with the entire token package. Relaying that verbatim would spend a context
 * window on one call.
 *
 * So a reply is digested, not forwarded: scalars survive, long strings become files on the
 * agent's disk (the `__alteryFile` envelope the bridge materialises — see `files.ts`), big
 * collections become a count and a sample, and a burst of identical progress messages
 * collapses to its first and last. Everything that gets dropped says so in place, because a
 * silent truncation reads as "that's all there was".
 */

import { isSafeFileName, textFile } from './files.ts'

export interface DigestBudget {
  /** Strings up to this length are quoted verbatim; longer ones spill to a file. */
  keep: number
  maxFiles: number
  maxBytes: number
}

export const DEFAULT_DIGEST_BUDGET: DigestBudget = { keep: 400, maxFiles: 60, maxBytes: 4_000_000 }

export interface DigestResult {
  replies: unknown[]
  /** How many replies were folded away by the progress collapse. */
  collapsed: number
  files: number
  /** True when a budget ran out, so the caller can say the answer is partial. */
  truncated: boolean
}

const MAX_DEPTH = 5
const MAX_ARRAY = 12
const MAX_KEYS = 24

/** Channel traffic, not a command's answer — an agent's own request/response never belongs in
 * the digest of what the command did. */
const CHANNEL_TYPES = ['AGENT_REQUEST', 'AGENT_RESPONSE', 'AGENT_GATES', 'AGENT_ACTIVITY']

export function digestReplies(
  replies: readonly unknown[],
  budget: DigestBudget = DEFAULT_DIGEST_BUDGET
): DigestResult {
  const state = { files: 0, bytes: 0, truncated: false, names: new Set<string>() }
  const own = replies.filter((reply) => !CHANNEL_TYPES.includes(typeOf(reply) ?? ''))

  const out: unknown[] = []
  let collapsed = 0
  for (let index = 0; index < own.length; index++) {
    const type = typeOf(own[index])
    // A document walk posts progress on every 200th node. The first tells the agent what the
    // command started doing and the last how far it got; the hundreds in between are a
    // spinner, and a spinner does not belong in a transcript.
    let runEnd = index
    while (runEnd + 1 < own.length && type !== null && typeOf(own[runEnd + 1]) === type) runEnd++
    if (runEnd > index + 1) {
      out.push(digestValue(own[index], 0, budget, state))
      out.push({ type, repeated: runEnd - index - 1, note: 'identical replies omitted' })
      out.push(digestValue(own[runEnd], 0, budget, state))
      collapsed += runEnd - index - 1
      index = runEnd
      continue
    }
    out.push(digestValue(own[index], 0, budget, state))
  }

  return { replies: out, collapsed, files: state.files, truncated: state.truncated }
}

function typeOf(reply: unknown): string | null {
  if (typeof reply !== 'object' || reply === null) return null
  const type = (reply as Record<string, unknown>).type
  return typeof type === 'string' ? type : null
}

interface State {
  files: number
  bytes: number
  truncated: boolean
  names: Set<string>
}

function digestValue(value: unknown, depth: number, budget: DigestBudget, state: State, key = ''): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return digestString(value, budget, state, key)
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`

  if (value instanceof Uint8Array) {
    state.truncated = true
    return { bytes: value.length, note: 'binary omitted' }
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return { count: value.length, note: 'nested too deep to show' }
    }
    if (value.length > MAX_ARRAY) {
      state.truncated = true
      return {
        count: value.length,
        sample: value.slice(0, 3).map((entry) => digestValue(entry, depth + 1, budget, state, key)),
        note: `showing 3 of ${value.length}`,
      }
    }
    return value.map((entry) => digestValue(entry, depth + 1, budget, state, key))
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (depth >= MAX_DEPTH) {
    state.truncated = true
    return { keys: keys.length, note: 'nested too deep to show' }
  }
  if (keys.length > MAX_KEYS) {
    // A file map (`{ 'css/tokens.css': '…' }`) lands here. Its keys are the interesting part —
    // the agent asks for one by name afterwards — so name them and spill nothing.
    state.truncated = true
    return { keys: keys.length, names: keys.slice(0, MAX_KEYS), note: `showing ${MAX_KEYS} of ${keys.length}` }
  }

  const out: Record<string, unknown> = {}
  for (const entry of keys) {
    out[entry] = digestValue(record[entry], depth + 1, budget, state, entry)
  }
  return out
}

function digestString(value: string, budget: DigestBudget, state: State, key: string): unknown {
  if (value.length <= budget.keep) return value

  if (state.files < budget.maxFiles && state.bytes + value.length <= budget.maxBytes) {
    const name = fileNameFor(key, state.names)
    if (name) {
      state.files++
      state.bytes += value.length
      state.names.add(name)
      return textFile(name, mimeFor(name), value)
    }
  }

  state.truncated = true
  return { chars: value.length, head: value.slice(0, budget.keep), note: 'truncated' }
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  css: 'text/css',
  csv: 'text/csv',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  po: 'text/x-gettext-translation',
  scss: 'text/x-scss',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  xml: 'application/xml',
}

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'text/plain'
}

/**
 * A name the bridge will accept, derived from where the string sat in the reply. Keys are
 * paths as often as they are identifiers (`static/css/tokens.css`), so the separators fold
 * into the name rather than climbing out of the directory the bridge picked.
 */
function fileNameFor(key: string, taken: ReadonlySet<string>): string | null {
  const dot = key.lastIndexOf('.')
  const ext = dot > 0 ? key.slice(dot + 1).toLowerCase() : ''
  const stem = dot > 0 ? key.slice(0, dot) : key
  const slug = stem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).toLowerCase()
  const suffix = /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'txt'

  let candidate = `${slug || 'reply'}.${suffix}`
  for (let n = 2; taken.has(candidate); n++) candidate = `${slug || 'reply'}-${n}.${suffix}`
  return isSafeFileName(candidate) ? candidate : null
}
