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

test('a long array keeps its shape inline and all of itself in a file', () => {
  const lint = Array.from({ length: 50 }, (_, i) => ({ id: i, message: `finding ${i}` }))
  const digest = digestReplies([{ type: 'SCAN_RESULT', lint }])
  const summary = (digest.replies[0] as { lint: Record<string, unknown> }).lint

  assert.equal(summary.count, 50)
  assert.deepEqual(summary.sample, [
    { id: 0, message: 'finding 0' },
    { id: 1, message: 'finding 1' },
    { id: 2, message: 'finding 2' },
  ])
  assert.ok(isFileEnvelope(summary.full))
  assert.deepEqual(JSON.parse(envelope(summary.full).data), lint, 'the file must hold every entry')
  assert.equal(envelope(summary.full).name, 'lint.json')
  // Nothing was dropped, so this is not a truncation — the flag is reserved for real loss.
  assert.equal(digest.truncated, false)
})

test('a wide object is one file, not forty', () => {
  const files: Record<string, string> = {}
  for (let index = 0; index < 40; index++) files[`page-${index}.html`] = 'x'.repeat(1000)
  const digest = digestReplies([{ type: 'FILES_READY', files }])
  const summary = (digest.replies[0] as { files: Record<string, unknown> }).files

  assert.equal(summary.keys, 40)
  assert.equal((summary.names as string[]).length, 24)
  assert.equal(digest.files, 1, 'a 40-file map must not write 40 files behind the agent')
  assert.deepEqual(JSON.parse(envelope(summary.full).data), files)
})

test('a styled run at the depth cap is printed, not filed', () => {
  // 201 bytes against a cap of 200 sent the one run that carried the link to disk. The cap is
  // about unbounded walks, not about a structure smaller than the note explaining its absence.
  const run = { from: 17, to: 27, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14,
    fill: 'var:content/minimal', textDecoration: 'UNDERLINE', letterSpacing: '0%',
    link: 'https://allcrew.com/invoice/1042' }
  const digest = digestReplies([{ type: 'NODES_FOUND', nodes: [{ props: { runs: [run] } }] }])
  assert.match(JSON.stringify(digest.replies), /invoice\/1042/)
  assert.equal(digest.files, 0)
})

test('a structure below the file floor stays inline as a shape', () => {
  // Thirteen small numbers do not need a file; the count and a taste are the whole answer.
  const digest = digestReplies([{ type: 'TINY', ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }])
  const summary = (digest.replies[0] as { ids: Record<string, unknown> }).ids
  assert.equal(summary.count, 13)
  assert.equal(summary.full, undefined)
  assert.equal(digest.truncated, true)
})

test('the shape beside a spilled structure never writes files of its own', () => {
  // The file holds every byte already; a sample that spilled too would store the same strings
  // twice and burn the budget doing it.
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, css: 'a'.repeat(2000) }))
  const digest = digestReplies([{ type: 'BIG', rows }])
  assert.equal(digest.files, 1)
  const sample = (digest.replies[0] as { rows: { sample: Array<{ css: unknown }> } }).rows.sample
  assert.equal(typeof (sample[0].css as { chars?: number }).chars, 'number', 'the sample quotes, it does not spill')
})

test('a reply that cannot be serialised falls back to its shape, and says so', () => {
  const circular: Record<string, unknown> = { name: 'loop' }
  circular.self = circular
  const wide: Record<string, unknown> = {}
  for (let index = 0; index < 30; index++) wide[`k${index}`] = circular
  const digest = digestReplies([{ type: 'CYCLE', wide }])

  const summary = (digest.replies[0] as { wide: Record<string, unknown> }).wide
  assert.equal(summary.keys, 30)
  assert.equal(summary.full, undefined)
  assert.equal(digest.truncated, true)
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

test('a deep but tiny chain is taken whole, and the walk still stops', () => {
  // Twelve levels of one key each: past the cap, and small enough that printing it costs less
  // than explaining its absence. The guarantee that matters is that recursion ends — the value
  // is taken as it is rather than descended into.
  let deep: unknown = 'leaf'
  for (let index = 0; index < 12; index++) deep = { level: deep }
  const digest = digestReplies([{ type: 'DEEP', tree: deep }])
  assert.equal(digest.truncated, false)
  assert.match(JSON.stringify(digest.replies), /"leaf"/)
})

test('a small structure at the depth cap is shown, not explained away', () => {
  // `padding: [12,12,12,12]` five levels down was arriving as
  // `{ count: 4, note: "nested too deep to quote" }` — longer than the thing it refused to print.
  const deep = { a: { b: { c: { d: { padding: [12, 12, 12, 12], corners: { topLeft: 8 } } } } } }
  const digest = digestReplies([{ type: 'DEEP', ...deep }])
  const found = JSON.stringify(digest.replies[0])
  assert.match(found, /\[12,12,12,12\]/)
  assert.match(found, /"topLeft":8/)
  assert.equal(digest.truncated, false)
})

test('a big structure at the depth cap is still summarised', () => {
  const wide = Array.from({ length: 200 }, (_, index) => ({ id: index, name: `row ${index}` }))
  const digest = digestReplies([{ type: 'DEEP', a: { b: { c: { d: { rows: wide } } } } }])
  const found = JSON.stringify(digest.replies[0])
  assert.match(found, /nested too deep to quote|all of it in the file/)
})

test('a file a command made itself crosses untouched', () => {
  // NODE_EXPORT builds the envelope: it has already decided the name, the type and the bytes.
  // Digesting it would spill the base64 into a file of its own and leave the bridge an envelope
  // that is no longer one.
  const envelope = { [FILE_ENVELOPE]: { name: 'card.png', mime: 'image/png', encoding: 'base64', data: 'x'.repeat(5000) } }
  const digest = digestReplies([{ type: 'NODE_EXPORTED', files: [envelope] }])
  const out = (digest.replies[0] as { files: unknown[] }).files[0]
  assert.deepEqual(out, envelope)
  assert.equal(digest.files, 1)
  assert.equal(digest.truncated, false)
})
