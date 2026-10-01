import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SECRET = 'rest-routing-secret'
const FILE = 'abcdefghijklmnopqrstuv'

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

let bridgePort
let apiPort
let bridge
let api
const requests = []
let active = 0
let maxActive = 0
let rateAttempts = 0

async function call(op, params) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-allcrew-channel-secret': SECRET },
    body: JSON.stringify({ op, params }),
  })
  return { status: response.status, body: await response.json() }
}

async function cliCall(op, params) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'allcrew-channel.mjs'), 'call', op, JSON.stringify(params)], {
      env: {
        ...process.env,
        ALLCREW_CHANNEL_AGENT_URL: `http://127.0.0.1:${bridgePort}`,
        ALLCREW_CHANNEL_AGENT_SECRET: SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test.before(async () => {
  apiPort = await freePort()
  api = http.createServer((req, res) => {
    requests.push(req.url)
    active += 1
    maxActive = Math.max(maxActive, active)
    res.on('finish', () => { active -= 1 })
    res.setHeader('content-type', 'application/json')
    const url = new URL(req.url, `http://127.0.0.1:${apiPort}`)
    const id = url.searchParams.get('ids')
    if (!id) {
      res.end(JSON.stringify({
        name: 'File',
        document: {
          id: '0:0',
          name: 'Document',
          type: 'DOCUMENT',
          children: [
            { id: '1:1', name: 'Page One', type: 'CANVAS', children: [{ id: '2:1', name: 'Frame One', type: 'FRAME' }] },
            { id: '1:2', name: 'Page Two', type: 'CANVAS', children: [{ id: '2:2', name: 'Frame Two', type: 'FRAME' }] },
          ],
        },
      }))
      return
    }
    if (id === 'rate' && ++rateAttempts < 3) {
      res.statusCode = 429
      res.setHeader('Retry-After', '0')
      res.setHeader('x-figma-plan-tier', 'org')
      res.end(JSON.stringify({ err: 'rate limited' }))
      return
    }
    const document = id === 'document'
      ? {
          id: 'document',
          name: 'Document',
          type: 'DOCUMENT',
          children: [{ id: 'page', name: 'Page', type: 'CANVAS', children: [{ id: 'frame', name: 'Frame', type: 'FRAME' }] }],
        }
      : {
          id,
          name: 'Node',
          type: 'FRAME',
          children: [{ id: `${id}:child`, name: 'Child', type: 'FRAME', children: [{ id: `${id}:grand`, name: 'Grandchild', type: 'RECTANGLE' }] }],
        }
    const answer = () => res.end(JSON.stringify({ nodes: { [id]: { document } } }))
    if (id.startsWith('slow')) setTimeout(answer, 30)
    else answer()
  })
  await new Promise((resolve) => api.listen(apiPort, '127.0.0.1', resolve))

  bridgePort = await freePort()
  bridge = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
    env: {
      ...process.env,
      ALLCREW_CHANNEL_AGENT_PORT: String(bridgePort),
      ALLCREW_CHANNEL_AGENT_HOST: '127.0.0.1',
      ALLCREW_CHANNEL_AGENT_SECRET: SECRET,
      ALLCREW_CHANNEL_FIGMA_API: `http://127.0.0.1:${apiPort}`,
      FIGMA_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.resume()
  bridge.stderr.resume()
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${bridgePort}/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('bridge did not start')
})

test.after(async () => {
  bridge?.kill('SIGKILL')
  if (api) await new Promise((resolve) => api.close(resolve))
})

test('parallel page.frames calls share one cached file-tree request', async () => {
  requests.length = 0
  const answers = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      call('page.frames', { fileKey: FILE, pageId: index % 2 === 0 ? '1:1' : '1:2' })
    )
  )
  assert.ok(answers.every((answer) => answer.status === 200))
  assert.equal(answers[0].body.result.frames[0].name, 'Frame One')
  assert.deepEqual(requests, [`/v1/files/${FILE}?depth=2`])
})

test('node.get recursively reports the requested depth, including document pages and frames', async () => {
  requests.length = 0
  const answer = await call('node.get', { fileKey: FILE, nodeId: 'document', depth: 2 })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.result.children[0].name, 'Page')
  assert.equal(answer.body.result.children[0].children[0].name, 'Frame')
  assert.deepEqual(requests, [`/v1/files/${FILE}/nodes?ids=document&depth=2`])
})

test('429 responses honor Retry-After and retry at most through the successful third attempt', async () => {
  requests.length = 0
  rateAttempts = 0
  const answer = await call('node.get', { fileKey: FILE, nodeId: 'rate', depth: 1 })
  assert.equal(answer.status, 200)
  assert.equal(rateAttempts, 3)
})

test('the REST bridge starts at most four Figma requests concurrently', async () => {
  maxActive = 0
  const answers = await Promise.all(
    Array.from({ length: 8 }, (_, index) => call('node.get', { fileKey: FILE, nodeId: `slow${index}`, depth: 1 }))
  )
  assert.ok(answers.every((answer) => answer.status === 200))
  assert.ok(maxActive <= 4, `saw ${maxActive} concurrent REST requests`)
})

test('CLI labels REST and bridge-owned answers without undefined window names', async () => {
  const answer = await cliCall('node.get', { fileKey: FILE, nodeId: 'cli', depth: 1 })
  assert.equal(answer.code, 0)
  assert.ok(answer.stderr.includes(`answered by Figma REST (${FILE})`))
  assert.doesNotMatch(answer.stderr, /undefined/)
})
