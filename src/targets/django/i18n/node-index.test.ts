import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNodeIndex } from './node-index.ts'
import { translationKey } from './normalize.ts'

function makeTextNode(overrides: any): any {
  const store = new Map<string, string>()
  return {
    id: 'text:1',
    name: 'Label',
    characters: 'Place order',
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
    ...overrides,
  }
}

test('buildNodeIndex always keys a node by its raw nodeId', () => {
  const node = makeTextNode({ id: 'text:42' })
  const index = buildNodeIndex([node])

  assert.equal(index.byNodeId.get('text:42'), node)
})

test('buildNodeIndex keys a node by its pluginData i18nKey context when set', () => {
  const node = makeTextNode({ id: 'text:1' })
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'checkout.submit' }))

  const index = buildNodeIndex([node])

  assert.equal(index.byContext.get('checkout.submit'), node)
  assert.equal(index.byContext.size, 1)
})

test('buildNodeIndex keys a node without a context by its normalized text alone', () => {
  const node = makeTextNode({ id: 'text:1', characters: 'Place  \norder' })

  const index = buildNodeIndex([node])

  assert.equal(index.byText.get(translationKey('', 'Place order')), node)
})

test('buildNodeIndex separates same-text nodes that carry different contexts', () => {
  const withCtx = makeTextNode({ id: 'text:1', characters: 'Cancel' })
  withCtx.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'modal' }))
  const withoutCtx = makeTextNode({ id: 'text:2', characters: 'Cancel' })

  const index = buildNodeIndex([withCtx, withoutCtx])

  assert.equal(index.byText.get(translationKey('modal', 'Cancel')), withCtx)
  assert.equal(index.byText.get(translationKey('', 'Cancel')), withoutCtx)
})
