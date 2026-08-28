import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractUiCommands } from './ui-commands.ts'

const SOURCE = readFileSync(new URL('../code.ts', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ the parser */

const SAMPLE = `
type PluginMessage =
  | { type: 'DO_THING'; nodeId: string; depth?: number }
  | { type: 'PURE_THING' }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'DO_THING': {
      // @agent write: does the thing
      await write(msg.nodeId)
      figma.ui.postMessage({ type: 'THING_DONE' })
      break
    }
    case 'PURE_THING': {
      // @agent read: answers without touching anything
      figma.ui.postMessage({
        type: 'THING_ANSWER',
        value: 1,
      })
      break
    }
    case 'UNMARKED_THING': {
      figma.ui.postMessage({ type: 'WHATEVER' })
      break
    }
  }
}
`

test('a case becomes a command, with its marker, params and replies', () => {
  const commands = extractUiCommands(SAMPLE)
  assert.deepEqual(commands.map((command) => command.name), ['DO_THING', 'PURE_THING', 'UNMARKED_THING'])

  const doThing = commands[0]
  assert.equal(doThing.access, 'write')
  assert.equal(doThing.summary, 'does the thing')
  assert.deepEqual(doThing.params, [
    { name: 'nodeId', required: true, type: 'string' },
    { name: 'depth', required: false, type: 'number' },
  ])
  assert.deepEqual(doThing.replies, ['THING_DONE'])
})

test('a reply posted across several lines is still found', () => {
  const pure = extractUiCommands(SAMPLE)[1]
  assert.equal(pure.access, 'read')
  assert.deepEqual(pure.replies, ['THING_ANSWER'])
})

test('a case with no marker is a write, and says the classification was assumed', () => {
  // The whole point: an unclassified command still works, it just costs the write gate. Reading
  // "harmless" into silence is how a read gate ends up authorising a mutation.
  const unmarked = extractUiCommands(SAMPLE)[2]
  assert.equal(unmarked.access, 'write')
  assert.equal(unmarked.classified, false)
  assert.equal(unmarked.summary, undefined)
})

test('cases outside the handler are not commands', () => {
  const commands = extractUiCommands(`
    function resolveSource(kind: string) {
      switch (kind) {
        case 'LIBRARY': { return 1 }
      }
    }
    async function handleUiMessage(msg: PluginMessage): Promise<void> {
      switch (msg.type) {
        case 'REAL': { break }
      }
    }
  `)
  assert.deepEqual(commands.map((command) => command.name), ['REAL'])
})

test('a fall-through label inherits the params of the block that serves it', () => {
  const commands = extractUiCommands(`
type PluginMessage =
  | { type: 'PREVIEW_IT'; source: Source }
  | { type: 'APPLY_IT'; source: Source }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'PREVIEW_IT':
      // @agent read: counts only
    case 'APPLY_IT': {
      // @agent write: writes
      const plan = await plan(msg.source)
      figma.ui.postMessage({ type: 'DONE' })
      break
    }
  }
}
  `)
  const [preview, apply] = commands
  assert.equal(preview.access, 'read')
  assert.equal(apply.access, 'write')
  // The label has no body of its own, so an empty param list would have been a lie.
  assert.deepEqual(preview.params, apply.params)
  assert.deepEqual(preview.replies, apply.replies)
})

test('a param the union forgot is still reported from the body', () => {
  const commands = extractUiCommands(`
type PluginMessage =
  | { type: 'DRIFTED' }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'DRIFTED': {
      // @agent read: reads
      use(msg.somethingNew)
      break
    }
  }
}
  `)
  assert.deepEqual(commands[0].params, [{ name: 'somethingNew', required: false }])
})

test('a nested object type is one param, not three', () => {
  const commands = extractUiCommands(`
type PluginMessage =
  | {
      type: 'WITH_FILES'
      files: Array<{ name: string; text: string }>
      snap?: number
    }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'WITH_FILES': {
      // @agent read: reads
      break
    }
  }
}
  `)
  assert.deepEqual(commands[0].params, [
    { name: 'files', required: true, type: 'Array<{ name: string; text: string }>' },
    { name: 'snap', required: false, type: 'number' },
  ])
})

test('a source with no handler yields nothing rather than guessing', () => {
  assert.deepEqual(extractUiCommands('const x = 1'), [])
})

test('a nested object type survives whole, and an over-long one is marked as cut', () => {
  const commands = extractUiCommands(`
type PluginMessage =
  | { type: 'DOCS'; docs?: { componentDocs?: boolean; componentPreviews?: boolean; previewBudgetMb?: number } }
  | { type: 'HUGE'; thing: { ${'a: string; '.repeat(20)}} }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'DOCS': {
      // @agent read: reads
      break
    }
    case 'HUGE': {
      // @agent read: reads
      break
    }
  }
}
  `)
  // A type sliced mid-way reads as a complete annotation missing its closing brace.
  assert.equal(
    commands[0].params[0].type,
    '{ componentDocs?: boolean; componentPreviews?: boolean; previewBudgetMb?: number }'
  )
  assert.ok(commands[1].params[0].type!.endsWith('…'), 'a cut type must say it was cut')
})

/* --------------------------------------------------- shapes, notes and cost */

const SHAPED = `
type Scope = { mode: 'page' } | { mode: 'frame'; frameId: string }

export interface Form {
  context: string
  plural: boolean
}

type PluginMessage =
  | { type: 'NARROW'; scope: Scope; form: Form }
  | { type: 'LOOSE'; settings: unknown }

async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'NARROW': {
      // @agent read: reads
      // @agent cost: one walk of the document — 12s over 200k nodes
      use(msg.scope, msg.form)
      break
    }
    case 'LOOSE': {
      // @agent read: reads
      // @agent param settings: Form — unrecognised input is replaced by defaults, not refused
      use(msg.settings)
      break
    }
  }
}
`

test('a named type carries its own declaration, collapsed to one line', () => {
  const [narrow] = extractUiCommands(SHAPED)
  assert.equal(narrow.params[0].shape, "{ mode: 'page' } | { mode: 'frame'; frameId: string }")
  // Fields separated by newlines come back separated by semicolons — flattened naively an
  // interface reads `{ context: string plural: boolean }`, which nobody can copy.
  assert.equal(narrow.params[1].shape, '{ context: string; plural: boolean }')
})

test('a cost marker rides on the command', () => {
  const [narrow] = extractUiCommands(SHAPED)
  assert.equal(narrow.cost, 'one walk of the document — 12s over 200k nodes')
  assert.equal(extractUiCommands(SHAPED)[1].cost, undefined)
})

test('a param declared unknown takes its shape from the type its note names', () => {
  const loose = extractUiCommands(SHAPED)[1]
  assert.equal(loose.params[0].type, 'unknown')
  assert.equal(loose.params[0].shape, '{ context: string; plural: boolean }')
  assert.match(loose.params[0].note!, /replaced by defaults/)
})

test('a type declared in another file resolves from the dictionary, not from thin air', () => {
  const source = `
type PluginMessage = | { type: 'GO'; form: Elsewhere }
async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'GO': {
      // @agent read: reads
      break
    }
  }
}`
  assert.equal(extractUiCommands(source)[0].params[0].shape, undefined)
  assert.equal(
    extractUiCommands(source, 'export interface Elsewhere { a: string }')[0].params[0].shape,
    '{ a: string }'
  )
})

/* ------------------------------------------------------- against the real plugin */

test("every command in the plugin's own switch is classified", () => {
  const commands = extractUiCommands(SOURCE)
  assert.ok(commands.length >= 40, `only ${commands.length} commands extracted — the handler shape may have moved`)
  const unclassified = commands.filter((command) => !command.classified).map((command) => command.name)
  // Not a requirement of the mechanism — an unmarked case works — but the whole surface was
  // classified when this landed, and a new case should be marked while it is fresh.
  assert.deepEqual(unclassified, [], 'these cases need an `// @agent read|write|deny:` marker')
})

test('the channel is not exposed through itself', () => {
  const commands = extractUiCommands(SOURCE)
  for (const name of ['AGENT_SET_GATES', 'AGENT_REQUEST']) {
    assert.equal(commands.find((command) => command.name === name)?.access, 'deny', `${name} must be denied`)
  }
})

test('the reads really are reads, by name and by spot check', () => {
  const commands = extractUiCommands(SOURCE)
  const access = (name: string) => commands.find((command) => command.name === name)?.access

  // Anything that writes the document, stored settings or the network is a write, however
  // read-ish its name sounds.
  assert.equal(access('REMAP_APPLY'), 'write')
  assert.equal(access('REMAP_BOARD'), 'write')
  assert.equal(access('APPLY_PALETTE'), 'write')
  assert.equal(access('SAVE_EXPORT_OPTIONS'), 'write')
  assert.equal(access('DELIVER'), 'write')
  assert.equal(access('CONFIRM_EXPORT'), 'write')
  assert.equal(access('FIX_LINT'), 'write')

  assert.equal(access('REMAP_SCAN'), 'read')
  assert.equal(access('REMAP_PREVIEW'), 'read')
  assert.equal(access('READ_VARIABLES'), 'read')
  assert.equal(access('PREVIEW_PALETTE'), 'read')
})

test('commands report the replies they actually post', () => {
  // This was silently empty for every command once the sandbox stopped calling
  // `figma.ui.postMessage` by name and went through `postToUi` — the surface still listed 40
  // commands, and told an agent nothing about what any of them answers.
  const commands = extractUiCommands(SOURCE)
  const replies = (name: string) => commands.find((command) => command.name === name)?.replies ?? []

  assert.ok(replies('REMAP_BOARD').includes('REMAP_BOARD_DRAWN'), 'REMAP_BOARD lost its reply types')
  assert.ok(replies('REMAP_SCAN').includes('REMAP_INVENTORY'))
  assert.ok(replies('REMAP_PREVIEW').includes('REMAP_PLAN'))
  assert.ok(replies('SCAN_TOP').includes('SCAN_TOP_RESULT'))

  // Posted by a helper the case calls, not by the case — the caller still has to expect them.
  assert.ok(replies('LOAD_ANNOTATION_PANEL').includes('COMMAND_REFUSED'), 'a refusal must be declared')
  assert.ok(replies('SET_ANNOTATION').includes('COMMAND_REFUSED'))
  assert.ok(replies('SCAN').includes('SELECTION_CHANGED'), 'the scan posts a selection notice too')

  const silent = commands.filter((command) => command.access !== 'deny' && command.replies.length === 0)
  // A handful genuinely answer nothing (they only store a setting); most do answer, and a
  // wholesale empty list means the extraction broke rather than the plugin going quiet.
  assert.ok(silent.length < 8, `${silent.length} commands report no replies: ${silent.map((c) => c.name).join(', ')}`)
})

test('the remap stage is reachable end to end, with its params', () => {
  // The reason this mechanism exists: the plugin's colour mapping and its standardised board,
  // driven from the agent side without an op per step.
  const commands = extractUiCommands(SOURCE)
  for (const name of ['REMAP_SCAN', 'REMAP_PREVIEW', 'REMAP_APPLY', 'REMAP_BOARD', 'REMAP_EXPORT_MAPPING', 'REMAP_REVERT']) {
    assert.ok(commands.some((command) => command.name === name), `${name} is missing from the table`)
  }
  const preview = commands.find((command) => command.name === 'REMAP_PREVIEW')!
  assert.deepEqual(
    preview.params.filter((param) => param.required).map((param) => param.name),
    ['source']
  )
})

test('a marker for a nested key is kept as documentation, not dropped', () => {
  // `props` lives inside each entry of `nodes`, so it is not a top-level field — and dropping
  // its markers took the entire node vocabulary out of the table with it.
  const source = `
type PluginMessage = | { type: 'NODE_SET'; nodes: unknown }
async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    case 'NODE_SET': {
      // @agent write: set properties on nodes
      // @agent param nodes: an array of { node, props }
      // @agent param props: name, fill, layout
      // @agent param props: and on an instance, properties and swap
      postToUi({ type: 'NODES_SET' })
      break
    }
  }
}`
  const [command] = extractUiCommands(source)
  const props = command.params.find((param) => param.name === 'props')
  assert.ok(props, 'the nested marker must survive')
  assert.equal(props!.nested, true)
  assert.equal(props!.required, false)
  // Two markers for one name add up rather than the last one winning.
  assert.match(props!.note!, /name, fill, layout · and on an instance/)
  assert.equal(command.params.find((param) => param.name === 'nodes')!.nested, undefined)
})
