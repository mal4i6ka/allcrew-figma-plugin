/*
 * MCP front — the parts that decide what a client sees and what it writes to disk.
 *
 * Importing must not start reading stdin: the module guards on being the process entry point,
 * and this file is the reason that guard has to keep working.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { mergeServers, serverEntry, MCP_CLIENTS, SERVER_NAME, opToTool, toolName } = await import('./mcp.mjs')

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
