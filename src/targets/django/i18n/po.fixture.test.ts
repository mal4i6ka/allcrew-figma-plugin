/**
 * Fixture-driven unit tests (T7.2, docs/PLAN.md E7): exercises the PO generator (`emitPo`)
 * against `tests/fixtures/i18n/po-entries.json` — extractStrings()-shaped entries, one with a
 * context/comment/reference, one relying on inline markup with no context or comment.
 * Complements po.test.ts's inline-mock unit tests with coverage driven from a fixture file,
 * per the DoD's "on fixtures from tests/fixtures/" requirement.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emitPo } from './po.ts'
import { parseTranslations } from './import.ts'
import type { ExtractedEntry } from './extract.ts'

function readFixture(): { entries: ExtractedEntry[] } {
  return JSON.parse(readFileSync(new URL('../../../../tests/fixtures/i18n/po-entries.json', import.meta.url), 'utf8'))
}

test('emitPo writes a header, #. comment, #: reference and msgctxt for the fixture\'s first entry', () => {
  const { entries } = readFixture()

  const po = emitPo(entries)

  assert.match(po, /^msgid ""\nmsgstr ""\n/)
  assert.match(po, /#\. Primary CTA button label/)
  assert.match(po, /#: figma:\/\/REF-Figma2Django-0001\?node-id=10:2 Card\/Title/)
  assert.match(po, /msgctxt "checkout\.submit"/)
  assert.match(po, /msgid "Place order"/)
})

test('emitPo prefers the fixture\'s inline markup over the plain msgid and omits msgctxt/comment when absent', () => {
  const { entries } = readFixture()

  const po = emitPo(entries)

  assert.match(po, /msgid "Read <strong>the docs<\/strong>"/)
  assert.doesNotMatch(po, /msgid "Read the docs"/)
})

test('emitPo output for the fixture round-trips through the import.ts PO parser', () => {
  const { entries } = readFixture()

  const po = emitPo(entries)
  const parsed = parseTranslations(po, 'po')

  assert.deepEqual(
    parsed.map((entry) => entry.msgid),
    ['Place order', 'Read <strong>the docs</strong>']
  )
  assert.equal(parsed[0].msgctxt, 'checkout.submit')
  assert.equal(parsed[0].nodeId, '10:2')
  assert.ok(parsed.every((entry) => entry.msgstr === ''))
})
