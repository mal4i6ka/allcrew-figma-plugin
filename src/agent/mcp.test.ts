import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error — the MCP server is plain JS, imported for the pure helpers it exports.
import { paramToSchema, opToTool, toResult, META_TOOLS } from '../../agent/mcp.mjs'

test('a ParamSpec becomes the JSON Schema the bridge will actually enforce', () => {
  assert.deepEqual(paramToSchema({ type: 'string', description: 'a name' }), { type: 'string', description: 'a name' })
  assert.deepEqual(paramToSchema({ type: 'string', enum: ['a', 'b'] }), { type: 'string', enum: ['a', 'b'] })
  assert.deepEqual(paramToSchema({ type: 'number', min: 0, max: 10 }), { type: 'number', minimum: 0, maximum: 10 })
  assert.deepEqual(paramToSchema({ type: 'boolean' }), { type: 'boolean' })
  assert.deepEqual(paramToSchema({ type: 'string[]' }), { type: 'array', items: { type: 'string' } })
})

test('a json param is left unconstrained — object or array, the bridge owns the contract', () => {
  // No `type`, so a client is free to send either shape; only the description carries through.
  assert.deepEqual(paramToSchema({ type: 'json', description: 'the rest' }), { description: 'the rest' })
  assert.deepEqual(paramToSchema({ type: 'json' }), {})
})

test('an op turns into a tool with a sanitised name and a target it did not declare', () => {
  const tool = opToTool({
    name: 'node.get',
    summary: 'one node by id',
    mutates: false,
    params: { nodeId: { type: 'string', required: true, description: 'the node' }, depth: { type: 'number' } },
  })
  assert.equal(tool.name, 'node_get') // the dot a Figma op carries is not legal in a tool name
  assert.equal(tool.inputSchema.type, 'object')
  assert.deepEqual(tool.inputSchema.required, ['nodeId'])
  assert.equal(tool.inputSchema.properties.nodeId.type, 'string')
  // Every generated tool gains `target` so a call can name one of several open files.
  assert.equal(tool.inputSchema.properties.target.type, 'string')
})

test('a mutating op is flagged as one in the tool description, and carries no `required` when it has no required params', () => {
  const tool = opToTool({ name: 'board.render', summary: 'draw a board', mutates: true, params: {} })
  assert.match(tool.description, /writes to the document/)
  assert.equal(tool.inputSchema.required, undefined)
})

test('a successful single answer names the file that replied', () => {
  const result = toResult({ ok: true, status: 200, body: { ok: true, op: 'document.info', file: 'Mobile DS', handle: 'mobile', result: { name: 'Mobile DS' } } })
  assert.equal(result.isError, undefined)
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.handle, 'mobile')
  assert.deepEqual(payload.result, { name: 'Mobile DS' })
})

test('a broadcast answer keeps every file’s reply', () => {
  const result = toResult({ ok: true, status: 200, body: { ok: true, op: 'lint.colors', broadcast: true, count: 2, results: [{ handle: 'a' }, { handle: 'b' }] } })
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.broadcast, true)
  assert.equal(payload.count, 2)
})

test('a 409 ambiguity refusal becomes an error that carries the roster and the way out', () => {
  const result = toResult({ ok: true, status: 409, body: { ok: false, error: 'more than one file connected', files: [{ handle: 'a', file: 'A' }, { handle: 'b', file: 'B' }] } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /more than one file/)
  assert.match(result.content[0].text, /a\s+A/)
  assert.match(result.content[0].text, /Pass "target"/)
})

test('an unreachable bridge is an error the model can act on, not a crash', () => {
  const result = toResult({ ok: false, error: 'cannot reach the AllCrew Channel bridge' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /cannot reach the AllCrew Channel bridge/)
})

test('the meta tools are always present, needing no connected plugin', () => {
  const names = META_TOOLS.map((t: { name: string }) => t.name)
  assert.deepEqual(names, ['allcrew_channel_status', 'allcrew_channel_call', 'allcrew_channel_batch'])
})

test('the batch tool asks for ordered calls and defaults to stopping on failure', () => {
  const batch = META_TOOLS.find((t: { name: string }) => t.name === 'allcrew_channel_batch') as {
    description: string
    inputSchema: { required: string[]; properties: Record<string, { type?: string; items?: unknown }> }
  }
  assert.deepEqual(batch.inputSchema.required, ['calls'])
  assert.equal(batch.inputSchema.properties.calls.type, 'array')
  // The description has to say the two things a model cannot infer from the schema: that order
  // is a guarantee, and that it stops at the first failure unless told otherwise.
  assert.match(batch.description, /in order/i)
  assert.match(batch.description, /first failure/i)
})
