// `ops.ts` first — the registry and the op modules import each other (see context-ops.test.ts).
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'
import { authorize } from './protocol.ts'
import { FILE_ENVELOPE } from './files.ts'

function installFigma(editorType = 'figma') {
  const store = new Map<string, string>()
  let undo = 0
  const root = {
    name: 'Brand Book',
    children: [],
    getSharedPluginData: (ns: string, key: string) => store.get(`${ns}|${key}`) ?? '',
    setSharedPluginData: (ns: string, key: string, value: string) => {
      if (value === '') store.delete(`${ns}|${key}`)
      else store.set(`${ns}|${key}`, value)
    },
    getSharedPluginDataKeys: (ns: string) => [...store.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)),
  }
  ;(globalThis as { figma?: unknown }).figma = { root, editorType, commitUndo: () => undo++ }
  return { store, undos: () => undo }
}

const run = (name: string, params: Record<string, unknown>) => (OPS_BY_NAME.get(name) as { run: (p: Record<string, unknown>) => Promise<any> }).run(params)

test('docs.write dry run reports and writes nothing; the real write is read back by docs.read', async () => {
  const fake = installFigma()
  const files = { 'SKILL.md': '# Acme creative', 'DESIGN.md': '---\nname: Acme\n---\n' }
  const dry = await run('docs.write', { files, name: 'Acme brand kit', entry: 'SKILL.md', dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.added.sort(), ['DESIGN.md', 'SKILL.md'])
  assert.equal(fake.store.size, 0)

  const wrote = await run('docs.write', { files, name: 'Acme brand kit', entry: 'SKILL.md' })
  assert.equal(wrote.verified, true)
  assert.equal(fake.undos(), 1)

  const read = await run('docs.read', {})
  assert.equal(read.guidelines.name, 'Acme brand kit')
  assert.equal(read.guidelines.entry, 'SKILL.md')
  const skill = read.files.find((f: { path: string }) => f.path === 'SKILL.md')
  assert.equal(skill.file[FILE_ENVELOPE].data, '# Acme creative')
  assert.equal(skill.file[FILE_ENVELOPE].name, 'SKILL.md')

  // the same text again changes nothing and writes nothing
  const again = await run('docs.write', { files })
  assert.equal(again.changed, false)
  assert.equal(fake.undos(), 1)
})

test('docs.read on a file without guidelines says how to add them', async () => {
  installFigma()
  const read = await run('docs.read', {})
  assert.equal(read.guidelines, null)
  assert.match(read.note, /docs\.write/)
})

test('docs.configure pins, reads back and unpins; Dev Mode refuses the write', async () => {
  installFigma()
  const set = await run('docs.configure', { set: { componentDocs: true, componentPreviews: false } })
  assert.equal(set.verified, true)
  assert.deepEqual((await run('docs.configure', {})).after, { componentDocs: true, componentPreviews: false })
  const unpinned = await run('docs.configure', { set: { componentPreviews: null } })
  assert.deepEqual(unpinned.after, { componentDocs: true })
  await assert.rejects(() => run('docs.configure', { set: { colour: 'orange' } }), /unknown setting/)

  installFigma('dev')
  await assert.rejects(() => run('docs.configure', { set: { componentDocs: true } }), /Dev Mode/)
})

test('gates: reads and dry runs need only the read gate; real writes need the write gate', () => {
  const readOnly = { read: true, write: false }
  const allowed = (op: string, params: unknown) => authorize(OPS_BY_NAME.get(op), readOnly, params).ok
  assert.equal(allowed('docs.read', {}), true)
  assert.equal(allowed('docs.configure', {}), true)
  assert.equal(allowed('docs.configure', { set: { componentDocs: true }, dryRun: true }), true)
  assert.equal(allowed('docs.configure', { set: { componentDocs: true } }), false)
  assert.equal(allowed('docs.write', { files: { 'a.md': 'A' }, dryRun: true }), true)
  assert.equal(allowed('docs.write', { files: { 'a.md': 'A' } }), false)
  assert.equal(allowed('docs.write', {}), false)
})
