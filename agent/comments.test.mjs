/**
 * Comments, end to end: the real bridge, a stand-in plugin, and a stand-in Figma REST API.
 *
 * Comments are the only class of op this channel answers WITHOUT the plugin — the Plugin API has
 * no comment surface at all (`grep -i comment` over `@figma/plugin-typings` returns nothing), so
 * they go out over REST from the bridge itself. That makes them the only ops that write to
 * somebody's file through a path the plugin never sees, which is exactly the path worth testing:
 * the gate, the aiming, the pin shape Figma actually receives, and the refusals for the things
 * the API cannot do.
 *
 * The fake API records every request it receives, so the assertions are about the bytes Figma
 * would have been sent — not about what this code believes it sent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SECRET = 'commentsecret0123456789abcdef0123'
const FILE_KEY = 'aBcDeFgHiJkLmNoPqRsTuV'

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

/* ------------------------------------------------------- the fake Figma API */

/** Requests the fake API saw, newest last. Cleared between tests that care. */
let seen = []
/** Comments the fake file holds. */
let store = []
let nextId = 100
let figmaStatus = null // set to force an error response

const figma = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : null
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, token: req.headers['x-figma-token'] })

    const reply = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(payload === undefined ? '' : JSON.stringify(payload))
    }
    if (figmaStatus) return reply(figmaStatus.code, figmaStatus.body)

    const comments = `/v1/files/${FILE_KEY}/comments`
    if (req.method === 'GET' && url.pathname === comments) return reply(200, { comments: store })
    if (req.method === 'POST' && url.pathname === comments) {
      const made = {
        id: `c${nextId++}`,
        file_key: FILE_KEY,
        user: { handle: 'agent' },
        created_at: new Date().toISOString(),
        resolved_at: null,
        message: parsed.message,
        order_id: parsed.comment_id ? null : String(store.filter((c) => !c.parent_id).length + 1),
        reactions: [],
        client_meta: parsed.client_meta ?? null,
        ...(parsed.comment_id ? { parent_id: parsed.comment_id } : {}),
      }
      store.push(made)
      return reply(200, made)
    }
    if (req.method === 'DELETE' && url.pathname.startsWith(comments + '/')) {
      if (url.pathname.endsWith('/reactions')) return reply(200, undefined)
      store = store.filter((c) => c.id !== url.pathname.slice(comments.length + 1))
      return reply(200, undefined) // Figma answers a delete with an empty body
    }
    if (req.method === 'POST' && url.pathname.endsWith('/reactions')) return reply(200, undefined)
    return reply(404, { err: 'not found' })
  })
})

/* ----------------------------------------------------------- bridge + plugin */

let PORT = 0
let child = null
const base = () => `http://127.0.0.1:${PORT}`

async function api(method, route, body) {
  const res = await fetch(base() + route, {
    method,
    headers: { 'content-type': 'application/json', 'x-allcrew-channel-secret': SECRET },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const call = (op, params) => api('POST', '/call', { op, params })

/** The plugin's answer to `node.anchor` — a label inside a card inside a screen at (1000, 500).
 * Mirrors what `anchorOf` really computes; `anchor.test.ts` is what proves that math. */
const ANCHOR = {
  node: { id: 'label', name: 'Label', type: 'TEXT' },
  frame: { id: 'screen', name: 'Screen', type: 'FRAME', box: { x: 1000, y: 500, width: 375, height: 812 } },
  absolute: { x: 1056, y: 596, width: 100, height: 20 },
  inFrame: { x: 56, y: 96, width: 100, height: 20 },
  offsets: {
    center: { x: 106, y: 106 },
    'top-left': { x: 56, y: 96 },
    'bottom-right': { x: 156, y: 116 },
  },
  depth: 2,
}

let pluginGates = { read: true, write: true }
let pluginSession = null
let polling = false
let anchorCalls = []

async function connectPlugin(gates = { read: true, write: true }) {
  pluginGates = gates
  const hello = await api('POST', '/plugin/hello', {
    clientId: 'c' + Math.random().toString(36).slice(2, 10),
    ops: [{ name: 'node.anchor', summary: 'aim', mutates: false, params: { nodeId: { type: 'string', description: 'id', required: true } } }],
    gates,
    file: 'Comment File',
  })
  pluginSession = hello.body.session
  polling = true
  ;(async () => {
    while (polling) {
      let poll
      try { poll = await api('GET', `/plugin/poll?session=${pluginSession}`) } catch { return }
      if (!polling || poll.status === 409) return
      for (const request of poll.body?.requests || []) {
        if (request.op === 'node.anchor') {
          anchorCalls.push(request.params)
          const point = request.params.anchor || 'center'
          const offset = ANCHOR.offsets[point] || ANCHOR.offsets.center
          await api('POST', '/plugin/result', {
            session: pluginSession,
            id: request.id,
            ok: true,
            result: { ...ANCHOR, anchor: point, pin: { node_id: ANCHOR.frame.id, node_offset: offset } },
          })
        } else {
          await api('POST', '/plugin/result', { session: pluginSession, id: request.id, ok: false, error: 'unknown op', code: 'unknown_op' })
        }
      }
    }
  })()
  return hello.body.handle
}

async function disconnectPlugin() {
  polling = false
  if (pluginSession) {
    await api('POST', '/plugin/gates', { session: pluginSession, read: false, write: false }).catch(() => {})
    pluginSession = null
  }
}

test.before(async () => {
  const figmaPort = await freePort()
  await new Promise((r) => figma.listen(figmaPort, '127.0.0.1', r))
  PORT = await freePort()
  child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
    env: {
      ...process.env,
      ALLCREW_CHANNEL_AGENT_PORT: String(PORT),
      ALLCREW_CHANNEL_AGENT_SECRET: SECRET,
      ALLCREW_CHANNEL_AGENT_HOST: '127.0.0.1',
      ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS: '5000',
      ALLCREW_CHANNEL_FIGMA_API: `http://127.0.0.1:${figmaPort}`,
      FIGMA_TOKEN: 'figd_faketoken',
      ALLCREW_CHANNEL_FIGMA_FILE_KEY: '',
      ALLCREW_CHANNEL_AGENT_FILES: path.join(HERE, '..', '.comments-test-files'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base() + '/health')).ok) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 50))
  }
})

test.after(async () => {
  await disconnectPlugin()
  if (child) child.kill('SIGKILL')
  figma.close()
})

test.beforeEach(() => {
  seen = []
  anchorCalls = []
  figmaStatus = null
})

/* ------------------------------------------------------------- the manifest */

test('the comment ops are published even with no plugin open', async () => {
  const ops = await api('GET', '/ops')
  const names = ops.body.ops.map((op) => op.name)
  for (const name of ['comments.list', 'comments.post', 'comments.reply', 'comments.remove', 'comments.react']) {
    assert.ok(names.includes(name), `${name} missing from the manifest`)
  }
  // A client that cannot see them in the manifest has no way to learn the channel can annotate.
  assert.equal(ops.body.ops.find((op) => op.name === 'comments.post').mutates, true)
  assert.equal(ops.body.ops.find((op) => op.name === 'comments.list').mutates, false)
})

test('what Figma cannot do is refused by name, not by 404', async () => {
  const refuses = (await api('GET', '/ops')).body.refuses
  for (const name of ['comments.resolve', 'comments.unresolve', 'comments.archive', 'comments.edit', 'comments.mention']) {
    assert.ok(refuses[name], `${name} should carry a reason`)
  }

  const answer = await call('comments.resolve', { fileKey: FILE_KEY, commentId: 'c1' })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.code, 'rest_unavailable')
  // The refusal has to say WHY and what to do instead, or an agent posts "done" and reports the
  // thread closed while the designer's inbox still shows it open.
  assert.match(answer.body.error, /resolved_at` is readable and read-only/)
  assert.match(answer.body.error, /Only a person can tick a thread done/)
  // And nothing was sent to Figma.
  assert.deepEqual(seen, [])
})

/* ------------------------------------------------------------------ reading */

test('threads come back grouped, with the pin made legible and resolved state read', async () => {
  store = [
    {
      id: 'root1', file_key: FILE_KEY, user: { handle: 'designer' }, created_at: '2026-09-01T10:00:00Z',
      resolved_at: null, message: 'This spacing is wrong', order_id: '1', reactions: [{ emoji: ':+1:', user: { handle: 'dev' } }],
      client_meta: { node_id: 'screen', node_offset: { x: 106, y: 106 } },
    },
    {
      id: 'reply1', parent_id: 'root1', file_key: FILE_KEY, user: { handle: 'dev' }, created_at: '2026-09-01T11:00:00Z',
      resolved_at: null, message: 'Fixed in build 42', order_id: null, reactions: [], client_meta: null,
    },
    {
      id: 'root2', file_key: FILE_KEY, user: { handle: 'designer' }, created_at: '2026-09-02T10:00:00Z',
      resolved_at: '2026-09-03T10:00:00Z', message: 'Colour was off', order_id: '2', reactions: [],
      client_meta: { x: 4000, y: 200 },
    },
  ]
  const answer = await call('comments.list', { fileKey: FILE_KEY })
  assert.equal(answer.status, 200)
  const r = answer.body.result
  assert.equal(r.threads, 2, 'a reply is part of its thread, not a thread')
  assert.equal(r.comments, 3)
  assert.equal(r.open, 1)

  // Newest thread first.
  assert.deepEqual(r.items.map((t) => t.id), ['root2', 'root1'])
  const thread = r.items.find((t) => t.id === 'root1')
  assert.equal(thread.replies.length, 1)
  assert.equal(thread.replies[0].message, 'Fixed in build 42')
  // The number the designer says out loud.
  assert.equal(thread.number, '1')
  assert.deepEqual(thread.reactions, [{ emoji: ':+1:', by: 'dev' }])
  // Figma returns four positioning shapes under one key and never says which; naming the kind
  // is the difference between reading a pin and sniffing for `node_id`.
  assert.deepEqual(thread.pin, { kind: 'frame-offset', nodeId: 'screen', offset: { x: 106, y: 106 } })
  assert.deepEqual(r.items.find((t) => t.id === 'root2').pin, { kind: 'point', at: { x: 4000, y: 200 } })

  const done = r.items.find((t) => t.id === 'root2')
  assert.equal(done.resolved, true)
  assert.equal(done.resolvedAt, '2026-09-03T10:00:00Z')
  // Every read says it, because it is the question an agent asks next.
  assert.match(r.note, /resolved is read-only/)
})

test('a region pin and a frame region are told apart', async () => {
  store = [
    { id: 'a', file_key: FILE_KEY, user: {}, created_at: '2026-09-01T10:00:00Z', message: 'm', order_id: '1', reactions: [],
      client_meta: { x: 10, y: 20, region_width: 100, region_height: 50, comment_pin_corner: 'top-left' } },
    { id: 'b', file_key: FILE_KEY, user: {}, created_at: '2026-09-02T10:00:00Z', message: 'm', order_id: '2', reactions: [],
      client_meta: { node_id: 'screen', node_offset: { x: 1, y: 2 }, region_width: 10, region_height: 10 } },
  ]
  const items = (await call('comments.list', { fileKey: FILE_KEY })).body.result.items
  assert.equal(items.find((t) => t.id === 'a').pin.kind, 'region')
  assert.equal(items.find((t) => t.id === 'b').pin.kind, 'frame-region')
  assert.equal(items.find((t) => t.id === 'a').pin.region.pinCorner, 'top-left')
})

test('filters answer the two questions worth asking', async () => {
  store = [
    { id: 'open-here', file_key: FILE_KEY, user: {}, created_at: '2026-09-01T10:00:00Z', message: 'm', order_id: '1', reactions: [], resolved_at: null, client_meta: { node_id: 'screen', node_offset: { x: 1, y: 1 } } },
    { id: 'done-here', file_key: FILE_KEY, user: {}, created_at: '2026-09-02T10:00:00Z', message: 'm', order_id: '2', reactions: [], resolved_at: '2026-09-03T10:00:00Z', client_meta: { node_id: 'screen', node_offset: { x: 2, y: 2 } } },
    { id: 'elsewhere', file_key: FILE_KEY, user: {}, created_at: '2026-09-04T10:00:00Z', message: 'm', order_id: '3', reactions: [], resolved_at: null, client_meta: { node_id: 'other', node_offset: { x: 3, y: 3 } } },
  ]
  // "What is outstanding on this screen."
  const onNode = await call('comments.list', { fileKey: FILE_KEY, nodeId: 'screen', resolved: false })
  assert.deepEqual(onNode.body.result.items.map((t) => t.id), ['open-here'])
  const anyOnNode = await call('comments.list', { fileKey: FILE_KEY, nodeId: 'screen' })
  assert.equal(anyOnNode.body.result.items.length, 2)
})

test('markdown is asked of Figma rather than rendered here', async () => {
  store = []
  await call('comments.list', { fileKey: FILE_KEY, as: 'markdown' })
  assert.equal(seen.at(-1).query.as_md, 'true')
  seen = []
  await call('comments.list', { fileKey: FILE_KEY })
  assert.equal(seen.at(-1).query.as_md, undefined)
})

test('a Figma URL is accepted wherever a key is', async () => {
  store = []
  await call('comments.list', { fileKey: `https://www.figma.com/design/${FILE_KEY}/My-File?node-id=1-2` })
  assert.equal(seen.at(-1).path, `/v1/files/${FILE_KEY}/comments`)
})

test('no file key is a named refusal — the plugin cannot supply it', async () => {
  const answer = await call('comments.list', {})
  assert.equal(answer.body.code, 'bad_request')
  // figma.fileKey is null on an Organization-private plugin, which is why this is not optional.
  assert.match(answer.body.error, /Organization-private/)
})

/* ------------------------------------------------------------------ the gate */

test('posting needs a designer present, and says so', async () => {
  await disconnectPlugin()
  const answer = await call('comments.post', { fileKey: FILE_KEY, message: 'hi', x: 1, y: 1 })
  assert.equal(answer.status, 503)
  assert.equal(answer.body.code, 'no_plugin')
  assert.match(answer.body.error, /needs the designer present/)
  assert.deepEqual(seen, [], 'nothing reached Figma')

  // Reading needs nobody: a token-holder reading comments is doing what the web app does.
  store = []
  assert.equal((await call('comments.list', { fileKey: FILE_KEY })).status, 200)
})

test('posting respects the write gate the plugin pushed', async () => {
  await disconnectPlugin()
  await connectPlugin({ read: true, write: false })
  const answer = await call('comments.post', { fileKey: FILE_KEY, message: 'hi', x: 1, y: 1 })
  assert.equal(answer.body.code, 'gate_closed')
  assert.equal(answer.body.retryable, true)
  assert.deepEqual(seen, [])

  // And a read is refused when READS are off, on the same authority.
  await disconnectPlugin()
  await connectPlugin({ read: false, write: false })
  assert.equal((await call('comments.list', { fileKey: FILE_KEY })).body.code, 'gate_closed')
  await disconnectPlugin()
})

/* ------------------------------------------------------------------ aiming */

test('a nodeId becomes a frame-relative pin, resolved by the plugin', async () => {
  await connectPlugin()
  store = []
  const answer = await call('comments.post', { fileKey: FILE_KEY, message: 'This label is 2px off', nodeId: 'label' })
  assert.equal(answer.status, 200)

  // The plugin was asked to aim.
  assert.deepEqual(anchorCalls, [{ nodeId: 'label' }])

  // THE assertion: the bytes Figma received. Addressed to the FRAME, with an offset inside it —
  // which is what makes the comment move when the designer drags the screen.
  const post = seen.find((r) => r.method === 'POST')
  assert.deepEqual(post.body, {
    message: 'This label is 2px off',
    client_meta: { node_id: 'screen', node_offset: { x: 106, y: 106 } },
  })
  assert.equal(post.token, 'figd_faketoken')
  // And the answer tells the caller where it landed, so it can say so to a human.
  assert.equal(answer.body.result.aimedAt.frame, 'screen')
  assert.equal(answer.body.result.posted.pin.kind, 'frame-offset')
})

test('the anchor point chooses which corner the pin sits on', async () => {
  store = []
  await call('comments.post', { fileKey: FILE_KEY, message: 'the corner', nodeId: 'label', anchor: 'bottom-right' })
  assert.deepEqual(anchorCalls, [{ nodeId: 'label', anchor: 'bottom-right' }])
  assert.deepEqual(seen.find((r) => r.method === 'POST').body.client_meta, {
    node_id: 'screen',
    node_offset: { x: 156, y: 116 },
  })
})

test('a size turns the pin into a region over the node', async () => {
  store = []
  await call('comments.post', { fileKey: FILE_KEY, message: 'this whole block', nodeId: 'label', width: 295, height: 120, pinCorner: 'top-left' })
  assert.deepEqual(seen.find((r) => r.method === 'POST').body.client_meta, {
    node_id: 'screen',
    node_offset: { x: 106, y: 106 },
    region_width: 295,
    region_height: 120,
    comment_pin_corner: 'top-left',
  })
})

test('without a node the pin is absolute canvas coordinates', async () => {
  store = []
  await call('comments.post', { fileKey: FILE_KEY, message: 'a note about nothing', x: 4000, y: 250 })
  assert.deepEqual(anchorCalls, [], 'no node, no aiming round trip')
  assert.deepEqual(seen.find((r) => r.method === 'POST').body.client_meta, { x: 4000, y: 250 })
})

test('nothing to pin to is refused before the request goes out', async () => {
  store = []
  const answer = await call('comments.post', { fileKey: FILE_KEY, message: 'where?' })
  assert.equal(answer.body.code, 'param_invalid')
  assert.match(answer.body.error, /nothing to pin to/)
  assert.deepEqual(seen, [])

  const blank = await call('comments.post', { fileKey: FILE_KEY, message: '   ', x: 1, y: 1 })
  assert.equal(blank.body.code, 'param_invalid')
  assert.match(blank.body.error, /a pin nobody can read/)
})

/* -------------------------------------------------------- reply, delete, react */

test('a reply carries the thread id and no pin of its own', async () => {
  store = [{ id: 'root1', file_key: FILE_KEY, user: {}, created_at: '2026-09-01T10:00:00Z', message: 'm', order_id: '1', reactions: [], client_meta: { node_id: 'screen', node_offset: { x: 1, y: 1 } } }]
  const answer = await call('comments.reply', { fileKey: FILE_KEY, commentId: 'root1', message: 'Fixed — spacing now uses spacing/md' })
  assert.equal(answer.status, 200)
  const post = seen.find((r) => r.method === 'POST')
  assert.deepEqual(post.body, { message: 'Fixed — spacing now uses spacing/md', comment_id: 'root1' })
  assert.equal(post.body.client_meta, undefined, 'a reply inherits the thread pin')
  // It really joined the thread.
  const listed = (await call('comments.list', { fileKey: FILE_KEY })).body.result
  assert.equal(listed.threads, 1)
  assert.equal(listed.items[0].replies.length, 1)
})

test('a delete is a DELETE, and the answer says it is permanent', async () => {
  store = [{ id: 'mine', file_key: FILE_KEY, user: {}, created_at: '2026-09-01T10:00:00Z', message: 'm', order_id: '1', reactions: [], client_meta: null }]
  const answer = await call('comments.remove', { fileKey: FILE_KEY, commentId: 'mine' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.result.permanent, true, 'this is not "archive" — Figma has no archive')
  assert.deepEqual(seen.map((r) => [r.method, r.path]), [['DELETE', `/v1/files/${FILE_KEY}/comments/mine`]])
  assert.equal((await call('comments.list', { fileKey: FILE_KEY })).body.result.threads, 0)
})

test('a reaction posts a shortcode, and removing one sends it as a query param', async () => {
  store = []
  const added = await call('comments.react', { fileKey: FILE_KEY, commentId: 'root1', emoji: ':+1:' })
  assert.deepEqual(seen.at(-1).body, { emoji: ':+1:' })
  assert.equal(seen.at(-1).path, `/v1/files/${FILE_KEY}/comments/root1/reactions`)
  // The closest the API comes to "done", and it must not be mistaken for resolution.
  assert.match(added.body.result.note, /not resolution/)

  seen = []
  await call('comments.react', { fileKey: FILE_KEY, commentId: 'root1', emoji: ':eyes:', remove: true })
  assert.equal(seen.at(-1).method, 'DELETE')
  assert.equal(seen.at(-1).query.emoji, ':eyes:')
})

/* --------------------------------------------------------------- credentials */

test('a scope problem is named, because it looks exactly like an expired token', async () => {
  figmaStatus = { code: 403, body: { status: 403, err: 'Invalid scope(s)' } }
  const answer = await call('comments.list', { fileKey: FILE_KEY })
  assert.equal(answer.status, 401)
  assert.equal(answer.body.code, 'unauthorized')
  // Figma's own words, plus the thing a person has to go and do about it.
  assert.match(answer.body.error, /Invalid scope/)
  assert.match(answer.body.error, /file_comments:read/)
  assert.match(answer.body.error, /cannot be added later/)
})

test('a batch can annotate several layers in one round trip', async () => {
  store = []
  const answer = await api('POST', '/calls', {
    calls: [
      { op: 'comments.post', params: { fileKey: FILE_KEY, message: 'one', nodeId: 'label' } },
      { op: 'comments.post', params: { fileKey: FILE_KEY, message: 'two', nodeId: 'label', anchor: 'top-left' } },
      { op: 'comments.list', params: { fileKey: FILE_KEY } },
    ],
  })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.ran, 3)
  assert.equal(answer.body.results[2].result.threads, 2)
  // Order is a guarantee, and it is what makes the third call's count meaningful.
  assert.deepEqual(
    seen.filter((r) => r.method === 'POST').map((r) => r.body.message),
    ['one', 'two']
  )
})
