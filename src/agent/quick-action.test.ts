import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuickParams, suggestCommands } from './quick-action.ts'
import type { UiCommandDef } from './ui-commands.ts'

const command = (name: string, summary: string, access: 'read' | 'write' | 'deny' = 'read') =>
  ({ name, summary, access, classified: true, params: [], replies: [] }) as UiCommandDef

test('suggestions match every typed word, names before summaries, denied commands never', () => {
  const table = [
    command('PAGE_LIST', 'the pages of this file'),
    command('PAGE_CREATE', 'add a page', 'write'),
    command('NODE_QUERY', 'find nodes on the page'),
    command('AGENT_SET_GATES', 'change the gates', 'deny'),
  ]
  assert.deepEqual(suggestCommands(table, 'page').map((one) => one.data), ['PAGE_LIST', 'PAGE_CREATE', 'NODE_QUERY'])
  assert.deepEqual(suggestCommands(table, 'page add').map((one) => one.data), ['PAGE_CREATE'])
  assert.deepEqual(suggestCommands(table, 'gates'), [])
})

test('quick-action parameters are a JSON object without its own type', () => {
  assert.deepEqual(parseQuickParams(undefined), { params: {} })
  assert.deepEqual(parseQuickParams('{"name":"Card"}'), { params: { name: 'Card' } })
  assert.match((parseQuickParams('[1]') as { problem: string }).problem, /JSON object/)
  assert.match((parseQuickParams('{"type":"X"}') as { problem: string }).problem, /"type" is the command/)
  assert.match((parseQuickParams('{nope') as { problem: string }).problem, /not JSON/)
})
