import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHUNK_BYTES,
  FILE_DOCS_NAMESPACE,
  GUIDELINES_KEY,
  applyFileDocsConfig,
  applyGuidelines,
  chunkUtf8,
  guidelinePathProblem,
  normalizeFileDocsConfig,
  planGuidelines,
  readFileDocsConfig,
  readGuidelines,
  utf8Bytes,
  writeFileDocsConfig,
  type SharedDataHost,
} from './file-docs.ts'

/** Figma's shared plugin data, as far as these functions use it — including its 100 kB ceiling. */
function fakeRoot(): SharedDataHost & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getSharedPluginData: (ns, key) => store.get(`${ns}|${key}`) ?? '',
    setSharedPluginData: (ns, key, value) => {
      if (utf8Bytes(ns + key + value) > 100_000) throw new Error('entry exceeds 100 kB')
      if (value === '') store.delete(`${ns}|${key}`)
      else store.set(`${ns}|${key}`, value)
    },
    getSharedPluginDataKeys: (ns) => [...store.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)),
  }
}

let clock = 0
const gen = () => `g${++clock}`
const now = () => '2026-11-27T10:00:00.000Z'

test('utf8Bytes counts what Figma counts, not UTF-16 units', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('ё'), 2)
  assert.equal(utf8Bytes('→'), 3)
  assert.equal(utf8Bytes('🟠'), 4)
})

test('chunkUtf8 never splits a code point and reassembles exactly', () => {
  const text = 'Acme → ёлка 🟠 '.repeat(5000)
  const chunks = chunkUtf8(text, 1000)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(utf8Bytes(chunk) <= 1000)
  assert.equal(chunks.join(''), text)
  assert.deepEqual(chunkUtf8(''), [''])
})

test('paths: relative, plain segments, text formats only', () => {
  assert.equal(guidelinePathProblem('DESIGN.md'), null)
  assert.equal(guidelinePathProblem('skill/SKILL.md'), null)
  assert.equal(guidelinePathProblem('rules/brand-rules.json'), null)
  assert.match(guidelinePathProblem('/etc/passwd.md') ?? '', /relative/)
  assert.match(guidelinePathProblem('../x.md') ?? '', /segment/)
  assert.match(guidelinePathProblem('logo.png') ?? '', /text format/)
  assert.match(guidelinePathProblem('a b.md') ?? '', /letters/)
})

test('a set written is the set read back, big files chunked under the entry limit', () => {
  const root = fakeRoot()
  const big = '# Brand\n' + 'Orange #FB5B0A. '.repeat(20_000) // ~320 KB
  const plan = planGuidelines(root, { name: 'Acme brand kit', entry: 'SKILL.md', files: { 'SKILL.md': '# Skill', 'DESIGN.md': big } }, now, gen)
  assert.deepEqual(plan.added.sort(), ['DESIGN.md', 'SKILL.md'])
  applyGuidelines(root, plan)
  const read = readGuidelines(root)
  assert.equal(read.manifest?.name, 'Acme brand kit')
  assert.equal(read.manifest?.entry, 'SKILL.md')
  assert.deepEqual(read.damaged, [])
  assert.equal(read.files.find((f) => f.path === 'DESIGN.md')?.text, big)
  assert.ok((read.manifest?.files.find((f) => f.path === 'DESIGN.md')?.chunks ?? 0) >= Math.ceil(utf8Bytes(big) / CHUNK_BYTES))
})

test('merge by default, null removes, replace keeps only what is given; old generations are cleaned up', () => {
  const root = fakeRoot()
  applyGuidelines(root, planGuidelines(root, { name: 'Kit', files: { 'a.md': 'A', 'b.md': 'B' } }, now, gen))
  const firstGen = readGuidelines(root).manifest?.gen

  const merge = planGuidelines(root, { files: { 'b.md': 'B2', 'c.md': 'C', 'a.md': null } }, now, gen)
  assert.deepEqual(merge.removed, ['a.md'])
  assert.deepEqual(merge.replaced, ['b.md'])
  assert.deepEqual(merge.added, ['c.md'])
  applyGuidelines(root, merge)
  assert.deepEqual(readGuidelines(root).files.map((f) => f.path), ['b.md', 'c.md'])
  // nothing of the first generation is left behind
  assert.ok(!root.getSharedPluginDataKeys(FILE_DOCS_NAMESPACE).some((k) => k.startsWith(`${GUIDELINES_KEY}.${firstGen}.`)))

  const replace = planGuidelines(root, { replace: true, files: { 'only.md': 'X' } }, now, gen)
  applyGuidelines(root, replace)
  assert.deepEqual(readGuidelines(root).files.map((f) => f.path), ['only.md'])
  assert.deepEqual(replace.removed.sort(), ['b.md', 'c.md'])
})

test('the manifest switches last: a reader mid-write still sees the old, complete set', () => {
  const root = fakeRoot()
  applyGuidelines(root, planGuidelines(root, { name: 'Kit', files: { 'a.md': 'old' } }, now, gen))
  const plan = planGuidelines(root, { files: { 'a.md': 'new' } }, now, gen)
  const manifestAt = plan.writes.findIndex((w) => w.key === GUIDELINES_KEY)
  // apply only the chunk writes, as if the call died before the manifest
  for (const w of plan.writes.slice(0, manifestAt)) root.setSharedPluginData(FILE_DOCS_NAMESPACE, w.key, w.value)
  assert.equal(readGuidelines(root).files[0].text, 'old')
  for (const w of plan.writes.slice(manifestAt)) root.setSharedPluginData(FILE_DOCS_NAMESPACE, w.key, w.value)
  assert.equal(readGuidelines(root).files[0].text, 'new')
})

test('clear removes the manifest and every chunk', () => {
  const root = fakeRoot()
  applyGuidelines(root, planGuidelines(root, { name: 'Kit', files: { 'a.md': 'A' } }, now, gen))
  root.setSharedPluginData(FILE_DOCS_NAMESPACE, 'i18nKey', '"greeting"')
  applyGuidelines(root, planGuidelines(root, { clear: true }, now, gen))
  assert.equal(readGuidelines(root).manifest, null)
  // the plugin's other data on the root is untouched
  assert.deepEqual(root.getSharedPluginDataKeys(FILE_DOCS_NAMESPACE), ['i18nKey'])
})

test('invalid changes are refused whole, nothing planned', () => {
  const root = fakeRoot()
  assert.throws(() => planGuidelines(root, { files: { 'a.md': 'A' } }, now, gen), /name the set/)
  assert.throws(() => planGuidelines(root, { name: 'K', files: { 'x.png': 'A' } }, now, gen), /text format/)
  assert.throws(() => planGuidelines(root, { name: 'K', entry: 'missing.md', files: { 'a.md': 'A' } }, now, gen), /entry/)
  assert.throws(() => planGuidelines(root, { name: 'K', files: { 'big.md': 'x'.repeat(600 * 1024) } }, now, gen), /per file/)
  assert.equal(root.store.size, 0)
})

test('docs settings: validated, pinned in the file, and laid over each person\'s', () => {
  assert.deepEqual(normalizeFileDocsConfig({ componentDocs: true, previewBudgetMb: 8.4 }).config, { componentDocs: true, previewBudgetMb: 8 })
  assert.match(normalizeFileDocsConfig({ components: true }).problems[0], /unknown setting/)
  assert.match(normalizeFileDocsConfig({ previewBudgetMb: 0 }).problems[0], /1 to 512/)
  const root = fakeRoot()
  assert.equal(readFileDocsConfig(root), null)
  writeFileDocsConfig({ componentDocs: true, componentPreviews: false }, root)
  const pinned = readFileDocsConfig(root)
  assert.deepEqual(pinned, { componentDocs: true, componentPreviews: false })
  const person = { docs: { componentDocs: false, componentPreviews: true, previewBudgetMb: 64 }, other: 1 }
  assert.deepEqual(applyFileDocsConfig(person, pinned), { docs: { componentDocs: true, componentPreviews: false, previewBudgetMb: 64 }, other: 1 })
  writeFileDocsConfig(null, root)
  assert.equal(readFileDocsConfig(root), null)
})
