import test from 'node:test'
import assert from 'node:assert/strict'
import { getAnnotation, setAnnotation, validateAnnotation } from './annotation.ts'

function makeNode(characters = 'Hello, Anna!'): any {
  const store = new Map<string, string>()
  return {
    characters,
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
  }
}

test('getAnnotation returns null when nothing was ever set', () => {
  assert.equal(getAnnotation(makeNode()), null)
})

test('setAnnotation/getAnnotation round-trip a manual context', () => {
  const node = makeNode()
  setAnnotation(node, { context: 'checkout.submit' })
  assert.deepEqual(getAnnotation(node), { context: 'checkout.submit' })
})

test('setAnnotation/getAnnotation round-trip plural forms', () => {
  const node = makeNode()
  setAnnotation(node, { plural: { one: '%(count)d item', other: '%(count)d items' } })
  assert.deepEqual(getAnnotation(node), { plural: { one: '%(count)d item', other: '%(count)d items' } })
})

test('setAnnotation/getAnnotation round-trip placeholder ranges', () => {
  const node = makeNode('Hello, Anna!')
  setAnnotation(node, { placeholders: [{ start: 7, end: 11, name: 'username' }] })
  assert.deepEqual(getAnnotation(node), { placeholders: [{ start: 7, end: 11, name: 'username' }] })
})

test('setAnnotation rejects a plural annotation missing the "other" form', () => {
  const node = makeNode()
  assert.throws(() => setAnnotation(node, { plural: { one: '%(count)d item', other: '' } }), /plural annotation requires/)
})

test('setAnnotation rejects a placeholder with an invalid name', () => {
  const node = makeNode('Hello, Anna!')
  assert.throws(
    () => setAnnotation(node, { placeholders: [{ start: 7, end: 11, name: '1nvalid' }] }),
    /invalid placeholder name/
  )
})

test('setAnnotation rejects a placeholder range past the end of the text', () => {
  const node = makeNode('Hi!')
  assert.throws(
    () => setAnnotation(node, { placeholders: [{ start: 0, end: 20, name: 'name' }] }),
    /out-of-range/
  )
})

test('setAnnotation rejects overlapping placeholders', () => {
  const node = makeNode('Hello, Anna, welcome!')
  assert.throws(
    () =>
      setAnnotation(node, {
        placeholders: [
          { start: 0, end: 10, name: 'a' },
          { start: 5, end: 15, name: 'b' },
        ],
      }),
    /overlaps/
  )
})

test('validateAnnotation accepts an empty annotation', () => {
  assert.doesNotThrow(() => validateAnnotation({}, 10))
})
