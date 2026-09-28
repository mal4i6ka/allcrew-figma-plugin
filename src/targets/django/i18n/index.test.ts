import test from 'node:test'
import assert from 'node:assert/strict'
import { importTranslations } from './index.ts'

function makeTextNode(overrides: any = {}): any {
  const store = new Map<string, string>()
  return {
    id: 'text:1',
    name: 'CTA label',
    characters: 'Place order',
    hasMissingFont: false,
    absoluteBoundingBox: { x: 8, y: 8, width: 100, height: 20 },
    parent: null,
    getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }],
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
    ...overrides,
  }
}

function makeAutoLayoutFrame(overrides: any = {}): any {
  return {
    layoutMode: 'HORIZONTAL',
    primaryAxisSizingMode: 'FIXED',
    counterAxisSizingMode: 'AUTO',
    width: 160,
    absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 40 },
    parent: null,
    ...overrides,
  }
}

function setFigma() {
  ;(globalThis as any).figma = { loadFontAsync: async () => {} }
}

test('round-trip: exporting a node then importing its own PO restores identical characters', async () => {
  setFigma()

  // Mirrors the export side's pluginData shape (T4.2, not yet built): a node the exporter
  // tagged with an explicit i18nKey context, whose original text becomes the PO msgid.
  const originalText = 'Place order'
  const node = makeTextNode({ id: 'text:1', characters: originalText })
  node.setSharedPluginData('allcrewChannel', 'i18nKey', JSON.stringify({ context: 'checkout.submit' }))

  const exportedPo = `
#: figma://AbC123?node-id=text:1 Page 1/Checkout/CTA
msgctxt "checkout.submit"
msgid "${originalText}"
msgstr "${originalText}"
`

  const first = await importTranslations(exportedPo, 'po', [node])
  assert.equal(node.characters, originalText)
  assert.equal(first.applied.length, 1)
  assert.equal(first.overflows.length, 0)

  const translatedPo = exportedPo.replace(`msgstr "${originalText}"`, 'msgstr "Оформить заказ"')
  const second = await importTranslations(translatedPo, 'po', [node])
  assert.equal(node.characters, 'Оформить заказ')

  // Revert using the backup import.ts/apply.ts wrote before the first mutation.
  const backup = JSON.parse(node.getSharedPluginData('allcrewChannel', 'i18nOriginal'))
  node.characters = backup
  assert.equal(node.characters, originalText, 'identity round-trip: original text is recoverable after translation')
})

test('round-trip: a translation twice as long as the original triggers the overflow report on a FIXED auto-layout parent', async () => {
  setFigma()

  const frame = makeAutoLayoutFrame({ width: 160, absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 40 } })
  const node = makeTextNode({ id: 'text:cta', characters: 'Place order', parent: frame })
  // Real Figma recomputes a text node's bounding box as `characters` is written; the mock
  // stands in for that by deriving width from the live text length (8px/char, at x=8).
  Object.defineProperty(node, 'absoluteBoundingBox', {
    get() {
      return { x: 8, y: 8, width: node.characters.length * 8, height: 20 }
    },
  })

  const po = `
msgid "Place order"
msgstr "Please proceed to finalize your order now"
`

  const result = await importTranslations(po, 'po', [node])

  assert.equal(node.characters, 'Please proceed to finalize your order now')
  assert.equal(result.applied.length, 1)
  assert.equal(result.overflows.length, 1)
  assert.equal(result.overflows[0].nodeId, 'text:cta')
  assert.ok(result.overflows[0].actual > result.overflows[0].expected)
})
