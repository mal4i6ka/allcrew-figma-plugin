import test from 'node:test'
import assert from 'node:assert/strict'
import { FigmaDesktopMcpClient, readMcpResponse } from './figma-desktop-mcp.mjs'

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

test('parses Streamable HTTP SSE data envelopes', async () => {
  const got = await readMcpResponse(response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }))
  assert.deepEqual(got.result, { tools: [] })
})

test('initializes, carries the MCP session, lists and allow-lists tool calls', async () => {
  const requests = []
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push({ body, headers: options.headers })
    if (body.method === 'initialize') {
      return response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      })
    }
    if (body.method === 'notifications/initialized') return response('', { status: 202 })
    if (body.method === 'tools/list') {
      return response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_metadata', inputSchema: {} }] } })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }))
  }
  const client = new FigmaDesktopMcpClient({ fetchImpl })
  const result = await client.call('get_metadata', { nodeId: '1:2' })
  assert.equal(result.content[0].text, 'ok')
  assert.equal(requests[0].body.params.protocolVersion, '2025-06-18')
  assert.equal(requests[1].headers['mcp-session-id'], 'session-1')
  assert.deepEqual(requests.at(-1).body.params, { name: 'get_metadata', arguments: { nodeId: '1:2' } })
  await assert.rejects(() => client.call('delete_everything', {}), /does not list tool/)
})

test('connection failures explain how to enable the desktop server', async () => {
  const client = new FigmaDesktopMcpClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  await assert.rejects(() => client.tools(), /enable Dev Mode MCP in Figma desktop preferences.*ECONNREFUSED/)
})
