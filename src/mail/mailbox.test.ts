import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  READ_GRACE_MS,
  compose,
  decisionKey,
  identity,
  mayDecide,
  messageKey,
  planPrune,
  readMailbox,
  receiptKey,
  utf8Bytes,
  viewFor,
  type MailMessage,
} from './mailbox.ts'

const T0 = Date.UTC(2026, 9, 28, 12)
const ann = identity({ id: '111', name: 'Ann', sessionId: 1 })
const bob = identity({ id: '222', name: 'Bob', sessionId: 2 })
const fixed = () => 0.5
const from = (me: typeof ann, as: 'user' | 'agent' = 'user') => ({ address: me[as], name: me.name, session: me.session })

function store(...messages: MailMessage[]): Record<string, string> {
  return Object.fromEntries(messages.map((message) => [messageKey(message.id), JSON.stringify(message)]))
}

test('a draft becomes a message with an expiry and an audience', () => {
  const message = compose({ to: '*', text: '  hi  ' }, from(ann), T0, [ann.user, bob.user], fixed)
  assert.equal(message.text, 'hi')
  assert.equal(message.expiresAt, T0 + DEFAULT_TTL_MS)
  assert.deepEqual(message.audience, [bob.user], 'everyone in the file but the sender')
  assert.equal(compose({ to: bob.agent, text: 'x', ttlHours: 1000 }, from(ann), T0, [], fixed).expiresAt, T0 + MAX_TTL_MS)
  assert.throws(() => compose({ to: 'bob', text: 'x' }, from(ann), T0, [], fixed), /not an address/)
  assert.throws(() => compose({ to: '*', text: ' ' }, from(ann), T0, [], fixed), /empty/)
  assert.throws(() => compose({ to: '*', text: 'я'.repeat(5000) }, from(ann), T0, [], fixed), /limit is 8192/)
  assert.throws(() => compose({ to: '*', text: 'x', kind: 'reply' }, from(ann), T0, [], fixed), /thread/)
  assert.equal(utf8Bytes('aя😀'), 1 + 2 + 4)
})

test('expired messages go, with their receipts and decisions', () => {
  const message = compose({ to: bob.user, text: 'x', ttlHours: 1 }, from(ann), T0, [], fixed)
  const entries = {
    ...store(message),
    [receiptKey(message.id, bob.agent)]: JSON.stringify({ at: T0, name: 'Bob' }),
    'mail:ack:gone:user:1': JSON.stringify({ at: T0, name: 'x' }),
    'mail:junk': 'x',
  }
  assert.deepEqual(planPrune(entries, T0 + 1000).remove.sort(), ['mail:ack:gone:user:1', 'mail:junk'])
  const later = planPrune(entries, T0 + 60 * 60 * 1000)
  assert.equal(later.expired, 1)
  assert.ok(later.remove.includes(messageKey(message.id)))
  assert.ok(later.remove.includes(receiptKey(message.id, bob.agent)))
})

test('a message everyone has read goes after the grace period; a request also waits for its answer', () => {
  const note = compose({ to: [bob.user, bob.agent], text: 'n' }, from(ann), T0, [], fixed)
  const ask = compose({ to: bob.agent, text: 'rename it?', kind: 'request' }, from(ann, 'agent'), T0, [], () => 0.9)
  const read = (id: string, reader: string, at: number) => ({ [receiptKey(id, reader)]: JSON.stringify({ at, name: 'Bob' }) })
  let entries: Record<string, string> = { ...store(note, ask), ...read(note.id, bob.user, T0), ...read(ask.id, bob.agent, T0) }
  assert.equal(planPrune(entries, T0 + READ_GRACE_MS * 2).read, 0, 'the note still waits for bob’s agent')

  entries = { ...entries, ...read(note.id, bob.agent, T0 + 1000) }
  assert.equal(planPrune(entries, T0 + READ_GRACE_MS).read, 0, 'within the grace period')
  const plan = planPrune(entries, T0 + 1000 + READ_GRACE_MS)
  assert.equal(plan.read, 1)
  assert.ok(!plan.remove.includes(messageKey(ask.id)), 'the request is read but undecided')

  entries[decisionKey(ask.id)] = JSON.stringify({ decision: 'declined', by: { address: bob.user, name: 'Bob' }, at: T0 + 5000 })
  assert.equal(planPrune(entries, T0 + 5000 + READ_GRACE_MS).read, 2)
})

test('the mailbox stays under its budget by dropping the oldest', () => {
  const messages = [0, 1, 2].map((i) => compose({ to: '*', text: 'x'.repeat(4000) }, from(ann), T0 + i, [], () => i / 10))
  const plan = planPrune(store(...messages), T0 + 10, 9000)
  assert.equal(plan.evicted, 1)
  assert.deepEqual(plan.remove, [messageKey(messages[0].id)])
})

test('each reader sees their own mail, and only people decide requests', () => {
  const toBob = compose({ to: bob.user, text: 'for bob' }, from(ann), T0, [], () => 0.1)
  const toAll = compose({ to: '*', text: 'all' }, from(ann), T0 + 1, [], () => 0.2)
  const ask = compose({ to: bob.agent, text: 'may I?', kind: 'request' }, from(ann, 'agent'), T0 + 2, [], () => 0.3)
  const box = readMailbox({ ...store(toBob, toAll, ask), [receiptKey(toAll.id, bob.user)]: JSON.stringify({ at: T0, name: 'Bob' }) })

  const bobSees = viewFor(box, bob, 'user', T0 + 5)
  assert.deepEqual(bobSees.map((item) => [item.text, item.read]), [['for bob', false], ['all', true]])
  assert.deepEqual(viewFor(box, bob, 'agent', T0 + 5).map((item) => item.text), ['all', 'may I?'])
  assert.deepEqual(viewFor(box, ann, 'user', T0 + 5).map((item) => [item.text, item.mine]), [['for bob', true], ['all', true]])

  // Ann in a second window sees what her first window sent to everyone.
  const annElsewhere = { ...ann, session: 9 }
  assert.deepEqual(viewFor(box, annElsewhere, 'user', T0 + 5).map((item) => [item.text, item.mine, item.forMe]), [['all', false, true]])

  assert.equal(mayDecide(ask, bob), true)
  assert.equal(mayDecide(ask, ann), false, 'not the window it came from')
  assert.equal(mayDecide(ask, { ...bob, session: 7 }), true, 'any of bob’s windows')
  assert.equal(mayDecide(toBob, bob), false, 'a note is not a request')
})
