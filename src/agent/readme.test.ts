/**
 * The documented op tables, checked against the registry.
 *
 * `agent/README.md` is the contract an agent reads before it calls anything, and its op tables
 * are the one thing in this channel that is hand-maintained while everything else is extracted.
 * That drifted exactly as you would expect: the README said the channel had "four" write ops,
 * then "five", while the registry held seventeen — and `page.warm`, `text.segments`,
 * `variables.match`, `variables.usage`, `variables.external` and `instances.external` were not
 * documented at all. An agent reading that file as its contract was being told a smaller channel
 * existed than the one it was talking to.
 *
 * `TASK-design-md-contract-integrity.md` already litigated this failure class for the exported
 * package: "the instructions are stricter than the data underneath", and a contract the data
 * cannot satisfy is worse than no contract. This is the same defect pointed at the channel, so
 * it gets the same answer — a test, not a promise to remember.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALL_OPS } from './ops.ts'
import {
  COMMENT_MANIFEST,
  COMMENT_REFUSALS,
  HISTORY_MANIFEST,
  HISTORY_REFUSALS,
} from '../../agent/bridge.mjs'

const README = readFileSync(new URL('../../agent/README.md', import.meta.url), 'utf8')

/** Op names in a table row's first cell. `guide.list` / `guide.get` share one row. */
const DOCUMENTED = new Set(
  [...README.matchAll(/^\| `([a-z][a-zA-Z0-9.]*)`(?: \/ `([a-z][a-zA-Z0-9.]*)`)? \|/gm)].flatMap((match) =>
    [match[1], match[2]].filter((name): name is string => typeof name === 'string')
  )
)

test('every registered op has a row in the README', () => {
  const undocumented = ALL_OPS.filter((op) => !DOCUMENTED.has(op.name)).map((op) => op.name)
  assert.deepEqual(
    undocumented,
    [],
    `these ops are registered but not documented in agent/README.md: ${undocumented.join(', ')}`
  )
})

/** Every op some registry actually stands behind. Three of them, on purpose: most live in the
 * plugin's `ALL_OPS`; the comment and history READS live in the BRIDGE, because the Plugin API
 * has no comment surface and no way to render a past version, so the plugin cannot run them. */
const BRIDGE_OPS = [...COMMENT_MANIFEST, ...HISTORY_MANIFEST].map((op) => op.name)
/** Named ops that deliberately have no implementation. Listing them IS the feature: a refusal
 * nobody can find in the docs is a 404 with extra steps. */
const REFUSED = [...Object.keys(COMMENT_REFUSALS), ...Object.keys(HISTORY_REFUSALS)]

test('the README does not promise an op nothing implements', () => {
  const implemented = new Set([...ALL_OPS.map((op) => op.name), ...BRIDGE_OPS, ...REFUSED])
  // Only names that look like ops are considered: the REST refusal table and the env-var table
  // use the same row shape, and `variables.get` appearing in both is correct.
  const phantom = [...DOCUMENTED].filter((name) => name.includes('.') && !implemented.has(name))
  assert.deepEqual(phantom, [], `documented but implemented nowhere: ${phantom.join(', ')}`)
})

test('every op the bridge publishes has a row too', () => {
  const undocumented = BRIDGE_OPS.filter((name) => !DOCUMENTED.has(name))
  assert.deepEqual(undocumented, [], `bridge ops missing from agent/README.md: ${undocumented.join(', ')}`)
})

test('every refusal is documented, because a refusal nobody can find is a 404 with extra steps', () => {
  const undocumented = REFUSED.filter((name) => !DOCUMENTED.has(name))
  assert.deepEqual(undocumented, [], `refusals missing from agent/README.md: ${undocumented.join(', ')}`)
})

test('the stated write count is the real one', () => {
  // The number is prose, and prose is exactly what drifted. Spelled out because that is how the
  // sentence reads; a digit would be easier to check and harder to read.
  const WORDS: Record<number, string> = {
    4: 'four',
    5: 'five',
    15: 'fifteen',
    16: 'sixteen',
    17: 'seventeen',
    18: 'eighteen',
    19: 'nineteen',
    20: 'twenty',
    23: 'twenty-three',
    25: 'twenty-five',
    28: 'twenty-eight',
  }
  const mutating = ALL_OPS.filter((op) => op.mutates).length
  const word = WORDS[mutating]
  assert.ok(word, `no spelling for ${mutating} — add it to WORDS and update the README`)
  assert.match(
    README,
    new RegExp(`${word} of them change`, 'i'),
    `the README's write count is stale: the registry has ${mutating} (${word}) mutating ops`
  )
  assert.match(
    README,
    new RegExp(`^${word[0].toUpperCase()}${word.slice(1)} \\*\\*change\\*\\* the document`, 'im'),
    `the write table's heading count is stale: ${mutating} (${word})`
  )
})
