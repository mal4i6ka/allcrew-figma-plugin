import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTranslations } from './apply.ts'
import { buildNodeIndex } from './node-index.ts'
import type { TranslationEntry } from './import.ts'

function makeTextNode(overrides: any = {}): any {
  const store = new Map<string, string>()
  return {
    id: 'text:1',
    name: 'Label',
    characters: 'Place order',
    hasMissingFont: false,
    fontsLoaded: [] as unknown[],
    getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }],
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
    ...overrides,
  }
}

function setFigma(loaded: unknown[]) {
  ;(globalThis as any).figma = {
    loadFontAsync: async (font: unknown) => {
      loaded.push(font)
    },
  }
}

test('applyTranslations matches by nodeId first, loads fonts, and writes the translation', async () => {
  const loaded: unknown[] = []
  setFigma(loaded)
  const node = makeTextNode({ id: 'text:1', characters: 'Place order' })
  const index = buildNodeIndex([node])
  const entries: TranslationEntry[] = [{ nodeId: 'text:1', msgctxt: 'wrong-context', msgid: 'Different text', msgstr: 'Оформить заказ' }]

  const result = await applyTranslations(entries, index)

  assert.equal(node.characters, 'Оформить заказ')
  assert.equal(result.applied.length, 1)
  assert.equal(result.skipped.length, 0)
  assert.deepEqual(loaded, [{ family: 'Inter', style: 'Regular' }])
})

test('applyTranslations falls back to pluginData context when there is no nodeId match', async () => {
  setFigma([])
  const node = makeTextNode({ id: 'text:2', characters: 'Place order' })
  node.setSharedPluginData('allcrewChannel', 'i18nKey', JSON.stringify({ context: 'checkout.submit' }))
  const index = buildNodeIndex([node])
  const entries: TranslationEntry[] = [{ msgctxt: 'checkout.submit', msgid: '', msgstr: 'Оформить заказ' }]

  const result = await applyTranslations(entries, index)

  assert.equal(node.characters, 'Оформить заказ')
  assert.equal(result.applied[0].nodeId, 'text:2')
})

test('applyTranslations falls back to normalized text when nodeId and context both miss', async () => {
  setFigma([])
  const node = makeTextNode({ id: 'text:3', characters: 'Place  \norder' })
  const index = buildNodeIndex([node])
  const entries: TranslationEntry[] = [{ nodeId: 'does-not-exist', msgctxt: '', msgid: 'Place order', msgstr: 'Оформить заказ' }]

  const result = await applyTranslations(entries, index)

  assert.equal(node.characters, 'Оформить заказ')
  assert.equal(result.applied[0].nodeId, 'text:3')
})

test('applyTranslations backs up the pre-translation text into pluginData exactly once', async () => {
  setFigma([])
  const node = makeTextNode({ id: 'text:1', characters: 'Place order' })
  const index = buildNodeIndex([node])
  const first: TranslationEntry[] = [{ nodeId: 'text:1', msgctxt: '', msgid: '', msgstr: 'Оформить заказ' }]

  await applyTranslations(first, index)
  assert.equal(node.getSharedPluginData('allcrewChannel', 'i18nOriginal'), JSON.stringify('Place order'))

  const second: TranslationEntry[] = [{ nodeId: 'text:1', msgctxt: '', msgid: '', msgstr: 'Commander' }]
  await applyTranslations(second, index)

  // Backup stays pinned to the very first original, not the intermediate translation.
  assert.equal(node.getSharedPluginData('allcrewChannel', 'i18nOriginal'), JSON.stringify('Place order'))
})

test('applyTranslations skips nodes with a missing font and reports why', async () => {
  setFigma([])
  const node = makeTextNode({ id: 'text:1', hasMissingFont: true })
  const index = buildNodeIndex([node])
  const entries: TranslationEntry[] = [{ nodeId: 'text:1', msgctxt: '', msgid: '', msgstr: 'Оформить заказ' }]

  const result = await applyTranslations(entries, index)

  assert.equal(node.characters, 'Place order')
  assert.equal(result.applied.length, 0)
  assert.deepEqual(result.skipped, [{ entry: entries[0], reason: 'missing-font' }])
})

test('applyTranslations skips entries that match no node', async () => {
  setFigma([])
  const index = buildNodeIndex([])
  const entries: TranslationEntry[] = [{ nodeId: 'ghost', msgctxt: '', msgid: 'Never there', msgstr: 'x' }]

  const result = await applyTranslations(entries, index)

  assert.equal(result.applied.length, 0)
  assert.deepEqual(result.skipped, [{ entry: entries[0], reason: 'not-found' }])
})
