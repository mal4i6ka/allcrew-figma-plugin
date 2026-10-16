/**
 * Every source file stays text.
 *
 * A raw NUL byte in a string literal (a composite-key separator, a sentinel) works at runtime and
 * turns the whole file into "data" for every tool that sniffs content: grep -I skips it, so a
 * search of code.ts silently came back empty, and git showed plan.ts as a binary diff. Write the
 * escape — `\x00` in the source is the same string at runtime.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|mjs|js)$/.test(name)) yield path
  }
}

test('no source file carries a raw NUL byte', () => {
  const offenders: string[] = []
  for (const path of sources(root)) {
    const bytes = readFileSync(path)
    const at = bytes.indexOf(0)
    if (at !== -1) offenders.push(`${path.slice(root.length)} (line ${bytes.subarray(0, at).toString('utf8').split('\n').length})`)
  }
  assert.deepEqual(offenders, [], 'write \\x00 instead of the byte itself')
})
