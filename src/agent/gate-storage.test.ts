import test from 'node:test'
import assert from 'node:assert/strict'
import { storedGatesFor, withStoredGates } from './gate-storage.ts'

test('a development plugin never restores grants by file name', () => {
  const stored = { Untitled: { read: true, write: true } }
  assert.deepEqual(storedGatesFor(stored, null), { read: false, write: false })
  assert.deepEqual(
    withStoredGates(stored, null, 'Untitled', { read: true, write: true }),
    stored,
    'session consent is not persisted without a stable file identity'
  )
})

test('a private plugin persists grants only under the stable file key', () => {
  const next = withStoredGates(
    { Untitled: { read: true, write: true } },
    'AbC123',
    'Untitled',
    { read: true, write: false }
  )
  assert.deepEqual(next, { AbC123: { read: true, write: false } })
  assert.deepEqual(storedGatesFor(next, 'AbC123'), { read: true, write: false })
})

test('revoking a stable grant removes it', () => {
  const next = withStoredGates(
    { AbC123: { read: true, write: true }, Other: { read: true, write: false } },
    'AbC123',
    'Design',
    { read: false, write: false }
  )
  assert.deepEqual(next, { Other: { read: true, write: false } })
})
