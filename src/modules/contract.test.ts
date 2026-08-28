import test from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_FORMAT, moduleCapabilities, parseUserModule } from './contract.ts'
import type { UiCommandDef } from '../agent/ui-commands.ts'

/** A stand-in for what `build.mjs` extracts: two reads, one write, one denied. */
const KNOWN: UiCommandDef[] = [
  {
    name: 'REMAP_SCAN',
    access: 'read',
    classified: true,
    summary: 'inventory every colour',
    cost: 'one walk of the document — 12s over 200k nodes',
    params: [{ name: 'depth', required: false, type: 'ScanDepth' }],
    replies: ['REMAP_INVENTORY'],
  },
  {
    name: 'REMAP_PREVIEW',
    access: 'read',
    classified: true,
    summary: 'build the mapping',
    params: [{ name: 'source', required: true, type: 'RemapSource' }],
    replies: ['REMAP_PLAN'],
  },
  {
    name: 'REMAP_APPLY',
    access: 'write',
    classified: true,
    summary: 'write the mapping',
    params: [{ name: 'source', required: true, type: 'RemapSource' }],
    replies: ['REMAP_APPLIED'],
  },
  { name: 'AGENT_SET_GATES', access: 'deny', classified: true, summary: 'the designer switch', params: [], replies: [] },
]

const MODULE = {
  module: MODULE_FORMAT,
  id: 'acme.remap',
  name: 'Remap onto our library',
  summary: 'Scan, map onto the reference library, then apply.',
  version: '1.0.0',
  state: {
    libraryKey: { type: 'string', default: '', label: 'Library collection' },
    rows: { type: 'number', default: 0 },
  },
  screens: {
    main: {
      blocks: [
        { block: 'heading', text: 'Remap' },
        { block: 'field', bind: 'libraryKey', label: 'Library collection key' },
        {
          block: 'button',
          label: 'Preview',
          steps: [
            { call: 'REMAP_SCAN', as: 'inventory' },
            { call: 'REMAP_PREVIEW', params: { source: { from: 'libraryKey' } }, as: 'plan' },
            { set: 'rows', from: 'plan.rows' },
          ],
        },
      ],
    },
  },
  commands: [
    {
      name: 'acme.remap.apply',
      summary: 'Scan, map and write, in one call.',
      params: [{ name: 'libraryKey', required: true, type: 'string' }],
      steps: [
        { call: 'REMAP_SCAN' },
        { confirm: 'This rewrites every bound colour in the file.' },
        { call: 'REMAP_APPLY', params: { source: { from: 'libraryKey' } } },
      ],
    },
  ],
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/* ------------------------------------------------------------------ a good one */

test('a whole module parses, and its screens and commands survive', () => {
  const { module, problems } = parseUserModule(MODULE, KNOWN)
  assert.deepEqual(problems, [])
  assert.ok(module)
  assert.equal(module.id, 'acme.remap')
  assert.equal(module.screens.main.blocks.length, 3)
  assert.equal(module.screens.settings, undefined)
  assert.equal(module.commands.length, 1)
  assert.equal(module.state.libraryKey.default, '')
})

test('a module arrives as text as readily as an object', () => {
  const { module, problems } = parseUserModule(JSON.stringify(MODULE), KNOWN)
  assert.deepEqual(problems, [])
  assert.equal(module?.id, 'acme.remap')
})

test('text that is not JSON is refused as such, not as a shape problem', () => {
  const { module, problems } = parseUserModule('{ nope', KNOWN)
  assert.equal(module, null)
  assert.match(problems[0].message, /^not JSON/)
})

/* ------------------------------------------------------------------- derived */

test('access is derived from what the steps call, and cannot be declared', () => {
  const { module } = parseUserModule(MODULE, KNOWN)
  // Two reads and a write in the same command: the whole thing is a write.
  assert.equal(module!.commands[0].access, 'write')
  assert.equal(module!.commands[0].confirms, true)

  const lying = clone(MODULE)
  ;(lying.commands[0] as Record<string, unknown>).access = 'read'
  const { module: refused, problems } = parseUserModule(lying, KNOWN)
  assert.equal(refused, null)
  assert.equal(problems[0].path, 'commands[0].access')
  assert.match(problems[0].message, /not yours to declare/)
})

test('a module of nothing but reads is a read', () => {
  const readOnly = clone(MODULE)
  readOnly.commands[0].steps = [{ call: 'REMAP_SCAN' }] as never
  const { module } = parseUserModule(readOnly, KNOWN)
  assert.equal(module!.commands[0].access, 'read')
  assert.equal(module!.commands[0].confirms, false)
})

test('the capability list is computed from the file, not read out of it', () => {
  const { module } = parseUserModule(MODULE, KNOWN)
  const capabilities = moduleCapabilities(module!, KNOWN)

  // Writes first — that is the line an install screen has to lead with.
  assert.deepEqual(
    capabilities.map((entry) => [entry.command, entry.access, entry.uses]),
    [
      ['REMAP_APPLY', 'write', 1],
      ['REMAP_PREVIEW', 'read', 1],
      ['REMAP_SCAN', 'read', 2],
    ]
  )
  // Buttons count too: a module whose screen writes is a module that writes.
  assert.equal(capabilities.find((entry) => entry.command === 'REMAP_SCAN')?.cost, KNOWN[0].cost)
})

/* ------------------------------------------------------------------ refusals */

test('an unknown format is refused before anything else is read', () => {
  const { module, problems } = parseUserModule({ module: 'altery.module/9', id: 'x' }, KNOWN)
  assert.equal(module, null)
  assert.deepEqual(problems.map((problem) => problem.path), ['module'])
})

test('a step naming a command this build lacks is an error, never a skip', () => {
  const future = clone(MODULE)
  future.commands[0].steps = [{ call: 'REMAP_TELEPORT' }] as never
  const { module, problems } = parseUserModule(future, KNOWN)
  assert.equal(module, null)
  assert.equal(problems[0].path, 'commands[0].steps[0].call')
  assert.match(problems[0].message, /needs a newer plugin, or a typo fixed/)
})

test('a denied command cannot be reached through a module either', () => {
  const rogue = clone(MODULE)
  rogue.commands[0].steps = [{ call: 'AGENT_SET_GATES' }] as never
  const { module, problems } = parseUserModule(rogue, KNOWN)
  assert.equal(module, null)
  assert.match(problems[0].message, /never callable from outside the panel/)
})

test('a command name must be namespaced, and lowercase', () => {
  const squatter = clone(MODULE)
  squatter.commands[0].name = 'REMAP_APPLY'
  const { problems } = parseUserModule(squatter, KNOWN)
  const paths = problems.map((problem) => problem.message)
  assert.ok(paths.some((message) => /must start with "acme.remap."/.test(message)))
  assert.ok(paths.some((message) => /SCREAMING_CASE names belong to the plugin/.test(message)))
})

test('two commands may not share a name', () => {
  const twins = clone(MODULE)
  twins.commands.push(clone(MODULE.commands[0]))
  const { problems } = parseUserModule(twins, KNOWN)
  assert.ok(problems.some((problem) => /duplicated/.test(problem.message)))
})

test('a required param the step never passes is caught here, not at the first click', () => {
  const forgetful = clone(MODULE)
  forgetful.commands[0].steps = [{ call: 'REMAP_APPLY', params: {} }] as never
  const { problems } = parseUserModule(forgetful, KNOWN)
  assert.equal(problems[0].path, 'commands[0].steps[0].params.source')
  assert.match(problems[0].message, /requires source/)
})

test('a param the command does not read is a mistake worth naming', () => {
  const hopeful = clone(MODULE)
  hopeful.commands[0].steps = [{ call: 'REMAP_SCAN', params: { colour: 'blue' } }] as never
  const { problems } = parseUserModule(hopeful, KNOWN)
  assert.ok(problems.some((problem) => /does not read colour/.test(problem.message)))
})

test('a reference must reach something — state, or an earlier step', () => {
  const dangling = clone(MODULE)
  dangling.commands[0].steps = [
    { call: 'REMAP_PREVIEW', params: { source: { from: 'nowhere.key' } } },
  ] as never
  const { problems } = parseUserModule(dangling, KNOWN)
  assert.match(problems[0].message, /nothing named "nowhere" is available here/)

  const backwards = clone(MODULE)
  backwards.commands[0].steps = [
    { call: 'REMAP_PREVIEW', params: { source: { from: 'plan.rows' } }, as: 'plan' },
  ] as never
  // `plan` is not readable by the step that produces it.
  assert.ok(parseUserModule(backwards, KNOWN).problems.length > 0)
})

test('an unknown block is named rather than quietly dropped', () => {
  const exotic = clone(MODULE)
  exotic.screens.main.blocks.push({ block: 'carousel', text: 'spin' } as never)
  const { module, problems } = parseUserModule(exotic, KNOWN)
  assert.equal(module, null)
  assert.equal(problems[0].path, 'screens.main.blocks[3].block')
  assert.match(problems[0].message, /unknown block "carousel"/)
})

test('a binding must name a declared field, and the message says which exist', () => {
  const loose = clone(MODULE)
  loose.screens.main.blocks[1] = { block: 'field', bind: 'typo' } as never
  const { problems } = parseUserModule(loose, KNOWN)
  assert.equal(problems[0].path, 'screens.main.blocks[1].bind')
  assert.match(problems[0].message, /declared: libraryKey, rows/)
})

test('a state field whose default does not match its type is refused', () => {
  const mismatched = clone(MODULE)
  ;(mismatched.state as Record<string, unknown>).rows = { type: 'number', default: 'lots' }
  const { problems } = parseUserModule(mismatched, KNOWN)
  assert.equal(problems[0].path, 'state.rows.default')
  assert.match(problems[0].message, /must be a number/)
})

test('every problem is reported, not just the first', () => {
  // An author should learn everything wrong with their file in one run.
  const messy = clone(MODULE)
  messy.id = 'Acme Remap'
  messy.version = 'one'
  messy.summary = ''
  const { problems } = parseUserModule(messy, KNOWN)
  assert.deepEqual(problems.map((problem) => problem.path).sort(), ['id', 'summary', 'version'])
})

test('a module with no screens at all is not a module', () => {
  const headless = clone(MODULE) as Record<string, unknown>
  delete headless.screens
  const { module, problems } = parseUserModule(headless, KNOWN)
  assert.equal(module, null)
  assert.ok(problems.some((problem) => problem.path === 'screens'))
})

test('a value block shows a state field without offering to edit it', () => {
  // The screens had no way to display a number a run produced: a module could finish its work
  // and show nothing but "done".
  const withValue = clone(MODULE)
  withValue.screens.main.blocks.push({ block: 'value', bind: 'rows', label: 'Colours that move', hint: 'from the last plan' } as never)
  const { module, problems } = parseUserModule(withValue, KNOWN)
  assert.deepEqual(problems, [])
  assert.deepEqual(module!.screens.main.blocks.at(-1), {
    block: 'value',
    bind: 'rows',
    label: 'Colours that move',
    hint: 'from the last plan',
  })
})

test('a value block must name a declared field, like every other binding', () => {
  const loose = clone(MODULE)
  loose.screens.main.blocks.push({ block: 'value', bind: 'invented' } as never)
  const { module, problems } = parseUserModule(loose, KNOWN)
  assert.equal(module, null)
  assert.match(problems[0].path, /\.bind$/)
})
