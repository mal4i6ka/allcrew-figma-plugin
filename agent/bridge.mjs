#!/usr/bin/env node
/*
 * Altery agent bridge — the local relay between a CLI agent and the running Figma plugin.
 *
 * Figma plugins cannot be reached from outside: the sandbox has no listening socket, and
 * there is no headless mode. So the plugin dials *out* — its UI long-polls this process —
 * and this process gives a CLI something conventional to talk to:
 *
 *     agent (Claude Code, curl, anything)          plugin (UI iframe → sandbox)
 *        │  POST /call {op, params}                   │
 *        ▼                                            │ GET /plugin/poll  (parked ~25s)
 *      bridge ──────── hands the request over ────────┤
 *        │                                            │ POST /plugin/result
 *        ◄──────────── answers the waiting call ──────┘
 *
 * Deliberately dependency-free, like server/receiver.mjs — Node built-ins only. The plugin
 * carries a copy of this file and hands it over from its Agent Listener screen, so a designer
 * who installed the plugin from Figma has it without ever seeing this repo:
 *
 *     node bridge.mjs
 *
 * The secret is per-machine and nobody types it. On first run the bridge mints one into
 * ~/.altery/agent-secret (0600) and opens a five-minute pairing window; the plugin's "Pair
 * with bridge" button collects it and stores it in that designer's own client storage. So
 * every machine ends up with a different secret, nothing is baked into the built plugin, and
 * an agent reads it straight off disk:
 *
 *     curl -s localhost:8788/call -H "x-altery-secret: $(cat ~/.altery/agent-secret)" ...
 *
 * Environment:
 *   ALTERY_AGENT_SECRET       set it yourself and the bridge uses that instead — and then
 *                             does NOT open a pairing window, since you're managing the
 *                             secret by hand. Pass --pair to open one anyway.
 *   ALTERY_AGENT_SECRET_FILE  where the minted secret lives (default ~/.altery/agent-secret)
 *   ALTERY_AGENT_PORT         (default 8788)
 *   ALTERY_AGENT_HOST         (default 127.0.0.1) — loopback on purpose. Anyone who can reach
 *                             this port and knows the secret can read the open Figma file.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = parseInt(process.env.ALTERY_AGENT_PORT || '8788', 10)
const HOST = process.env.ALTERY_AGENT_HOST || '127.0.0.1'
const SECRET_FILE =
  process.env.ALTERY_AGENT_SECRET_FILE || path.join(os.homedir(), '.altery', 'agent-secret')

/** env → file → mint. Minting writes 0600 under a 0700 directory: the secret is exactly as
 * private as the account running the bridge, which is the whole trust boundary here. */
function resolveSecret() {
  if (process.env.ALTERY_AGENT_SECRET) return { secret: process.env.ALTERY_AGENT_SECRET, source: 'env' }
  try {
    const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    if (stored) return { secret: stored, source: 'file' }
  } catch {
    /* not written yet — mint below */
  }
  const secret = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 })
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 })
  return { secret, source: 'minted' }
}

const { secret: SECRET, source: SECRET_SOURCE } = resolveSecret()

/** Pairing hands the secret to a plugin that asks for it, unauthenticated — so it is bounded
 * three ways: loopback only, five minutes from a start the person just typed, and closed by
 * the first success. A hand-managed env secret opens no window at all unless --pair says so. */
const PAIR_WINDOW_MS = 5 * 60 * 1000
let pairOpenUntil =
  SECRET_SOURCE !== 'env' || process.argv.includes('--pair') ? Date.now() + PAIR_WINDOW_MS : 0
const pairingOpen = () => Date.now() < pairOpenUntil

/** Pairing is only ever offered to something on this machine. */
function isLoopback(req) {
  const address = req.socket.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** How long a parked /plugin/poll is held before answering empty. Comfortably under any
 * proxy or browser idle timeout, long enough that the poll is effectively a socket. */
const POLL_HOLD_MS = 25_000
/** A call gives up if the plugin has not answered in this long. Ops walking a whole document
 * can genuinely take a few seconds, so this is generous. */
const CALL_TIMEOUT_MS = 60_000
/** No poll renewed within this window → treat the plugin as gone. */
const OFFLINE_AFTER_MS = 45_000

const state = {
  /** Last hello from the plugin: what it can do and what the designer has allowed. */
  plugin: { lastSeen: 0, ops: [], gates: { read: false, write: false }, file: null },
  /** Requests handed over but not yet answered: id → { res, timer, op, startedAt }. */
  pending: new Map(),
  /** Requests not yet picked up by a poll. */
  queue: [],
  /** The currently parked /plugin/poll, if any. */
  poller: null,
}

const online = () => Date.now() - state.plugin.lastSeen < OFFLINE_AFTER_MS

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''))
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/* ----------------------------------------------------------------- plumbing */

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4 * 1024 * 1024) { req.destroy(); reject(new Error('payload too large')) }
    })
    req.on('end', () => {
      if (body === '') return resolve({})
      try { resolve(JSON.parse(body)) } catch { reject(new Error('body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

/** Hands everything queued to a parked poll, if both exist. */
function flush() {
  if (!state.poller || state.queue.length === 0) return
  const { res, timer } = state.poller
  state.poller = null
  clearTimeout(timer)
  const requests = state.queue.splice(0, state.queue.length)
  send(res, 200, { requests })
}

/** Fails every in-flight call — used when the plugin disappears mid-request. */
function failPending(reason) {
  for (const [id, entry] of state.pending) {
    clearTimeout(entry.timer)
    send(entry.res, 503, { ok: false, error: reason })
    state.pending.delete(id)
  }
  state.queue.length = 0
}

/* ------------------------------------------------------------------ routes */

const ROUTES = {
  /* ---- agent side ---- */

  'GET /ops': async () => ({
    code: 200,
    body: {
      online: online(),
      gates: state.plugin.gates,
      file: state.plugin.file,
      ops: state.plugin.ops,
    },
  }),

  'GET /status': async () => ({
    code: 200,
    body: {
      online: online(),
      lastSeen: state.plugin.lastSeen ? new Date(state.plugin.lastSeen).toISOString() : null,
      gates: state.plugin.gates,
      file: state.plugin.file,
      inFlight: state.pending.size,
      queued: state.queue.length,
    },
  }),

  'POST /call': async (req, res) => {
    const body = await readBody(req)
    const op = typeof body.op === 'string' ? body.op : ''
    if (!op) return { code: 400, body: { ok: false, error: 'missing "op"' } }
    if (!online()) {
      return {
        code: 503,
        body: {
          ok: false,
          error: 'plugin not connected — open the Altery plugin in Figma and turn on Settings → Agent listener → Allow reads',
        },
      }
    }

    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      state.pending.delete(id)
      send(res, 504, { ok: false, error: `no answer from the plugin within ${CALL_TIMEOUT_MS / 1000}s` })
    }, CALL_TIMEOUT_MS)

    state.pending.set(id, { res, timer, op, startedAt: Date.now() })
    state.queue.push({ id, op, params: body.params ?? {} })
    flush()
    return null // answered later, from /plugin/result
  },

  /* ---- plugin side ---- */

  'POST /plugin/hello': async (req) => {
    const body = await readBody(req)
    state.plugin.lastSeen = Date.now()
    state.plugin.ops = Array.isArray(body.ops) ? body.ops : []
    state.plugin.gates = { read: body.gates?.read === true, write: body.gates?.write === true }
    state.plugin.file = typeof body.file === 'string' ? body.file : null
    console.log(
      new Date().toISOString(),
      `plugin connected — "${state.plugin.file}" · ${state.plugin.ops.length} ops ·`,
      `read=${state.plugin.gates.read} write=${state.plugin.gates.write}`
    )
    return { code: 200, body: { ok: true, pollHoldMs: POLL_HOLD_MS } }
  },

  'GET /plugin/poll': async (req, res) => {
    state.plugin.lastSeen = Date.now()

    // One poll at a time. A second one (a reloaded plugin window) retires the first.
    if (state.poller) {
      clearTimeout(state.poller.timer)
      send(state.poller.res, 200, { requests: [] })
      state.poller = null
    }

    if (state.queue.length > 0) {
      return { code: 200, body: { requests: state.queue.splice(0, state.queue.length) } }
    }

    const timer = setTimeout(() => {
      state.poller = null
      send(res, 200, { requests: [] })
    }, POLL_HOLD_MS)
    state.poller = { res, timer }
    res.on('close', () => {
      if (state.poller && state.poller.res === res) {
        clearTimeout(timer)
        state.poller = null
      }
    })
    return null
  },

  'POST /plugin/result': async (req) => {
    const body = await readBody(req)
    state.plugin.lastSeen = Date.now()
    const entry = state.pending.get(body.id)
    // No entry means the call already timed out — the plugin answering late is not an error.
    if (!entry) return { code: 200, body: { ok: true, note: 'no caller waiting' } }
    clearTimeout(entry.timer)
    state.pending.delete(body.id)
    const ms = Date.now() - entry.startedAt
    console.log(new Date().toISOString(), `${entry.op} — ${body.ok ? 'ok' : 'error: ' + body.error} (${ms}ms)`)
    send(entry.res, body.ok ? 200 : 400, {
      ok: body.ok === true,
      op: entry.op,
      ...(body.ok ? { result: body.result } : { error: body.error || 'unknown error' }),
    })
    return { code: 200, body: { ok: true } }
  },

  'POST /plugin/gates': async (req) => {
    const body = await readBody(req)
    state.plugin.lastSeen = Date.now()
    state.plugin.gates = { read: body.read === true, write: body.write === true }
    if (!state.plugin.gates.read && !state.plugin.gates.write) {
      state.plugin.lastSeen = 0
      failPending('the designer turned the agent listener off')
    }
    console.log(new Date().toISOString(), `gates — read=${state.plugin.gates.read} write=${state.plugin.gates.write}`)
    return { code: 200, body: { ok: true } }
  },
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  // The plugin UI is an iframe on a null origin — it needs CORS to reach loopback at all.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-altery-secret')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/'

  if (path === '/' || path === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'altery-agent-bridge',
      online: online(),
      pairing: pairingOpen(),
    })
  }

  // Ahead of the secret gate on purpose: this is how a plugin gets the secret at all.
  if (path === '/pair') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'pairing is loopback-only' })
    if (!pairingOpen()) {
      return send(res, 403, {
        ok: false,
        error: 'pairing window is closed — restart the bridge (or run it with --pair) and pair within 5 minutes',
      })
    }
    pairOpenUntil = 0 // one-shot: the first plugin to ask closes the window behind itself
    console.log(new Date().toISOString(), 'paired — secret handed to the plugin, window closed')
    return send(res, 200, { ok: true, secret: SECRET })
  }

  if (!safeEqual(req.headers['x-altery-secret'], SECRET)) {
    return send(res, 401, { ok: false, error: 'bad or missing x-altery-secret' })
  }

  const route = ROUTES[`${req.method} ${path}`]
  if (!route) return send(res, 404, { ok: false, error: `no route for ${req.method} ${path}` })

  try {
    const answer = await route(req, res)
    if (answer) send(res, answer.code, answer.body)
  } catch (err) {
    const message = (err && err.message) || String(err)
    console.error(new Date().toISOString(), 'ERROR —', message)
    if (!res.headersSent) send(res, 500, { ok: false, error: message })
  }
})

// A dropped poll is how we learn the plugin closed; nothing else notices.
setInterval(() => {
  if (!online() && state.pending.size > 0) failPending('the plugin disconnected')
}, 5_000).unref()

server.listen(PORT, HOST, () => {
  console.log(`altery-agent-bridge listening on http://${HOST}:${PORT}`)
  const where =
    SECRET_SOURCE === 'env'
      ? 'ALTERY_AGENT_SECRET (yours to manage)'
      : `${SECRET_FILE} (${SECRET_SOURCE === 'minted' ? 'just created' : 'existing'})`
  console.log(`  secret: ${where}`)
  console.log('  agents read it with:  -H "x-altery-secret: $(cat ' + SECRET_FILE + ')"')
  if (pairingOpen()) {
    console.log(`  pairing OPEN for ${PAIR_WINDOW_MS / 60000} min — press "Pair with bridge" in the plugin now.`)
  } else {
    console.log('  pairing closed (secret came from the environment) — restart with --pair to open it.')
  }
  console.log('  waiting for the plugin to connect…')
})
