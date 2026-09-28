import test from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_FORMAT, parseUserModule } from './contract.ts'
import {
  compareModuleVersions,
  describeModules,
  findModuleCommand,
  migrateModuleState,
  moduleCommandDefs,
  redactModuleState,
  moduleStorageProblems,
  registerModules,
  MODULE_COUNT_LIMIT,
  MODULE_STATE_SIZE_LIMIT,
} from './registry.ts'
import type { UiCommandDef } from '../agent/ui-commands.ts'

const KNOWN: UiCommandDef[] = [
  {
    name: 'SCAN',
    access: 'read',
    classified: true,
    summary: 'scan',
    cost: '12s over 200k nodes',
    params: [],
    replies: ['SCANNED'],
  },
  { name: 'APPLY', access: 'write', classified: true, summary: 'apply', params: [], replies: ['APPLIED'] },
]

const file = (over: Record<string, unknown> = {}) => ({
  module: MODULE_FORMAT,
  id: 'acme.pipe',
  name: 'Pipe',
  summary: 'Scan then apply.',
  version: '1.0.0',
  state: {},
  screens: { main: { blocks: [{ block: 'heading', text: 'Pipe' }] } },
  commands: [
    {
      name: 'acme.pipe.read',
      summary: 'Just look.',
      steps: [{ call: 'SCAN' }],
    },
    {
      name: 'acme.pipe.write',
      summary: 'Look, then write.',
      steps: [{ call: 'SCAN' }, { confirm: 'This writes.' }, { call: 'APPLY' }],
    },
  ],
  ...over,
})

test('a module command reaches the channel in the same shape a native one does', () => {
  const registered = registerModules({ 'acme.pipe': { file: file() } }, KNOWN)
  const defs = moduleCommandDefs(registered)

  assert.deepEqual(defs.map((def) => [def.name, def.access, def.module]), [
    ['acme.pipe.read', 'read', 'acme.pipe'],
    ['acme.pipe.write', 'write', 'acme.pipe'],
  ])
  // The cost of what it runs, in the words of the commands it runs — a module cannot know this
  // about itself.
  assert.match(defs[0].cost!, /SCAN: 12s over 200k nodes/)
})

test('a command that stops to ask advertises the way past it', () => {
  const defs = moduleCommandDefs(registerModules({ 'acme.pipe': { file: file() } }, KNOWN))
  const confirm = defs[1].params.find((param) => param.name === 'confirm')
  assert.ok(confirm, 'a confirming command must say how to confirm')
  assert.match(confirm.note!, /stops to ask before it writes/)
  // The one that does not ask does not grow the param.
  assert.equal(defs[0].params.find((param) => param.name === 'confirm'), undefined)
})

test('a module that no longer parses is kept and explained, not dropped', () => {
  const broken = file({ commands: [{ name: 'acme.pipe.gone', summary: 'x', steps: [{ call: 'TELEPORT' }] }] })
  const [entry] = registerModules({ 'acme.pipe': { file: broken } }, KNOWN)

  assert.equal(entry.module, null)
  assert.equal(entry.active, false)
  assert.match(entry.problems[0].message, /no command "TELEPORT" in this build/)
  // A capability that vanishes silently is worse than one that says why it is unavailable.
  assert.equal(describeModules([entry])[0].problems !== undefined, true)
  assert.deepEqual(moduleCommandDefs([entry]), [])
})

test('a file edited to claim another id is not the module that was installed', () => {
  // Internally consistent — it would install perfectly well under its own name — and simply not
  // the thing stored under this key.
  const renamed = file({
    id: 'acme.other',
    commands: [{ name: 'acme.other.read', summary: 'Just look.', steps: [{ call: 'SCAN' }] }],
  })
  const [entry] = registerModules({ 'acme.pipe': { file: renamed } }, KNOWN)

  assert.equal(entry.module, null)
  assert.equal(entry.active, false)
  assert.match(entry.problems[0].message, /stored as "acme.pipe" but the file says "acme.other"/)
})

test('a switched-off module answers that it is off, rather than that it never existed', () => {
  const registered = registerModules({ 'acme.pipe': { file: file(), disabled: true } }, KNOWN)
  assert.equal(registered[0].active, false)
  assert.deepEqual(moduleCommandDefs(registered), [])

  const found = findModuleCommand(registered, 'acme.pipe.read')
  assert.ok(found && 'error' in found)
  assert.match(found.error, /switched off/)
})

test('a command nobody installed is simply not there', () => {
  const registered = registerModules({ 'acme.pipe': { file: file() } }, KNOWN)
  assert.equal(findModuleCommand(registered, 'acme.pipe.invented'), null)

  const found = findModuleCommand(registered, 'acme.pipe.write')
  assert.ok(found && !('error' in found))
  assert.equal(found.command.access, 'write')
})

test('the listing carries what an install screen needs and not the file itself', () => {
  const [described] = describeModules(registerModules({ 'acme.pipe': { file: file(), installedAt: 'yesterday' } }, KNOWN))

  assert.equal(described.name, 'Pipe')
  assert.equal(described.installedAt, 'yesterday')
  assert.deepEqual(described.screens, ['main'])
  assert.deepEqual((described.commands as Array<{ access: string }>).map((command) => command.access), ['read', 'write'])
  assert.deepEqual(
    (described.capabilities as Array<{ command: string; access: string }>).map((entry) => [entry.command, entry.access]),
    [
      ['APPLY', 'write'],
      ['SCAN', 'read'],
    ]
  )
  assert.equal(described.file, undefined, 'the listing is a description, not a copy of the module')
})

test('upgrades preserve compatible state, add defaults and redact secrets', () => {
  const upgraded = file({
    version: '2.0.0',
    state: {
      name: { type: 'string', default: 'new' },
      count: { type: 'number', default: 4, min: 0, max: 10 },
      enabled: { type: 'boolean', default: true },
      token: { type: 'string', default: '', secret: true },
    },
  })
  const parsed = parseUserModule(upgraded, KNOWN).module!
  assert.deepEqual(
    migrateModuleState(parsed, { name: 'kept', count: 99, removed: 'gone', token: 'private' }),
    { name: 'kept', count: 4, enabled: true, token: 'private' }
  )
  assert.deepEqual(
    redactModuleState(parsed, { name: 'visible', count: 3, enabled: true, token: 'private' }),
    { name: 'visible', count: 3, enabled: true }
  )
})

test('SemVer comparison guards downgrades including prereleases', () => {
  assert.equal(compareModuleVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareModuleVersions('1.0.0', '1.0.0-beta.2'), 1)
  assert.equal(compareModuleVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(compareModuleVersions('1.0.0+build.2', '1.0.0+build.1'), 0)
  assert.equal(compareModuleVersions('1.0.0-rc-2', '1.0.0-rc-1'), 1)
})

test('storage budgets reject oversized state and excessive module counts', () => {
  const large = { 'acme.pipe': { file: file(), state: { text: 'x'.repeat(MODULE_STATE_SIZE_LIMIT + 1) } } }
  assert.ok(moduleStorageProblems(large).some((problem) => /state is .* bytes; limit/.test(problem)))

  const many: Record<string, { file: unknown }> = {}
  for (let index = 0; index <= MODULE_COUNT_LIMIT; index += 1) many[`mod.${index}`] = { file: file() }
  assert.ok(moduleStorageProblems(many).some((problem) => /module count/.test(problem)))
})
