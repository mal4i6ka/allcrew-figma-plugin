/**
 * File mail — the mailbox on the document root, and how this client notices a change to it.
 *
 * The root is no page's node, so no `nodechange` reports it, and the document-wide
 * `documentchange` is refused under `dynamic-page` unless every page is loaded first. What is
 * left is looking: every `POLL_MS` the root's key list is compared with the last one. Messages
 * and receipts are immutable once written, so the list of keys is the whole state — no values
 * are read until it changes. Measured between two clients on one machine, a write shows up on
 * the other side in about 0.4 s.
 *
 * The rules (what a message is, who it is for, what has to go) are in `mailbox.ts`; this file
 * only reads and writes.
 */

import {
  MAIL_PREFIX,
  compose,
  decisionKey,
  identity,
  mayDecide,
  messageKey,
  planPrune,
  readMailbox,
  receiptKey,
  viewFor,
  type Draft,
  type MailDecision,
  type MailItem,
  type MailMessage,
  type Me,
  type Prune,
} from './mailbox.ts'

const POLL_MS = 750
const PRUNE_MS = 5 * 60 * 1000

export type Reader = 'user' | 'agent'

export function mailMe(): Me {
  return identity(figma.currentUser)
}

export function mailEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const key of figma.root.getPluginDataKeys()) if (key.startsWith(MAIL_PREFIX)) entries[key] = figma.root.getPluginData(key)
  return entries
}

/** The people in the file right now, as addresses — who `*` is meant to reach. */
function people(): string[] {
  try {
    return [...new Set(figma.activeUsers.map((user) => identity(user).user))]
  } catch {
    return []
  }
}

export function mailView(as: Reader, all = false): MailItem[] {
  return viewFor(readMailbox(mailEntries()), mailMe(), as, Date.now(), all)
}

export function sendMail(draft: Draft, as: Reader): MailMessage {
  const me = mailMe()
  const from = { address: as === 'user' ? me.user : me.agent, name: as === 'user' ? me.name : `${me.name}’s agent`, session: me.session }
  const message = compose(draft, from, Date.now(), people(), Math.random)
  figma.root.setPluginData(messageKey(message.id), JSON.stringify(message))
  pruneMail()
  changed()
  return message
}

/** Marks messages read for this reader. Unknown ids and ones already read are skipped. */
export function ackMail(ids: readonly string[], as: Reader): string[] {
  const me = mailMe()
  const reader = as === 'user' ? me.user : me.agent
  const known = new Set(mailView(as).filter((item) => !item.read).map((item) => item.id))
  const marked: string[] = []
  for (const id of ids) {
    if (!known.has(id)) continue
    figma.root.setPluginData(receiptKey(id, reader), JSON.stringify({ at: Date.now(), name: as === 'user' ? me.name : `${me.name}’s agent` }))
    marked.push(id)
  }
  if (marked.length > 0) changed()
  return marked
}

/** A person's answer to a request. There is deliberately no agent path to this. */
export function decideMail(id: string, decision: MailDecision['decision'], note?: string): MailDecision {
  const me = mailMe()
  const message = readMailbox(mailEntries()).messages.find((one) => one.id === id)
  if (!message) throw new Error('that message is gone')
  if (!mayDecide(message, me)) throw new Error('only the person a request was sent to can answer it')
  if (decision !== 'approved' && decision !== 'declined') throw new Error('approved or declined')
  const answer: MailDecision = { decision, by: { address: me.user, name: me.name }, at: Date.now(), ...(note ? { note: note.slice(0, 500) } : {}) }
  figma.root.setPluginData(decisionKey(id), JSON.stringify(answer))
  const receipt = receiptKey(id, me.user)
  if (!figma.root.getPluginData(receipt)) figma.root.setPluginData(receipt, JSON.stringify({ at: answer.at, name: me.name }))
  changed()
  return answer
}

export function pruneMail(): Prune {
  const plan = planPrune(mailEntries(), Date.now())
  for (const key of plan.remove) figma.root.setPluginData(key, '')
  return plan
}

/* ------------------------------------------------------------------ watch */

type Listener = () => void
const listeners = new Set<Listener>()
let signature = ''
let poller = 0
let pruner = 0

function keySignature(): string {
  return figma.root.getPluginDataKeys().filter((key) => key.startsWith(MAIL_PREFIX)).sort().join('\n')
}

function changed(): void {
  signature = keySignature()
  listeners.forEach((listener) => listener())
}

function tick(): void {
  let next: string
  try {
    next = keySignature()
  } catch {
    return
  }
  if (next === signature) return
  signature = next
  listeners.forEach((listener) => listener())
}

function prune(): void {
  try {
    if (pruneMail().remove.length > 0) changed()
  } catch {
    // A client that may not write (view-only, Dev Mode) still reads; somebody else prunes.
  }
}

/** Starts looking at the mailbox (once per plugin run) and calls `listener` on every change —
 * ours or another client's. Returns the function that stops listening. */
export function watchMail(listener: Listener): () => void {
  listeners.add(listener)
  if (!poller) {
    signature = keySignature()
    poller = setInterval(tick, POLL_MS) as unknown as number
    pruner = setInterval(prune, PRUNE_MS) as unknown as number
    prune()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(poller)
      clearInterval(pruner)
      poller = pruner = 0
    }
  }
}

/** Resolves with this reader's unread messages as soon as there is one, or with none at the
 * timeout. Unread mail already waiting answers at once. */
export function waitForMail(as: Reader, timeoutMs: number): Promise<MailItem[]> {
  const unread = () => mailView(as).filter((item) => item.forMe && !item.read)
  const now = unread()
  if (now.length > 0) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    let stop = () => {}
    const finish = (items: MailItem[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      resolve(items)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)
    // Starting the watch may prune, and a prune is a change: the listener can run before
    // `watchMail` has even returned.
    stop = watchMail(() => {
      const items = unread()
      if (items.length > 0) finish(items)
    })
    if (done) stop()
  })
}
