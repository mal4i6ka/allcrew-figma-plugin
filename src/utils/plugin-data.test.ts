import test from 'node:test'
import assert from 'node:assert/strict'
import { getPluginData, setPluginData, clearPluginData, PluginDataKey } from './plugin-data.ts'

function makeNode() {
  const store = new Map<string, string>()
  return {
    node: {
      getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
      setSharedPluginData: (namespace: string, key: string, value: string) => {
        store.set(`${namespace}:${key}`, value)
      },
    },
    store,
  }
}

test('getPluginData returns null when nothing is stored', () => {
  const { node } = makeNode()
  assert.equal(getPluginData(node, PluginDataKey.I18N_KEY), null)
})

test('setPluginData/getPluginData round-trip JSON values under the altery namespace', () => {
  const { node, store } = makeNode()

  setPluginData(node, PluginDataKey.I18N_KEY, { context: 'hero.title' })

  assert.equal(store.get(`altery:${PluginDataKey.I18N_KEY}`), JSON.stringify({ context: 'hero.title' }))
  assert.deepEqual(getPluginData(node, PluginDataKey.I18N_KEY), { context: 'hero.title' })
})

test('getPluginData returns null for corrupted JSON instead of throwing', () => {
  const { node, store } = makeNode()
  store.set(`altery:${PluginDataKey.I18N_KEY}`, '{not valid json')

  assert.equal(getPluginData(node, PluginDataKey.I18N_KEY), null)
})

test('setPluginData throws once the serialized value exceeds the 100KB pluginData limit', () => {
  const { node } = makeNode()
  const oversized = 'x'.repeat(100_001)

  assert.throws(() => setPluginData(node, PluginDataKey.I18N_KEY, oversized), /100KB/)
})

test('clearPluginData wipes the stored value', () => {
  const { node, store } = makeNode()
  setPluginData(node, PluginDataKey.I18N_KEY, 'hero.title')

  clearPluginData(node, PluginDataKey.I18N_KEY)

  assert.equal(store.get(`altery:${PluginDataKey.I18N_KEY}`), '')
  assert.equal(getPluginData(node, PluginDataKey.I18N_KEY), null)
})
