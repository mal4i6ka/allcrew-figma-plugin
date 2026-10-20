/**
 * Code Connect from the agent's side: the official CLI run for it, and the map of which Figma
 * components already have code.
 *
 * The CLI is the only supported writer of mappings, so these ops wrap it rather than re-create its
 * protocol: a pinned version (a release that changes its JSON must not change these answers
 * silently), an argv array (a path with a space or a quote is data, not shell), and the token in
 * the child's environment only — never on argv, where `ps` would show it, and redacted from the
 * captured log.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { FigmaDesktopMcpClient } from './figma-desktop-mcp.mjs'

const PINNED_PACKAGE = '@figma/code-connect@2.0.2'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_LOG = 32 * 1024

const commonParams = {
  dir: { type: 'string', required: true, description: 'Repository root containing figma.config.json; resolved to an absolute path.' },
  files: { type: 'string[]', description: 'Only these template files, relative to dir.' },
  exitOnUnreadable: { type: 'boolean', default: false, description: 'Fail instead of skipping unreadable template files.' },
}

export const CODE_CONNECT_MANIFEST = [
  {
    name: 'codeconnect.preview', summary: 'Render Code Connect templates locally through the pinned official CLI.', mutates: false,
    params: { ...commonParams },
  },
  {
    name: 'codeconnect.parse', summary: 'Parse Code Connect templates into the official machine-readable representation.', mutates: false,
    params: { ...commonParams },
  },
  {
    name: 'codeconnect.publish', summary: 'Validate or publish Code Connect mappings; dry-run is the safe default.', mutates: true, destructive: true, openWorld: true,
    params: {
      ...commonParams,
      dryRun: { type: 'boolean', default: true, description: 'Must be explicitly false to publish remotely.' },
      force: { type: 'boolean', default: false, description: 'Replace mappings created by Code Connect UI.' },
    },
  },
  {
    name: 'codeconnect.unpublish', summary: 'Remove published Code Connect mappings for discovered files or one node and label.', mutates: true, destructive: true, openWorld: true,
    params: {
      ...commonParams,
      node: { type: 'string', description: 'Figma component URL to unpublish.' },
      label: { type: 'string', description: 'Framework label paired with node.' },
    },
  },
  {
    name: 'codeconnect.map', summary: 'Map Figma components to local templates and, when available, the desktop MCP Code Connect map.', mutates: false,
    params: {
      dir: commonParams.dir,
      nodeId: { type: 'string', description: 'Ask the desktop MCP about this node (its get_code_connect_map is node-scoped).' },
    },
  },
]

export const CODE_CONNECT_OPS = CODE_CONNECT_MANIFEST.map((entry) => entry.name)

function repositoryDir(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('dir is required')
  const absolute = path.resolve(input)
  let stat
  try { stat = fs.statSync(absolute) } catch { throw new Error(`dir does not exist: ${absolute}`) }
  if (!stat.isDirectory()) throw new Error(`dir is not a directory: ${absolute}`)
  if (!fs.existsSync(path.join(absolute, 'figma.config.json'))) {
    throw new Error(`dir does not contain figma.config.json: ${absolute}`)
  }
  return fs.realpathSync(absolute)
}

function executable(dir) {
  const local = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'figma.cmd' : 'figma')
  return fs.existsSync(local)
    ? { command: local, prefix: ['connect'], local: true }
    : { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefix: ['--yes', PINNED_PACKAGE, 'connect'], local: false }
}

function commandArgs(command, params) {
  const args = [command]
  if (command === 'preview') args.push('--output', 'json')
  for (const file of Array.isArray(params.files) ? params.files : []) args.push('--file', String(file))
  if (params.exitOnUnreadable === true) args.push('--exit-on-unreadable-files')
  if (command === 'publish') {
    if (params.dryRun !== false) args.push('--dry-run')
    if (params.force === true) args.push('--force')
  }
  if (command === 'unpublish') {
    if (params.node) args.push('--node', String(params.node))
    if (params.label) args.push('--label', String(params.label))
  }
  return args
}

function parsedJson(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) } catch { /* Some CLI versions print status before JSON. */ }
  const lines = trimmed.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const candidate = lines.slice(index).join('\n')
    try { return JSON.parse(candidate) } catch { /* keep looking */ }
  }
  return null
}

function collectNamed(value, key, out = []) {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const entry of value) collectNamed(entry, key, out)
    return out
  }
  if (Object.hasOwn(value, key)) {
    const found = value[key]
    if (Array.isArray(found)) out.push(...found)
    else if (found !== undefined && found !== null) out.push(found)
  }
  for (const child of Object.values(value)) collectNamed(child, key, out)
  return out
}

function structuredResult({ command, dir, argv, stdout, stderr, code, signal, timedOut }) {
  const parsed = parsedJson(stdout)
  const logs = [stdout, stderr].filter(Boolean).join('\n').slice(-MAX_LOG)
  const files = [...collectNamed(parsed, 'files'), ...collectNamed(parsed, '_codeConnectFilePath')]
  const components = [...collectNamed(parsed, 'components'), ...collectNamed(parsed, 'component')]
  const urls = [...collectNamed(parsed, 'url'), ...collectNamed(parsed, 'figmaNode')].filter(
    (value) => typeof value === 'string'
  )
  return {
    command,
    dir,
    exitCode: code,
    signal: signal || null,
    timedOut,
    ok: code === 0 && !timedOut,
    files: [...new Set(files)],
    components,
    urls: [...new Set(urls)],
    errors: [...collectNamed(parsed, 'errors'), ...(code === 0 ? [] : [stderr.trim() || `CLI exited ${code}`])].filter(Boolean),
    output: parsed,
    log: logs,
    argv,
  }
}

export function runCodeConnectCli(command, params, { spawnImpl = nodeSpawn, token = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dir = repositoryDir(params.dir)
  const bin = executable(dir)
  const args = [...bin.prefix, ...commandArgs(command, params)]
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin.command, args, {
      cwd: dir,
      shell: false,
      env: { ...process.env, DO_NOT_TRACK: process.env.DO_NOT_TRACK || '1', ...(token ? { FIGMA_ACCESS_TOKEN: token } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    const finish = (code, signal, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const redact = (text) => (token ? text.split(token).join('[REDACTED]') : text)
      resolve(
        structuredResult({
          command,
          dir,
          argv: [bin.command, ...args],
          stdout: redact(stdout),
          stderr: redact(stderr),
          code,
          signal,
          timedOut,
        })
      )
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`could not start Code Connect CLI: ${error.message}`))
    })
    child.once('close', (code, signal) => finish(code ?? 1, signal, false))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(null, 'SIGTERM', true)
    }, timeoutMs)
  })
}

function walkTemplates(dir, at = dir, found = []) {
  for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const file = path.join(at, entry.name)
    if (entry.isDirectory()) walkTemplates(dir, file, found)
    else if (/\.figma\.(?:ts|js)$/.test(entry.name)) found.push(file)
  }
  return found
}

export function parseTemplateHeaders(source, file = '', dir = '') {
  const headers = {}
  for (const match of source.matchAll(/^\s*\/\/\s*(url|source|component)\s*=\s*(.*?)\s*$/gm)) headers[match[1]] = match[2]
  if (!headers.url) return null
  let parsed
  try { parsed = new URL(headers.url) } catch { return null }
  const segments = parsed.pathname.split('/').filter(Boolean)
  const fileIndex = segments.findIndex((entry) => entry === 'design' || entry === 'file')
  const fileKey = fileIndex >= 0 ? segments[fileIndex + 1] || null : null
  const rawNode = parsed.searchParams.get('node-id')
  const nodeId = rawNode ? rawNode.replace(/-/g, ':') : null
  return {
    nodeId,
    url: headers.url,
    fileKey,
    componentName: headers.component || null,
    source: headers.source || (file ? path.relative(dir || path.dirname(file), file) : null),
    label: null,
    origin: 'template',
  }
}

function mcpEntries(result) {
  const candidates = []
  const visit = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      try { visit(JSON.parse(value)) } catch { /* prose is not a map */ }
      return
    }
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return }
    if (typeof value !== 'object') return
    if (value.source || value.componentName || value.url || value.nodeId) candidates.push(value)
    for (const child of Object.values(value)) visit(child)
  }
  visit(result)
  return candidates.map((entry) => ({
    nodeId: entry.nodeId || entry.node_id || null,
    url: entry.url || null,
    fileKey: entry.fileKey || entry.file_key || null,
    componentName: entry.componentName || entry.component || entry.name || null,
    source: entry.source || null,
    label: entry.label || null,
    origin: 'figma-mcp',
  }))
}

export async function codeConnectMap(params, { mcpClient = new FigmaDesktopMcpClient() } = {}) {
  const dir = repositoryDir(params.dir)
  const local = walkTemplates(dir).map((file) => parseTemplateHeaders(fs.readFileSync(file, 'utf8'), file, dir)).filter(Boolean)
  let tools = []
  try { tools = await mcpClient.tools() } catch (error) {
    return { entries: local, sources: { template: { available: true, count: local.length }, figmaMcp: { available: false, reason: error.message } } }
  }
  const available = tools.some((tool) => tool.name === 'get_code_connect_map')
  if (!available) {
    return {
      entries: local,
      sources: {
        template: { available: true, count: local.length },
        figmaMcp: { available: false, reason: 'desktop MCP does not list get_code_connect_map', tools: tools.map((tool) => tool.name) },
      },
    }
  }
  const remote = mcpEntries(await mcpClient.call('get_code_connect_map', params.nodeId ? { nodeId: params.nodeId } : {}))
  return { entries: [...local, ...remote], sources: { template: { available: true, count: local.length }, figmaMcp: { available: true, count: remote.length } } }
}

export async function runCodeConnectOp(op, params, options = {}) {
  if (op === 'codeconnect.map') return codeConnectMap(params, options)
  const command = op.replace(/^codeconnect\./, '')
  if (!['preview', 'parse', 'publish', 'unpublish'].includes(command)) throw new Error(`unknown Code Connect op "${op}"`)
  return runCodeConnectCli(command, params, options)
}
