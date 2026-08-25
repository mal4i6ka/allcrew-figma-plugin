#!/usr/bin/env node
/*
 * altery-figma — the CLI half of the agent listener.
 *
 * Thin on purpose: an agent that can run a shell command can drive Figma, with no MCP server,
 * no client library and nothing to keep in sync but the op names. Results go to stdout as
 * JSON (pipe them to jq); everything human goes to stderr, so `$(altery-figma call …)` is
 * always clean data.
 *
 *   altery-figma status
 *   altery-figma ops
 *   altery-figma call document.info
 *   altery-figma call page.frames '{"pageId":"0:1"}'
 *   echo '{"nodeId":"12:345","depth":2}' | altery-figma call node.get -
 *
 * Environment:
 *   ALTERY_AGENT_URL          default http://127.0.0.1:8788
 *   ALTERY_AGENT_SECRET       optional — falls back to the file the bridge minted, so a
 *                             machine that has run the bridge needs no setup at all
 *   ALTERY_AGENT_SECRET_FILE  default ~/.altery/agent-secret
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.env.ALTERY_AGENT_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')
const SECRET_FILE =
  process.env.ALTERY_AGENT_SECRET_FILE || path.join(os.homedir(), '.altery', 'agent-secret')

/** Same order the bridge resolves in, so the two agree without anyone configuring anything. */
function resolveSecret() {
  if (process.env.ALTERY_AGENT_SECRET) return process.env.ALTERY_AGENT_SECRET
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() } catch { return '' }
}

const SECRET = resolveSecret()

const USAGE = `altery-figma — drive the open Figma file through the Altery plugin

  altery-figma status              is the plugin connected, and what is allowed
  altery-figma ops [--json]        list the ops the plugin is offering
  altery-figma call <op> [json]    run one op; pass "-" to read params from stdin

Secret: $ALTERY_AGENT_SECRET, else ${SECRET_FILE} (written by the bridge).
Bridge URL: $ALTERY_AGENT_URL, default ${BASE}.`

function die(message, code = 1) {
  process.stderr.write(message.replace(/\n?$/, '\n'))
  process.exit(code)
}

async function request(method, path, body) {
  let response
  try {
    response = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-altery-secret': SECRET },
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

/* --------------------------------------------------------------- commands */

async function cmdStatus() {
  const { body } = await request('GET', '/status')
  if (!body.online) {
    die('plugin: not connected\n  Open the Altery plugin in Figma → Settings → Agent listener → Allow reads.')
  }
  const gates = [body.gates.read ? 'read' : null, body.gates.write ? 'write' : null].filter(Boolean)
  process.stderr.write(
    `plugin: connected\nfile:   ${body.file || '(unknown)'}\nallows: ${gates.join(' + ') || 'nothing'}\nlast seen: ${body.lastSeen}\n`
  )
}

async function cmdOps(args) {
  const { body } = await request('GET', '/ops')
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(body.ops, null, 2) + '\n')
    return
  }
  if (!body.online) die('plugin: not connected — nothing to list.')
  if (body.ops.length === 0) die('the plugin connected but offered no ops (version mismatch?).')
  for (const op of body.ops) {
    const params = Object.entries(op.params || {})
      .map(([name, spec]) => (spec.required ? `${name}!` : name) + `:${spec.type}`)
      .join(' ')
    process.stdout.write(`${op.mutates ? '! ' : '  '}${op.name.padEnd(18)} ${op.summary}\n`)
    if (params) process.stdout.write(`  ${''.padEnd(18)} params: ${params}\n`)
  }
}

async function cmdCall(args) {
  const op = args[0]
  if (!op) die('usage: altery-figma call <op> [json]\nRun `altery-figma ops` to see what is available.')

  // Params come from the argument; stdin is opt-in via "-". An agent's shell hands a command
  // a pipe that may never reach EOF, and a CLI that hangs waiting on absent input is a far
  // worse failure than one that wants an explicit dash.
  const raw = args[1] === '-' ? await readStdin() : args[1] || ''
  let params = {}
  if (raw) {
    try { params = JSON.parse(raw) } catch (err) { die(`params are not valid JSON: ${err.message}`) }
  }

  const { status, body } = await request('POST', '/call', { op, params })
  if (!body.ok) {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    die(`\n${op} failed (HTTP ${status}): ${body.error}`, 1)
  }
  process.stdout.write(JSON.stringify(body.result, null, 2) + '\n')
}

/* ------------------------------------------------------------------- main */

const [command, ...rest] = process.argv.slice(2)

if (!command || command === '-h' || command === '--help') die(USAGE, command ? 0 : 1)
if (!SECRET) {
  die(`no secret found — ${SECRET_FILE} does not exist and ALTERY_AGENT_SECRET is unset.\n  Start the bridge once and it writes that file:  node agent/bridge.mjs`)
}

const COMMANDS = { status: cmdStatus, ops: cmdOps, call: cmdCall }
const handler = COMMANDS[command]
if (!handler) die(`unknown command "${command}"\n\n${USAGE}`)

await handler(rest)
