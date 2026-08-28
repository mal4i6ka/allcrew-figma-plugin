import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUserModule, MODULE_FORMAT } from './contract.ts'
import { runModuleCommand } from './run.ts'
import type { UiCommandDef } from '../agent/ui-commands.ts'

const KNOWN: UiCommandDef[] = [
  { name: 'SCAN', access: 'read', classified: true, summary: 'scan', params: [{ name: 'depth', required: false }], replies: ['SCANNED'] },
  { name: 'PREVIEW', access: 'read', classified: true, summary: 'preview', params: [{ name: 'source', required: true }], replies: ['PLAN'] },
  { name: 'APPLY', access: 'write', classified: true, summary: 'apply', params: [{ name: 'source', required: true }], replies: ['APPLIED'] },
]

const FILE = {
  module: MODULE_FORMAT,
  id: 'acme.pipe',
  name: 'Pipe',
  summary: 'Scan, preview, apply.',
  version: '1.0.0',
  state: { key: { type: 'string', default: 'stored-key' }, rows: { type: 'number', default: 0 } },
  screens: { main: { blocks: [{ block: 'heading', text: 'Pipe' }] } },
  commands: [
    {
      name: 'acme.pipe.run',
      summary: 'The whole pipeline.',
      params: [{ name: 'key', required: false, type: 'string' }],
      steps: [
        { call: 'SCAN', as: 'inventory' },
        { call: 'PREVIEW', params: { source: { from: 'key' } }, as: 'plan' },
        { set: 'rows', from: 'plan.rows' },
        { confirm: 'This writes to the document.' },
        { call: 'APPLY', params: { source: { from: 'key' } } },
      ],
    },
  ],
}

const MODULE = parseUserModule(FILE, KNOWN).module!
const COMMAND = MODULE.commands[0]

/** A stand-in for the plugin: records what each step asked for, answers what it is told to. */
function harness(answers: Record<string, unknown[]>, options: { throwOn?: string } = {}) {
  const sent: Array<Record<string, unknown>> = []
  let current: unknown[] = []
  return {
    sent,
    context: {
      call: async (message: Record<string, unknown>) => {
        sent.push(message)
        if (options.throwOn === message.type) throw new Error('the sandbox threw')
        current = answers[String(message.type)] ?? []
      },
      record: async (work: () => Promise<void>) => {
        current = []
        await work()
        return current
      },
    },
  }
}

const ANSWERS = {
  SCAN: [{ type: 'PROGRESS', label: 'walking…' }, { type: 'SCANNED', sites: 560 }],
  PREVIEW: [{ type: 'PLAN', rows: 42 }],
  APPLY: [{ type: 'APPLIED', written: 42 }],
}

/* --------------------------------------------------------------- the happy path */

test('a run stops at the confirmation and says what it is asking about', async () => {
  const { sent, context } = harness(ANSWERS)
  const report = await runModuleCommand(MODULE, COMMAND, {}, context)

  assert.equal(report.ok, false)
  assert.equal(report.needsConfirmation, 'This writes to the document.')
  // The write never ran.
  assert.deepEqual(sent.map((message) => message.type), ['SCAN', 'PREVIEW'])
  // And what it learned on the way is still reported.
  assert.equal(report.state.rows, 42)
})

test('confirmed, the same run goes through to the end', async () => {
  const { sent, context } = harness(ANSWERS)
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })

  assert.equal(report.ok, true)
  assert.equal(report.needsConfirmation, undefined)
  assert.deepEqual(sent.map((message) => message.type), ['SCAN', 'PREVIEW', 'APPLY'])
  assert.deepEqual(report.steps.map((step) => step.ok), [true, true, true, true, true])
})

test('a reference reads state, and a param overrides it for this run only', async () => {
  const { sent, context } = harness(ANSWERS)
  await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })
  assert.equal(sent[1].source, 'stored-key')

  const second = harness(ANSWERS)
  const report = await runModuleCommand(MODULE, COMMAND, { key: 'call-key' }, { ...second.context, confirmed: true })
  assert.equal(second.sent[1].source, 'call-key')
  // The override does not leak into what the module keeps.
  assert.equal(report.state.key, 'call-key')
})

test('a step reads what an earlier step kept', async () => {
  const { context } = harness(ANSWERS)
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })
  // `plan.rows` came from the last reply of the PREVIEW step, not from the progress line.
  assert.equal(report.state.rows, 42)
})

test('only declared fields survive the run — a step name is scratch space', async () => {
  const { context } = harness(ANSWERS)
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })
  assert.deepEqual(Object.keys(report.state).sort(), ['key', 'rows'])
})

/* -------------------------------------------------------------------- failures */

test('a command that answers with an error stops the run where it happened', async () => {
  const { sent, context } = harness({ ...ANSWERS, PREVIEW: [{ type: 'REMAP_ERROR', message: 'no such library' }] })
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })

  assert.equal(report.ok, false)
  assert.match(report.error!, /step 1 \(PREVIEW\): no such library/)
  // Nothing after the failure ran — continuing would run the write against a plan that never
  // arrived.
  assert.deepEqual(sent.map((message) => message.type), ['SCAN', 'PREVIEW'])
})

test('a refusal is a failure too, and its reason is the one reported', async () => {
  const { context } = harness({ ...ANSWERS, SCAN: [{ type: 'COMMAND_REFUSED', command: 'SCAN', reason: 'not in the last scan' }] })
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })
  assert.match(report.error!, /step 0 \(SCAN\): not in the last scan/)
})

test('a sandbox that throws is reported, not swallowed', async () => {
  const { context } = harness(ANSWERS, { throwOn: 'PREVIEW' })
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })
  assert.match(report.error!, /step 1 \(PREVIEW\): the sandbox threw/)
})

test('a reference that reaches nothing fails the step rather than sending undefined', async () => {
  const broken = parseUserModule(
    {
      ...FILE,
      commands: [
        {
          name: 'acme.pipe.broken',
          summary: 'Reads a step that has not run.',
          steps: [{ call: 'PREVIEW', params: { source: { from: 'plan.rows' } }, as: 'plan' }],
        },
      ],
    },
    KNOWN
  )
  // The contract already refuses this shape, so the runner is being tested against a module the
  // parser would never hand it — belt and braces, because the runner is what actually sends.
  assert.equal(broken.module, null)

  const late = { ...MODULE, commands: [{ ...COMMAND, steps: [{ call: 'PREVIEW', params: { source: { from: 'nowhere' } } }] }] }
  const { sent, context } = harness(ANSWERS)
  const report = await runModuleCommand(late, late.commands[0], {}, context)
  assert.equal(report.ok, false)
  assert.match(report.error!, /nothing to read at "nowhere" for source/)
  assert.deepEqual(sent, [], 'the call must not have been made')
})

test('a set that reads nothing fails rather than storing undefined', async () => {
  const module = { ...MODULE, commands: [{ ...COMMAND, steps: [{ set: 'rows', from: 'plan.rows' }] }] }
  const { context } = harness(ANSWERS)
  const report = await runModuleCommand(module, module.commands[0], {}, context)
  assert.equal(report.ok, false)
  assert.match(report.error!, /nothing to read at "plan.rows"/)
  // The field keeps its declared default rather than becoming undefined.
  assert.equal(report.state.rows, 0)
})

/* ------------------------------------------------------ references inside objects */

test('a reference inside an object param is filled in, however deep it sits', async () => {
  // The commands worth composing take objects — `source` is `{ kind, key }` — and module state
  // holds scalars, so a form field can only reach one if substitution goes all the way down.
  const nested = {
    ...MODULE,
    commands: [
      {
        ...COMMAND,
        steps: [{ call: 'PREVIEW', params: { source: { kind: 'library', key: { from: 'key' } } } }],
      },
    ],
  }
  const { sent, context } = harness(ANSWERS)
  const report = await runModuleCommand(nested, nested.commands[0], { key: 'abc123' }, context)

  assert.equal(report.ok, true)
  assert.deepEqual(sent[0].source, { kind: 'library', key: 'abc123' })
})

test('an unreachable reference inside an object fails the step, naming the path', async () => {
  const nested = {
    ...MODULE,
    commands: [
      {
        ...COMMAND,
        steps: [{ call: 'PREVIEW', params: { source: { kind: 'library', key: { from: 'missing' } } } }],
      },
    ],
  }
  const { sent, context } = harness(ANSWERS)
  const report = await runModuleCommand(nested, nested.commands[0], {}, context)

  assert.equal(report.ok, false)
  assert.match(report.error!, /nothing to read at "missing" for source/)
  assert.deepEqual(sent, [])
})

test('the contract checks nested references as deep as the runner substitutes them', () => {
  const file = {
    ...FILE,
    commands: [
      {
        name: 'acme.pipe.nested',
        summary: 'Reads a field that was never declared.',
        steps: [{ call: 'PREVIEW', params: { source: { kind: 'library', key: { from: 'typo' } } } }],
      },
    ],
  }
  const { module, problems } = parseUserModule(file, KNOWN)
  assert.equal(module, null)
  assert.equal(problems[0].path, 'commands[0].steps[0].params.source.key.from')
})

test('a value that does not match the declared type is refused, not stored', async () => {
  // Found in the first live run: a module declared `rows` a number and set it from a path that
  // holds the rows themselves. Storing it anyway put a 560-entry array in clientStorage under a
  // field a form was about to render as a number.
  const { context } = harness({ ...ANSWERS, PREVIEW: [{ type: 'PLAN', rows: [{ id: 1 }, { id: 2 }], total: 2 }] })
  const report = await runModuleCommand(MODULE, COMMAND, {}, { ...context, confirmed: true })

  assert.equal(report.ok, false)
  assert.match(report.error!, /"rows" is declared number, but "plan.rows" holds an array of 2/)
  assert.equal(report.state.rows, 0, 'the field keeps its declared default')
})

test('the matching type goes through', async () => {
  const module = { ...MODULE, commands: [{ ...COMMAND, steps: [{ call: 'PREVIEW', params: { source: { from: 'key' } }, as: 'plan' }, { set: 'rows', from: 'plan.total' }] }] }
  const { context } = harness({ ...ANSWERS, PREVIEW: [{ type: 'PLAN', rows: [{ id: 1 }], total: 560 }] })
  const report = await runModuleCommand(module, module.commands[0], {}, context)
  assert.equal(report.ok, true)
  assert.equal(report.state.rows, 560)
})
