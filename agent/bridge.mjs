#!/usr/bin/env node
/*
 * Altery agent bridge — the local relay between a CLI agent and the running Figma plugins.
 *
 * Figma plugins cannot be reached from outside: the sandbox has no listening socket, and
 * there is no headless mode. So each plugin dials *out* — its UI long-polls this process —
 * and this process gives a CLI something conventional to talk to:
 *
 *     agent (Claude Code, curl, anything)          plugin (UI iframe → sandbox)
 *        │  POST /call {op, params, target}           │
 *        ▼                                            │ GET /plugin/poll  (parked ~25s)
 *      bridge ──────── hands the request over ────────┤
 *        │                                            │ POST /plugin/result
 *        ◄──────────── answers the waiting call ──────┘
 *
 * MANY plugins, not one. A design system lives in one file and is consumed in others, so the
 * questions worth asking are usually cross-file: which components are actually instantiated,
 * what a token change did downstream, where the raw colours are. Figma gives a plugin only a
 * published-library view of its neighbours; two plugin windows on one bridge give an agent the
 * full op surface against both documents at once, which no Figma API offers.
 *
 * Every connection therefore gets its own registry entry, its own parked poll and its own
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
 *                             this port and knows the secret can read every connected file.
 *   ALTERY_AGENT_CALL_TIMEOUT_MS  how long one call may take (default 180000)
 *   ALTERY_AGENT_FILES        where ops that return files write them
 *                             (default ~/.altery/agent-files)
 *   ALTERY_AGENT_SKILL_FILE   comma-separated paths --install-skill writes the skill to
 *                             (default: ~/.claude/skills/altery-figma-listener/SKILL.md for
 *                             Claude Code, plus the agent-neutral ~/.altery/SKILL.md — point
 *                             any other agent's standing-instructions mechanism at that one)
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A fingerprint of this file, so a stale bridge announces itself instead of behaving subtly
 * differently. The plugin carries the exact source it was built against (build.mjs inlines
 * `agent/bridge.mjs` into ui.html), so it can fingerprint that and compare — no version
 * constant for anyone to forget to bump, and no false alarm from a whitespace-identical copy.
 * FNV-1a rather than a real digest: this detects change, it does not defend against anyone.
 */
export function fingerprint(source) {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const BRIDGE_FINGERPRINT = (() => {
  try {
    return fingerprint(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))
  } catch {
    return null
  }
})()

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

/**
 * Opt-in auto-install of the paste-once skill. The plugin sends its rendered skill text with
 * every hello; with this enabled the bridge keeps a copy on disk, so "teach the agent" happens
 * zero times instead of once and never goes stale. Opt-in on purpose: this file becomes
 * standing instructions for whatever agent reads it, and silently (re)writing those is a trust
 * decision the person at the keyboard should make, not a default they discover.
 */
const SKILL_TARGETS = (() => {
  const flag = process.argv.find((arg) => arg === '--install-skill' || arg.startsWith('--install-skill='))
  const env = process.env.ALTERY_AGENT_SKILL_FILE
  if (!flag && !env) return []
  const listed = (flag && flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : env || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (listed.length > 0) return listed
  /* Two defaults on purpose. The first is where Claude Code reads user-level skills. The second
   * is agent-neutral: every other CLI has its own idea of standing instructions (AGENTS.md,
   * rules files, config dirs), and chasing them all is a losing game — so the bridge maintains
   * ONE canonical copy at a stable path and any agent gets pointed at it, or at GET /skill. */
  return [
    path.join(os.homedir(), '.claude', 'skills', 'altery-figma-listener', 'SKILL.md'),
    path.join(os.homedir(), '.altery', 'SKILL.md'),
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
const CALL_TIMEOUT_MS = Math.max(5_000, Number(process.env.ALTERY_AGENT_CALL_TIMEOUT_MS) || 180_000)
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
        'no plugin connected — open the Altery plugin in Figma and turn on Settings → Agent listener → Allow reads',
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

/** Hands everything queued for one plugin to its parked poll, if both exist. */
function flush(plugin) {
  if (!plugin.poller || plugin.queue.length === 0) return
  const { res, timer } = plugin.poller
  plugin.poller = null
  clearTimeout(timer)
  send(res, 200, { requests: plugin.queue.splice(0, plugin.queue.length) })
}

/** Fails every in-flight call for one plugin — used when it disappears mid-request. */
function failPending(plugin, reason) {
  for (const [id, entry] of pending) {
    if (entry.session !== plugin.session) continue
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, error: reason })
    pending.delete(id)
  }
  plugin.queue.length = 0
}

/* ------------------------------------------------------------------- files */

const FILES_DIR = process.env.ALTERY_AGENT_FILES || path.join(os.homedir(), '.altery', 'agent-files')
/** Directories kept before the oldest are swept. A screenshot is worth having until the next
 * few; keeping every one forever turns a debugging session into a disk leak. */
const KEEP_RUNS = 40

/** Only ever a basename, only ever these characters — the sandbox proposes a name, this
 * decides whether it may become a path. */
function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(name) && !name.startsWith('.')
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
 * Walks a result and turns every `{ __alteryFile: … }` into the path it was written to. The
 * sandbox has no filesystem and the agent has no way into the sandbox, so this is the only
 * place bytes can become a file — and doing it here is what keeps a base64 PNG out of the
 * agent's context, which is the whole reason ops hand back files instead of payloads.
 */
function materialiseFiles(value, dir, written) {
  if (Array.isArray(value)) return value.map((entry) => materialiseFiles(entry, dir, written))
  if (typeof value !== 'object' || value === null) return value

  const envelope = value.__alteryFile
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
      resolve({
        ok: false,
        error:
          `no answer from "${plugin.handle}" within ${CALL_TIMEOUT_MS / 1000}s ` +
          '(the bridge ceiling — raise it with ALTERY_AGENT_CALL_TIMEOUT_MS, or narrow the scope)',
      })
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
      },
    }
  },

  'GET /ops': async (req, res, url) => {
    const target = url.searchParams.get('target')
    if (target) {
      const found = resolveTarget(target)
      if (found.error) return { code: 404, body: { ok: false, error: found.error, files: found.candidates || [] } }
      return { code: 200, body: { ...describe(found.plugin), ops: found.plugin.ops } }
    }
    const files = roster().map((plugin) => ({ ...describe(plugin), ops: plugin.ops }))
    return { code: 200, body: { online: files.length > 0, count: files.length, files } }
  },

  'GET /skill': async (req, res, url) => {
    /* The paste-once document, as the connected plugin rendered it — markdown, not JSON, so
     * `curl …/skill > SKILL.md` is the whole update procedure an agent needs. */
    const target = url.searchParams.get('target')
    const online = roster().filter((plugin) => plugin.skill)
    let plugin = null
    if (target) {
      const found = resolveTarget(target)
      if (found.error) return { code: 404, body: { ok: false, error: found.error, files: found.candidates || [] } }
      plugin = found.plugin
    } else {
      plugin = online[0] || null
    }
    if (!plugin || !plugin.skill) {
      return { code: 503, body: { ok: false, error: 'no connected plugin has sent a skill yet — open the plugin and switch the listener on' } }
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    res.end(plugin.skill)
    return null
  },

  'POST /call': async (req) => {
    const body = await readBody(req)
    const op = typeof body.op === 'string' ? body.op : ''
    if (!op) return { code: 400, body: { ok: false, error: 'missing "op"' } }

    /* Broadcast: one question, every connected file, one answer each. This is the whole point
     * of holding a registry — "which of my open files still paints raw hexes" is one call.
     * Reads only: writing the same thing into every open document is never what someone meant
     * to type, so it is refused rather than confirmed. */
    if (body.target === '*') {
      const online = roster()
      if (online.length === 0) return { code: 503, body: { ok: false, error: 'no plugin connected' } }
      const mutating = online.filter((plugin) => opIsMutating(plugin, op))
      if (mutating.length > 0) {
        return {
          code: 400,
          body: {
            ok: false,
            error: `"${op}" writes to the document — a broadcast write is refused. Name one target instead.`,
            files: online.map(describe),
          },
        }
      }
      /* One schema check against the first plugin that publishes one: a broadcast is the same
       * call to every file, so a bad parameter is bad everywhere, and finding that out once is
       * better than finding it out per file. */
      const spec = online.map((plugin) => opEntry(plugin, op)).find((found) => found && found.params)
      const wrong = checkParams(spec, body.params)
      if (wrong.length > 0) {
        return { code: 400, body: { ok: false, op, error: wrong.join('; '), problems: wrong } }
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
      return { code: roster().length === 0 ? 503 : 409, body: { ok: false, error: found.error, files: found.candidates || [] } }
    }

    const plugin = found.plugin

    /* Checked against the schema of the plugin that will actually run it, not a shared idea of
     * the op: two connected files can be running different builds, and the one being addressed
     * is the only one whose contract matters here. */
    const wrong = checkParams(opEntry(plugin, op), body.params)
    if (wrong.length > 0) {
      return {
        code: 400,
        body: { ok: false, op, file: plugin.file, handle: plugin.handle, error: wrong.join('; '), problems: wrong },
      }
    }

    const answer = await dispatch(plugin, op, body.params)
    /* The answer always names the file it came from. An agent that cannot see which document
     * replied cannot tell a right answer from a right-looking one. */
    return {
      code: answer.ok ? 200 : 400,
      body: { ok: answer.ok, op, file: plugin.file, handle: plugin.handle, ...(answer.ok ? { result: answer.result } : { error: answer.error }) },
    }
  },

  /* ---- plugin side ---- */

  'POST /plugin/hello': async (req) => {
    const body = await readBody(req)
    const file = typeof body.file === 'string' ? body.file : null
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
      failPending(known, `"${known.handle}" reconnected mid-call`)
      known.file = file
      known.fileKey = typeof body.fileKey === 'string' ? body.fileKey : null
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
        body: { ok: true, session, handle: known.handle, pollHoldMs: POLL_HOLD_MS, bridgeFingerprint: BRIDGE_FINGERPRINT },
      }
    }

    const plugin = {
      session,
      handle: mintHandle(file),
      file,
      fileKey: typeof body.fileKey === 'string' ? body.fileKey : null,
      ops: Array.isArray(body.ops) ? body.ops : [],
      skill: typeof body.skill === 'string' ? body.skill : null,
      gates: { read: body.gates?.read === true, write: body.gates?.write === true },
      expects: typeof body.bridgeFingerprint === 'string' ? body.bridgeFingerprint : null,
      lastSeen: Date.now(),
      poller: null,
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
      body: { ok: true, session, handle: plugin.handle, pollHoldMs: POLL_HOLD_MS, bridgeFingerprint: BRIDGE_FINGERPRINT },
    }
  },

  'GET /plugin/poll': async (req, res, url) => {
    const plugin = plugins.get(url.searchParams.get('session'))
    /* Unknown session means this bridge never said hello to that window — it restarted, or the
     * plugin is holding an id from a previous run. Telling it to reconnect is what makes a
     * bridge restart recoverable without the designer touching anything. */
    if (!plugin) return { code: 409, body: { ok: false, reconnect: true, error: 'unknown session — say hello again' } }
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
    const plugin = plugins.get(body.session)
    if (plugin) plugin.lastSeen = Date.now()
    const entry = pending.get(body.id)
    // No entry means the call already timed out — the plugin answering late is not an error.
    if (!entry) return { code: 200, body: { ok: true, note: 'no caller waiting' } }
    clearTimeout(entry.timer)
    pending.delete(body.id)
    console.log(
      new Date().toISOString(),
      `${plugin ? plugin.handle : '?'} · ${entry.op} — ${body.ok ? 'ok' : 'error: ' + body.error}`,
      `(${Date.now() - entry.startedAt}ms)`
    )
    if (body.ok !== true) {
      entry.resolve({ ok: false, error: body.error || 'unknown error' })
      return { code: 200, body: { ok: true } }
    }
    let result = body.result
    try {
      const written = []
      result = materialiseFiles(result, path.join(FILES_DIR, `${entry.op.replace(/[^a-z0-9.]/gi, '-')}-${body.id.slice(0, 8)}`), written)
      if (written.length > 0) {
        console.log(new Date().toISOString(), `  wrote ${written.length} file${written.length === 1 ? '' : 's'} → ${path.dirname(written[0])}`)
        sweepRuns()
      }
    } catch (err) {
      entry.resolve({ ok: false, error: `could not write the files this op returned: ${err.message}` })
      return { code: 200, body: { ok: true } }
    }
    entry.resolve({ ok: true, result })
    return { code: 200, body: { ok: true } }
  },

  'POST /plugin/gates': async (req) => {
    const body = await readBody(req)
    const plugin = plugins.get(body.session)
    if (!plugin) return { code: 409, body: { ok: false, reconnect: true, error: 'unknown session' } }
    plugin.lastSeen = Date.now()
    plugin.gates = { read: body.read === true, write: body.write === true }
    if (!plugin.gates.read && !plugin.gates.write) {
      failPending(plugin, 'the designer turned that file\'s agent listener off')
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
  // The plugin UI is an iframe on a null origin — it needs CORS to reach loopback at all.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-altery-secret')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  if (route === '/' || route === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'altery-agent-bridge',
      online: roster().length > 0,
      files: roster().length,
      pairing: pairingOpen(),
    })
  }

  // Ahead of the secret gate on purpose: this is how a plugin gets the secret at all.
  if (route === '/pair') {
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

  const handler = ROUTES[`${req.method} ${route}`]
  if (!handler) return send(res, 404, { ok: false, error: `no route for ${req.method} ${route}` })

  try {
    const answer = await handler(req, res, url)
    if (answer) send(res, answer.code, answer.body)
  } catch (err) {
    const message = (err && err.message) || String(err)
    console.error(new Date().toISOString(), 'ERROR —', message)
    if (!res.headersSent) send(res, 500, { ok: false, error: message })
  }
})

// A dropped poll is how we learn a plugin closed; nothing else notices.
setInterval(() => {
  for (const plugin of [...plugins.values()]) {
    if (isOnline(plugin)) continue
    failPending(plugin, `"${plugin.handle}" disconnected`)
    plugins.delete(plugin.session)
    console.log(new Date().toISOString(), `- "${plugin.file}" (${plugin.handle}) — gone · ${roster().length} connected`)
  }
}, 5_000).unref()

server.listen(PORT, HOST, () => {
  console.log(`altery-agent-bridge listening on http://${HOST}:${PORT}`)
  const where =
    SECRET_SOURCE === 'env'
      ? 'ALTERY_AGENT_SECRET (yours to manage)'
      : `${SECRET_FILE} (${SECRET_SOURCE === 'minted' ? 'just created' : 'existing'})`
  console.log(`  secret: ${where}`)
  console.log('  agents read it with:  -H "x-altery-secret: $(cat ' + SECRET_FILE + ')"')
  if (SKILL_TARGETS.length > 0) console.log('  skill auto-install:   ' + SKILL_TARGETS.join(', '))
  if (pairingOpen()) {
    console.log(`  pairing OPEN for ${PAIR_WINDOW_MS / 60000} min — press "Pair with bridge" in the plugin now.`)
  } else {
    console.log('  pairing closed (secret came from the environment) — restart with --pair to open it.')
  }
  console.log('  open the plugin in as many files as you want — each one registers separately.')
})
