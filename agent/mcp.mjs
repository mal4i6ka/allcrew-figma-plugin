#!/usr/bin/env node
/*
 * altery-agent-mcp — an MCP (Model Context Protocol) front for the Altery agent bridge.
 *
 * The bridge already gives a CLI something conventional to talk to (POST /call over loopback).
 * This process gives an *MCP client* — Claude Desktop, Claude Code, Cursor, Codex — the same
 * thing in the one wire format they all already speak, so driving the open Figma file needs no
 * SKILL.md and no `curl`: the client lists tools and calls them like any other server.
 *
 *     MCP client (Claude Desktop, Cursor, …)          plugin (open in Figma)
 *        │  stdio: JSON-RPC (initialize, tools/*)         │
 *        ▼                                                │  GET /plugin/poll (parked ~25s)
 *      mcp.mjs ── POST /call {op, params, target} ──▶ bridge.mjs ──┤
 *        ◄──────────── the op's answer ─────────────────────┘  POST /plugin/result
 *
 * It is a *client* of the bridge, exactly like agent/altery-figma.mjs is — not a replacement.
 * The bridge is what the plugin dials out to and where the read/write gates, the op registry
 * and the file-delivery live; this only translates. So the model is the same one the bridge
 * already has: one bridge per machine, and as many MCP clients as you like, each spawning its
 * own copy of this script and forwarding to that single bridge.
 *
 * Transport: MCP stdio — newline-delimited JSON-RPC on stdin/stdout, one message per line,
 * never an embedded newline (JSON.stringify escapes them). Everything human goes to stderr, so
 * stdout stays a clean protocol stream.
 *
 * Configure it in an MCP client (path is this file, wherever it was saved):
 *
 *     { "mcpServers": { "altery-figma": { "command": "node",
 *                                         "args": ["/abs/path/to/mcp.mjs"] } } }
 *
 * Environment (shared with agent/altery-figma.mjs, so a machine that ran the bridge needs no
 * setup):
 *   ALTERY_AGENT_URL          default http://127.0.0.1:8788
 *   ALTERY_AGENT_SECRET       optional — else the file the bridge minted
 *   ALTERY_AGENT_SECRET_FILE  default ~/.altery/agent-secret
 *   ALTERY_AGENT_FILE         optional default target (a handle, part of a name, or "*")
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BASE = (process.env.ALTERY_AGENT_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')
const SECRET_FILE =
  process.env.ALTERY_AGENT_SECRET_FILE || path.join(os.homedir(), '.altery', 'agent-secret')
const DEFAULT_TARGET = process.env.ALTERY_AGENT_FILE || ''

/** The MCP revision we answer with when a client does not pin one of its own. Kept old enough
 * that a client on an older revision still recognises it; a client that sends a newer one gets
 * it echoed back, which is what the spec asks for. */
const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'altery-figma', version: '1.0.0' }

/** Same order the bridge and the CLI resolve in, so none of the three needs configuring on a
 * machine that already has one of the others. */
function resolveSecret() {
  if (process.env.ALTERY_AGENT_SECRET) return process.env.ALTERY_AGENT_SECRET
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}
const SECRET = resolveSecret()

function log(...args) {
  process.stderr.write(args.map(String).join(' ') + '\n')
}

/* ------------------------------------------------------------------ bridge */

/** One request to the bridge. Never throws: a dead bridge or a rejected secret is an answer an
 * agent can act on, not a crash that takes the MCP session down with it. */
async function bridge(method, route, body) {
  let response
  try {
    response = await fetch(BASE + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-altery-secret': SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (err) {
    return {
      ok: false,
      error:
        `cannot reach the Altery bridge at ${BASE} — is it running?  node ~/Downloads/bridge.mjs\n` +
        `(${err.message})`,
    }
  }
  if (response.status === 401) {
    return {
      ok: false,
      error: `the bridge rejected the secret (401) — it is running with a different secret than ${SECRET_FILE} holds. Re-pair, or align ALTERY_AGENT_SECRET.`,
    }
  }
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: `the bridge returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}` }
  }
  return { ok: true, status: response.status, body: parsed }
}

/* --------------------------------------------------------------- tool list */

/** A Figma op name carries a dot (`document.info`); an MCP tool name may not. Map it and keep
 * the way back, so tools/call can recover the op the client actually meant. */
const toolToOp = new Map()
function toolName(op) {
  const name = op.replace(/[^A-Za-z0-9_-]/g, '_')
  toolToOp.set(name, op)
  return name
}

/** The one property every generated tool gains that the op itself does not declare: which of
 * several open files to ask. Optional — the bridge answers an unaddressed call when exactly one
 * file is connected, and refuses it with the roster when more than one is, which is the safety
 * property worth preserving rather than papering over with a guess. */
const TARGET_PROP = {
  type: 'string',
  description:
    "Which connected Figma file to act on — a handle from altery_status, or part of its name. " +
    "Optional when exactly one file is connected. \"*\" asks every file at once (reads only; a broadcast write is refused).",
}

/** The other way to name a file: its key, for when no plugin is open and the bridge answers
 * from Figma's REST API. Reads only, and a thinner answer — REST has no variable bindings, no
 * Motion and no panel commands — but it works at three in the morning. */
const FILE_KEY_PROP = {
  type: 'string',
  description:
    'Figma file key (or a file URL) to read over the REST API when no plugin is open. ' +
    'Answers are marked source: "rest" and cover fewer ops — the bridge says which.',
}

/** ParamSpec (src/agent/protocol.ts) → JSON Schema. Faithful to what the bridge will actually
 * enforce, so a client that respects the schema never sends the bridge something it will reject. */
function paramToSchema(spec) {
  const base = spec.description ? { description: spec.description } : {}
  switch (spec.type) {
    case 'string':
      return { type: 'string', ...base, ...(spec.enum ? { enum: [...spec.enum] } : {}) }
    case 'number':
      return {
        type: 'number',
        ...base,
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
      }
    case 'boolean':
      return { type: 'boolean', ...base }
    case 'string[]':
      return { type: 'array', items: { type: 'string' }, ...base }
    case 'json':
    default:
      // 'json' may be an object or an array; constraining it to one would reject the other.
      // Describe it and let the bridge coerce — it owns the real contract.
      return base
  }
}

/** One op → one tool. The description leads with the op's own summary and, where it has one,
 * the longer `agent` note, because that note is written for exactly this reader. */
function opToTool(op) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(op.params || {})) {
    properties[key] = paramToSchema(spec)
    if (spec.required) required.push(key)
  }
  properties.target = TARGET_PROP
  properties.fileKey = FILE_KEY_PROP
  const description = [op.mutates ? '[writes to the document] ' : '', op.summary || '', op.agent ? '\n\n' + op.agent : '']
    .join('')
    .trim()
  return {
    name: toolName(op.name),
    description: description || op.name,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
  }
}

/** The two tools that do not depend on a connected plugin, so the surface an MCP client caches
 * at startup is never empty even when Figma is not open yet. `altery_call` is also the escape
 * hatch: it reaches any op — including `plugin.call`, the doorway to every panel command — by
 * name, so nothing is unreachable if the typed tool for it is momentarily absent. */
const META_TOOLS = [
  {
    name: 'altery_status',
    description:
      'List the Figma files currently connected through the Altery bridge and what each one allows (read / write). Call this first: the other tools act on one of these files.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'altery_call',
    description:
      'Run any Altery op by name against a connected Figma file — the universal doorway. Prefer the named tool for an op when one is listed; use this for ops not surfaced as their own tool (e.g. plugin.call, which runs a panel command). Discover ops from altery_status → the per-op tools, or by calling plugin.commands through this.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'The op name, e.g. document.info or plugin.call.' },
        params: { type: 'object', description: "The op's parameters, as an object.", additionalProperties: true },
        target: TARGET_PROP,
        fileKey: FILE_KEY_PROP,
      },
      required: ['op'],
    },
  },
]

/** Build the whole tool list: the two meta tools, then one typed tool per op the connected
 * files publish. Ops are unioned by name across files — two files may run different builds, and
 * the `target` argument decides which one a call lands on, so a single tool per name is right. */
async function listTools() {
  const result = await bridge('GET', '/ops')
  // Collect the ops first, then swap the name map in one synchronous step *after* the await —
  // so a tools/call that runs concurrently with a re-list still sees the previous map rather
  // than an empty one cleared at the top.
  const ops = []
  const claimed = new Set()
  if (result.ok && result.body && Array.isArray(result.body.files)) {
    for (const file of result.body.files) {
      for (const op of file.ops || []) {
        if (!op || typeof op.name !== 'string' || claimed.has(op.name)) continue
        claimed.add(op.name)
        ops.push(op)
      }
    }
  }
  // Nothing open: the bridge publishes what Figma's REST API can still answer. A client that
  // listed zero tools would look broken, and an agent would never learn that half the reads
  // are available with no plugin at all — it just has to name a `fileKey`.
  if (ops.length === 0 && result.ok && Array.isArray(result.body?.ops)) {
    for (const op of result.body.ops) {
      if (!op || typeof op.name !== 'string' || claimed.has(op.name)) continue
      claimed.add(op.name)
      ops.push({
        ...op,
        summary: `${op.name} — answered from Figma's REST API (no plugin open); pass fileKey.`,
        params: { fileKey: { type: 'string', description: 'Figma file key or URL — REST needs it named.' } },
      })
    }
  }
  toolToOp.clear()
  const tools = ops.map(opToTool) // opToTool → toolName repopulates toolToOp
  return [...META_TOOLS, ...tools]
}

/* --------------------------------------------------------------- dispatch */

/** Shape a bridge answer into an MCP tool result. Failures come back as `isError` with the
 * bridge's own message — including the roster on a 409 ambiguity refusal, which is the
 * actionable half of that answer — rather than as a protocol error, so the model reads the
 * reason and picks a target instead of seeing the call vanish. */
function toResult(answer) {
  if (!answer.ok) return { content: [{ type: 'text', text: answer.error }], isError: true }
  const body = answer.body
  if (!body || body.ok === false) {
    let text = body?.error || `the op failed (HTTP ${answer.status})`
    if (answer.status === 409 && Array.isArray(body?.files)) {
      text +=
        '\n\nConnected files:\n' + body.files.map((f) => `  ${f.handle}  ${f.file}`).join('\n') + '\n\nPass "target" to choose one.'
    }
    return { content: [{ type: 'text', text }], isError: true }
  }
  // A broadcast answers per file; a single call names the one that replied. Either way the
  // document that answered is part of the answer — a model that cannot see it cannot tell a
  // right answer from a right-looking one.
  const payload = body.broadcast
    ? { op: body.op, broadcast: true, count: body.count, results: body.results }
    : { op: body.op, file: body.file, handle: body.handle, result: body.result }
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

async function callTool(name, args) {
  const params = args && typeof args === 'object' ? { ...args } : {}

  if (name === 'altery_status') {
    const answer = await bridge('GET', '/status')
    if (!answer.ok) return { content: [{ type: 'text', text: answer.error }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify(answer.body, null, 2) }] }
  }

  if (name === 'altery_call') {
    const op = typeof params.op === 'string' ? params.op : ''
    if (!op) return { content: [{ type: 'text', text: 'altery_call needs an "op".' }], isError: true }
    const target = pickTarget(params.target)
    const fileKey = typeof params.fileKey === 'string' ? params.fileKey : ''
    return toResult(
      await bridge('POST', '/call', {
        op,
        params: params.params || {},
        ...(target ? { target } : {}),
        ...(fileKey ? { fileKey } : {}),
      })
    )
  }

  // Resolve the tool to its op. If the map does not know it yet — a call that raced the first
  // tools/list, or a client working from a stale list — rebuild once before giving up, so a
  // valid tool never fails purely on ordering.
  let op = toolToOp.get(name)
  if (!op) {
    await listTools()
    op = toolToOp.get(name)
  }
  if (!op) return { content: [{ type: 'text', text: `unknown tool "${name}" — call tools/list again; the connected files may have changed.` }], isError: true }
  const target = pickTarget(params.target)
  delete params.target
  // `fileKey` travels beside the params, not inside them: it addresses the FILE, the same slot
  // `target` fills for an open plugin, and the bridge reads it there.
  const fileKey = typeof params.fileKey === 'string' ? params.fileKey : ''
  delete params.fileKey
  return toResult(
    await bridge('POST', '/call', { op, params, ...(target ? { target } : {}), ...(fileKey ? { fileKey } : {}) })
  )
}

/** An explicit target wins; otherwise the env default, if any. Empty string means "let the
 * bridge decide", which it can when exactly one file is connected. */
function pickTarget(explicit) {
  if (typeof explicit === 'string' && explicit) return explicit
  return DEFAULT_TARGET || ''
}

/* --------------------------------------------------------------- protocol */

let writeQueue = Promise.resolve()
function send(message) {
  // Serialised writes: two messages racing to stdout could interleave bytes and break framing.
  const line = JSON.stringify(message) + '\n'
  writeQueue = writeQueue.then(
    () => new Promise((resolve) => process.stdout.write(line, resolve)),
  )
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

let initialized = false

async function handle(message) {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message.id !== undefined) fail(message.id ?? null, -32600, 'invalid request')
    return
  }
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  switch (method) {
    case 'initialize': {
      initialized = true
      const clientVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION
      reply(id, {
        protocolVersion: clientVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      })
      startRosterWatch()
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return // notifications: nothing to answer
    case 'ping':
      if (isRequest) reply(id, {})
      return
    case 'tools/list': {
      const tools = await listTools()
      reply(id, { tools })
      return
    }
    case 'tools/call': {
      const toolCall = params || {}
      const result = await callTool(toolCall.name, toolCall.arguments)
      reply(id, result)
      return
    }
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`)
      return
  }
}

/* ------------------------------------------------------- list-changed watch */

/** The connected roster changes under the client — a designer opens the plugin, toggles a gate,
 * closes a file. Poll for that and tell the client to re-list when the surface actually moved,
 * so a tools/list cached while nothing was open does not strand the session. Signature over
 * handles + gates + op names: the three things a change to any of would change the tool list. */
let rosterSignature = null
let watching = false
function startRosterWatch() {
  if (watching) return
  watching = true
  const tick = async () => {
    const result = await bridge('GET', '/ops')
    let signature = ''
    if (result.ok && Array.isArray(result.body?.files)) {
      signature = result.body.files
        .map((f) => `${f.handle}:${f.gates?.read ? 'r' : ''}${f.gates?.write ? 'w' : ''}:${(f.ops || []).map((o) => o.name).join(',')}`)
        .sort()
        .join('|')
    }
    if (rosterSignature !== null && signature !== rosterSignature) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    rosterSignature = signature
  }
  tick()
  setInterval(tick, 3000).unref()
}

/* ------------------------------------------------------------------- main */

function main() {
  // A handler is async — a tools/call is a round trip to the bridge. When stdin closes we must
  // let the ones already in flight finish replying before exiting, or a client that closed the
  // pipe right after its last request never sees the answer. Count them, and exit only once the
  // input has ended AND nothing is still being answered.
  let pending = 0
  let inputEnded = false
  const exitWhenDrained = () => {
    if (inputEnded && pending === 0) {
      // Let the last write flush, then go.
      writeQueue.then(() => process.exit(0))
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (err) {
        fail(null, -32700, `parse error: ${err.message}`)
        continue
      }
      // Handlers are self-contained and reply by id, so they need no ordering between them.
      pending++
      handle(message)
        .catch((err) => {
          log('handler error:', err?.stack || err)
          if (message && message.id !== undefined && message.id !== null) fail(message.id, -32603, `internal error: ${err?.message || err}`)
        })
        .finally(() => {
          pending--
          exitWhenDrained()
        })
    }
  })
  process.stdin.on('end', () => {
    inputEnded = true
    exitWhenDrained()
  })
  log(`altery-figma MCP server ready — bridge ${BASE}${SECRET ? '' : ' (no secret found; run the bridge once, or set ALTERY_AGENT_SECRET)'}`)
}

/* ------------------------------------------------------------------ install */
/*
 * `node mcp.mjs --install claude` and the agent is wired up.
 *
 * Every MCP client stores the same three facts — a server name, a command, its arguments — in
 * its own file, and the four steps of finding that file, creating it, merging rather than
 * overwriting, and getting the absolute path right are exactly the four a person gets wrong
 * once and blames the tool for. The entry is merged into whatever is already there; an
 * existing `altery-figma` entry is replaced, everything else is left alone.
 */

/** Client → where it keeps its MCP servers. JSON only: Codex keeps TOML, and rewriting
 * someone's TOML by hand is how configs get mangled — it gets the snippet printed instead. */
export const MCP_CLIENTS = {
  claude: {
    label: 'Claude Desktop',
    file: ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'],
  },
  cursor: { label: 'Cursor', file: ['.cursor', 'mcp.json'] },
  windsurf: { label: 'Windsurf', file: ['.codeium', 'windsurf', 'mcp_config.json'] },
  vscode: { label: 'VS Code (user)', file: ['.vscode', 'mcp.json'] },
}

export const SERVER_NAME = 'altery-figma'

/** The entry itself — one absolute path, so it works whatever directory the client starts in. */
export function serverEntry(scriptPath) {
  return { command: process.execPath, args: [scriptPath] }
}

/** Merges the entry into a client config without touching anything else in it. */
export function mergeServers(existing, name, entry) {
  const config = existing && typeof existing === 'object' ? { ...existing } : {}
  const servers = { ...(config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) }
  servers[name] = entry
  config.mcpServers = servers
  return config
}

function install(client) {
  const spec = MCP_CLIENTS[client]
  if (!spec) {
    log(`unknown client "${client}". Known: ${Object.keys(MCP_CLIENTS).join(', ')}`)
    log('For Codex (TOML) or anything else, add this by hand:')
    log(JSON.stringify({ mcpServers: { [SERVER_NAME]: serverEntry(fileURLToPath(import.meta.url)) } }, null, 2))
    process.exitCode = 1
    return
  }
  const target = path.join(os.homedir(), ...spec.file)
  let existing = null
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    /* no config yet, or one we cannot read — either way the merge starts from nothing, and
       the write below is what creates the directory */
  }
  const merged = mergeServers(existing, SERVER_NAME, serverEntry(fileURLToPath(import.meta.url)))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n')
  log(`${spec.label}: ${SERVER_NAME} → ${target}`)
  log('Restart the client, then ask it to list tools. The bridge must be running and the plugin open.')
}

/* Guarded so the module can be imported — by a test, or by anything that wants the pure
 * schema/result helpers — without the import itself starting to read stdin. */
const RUNNING_AS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (RUNNING_AS_CLI) {
  const flag = process.argv.indexOf('--install')
  if (flag >= 0) install(process.argv[flag + 1] || '')
  else main()
}

export { paramToSchema, opToTool, toResult, toolName, toolToOp, META_TOOLS }
