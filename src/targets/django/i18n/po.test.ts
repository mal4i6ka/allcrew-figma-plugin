import test from 'node:test'
import assert from 'node:assert/strict'
import { emitPo, emitLocaleCatalogs } from './po.ts'
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

test('emitLocaleCatalogs builds one file per target language keyed under locale/<lang>/LC_MESSAGES, excluding the source language', () => {
  const files = emitLocaleCatalogs([makeEntry()], ['en', 'ru', 'de'], 'en')

  assert.deepEqual(Object.keys(files), ['locale/de/LC_MESSAGES/django.po', 'locale/ru/LC_MESSAGES/django.po'])
})

test("emitLocaleCatalogs writes a ru catalog header with that language's own Plural-Forms, not the source's", () => {
  const files = emitLocaleCatalogs([makeEntry()], ['ru'], 'en')
  const po = files['locale/ru/LC_MESSAGES/django.po']

  assert.match(po, /"Language: ru\\n"/)
  assert.match(po, /"Plural-Forms: nplurals=3; plural=\(n%10==1 && n%100!=11 \? 0 : n%10>=2 && n%10<=4 && \(n%100<10 \|\| n%100>=20\) \? 1 : 2\);\\n"/)
  assert.match(po, /"MIME-Version: 1\.0\\n"/)
  assert.match(po, /"Content-Transfer-Encoding: 8bit\\n"/)
})

test('emitLocaleCatalogs falls back to the two-form rule for a language absent from the table', () => {
  const files = emitLocaleCatalogs([makeEntry()], ['fi'], 'en')

  assert.match(files['locale/fi/LC_MESSAGES/django.po'], /"Plural-Forms: nplurals=2; plural=\(n != 1\);\\n"/)
})

test('emitPo writes msgid_plural and one blank msgstr[n] per the target language\'s own plural count', () => {
  const entry = makeEntry({ msgid: '%(count)d item', msgidPlural: '%(count)d items', msgctxt: '' })

  const ru = emitPo([entry], { language: 'ru', sourceLanguage: 'en' })
  assert.match(ru, /msgid_plural "%\(count\)d items"/)
  assert.match(ru, /msgstr\[0\] ""\nmsgstr\[1\] ""\nmsgstr\[2\] ""/)

  const pot = emitPo([entry])
  assert.match(pot, /msgstr\[0\] ""\nmsgstr\[1\] ""/)
  assert.doesNotMatch(pot, /msgstr\[2\]/)
})

test('emitPo round-trips msgctxt through a per-locale catalog exactly like the plain figma.po extraction', () => {
  const entry = makeEntry({ msgctxt: 'checkout.submit', msgid: 'Place order' })
  const po = emitPo([entry], { language: 'ru', sourceLanguage: 'en' })

  const [parsed] = parseTranslations(po, 'po')

  assert.equal(parsed.msgctxt, 'checkout.submit')
  assert.equal(parsed.nodeId, 'text:1')
})
