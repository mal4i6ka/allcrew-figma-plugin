export const FIGMA_DESKTOP_MCP_MANIFEST = [
  {
    name: 'figma.mcp.tools',
    summary: 'List the read-only tools offered by the Figma desktop Dev Mode MCP server.',
    mutates: false,
    params: {},
  },
  {
    name: 'figma.mcp',
    summary: 'Call one tool offered by the Figma desktop Dev Mode MCP server.',
    mutates: false,
    params: {
      tool: { type: 'string', required: true, description: 'Exact tool name returned by figma.mcp.tools.' },
      arguments: { type: 'json', default: {}, description: 'Arguments passed to the desktop MCP tool.' },
    },
  },
]

export const FIGMA_DESKTOP_MCP_OPS = FIGMA_DESKTOP_MCP_MANIFEST.map((entry) => entry.name)

const DEFAULT_URL = 'http://127.0.0.1:3845/mcp'
const PROTOCOL_VERSION = '2025-06-18'

function desktopMessage(url, detail = '') {
  return `Figma desktop Dev Mode MCP is not running at ${url} — enable Dev Mode MCP in Figma desktop preferences${detail ? ` (${detail})` : ''}`
}

function parseSse(text) {
  const payloads = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    payloads.push(JSON.parse(data))
  }
  return payloads
}

export async function readMcpResponse(response) {
  const text = await response.text()
  if (!text.trim()) return null
  const type = response.headers?.get?.('content-type') || ''
  const messages = type.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)]
  return messages.find((entry) => entry && (entry.result !== undefined || entry.error !== undefined)) || messages.at(-1) || null
}

export class FigmaDesktopMcpClient {
  constructor({ url = process.env.ALLCREW_CHANNEL_FIGMA_MCP_URL || DEFAULT_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    this.url = url
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.sessionId = ''
    this.nextId = 1
    this.initialized = false
  }

  async post(body, { notification = false } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const detail = error?.name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : error?.message || String(error)
      throw new Error(desktopMessage(this.url, detail))
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const said = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Figma desktop MCP HTTP ${response.status}${said ? ` — ${said}` : ''}`)
    }
    const session = response.headers?.get?.('mcp-session-id')
    if (session) this.sessionId = session
    if (notification) return null
    const envelope = await readMcpResponse(response)
    if (envelope?.error) throw new Error(`Figma desktop MCP ${envelope.error.code ?? 'error'} — ${envelope.error.message || 'request failed'}`)
    return envelope?.result
  }

  async initialize() {
    if (this.initialized) return
    await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        // The channel's own MCP identity (agent/mcp.mjs SERVER_INFO), not the plugin release —
        // a release number here would drift the first time nobody remembered to bump it.
        clientInfo: { name: 'allcrew-channel', version: '1.0.0' },
      },
    })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { notification: true })
    this.initialized = true
  }

  async tools() {
    await this.initialize()
    const result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} })
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async call(tool, args = {}) {
    if (!tool || typeof tool !== 'string') throw new Error('tool is required')
    const tools = await this.tools()
    if (!tools.some((entry) => entry.name === tool)) {
      throw new Error(`Figma desktop MCP does not list tool "${tool}" — available: ${tools.map((entry) => entry.name).join(', ') || 'none'}`)
    }
    return this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name: tool, arguments: args && typeof args === 'object' ? args : {} },
    })
  }
}
