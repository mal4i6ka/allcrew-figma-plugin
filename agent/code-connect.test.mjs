import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeConnectMap, parseTemplateHeaders, runCodeConnectCli } from './code-connect.mjs'

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'allcrew-code-connect-'))
  writeFileSync(join(dir, 'figma.config.json'), '{"codeConnect":{"include":["**/*.figma.ts"]}}')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeSpawn(onSpawn) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = (signal) => { child.killedWith = signal; return true }
    queueMicrotask(() => onSpawn({ command, args, options, child }))
    return child
  }
}

test('pinned CLI uses argv, cwd and a token only in the environment, then parses JSON', async (t) => {
  const dir = repo(t)
  const token = 'secret-token-never-an-argument'
  let invocation
  const result = await runCodeConnectCli('parse', { dir, files: ['Button.figma.ts'], exitOnUnreadable: true }, {
    token,
    spawnImpl: fakeSpawn((seen) => {
      invocation = seen
      seen.child.stdout.emit('data', JSON.stringify({ files: ['Button.figma.ts'], components: [{ name: 'Button', url: 'https://figma.test/1' }] }))
      seen.child.stderr.emit('data', `diagnostic accidentally included ${token}`)
      seen.child.emit('close', 0, null)
    }),
  })
  assert.match(invocation.command, /npx/)
  assert.deepEqual(invocation.args.slice(0, 3), ['--yes', '@figma/code-connect@2.0.2', 'connect'])
  assert.ok(!invocation.args.includes('--output'), 'parse emits JSON without the preview-only --output flag')
  assert.ok(invocation.args.includes('--exit-on-unreadable-files'))
  assert.equal(invocation.options.cwd, realpathSync(dir))
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.env.FIGMA_ACCESS_TOKEN, token)
  assert.equal(invocation.options.env.DO_NOT_TRACK, '1')
  assert.ok(![invocation.command, ...invocation.args].join(' ').includes(token))
  assert.equal(result.ok, true)
  assert.deepEqual(result.files, ['Button.figma.ts'])
  assert.equal(result.components[0].name, 'Button')
  assert.ok(!result.log.includes(token))
  assert.deepEqual(result.urls, ['https://figma.test/1'])
})

test('publish is dry-run unless false is explicit and supports force', async (t) => {
  const dir = repo(t)
  const calls = []
  const spawnImpl = fakeSpawn((seen) => { calls.push(seen.args); seen.child.emit('close', 0, null) })
  await runCodeConnectCli('publish', { dir }, { spawnImpl })
  await runCodeConnectCli('publish', { dir, dryRun: false, force: true }, { spawnImpl })
  assert.ok(calls[0].includes('--dry-run'))
  assert.ok(!calls[1].includes('--dry-run'))
  assert.ok(calls[1].includes('--force'))
})

test('timeout terminates the child and returns a structured failure', async (t) => {
  const dir = repo(t)
  let child
  const result = await runCodeConnectCli('parse', { dir }, {
    timeoutMs: 5,
    spawnImpl: fakeSpawn((seen) => { child = seen.child }),
  })
  assert.equal(child.killedWith, 'SIGTERM')
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
})

test('template headers become mapping entries with Figma identity', () => {
  const entry = parseTemplateHeaders(`// url=https://www.figma.com/design/AbCd/File?node-id=12-34\n// source=src/Button.tsx\n// component=Button\nimport figma from 'figma'`)
  assert.deepEqual(entry, {
    nodeId: '12:34', url: 'https://www.figma.com/design/AbCd/File?node-id=12-34', fileKey: 'AbCd',
    componentName: 'Button', source: 'src/Button.tsx', label: null, origin: 'template',
  })
})

test('map reports unavailable desktop map honestly and keeps local templates', async (t) => {
  const dir = repo(t)
  mkdirSync(join(dir, 'components'))
  writeFileSync(join(dir, 'components', 'Button.figma.ts'), '// url=https://www.figma.com/design/Key/File?node-id=1-2\n// source=src/Button.tsx\n// component=Button\n')
  const result = await codeConnectMap({ dir }, { mcpClient: { tools: async () => [{ name: 'get_metadata' }] } })
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].origin, 'template')
  assert.equal(result.sources.figmaMcp.available, false)
  assert.deepEqual(result.sources.figmaMcp.tools, ['get_metadata'])
})

test('remote-write publish is refused before spawning when no designer gate is present', async () => {
  process.env.ALLCREW_CHANNEL_AGENT_SECRET ||= 'test-secret'
  const { runCall } = await import('./bridge.mjs')
  const answer = await runCall({ op: 'codeconnect.publish', params: { dir: '.', dryRun: false } })
  assert.equal(answer.body.code, 'no_plugin')
  assert.match(answer.body.error, /Allow changes/)
})

test('EMIT_REACT inherits a discovered file key without overriding an explicit fileUrl', async () => {
  process.env.ALLCREW_CHANNEL_AGENT_SECRET ||= 'test-secret'
  const { withDiscoveredFileUrl } = await import('./bridge.mjs')
  assert.deepEqual(
    withDiscoveredFileUrl(
      'plugin.call',
      { command: 'EMIT_REACT', params: { frameId: '1:2' } },
      'DiscoveredKey'
    ),
    { command: 'EMIT_REACT', params: { frameId: '1:2', fileUrl: 'DiscoveredKey' } }
  )
  const explicit = { command: 'EMIT_REACT', params: { fileUrl: 'https://www.figma.com/design/Explicit/File' } }
  assert.equal(withDiscoveredFileUrl('plugin.call', explicit, 'DiscoveredKey'), explicit)
  assert.deepEqual(
    withDiscoveredFileUrl('plugin.call', { command: 'NODE_CREATE', params: {} }, 'DiscoveredKey'),
    { command: 'NODE_CREATE', params: {} }
  )
})
