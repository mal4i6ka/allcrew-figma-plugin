/**
 * The wire contract, from the plugin's side.
 *
 * Three shapes of this request existed at once — zip bytes with `legacy route` headers here,
 * a JSON body in the receiver, a third in a stale bundle — and none of them could talk to the
 * others. The body these tests assert IS the contract; if it has to change, the receiver changes
 * in the same commit.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverPackage, type DeliveryConfig } from './delivery.ts'

const ROUTE = {
  repo: 'git@gitlab.example:team/site.git',
  branch: 'allcrew/tokens',
  base: 'main',
  path: 'sites/site.com',
  package: '',
  project: 'team/site',
}

function config(over: Partial<DeliveryConfig> = {}): DeliveryConfig {
  return {
    endpoint: 'http://127.0.0.1:8787',
    secret: 's3cret',
    target: 'mr',
    route: { ...ROUTE },
    onChange: false,
    onOpen: false,
    ...over,
  }
}

/** Replaces `fetch` for one test and records what it was handed. */
function stubFetch(reply: { status?: number; body: string; contentType?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => reply.body,
    }
  }) as unknown as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('the request body is the contract: target, dryRun, route, files', async () => {
  const stub = stubFetch({ body: '{"ok":true,"detail":"wrote 2 files"}' })
  try {
    await deliverPackage(
      { 'static/css/tokens.css': ':root{--a:1px}', 'static/img/logo.png': { base64: 'AQID' } },
      config({ dryRun: false })
    )
  } finally {
    stub.restore()
  }

  assert.equal(stub.calls.length, 1)
  const [call] = stub.calls
  assert.equal(call.url, 'http://127.0.0.1:8787')
  assert.equal(call.init.method, 'POST')
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['x-allcrew-channel-secret'], 's3cret')

  assert.deepEqual(JSON.parse(String(call.init.body)), {
    target: 'mr',
    dryRun: false,
    route: ROUTE,
    files: {
      'static/css/tokens.css': ':root{--a:1px}',
      // Bytes survive the trip as an object, not as a mangled UTF-8 string.
      'static/img/logo.png': { base64: 'AQID' },
    },
  })
})

test('dryRun rides the body, not a header, and defaults to off when unset', async () => {
  const stub = stubFetch({ body: '{"ok":true}' })
  try {
    await deliverPackage({ 'a.css': 'a{}' }, config({ dryRun: true }))
    await deliverPackage({ 'a.css': 'a{}' }, config())
  } finally {
    stub.restore()
  }
  assert.equal(JSON.parse(String(stub.calls[0].init.body)).dryRun, true)
  assert.equal(JSON.parse(String(stub.calls[1].init.body)).dryRun, false)
})

test("a dry run's plan reaches the caller intact", async () => {
  const stub = stubFetch({
    body: JSON.stringify({
      ok: true,
      target: 'mr',
      dryRun: true,
      detail: '2 files would change',
      plan: {
        files: [
          { path: 'static/css/tokens.css', action: 'update', added: 12, removed: 3, binary: false },
          { path: 'static/img/logo.png', action: 'create', added: 0, removed: 0, binary: true },
          { path: 'README.md', action: 'unchanged', added: 0, removed: 0, binary: false },
        ],
        diff: '--- a\n+++ b\n',
        truncated: false,
      },
    }),
  })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config({ dryRun: true }))
  } finally {
    stub.restore()
  }

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.detail, '2 files would change')
  assert.equal(result.plan?.files.length, 3)
  assert.deepEqual(result.plan?.files[1], {
    path: 'static/img/logo.png',
    action: 'create',
    added: 0,
    removed: 0,
    binary: true,
  })
  assert.equal(result.plan?.diff, '--- a\n+++ b\n')
  assert.equal(result.plan?.truncated, false)
})

test('a real merge request hands back its url', async () => {
  const stub = stubFetch({
    body: '{"ok":true,"target":"mr","dryRun":false,"detail":"opened !42","url":"https://gitlab.example/team/site/-/merge_requests/42"}',
  })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config({ dryRun: false }))
  } finally {
    stub.restore()
  }
  assert.equal(result.url, 'https://gitlab.example/team/site/-/merge_requests/42')
  assert.equal(result.dryRun, false)
})

test('a JSON error reply is reported by its own words', async () => {
  const stub = stubFetch({ status: 422, body: '{"ok":false,"error":"branch allcrew/tokens is protected"}' })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config())
  } finally {
    stub.restore()
  }
  assert.equal(result.ok, false)
  assert.equal(result.status, 422)
  assert.equal(result.message, 'branch allcrew/tokens is protected')
})

test('a reply that is not JSON degrades to a message instead of throwing', async () => {
  // A proxy in front of the receiver answers HTML; a crashed one answers a stack trace.
  const stub = stubFetch({ status: 502, body: '<html><body>Bad Gateway</body></html>' })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config())
  } finally {
    stub.restore()
  }
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.message, '<html><body>Bad Gateway</body></html>')
  assert.equal(result.plan, undefined)
})

test('a 200 that is not JSON is still a success, with the text as its message', async () => {
  const stub = stubFetch({ body: 'ok' })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config())
  } finally {
    stub.restore()
  }
  assert.equal(result.ok, true)
  assert.equal(result.message, 'ok')
})

test('an empty endpoint never reaches the network', async () => {
  const stub = stubFetch({ body: '{"ok":true}' })
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config({ endpoint: '' }))
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 0)
  assert.equal(result.ok, false)
  assert.equal(result.message, 'No delivery endpoint configured.')
})

test('a transport failure is a result, not an exception', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8787')
  }) as unknown as typeof fetch
  let result
  try {
    result = await deliverPackage({ 'a.css': 'a{}' }, config())
  } finally {
    globalThis.fetch = original
  }
  assert.equal(result.ok, false)
  assert.equal(result.message, 'connect ECONNREFUSED 127.0.0.1:8787')
})
