import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUserModule } from '../modules/contract.ts'
import { MODULE_OPS, setModuleAdminProvider } from './module-ops.ts'

const op = (name: string) => MODULE_OPS.find((entry) => entry.name === name)!

test('modules.schema returns a starter accepted by the same runtime parser', async () => {
  const result = await op('modules.schema').run({}) as Record<string, unknown>
  assert.equal(typeof result.schemaId, 'string')
  assert.ok(result.schema)
  assert.equal(parseUserModule(result.template, []).problems.length, 0)
})

test('module administration ops forward exact ids, state and downgrade consent', async () => {
  const calls: unknown[][] = []
  setModuleAdminProvider({
    list: () => ['listed'],
    inspect: (id) => ({ id }),
    install: async (file, allowDowngrade) => { calls.push(['install', file, allowDowngrade]); return { ok: true } },
    configure: async (id, enabled, state) => { calls.push(['configure', id, enabled, state]); return { ok: true } },
    remove: async (id) => { calls.push(['remove', id]); return { ok: true } },
    export: (id, includeState) => ({ id, includeState }),
  })
  try {
    await op('modules.install').run({ file: { id: 'acme.test' }, allowDowngrade: true })
    await op('modules.configure').run({ id: 'acme.test', enabled: false, state: { value: 2 } })
    await op('modules.remove').run({ id: 'acme.test' })
    assert.deepEqual(calls, [
      ['install', { id: 'acme.test' }, true],
      ['configure', 'acme.test', false, { value: 2 }],
      ['remove', 'acme.test'],
    ])
    assert.deepEqual(await op('modules.export').run({ id: 'acme.test', includeState: true }), {
      id: 'acme.test', includeState: true,
    })
  } finally {
    setModuleAdminProvider(null)
  }
})

test('module storage mutations are write-gated while authoring and inspection are reads', () => {
  for (const name of ['modules.schema', 'modules.list', 'modules.inspect', 'modules.export']) {
    assert.equal(op(name).mutates, false, name)
  }
  for (const name of ['modules.install', 'modules.configure', 'modules.remove']) {
    assert.equal(op(name).mutates, true, name)
    assert.ok(op(name).agent)
  }
})
