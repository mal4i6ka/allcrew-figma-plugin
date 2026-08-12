import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTranslations } from './import.ts'

test('parseTranslations(po) parses msgctxt/msgid/msgstr blocks and skips the header record', () => {
  const po = `
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#: figma://AbC123?node-id=42:7 Page 1/Checkout/CTA
msgctxt "checkout"
msgid "Place order"
msgstr "Оформить заказ"

msgid "Cancel"
msgstr "Отмена"
`

  const entries = parseTranslations(po, 'po')

  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { nodeId: '42:7', msgctxt: 'checkout', msgid: 'Place order', msgstr: 'Оформить заказ' })
  assert.deepEqual(entries[1], { nodeId: undefined, msgctxt: '', msgid: 'Cancel', msgstr: 'Отмена' })
})

test('parseTranslations(po) resolves escape sequences and joins multi-line quoted strings', () => {
  const po = `
msgid "Line one\\nLine two"
msgstr "Строка один"
"Строка два"
`

  const entries = parseTranslations(po, 'po')

  assert.equal(entries.length, 1)
  assert.equal(entries[0].msgid, 'Line one\nLine two')
  assert.equal(entries[0].msgstr, 'Строка одинСтрока два')
})

test('parseTranslations(json) reads a flat msgctxt -> translation map', () => {
  const json = JSON.stringify({ 'checkout.submit': 'Оформить заказ', 'nav.cancel': 'Отмена' })

  const entries = parseTranslations(json, 'json')

  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.sort((a, b) => a.msgctxt.localeCompare(b.msgctxt)),
    [
      { msgctxt: 'checkout.submit', msgid: '', msgstr: 'Оформить заказ' },
      { msgctxt: 'nav.cancel', msgid: '', msgstr: 'Отмена' },
    ]
  )
})
