import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveKey, applyPlaceholders } from './keys.ts'

function makeTextNode(overrides: any = {}): any {
  const store = new Map<string, string>()
  return {
    id: 'text:1',
    characters: 'Place order',
    boundVariables: undefined,
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
    ...overrides,
  }
}

test('applyPlaceholders substitutes an annotated range with a gettext placeholder', () => {
  const result = applyPlaceholders('Hello, Anna!', [{ start: 7, end: 11, name: 'username' }])
  assert.equal(result, 'Hello, %(username)s!')
})

test('applyPlaceholders returns the text unchanged when there are no placeholders', () => {
  assert.equal(applyPlaceholders('Place order', undefined), 'Place order')
  assert.equal(applyPlaceholders('Place order', []), 'Place order')
})

test('applyPlaceholders handles multiple out-of-order placeholders', () => {
  const result = applyPlaceholders('Hi Bob, you have 3 items', [
    { start: 17, end: 18, name: 'count' },
    { start: 3, end: 6, name: 'name' },
  ])
  assert.equal(result, 'Hi %(name)s, you have %(count)s items')
})

test('resolveKey defaults to the normalized node text with no msgctxt', async () => {
  const node = makeTextNode({ characters: 'Place  \norder' })
  const key = await resolveKey(node)
  assert.deepEqual(key, { msgid: 'Place order', msgctxt: '', source: 'text' })
})

test('resolveKey uses a manual pluginData context as msgctxt', async () => {
  const node = makeTextNode({ characters: 'Cancel' })
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'modal' }))

  const key = await resolveKey(node)
  assert.deepEqual(key, { msgid: 'Cancel', msgctxt: 'modal', source: 'manual' })
})

test('resolveKey applies manual placeholder annotations to the msgid', async () => {
  const node = makeTextNode({ characters: 'Hello, Anna!' })
  node.setSharedPluginData(
    'altery',
    'i18nKey',
    JSON.stringify({ placeholders: [{ start: 7, end: 11, name: 'username' }] })
  )

  const key = await resolveKey(node)
  assert.equal(key.msgid, 'Hello, %(username)s!')
  assert.equal(key.source, 'text')
})

test('resolveKey turns a manual plural annotation into msgid/msgidPlural, ignoring node text', async () => {
  const node = makeTextNode({ characters: '3 items' })
  node.setSharedPluginData(
    'altery',
    'i18nKey',
    JSON.stringify({ context: 'cart', plural: { one: '%(count)d item', other: '%(count)d items' } })
  )

  const key = await resolveKey(node)
  assert.deepEqual(key, {
    msgid: '%(count)d item',
    msgidPlural: '%(count)d items',
    msgctxt: 'cart',
    source: 'manual',
  })
})

test('resolveKey treats a bound STRING variable as the ready-made key, taking priority over manual context', async () => {
  const node = makeTextNode({
    characters: 'stale cached text',
    boundVariables: { characters: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
  })
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'ignored' }))

  ;(globalThis as any).figma = {
    variables: {
      getVariableByIdAsync: async (id: string) => {
        assert.equal(id, 'VariableID:1')
        return {
          name: 'checkout/submit_button',
          resolvedType: 'STRING',
          variableCollectionId: 'VariableCollectionId:1',
          valuesByMode: { modeEn: 'Place order', modeRu: 'Оформить заказ' },
        }
      },
      getVariableCollectionByIdAsync: async (id: string) => {
        assert.equal(id, 'VariableCollectionId:1')
        return {
          modes: [
            { modeId: 'modeEn', name: 'en' },
            { modeId: 'modeRu', name: 'ru' },
          ],
        }
      },
    },
  }

  const key = await resolveKey(node)
  assert.deepEqual(key, {
    msgid: 'Place order',
    msgctxt: 'checkout',
    source: 'variable',
    variableName: 'checkout/submit_button',
  })
})

test('resolveKey falls back past a dangling variable alias to the manual/text tiers', async () => {
  const node = makeTextNode({
    characters: 'Place order',
    boundVariables: { characters: { type: 'VARIABLE_ALIAS', id: 'missing' } },
  })

  ;(globalThis as any).figma = {
    variables: {
      getVariableByIdAsync: async () => null,
      getVariableCollectionByIdAsync: async () => null,
    },
  }

  const key = await resolveKey(node)
  assert.deepEqual(key, { msgid: 'Place order', msgctxt: '', source: 'text' })
})
