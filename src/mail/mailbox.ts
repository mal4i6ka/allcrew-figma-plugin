/**
 * File mail — messages between the people and agents working in one Figma file, kept in the file.
 *
 * Pure: no `figma`. The store (`store.ts`) reads the document root's plugin data into a flat
 * `Record<key, value>` and hands it here; everything that decides what a message looks like,
 * who it is for, whether it has been read and when it must go lives in this file, where it can
 * be tested without a client.
 *
 * Why the root and why one key per thing. Plugin data syncs to every open client like any other
 * edit, so the file itself is the transport — no server, nothing outside Figma. One key per
 * message, per read receipt and per decision means two clients writing at once never write the
 * same key: a message is immutable once sent, a receipt is written once by its reader.
 *
 * The file is not a database, and every write lands in undo and version history. So nothing
 * here lives forever: each message carries an expiry (a day by default, a week at most), one
 * that everybody it was meant for has read goes ten minutes after the last read, and the whole
 * mailbox is held under a byte budget by dropping the oldest. Every open client prunes — the
 * deletes are idempotent, so two of them pruning at once is harmless.
 *
 * Trust. The data is private to this plugin's id, so other plugins can neither read nor forge
 * it; the sender is stamped by the sending client from `figma.currentUser`. That is attribution,
 * not authentication — the plugin id is public and anyone can build a plugin under it. And a
 * message is something a colleague *said*: an agent reads it as information, never as an
 * instruction, and a `request` is only acted on once the human it was addressed to approves it
 * in their own panel.
 */

export const MAIL_PREFIX = 'mail:'
const MSG = 'mail:msg:'
const ACK = 'mail:ack:'
const DEC = 'mail:dec:'

export const MAX_TEXT_BYTES = 8 * 1024
export const MAILBOX_BUDGET_BYTES = 512 * 1024
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MIN_TTL_MS = 60 * 1000
/** How long a message everybody has read stays around — long enough to scroll back to it. */
export const READ_GRACE_MS = 10 * 60 * 1000
const MAX_NODES = 20
const MAX_TO = 20

export type MailKind = 'note' | 'request' | 'reply'
export const MAIL_KINDS: readonly MailKind[] = ['note', 'request', 'reply']

/** `*` (everyone in the file), `user:<figma user id>` (that person, in any of their clients) or
 * `agent:<figma user id>` (the agent connected to that person's plugin). */
export type Address = string

export interface MailParty {
  address: Address
  name: string
  /** `figma.currentUser.sessionId` of the sending client: tells one person's two windows apart. */
  session: number | null
}

export interface MailMessage {
  v: 1
  id: string
  at: number
  expiresAt: number
  from: MailParty
  to: Address[]
  /** Who is expected to read it: the people and agents in `to`, with `*` expanded to the people
   * in the file when it was sent. Read-and-gone applies once every one of them has read it; an
   * empty audience leaves the message to its expiry. */
  audience: Address[]
  kind: MailKind
  thread?: string
  text: string
  nodes?: Array<{ id: string; name: string }>
}

export interface MailReceipt {
  at: number
  name: string
}

export interface MailDecision {
  decision: 'approved' | 'declined'
  by: { address: Address; name: string }
  at: number
  note?: string
}

/* --------------------------------------------------------------- addresses */

const ADDRESS = /^(\*|(user|agent):[A-Za-z0-9_-]{1,64})$/

export function isAddress(raw: unknown): raw is Address {
  return typeof raw === 'string' && ADDRESS.test(raw)
}

export interface Me {
  user: Address
  agent: Address
  name: string
  session: number | null
}

export function identity(user: { id?: string | null; name?: string; sessionId?: number } | null | undefined): Me {
  const id = String(user?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'anonymous'
  return {
    user: `user:${id}`,
    agent: `agent:${id}`,
    name: String(user?.name || 'Someone'),
    session: typeof user?.sessionId === 'number' ? user.sessionId : null,
  }
}

/* ------------------------------------------------------------------- keys */

export const messageKey = (id: string): string => MSG + id
export const receiptKey = (id: string, reader: Address): string => `${ACK}${id}:${reader}`
export const decisionKey = (id: string): string => DEC + id

function receiptParts(key: string): { id: string; reader: Address } | null {
  const rest = key.slice(ACK.length)
  const colon = rest.indexOf(':')
  return colon < 0 ? null : { id: rest.slice(0, colon), reader: rest.slice(colon + 1) }
}

/** Sortable by time, unique enough for one file: base-36 milliseconds, then randomness. */
export function newMessageId(now: number, random: () => number): string {
  let tail = ''
  for (let i = 0; i < 6; i++) tail += Math.floor(random() * 36).toString(36)
  return `${now.toString(36)}-${tail}`
}

/** UTF-8 length without TextEncoder, which the plugin sandbox does not promise. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/* ------------------------------------------------------------------- read */

export interface Mailbox {
  messages: MailMessage[]
  receipts: Map<string, Map<Address, MailReceipt>>
  decisions: Map<string, MailDecision>
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function isMessage(value: unknown): value is MailMessage {
  const m = value as MailMessage
  return Boolean(
    m && m.v === 1 && typeof m.id === 'string' && typeof m.at === 'number' && typeof m.expiresAt === 'number' &&
      m.from && typeof m.from.address === 'string' && Array.isArray(m.to) && Array.isArray(m.audience) &&
      typeof m.text === 'string' && MAIL_KINDS.includes(m.kind)
  )
}

export function readMailbox(entries: Readonly<Record<string, string>>): Mailbox {
  const messages: MailMessage[] = []
  const receipts = new Map<string, Map<Address, MailReceipt>>()
  const decisions = new Map<string, MailDecision>()
  for (const [key, raw] of Object.entries(entries)) {
    if (key.startsWith(MSG)) {
      const message = parse<MailMessage>(raw)
      if (isMessage(message) && message.id === key.slice(MSG.length)) messages.push(message)
    } else if (key.startsWith(ACK)) {
      const parts = receiptParts(key)
      const receipt = parse<MailReceipt>(raw)
      if (!parts || !receipt) continue
      if (!receipts.has(parts.id)) receipts.set(parts.id, new Map())
      receipts.get(parts.id)!.set(parts.reader, receipt)
    } else if (key.startsWith(DEC)) {
      const decision = parse<MailDecision>(raw)
      if (decision) decisions.set(key.slice(DEC.length), decision)
    }
  }
  messages.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  return { messages, receipts, decisions }
}

/* ------------------------------------------------------------------- send */

export interface Draft {
  to: unknown
  text: unknown
  kind?: unknown
  thread?: unknown
  ttlHours?: unknown
  nodes?: Array<{ id: string; name: string }>
}

/** Validates a draft and turns it into the message to store. Throws with a sentence the sender
 * can act on. `people` is who is in the file right now (`user:` addresses), for `*`. */
export function compose(draft: Draft, from: MailParty, now: number, people: readonly Address[], random: () => number): MailMessage {
  const toList = (Array.isArray(draft.to) ? draft.to : [draft.to ?? '*']).map(String)
  if (toList.length === 0) throw new Error('say who it is for: "*" (everyone), "user:<id>" or "agent:<id>"')
  if (toList.length > MAX_TO) throw new Error(`at most ${MAX_TO} recipients`)
  const bad = toList.filter((address) => !isAddress(address))
  if (bad.length > 0) throw new Error(`not an address: ${bad.join(', ')} — use "*", "user:<id>" or "agent:<id>"`)
  const to = [...new Set(toList)]

  const text = String(draft.text ?? '').trim()
  if (text === '') throw new Error('the message is empty')
  const bytes = utf8Bytes(text)
  if (bytes > MAX_TEXT_BYTES) throw new Error(`the message is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES} — link to a frame or a page instead of pasting it`)

  const kind = (draft.kind ?? 'note') as MailKind
  if (!MAIL_KINDS.includes(kind)) throw new Error(`kind is one of ${MAIL_KINDS.join(', ')}`)
  const thread = draft.thread === undefined || draft.thread === null || draft.thread === '' ? undefined : String(draft.thread)
  if (kind === 'reply' && !thread) throw new Error('a reply names the message it answers in `thread`')

  const hours = draft.ttlHours === undefined || draft.ttlHours === null || draft.ttlHours === '' ? null : Number(draft.ttlHours)
  if (hours !== null && !Number.isFinite(hours)) throw new Error('ttlHours is a number of hours')
  const ttl = hours === null ? DEFAULT_TTL_MS : Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, hours * 60 * 60 * 1000))

  const audience = new Set<Address>()
  for (const address of to) {
    if (address === '*') people.forEach((person) => audience.add(person))
    else audience.add(address)
  }
  audience.delete(from.address)

  const nodes = (draft.nodes ?? []).slice(0, MAX_NODES).map((node) => ({ id: String(node.id), name: String(node.name).slice(0, 120) }))
  return {
    v: 1,
    id: newMessageId(now, random),
    at: now,
    expiresAt: now + ttl,
    from,
    to,
    audience: [...audience],
    kind,
    ...(thread ? { thread } : {}),
    text,
    ...(nodes.length > 0 ? { nodes } : {}),
  }
}

/* ------------------------------------------------------------------ prune */

export interface Prune {
  remove: string[]
  expired: number
  read: number
  evicted: number
}

/** What has to go, given everything under `mail:` on the root. Expired messages; messages every
 * reader has read, once the grace period after the last read has passed; receipts and decisions
 * whose message is gone; anything that does not parse; and then, oldest first, whatever it takes
 * to bring the mailbox under its byte budget. */
export function planPrune(entries: Readonly<Record<string, string>>, now: number, budget = MAILBOX_BUDGET_BYTES): Prune {
  const remove = new Set<string>()
  const box = readMailbox(entries)
  const alive = new Set<string>()
  let expired = 0
  let read = 0

  const dropMessage = (id: string) => {
    remove.add(messageKey(id))
    remove.add(decisionKey(id))
    for (const reader of box.receipts.get(id)?.keys() ?? []) remove.add(receiptKey(id, reader))
  }

  for (const message of box.messages) {
    if (message.expiresAt <= now) {
      dropMessage(message.id)
      expired++
      continue
    }
    const receipts = box.receipts.get(message.id)
    const readers = message.audience
    const everyoneRead = readers.length > 0 && readers.every((reader) => receipts?.has(reader))
    // A request waits for its answer as well as its readers: nobody should lose the question
    // while the person who has to decide still has not.
    const settled = message.kind !== 'request' || box.decisions.has(message.id)
    if (everyoneRead && settled) {
      const last = Math.max(...readers.map((reader) => receipts!.get(reader)!.at), box.decisions.get(message.id)?.at ?? 0)
      if (last + READ_GRACE_MS <= now) {
        dropMessage(message.id)
        read++
        continue
      }
    }
    alive.add(message.id)
  }

  for (const key of Object.keys(entries)) {
    if (!key.startsWith(MAIL_PREFIX) || remove.has(key)) continue
    if (key.startsWith(MSG)) {
      if (!alive.has(key.slice(MSG.length))) remove.add(key)
    } else if (key.startsWith(ACK)) {
      const parts = receiptParts(key)
      if (!parts || !alive.has(parts.id)) remove.add(key)
    } else if (key.startsWith(DEC)) {
      if (!alive.has(key.slice(DEC.length))) remove.add(key)
    } else remove.add(key)
  }

  let size = 0
  for (const [key, value] of Object.entries(entries)) if (key.startsWith(MAIL_PREFIX) && !remove.has(key)) size += key.length + utf8Bytes(value)
  let evicted = 0
  for (const message of box.messages) {
    if (size <= budget) break
    if (!alive.has(message.id)) continue
    for (const key of [messageKey(message.id), decisionKey(message.id), ...[...(box.receipts.get(message.id)?.keys() ?? [])].map((reader) => receiptKey(message.id, reader))]) {
      if (key in entries && !remove.has(key)) {
        size -= key.length + utf8Bytes(entries[key])
        remove.add(key)
      }
    }
    alive.delete(message.id)
    evicted++
  }

  return { remove: [...remove], expired, read, evicted }
}

/* ------------------------------------------------------------------- view */

export interface MailItem extends MailMessage {
  /** This reader sent it (from this very client, for a person). */
  mine: boolean
  /** Addressed to this reader, directly or through `*`. */
  forMe: boolean
  /** This reader has a receipt for it. Own messages count as read. */
  read: boolean
  readBy: Array<{ address: Address; name: string; at: number }>
  decision?: MailDecision
}

/** The mailbox as one reader sees it: a person (`as: 'user'`) or that person's agent. Others'
 * private conversations are left out unless `all`. */
export function viewFor(box: Mailbox, me: Me, as: 'user' | 'agent', now: number, all = false): MailItem[] {
  const self = as === 'user' ? me.user : me.agent
  const items: MailItem[] = []
  for (const message of box.messages) {
    if (message.expiresAt <= now) continue
    // One person can have the file open twice (two windows, the desktop app and a browser), and
    // each window has its own agent: the session says which window wrote it.
    const mine = message.from.address === self && message.from.session === me.session
    const forMe = !mine && (message.to.includes(self) || message.to.includes('*'))
    if (!all && !mine && !forMe) continue
    const receipts = box.receipts.get(message.id)
    items.push({
      ...message,
      mine,
      forMe,
      read: mine || Boolean(receipts?.has(self)),
      readBy: [...(receipts?.entries() ?? [])].map(([address, receipt]) => ({ address, name: receipt.name, at: receipt.at })),
      ...(box.decisions.has(message.id) ? { decision: box.decisions.get(message.id)! } : {}),
    })
  }
  return items
}

/** Whether this person may approve or decline a request: it was addressed to them or to their
 * agent, and it did not come out of this same window. Agents never decide — that is the whole
 * point; a person's agent in another window asking that person is fine, since a person answers. */
export function mayDecide(message: MailMessage, me: Me): boolean {
  const fromHere = (message.from.address === me.user || message.from.address === me.agent) && message.from.session === me.session
  return message.kind === 'request' && !fromHere &&
    (message.to.includes(me.user) || message.to.includes(me.agent) || message.to.includes('*'))
}
