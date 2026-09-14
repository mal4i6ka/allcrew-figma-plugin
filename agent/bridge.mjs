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
/**
 * What a plain `fetch` client will wait, whatever this bridge promises.
 *
 * Node's own `fetch` (undici) drops a request whose headers have not arrived in five minutes,
 * and it does it without a word from the server. So raising `ALTERY_AGENT_CALL_TIMEOUT_MS` past
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
          `no answer from "${plugin.handle}" within ${CALL_TIMEOUT_MS / 1000}s (the bridge ceiling). ` +
          'If the file is big and the page was cold, this is Figma loading it: while that runs, the ' +
          'plugin\'s own budgets cannot fire either, because nothing in the sandbox gets a turn. The ' +
          'load continues after this call dies, so the same call often answers at once on a retry' +
          (CALL_TIMEOUT_MS >= CLIENT_CEILING_MS
            ? ' — raising it further will not help: a plain fetch client gives up at ' +
              `${CLIENT_CEILING_MS / 1000}s. Narrow the scope, or use the op's own paging (limit/offset/budgetMs).`
            : ' — raise it with ALTERY_AGENT_CALL_TIMEOUT_MS, or narrow the scope'),
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

const FIGMA_TOKEN_FILE = process.env.FIGMA_TOKEN_FILE || path.join(os.homedir(), '.altery', 'figma-token')
const DEFAULT_FILE_KEY = process.env.ALTERY_FIGMA_FILE_KEY || ''

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

/** A file key out of whatever the caller typed: the key itself, a Figma URL, or `rest:<key>`. */
export function fileKeyOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const prefixed = text.startsWith('rest:') ? text.slice(5) : text
  const url = prefixed.match(/figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/)
  if (url) return url[1]
  return /^[A-Za-z0-9]{10,}$/.test(prefixed) ? prefixed : ''
}

/** True when this call is addressed at REST rather than at an open plugin. */
export function wantsRest(body, anyPluginOnline) {
  if (body && typeof body.fileKey === 'string' && fileKeyOf(body.fileKey)) return true
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

async function restFetch(route) {
  const token = figmaToken()
  if (!token) {
    throw new Error(
      `no Figma token — put one in ${FIGMA_TOKEN_FILE} or FIGMA_TOKEN (figma.com/developers/api#access-tokens)`
    )
  }
  const response = await fetch(`https://api.figma.com${route}`, { headers: { 'X-Figma-Token': token } })
  if (!response.ok) throw new Error(`Figma REST ${response.status} on ${route}`)
  return response.json()
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
export function restNodeSummary(node) {
  if (!node) return null
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
      ? node.children.map((child) => ({ id: child.id, name: child.name, type: child.type }))
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
    const file = await restFetch(`/v1/files/${key}?depth=2`)
    const pages = file.document?.children || []
    const page = params.pageId ? pages.find((entry) => entry.id === params.pageId) : pages[0]
    if (!page) throw new Error(`no page ${params.pageId} in this file`)
    return {
      page: { id: page.id, name: page.name },
      frames: (page.children || []).map(restNodeSummary),
    }
  }

  if (op === 'node.get') {
    const ids = encodeURIComponent(String(params.nodeId || ''))
    if (!ids) throw new Error('nodeId is required')
    const answer = await restFetch(`/v1/files/${key}/nodes?ids=${ids}&depth=${Number(params.depth) || 1}`)
    const entry = Object.values(answer.nodes || {})[0]
    if (!entry) throw new Error(`no node ${params.nodeId} in this file`)
    return restNodeSummary(entry.document)
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
    const target = url.searchParams.get('target')
    if (target) {
      const found = resolveTarget(target)
      if (found.error) return { code: 404, body: { ok: false, error: found.error, files: found.candidates || [] } }
      return { code: 200, body: { ...describe(found.plugin), ops: found.plugin.ops } }
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
          ops: REST_OPS.map((name) => ({ name, mutates: false, source: 'rest' })),
          refuses: REST_REFUSALS,
          token: Boolean(figmaToken()),
        },
      }
    }
    const files = roster().map((plugin) => ({ ...describe(plugin), ops: plugin.ops }))
    return { code: 200, body: { online: true, count: files.length, files } }
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

    /* REST before the roster: either the caller addressed a file key outright, or nothing is
     * open and a default key is configured. The answer is marked `source: "rest"` — an agent
     * that cannot tell which half answered cannot tell a thin answer from a complete one. */
    if (wantsRest(body, roster().length > 0)) {
      const key = fileKeyOf(body.fileKey || body.target) || DEFAULT_FILE_KEY
      if (!key) {
        return {
          code: 400,
          body: { ok: false, error: 'no file key — pass fileKey (or target "rest:<key>"), or set ALTERY_FIGMA_FILE_KEY' },
        }
      }
      try {
        const result = await restCall(op, body.params || {}, key)
        return { code: 200, body: { ok: true, op, source: 'rest', fileKey: key, result } }
      } catch (err) {
        return { code: 400, body: { ok: false, op, source: 'rest', fileKey: key, error: (err && err.message) || String(err) } }
      }
    }

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

/* Started only when this file is what was run. Imported — by a test, or by a wrapper that
 * wants the REST helpers — it defines everything and listens on nothing: a second process
 * binding 8788 would take the port away from the bridge the plugin is already talking to. */
const RUN_AS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (RUN_AS_MAIN) server.listen(PORT, HOST, () => {
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
