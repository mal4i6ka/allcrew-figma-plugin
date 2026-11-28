import test from 'node:test'
import assert from 'node:assert/strict'
import { EventFeed } from './events.ts'
import { jsxFromJson } from './reach-ops.ts'

const clock = () => new Date('2026-11-28T10:00:00Z')

test('the feed reads what came after `since`, filtered by kind, newest last', () => {
  const feed = new EventFeed(1000, clock)
  feed.record({ kind: 'SELECTION', data: { count: 1, nodes: ['1:2'] } })
  feed.record({ kind: 'PAGE', id: '0:1', name: 'Cover' })
  feed.record({ kind: 'DROP', data: { files: [] } })
  const all = feed.read()
  assert.deepEqual(all.events.map((one) => one.kind), ['SELECTION', 'PAGE', 'DROP'])
  assert.equal(all.next, 3)
  assert.equal(all.events[0].at, '2026-11-28T10:00:00.000Z')
  assert.deepEqual(feed.read({ since: 1 }).events.map((one) => one.seq), [1, 2])
  assert.deepEqual(feed.read({ kinds: ['drop', 'PAGE'] }).events.map((one) => one.kind), ['PAGE', 'DROP'])
})

test('the limit keeps the newest and says how many it left out; the buffer holds its size', () => {
  const feed = new EventFeed(5, clock)
  for (let i = 0; i < 8; i++) feed.record({ kind: 'RUN', data: { i } })
  const read = feed.read({ limit: 2 })
  assert.deepEqual(read.events.map((one) => one.seq), [6, 7])
  assert.equal(read.dropped, 3)
  assert.equal(feed.read().events.length, 5)
  feed.forget()
  assert.deepEqual(feed.read().events, [])
  assert.equal(feed.read().next, 8)
})

test('a JSX tree from JSON is built with the runtime\'s own h, every problem naming where', () => {
  const calls: unknown[] = []
  const widget = {
    h: (type: unknown, props: unknown, ...children: unknown[]) => {
      calls.push(type)
      return { type, props, children }
    },
    AutoLayout: 'AL',
    Text: 'T',
  }
  const built = jsxFromJson({ type: 'AutoLayout', props: { padding: 8 }, children: [{ type: 'Text', children: 'Hi' }] }, widget)
  assert.deepEqual(built, { type: 'AL', props: { padding: 8 }, children: [{ type: 'T', props: null, children: ['Hi'] }] })
  assert.throws(() => jsxFromJson({ type: 'Div' }, widget), /tree\.type must be one of: AutoLayout/)
  assert.throws(() => jsxFromJson({ type: 'AutoLayout', children: [{ type: 'Frame' }] }, widget), /tree\.children\[0\]: this Figma's JSX runtime has no Frame/)
  assert.throws(() => jsxFromJson({ type: 'Text', props: [1] }, widget), /tree\.props must be an object/)
  assert.throws(() => jsxFromJson(42, widget), /tree must be/)
})
