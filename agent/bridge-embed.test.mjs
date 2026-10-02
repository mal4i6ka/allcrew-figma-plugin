import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { embeddedScript } from './embed-script.mjs'
import { localImports, sourceSetFiles, sourceSetFingerprint } from './source-set.mjs'

const ENTRY = resolve('agent/bridge.mjs')

test('downloadable bridge is one executable ESM file with its logical fingerprint embedded', async () => {
  const output = await embeddedScript({ file: ENTRY, bundle: true })
  assert.match(output.source, /^#!\/usr\/bin\/env node/)
  assert.deepEqual(localImports(output.source), [])
  assert.equal(output.fingerprint, sourceSetFingerprint(ENTRY))
  assert.match(output.source, new RegExp(output.fingerprint))
  assert.doesNotMatch(output.source, /__ALLCREW_BRIDGE_FINGERPRINT__/)
})

test('downloadable MCP front is self-contained and carries the fidelity contract', async () => {
  const output = await embeddedScript({ file: resolve('agent/mcp.mjs'), bundle: true })
  assert.match(output.source, /^#!\/usr\/bin\/env node/)
  assert.deepEqual(localImports(output.source), [])
  assert.match(output.source, /Fidelity-first product design contract/)
})

test('the fingerprint covers every local import transitively without duplicates', () => {
  const files = sourceSetFiles(ENTRY)
  assert.ok(files.some(({ file }) => file.endsWith('/agent/source-set.mjs')))
  assert.equal(new Set(files.map(({ file }) => file)).size, files.length)
  assert.equal(typeof sourceSetFingerprint(ENTRY), 'string')
  assert.equal(sourceSetFingerprint(ENTRY).length, 8)
})

test('import-looking paths in comments are not dependencies', () => {
  assert.deepEqual(localImports("// import thing from './missing.mjs'\nconst x = \"import './also-missing.mjs'\""), [])
})

test('an unbundled downloadable script with a local import is refused loudly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allcrew-embed-'))
  const entry = join(dir, 'entry.mjs')
  writeFileSync(entry, "#!/usr/bin/env node\nimport './sibling.mjs'\n")
  writeFileSync(join(dir, 'sibling.mjs'), 'export const value = 1\n')
  try {
    await assert.rejects(
      () => embeddedScript({ file: entry, bundle: false }),
      /would fail with ERR_MODULE_NOT_FOUND/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
