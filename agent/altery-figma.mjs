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
 * Open the plugin in several files and each one registers separately — a design system and the
 * product file consuming it, say. Then a call has to say which one it means:
 *
 *   altery-figma status                          the roster: every connected file
 *   altery-figma call -f mobile lint.colors      one file, matched on name
 *   altery-figma call -f '*' components.list     every file, one answer each (reads only)
 *
 * With a single file connected `-f` is optional. With several it is required: an unaddressed
 * call is refused with the roster rather than routed by guess.
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

  altery-figma status                   which files are connected, and what each allows
  altery-figma ops [-f <file>] [--json] list the ops a connected file is offering
  altery-figma call [-f <file>] <op> [json]
                                        run one op; pass "-" to read params from stdin

  -f, --file <handle|name|*>  which connected file to ask. Optional when exactly one is
                              connected, required when more than one. "*" asks them all
                              (reads only — a broadcast write is refused).

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

/** Pulls `-f/--file <target>` out of an argument list wherever it sits, so `call -f ds op` and
 * `call op -f ds` both work — an agent composing a command line should not have to remember
 * which. Returns the rest untouched, in order. */
function takeTarget(args) {
  const rest = []
  let target = process.env.ALTERY_AGENT_FILE || ''
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

/* --------------------------------------------------------------- commands */

function gateLabel(gates) {
  return [gates.read ? 'read' : null, gates.write ? 'write' : null].filter(Boolean).join(' + ') || 'nothing'
}

async function cmdStatus() {
  const { body } = await request('GET', '/status')
  if (!body.online) {
    die('no file connected\n  Open the Altery plugin in Figma → Settings → Agent listener → Allow reads.')
  }
  const width = Math.max(...body.files.map((entry) => entry.handle.length))
  process.stderr.write(`${body.count} file${body.count === 1 ? '' : 's'} connected\n`)
  for (const entry of body.files) {
    process.stderr.write(`  ${entry.handle.padEnd(width)}  ${entry.file}  —  allows ${gateLabel(entry.gates)}\n`)
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
  if (!op) die('usage: altery-figma call [-f <file>] <op> [json]\nRun `altery-figma ops` to see what is available.')

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
    die(`\n${op} failed (HTTP ${status}): ${body.error}`, 1)
  }
  // Which document answered is part of the answer — an agent that cannot see it cannot tell a
  // right answer from a right-looking one.
  if (body.broadcast) {
    process.stderr.write(`${op} — ${body.count} file${body.count === 1 ? '' : 's'} answered\n`)
    process.stdout.write(JSON.stringify(body.results, null, 2) + '\n')
    return
  }
  process.stderr.write(`${op} — answered by ${body.handle} (${body.file})\n`)
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
