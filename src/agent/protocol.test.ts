import test from 'node:test'
import assert from 'node:assert/strict'
import { ParamError, authorize, toManifest, validateParams, type OpDef } from './protocol.ts'

const readOp: OpDef = { name: 'r.read', summary: '', mutates: false, params: {}, run: async () => null }
const writeOp: OpDef = { name: 'w.write', summary: '', mutates: true, params: {}, run: async () => null }

/* -------------------------------------------------------------------- gates */

test('authorize refuses everything when both gates are off', () => {
  const gates = { read: false, write: false }
  assert.equal(authorize(readOp, gates).ok, false)
  assert.equal(authorize(writeOp, gates).ok, false)
})

test('authorize lets reads through on the read gate alone', () => {
  assert.deepEqual(authorize(readOp, { read: true, write: false }), { ok: true })
})

test('authorize does not let the read gate carry a mutating op', () => {
  const verdict = authorize(writeOp, { read: true, write: false })
  assert.equal(verdict.ok, false)
  assert.match((verdict as { error: string }).error, /writes are off/)
})

test('authorize does not let the write gate imply reads', () => {
  assert.equal(authorize(readOp, { read: false, write: true }).ok, false)
})

test('an op that decides its own write-ness is asked, and is asked with the raw params', () => {
  // `plugin.call` runs whichever plugin command it was handed, so whether it mutates is a
  // property of the request, not of the op.
  const seen: unknown[] = []
  const doorway: OpDef = {
    name: 'plugin.call',
    summary: '',
    mutates: true,
    mutatesWhen: (raw) => {
      seen.push(raw)
      return (raw as { command?: string })?.command !== 'PURE'
    },
    params: {},
    run: async () => null,
  }
  const readOnly = { read: true, write: false }

  assert.deepEqual(authorize(doorway, readOnly, { command: 'PURE' }), { ok: true })
  assert.equal(authorize(doorway, readOnly, { command: 'DIRTY' }).ok, false)
  assert.deepEqual(seen, [{ command: 'PURE' }, { command: 'DIRTY' }])

  // With nothing to go on it must fall on the safe side of the gate.
  assert.equal(authorize(doorway, readOnly, undefined).ok, false)
})

test('authorize reports an unknown op rather than throwing', () => {
  const verdict = authorize(undefined, { read: true, write: true })
  assert.deepEqual(verdict, { ok: false, error: 'unknown op' })
})

/* --------------------------------------------------------------- manifest */

test('toManifest drops the runnable half of every op', () => {
  const manifest = toManifest([readOp, writeOp])
  assert.deepEqual(
    manifest.map((entry) => entry.name),
    ['r.read', 'w.write']
  )
  assert.equal('run' in manifest[0], false)
  assert.equal(manifest[1].mutates, true)
})

/* ------------------------------------------------------------- validation */

test('validateParams applies defaults and leaves optionals undefined', () => {
  const specs = {
    depth: { type: 'number', description: '', default: 1 },
    name: { type: 'string', description: '' },
  } as const
  assert.deepEqual(validateParams(specs, {}), { depth: 1 })
})

test('validateParams rejects a missing required param by name', () => {
  const specs = { nodeId: { type: 'string', description: '', required: true } } as const
  assert.throws(() => validateParams(specs, {}), (err: Error) => {
    assert.ok(err instanceof ParamError)
    assert.match(err.message, /missing required param "nodeId"/)
    return true
  })
})

test('validateParams rejects an unknown param and lists what is accepted', () => {
  const specs = { nodeId: { type: 'string', description: '' } } as const
  assert.throws(() => validateParams(specs, { nodeld: '1:2' }), /unknown param "nodeld" — accepted: nodeId/)
})

test('validateParams enforces enums', () => {
  const specs = { scope: { type: 'string', description: '', enum: ['page', 'document'] } } as const
  assert.deepEqual(validateParams(specs, { scope: 'document' }), { scope: 'document' })
  assert.throws(() => validateParams(specs, { scope: 'selection' }), /must be one of: page, document/)
})

test('validateParams coerces CLI-shaped strings into numbers and booleans', () => {
  const specs = {
    depth: { type: 'number', description: '' },
    deep: { type: 'boolean', description: '' },
  } as const
  assert.deepEqual(validateParams(specs, { depth: '3', deep: 'true' }), { depth: 3, deep: true })
})

test('validateParams clamps nothing — out-of-range is an error, not a silent fix', () => {
  const specs = { depth: { type: 'number', description: '', min: 0, max: 5 } } as const
  assert.throws(() => validateParams(specs, { depth: 9 }), /must be <= 5/)
  assert.throws(() => validateParams(specs, { depth: -1 }), /must be >= 0/)
})

test('validateParams rejects a non-string entry inside a string[]', () => {
  const specs = { types: { type: 'string[]', description: '' } } as const
  assert.deepEqual(validateParams(specs, { types: ['FRAME'] }), { types: ['FRAME'] })
  assert.throws(() => validateParams(specs, { types: ['FRAME', 7] }), /array of strings/)
})

test('validateParams treats a non-object payload as no params at all', () => {
  const specs = { name: { type: 'string', description: '', default: 'x' } } as const
  assert.deepEqual(validateParams(specs, null), { name: 'x' })
  assert.deepEqual(validateParams(specs, 'nonsense'), { name: 'x' })
})
