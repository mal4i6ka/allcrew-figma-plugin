import test from 'node:test'
import assert from 'node:assert/strict'
import { emitPo } from './po.ts'
import { parseTranslations } from './import.ts'
import type { ExtractedEntry } from './extract.ts'

function makeEntry(overrides: Partial<ExtractedEntry> = {}): ExtractedEntry {
  return {
    msgid: 'Place order',
    msgctxt: '',
    markup: null,
    references: ['figma://AbC123?node-id=text:1 Page 1/Checkout/CTA'],
    comment: 'Primary CTA',
    nodeIds: ['text:1'],
    ...overrides,
  }
}

test('emitPo writes a catalog header before any entries', () => {
  const po = emitPo([])

  assert.match(po, /^msgid ""\nmsgstr ""\n/)
  assert.match(po, /Content-Type: text\/plain; charset=UTF-8/)
})

test('emitPo writes #: references, #. comment, msgid and an empty msgstr', () => {
  const po = emitPo([makeEntry()])

  assert.match(po, /#\. Primary CTA/)
  assert.match(po, /#: figma:\/\/AbC123\?node-id=text:1 Page 1\/Checkout\/CTA/)
  assert.match(po, /msgid "Place order"/)
  assert.match(po, /msgstr ""/)
})

test('emitPo writes msgctxt when the entry carries an explicit context', () => {
  const po = emitPo([makeEntry({ msgctxt: 'checkout.submit' })])

  assert.match(po, /msgctxt "checkout\.submit"/)
})

test('emitPo prefers inline markup over the plain msgid', () => {
  const po = emitPo([makeEntry({ msgid: 'Read the docs', markup: 'Read <strong>the docs</strong>' })])

  assert.match(po, /msgid "Read <strong>the docs<\/strong>"/)
})

test('emitPo escapes quotes and backslashes in msgid', () => {
  const po = emitPo([makeEntry({ msgid: 'Say "hi" \\ bye' })])

  assert.match(po, /msgid "Say \\"hi\\" \\\\ bye"/)
})

test('emitPo round-trips through the import.ts PO parser', () => {
  const entry = makeEntry({ msgctxt: 'checkout.submit', msgid: 'Place order' })
  const po = emitPo([entry])

  const [parsed] = parseTranslations(po, 'po')

  assert.equal(parsed.msgctxt, 'checkout.submit')
  assert.equal(parsed.msgid, 'Place order')
  assert.equal(parsed.msgstr, '')
  assert.equal(parsed.nodeId, 'text:1')
})

test('emitPo joins multiple entries into separate blocks', () => {
  const po = emitPo([makeEntry({ msgid: 'First' }), makeEntry({ msgid: 'Second', references: [], comment: '' })])

  const parsed = parseTranslations(po, 'po')

  assert.deepEqual(
    parsed.map((entry) => entry.msgid),
    ['First', 'Second']
  )
})
