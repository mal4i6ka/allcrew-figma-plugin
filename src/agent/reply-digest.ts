/**
 * Turning a UI reply into something an agent can afford to read.
 *
 * The plugin's commands answer the *iframe*, which can hold a whole export in memory and hand
 * it to JSZip. An agent cannot: `CONFIRM_EXPORT` alone replies with every generated file, and
 * `SCAN_TOKENS` with the entire token package. Relaying that verbatim would spend a context
 * window on one call.
 *
 * So a reply is digested, not forwarded: scalars survive, and anything too big to quote — a
 * long string, a long array, a wide object — becomes a file on the agent's disk (the
 * `__allcrewChannelFile` envelope the bridge materialises, see `files.ts`) with its shape left inline.
 * A burst of identical progress messages collapses to its first and last. Everything that
 * actually gets dropped says so in place, because a silent truncation reads as "that's all
 * there was" — and `truncated` is reserved for exactly that, so it does not fire when the data
 * merely moved to a file.
 */

import { isFileEnvelope, isSafeFileName, textFile } from './files.ts'

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
  // A command that already made a file — an export, say — has said exactly what it wants written.
  // Walking into it would spill its own base64 into a second file and leave the bridge holding an
  // envelope that no longer looks like one.
  if (isFileEnvelope(value)) {
    state.files++
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return digestString(value, budget, state, key)
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`

  if (value instanceof Uint8Array) {
    state.truncated = true
    return { bytes: value.length, note: 'binary omitted' }
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      const small = smallEnoughToShow(value)
      if (small !== null) return small
      return oversized(value, { count: value.length }, 'nested too deep to quote', budget, state, key)
    }
    if (value.length > MAX_ARRAY) {
      return oversized(
        value,
        { count: value.length, sample: preview(value.slice(0, 3), budget) },
        `showing 3 of ${value.length}`,
        budget,
        state,
        key
      )
    }
    return value.map((entry) => digestValue(entry, depth + 1, budget, state, key))
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (depth >= MAX_DEPTH) {
    const small = smallEnoughToShow(record)
    if (small !== null) return small
    return oversized(record, { keys: keys.length }, 'nested too deep to quote', budget, state, key)
  }
  if (keys.length > MAX_KEYS) {
    // A file map (`{ 'css/tokens.css': '…' }`) lands here: its keys are the shape, and the
    // contents are what the caller came for — one file with all of it, not forty files and not
    // a list of names.
    return oversized(
      record,
      { keys: keys.length, names: keys.slice(0, MAX_KEYS) },
      `showing ${MAX_KEYS} key(s) of ${keys.length}`,
      budget,
      state,
      key
    )
  }

  const out: Record<string, unknown> = {}
  for (const entry of keys) {
    out[entry] = digestValue(record[entry], depth + 1, budget, state, entry)
  }
  return out
}

/**
 * A structure too big to quote inline.
 *
 * Summarising it was the wrong instinct: `READ_VARIABLES` came back as
 * `collections: { count: 13, sample: [ { modes: [ { keys: 2, note: 'nested too deep to show' } ] } ] }`
 * — a reply whose entire purpose is the data, answered with the shape of the data. The caps
 * suit a chatty progress reply and ruin a dump.
 *
 * So the whole of it goes to a file — the same `__allcrewChannelFile` envelope a long string uses, so
 * the bridge writes it and hands back a path — and what stays inline is the shape: how many,
 * which keys, a three-entry taste. Nothing is lost, so this does not count as truncation; a
 * caller that only needed the shape never opens the file.
 */
function oversized(
  value: unknown,
  shape: Record<string, unknown>,
  note: string,
  budget: DigestBudget,
  state: State,
  key: string
): unknown {
  const json = safeJson(value)
  if (
    json !== null &&
    json.length >= MIN_SPILL_BYTES &&
    state.files < budget.maxFiles &&
    state.bytes + json.length <= budget.maxBytes
  ) {
    const name = fileNameFor(`${key || 'reply'}.json`, state.names)
    if (name) {
      state.files++
      state.bytes += json.length
      state.names.add(name)
      return { ...shape, note: `${note} — all of it in the file`, full: textFile(name, 'application/json', json) }
    }
  }
  state.truncated = true
  return { ...shape, note }
}

/**
 * A structure at the depth cap that is simply small.
 *
 * The cap exists to stop an unbounded walk, not to hide four numbers: a report's
 * `padding: [12,12,12,12]` was arriving as `{ count: 4, note: "nested too deep to quote" }`,
 * which is longer than the thing it refused to print. Recursion still stops here — the value is
 * taken whole — so nothing unbounded gets through.
 */
function smallEnoughToShow(value: unknown): unknown | null {
  const json = safeJson(value)
  return json !== null && json.length <= SHOW_ANYWAY_BYTES ? value : null
}

/**
 * Small enough that printing it costs less than explaining its absence.
 *
 * The alternative is not nothing: a spilled structure costs a `note`, a shape and a file envelope
 * with a path — about 150 bytes of its own, and then a caller who has to go and open the file. A
 * styled text run came to 201 bytes against a cap of 200 and went to disk, which is how the one
 * run that carried the link left the reply.
 */
const SHOW_ANYWAY_BYTES = 500

/** Below this a file costs more than it explains, and the shape already carries the answer. */
const MIN_SPILL_BYTES = 120

/**
 * The shape hint beside a spilled structure, rendered with spilling switched off: the file
 * already holds every byte, and a sample that wrote files of its own would store the same
 * strings twice.
 */
function preview(value: unknown[], budget: DigestBudget): unknown[] {
  const sealed: State = { files: 0, bytes: 0, truncated: false, names: new Set() }
  // From the top, not from the depth the parent had reached: three entries can afford to be
  // shown properly, and a sample that renders its own children as "nested too deep" reads as a
  // second loss right next to the note saying nothing was lost.
  return value.map((entry) => digestValue(entry, 0, { ...budget, maxFiles: 0 }, sealed, ''))
}

/** JSON or nothing: a reply can carry a cycle, and a digest must not throw over one. */
function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, (_key, entry) =>
      entry instanceof Uint8Array ? { bytes: entry.length, note: 'binary omitted' } : entry
    )
    return typeof json === 'string' ? json : null
  } catch {
    return null
  }
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
