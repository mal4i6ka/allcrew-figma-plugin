#!/usr/bin/env node
/*
 * AllCrew Figma Workspace bridge — the local relay between a CLI agent and the running Figma plugins.
 *
 * Figma plugins cannot be reached from outside: the sandbox has no listening socket, and
 * there is no headless mode. So each plugin UI dials *out* over an authenticated loopback
 * WebSocket (falling back to HTTP polling for older clients), and this process gives a CLI
 * something conventional to talk to:
 *
 *     agent (Claude Code, curl, anything)          plugin (UI iframe → sandbox)
 *        │  POST /call {op, params, target}           │
 *        ▼                                            │ WebSocket /plugin/ws
 *      bridge ──────── hands the request over ────────┤
 *        │                                            │ result on the same socket
 *        ◄──────────── answers the waiting call ──────┘
 *
 * MANY plugins, not one. A design system lives in one file and is consumed in others, so the
 * questions worth asking are usually cross-file: which components are actually instantiated,
 * what a token change did downstream, where the raw colours are. Figma gives a plugin only a
 * published-library view of its neighbours; two plugin windows on one bridge give an agent the
 * full op surface against both documents at once, which no Figma API offers.
 *
 * Every connection therefore gets its own registry entry, socket (or compatibility poll) and
 * queue, and every call names its target:
 *
 *     POST /call {"op":"lint.colors","target":"mobile"}   → one file
 *     POST /call {"op":"lint.colors","target":"*"}        → every file, one answer each
 *
 * A call that names no target is answered only when exactly one file is connected. With more
 * than one it is refused with the roster attached — never routed by guess. That refusal is the
 * whole safety property: an unaddressed write must not be able to land in the wrong document.
 *
 * Identity is a `clientId` the plugin window mints once when it loads and repeats on every
 * hello. A window says hello more than once — reconnecting after a bridge restart, or whenever
 * the designer flips a gate — and keying on anything else would file the same window twice,
 * putting phantom duplicates in the roster and making an unaddressed call look ambiguous when
 * only one file is really open. `figma.fileKey` would be the natural key but it is exposed only
 * to private plugins on Organization plans, so it is absent for almost everyone; the file *name*
 * is carried as the human handle and is what an agent actually types.
 *
 * Runtime dependencies are Node built-ins only. The repository source is split into reviewed
 * local modules; build.mjs bundles that source set into the single bridge.mjs the plugin hands
 * over from its Agent Listener screen, so an installed designer never needs the checkout:
 *
 *     node bridge.mjs
 *
 * The secret is per-machine and nobody types it. On first run the bridge mints one into
 * ~/.allcrew-channel/agent-secret (0600) and opens a five-minute pairing window; the plugin's "Pair
 * with bridge" button collects it and stores it in that designer's own client storage. So
 * every machine ends up with a different secret, nothing is baked into the built plugin, and
 * an agent reads it straight off disk:
 *
 *     curl -s localhost:8788/call -H "x-allcrew-channel-secret: $(cat ~/.allcrew-channel/agent-secret)" ...
 *
 * Environment:
 *   ALLCREW_CHANNEL_AGENT_SECRET       set it yourself and the bridge uses that instead — and then
 *                             does NOT open a pairing window, since you're managing the
 *                             secret by hand. Pass --pair to open one anyway.
 *   ALLCREW_CHANNEL_AGENT_SECRET_FILE  where the minted secret lives (default ~/.allcrew-channel/agent-secret)
 *   ALLCREW_CHANNEL_AGENT_PORT         (default 8788)
 *   ALLCREW_CHANNEL_AGENT_HOST         (default 127.0.0.1) — loopback on purpose. Anyone who can reach
 *                             this port and knows the secret can read every connected file.
 *   ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS  how long one call may take (default 180000)
 *   ALLCREW_CHANNEL_AGENT_FILES        where ops that return files write them
 *                             (default ~/.allcrew-channel/agent-files)
 *   ALLCREW_CHANNEL_AGENT_SKILL_FILE   comma-separated paths --install-skill writes the skill to
 *                             (default: ~/.claude/skills/allcrew-channel-listener/SKILL.md for
 *                             Claude Code, ~/.agents/skills/allcrew-channel-listener/SKILL.md for
 *                             agents that read the .agent[s] convention — Oh My Pi and friends —
 *                             plus the agent-neutral ~/.allcrew-channel/SKILL.md, which no tool discovers
 *                             on its own: point anything else at that one, or at GET /skill)
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, sourceSetFingerprint } from './source-set.mjs'
import { acceptWebSocket } from './websocket.mjs'
import { matchTab, readDesktopTabs, runRecentHistory } from './desktop-tabs.mjs'
import { FIDELITY_POLICY } from './design-policy.mjs'

/**
 * Logical source-set fingerprint. A repository run hashes bridge.mjs plus every local import;
 * the downloadable esbuild bundle receives that same value through `define`, so both forms
 * identify the same build even though their emitted bytes differ.
 */
export { fingerprint }
const BRIDGE_SOURCE_FILE = fileURLToPath(import.meta.url)
const BRIDGE_FINGERPRINT =
  typeof __ALLCREW_BRIDGE_FINGERPRINT__ === 'string'
    ? __ALLCREW_BRIDGE_FINGERPRINT__
    : sourceSetFingerprint(BRIDGE_SOURCE_FILE)

const PORT = parseInt(process.env.ALLCREW_CHANNEL_AGENT_PORT || '8788', 10)
const HOST = process.env.ALLCREW_CHANNEL_AGENT_HOST || '127.0.0.1'
const SECRET_FILE =
  process.env.ALLCREW_CHANNEL_AGENT_SECRET_FILE || path.join(os.homedir(), '.allcrew-channel', 'agent-secret')

/** env → file → mint. Minting writes 0600 under a 0700 directory: the secret is exactly as
 * private as the account running the bridge, which is the whole trust boundary here. */
function resolveSecret() {
  if (process.env.ALLCREW_CHANNEL_AGENT_SECRET) return { secret: process.env.ALLCREW_CHANNEL_AGENT_SECRET, source: 'env' }
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

/**
 * Opt-in auto-install of the paste-once skill. The plugin sends its rendered skill text with
 * every hello; with this enabled the bridge keeps a copy on disk, so "teach the agent" happens
 * zero times instead of once and never goes stale. Opt-in on purpose: this file becomes
 * standing instructions for whatever agent reads it, and silently (re)writing those is a trust
 * decision the person at the keyboard should make, not a default they discover.
 */
const SKILL_TARGETS = (() => {
  const flag = process.argv.find((arg) => arg === '--install-skill' || arg.startsWith('--install-skill='))
  const env = process.env.ALLCREW_CHANNEL_AGENT_SKILL_FILE
  if (!flag && !env) return []
  const listed = (flag && flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : env || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (listed.length > 0) return listed
  /* Three defaults, because a copy an agent does not DISCOVER is a copy nobody reads. The first
   * is where Claude Code reads user-level skills; the second is the `.agent[s]/skills` convention
   * Oh My Pi treats as native (a skill only under ~/.claude is a foreign user-level source there,
   * opt-in behind `enabledProviders`, so it stays invisible until someone edits a config). The
   * third is agent-neutral: every other CLI has its own idea of standing instructions (AGENTS.md,
   * rules files, config dirs), and chasing them all is a losing game — so the bridge maintains
   * ONE canonical copy at a stable path and any agent gets pointed at it, or at GET /skill. */
  return [
    path.join(os.homedir(), '.claude', 'skills', 'allcrew-channel-listener', 'SKILL.md'),
    path.join(os.homedir(), '.agents', 'skills', 'allcrew-channel-listener', 'SKILL.md'),
    path.join(os.homedir(), '.allcrew-channel', 'SKILL.md'),
  ]
})()

function installSkill(plugin) {
  if (SKILL_TARGETS.length === 0 || typeof plugin.skill !== 'string' || plugin.skill === '') return
  for (const target of SKILL_TARGETS) {
    try {
      let current = null
      try {
        current = fs.readFileSync(target, 'utf8')
      } catch {
        /* not installed yet */
      }
      if (current === plugin.skill) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, plugin.skill)
      console.log(
        new Date().toISOString(),
        `~ skill → ${target} (${plugin.skill.length} bytes, from "${plugin.file}")`
      )
    } catch (err) {
      console.log(new Date().toISOString(), `! skill install failed for ${target}: ${String(err?.message || err)}`)
    }
  }
}

/** Pairing is only ever offered to something on this machine. */
function isLoopback(req) {
  const address = req.socket.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** How long a parked /plugin/poll is held before answering empty. Comfortably under any
 * proxy or browser idle timeout, long enough that the poll is effectively a socket. */
const POLL_HOLD_MS = 25_000
/** A call gives up if the plugin has not answered in this long. Ops walking a whole document
 * can genuinely take a few seconds, so this is generous — but a batch of variable writes that
 * each import from a library is network-bound and blows straight through a minute, and the
 * only workaround from the agent's side is to split the batch, which costs one undo step per
 * chunk. Raise it rather than shred the batch. */
const CALL_TIMEOUT_MS = Math.max(5_000, Number(process.env.ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS) || 180_000)
/**
 * What a plain `fetch` client will wait, whatever this bridge promises.
 *
 * Node's own `fetch` (undici) drops a request whose headers have not arrived in five minutes,
 * and it does it without a word from the server. So raising `ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS` past
 * this buys nothing for the clients that ship with this repo: the call dies at 300 s with a
 * bare "fetch failed" while the bridge is still politely waiting. Measured the hard way, on a
 * token sync that could not finish either way.
 */
export const CLIENT_CEILING_MS = 300_000
/** No poll renewed within this window → treat that plugin as gone. */
const OFFLINE_AFTER_MS = 45_000

/** session id → connected plugin. One entry per open plugin window. */
const plugins = new Map()
/** Requests handed over but not yet answered: id → { resolve, timer, op, session, startedAt }. */
const pending = new Map()

/** True while a call handed to this plugin is still waiting for its answer. */
function isBusy(session) {
  for (const entry of pending.values()) if (entry.session === session) return true
  return false
}

/**
 * A silent plugin is usually a closed one — but not while it is holding work. The poll runs in
 * the UI iframe and the op runs in the sandbox, and a heavy op (loading every page of a
 * fifty-page file, say) starves the poll long enough to look dead. Reaping it then fails the
 * very call it is busy answering, so a plugin with a call in flight gets the call's own
 * deadline instead of the idle one; if the window really did close, the call times out and the
 * next sweep collects it.
 */
const isOnline = (plugin) =>
  Date.now() - plugin.lastSeen < (isBusy(plugin.session) ? CALL_TIMEOUT_MS + 5_000 : OFFLINE_AFTER_MS)
const roster = () => [...plugins.values()].filter(isOnline)

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''))
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/* ---------------------------------------------------------------- identity */

/** A short, typeable name for a file — what an agent passes as `target`. Collisions get a
 * numeric suffix so two files called "Untitled" stay separately addressable. */
function mintHandle(fileName) {
  const base =
    String(fileName || 'file')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'file'
  const taken = new Set([...plugins.values()].map((plugin) => plugin.handle))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function describe(plugin) {
  return {
    session: plugin.session,
    handle: plugin.handle,
    file: plugin.file,
    online: isOnline(plugin),
    stale: isStale(plugin),
    gates: plugin.gates,
    transport: plugin.ws && !plugin.ws.closed ? 'websocket' : 'poll',
    fileKey: plugin.fileKey || null,
    fileKeyVia: plugin.fileKeyVia || null,
    lastSeen: plugin.lastSeen ? new Date(plugin.lastSeen).toISOString() : null,
    queued: plugin.queue.length,
  }
}

/**
 * Resolves a `target` to exactly one connected plugin, or explains why it could not. Matching
 * widens in steps — session id, then handle, then a substring of either — and every step
 * demands a unique winner. Ambiguity is an error with the candidates listed, never a pick.
 */
function resolveTarget(target) {
  const online = roster()
  if (online.length === 0) {
    return {
      error:
        'no plugin connected — open the AllCrew Figma Workspace plugin in Figma and turn on Settings → Agent listener → Allow reads',
    }
  }

  if (target === undefined || target === null || target === '') {
    if (online.length === 1) return { plugin: online[0] }
    return {
      error:
        `${online.length} files are connected — name one with "target" ` +
        `(or "*" to ask all of them): ${online.map((plugin) => plugin.handle).join(', ')}`,
      candidates: online.map(describe),
    }
  }

  const needle = String(target).toLowerCase()
  const bySession = online.filter((plugin) => plugin.session === target)
  const byHandle = online.filter((plugin) => plugin.handle === needle)
  const loose = online.filter(
    (plugin) => plugin.handle.includes(needle) || String(plugin.file || '').toLowerCase().includes(needle)
  )
  const matched = bySession.length ? bySession : byHandle.length ? byHandle : loose

  if (matched.length === 1) return { plugin: matched[0] }
  if (matched.length === 0) {
    return {
      error: `no connected file matches "${target}" — connected: ${online.map((p) => p.handle).join(', ')}`,
      candidates: online.map(describe),
    }
  }
  return {
    error: `"${target}" matches ${matched.length} connected files — be more specific: ${matched
      .map((plugin) => plugin.handle)
      .join(', ')}`,
    candidates: matched.map(describe),
  }
}

/* ----------------------------------------------------------------- plumbing */

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * The failure codes this bridge raises, and whether the same call could work on a retry.
 *
 * A mirror of `src/agent/errors.ts`, which this file cannot import: it is a standalone
 * dependency-free script AND its source is inlined verbatim into `ui.html` at build time, so a
 * relative import into `src/` would break both. `src/agent/errors.test.ts` asserts the two
 * tables agree, the same way the rest of this channel keeps a hand-written table honest.
 *
 * A code answers "what do I do next"; the prose beside it answers "why", and never goes away.
 */
const RETRYABLE_CODES = new Set([
  'unauthorized',
  'gate_closed',
  'no_plugin',
  'figma_threw',
  'timeout',
  'disconnected',
  'reconnected',
  'listener_off',
  'file_write_failed',
  'internal',
])

const ERROR_CODES = [
  'bad_request',
  'unknown_op',
  'param_invalid',
  'ambiguous_target',
  'no_route',
  'broadcast_write_refused',
  'payload_too_large',
  'rest_unavailable',
  'unauthorized',
  'gate_closed',
  'no_plugin',
  'figma_threw',
  'timeout',
  'disconnected',
  'reconnected',
  'listener_off',
  'file_write_failed',
  'internal',
]

export { ERROR_CODES, RETRYABLE_CODES }

/** A refusal body. `extra` carries whatever the caller needs to act — the roster on an
 * ambiguous target, the problem list on a bad param. */
function fail(code, error, extra) {
  return { ok: false, error, code, retryable: RETRYABLE_CODES.has(code), ...(extra || {}) }
}

/**
 * A refusal the plugin raised, passed through with its own code intact.
 *
 * The sandbox knows things this bridge cannot — whether a gate is closed, whether the op exists,
 * whether Figma threw. Re-deriving that here from the message text is exactly the guessing this
 * change removes, so the code travels with the answer and is only defaulted when an older
 * plugin build sent none.
 */
function failFromPlugin(body) {
  const error = String(body.error || 'the plugin refused without saying why')
  const code = ERROR_CODES.includes(body.code) ? body.code : 'figma_threw'
  return fail(code, error)
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

/** Hands everything queued for one plugin to its live socket, falling back to a parked poll. */
function flush(plugin) {
  if (plugin.queue.length === 0) return
  if (plugin.ws && !plugin.ws.closed) {
    plugin.ws.sendJson({ type: 'requests', requests: plugin.queue.splice(0, plugin.queue.length) })
    return
  }
  if (!plugin.poller) return
  const { res, timer } = plugin.poller
  plugin.poller = null
  clearTimeout(timer)
  send(res, 200, { requests: plugin.queue.splice(0, plugin.queue.length) })
}

/** Fails every in-flight call for one plugin — used when it disappears mid-request. `code` is
 * the caller's cue: `disconnected` and `reconnected` and `listener_off` are three different
 * things that used to be three different sentences and one indistinguishable status. */
function failPending(plugin, reason, code) {
  for (const [id, entry] of pending) {
    if (entry.session !== plugin.session) continue
    clearTimeout(entry.timer)
    entry.resolve(fail(code || 'disconnected', reason))
    pending.delete(id)
  }
  plugin.queue.length = 0
}

/* ------------------------------------------------------------------- files */

const FILES_DIR = process.env.ALLCREW_CHANNEL_AGENT_FILES || path.join(os.homedir(), '.allcrew-channel', 'agent-files')
/** Directories kept before the oldest are swept. A screenshot is worth having until the next
 * few; keeping every one forever turns a debugging session into a disk leak. */
const KEEP_RUNS = 40

/** Only ever a basename, only ever these characters — the sandbox proposes a name, this
 * decides whether it may become a path. `@` is allowed because asset names carry a density in
 * it (`icon@2x.png`); it cannot form a separator or a traversal. Kept in step with
 * `isSafeFileName` in src/agent/files.ts, which is the same rule on the sandbox side. */
function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._@-]{1,128}$/.test(name) && !name.startsWith('.')
}

function sweepRuns() {
  try {
    const runs = fs
      .readdirSync(FILES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(FILES_DIR, entry.name))
      .map((dir) => ({ dir, at: fs.statSync(dir).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const stale of runs.slice(KEEP_RUNS)) fs.rmSync(stale.dir, { recursive: true, force: true })
  } catch {
    /* sweeping is housekeeping — never fail a call over it */
  }
}

/**
 * Walks a result and turns every `{ __allcrewChannelFile: … }` into the path it was written to. The
 * sandbox has no filesystem and the agent has no way into the sandbox, so this is the only
 * place bytes can become a file — and doing it here is what keeps a base64 PNG out of the
 * agent's context, which is the whole reason ops hand back files instead of payloads.
 */
function materialiseFiles(value, dir, written) {
  if (Array.isArray(value)) return value.map((entry) => materialiseFiles(entry, dir, written))
  if (typeof value !== 'object' || value === null) return value

  const envelope = value.__allcrewChannelFile
  if (envelope && typeof envelope === 'object' && typeof envelope.data === 'string') {
    if (!safeName(envelope.name)) return { error: `refused unsafe file name ${JSON.stringify(envelope.name)}` }
    if (written.length === 0) fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, envelope.name)
    const bytes =
      envelope.encoding === 'base64' ? Buffer.from(envelope.data, 'base64') : Buffer.from(envelope.data, 'utf8')
    fs.writeFileSync(target, bytes)
    written.push(target)
    return { path: target, bytes: bytes.length, mime: envelope.mime || 'application/octet-stream' }
  }

  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = materialiseFiles(entry, dir, written)
  return out
}

/**
 * Queues one op for one plugin and resolves when it answers. Everything above this — single
 * call, broadcast — is just a different way of choosing which plugins to hand it to.
 */
function dispatch(plugin, op, params) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      // Name the knob: a caller that asked for a longer `timeoutMs` (plugin.call allows up to
      // 600s) otherwise reads this as the plugin hanging, when it is this bridge giving up first.
      resolve(
        fail(
          'timeout',
          `no answer from "${plugin.handle}" within ${CALL_TIMEOUT_MS / 1000}s (the bridge ceiling). ` +
            'If the file is big and the page was cold, this is Figma loading it: while that runs, the ' +
            'plugin\'s own budgets cannot fire either, because nothing in the sandbox gets a turn. The ' +
            'load continues after this call dies, so the same call often answers at once on a retry' +
            (CALL_TIMEOUT_MS >= CLIENT_CEILING_MS
              ? ' — raising it further will not help: a plain fetch client gives up at ' +
                `${CLIENT_CEILING_MS / 1000}s. Narrow the scope, or use the op's own paging (limit/offset/budgetMs).`
              : ' — raise it with ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS, or narrow the scope')
        )
      )
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, timer, op, session: plugin.session, startedAt: Date.now() })
    plugin.queue.push({ id, op, params: params ?? {} })
    flush(plugin)
  })
}

/** A plugin built against a different bridge is the likeliest cause of "it behaves oddly and
 * the code looks right" — say it once per connection, on both sides. */
function isStale(plugin) {
  return Boolean(plugin.expects && BRIDGE_FINGERPRINT && plugin.expects !== BRIDGE_FINGERPRINT)
}

function warnIfStale(plugin) {
  if (!isStale(plugin)) return
  console.log(
    new Date().toISOString(),
    `! "${plugin.file}" (${plugin.handle}) expects bridge ${plugin.expects}, this one is ${BRIDGE_FINGERPRINT} —`,
    `restart it from the plugin's own copy, or from agent/bridge.mjs in a checkout`
  )
}

/** What one plugin's manifest says about an op — used to refuse a broadcast that would write. */
function opIsMutating(plugin, op) {
  const entry = (plugin.ops || []).find((candidate) => candidate.name === op)
  return entry ? entry.mutates === true : false
}

function opEntry(plugin, op) {
  return (plugin.ops || []).find((candidate) => candidate.name === op) || null
}

/* ------------------------------------------------------------- param checks */

/**
 * The plugin publishes a schema for every op it exposes, so this process can refuse a
 * malformed call rather than relay it. That is worth more than it sounds. An op ignores a key
 * it does not recognise and still answers `ok: true`, so a misspelled parameter reads as a
 * *successful* no-op — the one failure an agent cannot see in the response, and the one it
 * will therefore report as done. `node.bind` with `token` instead of `variable` answered
 * `bound: 150, failed: 0` and wrote nothing. Refusing here turns that into an error at the
 * only boundary that holds both the schema and the call.
 *
 * Silence is the compatibility rule throughout: a plugin that publishes no schema for an op is
 * relayed exactly as before, because a bridge that rejected what it merely fails to understand
 * would be worse than one that never checked.
 */
function typeOk(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    /* `json` is the schema's way of saying "structured, shape documented in prose" — an array
     * of bindings, a batch of updates. Anything but undefined passes; the row check below is
     * what actually looks inside. */
    case 'json': return value !== undefined
    default: return true
  }
}

/**
 * Array-item shapes the op descriptions state in prose but the schema cannot yet express.
 * Kept deliberately small and named per op: this is the layer where the damage happened, and
 * a table of four keys is cheaper than relaying a call that will lie about its outcome. It
 * comes out the moment the plugin publishes an item schema of its own.
 */
const ROW_SHAPES = {
  'node.bind': { list: 'bindings', keys: ['node', 'field', 'variable', 'paintIndex'], required: ['node', 'field'] },
}

function checkParams(entry, params) {
  const spec = entry && entry.params
  if (!spec || typeof spec !== 'object' || Object.keys(spec).length === 0) return []
  const given = params && typeof params === 'object' ? params : {}
  const problems = []
  const accepted = Object.keys(spec)

  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(spec, key)) {
      problems.push(`unknown parameter "${key}" — "${entry.name}" accepts: ${accepted.join(', ')}`)
    }
  }

  for (const [key, rule] of Object.entries(spec)) {
    const value = given[key]
    if (value === undefined || value === null) {
      if (rule.required) problems.push(`missing required parameter "${key}"`)
      continue
    }
    if (rule.type && !typeOk(rule.type, value)) {
      problems.push(`"${key}" must be ${rule.type}, got ${Array.isArray(value) ? 'array' : typeof value}`)
      continue
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      problems.push(`"${key}" must be one of: ${rule.enum.join(', ')}`)
    }
    if (typeof value === 'number') {
      if (typeof rule.min === 'number' && value < rule.min) problems.push(`"${key}" must be >= ${rule.min}`)
      if (typeof rule.max === 'number' && value > rule.max) problems.push(`"${key}" must be <= ${rule.max}`)
    }
  }

  const shape = ROW_SHAPES[entry.name]
  if (shape) {
    const rows = given[shape.list]
    if (rows !== undefined && !Array.isArray(rows)) {
      problems.push(`"${shape.list}" must be an array`)
    } else if (Array.isArray(rows)) {
      /* Report the first few and say how many more. A batch of ninety-nine rows with the same
       * typo should read as one mistake, not ninety-nine. */
      const rowProblems = []
      rows.forEach((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          rowProblems.push(`${shape.list}[${index}] must be an object`)
          return
        }
        for (const key of Object.keys(row)) {
          if (!shape.keys.includes(key)) {
            rowProblems.push(`${shape.list}[${index}]: unknown key "${key}" — accepted: ${shape.keys.join(', ')}`)
          }
        }
        for (const key of shape.required || []) {
          if (row[key] === undefined) rowProblems.push(`${shape.list}[${index}]: missing "${key}"`)
        }
      })
      problems.push(...rowProblems.slice(0, 5))
      if (rowProblems.length > 5) problems.push(`… and ${rowProblems.length - 5} more like it`)
    }
  }

  return problems
}

/* -------------------------------------------------------------------- REST */
/*
 * What to answer when no plugin is open.
 *
 * The channel exists because a Figma plugin cannot be reached from outside — and the price is
 * that it only exists while a person has the plugin open. That is fine for a designer working
 * alongside an agent and useless for an agent that wakes up at three in the morning. Figma's
 * REST API answers a slice of the same questions without anyone present, so the bridge falls
 * back to it and SAYS SO in every answer: `source: "rest"`.
 *
 * The slice is genuinely smaller, and pretending otherwise would be the worst thing this could
 * do. REST returns rendered values, never the variable behind them; it has no Motion, no
 * variant state deltas, no prototype transition detail, no plugin commands, and no writes.
 * An op that needs any of those is refused by name, with the sentence that says what to open.
 */

const FIGMA_TOKEN_FILE = process.env.FIGMA_TOKEN_FILE || path.join(os.homedir(), '.allcrew-channel', 'figma-token')
const DEFAULT_FILE_KEY = process.env.ALLCREW_CHANNEL_FIGMA_FILE_KEY || ''

/** Personal access token: the environment first, then the file, whose comment lines are
 * skipped — the same file the Code Connect CLI reads, so a machine set up for one is set up
 * for both. */
function figmaToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim()
  try {
    const line = fs
      .readFileSync(FIGMA_TOKEN_FILE, 'utf8')
      .split('\n')
      .map((row) => row.trim())
      .find((row) => row && !row.startsWith('#') && !row.startsWith('PASTE'))
    return line || ''
  } catch {
    return ''
  }
}

/**
 * Where the REST API lives. Overridable because Figma for Government is a different host
 * (`api.figma-gov.com`) — the docs say so outright — and because a hard-coded hostname is a
 * transport nothing can exercise end to end.
 */
const FIGMA_API = (process.env.ALLCREW_CHANNEL_FIGMA_API || 'https://api.figma.com').replace(/\/+$/, '')

/** A file key out of whatever the caller typed: the key itself, a Figma URL, or `rest:<key>`. */
export function fileKeyOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const prefixed = text.startsWith('rest:') ? text.slice(5) : text
  const url = prefixed.match(/figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/)
  if (url) return url[1]
  return /^[A-Za-z0-9]{10,}$/.test(prefixed) ? prefixed : ''
}

export function requestedFileKey(body) {
  return fileKeyOf(body?.fileKey) || fileKeyOf(body?.params?.fileKey)
}

async function desktopKeyFor(file, pages) {
  const tabs = readDesktopTabs()
  const matched = await matchTab({ title: file, pages }, tabs.open, async (key) => {
    const answer = await restFetch(`/v1/files/${encodeURIComponent(key)}?depth=1`)
    return answer?.document?.children || []
  })
  return {
    key: matched.key,
    via: matched.via,
    candidates: matched.candidates?.map((entry) => ({ key: entry.key, title: entry.title, path: entry.path })) || [],
  }
}

/** True when this call is addressed at REST rather than at an open plugin. */
export function wantsRest(body, anyPluginOnline) {
  if (body && requestedFileKey(body)) return true
  if (typeof body?.target === 'string' && body.target.startsWith('rest:')) return true
  return !anyPluginOnline && Boolean(DEFAULT_FILE_KEY)
}

/** Ops REST can answer, and — for everything else — the reason it cannot. Written out rather
 * than derived: an agent deserves to read why, not to discover a 400. */
export const REST_OPS = [
  'document.info',
  'page.frames',
  'node.get',
  'node.find',
  'components.list',
  'styles.list',
  'node.screenshot',
  // Three the file payload answers outright, and which used to be refused for no better reason
  // than nobody having read it: REST carries `interactions` on a node in the SAME shape the
  // plugin reports reactions, `characterStyleOverrides`/`styleOverrideTable` on a TEXT node, and
  // an imageRef→URL map for every image fill in the file.
  'flow.map',
  'image.fills',
  'text.segments',
  // A fourth: half-answerable rather than answerable outright. `componentPropertyDefinitions`
  // and a member's NAME give the signature — axes, options, defaults, non-variant properties —
  // but not `changes` (needs getCSSAsync) or `targets` (needs componentPropertyReferences,
  // absent from every REST node payload this bridge has read). See restComponentSignature for
  // exactly what the note tells the caller is missing.
  'component.api',
]

export const REST_REFUSALS = {
  'variables.get': 'reading variable VALUES over REST is an Enterprise feature; the plugin reads them on any plan',
  'design.ir': 'the tree is built by the plugin from the live document',
  'design.context': 'needs the plugin: the value-to-token mapping is what makes it worth having',
  'design.measure': 'needs the plugin: Figma computes the CSS, REST only stores the properties',
  'assets.export': 'asset discovery comes from the IR — over REST, export one node with node.screenshot',
  'motion.context': 'the Motion API exists only inside a plugin',
  'motion.preview': 'the Motion API exists only inside a plugin',
  'transition.context': 'variant state diffing happens in the plugin',
  'node.states': 'variant state diffing happens in the plugin',
  'frames.compare': 'layer matching happens in the plugin',
  'guide.list': 'playbooks ship with the plugin build',
  'guide.get': 'playbooks ship with the plugin build',
  'plugin.commands': 'the panel’s command surface exists only while the panel is open',
  'plugin.call': 'the panel’s command surface exists only while the panel is open',
}

/* ---------------------------------------------------------------- comments */

/**
 * Comments, which the plugin cannot see at all.
 *
 * `grep -i comment` over `@figma/plugin-typings` returns nothing: the Plugin API has no comment
 * surface whatsoever. They exist only over REST, and only these six endpoints — GET/POST/DELETE
 * for a comment and the same three for its reactions. So comment ops are answered HERE, by the
 * bridge, whether or not a plugin is open. They are the only ops in the channel that work that
 * way, and the only ones that need a Figma token.
 *
 * What the REST API does NOT have, and this file therefore refuses by name rather than by 404:
 * there is no endpoint to resolve, unresolve or archive a comment. `resolved_at` is readable and
 * read-only — it is in the `Comment` schema with the description "if set, the UTC ISO 8601 time
 * the comment was resolved" and there is no request anywhere in Figma's OpenAPI spec that sets
 * it. Checking the tick in the Figma UI is not an API operation. An agent asked to "mark this
 * done" has to be told that, because the alternative is it posting a reply that says "done" and
 * reporting the thread as closed when the designer's inbox still shows it open.
 */
export const COMMENT_OPS = ['comments.list', 'comments.post', 'comments.reply', 'comments.remove', 'comments.react']

/** The comment things Figma's REST API cannot do, and what to do instead. Written out for the
 * same reason `REST_REFUSALS` is: an agent deserves to read why, not to discover a 404. */
export const COMMENT_REFUSALS = {
  'comments.resolve':
    'Figma has no resolve endpoint — `resolved_at` is readable and read-only, and nothing in the REST API sets it. ' +
    'Only a person can tick a thread done, in the Figma UI. Reply to the thread saying what changed and leave it ' +
    'open; reporting it closed would be a claim the designer\'s inbox contradicts.',
  'comments.unresolve': 'Figma has no unresolve endpoint either — see comments.resolve.',
  'comments.archive':
    'There is no archive in Figma\'s comment model: a thread is open or resolved, and neither transition is in the ' +
    'API. `comments.remove` deletes, permanently and only your own.',
  'comments.edit':
    'A posted comment cannot be edited over REST — there is no PUT or PATCH. Delete your own and post again, or ' +
    'reply with the correction so the thread keeps its history.',
  'comments.mention':
    'Mentions are not a REST feature: the message is plain text, and an `@name` in it stays text and notifies ' +
    'nobody. Name the person in words instead of pretending to tag them.',
}

/** One comment as this channel reports it — Figma's shape, with the pin made legible. */
function commentRow(comment) {
  const meta = comment.client_meta || null
  /* Figma returns four different positioning shapes under one key and never says which. Naming
   * the kind is the difference between a consumer that can read a pin and one that has to sniff
   * for the presence of `node_id`. */
  const pin = !meta
    ? null
    : {
        kind:
          typeof meta.node_id === 'string'
            ? meta.region_width !== undefined
              ? 'frame-region'
              : 'frame-offset'
            : meta.region_width !== undefined
              ? 'region'
              : 'point',
        ...(typeof meta.node_id === 'string' ? { nodeId: meta.node_id } : {}),
        ...(meta.node_offset ? { offset: meta.node_offset } : {}),
        ...(typeof meta.x === 'number' ? { at: { x: meta.x, y: meta.y } } : {}),
        ...(meta.region_width !== undefined
          ? { region: { width: meta.region_width, height: meta.region_height, pinCorner: meta.comment_pin_corner } }
          : {}),
      }
  return {
    id: comment.id,
    /* The number the Figma UI shows beside the thread. It is what a designer says out loud
     * ("look at 12"), and an agent that only knows the opaque id cannot answer them. */
    ...(comment.order_id ? { number: comment.order_id } : {}),
    author: comment.user?.handle || null,
    at: comment.created_at,
    /* Read-only, and the ONLY thing the API says about doneness. Nothing can set it. */
    resolved: Boolean(comment.resolved_at),
    ...(comment.resolved_at ? { resolvedAt: comment.resolved_at } : {}),
    message: comment.message,
    ...(pin ? { pin } : {}),
    ...(Array.isArray(comment.reactions) && comment.reactions.length > 0
      ? { reactions: comment.reactions.map((r) => ({ emoji: r.emoji, by: r.user?.handle || null })) }
      : {}),
  }
}

/** Replies carry `parent_id`; grouping here means an agent reads threads rather than a stream of
 * fragments it has to reassemble before it can answer anything. */
export function commentThreads(all, { nodeId, resolved } = {}) {
  const comments = Array.isArray(all) ? all : []
  const replies = new Map()
  for (const comment of comments) {
    if (!comment?.parent_id) continue
    replies.set(comment.parent_id, [...(replies.get(comment.parent_id) || []), comment])
  }
  let threads = comments
    .filter((comment) => comment && !comment.parent_id)
    .map((comment) => {
      const row = commentRow(comment)
      const children = (replies.get(comment.id) || []).sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at))
      )
      return { ...row, replies: children.map(commentRow) }
    })
  // Filters after grouping, never before: a thread whose ROOT is pinned to the node is about
  // that node even when a reply carries no pin of its own.
  if (typeof nodeId === 'string' && nodeId) threads = threads.filter((t) => t.pin?.nodeId === nodeId)
  if (resolved === true) threads = threads.filter((t) => t.resolved)
  if (resolved === false) threads = threads.filter((t) => !t.resolved)
  return threads.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** Kept in step with `ANCHOR_POINTS` in src/agent/anchor.ts; a test asserts they agree. */
export const ANCHOR_POINT_NAMES = [
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]

/**
 * The manifest for the comment ops, in the same shape a plugin publishes so the CLI, the MCP
 * front and `checkParams` all treat them like any other op. Declared here rather than in the
 * plugin because the plugin cannot run them.
 */
export const COMMENT_MANIFEST = [
  {
    name: 'comments.list',
    summary: 'Comment threads on the file — pins resolved to node and offset, replies grouped, reactions included.',
    mutates: false,
    agent:
      'Comments are the designer\'s side of the conversation and the plugin cannot see them at all — this is REST, so ' +
      'it needs a Figma token and a fileKey. Threads come back newest first with replies nested, each carrying the ' +
      '`number` the Figma UI shows (what a designer says out loud) and `resolved`. `nodeId` filters to the threads ' +
      'pinned to one layer, which is how you ask "what is outstanding on this screen". `resolved: false` is the ' +
      'open-work view. NOTE: `resolved` is read-only everywhere in Figma\'s API — see comments.resolve.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL. Required: the plugin cannot tell you its own key on an Organization-private plugin.' },
      nodeId: { type: 'string', description: 'Only threads pinned to this node.' },
      resolved: { type: 'boolean', description: 'true for done threads, false for open ones, omit for both.' },
      as: { type: 'string', enum: ['text', 'markdown'], default: 'text', description: 'Ask Figma for the markdown form of each message where it has one.' },
    },
  },
  {
    name: 'comments.post',
    summary: 'Leave a comment on the file, pinned to a node, a point or a region.',
    mutates: true,
    agent:
      'How an agent annotates a design instead of reporting into a void. AIMING is the point: pass `nodeId` and the ' +
      'pin is placed on that layer via node.anchor — addressed to the enclosing FRAME with an offset inside it, which ' +
      'is what makes the comment move with the screen when the designer drags it. `anchor` picks the point ' +
      '(`center` by default, or a corner/edge). `width`+`height` make it a region pin instead of a dot, for "this ' +
      'whole block is wrong". Without a nodeId, `x`+`y` place it on the canvas absolutely — use that only for a note ' +
      'about nothing in particular, because an absolute pin does not follow anything. The message is PLAIN TEXT: an ' +
      '`@name` in it stays text and notifies nobody.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      message: { type: 'string', required: true, description: 'What the comment says. Plain text.' },
      nodeId: { type: 'string', description: 'Pin it to this layer — the aimed case, and the one you almost always want.' },
      anchor: { type: 'string', enum: [...ANCHOR_POINT_NAMES], default: 'center', description: 'Which point of the node the pin sits on.' },
      x: { type: 'number', description: 'Absolute canvas x, when there is no node to pin to.' },
      y: { type: 'number', description: 'Absolute canvas y, when there is no node to pin to.' },
      width: { type: 'number', description: 'Region width — makes the pin cover an area rather than a point.' },
      height: { type: 'number', description: 'Region height.' },
      pinCorner: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'Which corner of the region the pin hangs off. Figma defaults to bottom-right.' },
    },
  },
  {
    name: 'comments.reply',
    summary: 'Reply to an existing comment thread.',
    mutates: true,
    agent:
      'Replies keep the conversation where the designer will read it. `commentId` must be a ROOT comment — Figma ' +
      'refuses a reply to a reply, so pass the thread id from comments.list, not a nested one. A reply inherits the ' +
      'thread\'s pin and takes none of its own. This is also the honest answer to "mark it done": say what changed ' +
      'and leave the thread for a person to tick, because no API can tick it.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      commentId: { type: 'string', required: true, description: 'The root comment to reply to.' },
      message: { type: 'string', required: true, description: 'The reply. Plain text.' },
    },
  },
  {
    name: 'comments.remove',
    summary: 'Delete a comment — permanently, and only one of your own.',
    mutates: true,
    agent:
      'Figma allows deleting only comments the token\'s own user posted, and there is no undo: this is not "archive", ' +
      'it is gone. Deleting a ROOT comment takes its replies with it. Use it to clean up notes this agent left, not ' +
      'to close a designer\'s thread.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      commentId: { type: 'string', required: true, description: 'The comment to delete.' },
    },
  },
  {
    name: 'comments.react',
    summary: 'Add or remove an emoji reaction on a comment.',
    mutates: true,
    agent:
      'The lightest possible acknowledgement, and the closest the API comes to a "seen" or "done" mark — it is NOT ' +
      'resolution and the thread stays open, but a 👍 on a thread you have acted on is a real signal a designer reads ' +
      'at a glance. `emoji` is a shortcode (`:+1:`, `:heart:`, `:eyes:`), not a literal character. `remove: true` ' +
      'takes back one you left.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      commentId: { type: 'string', required: true, description: 'The comment to react to.' },
      emoji: { type: 'string', required: true, description: 'Emoji shortcode, e.g. :+1: or :eyes:.' },
      remove: { type: 'boolean', default: false, description: 'Remove this reaction instead of adding it.' },
    },
  },
]

/**
 * `client_meta` for a comment write.
 *
 * Four shapes, and which one is right is decided by what the caller gave rather than by a
 * `kind` they have to know: a node means frame-relative, a size means a region, and only the
 * absence of a node falls back to absolute canvas coordinates. `anchor` is resolved by the
 * PLUGIN (node.anchor) because the offset needs `absoluteBoundingBox` of the layer and of its
 * enclosing frame, and REST would need a whole file payload to find either.
 */
export function commentPin({ anchor, x, y, width, height, pinCorner }) {
  const region =
    typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
      ? { region_width: width, region_height: height, ...(pinCorner ? { comment_pin_corner: pinCorner } : {}) }
      : null

  if (anchor && anchor.frame && anchor.offset) {
    // The aimed case: moves with the frame.
    return { node_id: anchor.frame, node_offset: anchor.offset, ...(region || {}) }
  }
  const at = anchor && anchor.offset ? anchor.offset : { x, y }
  if (typeof at.x !== 'number' || typeof at.y !== 'number') return null
  return { x: at.x, y: at.y, ...(region || {}) }
}

/**
 * Runs one comment op.
 *
 * `aim` is a callback the caller supplies to resolve a `nodeId` into a frame and an offset by
 * asking the plugin. Injected rather than reached for directly so this function stays testable
 * and so the gate decision lives in one place, above it.
 */
export async function runCommentOp(op, params, { fileKey, aim }) {
  const key = fileKeyOf(params.fileKey) || fileKeyOf(fileKey) || DEFAULT_FILE_KEY
  if (!key) {
    throw new Error(
      'no file key — pass fileKey (a key or a Figma URL), or set ALLCREW_CHANNEL_FIGMA_FILE_KEY. The plugin cannot supply ' +
        'it: figma.fileKey is null for an Organization-private plugin, which is why this is not optional.'
    )
  }
  const base = `/v1/files/${encodeURIComponent(key)}/comments`

  if (op === 'comments.list') {
    const query = params.as === 'markdown' ? '?as_md=true' : ''
    const answer = await restFetch(`${base}${query}`)
    const all = (answer && answer.comments) || []
    const threads = commentThreads(all, { nodeId: params.nodeId, resolved: params.resolved })
    return {
      fileKey: key,
      threads: threads.length,
      comments: all.length,
      open: threads.filter((t) => !t.resolved).length,
      /* Said on every read, because it is the question an agent asks next and the answer is
       * counter-intuitive enough that it will otherwise try. */
      note: 'resolved is read-only: Figma has no endpoint that closes a thread. See comments.resolve.',
      items: threads,
    }
  }

  if (op === 'comments.post') {
    const message = String(params.message || '')
    if (!message.trim()) throw new Error('message is empty — a blank comment is a pin nobody can read')
    let anchor = null
    if (typeof params.nodeId === 'string' && params.nodeId) {
      anchor = await aim(params.nodeId, params.anchor)
    }
    const pin = commentPin({
      anchor,
      x: params.x,
      y: params.y,
      width: params.width,
      height: params.height,
      pinCorner: params.pinCorner,
    })
    if (!pin) {
      throw new Error(
        'nothing to pin to — pass a nodeId (aimed at a layer, and it follows the frame) or x and y (absolute canvas)'
      )
    }
    const posted = await restFetch(base, { method: 'POST', body: { message, client_meta: pin } })
    return {
      fileKey: key,
      posted: commentRow(posted || {}),
      pin,
      ...(anchor ? { aimedAt: anchor } : {}),
    }
  }

  if (op === 'comments.reply') {
    const message = String(params.message || '')
    if (!message.trim()) throw new Error('message is empty')
    const posted = await restFetch(base, {
      method: 'POST',
      body: { message, comment_id: String(params.commentId) },
    })
    return { fileKey: key, posted: commentRow(posted || {}), replyTo: String(params.commentId) }
  }

  if (op === 'comments.remove') {
    await restFetch(`${base}/${encodeURIComponent(String(params.commentId))}`, { method: 'DELETE' })
    // Figma answers a delete with an empty body, so the confirmation is this op's own and says
    // plainly that it is not recoverable.
    return { fileKey: key, deleted: String(params.commentId), permanent: true }
  }

  if (op === 'comments.react') {
    const route = `${base}/${encodeURIComponent(String(params.commentId))}/reactions`
    const emoji = String(params.emoji || '')
    if (!emoji) throw new Error('emoji is required — a shortcode like :+1: or :eyes:')
    if (params.remove === true) {
      await restFetch(`${route}?emoji=${encodeURIComponent(emoji)}`, { method: 'DELETE' })
      return { fileKey: key, commentId: String(params.commentId), emoji, removed: true }
    }
    await restFetch(route, { method: 'POST', body: { emoji } })
    return {
      fileKey: key,
      commentId: String(params.commentId),
      emoji,
      added: true,
      note: 'a reaction is not resolution — the thread stays open, and only a person can tick it done',
    }
  }

  throw new Error(`"${op}" is not a comment op`)
}

/* ----------------------------------------------------------------- history */

/**
 * "Who changed what, and when."
 *
 * Figma answers the first and third directly and the second not at all. Version history is a
 * list of SNAPSHOTS — id, timestamp, author, and an optional label — and nothing in it says what
 * moved. Measured on a real file: 50 checkpoints over 12 days, of which **one** carried a label,
 * and 16 were authored by "Figma" itself, which is autosave rather than a person. So the list
 * tells you who touched the file and when, and almost never what they meant.
 *
 * The "what" has to be computed, and the mechanism is `GET /v1/files/:key?version=X`, which
 * renders the file as it stood at a version. Two of those, diffed, is the answer — and `ids` and
 * `depth` bound the cost, which is not incidental: a 200 KB subtree took 8–10 SECONDS per fetch
 * against the live API, so an unscoped walk of a version list is minutes of wall clock inside a
 * 180-second ceiling. Every op here reports how many fetches it spent.
 *
 * Attribution has exactly one honest shape: a diff between CONSECUTIVE checkpoints belongs to
 * the author of the later one. Diffing two distant versions says what changed across a span and
 * cannot name a person for any of it, and the answer says so rather than crediting the author of
 * the endpoint.
 */
export const HISTORY_OPS = ['history.recent', 'history.versions', 'history.diff', 'history.blame']

export const HISTORY_REFUSALS = {
  'history.activity':
    'Activity logs need a PLAN access token with `org:activity_log_read`, sent as an OAuth Bearer header — a ' +
    'personal access token answers 401 no matter its scopes, and the endpoint is organisation-level rather than ' +
    'per-file. If you have one, call it directly; this channel deliberately does not hold an org-wide credential. ' +
    'For per-file "who and when", history.versions is the answer that works on any plan.',
  'history.developerLogs':
    'Developer logs need a plan access token with `org:developer_log_read`, and they record REST/MCP API REQUESTS ' +
    'rather than design edits — they answer "which token read this file", not "who changed this layer".',
  'history.restore':
    'There is no endpoint that restores a version. Reverting is a person in the Figma UI. What an agent can do is ' +
    'read the old version with history.diff and write the values back with the ordinary write ops, which is a ' +
    'different thing and leaves its own checkpoint.',
}

/** One checkpoint, with the distinction that actually matters. */
function versionRow(version) {
  const author = version.user?.handle || null
  return {
    id: version.id,
    at: version.created_at,
    author,
    /* Figma autosaves constantly under its own name. An autosave is a point in time, not a
     * decision, and counting them as history is how "50 versions" comes to mean nothing. */
    autosave: author === 'Figma',
    /* Only a named version is somebody's deliberate marker — the one place intent is recorded. */
    named: Boolean(version.label),
    ...(version.label ? { label: version.label } : {}),
    ...(version.description ? { description: version.description } : {}),
  }
}

export function versionList(versions) {
  const rows = (Array.isArray(versions) ? versions : []).map(versionRow)
  const byAuthor = new Map()
  for (const row of rows) byAuthor.set(row.author, (byAuthor.get(row.author) || 0) + 1)
  return {
    checkpoints: rows.length,
    named: rows.filter((r) => r.named).length,
    autosaves: rows.filter((r) => r.autosave).length,
    authors: [...byAuthor.entries()]
      .map(([author, checkpoints]) => ({ author, checkpoints }))
      .sort((a, b) => b.checkpoints - a.checkpoints),
    items: rows,
  }
}

/* ------------------------------------------------------------- the diff */

/** Every node of a rendered file payload, by id. */
function flattenDocument(document) {
  const byId = new Map()
  if (!document) return byId
  ;(function walk(node) {
    if (!node || typeof node.id !== 'string') return
    byId.set(node.id, node)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  })(document)
  return byId
}

/** A node's own identity, children excluded — so a change is the node's and not a descendant's
 * bubbling up. Without this every ancestor of one edited layer reads as edited too. */
function ownShape(node) {
  const { children, ...rest } = node
  return JSON.stringify(rest)
}

/**
 * What moved between two rendered versions of the same subtree.
 *
 * `properties` is the part worth reading: a list of forty changed layers is noise, and "37 fills,
 * 25 backgrounds, 5 overrides" is a sentence. Measured on a real 12-day span, that histogram
 * said "somebody went through and re-did the imagery", which no count of layers would have.
 */
export function diffDocuments(before, after, { limit = 20 } = {}) {
  const a = flattenDocument(before)
  const b = flattenDocument(after)

  const added = [...b.keys()].filter((id) => !a.has(id))
  const removed = [...a.keys()].filter((id) => !b.has(id))
  const changed = [...b.keys()].filter((id) => a.has(id) && ownShape(a.get(id)) !== ownShape(b.get(id)))

  const properties = new Map()
  const details = []
  for (const id of changed) {
    const x = a.get(id)
    const y = b.get(id)
    const moved = []
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (key === 'children') continue
      const left = JSON.stringify(x[key])
      const right = JSON.stringify(y[key])
      if (left === right) continue
      properties.set(key, (properties.get(key) || 0) + 1)
      moved.push({ property: key, from: clip(left), to: clip(right) })
    }
    if (details.length < limit && moved.length > 0) {
      details.push({ id, name: y.name, type: y.type, moved })
    }
  }

  const describe = (map, id) => ({ id, name: map.get(id)?.name, type: map.get(id)?.type })
  return {
    nodes: { before: a.size, after: b.size },
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    added: added.slice(0, limit).map((id) => describe(b, id)),
    removed: removed.slice(0, limit).map((id) => describe(a, id)),
    properties: [...properties.entries()]
      .map(([property, layers]) => ({ property, layers }))
      .sort((p, q) => q.layers - p.layers || p.property.localeCompare(q.property)),
    changed: details,
    ...(changed.length > details.length ? { changedOmitted: changed.length - details.length } : {}),
  }
}

/** A value short enough to read in a report. The full thing is in the file, not in a diff. */
function clip(value) {
  const text = value === undefined ? 'undefined' : String(value)
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

export const HISTORY_MANIFEST = [
  {
    name: 'history.recent',
    summary: 'Version activity since a time across Figma Desktop files on this machine.',
    mutates: false,
    agent:
      'Reads open and recently closed file keys from Figma Desktop settings, then lists versions four files at a time. ' +
      'Default `since` is local midnight. Checkpoints are periodic, not every edit, and plugin writes are attributed to the signed-in user.',
    params: {
      since: { type: 'string', description: 'ISO date or date-time. Omitted means local midnight.' },
      limit: { type: 'number', default: 50, min: 1, max: 50, description: 'Recent checkpoints fetched per file.' },
      budgetMs: { type: 'number', default: 120000, min: 1000, max: 170000, description: 'Stop starting file reads after this budget.' },
    },
  },
  {
    name: 'history.versions',
    summary: 'Version checkpoints of a file — who, when, and whether anybody named it.',
    mutates: false,
    agent:
      'The "who and when" half, and it works on any plan (unlike activity logs, which need an organisation token). ' +
      'Read this before asking anything else about history: it gives you the version ids the other two ops take. ' +
      'Two fields decide how much the list is worth: `autosave` is true when Figma saved it rather than a person, ' +
      'and `named` is true when somebody typed a label — that is the only place INTENT is recorded, and on a real ' +
      'file it was 1 of 50. `authors` counts checkpoints per person, which is the cheapest honest answer to "who ' +
      'has been working in here". It does NOT say what changed; history.diff does.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      limit: { type: 'number', default: 30, min: 1, max: 50, description: 'Checkpoints to return, newest first. Figma caps a page at 50.' },
      before: { type: 'string', description: 'A version id — page further back than it.' },
      named: { type: 'boolean', default: false, description: 'Only the checkpoints somebody labelled, which is the history a human meant to leave.' },
    },
  },
  {
    name: 'history.diff',
    summary: 'What moved between two versions of a node — added, removed, changed, and which properties.',
    mutates: false,
    agent:
      'The "what" half. Renders the file at two versions and compares them. ALWAYS pass `nodeId`: an unscoped diff ' +
      'fetches the whole document twice, and one 200 KB subtree already costs 8–10 seconds per fetch — the answer ' +
      'reports `fetches` and `ms` so the cost is never a surprise. Read `properties` first: "37 fills, 25 ' +
      'backgrounds, 5 overrides" is a sentence about what somebody did, where a list of 40 changed layers is noise. ' +
      '`changed[].moved` has the before/after per property. ATTRIBUTION: only a diff between CONSECUTIVE ' +
      'checkpoints belongs to one person — pass `attribute: true` and it refuses unless `from` and `to` are ' +
      'adjacent, rather than crediting the author of the endpoint for a span of somebody else\'s work.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      nodeId: { type: 'string', description: 'Scope the comparison to this node. Strongly recommended — without it both fetches are the whole file.' },
      from: { type: 'string', required: true, description: 'The older version id.' },
      to: { type: 'string', description: 'The newer version id. Omitted means the file as it stands now.' },
      depth: { type: 'number', default: 6, min: 1, max: 12, description: 'How deep to render, counted from the DOCUMENT ROOT rather than from `nodeId` — a page is 1, a frame on it 2, so a deep layer needs 5 or 6. Too shallow and the node is pruned out of both renders; the op refuses rather than reporting no changes.' },
      limit: { type: 'number', default: 20, min: 1, max: 200, description: 'How many changed layers to detail; the counts and the property histogram always cover everything.' },
      attribute: { type: 'boolean', default: false, description: 'Refuse unless the two versions are adjacent, so the answer can name one author honestly.' },
    },
  },
  {
    name: 'history.blame',
    summary: 'Which checkpoint changed this node, and who made it — found by bisecting the version list.',
    mutates: false,
    agent:
      'The op that actually answers "who did this, and when". Figma has no blame primitive: nothing anywhere ' +
      'attributes a property to a person. So this bisects — render the node at the oldest and newest checkpoint in ' +
      'the window, and if they differ, halve the range until the single checkpoint that changed it is isolated. ' +
      'That is log2(N) steps instead of N: a 32-checkpoint window costs about 6 fetch pairs rather than 32. ' +
      'The answer names the checkpoint, its author, its label if it has one, and the diff at exactly that step — ' +
      'which IS attributable, because consecutive checkpoints have one author. `property` narrows the search to ' +
      'one field, so "who changed the fill" does not stop on somebody moving the layer. `window` bounds how far ' +
      'back to look; `budgetMs` stops the search and says where it got to rather than dying on the bridge ceiling.',
    params: {
      fileKey: { type: 'string', description: 'File key or Figma URL.' },
      nodeId: { type: 'string', required: true, description: 'The node whose change you are tracing.' },
      property: { type: 'string', description: 'Only consider this property (e.g. `fills`, `name`, `absoluteBoundingBox`). Without it, any difference counts.' },
      window: { type: 'number', default: 20, min: 2, max: 50, description: 'How many recent checkpoints to search within.' },
      depth: { type: 'number', default: 6, min: 1, max: 12, description: 'Render depth, counted from the DOCUMENT ROOT rather than from your node — a page is 1, a frame on it 2, so a deep layer needs 5 or 6. Too shallow and the node is not in the payload at all; the op says so rather than reporting it unchanged. The search pays for this on every step, so raise it only until the node appears.' },
      budgetMs: { type: 'number', default: 120_000, min: 10_000, max: 170_000, description: 'Give up after this long and report how far the search got. The bridge ceiling is 180s.' },
    },
  },
]

/**
 * Runs one history op. `fetchVersion` is injected so the search is testable without a network.
 */
export async function runHistoryOp(op, params, { fileKey, listVersions, fetchVersion, now = () => Date.now() }) {
  const key = fileKeyOf(params.fileKey) || fileKeyOf(fileKey) || DEFAULT_FILE_KEY
  if (!key) {
    throw new Error(
      'no file key — pass fileKey (a key or a Figma URL), or set ALLCREW_CHANNEL_FIGMA_FILE_KEY. The plugin cannot supply ' +
        'it: figma.fileKey is null for an Organization-private plugin.'
    )
  }

  if (op === 'history.versions') {
    const raw = await listVersions(key, { limit: params.limit, before: params.before })
    const listed = versionList(raw)
    const items = params.named === true ? listed.items.filter((row) => row.named) : listed.items
    return {
      fileKey: key,
      ...listed,
      items,
      note:
        listed.named === 0
          ? 'no checkpoint in this window is named, so none of them records what anybody intended — only when they ' +
            'touched the file. history.diff is the only way to learn what moved.'
          : undefined,
    }
  }

  if (op === 'history.diff') {
    const started = now()
    let fetches = 0
    const render = async (version) => {
      fetches += 1
      return fetchVersion(key, { version, nodeId: params.nodeId, depth: params.depth })
    }
    let attribution
    if (params.attribute === true) {
      const listed = versionList(await listVersions(key, { limit: 50 }))
      const ids = listed.items.map((row) => row.id)
      const iFrom = ids.indexOf(String(params.from))
      const iTo = params.to === undefined ? 0 : ids.indexOf(String(params.to))
      // `items` is newest-first, so adjacent means the indices differ by one.
      if (iFrom < 0 || iTo < 0 || Math.abs(iFrom - iTo) !== 1) {
        throw new Error(
          'attribute: true needs two ADJACENT checkpoints — a diff across a span cannot name one author for it, ' +
            'and crediting the author of the endpoint would be a claim about work that is not theirs. Call ' +
            'history.versions and pass a neighbouring pair, or drop `attribute`.'
        )
      }
      attribution = listed.items[Math.min(iFrom, iTo)]
    }
    const [before, after] = await Promise.all([render(String(params.from)), render(params.to ? String(params.to) : undefined)])
    /* The depth trap, same as in blame: Figma counts `depth` from the DOCUMENT ROOT rather than
     * from the node in `ids`, so a shallow render prunes the requested node out of both sides
     * and the diff reports no changes. Silence that means "I could not see it" has to be told
     * apart from silence that means "nothing moved". */
    if (params.nodeId) {
      const seen = flattenDocument(before).has(params.nodeId) || flattenDocument(after).has(params.nodeId)
      if (!seen) {
        throw new Error(
          `${params.nodeId} is not in the rendered payload at depth ${params.depth} — Figma counts depth from the ` +
            'DOCUMENT ROOT, not from the node you named. Raise `depth` until the node appears, or check the id.'
        )
      }
    }
    return {
      fileKey: key,
      from: String(params.from),
      to: params.to ? String(params.to) : 'current',
      ...(params.nodeId ? { nodeId: params.nodeId } : { scope: 'whole file' }),
      ...(attribution ? { by: attribution } : { by: null, note: 'a span, not one edit: nobody can be named for it. Use adjacent versions with attribute: true.' }),
      ...diffDocuments(before, after, { limit: params.limit }),
      fetches,
      ms: now() - started,
    }
  }

  if (op === 'history.blame') return blameNode(key, params, { listVersions, fetchVersion, now })

  throw new Error(`"${op}" is not a history op`)
}

/** "This node is not in the payload", which is not the same as "its value is null". */
const ABSENT = Symbol('absent')

/**
 * Finds the one checkpoint that changed a node, by bisection.
 *
 * Figma has no blame: nothing in the API attributes a property to a person. A linear walk of the
 * version list would answer it and cost one render per checkpoint — at 8–10 seconds each that is
 * minutes, inside a 180-second ceiling. Bisection is log2(N): render the ends, and if they
 * differ, halve until one step is isolated. That step has one author by construction.
 *
 * Renders are cached per version for the life of the call, because bisection revisits midpoints.
 */
async function blameNode(key, params, { listVersions, fetchVersion, now }) {
  const started = now()
  const budget = Number(params.budgetMs) || 120_000
  const listed = versionList(await listVersions(key, { limit: params.window }))
  const items = listed.items
  if (items.length < 2) {
    return { fileKey: key, nodeId: params.nodeId, found: null, note: 'fewer than two checkpoints in this window — nothing to compare' }
  }

  const cache = new Map()
  let fetches = 0
  const render = async (version) => {
    if (cache.has(version)) return cache.get(version)
    fetches += 1
    const payload = await fetchVersion(key, { version, nodeId: params.nodeId, depth: params.depth })
    cache.set(version, payload)
    return payload
  }
  /**
   * The node's own shape at a version.
   *
   * `ABSENT` rather than `null`, because "the node is not in this payload" and "the node exists
   * and the property is null" are different facts and one of them used to be reported as the
   * other. See the depth trap below.
   */
  const shapeAt = async (version) => {
    const node = flattenDocument(await render(version)).get(params.nodeId)
    if (!node) return ABSENT
    if (typeof params.property === 'string' && params.property) return JSON.stringify(node[params.property])
    return ownShape(node)
  }

  // `items` is newest-first; index 0 is now and the last index is the oldest in the window.
  const oldest = items.length - 1
  const newestShape = await shapeAt(items[0].id)
  const oldestShape = await shapeAt(items[oldest].id)

  /*
   * THE DEPTH TRAP. Figma's `depth` is counted from the DOCUMENT ROOT, not from the node named
   * in `ids` — measured: the same node was absent at depth 1 and 2 and present at depth 4. So a
   * depth too shallow for the node prunes it out of both renders, both shapes come back ABSENT,
   * and comparing them says "unchanged across this whole window". That is a confident wrong
   * answer to "who changed this", and it is the one this op must never give.
   */
  if (newestShape === ABSENT && oldestShape === ABSENT) {
    throw new Error(
      `${params.nodeId} is not in the rendered payload at depth ${params.depth} — Figma counts depth from the ` +
        'DOCUMENT ROOT, not from the node you named, so a deep layer needs a deeper render. Raise `depth` until ' +
        'the node appears (a page is 1, a frame on it 2, and so on), or check the id is still current.'
    )
  }
  if (newestShape === oldestShape) {
    return {
      fileKey: key,
      nodeId: params.nodeId,
      ...(params.property ? { property: params.property } : {}),
      found: null,
      searched: { checkpoints: items.length, from: items[oldest].at, to: items[0].at },
      note: 'unchanged across this whole window — widen `window`, or it was changed before it',
      fetches,
      ms: now() - started,
    }
  }

  /*
   * Indices run newest→oldest, so index 0 is now and `oldest` is the far end of the window.
   *
   * Invariant: `low` is the OLDEST index still carrying the current shape, and `high` is the
   * newest index carrying the older one. The checkpoint that changed the node is therefore
   * `items[low]` — it is the first one, walking forward in time, where the new shape appears.
   * Both bounds start proven: `shapeAt(items[0])` is the new shape by definition and
   * `shapeAt(items[oldest])` was just shown to differ from it.
   *
   * Getting the two assignments the wrong way round does not fail loudly — it converges on the
   * newest checkpoint instead of the responsible one, which reads like a plausible answer and
   * blames whoever touched the file last.
   */
  let low = 0
  let high = oldest
  let stoppedOn = null
  while (high - low > 1) {
    if (now() - started > budget) {
      stoppedOn = 'budgetMs'
      break
    }
    const mid = Math.floor((low + high) / 2)
    const midShape = await shapeAt(items[mid].id)
    // Still the new shape at `mid`? Then the change is at `mid` or older.
    if (midShape === newestShape) low = mid
    else high = mid
  }

  const culprit = items[low]
  const previous = items[high] ?? items[oldest]
  const before = await render(previous.id)
  const after = await render(culprit.id)
  return {
    fileKey: key,
    nodeId: params.nodeId,
    ...(params.property ? { property: params.property } : {}),
    /* The answer: one checkpoint, one author, and — because the pair is adjacent — an
     * attribution that is a fact rather than an inference. */
    found: { ...culprit, previous: { id: previous.id, at: previous.at, author: previous.author } },
    searched: { checkpoints: items.length, from: items[oldest].at, to: items[0].at },
    change: diffDocuments(before, after, { limit: 10 }),
    ...(stoppedOn ? { stoppedOn, partial: true } : {}),
    fetches,
    ms: now() - started,
  }
}

/**
 * Bezier control points for Figma's named easings.
 *
 * A copy of `BEZIER_PRESETS` in `src/targets/django/easing/index.ts`, because this file ships
 * alone: a designer downloads `bridge.mjs` and runs it from any directory, so it cannot import
 * the plugin's source. `bridge.test.mjs` asserts the two tables are identical, which is what
 * keeps a copy from becoming a fork.
 */
export const REST_BEZIER_PRESETS = {
  EASE_IN: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  EASE_OUT: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  EASE_IN_AND_OUT: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  EASE_IN_BACK: { x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 },
  EASE_OUT_BACK: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  EASE_IN_AND_OUT_BACK: { x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 },
}

/**
 * The easing as numbers, for the cases that need no solver.
 *
 * The plugin answers this for springs too, by integrating their ODE. That solver is not worth
 * copying into a file that has to stay readable in one sitting, so a spring gets `null` here and
 * the transition says which easing it could not turn into numbers - an agent that knows a curve
 * is missing falls back knowingly, one that is handed `linear` does not.
 */
export function restCurve(easing) {
  const type = easing && typeof easing.type === 'string' ? easing.type : null
  if (!type) return null
  if (type === 'LINEAR') return { kind: 'linear' }
  if (type === 'HOLD') return { kind: 'hold' }
  if (type === 'CUSTOM_CUBIC_BEZIER') {
    const points = easing.easingFunctionCubicBezier
    if (!points) return null
    return { kind: 'bezier', x1: points.x1, y1: points.y1, x2: points.x2, y2: points.y2 }
  }
  const preset = REST_BEZIER_PRESETS[type]
  return preset ? { kind: 'bezier', ...preset, preset: type } : null
}

/** A REST `transition` as the bridge reports it: Figma's own name, the duration in seconds the
 * plugin's own summary also uses, and the curve where this file can name one. */
export function restTransition(transition) {
  if (!transition || typeof transition !== 'object') return null
  const curve = restCurve(transition.easing)
  const easing = transition.easing && transition.easing.type ? transition.easing.type : 'LINEAR'
  return {
    type: transition.direction ? `${transition.type}_${transition.direction}` : transition.type,
    duration: typeof transition.duration === 'number' ? Math.round(transition.duration * 1000) / 1000 : 0,
    easing,
    ...(curve ? { curve } : { curveUnavailable: `${easing} is a spring — the plugin solves it, REST does not carry it` }),
  }
}

/**
 * Every prototype edge under one page node, from the `interactions` REST puts on a node - the
 * same `{trigger, actions[{type, destinationId, navigation, transition}]}` shape the plugin
 * reports, so the two answers differ in what they carry, never in what they mean.
 *
 * The legacy `transitionNodeID`/`transitionDuration`/`transitionEasing` triple is read as well:
 * Figma still fills it in beside `interactions`, and a file last touched by an older editor may
 * have only that.
 */
export function restEdges(page) {
  const named = new Map()
  restWalk(page, (node) => named.set(node.id, node.name))
  const edges = []
  restWalk(page, (node) => {
    const interactions = Array.isArray(node.interactions) ? node.interactions : []
    for (const interaction of interactions) {
      const actions = Array.isArray(interaction.actions) ? interaction.actions : []
      for (const action of actions) {
        if (!action || typeof action.destinationId !== 'string') continue
        edges.push({
          from: node.id,
          fromName: node.name,
          to: action.destinationId,
          toName: named.get(action.destinationId) ?? null,
          trigger: (interaction.trigger && interaction.trigger.type) || 'UNKNOWN',
          action: action.type || 'UNKNOWN',
          ...(action.navigation ? { navigation: action.navigation } : {}),
          ...(action.type === 'NODE' ? { transition: restTransition(action.transition) } : {}),
        })
      }
    }
    if (interactions.length === 0 && typeof node.transitionNodeID === 'string') {
      edges.push({
        from: node.id,
        fromName: node.name,
        to: node.transitionNodeID,
        toName: named.get(node.transitionNodeID) ?? null,
        trigger: 'ON_CLICK',
        action: 'NODE',
        // The legacy field is milliseconds where the modern one is seconds.
        transition: restTransition({
          type: 'SMART_ANIMATE',
          duration: (Number(node.transitionDuration) || 0) / 1000,
          easing: { type: node.transitionEasing || 'LINEAR' },
        }),
      })
    }
  })
  return edges
}

/**
 * A TEXT node's styled runs, rebuilt from the two halves REST splits them into:
 * `characterStyleOverrides` is one style id per CHARACTER (0 = the node's own style), and
 * `styleOverrideTable` maps those ids to the properties they override.
 *
 * A run is consecutive characters sharing an id, which is what the plugin's
 * `getStyledTextSegments` hands over directly. Variable bindings are not in this payload at all -
 * the op says so rather than reporting every run as bound to nothing.
 */
export function restTextRuns(node) {
  const characters = typeof (node && node.characters) === 'string' ? node.characters : ''
  const overrides = Array.isArray(node && node.characterStyleOverrides) ? node.characterStyleOverrides : []
  const table = (node && node.styleOverrideTable) || {}
  if (characters.length === 0) return []
  const runs = []
  const idAt = (index) => overrides[index] || 0
  let start = 0
  for (let index = 1; index <= characters.length; index += 1) {
    if (index < characters.length && idAt(index) === idAt(start)) continue
    const id = idAt(start)
    runs.push({
      start,
      end: index,
      characters: characters.slice(start, index).replace(/\n/g, '\\n'),
      // An override states only what it changes; the node's own `style` is the baseline under
      // every run, which is how the plugin reports one too.
      ...(id && table[id] ? { style: table[id] } : {}),
    })
    start = index
  }
  return runs
}

/**
 * One REST call. `method` and `body` exist because comments are the only half of this API that
 * WRITES — everything else the bridge reaches over REST is a GET, and a read-only helper is why
 * comments were unreachable through this channel at all.
 *
 * A failed call carries Figma's own message when it sent one. "Figma REST 403" alone is the
 * least useful thing that can be said about a scope problem: `file_comments:write` missing from
 * a personal token looks identical to an expired token until the body is read.
 */
const REST_MAX_CONCURRENCY = 4
const REST_MAX_ATTEMPTS = 3
const REST_TREE_TTL_MS = Math.max(
  0,
  Number(process.env.ALLCREW_CHANNEL_REST_TREE_TTL_MS || process.env.ALTERY_REST_TREE_TTL_MS || 30_000)
)
let restActive = 0
const restWaiters = []
const restTreeCache = new Map()

async function withRestSlot(run) {
  if (restActive >= REST_MAX_CONCURRENCY) await new Promise((resolve) => restWaiters.push(resolve))
  restActive += 1
  try { return await run() }
  finally {
    restActive -= 1
    restWaiters.shift()?.()
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function restFetch(route, { method = 'GET', body } = {}) {
  const token = figmaToken()
  if (!token) {
    throw new Error(
      `no Figma token — put one in ${FIGMA_TOKEN_FILE} or FIGMA_TOKEN (figma.com/developers/api#access-tokens)`
    )
  }
  for (let attempt = 1; attempt <= REST_MAX_ATTEMPTS; attempt++) {
    const response = await withRestSlot(() => fetch(`${FIGMA_API}${route}`, {
      method,
      headers: {
        'X-Figma-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON — the status is the answer */ }
    if (response.ok) return parsed
    const said = (parsed && (parsed.err || parsed.message)) || (text ? text.slice(0, 200) : '')
    if (response.status !== 429 || attempt === REST_MAX_ATTEMPTS) {
      const tier = response.headers.get('x-figma-plan-tier')
      throw new Error(
        `Figma REST ${response.status} on ${method} ${route}${said ? ` — ${said}` : ''}` +
        `${tier ? ` (plan: ${tier})` : ''}`
      )
    }
    const retryHeader = response.headers.get('retry-after')
    const seconds = retryHeader === null ? 1 : Number(retryHeader)
    const waitMs = Math.min(20_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 1000))
    await sleep(waitMs)
  }
  throw new Error(`Figma REST retry loop exhausted for ${method} ${route}`)
}

async function restFileTree(key) {
  const cached = restTreeCache.get(key)
  if (cached?.value && Date.now() - cached.at < REST_TREE_TTL_MS) return cached.value
  if (cached?.promise) return await cached.promise
  const entry = cached || { at: 0, value: null, promise: null }
  entry.promise = restFetch(`/v1/files/${encodeURIComponent(key)}?depth=2`)
    .then((value) => {
      entry.value = value
      entry.at = Date.now()
      return value
    })
    .finally(() => { entry.promise = null })
  restTreeCache.set(key, entry)
  return await entry.promise
}

/** A REST read that is allowed to fail: the library endpoints need a scope a personal token
 * often lacks, and an empty catalogue with the reason beats a failed call. */
async function restTry(route) {
  try {
    return { data: await restFetch(route) }
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
}

/** Node → the same shape `node.get` answers with, minus what REST does not carry. */
export function restNodeSummary(node, depth = 1) {
  if (!node) return null
  if (depth <= 0) return { id: node.id, name: node.name, type: node.type }
  const box = node.absoluteBoundingBox || {}
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(typeof box.width === 'number' ? { width: Math.round(box.width), height: Math.round(box.height) } : {}),
    ...(node.layoutMode && node.layoutMode !== 'NONE'
      ? {
          layout: {
            mode: node.layoutMode,
            itemSpacing: node.itemSpacing,
            padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
            primaryAxisAlign: node.primaryAxisAlignItems,
            counterAxisAlign: node.counterAxisAlignItems,
          },
        }
      : {}),
    ...(node.characters ? { text: { characters: node.characters } } : {}),
    ...(node.componentId ? { instanceOf: { id: node.componentId } } : {}),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
    children: Array.isArray(node.children)
      ? node.children.map((child) => restNodeSummary(child, depth - 1))
      : [],
  }
}

/** Depth-first walk of a REST document tree — REST hands the whole subtree at once, so the
 * search ops are a filter rather than a traversal of the canvas. */
export function restWalk(node, visit) {
  if (!node) return
  visit(node)
  for (const child of node.children || []) restWalk(child, visit)
}

/** A variant member's axis values, parsed off its NAME. REST's node payload never carries
 * `variantProperties`, the structured map the plugin reads directly — verified empty on the
 * Button set (node 819:95512) and on its members and on a Card instance's main component alike.
 * Figma writes every variant's name as `Axis=Value, Axis=Value`, which is the only place the
 * combination survives over REST. */
export function restVariantValues(name) {
  const values = {}
  for (const part of String(name || '').split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const axis = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (axis) values[axis] = value
  }
  return values
}

function normaliseVariantValue(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** The member whose axes all sit at their declared defaults — the rule
 * `src/agent/component-api.ts`'s `findDefaultVariant` applies to the plugin's live nodes, run
 * here against `values` parsed off REST names instead of `variantProperties`. `undefined` when
 * the set has no such combination, same as the plugin side. */
function restDefaultVariant(members, axisDefaults) {
  return members.find((member) =>
    axisDefaults.every(([axis, value]) => normaliseVariantValue(member.values[axis]) === normaliseVariantValue(value))
  )
}

/** The member with `axis = value` and every other axis at its default — see `restDefaultVariant`. */
function restIsolatedVariant(members, axisDefaults, axis, value) {
  return members.find(
    (member) =>
      normaliseVariantValue(member.values[axis]) === normaliseVariantValue(value) &&
      axisDefaults.every(
        ([otherAxis, otherValue]) =>
          otherAxis === axis || normaliseVariantValue(member.values[otherAxis]) === normaliseVariantValue(otherValue)
      )
  )
}

/**
 * The signature half of `component.api`, built from what REST actually carries: a component
 * set's `componentPropertyDefinitions` (verified present on the Button set's file payload —
 * axes, their options, their defaults, and non-variant properties with
 * type/defaultValue/preferredValues) and its members' `values`, parsed off their names by
 * `restVariantValues`. What this can never carry: a `getCSSAsync` diff per option (`changes`),
 * and the layer a boolean/text/swap property drives (`targets`) — `componentPropertyReferences`
 * is absent from every REST node payload this bridge has read (the set itself, a lone member,
 * and an instance all came back without it). `note` says so by name, rather than leaving a thin
 * answer to be mistaken for a complete one.
 *
 * `definitions` missing entirely — a component predating variant properties, or a file Figma
 * genuinely answers without them — falls back to axes read off the member names alone: real
 * axis names and real values, but no default and no isolated `variantId`, since neither is
 * knowable without `componentPropertyDefinitions` to say which value is the baseline.
 */
export function restComponentSignature(members, definitions) {
  const entries = Object.entries(definitions || {})
  const haveDefinitions = entries.length > 0
  const variantEntries = entries.filter(([, spec]) => spec.type === 'VARIANT')
  const axisNames = haveDefinitions
    ? variantEntries.map(([name]) => name)
    : [...new Set(members.flatMap((member) => Object.keys(member.values)))]
  const axisDefaults = variantEntries.map(([name, spec]) => [name, String(spec.defaultValue ?? '')])
  const defaultVariant = haveDefinitions ? restDefaultVariant(members, axisDefaults) : undefined

  const axes = axisNames.map((name) => {
    const spec = variantEntries.find(([entryName]) => entryName === name)?.[1]
    const values =
      spec?.variantOptions ?? [...new Set(members.map((member) => member.values[name]).filter((value) => value !== undefined))]
    const options = values.map((value) => {
      const isDefault = Boolean(spec) && normaliseVariantValue(value) === normaliseVariantValue(spec.defaultValue)
      const isolated = haveDefinitions
        ? isDefault
          ? defaultVariant
          : restIsolatedVariant(members, axisDefaults, name, value)
        : undefined
      return {
        value,
        ...(isDefault ? { isDefault: true } : {}),
        ...(isolated ? { variantId: isolated.id, variantName: isolated.name } : {}),
      }
    })
    return { name, ...(spec ? { default: String(spec.defaultValue ?? '') } : {}), options }
  })

  const properties = entries
    .filter(([, spec]) => spec.type !== 'VARIANT')
    .map(([name, spec]) => ({
      name,
      type: spec.type,
      ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
      ...(spec.preferredValues ? { preferredValues: spec.preferredValues } : {}),
    }))

  const notes = []
  if (axisNames.length > 0) {
    notes.push(
      haveDefinitions
        ? 'no option carries `changes`, the CSS delta against the default variant — that needs getCSSAsync, which only runs inside the plugin'
        : 'this component has no componentPropertyDefinitions in the REST payload, so axes come from variant NAMES alone: no default is known and no option gets isDefault or a variantId'
    )
  }
  if (properties.length > 0) {
    notes.push(
      'no property carries `targets` — REST never serves componentPropertyReferences, the map from a property to the layer it drives'
    )
  }
  const note =
    notes.length > 0
      ? `REST gives the declared signature, not the behaviour: ${notes.join('; ')}. Open the plugin for those.`
      : 'this node declares no component properties over REST.'

  return {
    ...(defaultVariant ? { defaultVariant: { id: defaultVariant.id, name: defaultVariant.name } } : {}),
    axes,
    properties,
    variants: members.map((member) => ({ id: member.id, name: member.name, values: member.values })),
    note,
  }
}

async function restCall(op, params = {}, fileKey) {
  const key = fileKey
  if (REST_REFUSALS[op]) {
    throw new Error(`"${op}" needs the plugin open — ${REST_REFUSALS[op]}`)
  }
  if (!REST_OPS.includes(op)) {
    throw new Error(`"${op}" is not answerable over REST — open the plugin. REST can do: ${REST_OPS.join(', ')}`)
  }

  if (op === 'document.info') {
    const file = await restFetch(`/v1/files/${key}?depth=1`)
    return {
      fileName: file.name,
      fileKey: key,
      lastModified: file.lastModified,
      editorType: file.editorType || null,
      pages: (file.document?.children || []).map((page) => ({ id: page.id, name: page.name })),
    }
  }

  if (op === 'page.frames') {
    const file = await restFileTree(key)
    const pages = file.document?.children || []
    const page = params.pageId ? pages.find((entry) => entry.id === params.pageId) : pages[0]
    if (!page) throw new Error(`no page ${params.pageId || '(first)'} in this file`)
    return {
      page: { id: page.id, name: page.name },
      frames: (page.children || []).map((frame) => restNodeSummary(frame, 1)),
    }
  }

  if (op === 'node.get') {
    const ids = encodeURIComponent(String(params.nodeId || ''))
    if (!ids) throw new Error('nodeId is required')
    const depth = Math.min(20, Math.max(0, Number(params.depth) || 1))
    const answer = await restFetch(`/v1/files/${key}/nodes?ids=${ids}&depth=${depth}`)
    const entry = Object.values(answer.nodes || {})[0]
    if (!entry) throw new Error(`no node ${params.nodeId} in this file`)
    return restNodeSummary(entry.document, depth)
  }

  if (op === 'node.find') {
    const file = await restFetch(`/v1/files/${key}?depth=${Number(params.depth) || 4}`)
    const needle = String(params.name || '').toLowerCase()
    const types = Array.isArray(params.types) ? params.types : null
    const found = []
    restWalk(file.document, (node) => {
      if (found.length >= (Number(params.limit) || 50)) return
      if (needle && !String(node.name || '').toLowerCase().includes(needle)) return
      if (types && !types.includes(node.type)) return
      found.push({ id: node.id, name: node.name, type: node.type })
    })
    return { count: found.length, nodes: found }
  }

  if (op === 'components.list') {
    // The library endpoints need a token scope a plain personal token often lacks, and they
    // only ever list PUBLISHED components anyway. A 403 here is a fact about the token, not a
    // failed call — it is reported as such, with the way round it.
    const [components, sets] = await Promise.all([
      restTry(`/v1/files/${key}/components`),
      restTry(`/v1/files/${key}/component_sets`),
    ])
    const list = {
      sets: (sets.data?.meta?.component_sets || []).map((entry) => ({ key: entry.key, name: entry.name, description: entry.description })),
      components: (components.data?.meta?.components || []).map((entry) => ({
        key: entry.key,
        name: entry.name,
        nodeId: entry.node_id,
        setId: entry.containing_frame?.containingStateGroup?.nodeId || null,
        description: entry.description,
      })),
    }
    // REST lists PUBLISHED components only. An unpublished library answers with an empty list,
    // which reads exactly like "this file has no components" — the one thing it must not be
    // mistaken for, since most files an agent meets have never been published.
    if (list.sets.length === 0 && list.components.length === 0) {
      const refused = [components.error, sets.error].filter(Boolean)
      list.note =
        (refused.length > 0
          ? `Figma refused the library endpoints (${refused.join('; ')}) — a personal token often lacks that scope. `
          : 'REST lists published library components only, and this file has none published — that is not the same as having none. ') +
        'Open the plugin for the real catalogue, or use node.find with types ["COMPONENT_SET"], which reads the ' +
        'document itself and needs no library scope.'
    }
    return list
  }

  if (op === 'component.api') {
    // A SET, a member, or an instance — the same three the plugin op resolves. REST hands the
    // resolution over for free, no library scope needed: fetching ANY of the three returns an
    // `entry.components`/`entry.componentSets` metadata map alongside `document`, and a
    // member's or an instance's main component's entry in `entry.components` carries
    // `componentSetId` — verified on the Button set (819:95512), its member (819:95513), and
    // the Card instance (4008:55636), whose `componentId` resolved straight to its set.
    const nodeId = String(params.nodeId || '')
    if (!nodeId) throw new Error('nodeId is required')
    const first = await restFetch(`/v1/files/${key}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`)
    const entry = first.nodes?.[nodeId]
    if (!entry) throw new Error(`no node ${nodeId} in this file`)
    let doc = entry.document
    let meta = entry.componentSets?.[doc.id] || entry.components?.[doc.id] || null

    const resolveTo = async (resolvedId) => {
      if (!resolvedId || resolvedId === doc.id) return
      const second = await restFetch(`/v1/files/${key}/nodes?ids=${encodeURIComponent(resolvedId)}&depth=1`)
      const resolvedEntry = second.nodes?.[resolvedId]
      if (!resolvedEntry) {
        throw new Error(`resolved ${doc.name} to ${resolvedId}, but Figma has no such node — pass the COMPONENT_SET id directly`)
      }
      doc = resolvedEntry.document
      meta = resolvedEntry.componentSets?.[doc.id] || resolvedEntry.components?.[doc.id] || null
    }

    if (doc.type === 'INSTANCE') {
      const mainId = String(doc.componentId || '')
      if (!mainId) throw new Error(`${doc.name} carries no componentId over REST — pass the COMPONENT_SET id directly`)
      await resolveTo(entry.components?.[mainId]?.componentSetId || mainId)
    } else if (doc.type === 'COMPONENT') {
      await resolveTo(entry.components?.[doc.id]?.componentSetId)
    } else if (doc.type !== 'COMPONENT_SET') {
      throw new Error(`${doc.type} is not a component, a variant or an instance of one — pass a COMPONENT_SET id`)
    }

    const members =
      doc.type === 'COMPONENT_SET'
        ? (doc.children || []).map((child) => ({ id: child.id, name: child.name, values: restVariantValues(child.name) }))
        : []
    return {
      id: doc.id,
      name: doc.name,
      ...(meta?.key ? { key: meta.key } : {}),
      type: doc.type,
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.documentationLinks?.length ? { documentationLinks: meta.documentationLinks } : {}),
      ...restComponentSignature(members, doc.componentPropertyDefinitions),
    }
  }

  if (op === 'styles.list') {
    const styles = await restTry(`/v1/files/${key}/styles`)
    const list = {
      styles: (styles.data?.meta?.styles || []).map((entry) => ({
        key: entry.key,
        name: entry.name,
        type: entry.style_type,
        nodeId: entry.node_id,
      })),
    }
    if (list.styles.length === 0) {
      list.note = styles.error
        ? `Figma refused /styles (${styles.error}) — a personal token often lacks the library scope. The plugin reads local styles with none.`
        : 'REST lists published styles only — an unpublished file answers empty. The plugin reads local styles.'
    }
    return list
  }

  if (op === 'flow.map') {
    // One page, not the whole file: `/nodes` hands over a full subtree, and a prototype edge can
    // sit on any depth of instance inside a frame, so a depth-limited file read would report a
    // graph with holes in it and no way to tell.
    let pageId = typeof params.pageId === 'string' && params.pageId !== '' ? params.pageId : null
    if (!pageId) {
      const shallow = await restFetch(`/v1/files/${key}?depth=1`)
      pageId = (shallow.document?.children || [])[0]?.id
      if (!pageId) throw new Error('this file has no pages')
    }
    const answer = await restFetch(`/v1/files/${key}/nodes?ids=${encodeURIComponent(pageId)}`)
    const page = Object.values(answer.nodes || {})[0]?.document
    if (!page) throw new Error(`no page ${pageId} in this file`)
    return {
      page: { id: page.id, name: page.name },
      startingPoints: (page.flowStartingPoints || []).map((point) => ({ nodeId: point.nodeId, name: point.name })),
      frames: (page.children || []).filter((node) => node.type === 'FRAME').map((node) => ({ id: node.id, name: node.name })),
      edges: restEdges(page),
    }
  }

  if (op === 'text.segments') {
    const ids = encodeURIComponent(String(params.nodeId || ''))
    if (!ids) throw new Error('nodeId is required')
    const answer = await restFetch(`/v1/files/${key}/nodes?ids=${ids}&depth=1`)
    const node = Object.values(answer.nodes || {})[0]?.document
    if (!node) throw new Error(`no node ${params.nodeId} in this file`)
    if (node.type !== 'TEXT') throw new Error(`${node.type} — need a TEXT node`)
    return {
      node: { id: node.id, name: node.name },
      style: node.style || null,
      segments: restTextRuns(node),
      // The reason this op exists inside the plugin is bindings, and they are the one thing REST
      // does not carry. Saying it beats answering "no run owns that binding", which is what a
      // silent omission would mean to the caller.
      note: 'REST carries the styling of each run but no variable bindings — open the plugin for those.',
    }
  }

  if (op === 'image.fills') {
    const ids = encodeURIComponent(String(params.nodeId || ''))
    if (!ids) throw new Error('nodeId is required')
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20))
    const [answer, refs] = await Promise.all([
      restFetch(`/v1/files/${key}/nodes?ids=${ids}`),
      restFetch(`/v1/files/${key}/images`),
    ])
    const node = Object.values(answer.nodes || {})[0]?.document
    if (!node) throw new Error(`no node ${params.nodeId} in this file`)
    const urls = refs.meta?.images || {}
    // Deduplicated by hash, like the plugin's own answer: one photo used on nine cards is one
    // file, and the nodes that paint with it are listed beside it.
    const byHash = new Map()
    restWalk(node, (child) => {
      for (const paint of child.fills || []) {
        if (paint?.type !== 'IMAGE' || typeof paint.imageRef !== 'string') continue
        const entry = byHash.get(paint.imageRef) || { imageHash: paint.imageRef, url: urls[paint.imageRef] || null, nodes: [] }
        if (entry.nodes.length < 8) entry.nodes.push({ id: child.id, name: child.name })
        byHash.set(paint.imageRef, entry)
      }
    })
    const wanted = [...byHash.values()].slice(0, limit)
    const dir = path.join(FILES_DIR, `rest-image-fills-${crypto.randomUUID().slice(0, 8)}`)
    const images = []
    const failed = []
    for (const entry of wanted) {
      if (!entry.url) {
        // A hash the file references and the images endpoint does not list: the upload is gone,
        // which is a fact about the file rather than a failure of this call.
        failed.push({ imageHash: entry.imageHash, reason: 'Figma lists no URL for this image ref' })
        continue
      }
      try {
        const response = await fetch(entry.url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${entry.imageHash.slice(0, 12)}.png`)
        fs.writeFileSync(file, bytes)
        images.push({ ...entry, bytes: bytes.length, file: { path: file, bytes: bytes.length } })
      } catch (err) {
        failed.push({ imageHash: entry.imageHash, reason: (err && err.message) || String(err) })
      }
    }
    sweepRuns()
    return {
      node: { id: node.id, name: node.name },
      total: byHash.size,
      truncated: byHash.size > wanted.length,
      images,
      ...(failed.length > 0 ? { failed } : {}),
      // S3 links expire; the bytes are on disk either way, which is what the plugin's answer is.
      note: 'The URLs Figma hands out are signed and short-lived — use the files written beside them.',
    }
  }

  // node.screenshot — REST renders server-side and answers with a URL, so the bytes are
  // fetched here and land in the same run directory an op's files would.
  const nodeId = String(params.nodeId || '')
  if (!nodeId) throw new Error('nodeId is required')
  const format = String(params.format || 'png').toLowerCase()
  const scale = Math.min(4, Math.max(0.01, Number(params.scale) || 1))
  const rendered = await restFetch(
    `/v1/images/${key}?ids=${encodeURIComponent(nodeId)}&scale=${scale}&format=${format}`
  )
  const url = Object.values(rendered.images || {})[0]
  if (!url) throw new Error(`Figma rendered nothing for ${nodeId}`)
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())
  const dir = path.join(FILES_DIR, `rest-${op.replace(/\W+/g, '-')}-${crypto.randomUUID().slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${nodeId.replace(/[^A-Za-z0-9]+/g, '-')}.${format}`)
  fs.writeFileSync(file, bytes)
  sweepRuns()
  return { nodeId, scale, format, bytes: bytes.length, file: { path: file, bytes: bytes.length } }
}

/* ------------------------------------------------------------------- calls */

/** How many ops one batch may carry. Sized so a batch cannot outlive the single call ceiling it
 * shares: at a second an op, thirty-two is comfortably inside 180s, and a caller with more work
 * than that wants several batches and the chance to look at what the first one did. */
const MAX_BATCH = 32

/**
 * A history op, gated like a read and costed out loud.
 *
 * Reads follow the read gate the same way comments do. There is no write half here: the only
 * thing that writes to history is `figma.saveVersionHistoryAsync`, which lives in the plugin.
 */
async function runHistory(op, body) {
  const online = roster()
  const params = body.params && typeof body.params === 'object' ? body.params : {}
  if (op === 'history.recent') {
    if (online.length > 0 && !online.some((plugin) => plugin.gates?.read === true)) {
      return { code: 400, body: fail('gate_closed', 'reads are off — enable \"Allow reads\" in one open plugin') }
    }
    try {
      const tabs = readDesktopTabs()
      const result = await runRecentHistory(params, {
        tabs,
        listVersions: async (key, { limit } = {}) => {
          const query = new URLSearchParams({ page_size: String(Math.min(50, Math.max(1, Number(limit) || 50))) })
          const answer = await restFetch(`/v1/files/${encodeURIComponent(key)}/versions?${query}`)
          return answer?.versions || []
        },
        fileMeta: async (key) => await restFetch(`/v1/files/${encodeURIComponent(key)}/meta`),
      })
      return { code: 200, body: { ok: true, op, source: 'rest', result } }
    } catch (error) {
      return { code: 400, body: { ...fail('figma_threw', error.message), op, source: 'rest' } }
    }
  }

  const addressed = body.target ? resolveTarget(body.target) : null
  if (addressed?.error) {
    return { code: 409, body: fail('ambiguous_target', addressed.error, { files: addressed.candidates || [] }) }
  }
  const plugin = addressed?.plugin || (online.length === 1 ? online[0] : null)
  if (plugin && (!plugin.gates || plugin.gates.read !== true)) {
    return { code: 400, body: fail('gate_closed', 'reads are off — enable \"Allow reads\" in the plugin') }
  }
  const listVersions = async (key, { limit, before } = {}) => {
    const query = new URLSearchParams()
    query.set('page_size', String(Math.min(50, Math.max(1, Number(limit) || 30))))
    if (before) query.set('before', String(before))
    const answer = await restFetch(`/v1/files/${encodeURIComponent(key)}/versions?${query}`)
    return (answer && answer.versions) || []
  }
  const fetchVersion = async (key, { version, nodeId, depth } = {}) => {
    const query = new URLSearchParams()
    if (version) query.set('version', String(version))
    if (nodeId) query.set('ids', String(nodeId))
    if (depth) query.set('depth', String(depth))
    const answer = await restFetch(`/v1/files/${encodeURIComponent(key)}?${query}`)
    return (answer && answer.document) || null
  }
  try {
    const fileKey = body.fileKey || params.fileKey || plugin?.fileKey
    const result = await runHistoryOp(op, params, { fileKey, listVersions, fetchVersion })
    return { code: 200, body: { ok: true, op, source: 'rest', result } }
  } catch (err) {
    const message = (err && err.message) || String(err)
    const code = /\b40[13]\b/.test(message)
      ? 'unauthorized'
      : /no file key|no Figma token/.test(message)
        ? 'bad_request'
        : /adjacent checkpoints/.test(message)
          ? 'param_invalid'
          : 'figma_threw'
    const hint = code === 'unauthorized'
      ? ' — a personal token needs the file_versions:read (or files:read) scope; it is chosen when the token is created'
      : ''
    return { code: code === 'unauthorized' ? 401 : 400, body: { ...fail(code, message + hint), op, source: 'rest' } }
  }
}

/**
 * A comment op, gated and aimed.
 *
 * **The gate.** Comment writes require a connected plugin whose WRITE gate is on, even though
 * the plugin performs none of the work. That is not bureaucracy: the gates are how a designer
 * consents to an agent touching their file, and a comment posted into a file is as visible as a
 * layer moved in it. Reading the gate the plugin PUSHED (on hello, and on every change) is not
 * the bridge deciding for itself — it is the plugin's own statement, which is the same authority
 * `/call` round-trips for. With nothing connected there is no statement to read and no designer
 * to consent, so a write is refused rather than allowed by default.
 *
 * Reads follow the read gate the same way, and fall back to the REST rule when no plugin is
 * open: a token-holder reading comments over REST is doing what the Figma web app does.
 *
 * **The aiming.** A `nodeId` has to become `{node_id, node_offset}`, and only the plugin can do
 * that — the offset needs the layer's and its enclosing frame's `absoluteBoundingBox`. So the
 * write costs one extra round trip into the plugin for `node.anchor` before the POST goes out.
 * Worth it: the alternative is a pin on the canvas that does not follow the screen.
 */
async function runComments(op, body) {
  const mutates = op !== 'comments.list'
  const online = roster()
  const addressed = body.target ? resolveTarget(body.target) : null
  if (addressed?.error) {
    return { code: 409, body: fail('ambiguous_target', addressed.error, { files: addressed.candidates || [] }) }
  }
  const plugin = addressed?.plugin || (online.length === 1 ? online[0] : null)

  if (mutates) {
    if (!plugin) {
      return {
        code: 503,
        body: fail(
          'no_plugin',
          `"${op}" writes into the file, so it needs the designer present: open the AllCrew Figma Workspace plugin and switch ` +
            '"Allow changes" on. Reading comments needs no plugin.'
        ),
      }
    }
    if (!plugin.gates || plugin.gates.write !== true) {
      return {
        code: 400,
        body: fail('gate_closed', 'writes are off — enable "Allow changes" in the plugin'),
      }
    }
  } else if (plugin && (!plugin.gates || plugin.gates.read !== true)) {
    return { code: 400, body: fail('gate_closed', 'reads are off — enable "Allow reads" in the plugin') }
  }

  /** Resolves a node id to a frame and an offset by asking the plugin's own `node.anchor`. */
  const aim = async (nodeId, anchorPoint) => {
    if (!plugin) {
      throw new Error(
        `pinning to a node needs the plugin open — the offset is computed from the layer's and its frame's ` +
          `absolute boxes, which only the plugin can read. Post with x and y for an absolute pin instead.`
      )
    }
    const answer = await dispatch(plugin, 'node.anchor', {
      nodeId,
      ...(anchorPoint ? { anchor: anchorPoint } : {}),
    })
    if (!answer.ok) throw new Error(`could not aim at ${nodeId}: ${answer.error}`)
    const result = answer.result || {}
    const pin = result.pin || {}
    return {
      node: result.node || { id: nodeId },
      frame: typeof pin.node_id === 'string' ? pin.node_id : null,
      offset: pin.node_offset || (typeof pin.x === 'number' ? { x: pin.x, y: pin.y } : null),
      anchor: result.anchor || 'center',
      ...(result.rotated ? { rotated: true } : {}),
    }
  }

  try {
    /* `body` is the /call envelope — the op's own arguments are in `body.params`. `fileKey` is
     * read from the envelope too, so a batch that names the file once still reaches every call. */
    const params = body.params && typeof body.params === 'object' ? body.params : {}
    const result = await runCommentOp(op, params, { fileKey: body.fileKey || params.fileKey || plugin?.fileKey, aim })
    return { code: 200, body: { ok: true, op, source: 'rest', result } }
  } catch (err) {
    const message = (err && err.message) || String(err)
    /* A scope problem and an expired token both arrive as 403, and the difference decides what
     * a person has to go and do. Figma's own message is carried through, and the scope is
     * named because a personal token minted without it fails exactly here. */
    const code = /\b40[13]\b/.test(message)
      ? 'unauthorized'
      : /no file key|no Figma token/.test(message)
        ? 'bad_request'
        : /^nothing to pin|message is empty|emoji is required/.test(message)
          ? 'param_invalid'
          : 'figma_threw'
    const hint =
      code === 'unauthorized'
        ? ' — a personal token needs the file_comments:read scope to list and file_comments:write to post; ' +
          'both are chosen when the token is created and cannot be added later'
        : ''
    return { code: code === 'unauthorized' ? 401 : 400, body: { ...fail(code, message + hint), op, source: 'rest' } }
  }
}

/**
 * One op against one file, from body to answer. The whole of `POST /call`, factored out so the
 * batch route runs exactly the same path — a batch that took a different route to the same op
 * would be a second implementation of the gate, the schema check and the REST fallback.
 */
async function runCall(body) {
  const op = typeof body.op === 'string' ? body.op : ''
  if (!op) return { code: 400, body: fail('bad_request', 'missing "op"') }

  /* Comments come first, and never reach the plugin: the Plugin API has no comment surface at
   * all, so these are the one class of op the bridge answers itself whether or not a file is
   * open. Ahead of the REST branch below because that one is a FALLBACK — comments are REST by
   * nature, not by the plugin being absent. */
  if (COMMENT_REFUSALS[op]) {
    return { code: 400, body: { ...fail('rest_unavailable', COMMENT_REFUSALS[op]), op } }
  }
  if (COMMENT_OPS.includes(op)) return runComments(op, body)

  /* History is the same shape as comments: REST-only, so the bridge answers it. Reads only —
   * `history.mark` is a PLUGIN op, because writing a version is `figma.saveVersionHistoryAsync`
   * and REST has no equivalent. */
  if (HISTORY_REFUSALS[op]) {
    return { code: 400, body: { ...fail('rest_unavailable', HISTORY_REFUSALS[op]), op } }
  }
  if (HISTORY_OPS.includes(op)) return runHistory(op, body)

  /* REST before the roster: either the caller addressed a file key outright, or nothing is
   * open and a default key is configured. The answer is marked `source: "rest"` — an agent
   * that cannot tell which half answered cannot tell a thin answer from a complete one. */
  if (wantsRest(body, roster().length > 0)) {
    const key = requestedFileKey(body) || fileKeyOf(body.target) || DEFAULT_FILE_KEY
    if (!key) {
      return {
        code: 400,
        body: fail(
          'bad_request',
          'no file key — pass fileKey (or target "rest:<key>"), or set ALLCREW_CHANNEL_FIGMA_FILE_KEY'
        ),
      }
    }
    try {
      const result = await restCall(op, body.params || {}, key)
      return { code: 200, body: { ok: true, op, source: 'rest', fileKey: key, result } }
    } catch (err) {
      /* A REST refusal is one of two very different things: this op needs the plugin open (never
       * fixable by retrying), or the call itself went wrong. `REST_REFUSALS` is the first kind. */
      const message = (err && err.message) || String(err)
      const code = REST_REFUSALS[op] !== undefined || /needs the plugin open/.test(message)
        ? 'rest_unavailable'
        : 'figma_threw'
      return { code: 400, body: { ...fail(code, message), op, source: 'rest', fileKey: key } }
    }
  }

  /* Broadcast: one question, every connected file, one answer each. This is the whole point
   * of holding a registry — "which of my open files still paints raw hexes" is one call.
   * Reads only: writing the same thing into every open document is never what someone meant
   * to type, so it is refused rather than confirmed. */
  if (body.target === '*') {
    const online = roster()
    if (online.length === 0) return { code: 503, body: fail('no_plugin', 'no plugin connected') }
    const mutating = online.filter((plugin) => opIsMutating(plugin, op))
    if (mutating.length > 0) {
      return {
        code: 400,
        body: fail(
          'broadcast_write_refused',
          `"${op}" writes to the document — a broadcast write is refused. Name one target instead.`,
          { files: online.map(describe) }
        ),
      }
    }
    /* One schema check against the first plugin that publishes one: a broadcast is the same
     * call to every file, so a bad parameter is bad everywhere, and finding that out once is
     * better than finding it out per file. */
    const spec = online.map((plugin) => opEntry(plugin, op)).find((found) => found && found.params)
    const wrong = checkParams(spec, body.params)
    if (wrong.length > 0) {
      return { code: 400, body: { ...fail('param_invalid', wrong.join('; '), { problems: wrong }), op } }
    }

    const answers = await Promise.all(
      online.map(async (plugin) => ({
        file: plugin.file,
        handle: plugin.handle,
        ...(await dispatch(plugin, op, body.params)),
      }))
    )
    return {
      code: 200,
      body: { ok: true, op, broadcast: true, count: answers.length, results: answers },
    }
  }

  const found = resolveTarget(body.target)
  if (found.error) {
    const empty = roster().length === 0
    return {
      code: empty ? 503 : 409,
      body: fail(empty ? 'no_plugin' : 'ambiguous_target', found.error, { files: found.candidates || [] }),
    }
  }

  const plugin = found.plugin

  /* Checked against the schema of the plugin that will actually run it, not a shared idea of
   * the op: two connected files can be running different builds, and the one being addressed
   * is the only one whose contract matters here. */
  const wrong = checkParams(opEntry(plugin, op), body.params)
  if (wrong.length > 0) {
    return {
      code: 400,
      body: {
        ...fail('param_invalid', wrong.join('; '), { problems: wrong }),
        op,
        file: plugin.file,
        handle: plugin.handle,
      },
    }
  }

  const answer = await dispatch(plugin, op, body.params)
  /* The answer always names the file it came from. An agent that cannot see which document
   * replied cannot tell a right answer from a right-looking one. */
  return {
    code: answer.ok ? 200 : 400,
    body: answer.ok
      ? { ok: true, op, file: plugin.file, handle: plugin.handle, result: answer.result }
      : {
          ok: false,
          op,
          file: plugin.file,
          handle: plugin.handle,
          error: answer.error,
          code: answer.code,
          retryable: answer.retryable,
        },
  }
}


async function acceptPluginResult(body, plugin) {
  if (plugin) plugin.lastSeen = Date.now()
  const entry = pending.get(body.id)
  if (!entry) return { ok: true, note: 'no caller waiting' }
  clearTimeout(entry.timer)
  pending.delete(body.id)
  console.log(
    new Date().toISOString(),
    `${plugin ? plugin.handle : '?'} · ${entry.op} — ${body.ok ? 'ok' : 'error: ' + body.error}`,
    `(${Date.now() - entry.startedAt}ms)`
  )
  if (body.ok !== true) {
    entry.resolve(failFromPlugin(body))
    return { ok: true }
  }
  let result = body.result
  try {
    const written = []
    result = materialiseFiles(result, path.join(FILES_DIR, `${entry.op.replace(/[^a-z0-9.]/gi, '-')}-${body.id.slice(0, 8)}`), written)
    if (written.length > 0) {
      console.log(new Date().toISOString(), `  wrote ${written.length} file${written.length === 1 ? '' : 's'} → ${path.dirname(written[0])}`)
      sweepRuns()
    }
  } catch (error) {
    entry.resolve(fail('file_write_failed', `could not write the files this op returned: ${error.message}`))
    return { ok: true }
  }
  entry.resolve({ ok: true, result })
  return { ok: true }
}
/* ---------------------------------------------------------- browser mirror */

const MIRROR_EVENT_LIMIT = 500
const MIRROR_CONTROLLER_MS = 45_000
const MIRROR_VIEWER_MS = 35_000
/** client id → Figma iframe acting as the live browser client's transport. */
const mirrorPlugins = new Map()

const mirrorIsOnline = (plugin) => Date.now() - plugin.lastSeen < OFFLINE_AFTER_MS
const mirrorRoster = () => [...mirrorPlugins.values()].filter(mirrorIsOnline)
const mirrorIsWatched = (plugin) => Date.now() - (plugin.viewerSeen || 0) < MIRROR_VIEWER_MS

function mintMirrorHandle(fileName) {
  const base =
    String(fileName || 'file')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'file'
  const taken = new Set([...mirrorPlugins.values()].map((plugin) => plugin.handle))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function describeMirror(plugin) {
  return {
    clientId: plugin.clientId,
    handle: plugin.handle,
    file: plugin.file,
    online: mirrorIsOnline(plugin),
    watched: mirrorIsWatched(plugin),
    viewers: plugin.viewers.size,
    queued: plugin.commands.length,
    lastSeen: new Date(plugin.lastSeen).toISOString(),
  }
}

function resolveMirrorTarget(target) {
  const online = mirrorRoster()
  if (online.length === 0) return { error: 'no live plugin UI is connected to the browser mirror' }
  if (target === undefined || target === null || target === '') {
    if (online.length === 1) return { plugin: online[0] }
    return {
      error: `${online.length} plugin UIs are connected — name one: ${online.map((plugin) => plugin.handle).join(', ')}`,
      candidates: online.map(describeMirror),
    }
  }
  const needle = String(target).toLowerCase()
  const exact = online.filter((plugin) => plugin.handle === needle || plugin.clientId === target)
  const loose = online.filter(
    (plugin) => plugin.handle.includes(needle) || String(plugin.file || '').toLowerCase().includes(needle)
  )
  const matched = exact.length ? exact : loose
  if (matched.length === 1) return { plugin: matched[0] }
  if (matched.length === 0) {
    return {
      error: `no browser mirror matches "${target}"`,
      candidates: online.map(describeMirror),
    }
  }
  return {
    error: `"${target}" matches ${matched.length} browser mirrors`,
    candidates: matched.map(describeMirror),
  }
}

function mirrorEventsAfter(plugin, cursor) {
  return plugin.events.filter((event) => event.seq > cursor)
}

function mirrorEventBody(plugin, cursor) {
  const events = mirrorEventsAfter(plugin, cursor)
  return {
    ok: true,
    generation: plugin.generation,
    target: plugin.handle,
    events,
    cursor: events.length > 0 ? events[events.length - 1].seq : cursor,
  }
}

function flushMirrorViewers(plugin) {
  for (const viewer of [...plugin.viewers]) {
    const events = mirrorEventsAfter(plugin, viewer.cursor)
    if (events.length === 0) continue
    clearTimeout(viewer.timer)
    plugin.viewers.delete(viewer)
    send(viewer.res, 200, mirrorEventBody(plugin, viewer.cursor))
  }
}

function appendMirrorEvent(plugin, message) {
  plugin.events.push({ seq: plugin.nextSeq++, message })
  if (plugin.events.length > MIRROR_EVENT_LIMIT) {
    plugin.events.splice(0, plugin.events.length - MIRROR_EVENT_LIMIT)
  }
  flushMirrorViewers(plugin)
}

function flushMirrorCommands(plugin) {
  if (!plugin.poller || plugin.commands.length === 0) return
  const { res, timer } = plugin.poller
  plugin.poller = null
  clearTimeout(timer)
  send(res, 200, { ok: true, watched: mirrorIsWatched(plugin), commands: plugin.commands.splice(0, plugin.commands.length) })
}

function claimMirrorController(plugin, viewerId) {
  const now = Date.now()
  if (
    plugin.controller &&
    plugin.controller.viewerId !== viewerId &&
    now - plugin.controller.lastSeen < MIRROR_CONTROLLER_MS
  ) {
    return false
  }
  plugin.controller = { viewerId, lastSeen: now }
  return true
}

function closeMirrorPlugin(plugin, reason) {
  if (plugin.poller) {
    clearTimeout(plugin.poller.timer)
    send(plugin.poller.res, 409, { ok: false, error: reason })
    plugin.poller = null
  }
  for (const viewer of plugin.viewers) {
    clearTimeout(viewer.timer)
    send(viewer.res, 409, { ok: false, error: reason })
  }
  plugin.viewers.clear()
  mirrorPlugins.delete(plugin.clientId)
}

function mirrorPage(plugin) {
  const config = JSON.stringify({
    target: plugin.handle,
    secret: SECRET,
    base: `http://${HOST}:${PORT}`,
  }).replace(/</g, '\\u003c')
  // Split the script-closing tag: this standalone file is embedded inside ui.html, where that
  // sequence would terminate the host script even when it only appears inside a string.
  const injected = '<scr' + `ipt>window.__ALLCREW_BROWSER_MIRROR__=${config}</scr` + 'ipt>'
  const source = String(plugin.source || '')
  return '<!DOCTYPE html>\n' + source.replace(/<head>/i, `<head>${injected}`)
}

/* ------------------------------------------------------------------ routes */

const ROUTES = {
  /* ---- agent side ---- */

  'GET /status': async (req, res, url) => {
    const files = roster().map(describe)
    return {
      code: 200,
      // `callTimeoutMs` is published so a caller can size its own work to the ceiling instead of
      // discovering it as a failed 3-minute call.
      body: {
        online: files.length > 0,
        files,
        count: files.length,
        inFlight: pending.size,
        callTimeoutMs: CALL_TIMEOUT_MS,
        // What a plain fetch client can actually wait for, and a word about the gap when the
        // configured ceiling is past it — a promise nobody can collect on is worse than a
        // smaller promise.
        clientCeilingMs: CLIENT_CEILING_MS,
        ...(CALL_TIMEOUT_MS > CLIENT_CEILING_MS
          ? {
              ceilingNote:
                `callTimeoutMs is ${Math.round(CALL_TIMEOUT_MS / 1000)}s, but Node's fetch drops a request ` +
                `after ${CLIENT_CEILING_MS / 1000}s with "fetch failed" — page the work (limit/offset/budgetMs) ` +
                'instead of waiting longer.',
            }
          : {}),
        // What is available when nothing is open — so an agent can plan instead of discovering
        // an empty roster as a failure.
        rest: {
          token: Boolean(figmaToken()),
          defaultFileKey: DEFAULT_FILE_KEY || null,
          ops: REST_OPS,
          refuses: REST_REFUSALS,
        },
      },
    }
  },

  'GET /ops': async (req, res, url) => {
    /* Comment ops ride along in every view. They are not the plugin's and not the REST
     * fallback's — they are the bridge's own, and a client that cannot see them in the manifest
     * has no way to learn the channel can annotate a design at all. */
    const withComments = (ops) => [
      ...ops,
      ...COMMENT_MANIFEST.map((op) => ({ ...op, source: 'rest' })),
      ...HISTORY_MANIFEST.map((op) => ({ ...op, source: 'rest' })),
    ]
    const target = url.searchParams.get('target')
    if (target) {
      const found = resolveTarget(target)
      if (found.error) return { code: 404, body: fail('ambiguous_target', found.error, { files: found.candidates || [] }) }
      return { code: 200, body: { ...describe(found.plugin), policy: FIDELITY_POLICY, ops: withComments(found.plugin.ops || []) } }
    }
    if (roster().length === 0) {
      // Nothing open: say what REST can still answer rather than an empty list that reads as
      // "this channel is dead".
      return {
        code: 200,
        body: {
          online: false,
          count: 0,
          files: [],
          source: 'rest',
          policy: FIDELITY_POLICY,
          ops: withComments(REST_OPS.map((name) => ({ name, mutates: false, source: 'rest' }))),
          refuses: { ...REST_REFUSALS, ...COMMENT_REFUSALS, ...HISTORY_REFUSALS },
          token: Boolean(figmaToken()),
        },
      }
    }
    const files = roster().map((plugin) => ({ ...describe(plugin), ops: withComments(plugin.ops || []) }))
    return { code: 200, body: { online: true, count: files.length, policy: FIDELITY_POLICY, files, refuses: { ...COMMENT_REFUSALS, ...HISTORY_REFUSALS } } }
  },

  'GET /skill': async (req, res, url) => {
    /* The paste-once document, as the connected plugin rendered it — markdown, not JSON, so
     * `curl …/skill > SKILL.md` is the whole update procedure an agent needs. */
    const target = url.searchParams.get('target')
    const online = roster().filter((plugin) => plugin.skill)
    let plugin = null
    if (target) {
      const found = resolveTarget(target)
      if (found.error) return { code: 404, body: fail('ambiguous_target', found.error, { files: found.candidates || [] }) }
      plugin = found.plugin
    } else {
      plugin = online[0] || null
    }
    if (!plugin || !plugin.skill) {
      return {
        code: 503,
        body: fail('no_plugin', 'no connected plugin has sent a skill yet — open the plugin and switch the listener on'),
      }
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    res.end(plugin.skill)
    return null
  },

  'POST /call': async (req) => runCall(await readBody(req)),

  /**
   * A batch: many ops, one round trip.
   *
   * Composing a screen is N calls, and until now each one paid a full stdio→HTTP→poll→
   * postMessage→postMessage→HTTP crossing, gave the designer its own ⌘Z entry, and staked its
   * own 180-second bet. Thirty node writes were thirty of each.
   *
   * Run STRICTLY IN ORDER, one at a time. Not an optimisation left on the table: the sandbox
   * does not serialize `handleAgentRequest`, so a parallel batch interleaves inside the plugin,
   * and the module-level state the ops share (`loading.ts`'s pending list, `ui-post.ts`'s
   * recorders) is then attributed to whichever call happens to finish first. A batch that builds
   * a screen also means its order.
   *
   * Stops at the first failure unless `continueOnError` is set. A batch that keeps writing after
   * step three refused leaves a half-built screen nobody asked for, and the answer always says
   * how far it got.
   */
  'POST /calls': async (req) => {
    const body = await readBody(req)
    const calls = Array.isArray(body.calls) ? body.calls : null
    if (!calls) return { code: 400, body: fail('bad_request', 'missing "calls" — an array of { op, params }') }
    if (calls.length === 0) return { code: 400, body: fail('bad_request', '"calls" is empty') }
    if (calls.length > MAX_BATCH) {
      return {
        code: 400,
        body: fail('bad_request', `${calls.length} calls is over the limit of ${MAX_BATCH} — send them in chunks`),
      }
    }

    const results = []
    let failed = null
    for (const entry of calls) {
      // Target and fileKey default to the batch's own, so a caller names the file once.
      const answer = await runCall({
        target: body.target,
        fileKey: body.fileKey,
        ...(entry && typeof entry === 'object' ? entry : {}),
      })
      results.push({ op: (entry && entry.op) || null, ...answer.body })
      if (!answer.body.ok) {
        failed = results.length - 1
        if (body.continueOnError !== true) break
      }
    }

    const ok = results.every((result) => result.ok)
    return {
      code: 200,
      body: {
        // `ok` is the batch's own verdict; every entry carries its own. A 200 here means the
        // batch was RUN, not that it succeeded — the per-entry `ok` is the answer to that, and
        // collapsing the two would lose which call broke.
        ok,
        batch: true,
        ran: results.length,
        of: calls.length,
        ...(failed !== null ? { failedAt: failed } : {}),
        results,
      },
    }
  },

  /* ---- live browser client ---- */

  'GET /mirror/status': async () => ({
    code: 200,
    body: {
      ok: true,
      count: mirrorRoster().length,
      files: mirrorRoster().map((plugin) => ({
        ...describeMirror(plugin),
        url: `http://${HOST}:${PORT}/ui?target=${encodeURIComponent(plugin.handle)}`,
      })),
    },
  }),

  'POST /mirror/plugin/hello': async (req) => {
    const body = await readBody(req)
    const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : ''
    if (!clientId) return { code: 400, body: fail('bad_request', 'missing mirror clientId') }
    const file = typeof body.file === 'string' ? body.file : null
    let plugin = mirrorPlugins.get(clientId)
    if (!plugin) {
      plugin = {
        clientId,
        handle: mintMirrorHandle(file),
        file,
        source: '',
        lastSeen: Date.now(),
        commands: [],
        poller: null,
        events: [],
        nextSeq: 1,
        generation: crypto.randomUUID(),
        viewers: new Set(),
        viewerSeen: 0,
        viewerAnnounced: false,
        controller: null,
      }
      mirrorPlugins.set(clientId, plugin)
    }
    plugin.file = file
    plugin.lastSeen = Date.now()
    if (typeof body.source === 'string' && body.source.includes('<html')) plugin.source = body.source
    const watched = mirrorIsWatched(plugin)
    if (Array.isArray(body.snapshot) && watched) {
      for (const message of body.snapshot) {
        if (message && typeof message === 'object') appendMirrorEvent(plugin, message)
      }
    }
    console.log(new Date().toISOString(), `~ browser mirror "${plugin.file}" (${plugin.handle})`)
    return {
      code: 200,
      body: {
        ok: true,
        handle: plugin.handle,
        pollHoldMs: POLL_HOLD_MS,
        watched,
        url: `http://${HOST}:${PORT}/ui?target=${encodeURIComponent(plugin.handle)}`,
      },
    }
  },

  'GET /mirror/plugin/poll': async (req, res, url) => {
    const plugin = mirrorPlugins.get(url.searchParams.get('clientId'))
    if (!plugin) return { code: 409, body: fail('disconnected', 'unknown browser mirror client') }
    plugin.lastSeen = Date.now()
    const idle = url.searchParams.get('idle') === '1'
    const watched = mirrorIsWatched(plugin)
    if (!watched) plugin.viewerAnnounced = false
    if (plugin.poller) {
      clearTimeout(plugin.poller.timer)
      send(plugin.poller.res, 200, { ok: true, watched, commands: [] })
      plugin.poller = null
    }
    if (plugin.commands.length > 0) {
      return { code: 200, body: { ok: true, watched, commands: plugin.commands.splice(0, plugin.commands.length) } }
    }
    if (idle && !watched) return { code: 200, body: { ok: true, watched: false, commands: [] } }
    if (idle && watched && !plugin.viewerAnnounced) {
      plugin.viewerAnnounced = true
      return { code: 200, body: { ok: true, watched: true, commands: [] } }
    }
    const timer = setTimeout(() => {
      plugin.poller = null
      send(res, 200, { ok: true, watched: mirrorIsWatched(plugin), commands: [] })
    }, POLL_HOLD_MS)
    plugin.poller = { res, timer }
    res.on('close', () => {
      if (plugin.poller?.res === res) {
        clearTimeout(timer)
        plugin.poller = null
      }
    })
    return null
  },

  'POST /mirror/plugin/event': async (req) => {
    const body = await readBody(req)
    const plugin = mirrorPlugins.get(body.clientId)
    if (!plugin) return { code: 409, body: fail('disconnected', 'unknown browser mirror client') }
    if (!body.message || typeof body.message !== 'object') {
      return { code: 400, body: fail('bad_request', 'mirror event needs a message object') }
    }
    plugin.lastSeen = Date.now()
    appendMirrorEvent(plugin, body.message)
    return { code: 200, body: { ok: true, cursor: plugin.nextSeq - 1 } }
  },

  'POST /mirror/plugin/bye': async (req) => {
    const body = await readBody(req)
    const plugin = mirrorPlugins.get(body.clientId)
    if (plugin) closeMirrorPlugin(plugin, 'the Figma plugin UI disconnected')
    return { code: 200, body: { ok: true } }
  },

  'POST /mirror/command': async (req) => {
    const body = await readBody(req)
    const found = resolveMirrorTarget(body.target)
    if (found.error) {
      return {
        code: mirrorRoster().length === 0 ? 503 : 409,
        body: fail('no_plugin', found.error, { files: found.candidates || [] }),
      }
    }
    const plugin = found.plugin
    plugin.viewerSeen = Date.now()
    const viewerId = typeof body.viewerId === 'string' && body.viewerId ? body.viewerId : ''
    if (!viewerId) return { code: 400, body: fail('bad_request', 'missing browser viewerId') }
    if (!claimMirrorController(plugin, viewerId)) {
      return { code: 409, body: fail('ambiguous_target', 'another browser tab currently controls this plugin UI') }
    }
    if (!body.message || typeof body.message !== 'object') {
      return { code: 400, body: fail('bad_request', 'mirror command needs a message object') }
    }
    const id = crypto.randomUUID()
    plugin.commands.push({ id, message: body.message })
    flushMirrorCommands(plugin)
    return { code: 202, body: { ok: true, id, target: plugin.handle } }
  },

  'GET /mirror/events': async (req, res, url) => {
    const found = resolveMirrorTarget(url.searchParams.get('target'))
    if (found.error) {
      return {
        code: mirrorRoster().length === 0 ? 503 : 409,
        body: fail('no_plugin', found.error, { files: found.candidates || [] }),
      }
    }
    const plugin = found.plugin
    plugin.viewerSeen = Date.now()
    let cursor = Math.max(0, Number(url.searchParams.get('cursor')) || 0)
    if (url.searchParams.get('generation') !== plugin.generation) cursor = 0
    const viewerId = url.searchParams.get('viewerId') || ''
    if (plugin.controller?.viewerId === viewerId) plugin.controller.lastSeen = Date.now()
    if (mirrorEventsAfter(plugin, cursor).length > 0) {
      return { code: 200, body: mirrorEventBody(plugin, cursor) }
    }
    const viewer = { res, cursor, timer: null }
    viewer.timer = setTimeout(() => {
      plugin.viewers.delete(viewer)
      send(res, 200, mirrorEventBody(plugin, cursor))
    }, POLL_HOLD_MS)
    plugin.viewers.add(viewer)
    res.on('close', () => {
      clearTimeout(viewer.timer)
      plugin.viewers.delete(viewer)
    })
    return null
  },

  /* ---- plugin side ---- */

  'POST /plugin/hello': async (req) => {
    const body = await readBody(req)
    const file = typeof body.file === 'string' ? body.file : null
    const desktopKey = typeof body.fileKey === 'string' && body.fileKey
      ? { key: body.fileKey, via: 'plugin', candidates: [] }
      : await desktopKeyFor(file, body.pages)
    // A plugin too old to send one still connects; it just cannot be recognised across a
    // reconnect, which is exactly the behaviour it had before clientId existed.
    const session = typeof body.clientId === 'string' && body.clientId ? body.clientId : crypto.randomUUID()

    const known = plugins.get(session)
    if (known) {
      /* The same window saying hello again. Its handle is kept — an agent may have it in a
       * command line already — but anything parked or queued belongs to the connection that
       * just ended, so it is failed now rather than left to time out sixty seconds from here. */
      if (known.poller) {
        clearTimeout(known.poller.timer)
        send(known.poller.res, 200, { requests: [] })
        known.poller = null
      }
      if (known.ws && !known.ws.closed) known.ws.close(1012, 'plugin reconnected')
      known.ws = null
      failPending(known, `"${known.handle}" reconnected mid-call`, 'reconnected')
      known.file = file
      known.fileKey = desktopKey.key || null
      known.fileKeyVia = desktopKey.via || null
      known.fileKeyCandidates = desktopKey.candidates
      known.ops = Array.isArray(body.ops) ? body.ops : []
      known.skill = typeof body.skill === 'string' ? body.skill : known.skill ?? null
      known.gates = { read: body.gates?.read === true, write: body.gates?.write === true }
      known.expects = typeof body.bridgeFingerprint === 'string' ? body.bridgeFingerprint : null
      known.lastSeen = Date.now()
      console.log(
        new Date().toISOString(),
        `= "${known.file}" (${known.handle}) — reconnected ·`,
        `read=${known.gates.read} write=${known.gates.write} · ${roster().length} connected`
      )
      warnIfStale(known)
      installSkill(known)
      return {
        code: 200,
        body: { ok: true, session, handle: known.handle, pollHoldMs: POLL_HOLD_MS, ws: '/plugin/ws', bridgeFingerprint: BRIDGE_FINGERPRINT },
      }
    }

    const plugin = {
      session,
      handle: mintHandle(file),
      file,
      fileKey: desktopKey.key || null,
      fileKeyVia: desktopKey.via || null,
      fileKeyCandidates: desktopKey.candidates,
      ops: Array.isArray(body.ops) ? body.ops : [],
      skill: typeof body.skill === 'string' ? body.skill : null,
      gates: { read: body.gates?.read === true, write: body.gates?.write === true },
      expects: typeof body.bridgeFingerprint === 'string' ? body.bridgeFingerprint : null,
      lastSeen: Date.now(),
      poller: null,
      ws: null,
      queue: [],
    }
    plugins.set(session, plugin)
    console.log(
      new Date().toISOString(),
      `+ "${plugin.file}" (${plugin.handle}) — ${plugin.ops.length} ops ·`,
      `read=${plugin.gates.read} write=${plugin.gates.write} · ${roster().length} connected`
    )
    warnIfStale(plugin)
    installSkill(plugin)
    return {
      code: 200,
      body: { ok: true, session, handle: plugin.handle, pollHoldMs: POLL_HOLD_MS, ws: '/plugin/ws', bridgeFingerprint: BRIDGE_FINGERPRINT },
    }
  },

  'GET /plugin/poll': async (req, res, url) => {
    const plugin = plugins.get(url.searchParams.get('session'))
    /* Unknown session means this bridge never said hello to that window — it restarted, or the
     * plugin is holding an id from a previous run. Telling it to reconnect is what makes a
     * bridge restart recoverable without the designer touching anything. */
    if (!plugin) return { code: 409, body: { ...fail('disconnected', 'unknown session — say hello again'), reconnect: true } }
    plugin.lastSeen = Date.now()

    // One poll at a time per plugin. A second one (a reloaded window) retires the first.
    if (plugin.poller) {
      clearTimeout(plugin.poller.timer)
      send(plugin.poller.res, 200, { requests: [] })
      plugin.poller = null
    }

    if (plugin.queue.length > 0) {
      return { code: 200, body: { requests: plugin.queue.splice(0, plugin.queue.length) } }
    }

    const timer = setTimeout(() => {
      plugin.poller = null
      send(res, 200, { requests: [] })
    }, POLL_HOLD_MS)
    plugin.poller = { res, timer }
    res.on('close', () => {
      if (plugin.poller && plugin.poller.res === res) {
        clearTimeout(timer)
        plugin.poller = null
      }
    })
    return null
  },

  'POST /plugin/result': async (req) => {
    const body = await readBody(req)
    return { code: 200, body: await acceptPluginResult(body, plugins.get(body.session)) }
  },

  'POST /plugin/gates': async (req) => {
    const body = await readBody(req)
    const plugin = plugins.get(body.session)
    if (!plugin) return { code: 409, body: { ...fail('disconnected', 'unknown session'), reconnect: true } }
    plugin.lastSeen = Date.now()
    plugin.gates = { read: body.read === true, write: body.write === true }
    if (!plugin.gates.read && !plugin.gates.write) {
      failPending(plugin, 'the designer turned that file\'s agent listener off', 'listener_off')
      if (plugin.ws && !plugin.ws.closed) plugin.ws.close(1000, 'listener off')
      plugins.delete(plugin.session)
      console.log(new Date().toISOString(), `- "${plugin.file}" (${plugin.handle}) — listener off · ${roster().length} connected`)
      return { code: 200, body: { ok: true, disconnected: true } }
    }
    console.log(
      new Date().toISOString(),
      `${plugin.handle} — read=${plugin.gates.read} write=${plugin.gates.write}`
    )
    return { code: 200, body: { ok: true } }
  },
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  /**
   * The plugin UI is a null-origin iframe, so pairing needs an explicit `null` CORS grant.
   * A wildcard would let any ordinary web origin read the one-shot secret during the five-minute
   * window. Requests without an Origin remain available to local CLI clients; browser origins
   * other than `null` are rejected below before the secret is returned.
   *
   * Chromium may preflight loopback as a Private Network Access request. Answer that preflight
   * only for the same null origin, otherwise the click reaches the bridge but surfaces in the
   * plugin as the unhelpful `Failed to fetch`.
   */
  const origin = req.headers.origin
  if (route === '/pair') {
    if (origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null')
      res.setHeader('Vary', 'Origin')
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
      }
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-allcrew-channel-secret')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (route === '/' || route === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'allcrew-channel-bridge',
      online: roster().length > 0,
      files: roster().length,
      mirrors: mirrorRoster().length,
      browserUrl: mirrorRoster().length === 1 ? `http://${HOST}:${PORT}/ui` : null,
      pairing: pairingOpen(),
    })
  }

  if (route === '/ui') {
    if (req.method !== 'GET') return send(res, 405, fail('no_route', 'GET only'))
    if (!isLoopback(req)) return send(res, 403, fail('unauthorized', 'browser mirror UI is loopback-only'))
    const target = url.searchParams.get('target')
    const online = mirrorRoster()
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    if (online.length === 0) {
      res.writeHead(503)
      res.end(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">' +
          '<title>AllCrew Figma Workspace mirror</title><style>body{margin:0;padding:32px;background:#000;color:#f6f6f6;' +
          'font:13px system-ui}code{color:#ffac8b}</style><h1>Waiting for Figma…</h1>' +
          '<p>Open the plugin, pair it with this bridge, then enable <code>Browser UI mirror</code>.</p>'
      )
      return
    }
    if (!target && online.length > 1) {
      const escape = (value) =>
        String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      const links = online
        .map(
          (plugin) =>
            `<li><a href="/ui?target=${encodeURIComponent(plugin.handle)}">${escape(plugin.file || plugin.handle)}</a></li>`
        )
        .join('')
      res.writeHead(200)
      res.end(
        '<!doctype html><meta charset="utf-8"><title>AllCrew Figma Workspace mirrors</title>' +
          '<style>body{margin:0;padding:32px;background:#000;color:#f6f6f6;font:13px system-ui}' +
          'a{color:#ff895b}li{margin:10px 0}</style><h1>Choose a Figma file</h1><ul>' + links + '</ul>'
      )
      return
    }
    const found = resolveMirrorTarget(target)
    if (found.error || !found.plugin.source) {
      res.writeHead(503)
      res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><p>Mirror source is not ready.</p>')
      return
    }
    res.writeHead(200)
    res.end(mirrorPage(found.plugin))
    return
  }

  // Ahead of the secret gate on purpose: this is how a plugin gets the secret at all.
  if (route === '/pair') {
    if (req.method !== 'POST') return send(res, 405, fail('no_route', 'POST only'))
    if (origin && origin !== 'null') {
      return send(res, 403, fail('unauthorized', 'pairing is available only to the Figma plugin or a local client'))
    }
    if (!isLoopback(req)) return send(res, 403, fail('unauthorized', 'pairing is loopback-only'))
    if (!pairingOpen()) {
      return send(
        res,
        403,
        fail(
          'unauthorized',
          'pairing window is closed — restart the bridge (or run it with --pair) and pair within 5 minutes'
        )
      )
    }
    pairOpenUntil = 0 // one-shot: the first plugin to ask closes the window behind itself
    console.log(new Date().toISOString(), 'paired — secret handed to the plugin, window closed')
    return send(res, 200, { ok: true, secret: SECRET })
  }

  if (!safeEqual(req.headers['x-allcrew-channel-secret'], SECRET)) {
    return send(res, 401, fail('unauthorized', 'bad or missing x-allcrew-channel-secret'))
  }

  const handler = ROUTES[`${req.method} ${route}`]
  if (!handler) return send(res, 404, fail('no_route', `no route for ${req.method} ${route}`))

  try {
    const answer = await handler(req, res, url)
    if (answer) send(res, answer.code, answer.body)
  } catch (err) {
    const message = (err && err.message) || String(err)
    console.error(new Date().toISOString(), 'ERROR —', message)
    // A body over the cap is the caller's size problem, not a bridge fault, and retrying the
    // same call produces the same bytes — so it is named rather than filed under "internal".
    const code = /payload too large/i.test(message)
      ? 'payload_too_large'
      : /not valid JSON/i.test(message)
        ? 'bad_request'
        : 'internal'
    if (!res.headersSent) send(res, code === 'payload_too_large' ? 413 : 500, fail(code, message))
  }
})

function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify(fail(status === 401 ? 'unauthorized' : 'disconnected', message))
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict'}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  )
  socket.destroy()
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  if (url.pathname !== '/plugin/ws') return rejectUpgrade(socket, 409, 'unknown WebSocket route')
  if (!isLoopback(req)) return rejectUpgrade(socket, 403, 'WebSocket transport is loopback-only')
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') {
    return rejectUpgrade(socket, 403, 'WebSocket transport accepts only the Figma null origin or a local client')
  }
  if (!safeEqual(url.searchParams.get('secret'), SECRET)) return rejectUpgrade(socket, 401, 'bad WebSocket secret')
  const plugin = plugins.get(url.searchParams.get('session'))
  if (!plugin) return rejectUpgrade(socket, 409, 'unknown session')
  if (plugin.ws && !plugin.ws.closed) plugin.ws.close(1012, 'replaced by a newer socket')
  if (plugin.poller) {
    clearTimeout(plugin.poller.timer)
    send(plugin.poller.res, 200, { requests: [] })
    plugin.poller = null
  }
  let peer
  try {
    peer = acceptWebSocket(req, socket, head, {
      onMessage(message) {
        if (!message || message.type !== 'result' || !message.body || typeof message.body !== 'object') {
          peer.close(1003, 'expected {type:\"result\",body}')
          return
        }
        void acceptPluginResult(message.body, plugin)
      },
      onPong() { plugin.lastSeen = Date.now() },
      onClose() { if (plugin.ws === peer) plugin.ws = null },
    })
  } catch (error) {
    return rejectUpgrade(socket, 409, error.message)
  }
  plugin.ws = peer
  plugin.lastSeen = Date.now()
  flush(plugin)
})

// A dropped poll is how we learn a plugin closed; nothing else notices.
setInterval(() => {
  for (const plugin of [...plugins.values()]) {
    if (isOnline(plugin)) continue
    failPending(plugin, `"${plugin.handle}" disconnected`, 'disconnected')
    plugins.delete(plugin.session)
    console.log(new Date().toISOString(), `- "${plugin.file}" (${plugin.handle}) — gone · ${roster().length} connected`)
    if (plugin.ws && !plugin.ws.closed) plugin.ws.close(1001, 'plugin timed out')
  }
  for (const plugin of [...mirrorPlugins.values()]) {
    if (mirrorIsOnline(plugin)) continue
    closeMirrorPlugin(plugin, 'the Figma plugin UI stopped polling')
    console.log(new Date().toISOString(), `- browser mirror "${plugin.file}" (${plugin.handle}) — gone`)
  }
}, 5_000).unref()

setInterval(() => {
  for (const plugin of plugins.values()) {
    if (plugin.ws && !plugin.ws.closed) plugin.ws.ping('allcrew')
  }
}, 20_000).unref()

/* Started only when this file is what was run. Imported — by a test, or by a wrapper that
 * wants the REST helpers — it defines everything and listens on nothing: a second process
 * binding 8788 would take the port away from the bridge the plugin is already talking to. */
const RUN_AS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (RUN_AS_MAIN) server.listen(PORT, HOST, () => {
  console.log(`AllCrew Figma Workspace listening on http://${HOST}:${PORT}`)
  const where =
    SECRET_SOURCE === 'env'
      ? 'ALLCREW_CHANNEL_AGENT_SECRET (yours to manage)'
      : `${SECRET_FILE} (${SECRET_SOURCE === 'minted' ? 'just created' : 'existing'})`
  console.log(`  secret: ${where}`)
  console.log('  agents read it with:  -H "x-allcrew-channel-secret: $(cat ' + SECRET_FILE + ')"')
  console.log(`  live browser UI:       http://${HOST}:${PORT}/ui`)
  if (SKILL_TARGETS.length > 0) console.log('  skill auto-install:   ' + SKILL_TARGETS.join(', '))
  if (pairingOpen()) {
    console.log(`  pairing OPEN for ${PAIR_WINDOW_MS / 60000} min — press "Pair with bridge" in the plugin now.`)
  } else {
    console.log('  pairing closed (secret came from the environment) — restart with --pair to open it.')
  }
  if (CALL_TIMEOUT_MS > CLIENT_CEILING_MS) {
    console.log(
      `  NOTE: call ceiling is ${Math.round(CALL_TIMEOUT_MS / 1000)}s, but Node's fetch drops a request after ` +
        `${CLIENT_CEILING_MS / 1000}s — the extra window only exists for clients that set their own dispatcher.`
    )
  }
  console.log('  open the plugin in as many files as you want — each one registers separately.')
  if (figmaToken()) {
    console.log('  figma REST:           token found — reads answer even with no plugin open (source: "rest")')
  }
})
