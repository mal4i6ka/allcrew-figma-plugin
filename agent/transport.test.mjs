/**
 * The transport, end to end, against a real bridge process and a fake plugin window.
 *
 * `bridge.test.mjs` covers the REST fallback's pure helpers and nothing else: there was no test
 * for `dispatch`, `flush`, `failPending`, `resolveTarget`, `checkParams`, the reaper, reconnect,
 * the poll lifecycle, or any of the failure paths — i.e. no test for the mechanism the whole
 * channel is. Unit-testing those in isolation would mean re-implementing the poll handshake in
 * the test, which is the part most likely to be wrong, so this drives the actual server over
 * loopback with a stand-in for the plugin's UI iframe.
 *
 * The fake plugin is deliberately small and honest about what it is: it handshakes, long-polls,
 * and answers from a routing table the test supplies. Anything it does differently from
 * `ui.html` is a bug in this file, not a difference the bridge can see.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SECRET = 'testsecret0123456789abcdef012345'

/** A port nothing is listening on, taken and released so the bridge can bind it. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------ bridge */

let PORT = 0
let child = null
const base = () => `http://127.0.0.1:${PORT}`

async function api(method, route, body, { secret = SECRET } = {}) {
  const res = await fetch(base() + route, {
    method,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-allcrew-channel-secret': secret } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed = null
  try { parsed = await res.json() } catch { /* a 204 or a broken body — the status is the answer */ }
  return { status: res.status, body: parsed, headers: res.headers }
}

test.before(async () => {
  PORT = await freePort()
  child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs'), '--pair'], {
    env: {
      ...process.env,
      ALLCREW_CHANNEL_AGENT_PORT: String(PORT),
      ALLCREW_CHANNEL_AGENT_SECRET: SECRET,
      ALLCREW_CHANNEL_AGENT_HOST: '127.0.0.1',
      // Short enough that the timeout test does not hold the suite for three minutes, long
      // enough that a normal call is never near it.
      ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS: '5000',
      ALLCREW_CHANNEL_AGENT_FILES: path.join(HERE, '..', '.transport-test-files'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()
  // Poll /health rather than sleep: the bind is fast but not instant, and a fixed wait is either
  // flaky or slow.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(base() + '/health')
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('bridge did not come up')
})

test.after(() => {
  if (child) child.kill('SIGKILL')
})

/* ------------------------------------------------------------ fake plugin */

/**
 * A stand-in for the plugin's UI iframe: handshake, then long-poll and answer.
 *
 * `handle(request)` returns `{ ok, result }` or `{ ok: false, error, code }` — the same body the
 * sandbox posts back — or `null` to answer nothing at all, which is how the timeout path is
 * exercised without killing the connection.
 */
function fakePlugin({ file = 'Test File', ops = [], gates = { read: true, write: true }, handle }) {
  const plugin = { session: null, handle: null, stopped: false, seen: [] }

  plugin.connect = async () => {
    const hello = await api('POST', '/plugin/hello', {
      clientId: 'c' + Math.random().toString(36).slice(2, 10),
      ops,
      gates,
      file,
      fileKey: null,
    })
    assert.equal(hello.status, 200, `hello failed: ${JSON.stringify(hello.body)}`)
    plugin.session = hello.body.session
    plugin.handle = hello.body.handle
    plugin.loop = (async () => {
      while (!plugin.stopped) {
        let poll
        try {
          poll = await api('GET', `/plugin/poll?session=${encodeURIComponent(plugin.session)}`)
        } catch { return }
        if (plugin.stopped) return
        if (poll.status === 409) return // the bridge forgot us; a real iframe re-handshakes
        for (const request of poll.body?.requests || []) {
          plugin.seen.push(request)
          const answer = await handle(request)
          if (answer === null) continue // deliberately silent — the caller should time out
          await api('POST', '/plugin/result', { session: plugin.session, id: request.id, ...answer })
        }
      }
    })()
    return plugin
  }

  plugin.stop = async () => {
    plugin.stopped = true
    // How a closing window says goodbye: both gates off is the bridge's disconnect signal.
    await api('POST', '/plugin/gates', { session: plugin.session, read: false, write: false }).catch(() => {})
  }

  return plugin
}

const ECHO_OPS = [
  { name: 'document.info', summary: 'file facts', mutates: false, params: {} },
  {
    name: 'node.get',
    summary: 'one node',
    mutates: false,
    params: { nodeId: { type: 'string', description: 'id', required: true } },
  },
  { name: 'node.bind', summary: 'bind', mutates: true, agent: 'binds fields to variables', params: {} },
]

/* ------------------------------------------------------------------- tests */

test('no plugin connected is a named refusal, not a hang', async () => {
  const answer = await api('POST', '/call', { op: 'document.info' })
  assert.equal(answer.status, 503)
  assert.equal(answer.body.code, 'no_plugin')
  // Retryable: a human opens the plugin and the identical call works.
  assert.equal(answer.body.retryable, true)
})

test('a bad secret is 401 with a code, and no route leaks past it', async () => {
  const answer = await api('POST', '/call', { op: 'document.info' }, { secret: 'wrong' })
  assert.equal(answer.status, 401)
  assert.equal(answer.body.code, 'unauthorized')

  const missing = await api('GET', '/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'no_route')
})

test('/pair is readable by Figma’s null-origin iframe, never by an ordinary web origin', async () => {
  const preflight = await fetch(base() + '/pair', {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-private-network': 'true',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null')
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')

  const hostile = await fetch(base() + '/pair', {
    method: 'POST',
    headers: { origin: 'https://example.com' },
  })
  assert.equal(hostile.status, 403)
  assert.equal(hostile.headers.get('access-control-allow-origin'), null)

  const pair = await fetch(base() + '/pair', { method: 'POST', headers: { origin: 'null' } })
  assert.equal(pair.status, 200)
  assert.equal(pair.headers.get('access-control-allow-origin'), 'null')
  assert.equal((await pair.json()).secret, SECRET)

  const health = await fetch(base() + '/health')
  assert.equal(health.headers.get('access-control-allow-origin'), '*')
})

test('the live browser client serves the real UI and round-trips commands and sandbox events', async () => {
  const clientId = 'mirror-test-client'
  const hello = await api('POST', '/mirror/plugin/hello', {
    clientId,
    file: 'Live Design',
    gates: { read: true, write: true },
    source: '<html><head></head><body><main id="real-ui">real plugin UI</main></body></html>',
    snapshot: [{ type: 'EXPORT_OPTIONS', options: { target: 'django' } }],
  })
  assert.equal(hello.status, 200)
  assert.equal(hello.body.handle, 'live-design')

  const page = await fetch(base() + '/ui?target=live-design')
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(html, /__ALLCREW_BROWSER_MIRROR__/)
  assert.match(html, /real plugin UI/)

  const initial = await api(
    'GET',
    '/mirror/events?target=live-design&viewerId=viewer-a&cursor=0'
  )
  assert.equal(initial.status, 200)
  assert.equal(initial.body.events[0].message.type, 'EXPORT_OPTIONS')
  const cursor = initial.body.cursor
  const generation = initial.body.generation

  const command = await api('POST', '/mirror/command', {
    target: 'live-design',
    viewerId: 'viewer-a',
    message: { type: 'SCAN', scope: { mode: 'page' } },
  })
  assert.equal(command.status, 202)

  const polled = await api('GET', `/mirror/plugin/poll?clientId=${clientId}`)
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body.commands[0].message, { type: 'SCAN', scope: { mode: 'page' } })

  const event = await api('POST', '/mirror/plugin/event', {
    clientId,
    message: { type: 'SCAN_RESULT', summary: { nodes: 12 } },
  })
  assert.equal(event.status, 200)
  const live = await api(
    'GET',
    `/mirror/events?target=live-design&viewerId=viewer-a&cursor=${cursor}&generation=${generation}`
  )
  assert.deepEqual(live.body.events.map((entry) => entry.message.type), ['SCAN_RESULT'])

  const secondController = await api('POST', '/mirror/command', {
    target: 'live-design',
    viewerId: 'viewer-b',
    message: { type: 'SCAN', scope: { mode: 'selection' } },
  })
  assert.equal(secondController.status, 409)
  assert.match(secondController.body.error, /another browser tab/)

  const bye = await api('POST', '/mirror/plugin/bye', { clientId })
  assert.equal(bye.status, 200)

  const rehello = await api('POST', '/mirror/plugin/hello', {
    clientId,
    file: 'Live Design',
    gates: { read: true, write: true },
    source: '<html><head></head><body>reconnected</body></html>',
    snapshot: [{ type: 'RECONNECTED' }],
  })
  assert.equal(rehello.status, 200)
  const replay = await api(
    'GET',
    `/mirror/events?target=live-design&viewerId=viewer-a&cursor=999&generation=${generation}`
  )
  assert.deepEqual(replay.body.events.map((entry) => entry.message.type), ['RECONNECTED'])
  assert.notEqual(replay.body.generation, generation)
  await api('POST', '/mirror/plugin/bye', { clientId })
})

test('a call reaches the plugin and the answer comes back named by file', async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async (request) => ({ ok: true, result: { echoed: request.op, params: request.params } }),
  }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'document.info' })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.result.echoed, 'document.info')
    // Which document answered is part of the answer.
    assert.equal(answer.body.handle, plugin.handle)
    assert.equal(answer.body.file, 'Test File')
  } finally {
    await plugin.stop()
  }
})

test("the plugin's own refusal code survives the trip instead of being guessed from the text", async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async () => ({
      ok: false,
      error: 'reads are off — enable "Allow reads" in the plugin',
      code: 'gate_closed',
      retryable: true,
    }),
  }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'document.info' })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.code, 'gate_closed')
    assert.equal(answer.body.retryable, true)
    // Only the sandbox knows this; re-deriving it here from the prose is the guessing the code
    // exists to remove.
    assert.match(answer.body.error, /Allow reads/)
  } finally {
    await plugin.stop()
  }
})

test('a refusal with no code at all is still classified rather than left blank', async () => {
  // An older plugin build sends prose and nothing else. The answer must still be actionable.
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async () => ({ ok: false, error: 'something went wrong inside Figma' }),
  }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'document.info' })
    assert.equal(answer.body.code, 'figma_threw')
    assert.equal(answer.body.retryable, true)
  } finally {
    await plugin.stop()
  }
})

test('a bad param is caught at the bridge, before the plugin is woken', async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async () => ({ ok: true, result: 'should never run' }),
  }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'node.get', params: { node: '1:2' } })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.code, 'param_invalid')
    assert.ok(Array.isArray(answer.body.problems) && answer.body.problems.length > 0)
    // The point of checking here: a misspelled param used to reach an op that answered
    // "ok, 0 changed" having done nothing.
    assert.deepEqual(plugin.seen, [])
  } finally {
    await plugin.stop()
  }
})

test('a missing op is a 400 with a code, not a silent relay', async () => {
  const answer = await api('POST', '/call', {})
  assert.equal(answer.status, 400)
  assert.equal(answer.body.code, 'bad_request')
  assert.equal(answer.body.retryable, false)
})

/* ------------------------------------------------------------------ batch */

test('a batch runs in order, in ONE round trip, and stops at the first failure', async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async (request) =>
      request.params?.boom
        ? { ok: false, error: 'refused', code: 'figma_threw' }
        : { ok: true, result: { step: request.params?.step } },
  }).connect()
  try {
    const answer = await api('POST', '/calls', {
      calls: [
        { op: 'document.info', params: { step: 1 } },
        { op: 'document.info', params: { step: 2, boom: true } },
        { op: 'document.info', params: { step: 3 } },
      ],
    })
    assert.equal(answer.status, 200, 'the batch RAN — 200 is about the batch, not its contents')
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.batch, true)
    assert.equal(answer.body.ran, 2)
    assert.equal(answer.body.of, 3)
    assert.equal(answer.body.failedAt, 1)
    // Order is a guarantee, not an accident: the sandbox does not serialize requests, so a
    // parallel batch would interleave and mis-attribute the state the ops share.
    assert.deepEqual(plugin.seen.map((r) => r.params.step), [1, 2])
    // Step three never ran — a batch that keeps writing after a refusal leaves a half-built
    // screen nobody asked for.
    assert.equal(answer.body.results.length, 2)
  } finally {
    await plugin.stop()
  }
})

test('continueOnError runs the whole batch and still reports where it broke', async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async (request) =>
      request.params?.boom ? { ok: false, error: 'refused', code: 'figma_threw' } : { ok: true, result: 'fine' },
  }).connect()
  try {
    const answer = await api('POST', '/calls', {
      continueOnError: true,
      calls: [
        { op: 'document.info', params: { step: 1 } },
        { op: 'document.info', params: { step: 2, boom: true } },
        { op: 'document.info', params: { step: 3 } },
      ],
    })
    assert.equal(answer.body.ran, 3)
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.failedAt, 1)
    assert.deepEqual(answer.body.results.map((r) => r.ok), [true, false, true])
  } finally {
    await plugin.stop()
  }
})

test('a batch names the file once, and every call inherits it', async () => {
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    handle: async () => ({ ok: true, result: 'fine' }),
  }).connect()
  try {
    const answer = await api('POST', '/calls', {
      target: plugin.handle,
      calls: [{ op: 'document.info' }, { op: 'document.info' }],
    })
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.ran, 2)
    for (const result of answer.body.results) assert.equal(result.handle, plugin.handle)
  } finally {
    await plugin.stop()
  }
})

test('an empty or oversized batch is refused before anything runs', async () => {
  const empty = await api('POST', '/calls', { calls: [] })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'bad_request')

  const missing = await api('POST', '/calls', {})
  assert.equal(missing.body.code, 'bad_request')

  const huge = await api('POST', '/calls', { calls: Array.from({ length: 33 }, () => ({ op: 'document.info' })) })
  assert.equal(huge.status, 400)
  assert.equal(huge.body.code, 'bad_request')
  assert.match(huge.body.error, /over the limit/)
})

/* ------------------------------------------------------------ the roster */

test('two files connected and no target named is a refusal carrying the roster', async () => {
  const one = await fakePlugin({ file: 'Alpha', ops: ECHO_OPS, handle: async () => ({ ok: true, result: 1 }) }).connect()
  const two = await fakePlugin({ file: 'Beta', ops: ECHO_OPS, handle: async () => ({ ok: true, result: 2 }) }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'document.info' })
    assert.equal(answer.status, 409)
    assert.equal(answer.body.code, 'ambiguous_target')
    // Refusing without the roster would make the caller guess. Never routed by guess: that is
    // the whole safety property.
    assert.equal(answer.body.files.length, 2)
    assert.deepEqual(answer.body.files.map((f) => f.file).sort(), ['Alpha', 'Beta'])

    // Named, it lands on exactly that file.
    const named = await api('POST', '/call', { op: 'document.info', target: two.handle })
    assert.equal(named.body.result, 2)
  } finally {
    await one.stop()
    await two.stop()
  }
})

test('a broadcast write is refused; a broadcast read answers per file', async () => {
  const one = await fakePlugin({ file: 'Alpha', ops: ECHO_OPS, handle: async () => ({ ok: true, result: 'a' }) }).connect()
  const two = await fakePlugin({ file: 'Beta', ops: ECHO_OPS, handle: async () => ({ ok: true, result: 'b' }) }).connect()
  try {
    const write = await api('POST', '/call', { op: 'node.bind', target: '*' })
    assert.equal(write.status, 400)
    assert.equal(write.body.code, 'broadcast_write_refused')

    const read = await api('POST', '/call', { op: 'document.info', target: '*' })
    assert.equal(read.body.broadcast, true)
    assert.equal(read.body.count, 2)
    assert.deepEqual(read.body.results.map((r) => r.result).sort(), ['a', 'b'])
  } finally {
    await one.stop()
    await two.stop()
  }
})

/* ------------------------------------------------- disappearing mid-call */

test('a window that closes mid-call fails that call as disconnected, not as a timeout', async () => {
  let arrived = null
  const plugin = await fakePlugin({
    ops: ECHO_OPS,
    // Never answers: the call is in flight when the window goes away.
    handle: async (request) => { arrived = request; return null },
  }).connect()

  const call = api('POST', '/call', { op: 'document.info' })
  for (let attempt = 0; attempt < 100 && !arrived; attempt++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(arrived, 'the request never reached the plugin')

  await plugin.stop()
  const answer = await call
  assert.equal(answer.status, 400)
  // `listener_off` rather than `timeout`: the caller learns the window went away in the same
  // moment it happened, instead of waiting out the full ceiling for a lie about no answer.
  assert.equal(answer.body.code, 'listener_off')
  assert.equal(answer.body.retryable, true)
})

test('a plugin that answers nothing at all times out with the timeout code', async () => {
  const plugin = await fakePlugin({ ops: ECHO_OPS, handle: async () => null }).connect()
  try {
    const answer = await api('POST', '/call', { op: 'document.info' })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.code, 'timeout')
    assert.equal(answer.body.retryable, true)
    // The message names the knob, because raising it is sometimes the right move.
    assert.match(answer.body.error, /ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS|bridge ceiling/)
  } finally {
    await plugin.stop()
  }
})

test('the roster and the ops manifest are what the plugin published', async () => {
  const plugin = await fakePlugin({ ops: ECHO_OPS, handle: async () => ({ ok: true, result: null }) }).connect()
  try {
    const status = await api('GET', '/status')
    assert.equal(status.body.online, true)
    assert.equal(status.body.files.length, 1)
    assert.deepEqual(status.body.files[0].gates, { read: true, write: true })

    const ops = await api('GET', '/ops')
    const names = ops.body.files[0].ops.map((op) => op.name)
    // The plugin's own ops, in the order it published them...
    assert.deepEqual(names.slice(0, 3), ['document.info', 'node.get', 'node.bind'])
    // ...followed by the ops the BRIDGE owns. Comments are the only class the plugin cannot run
    // at all — the Plugin API has no comment surface — so the bridge publishes them itself, and
    // a client that could not see them in the manifest would never learn they exist.
    assert.ok(names.includes('comments.list'), 'the bridge publishes its own ops too')
    assert.equal(ops.body.files[0].ops.find((op) => op.name === 'comments.list').source, 'rest')
    // `mutates` has to survive: it is what the MCP front marks a tool with, and what the
    // broadcast refusal is decided on.
    assert.equal(ops.body.files[0].ops.find((op) => op.name === 'node.bind').mutates, true)
  } finally {
    await plugin.stop()
  }
})
