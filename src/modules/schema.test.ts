import test from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_SCHEMA_ID, MODULE_TEMPLATE, moduleAgentPrompt } from './schema.ts'
import { MODULE_OPS } from '../agent/module-ops.ts'

test('the SDK builder prompt carries the current starter and validation contract', () => {
  const prompt = moduleAgentPrompt()
  assert.match(prompt, /what workflow should this screen automate/i)
  assert.match(prompt, /`modules\.schema`/)
  assert.match(prompt, /\"command\": \"MODULE_INSPECT\"/)
  assert.match(prompt, /`modules\.install`/)
  assert.match(prompt, new RegExp(MODULE_SCHEMA_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, new RegExp(`\"id\": \"${MODULE_TEMPLATE.id}\"`))
  assert.ok(prompt.split('\n').length > 20, 'the copied brief uses readable paragraphs and code blocks')
  const opNames = new Set(MODULE_OPS.map((op) => op.name))
  const mentionedModuleOps = [...prompt.matchAll(/`(modules\.[a-z.]+)`/g)].map((match) => match[1])
  assert.ok(mentionedModuleOps.length > 0)
  for (const name of mentionedModuleOps) assert.ok(opNames.has(name), `${name} is not an exposed module op`)
})
