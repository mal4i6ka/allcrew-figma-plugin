/**
 * The error taxonomy, and the one thing that can go wrong with it: drift.
 *
 * `agent/bridge.mjs` cannot import `errors.ts` — it is a standalone dependency-free script whose
 * source is also inlined verbatim into `ui.html` at build time, so a relative import into `src/`
 * would break both. It therefore carries its own copy of the table, and a copy nobody checks is a
 * copy that is wrong within a month. This test is the check.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ERROR_CODES, failure, isRetryable } from './errors.ts'
import { ERROR_CODES, RETRYABLE_CODES } from '../../agent/bridge.mjs'

test('the bridge and the sandbox know exactly the same codes', () => {
  assert.deepEqual([...ERROR_CODES].sort(), [...AGENT_ERROR_CODES].sort())
})

test('the two halves agree on which codes are worth retrying', () => {
  for (const code of AGENT_ERROR_CODES) {
    assert.equal(
      RETRYABLE_CODES.has(code),
      isRetryable(code),
      `${code}: bridge says ${RETRYABLE_CODES.has(code)}, sandbox says ${isRetryable(code)}`
    )
  }
})

test('codes are unique — a duplicate would silently shadow itself in the set', () => {
  assert.equal(new Set(AGENT_ERROR_CODES).size, AGENT_ERROR_CODES.length)
})

test('a refusal carries the prose AND the code — the code never replaces the message', () => {
  const closed = failure('gate_closed', 'reads are off — enable "Allow reads" in the plugin')
  assert.equal(closed.code, 'gate_closed')
  assert.equal(closed.retryable, true)
  assert.match(closed.error, /Allow reads/)
})

test('the caller-mistake codes are all terminal, and the world-is-busy codes are not', () => {
  // The whole point of the split: a retry loop that cannot tell these apart either gives up on
  // a channel that is one click from working, or hammers an op that will never exist.
  for (const code of ['unknown_op', 'param_invalid', 'ambiguous_target', 'bad_request', 'no_route', 'payload_too_large', 'broadcast_write_refused', 'rest_unavailable'] as const) {
    assert.equal(isRetryable(code), false, `${code} should be terminal`)
  }
  for (const code of ['gate_closed', 'no_plugin', 'timeout', 'disconnected', 'listener_off'] as const) {
    assert.equal(isRetryable(code), true, `${code} should be retryable`)
  }
})

test('payload_too_large is terminal on purpose', () => {
  // Retrying the identical call produces the identical bytes. The only fix is a narrower
  // request, and telling a caller to try again would be telling it to waste 180 seconds.
  assert.equal(isRetryable('payload_too_large'), false)
})
