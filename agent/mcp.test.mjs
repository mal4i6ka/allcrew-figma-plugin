/*
 * MCP front — the parts that decide what a client sees and what it writes to disk.
 *
 * Importing must not start reading stdin: the module guards on being the process entry point,
 * and this file is the reason that guard has to keep working.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { discoverResult, handle, initializeResult, mergeServers, serverEntry, MCP_CLIENTS, SERVER_NAME, opToTool, toolName } = await import('./mcp.mjs')

test('installing keeps every other server in the client’s config', () => {
  // People have other MCP servers configured. Overwriting the file — the obvious way to write
  // JSON — takes those away, and they find out when the other tool stops answering.
  const before = {
    mcpServers: { 'some-other': { command: 'node', args: ['/elsewhere.mjs'] } },
    theme: 'dark',
  }

  const after = mergeServers(before, SERVER_NAME, serverEntry('/abs/mcp.mjs'))

  assert.deepEqual(after.mcpServers['some-other'], { command: 'node', args: ['/elsewhere.mjs'] })
  assert.equal(after.theme, 'dark', 'unrelated settings survive')
  assert.deepEqual(after.mcpServers[SERVER_NAME].args, ['/abs/mcp.mjs'])
})

test('installing twice replaces our entry rather than doubling it', () => {
  const once = mergeServers(null, SERVER_NAME, serverEntry('/old/mcp.mjs'))
  const twice = mergeServers(once, SERVER_NAME, serverEntry('/new/mcp.mjs'))

  assert.deepEqual(Object.keys(twice.mcpServers), [SERVER_NAME])
  assert.deepEqual(twice.mcpServers[SERVER_NAME].args, ['/new/mcp.mjs'])
})

test('the entry runs this script by absolute path, with the node that is running now', () => {
  const entry = serverEntry('/abs/mcp.mjs')

  assert.equal(entry.command, process.execPath, 'a client starting from another PATH still finds node')
  assert.equal(entry.args[0], '/abs/mcp.mjs')
})

test('every known client points at a file inside the home directory', () => {
  for (const [key, spec] of Object.entries(MCP_CLIENTS)) {
    assert.ok(spec.label.length > 0, `${key} has no label to print`)
    assert.ok(Array.isArray(spec.file) && spec.file.length > 0, `${key} has no config path`)
    assert.ok(
      spec.file.every((part) => !part.includes('..')),
      `${key} config path climbs out of home`
    )
  }
})

test('an op becomes a tool that can also name a file key', () => {
  // The fileKey slot is what makes the REST fallback reachable from an MCP client at all: with
  // no plugin open there is no handle to pass, only a key.
  const tool = opToTool({
    name: 'node.get',
    summary: 'One node by id.',
    mutates: false,
    params: { nodeId: { type: 'string', description: 'Layer.', required: true } },
  })

  assert.equal(tool.name, toolName('node.get'))
  assert.deepEqual(tool.inputSchema.required, ['nodeId'])
  assert.ok(tool.inputSchema.properties.fileKey, 'no way to address a file over REST')
  assert.ok(tool.inputSchema.properties.target, 'no way to address one of several open files')
})

test('tool annotations distinguish reads, additive writes, destructive writes, and REST access', () => {
  const read = opToTool({ name: 'node.get', summary: 'Read a node.', mutates: false, params: {} })
  assert.equal(read.title, 'Node Get')
  assert.deepEqual(read.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })

  const additive = opToTool({ name: 'node.create', summary: 'Create a node.', mutates: true, params: {} })
  assert.equal(additive.annotations.destructiveHint, false)
  assert.equal(additive.annotations.idempotentHint, false)

  const destructive = opToTool({
    name: 'comments.remove',
    summary: 'Delete a comment.',
    mutates: true,
    destructive: true,
    source: 'rest',
    params: {},
  })
  assert.equal(destructive.annotations.destructiveHint, true)
  assert.equal(destructive.annotations.openWorldHint, true)
  assert.equal('outputSchema' in destructive, false, 'no output schema may be invented')
})

test('MCP initialization publishes the fidelity-first contract even without an installed skill', () => {
  const initialized = initializeResult('2024-11-05')
  assert.match(initialized.instructions, /Fidelity-first product design contract/)
  assert.match(initialized.instructions, /Search repository context before asking/)
  assert.match(initialized.instructions, /PLATFORM_DEFAULT/)
})

test('legacy initialization negotiates only revisions the server implements', () => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
    assert.equal(initializeResult(version).protocolVersion, version)
  }
  assert.equal(initializeResult('2099-01-01').protocolVersion, '2025-11-25')
})

test('modern discovery advertises stateless 2026 support and complete results', () => {
  const discovered = discoverResult()
  assert.equal(discovered.resultType, 'complete')
  assert.deepEqual(discovered.supportedVersions, ['2026-07-28'])
  assert.deepEqual(discovered.capabilities, { tools: {} })
  assert.deepEqual(discovered._meta['io.modelcontextprotocol/serverInfo'], {
    name: 'allcrew-channel',
    version: '1.0.0',
  })
})

const modernMeta = (version = '2026-07-28') => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
})

test('modern requests reject unknown protocol versions with the supported revision', async () => {
  const emitted = []
  await handle(
    { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: modernMeta('2099-01-01') } },
    (message) => emitted.push(message)
  )
  assert.deepEqual(emitted, [
    {
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: ['2026-07-28'], requested: '2099-01-01' },
      },
    },
  ])
})

test('a cancellation notification aborts the in-flight bridge fetch and suppresses its response', async () => {
  const originalFetch = globalThis.fetch
  let signal
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      signal = init.signal
      markStarted()
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    })

  const emitted = []
  try {
    const pending = handle(
      {
        jsonrpc: '2.0',
        id: 'slow-call',
        method: 'tools/call',
        params: {
          _meta: modernMeta(),
          name: 'allcrew_channel_status',
          arguments: {},
        },
      },
      (message) => emitted.push(message)
    )
    await started
    await handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'slow-call', reason: 'test cancellation' },
    })
    await pending

    assert.equal(signal.aborted, true)
    assert.deepEqual(emitted, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})
