#!/usr/bin/env node
/*
 * allcrew-channel — the CLI half of the agent listener.
 *
 * Thin on purpose: an agent that can run a shell command can drive Figma, with no MCP server,
 * no client library and nothing to keep in sync but the op names. Results go to stdout as
 * JSON (pipe them to jq); everything human goes to stderr, so `$(allcrew-channel call …)` is
 * always clean data.
 *
 *   allcrew-channel status
 *   allcrew-channel ops
 *   allcrew-channel call document.info
 *   allcrew-channel call page.frames '{"pageId":"0:1"}'
 *   echo '{"nodeId":"12:345","depth":2}' | allcrew-channel call node.get -
 *
 * Open the plugin in several files and each one registers separately — a design system and the
 * product file consuming it, say. Then a call has to say which one it means:
 *
 *   allcrew-channel status                          the roster: every connected file
 *   allcrew-channel call -f mobile lint.colors      one file, matched on name
 *   allcrew-channel call -f '*' components.list     every file, one answer each (reads only)
 *
 * With a single file connected `-f` is optional. With several it is required: an unaddressed
 * call is refused with the roster rather than routed by guess.
 *
 * A second, smaller half talks to Figma's REST API instead of the plugin, because three things
 * a design-system question keeps needing — comments, version history, and who changed what —
 * do not exist in the plugin API at all. Those need a personal access token, which an
 * Organization admin is allowed to forbid outright, so they are deliberately kept apart: the
 * plugin channel above needs no credential and must not start depending on one.
 *
 *   allcrew-channel comments -k <file key or URL>
 *   allcrew-channel versions -k <file key or URL>
 *   allcrew-channel activity --since 2026-08-01
 *
 * Environment:
 *   ALLCREW_CHANNEL_AGENT_URL          default http://127.0.0.1:8788
 *   ALLCREW_CHANNEL_AGENT_SECRET       optional — falls back to the file the bridge minted, so a
 *                             machine that has run the bridge needs no setup at all
 *   ALLCREW_CHANNEL_AGENT_SECRET_FILE  default ~/.allcrew-channel/agent-secret
 *   FIGMA_TOKEN               personal access token, REST commands only
 *   FIGMA_TOKEN_FILE          default ~/.allcrew-channel/figma-token
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  ACTIVITY_SCOPE,
  OAUTH_APP_FILE,
  authorizeUrl,
  exchangeCode,
  readOAuth,
  readOAuthApp,
  refreshGrant,
  runOrgOp,
  writeOAuth,
  writeOAuthApp,
} from './figma-org.mjs'

const BASE = (process.env.ALLCREW_CHANNEL_AGENT_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')
const SECRET_FILE =
  process.env.ALLCREW_CHANNEL_AGENT_SECRET_FILE || path.join(os.homedir(), '.allcrew-channel', 'agent-secret')

/** Same order the bridge resolves in, so the two agree without anyone configuring anything. */
function resolveSecret() {
  if (process.env.ALLCREW_CHANNEL_AGENT_SECRET) return process.env.ALLCREW_CHANNEL_AGENT_SECRET
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() } catch { return '' }
}

const SECRET = resolveSecret()

const TOKEN_FILE = process.env.FIGMA_TOKEN_FILE || path.join(os.homedir(), '.allcrew-channel', 'figma-token')

const USAGE = `allcrew-channel — drive the open Figma file through the AllCrew Figma Workspace plugin

  allcrew-channel status                   which files are connected, and what each allows
  allcrew-channel ops [-f <file>] [--json] list the ops a connected file is offering
  allcrew-channel call [-f <file>] <op> [json]
                                        run one op; pass "-" to read params from stdin
  allcrew-channel batch [-f <file>] <json>
                                        run many ops in order, one round trip; "-" reads stdin

  allcrew-channel comments [-k <key|url>]  comment threads on a file      ┐ Figma REST API,
  allcrew-channel versions [-k <key|url>]  named versions and autosaves   ┘ personal token

  allcrew-channel auth [--refresh|--status] sign in for the organisation audit log ┐ OAuth,
  allcrew-channel activity [--since <d>]    who did what, incl. access changes     ┘ Enterprise

  -f, --file <handle|name|*>  which connected file to ask. Optional when exactly one is
                              connected, required when more than one. "*" asks them all
                              (reads only — a broadcast write is refused).

Secret: $ALLCREW_CHANNEL_AGENT_SECRET, else ${SECRET_FILE} (written by the bridge).
Bridge URL: $ALLCREW_CHANNEL_AGENT_URL, default ${BASE}.
Token (REST only): $FIGMA_TOKEN, else ${TOKEN_FILE}. The plugin commands need none.`

function die(message, code = 1) {
  process.stderr.write(message.replace(/\n?$/, '\n'))
  process.exit(code)
}

async function request(method, path, body) {
  let response
  try {
    response = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-allcrew-channel-secret': SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (err) {
    die(`cannot reach the bridge at ${BASE} — is it running?\n  node agent/bridge.mjs\n(${err.message})`)
  }
  // Checked centrally: a 401 looks like "plugin not connected" to every command otherwise,
  // and "your secret is wrong" is the one diagnosis worth never burying.
  if (response.status === 401) {
    die(`bridge rejected the secret (401)\n  The bridge is running with a different secret than ${SECRET_FILE} holds.`)
  }
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { die(`bridge returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`) }
  return { status: response.status, body: parsed }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
  })
}

/** Pulls `-f/--file <target>` out of an argument list wherever it sits, so `call -f ds op` and
 * `call op -f ds` both work — an agent composing a command line should not have to remember
 * which. Returns the rest untouched, in order. */
function takeTarget(args) {
  const rest = []
  let target = process.env.ALLCREW_CHANNEL_AGENT_FILE || ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      target = args[++i]
      if (target === undefined) die('-f/--file needs a value: a file handle, part of its name, or "*"')
      continue
    }
    rest.push(args[i])
  }
  return { target, rest }
}

/* ------------------------------------------------------------------- REST */

const FIGMA_API = 'https://api.figma.com'

/** Same resolution order as the bridge secret, so neither needs configuring on a machine that
 * already has the other. */
function resolveToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN
  try {
    return firstTokenLine(fs.readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return ''
  }
}

/** The token file is also where the instructions for filling it in live, so `#` comments, blank
 * lines and the shipped `PASTE_…` placeholder are not tokens — sending one of those as a
 * credential earns a 403 that reads like "your token is wrong" rather than "you have not pasted
 * one in yet". */
export function firstTokenLine(contents) {
  for (const line of contents.split('\n')) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    return value.startsWith('PASTE_') ? '' : value
  }
  return ''
}

/**
 * The one error worth writing carefully. "Go make a token" is advice that fails outright for
 * anyone whose Organization admin has turned token creation off, and an agent told only to
 * retry will keep telling the designer to do something they cannot. Say both halves.
 */
function requireToken() {
  const token = resolveToken()
  if (token) return token
  die(
    `no Figma token — the REST commands need one, the plugin commands do not.\n` +
      `  Create a personal access token at figma.com → Settings → Security → Personal access\n` +
      `  tokens, then write it to ${TOKEN_FILE} (chmod 600) or export FIGMA_TOKEN.\n` +
      `  On an Organization plan an admin can disable token creation entirely. If that page\n` +
      `  offers you nothing, this half is closed to you — say so rather than retrying.`
  )
}

/** Accepts a bare key or any Figma URL — an agent is handed links, not keys. */
export function fileKeyFrom(ref) {
  if (!ref) return ''
  const url = /figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/.exec(ref)
  return url ? url[1] : ref.trim()
}

async function figmaGet(path, token) {
  let response
  try {
    response = await fetch(FIGMA_API + path, { headers: { 'X-Figma-Token': token } })
  } catch (err) {
    die(`cannot reach api.figma.com (${err.message})`)
  }
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* handled below */ }
  if (response.status === 401 || response.status === 403) {
    const detail = parsed?.err || parsed?.message || text.slice(0, 160)
    die(
      `Figma refused the token (HTTP ${response.status}): ${detail}\n` +
        `  Either the token is wrong, it lacks the required scope, or it cannot access that file.`
    )
  }
  if (!response.ok) die(`Figma returned HTTP ${response.status}: ${text.slice(0, 200)}`)
  if (!parsed) die(`Figma returned non-JSON: ${text.slice(0, 200)}`)
  return parsed
}

/**
 * The file key, from `-k` or from the plugin itself. Asking the plugin only works where Figma
 * exposes `fileKey` — private plugins on an Organization plan — which is exactly where these
 * REST commands are most likely to be used anyway.
 */
async function resolveFileKey(explicit, target) {
  if (explicit) return fileKeyFrom(explicit)
  const { status, body } = await request('POST', '/call', { op: 'sandbox.capabilities', target: target || undefined })
  if (status !== 200 || !body?.ok) {
    die(`no file key: pass -k <key or URL>, or open the plugin so it can supply one.`)
  }
  const key = body.result?.fileKey
  if (!key) {
    die(
      `the plugin could not supply a file key — Figma exposes it only to plugins published\n` +
        `  privately to an Organization. Pass -k with the file's URL instead.`
    )
  }
  return key
}

/* --------------------------------------------------------------- commands */

function gateLabel(gates) {
  return [gates.read ? 'read' : null, gates.write ? 'write' : null].filter(Boolean).join(' + ') || 'nothing'
}

async function cmdStatus() {
  const { body } = await request('GET', '/status')
  if (!body.online) {
    die('no file connected\n  Open the AllCrew Figma Workspace plugin in Figma → Settings → Agent listener → Allow reads.')
  }
  const width = Math.max(...body.files.map((entry) => entry.handle.length))
  process.stderr.write(`${body.count} file${body.count === 1 ? '' : 's'} connected\n`)
  for (const entry of body.files) {
    process.stderr.write(`  ${entry.handle.padEnd(width)}  ${entry.file}  —  allows ${gateLabel(entry.gates)}\n`)
  }
  // A bridge older than the plugin relays calls but not necessarily the same way. Say so here:
  // this is the first thing anyone runs, and the alternative is debugging the wrong layer.
  if (body.files.some((entry) => entry.stale)) {
    process.stderr.write(
      `\n! this bridge is older than the plugin connected to it — restart it from a current\n` +
        `  agent/bridge.mjs, or re-download it from the plugin's Agent Listener screen.\n`
    )
  }
  if (body.count > 1) process.stderr.write(`\nPass -f <handle> to choose one, or -f '*' to ask them all.\n`)
}

function printOps(ops) {
  for (const op of ops) {
    const params = Object.entries(op.params || {})
      .map(([name, spec]) => (spec.required ? `${name}!` : name) + `:${spec.type}`)
      .join(' ')
    process.stdout.write(`${op.mutates ? '! ' : '  '}${op.name.padEnd(20)} ${op.summary}\n`)
    if (params) process.stdout.write(`  ${''.padEnd(20)} params: ${params}\n`)
  }
}

async function cmdOps(args) {
  const { target, rest } = takeTarget(args)
  const { status, body } = await request('GET', '/ops' + (target ? `?target=${encodeURIComponent(target)}` : ''))
  if (rest.includes('--json')) {
    process.stdout.write(JSON.stringify(target ? body.ops : body.files, null, 2) + '\n')
    return
  }
  if (status !== 200) die(body.error || `bridge returned HTTP ${status}`)
  if (!body.online && !target) die('no file connected — nothing to list.')

  // One file reads like a plain list; several are grouped, because the same op name can be
  // offered by two files running different plugin builds.
  const files = target ? [{ ...body }] : body.files
  for (const entry of files) {
    if (files.length > 1) process.stderr.write(`\n${entry.handle} — ${entry.file} (allows ${gateLabel(entry.gates)})\n`)
    if (!entry.ops || entry.ops.length === 0) {
      process.stderr.write('  connected but offering no ops (version mismatch?)\n')
      continue
    }
    printOps(entry.ops)
  }
}

async function cmdCall(argv) {
  const { target, rest: args } = takeTarget(argv)
  const op = args[0]
  if (!op) die('usage: allcrew-channel call [-f <file>] <op> [json]\nRun `allcrew-channel ops` to see what is available.')

  // Params come from the argument; stdin is opt-in via "-". An agent's shell hands a command
  // a pipe that may never reach EOF, and a CLI that hangs waiting on absent input is a far
  // worse failure than one that wants an explicit dash.
  const raw = args[1] === '-' ? await readStdin() : args[1] || ''
  let params = {}
  if (raw) {
    try { params = JSON.parse(raw) } catch (err) { die(`params are not valid JSON: ${err.message}`) }
  }

  const { status, body } = await request('POST', '/call', { op, params, ...(target ? { target } : {}) })
  if (!body.ok) {
    // 409 is the ambiguity refusal — the roster is the actionable half of that answer, so it
    // goes to stderr where a human sees it, while stdout stays parseable.
    if (status === 409 && Array.isArray(body.files)) {
      for (const entry of body.files) process.stderr.write(`  ${entry.handle}  ${entry.file}\n`)
    }
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    // The code is on stderr beside the prose: a shell script branches on it without parsing
    // English, and the exit status stays "failed" either way.
    const tag = body.code ? ` [${body.code}${body.retryable ? ', retryable' : ''}]` : ''
    die(`\n${op} failed (HTTP ${status})${tag}: ${body.error}`, 1)
  }
  // Which document answered is part of the answer — an agent that cannot see it cannot tell a
  // right answer from a right-looking one.
  if (body.broadcast) {
    process.stderr.write(`${op} — ${body.count} file${body.count === 1 ? '' : 's'} answered\n`)
    process.stdout.write(JSON.stringify(body.results, null, 2) + '\n')
    return
  }
  // REST and the bridge's own ops (history, comments, org) have no plugin window to name; saying
  // "answered by undefined" there read like a broken call.
  const by = body.handle
    ? `${body.handle} (${body.file})`
    : body.source === 'rest'
      ? `Figma REST${body.fileKey || body.result?.fileKey ? ` (${body.fileKey || body.result.fileKey})` : ''}`
      : 'the bridge'
  process.stderr.write(`${op} — answered by ${by}\n`)
  process.stdout.write(JSON.stringify(body.result, null, 2) + '\n')
}

/**
 * `allcrew-channel batch [-f <file>] <json|->` — many ops, one round trip.
 *
 * The JSON is either an array of `{ op, params }` or the whole body
 * (`{ calls: [...], continueOnError: true }`). Ordered, stops at the first failure by default,
 * and the exit status is non-zero if any call failed — so a shell script can `&&` on it.
 */
async function cmdBatch(argv) {
  const { target, rest: args } = takeTarget(argv)
  const raw = args[0] === '-' ? await readStdin() : args[0] || ''
  if (!raw) {
    die(
      'usage: allcrew-channel batch [-f <file>] \'[{"op":"node.get","params":{"nodeId":"1:2"}}]\'\n' +
        '       allcrew-channel batch -   (read the JSON from stdin)\n' +
        'Accepts an array of { op, params }, or { calls: [...], continueOnError: true }.'
    )
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch (err) { die(`batch is not valid JSON: ${err.message}`) }
  const payload = Array.isArray(parsed) ? { calls: parsed } : parsed
  if (!payload || !Array.isArray(payload.calls)) die('batch needs an array of { op, params }, or { calls: [...] }')

  const { status, body } = await request('POST', '/calls', { ...payload, ...(target ? { target } : {}) })
  if (!body.batch) {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    die(`\nbatch failed (HTTP ${status}): ${body.error || 'no batch answer'}`, 1)
  }
  process.stderr.write(`batch — ran ${body.ran} of ${body.of}${body.ok ? '' : `, failed at #${body.failedAt}`}\n`)
  process.stdout.write(JSON.stringify(body.results, null, 2) + '\n')
  // A batch that ran and broke is a failure, however healthy the HTTP status looks.
  if (!body.ok) process.exit(1)
}

/** `-k/--key` anywhere in the argument list, mirroring `takeTarget`. */
function takeKey(args) {
  const rest = []
  let key = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-k' || args[i] === '--key') {
      key = args[++i]
      if (key === undefined) die('-k/--key needs a value: a file key, or any Figma URL')
      continue
    }
    rest.push(args[i])
  }
  return { key, rest }
}

function flagValue(args, name, fallback) {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}

async function runComments(args) {
  const token = requireToken()
  const { target, rest } = takeTarget(args)
  const { key } = takeKey(rest)
  const fileKey = await resolveFileKey(key, target)
  const data = await figmaGet(`/v1/files/${encodeURIComponent(fileKey)}/comments`, token)
  const all = data.comments || []
  // Replies carry parent_id; grouping here means an agent reads threads rather than a stream
  // of fragments it has to reassemble before it can answer anything.
  const roots = all.filter((c) => !c.parent_id)
  const replies = new Map()
  for (const c of all) if (c.parent_id) replies.set(c.parent_id, [...(replies.get(c.parent_id) || []), c])
  const threads = roots.map((c) => ({
    id: c.id,
    at: c.created_at,
    resolved: Boolean(c.resolved_at),
    author: c.user?.handle || null,
    nodeId: c.client_meta?.node_id || null,
    message: c.message,
    replies: (replies.get(c.id) || []).map((r) => ({
      at: r.created_at,
      author: r.user?.handle || null,
      message: r.message,
    })),
  }))
  process.stderr.write(`${threads.length} thread${threads.length === 1 ? '' : 's'} · ${all.length} comments · file ${fileKey}\n`)
  process.stdout.write(JSON.stringify(threads, null, 2) + '\n')
}

async function runVersions(args) {
  const token = requireToken()
  const { target, rest } = takeTarget(args)
  const { key, rest: tail } = takeKey(rest)
  const limit = Number(flagValue(tail, '--limit', 30)) || 30
  const fileKey = await resolveFileKey(key, target)
  const data = await figmaGet(`/v1/files/${encodeURIComponent(fileKey)}/versions`, token)
  const versions = (data.versions || []).slice(0, limit).map((v) => ({
    id: v.id,
    at: v.created_at,
    author: v.user?.handle || null,
    // Figma autosaves constantly; only the named ones are somebody's deliberate marker, and
    // that distinction is the whole reason to read this list.
    named: Boolean(v.label),
    label: v.label || null,
    description: v.description || null,
  }))
  const named = versions.filter((v) => v.named).length
  process.stderr.write(`${versions.length} version${versions.length === 1 ? '' : 's'} (${named} named) · file ${fileKey}\n`)
  process.stdout.write(JSON.stringify(versions, null, 2) + '\n')
}

/**
 * The audit log, which is the one command here that does NOT take the personal token.
 *
 * It used to, and could not have worked: `/v1/activity_logs` answers "OAuth token is not passed
 * in the Bearer authorization header" to a `figd_` token, and answers "figd_ tokens must be
 * passed via X-Figma-Token header" when the same token is offered as a Bearer. Both measured.
 * The old error text sent people to re-mint a personal token with more scopes, which is a loop
 * with no exit — scopes were never the problem, the token TYPE is.
 */
async function runActivity(args) {
  const grant = readOAuth()
  if (grant.state === 'absent') {
    die(
      `the activity log needs an OAuth grant, not a personal access token.\n` +
        `  A figd_ token is refused on both headers, whatever scopes it carries — this is not\n` +
        `  something more permissions will fix.\n\n` +
        `  Run:  allcrew-channel auth\n\n` +
        `  Needs an Enterprise plan, an organisation admin account with 2FA, and a one-time\n` +
        `  OAuth app registered at figma.com/developers/apps.\n` +
        `  For "who touched this file", allcrew-channel versions works on any plan today.`
    )
  }
  if (grant.state === 'expired') {
    die(`the stored grant expired on ${new Date(grant.expiresAt).toISOString()} — run: allcrew-channel auth --refresh`)
  }

  const result = await runOrgOp(
    'org.activity',
    {
      events: flagValue(args, '--events', undefined),
      since: flagValue(args, '--since', undefined),
      until: flagValue(args, '--until', undefined),
      limit: Number(flagValue(args, '--limit', 100)) || 100,
      all: args.includes('--all'),
    },
    { oauth: grant.accessToken }
  )
  process.stderr.write(
    `${result.count} event${result.count === 1 ? '' : 's'} over ${result.pages} page${result.pages === 1 ? '' : 's'}` +
      `${result.truncated ? ' (truncated — pass --all or narrow with --since)' : ''}\n`
  )
  process.stdout.write(JSON.stringify(result.events, null, 2) + '\n')
}

/**
 * The OAuth sign-in, done once per machine.
 *
 * A loopback redirect rather than a pasted code: Figma matches `redirect_uri` EXACTLY against
 * what the app registered, so the port is fixed and printed rather than chosen freely — a
 * randomly-bound port would work exactly once, before the registration stopped matching it.
 */
async function runAuth(args) {
  const app = readOAuthApp()
  const clientId = flagValue(args, '--client-id', app.clientId)
  const clientSecret = flagValue(args, '--client-secret', app.clientSecret)
  const port = Number(flagValue(args, '--port', 7789)) || 7789
  const redirectUri = flagValue(args, '--redirect', `http://127.0.0.1:${port}/callback`)

  if (args.includes('--status')) {
    const grant = readOAuth()
    process.stdout.write(
      JSON.stringify(
        {
          grant: grant.state,
          expires_at: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
          app: app.clientId ? app.source : 'not configured',
          token_file: grant.source,
        },
        null,
        2
      ) + '\n'
    )
    return
  }

  if (!clientId || !clientSecret) {
    die(
      `no OAuth app configured.\n\n` +
        `  1. figma.com/developers/apps → Create a new app\n` +
        `  2. Add this exact redirect URL:  ${redirectUri}\n` +
        `  3. Re-run with the credentials it gives you:\n\n` +
        `       allcrew-channel auth --client-id <id> --client-secret <secret>\n\n` +
        `  They are saved to ${OAUTH_APP_FILE()} (chmod 600) so this is a one-time step.\n` +
        `  The app needs the ${ACTIVITY_SCOPE} scope, and only an organisation admin on an\n` +
        `  Enterprise plan with 2FA enabled can authorise it.`
    )
  }
  if (!app.clientId || app.clientId !== clientId || app.clientSecret !== clientSecret) {
    writeOAuthApp({ clientId, clientSecret })
  }

  if (args.includes('--refresh')) {
    const grant = readOAuth({ marginMs: 0 })
    if (!grant.refreshToken) die('nothing to refresh — run `allcrew-channel auth` without --refresh first')
    const next = await refreshGrant({ clientId, clientSecret, refreshToken: grant.refreshToken })
    const file = writeOAuth({ ...next, scopes: [ACTIVITY_SCOPE] })
    process.stderr.write(`refreshed — valid for ${Math.round(Number(next.expires_in || 0) / 86400)} days, stored in ${file}\n`)
    return
  }

  const state = crypto.randomUUID()
  const url = authorizeUrl({ clientId, redirectUri, state })

  /* The server is started BEFORE the browser opens: Figma redirects immediately on an
   * already-authorised session, and a listener started afterwards would miss the one request
   * this whole flow exists to catch. */
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url, `http://127.0.0.1:${port}`)
      if (!incoming.pathname.startsWith('/callback')) {
        res.writeHead(404).end('not here')
        return
      }
      const got = incoming.searchParams
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (got.get('state') !== state) {
        res.end('<p>State mismatch — this response did not come from the request this tool made. Nothing was saved.</p>')
        server.close()
        reject(new Error('state mismatch — the callback did not match the request; nothing was stored'))
        return
      }
      if (got.get('error')) {
        res.end(`<p>Figma refused: ${got.get('error')}</p>`)
        server.close()
        reject(new Error(`Figma refused the authorisation: ${got.get('error')}`))
        return
      }
      res.end('<p>Signed in. You can close this tab and return to the terminal.</p>')
      server.close()
      resolve(got.get('code'))
    })
    server.on('error', (err) =>
      reject(
        new Error(
          `cannot listen on ${port} (${err.message}) — pass --port and register the matching redirect URL in the app`
        )
      )
    )
    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(`waiting for Figma on ${redirectUri}\n  ${url}\n`)
      // Best-effort: on a headless machine the printed URL above is the whole interface.
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      try {
        spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
      } catch {
        /* printed above */
      }
    })
  })

  const grant = await exchangeCode({ clientId, clientSecret, redirectUri, code })
  const file = writeOAuth({ ...grant, scopes: [ACTIVITY_SCOPE] })
  process.stderr.write(
    `signed in — valid for ${Math.round(Number(grant.expires_in || 0) / 86400)} days, stored in ${file}\n` +
      `  allcrew-channel activity --since 2026-09-01\n`
  )
}

/* ------------------------------------------------------------------- main */

/* Everything below runs the CLI. Guarded so the module can also be imported — by a test, or by
 * anything that wants `fileKeyFrom` — without the import itself trying to execute a command. */
const RUNNING_AS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

const [command, ...rest] = RUNNING_AS_CLI ? process.argv.slice(2) : []

if (RUNNING_AS_CLI) {
if (!command || command === '-h' || command === '--help') die(USAGE, command ? 0 : 1)

const COMMANDS = {
  status: cmdStatus,
  ops: cmdOps,
  call: cmdCall,
  batch: cmdBatch,
  comments: runComments,
  versions: runVersions,
  activity: runActivity,
  auth: runAuth,
}
const handler = COMMANDS[command]
if (!handler) die(`unknown command "${command}"\n\n${USAGE}`)

// The REST half talks to Figma, not to the bridge. Demanding the bridge's secret from it would
// be a setup step invented for nothing — and `activity` never touches the plugin at all.
const NEEDS_BRIDGE = new Set(['status', 'ops', 'call', 'batch'])
if (NEEDS_BRIDGE.has(command) && !SECRET) {
  die(`no secret found — ${SECRET_FILE} does not exist and ALLCREW_CHANNEL_AGENT_SECRET is unset.\n  Start the bridge once and it writes that file:  node agent/bridge.mjs`)
}

await handler(rest)
}
