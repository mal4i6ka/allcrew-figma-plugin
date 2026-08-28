import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIGEST_BUDGET, digestReplies } from './reply-digest.ts'
import { isFileEnvelope, FILE_ENVELOPE } from './files.ts'

const envelope = (value: unknown) => (value as Record<string, { name: string; data: string; mime: string }>)[FILE_ENVELOPE]

test('a small reply crosses unchanged', () => {
  const digest = digestReplies([{ type: 'PALETTE_APPLIED', report: { created: 4, updated: 0 } }])
  assert.deepEqual(digest.replies, [{ type: 'PALETTE_APPLIED', report: { created: 4, updated: 0 } }])
  assert.equal(digest.files, 0)
  assert.equal(digest.truncated, false)
})

test('a long string becomes a file named after where it sat', () => {
  const css = ':root{--x:1}\n'.repeat(200)
  const digest = digestReplies([{ type: 'DJANGO_TEMPLATE', css }])
  const reply = digest.replies[0] as { css: unknown }
  assert.ok(isFileEnvelope(reply.css))
  assert.equal(envelope(reply.css).name, 'css.txt')
  assert.equal(envelope(reply.css).data, css)
  assert.equal(digest.files, 1)
})

test('a file map keeps its own names and extensions', () => {
  const digest = digestReplies([
    { type: 'TOKENS_RESULT', files: { 'css/tokens.css': 'a'.repeat(500), 'DESIGN.md': 'b'.repeat(500) } },
  ])
  const files = (digest.replies[0] as { files: Record<string, unknown> }).files
  assert.equal(envelope(files['css/tokens.css']).name, 'css-tokens.css')
  assert.equal(envelope(files['css/tokens.css']).mime, 'text/css')
  assert.equal(envelope(files['DESIGN.md']).name, 'design.md')
  assert.equal(envelope(files['DESIGN.md']).mime, 'text/markdown')
})

test('two long strings under one key name do not collide', () => {
  const digest = digestReplies([
    { type: 'A', files: { 'a/x.css': 'a'.repeat(500) } },
    { type: 'B', files: { 'a/x.css': 'b'.repeat(500) } },
  ])
  const first = envelope((digest.replies[0] as { files: Record<string, unknown> }).files['a/x.css']).name
  const second = envelope((digest.replies[1] as { files: Record<string, unknown> }).files['a/x.css']).name
  assert.equal(first, 'a-x.css')
  assert.equal(second, 'a-x-2.css')
})

test('past the file budget a long string is truncated in place, and says so', () => {
  const digest = digestReplies([{ type: 'BIG', text: 'x'.repeat(5000) }], {
    ...DEFAULT_DIGEST_BUDGET,
    keep: 10,
    maxFiles: 0,
  })
  assert.deepEqual(digest.replies[0], {
    type: 'BIG',
    text: { chars: 5000, head: 'xxxxxxxxxx', note: 'truncated' },
  })
  assert.equal(digest.truncated, true)
})

test('a burst of identical progress replies collapses to its ends', () => {
  const replies = Array.from({ length: 40 }, (_, index) => ({ type: 'REMAP_PROGRESS', label: `step ${index}` }))
  const digest = digestReplies([...replies, { type: 'REMAP_PLAN', rows: 3 }])

  assert.deepEqual(digest.replies, [
    { type: 'REMAP_PROGRESS', label: 'step 0' },
    { type: 'REMAP_PROGRESS', repeated: 38, note: 'identical replies omitted' },
    { type: 'REMAP_PROGRESS', label: 'step 39' },
    { type: 'REMAP_PLAN', rows: 3 },
  ])
  assert.equal(digest.collapsed, 38)
})

test('two of a kind is not a burst — nothing is hidden to save one line', () => {
  const digest = digestReplies([
    { type: 'P', label: 'a' },
    { type: 'P', label: 'b' },
  ])
  assert.equal(digest.collapsed, 0)
  assert.equal(digest.replies.length, 2)
})

test('a long array becomes a count and a sample', () => {
  const digest = digestReplies([{ type: 'SCAN_RESULT', lint: Array.from({ length: 50 }, (_, i) => ({ id: i })) }])
  assert.deepEqual((digest.replies[0] as { lint: unknown }).lint, {
    count: 50,
    sample: [{ id: 0 }, { id: 1 }, { id: 2 }],
    note: 'showing 3 of 50',
  })
  assert.equal(digest.truncated, true)
})

test('a wide object is named, not spilled — the keys are the answer', () => {
  const files: Record<string, string> = {}
  for (let index = 0; index < 40; index++) files[`page-${index}.html`] = 'x'.repeat(1000)
  const digest = digestReplies([{ type: 'FILES_READY', files }])
  const summary = (digest.replies[0] as { files: { keys: number; names: string[] } }).files
  assert.equal(summary.keys, 40)
  assert.equal(summary.names.length, 24)
  assert.equal(digest.files, 0, 'a 40-file map must not write 40 files behind the agent')
})

test("the channel's own traffic is not part of a command's answer", () => {
  const digest = digestReplies([
    { type: 'AGENT_ACTIVITY', op: 'plugin.call' },
    { type: 'REMAP_PLAN', rows: 1 },
    { type: 'AGENT_RESPONSE', id: '1' },
  ])
  assert.deepEqual(digest.replies, [{ type: 'REMAP_PLAN', rows: 1 }])
})

test('binary is reported by size, never inlined', () => {
  const digest = digestReplies([{ type: 'PNG', bytes: new Uint8Array(2048) }])
  assert.deepEqual(digest.replies[0], { type: 'PNG', bytes: { bytes: 2048, note: 'binary omitted' } })
})

test('a reply nested past the depth cap is counted, not walked forever', () => {
  let deep: unknown = 'leaf'
  for (let index = 0; index < 12; index++) deep = { level: deep }
  const digest = digestReplies([{ type: 'DEEP', tree: deep }])
  assert.equal(digest.truncated, true)
  assert.equal(JSON.stringify(digest.replies).includes('nested too deep'), true)
})
