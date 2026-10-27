import test from 'node:test'
import assert from 'node:assert/strict'
import { WRITE_OPS } from './write-ops.ts'
import { RunStopped, setCurrentRun } from '../utils/budget.ts'

const removeVariables = WRITE_OPS.find((op) => op.name === 'variables.remove')!

test('variables.remove times out during its reference count before deleting', async () => {
  let removed = 0
  let committed = 0
  const variable = {
    id: 'VariableID:source',
    name: 'source',
    remote: false,
    valuesByMode: {},
    remove: () => {
      removed++
    },
  }
  let expire = () => undefined
  const page = {
    id: 'page:1',
    type: 'PAGE',
    name: 'Large page',
    children: [],
    loadAsync: async () => expire(),
  }
  ;(globalThis as { figma?: unknown }).figma = {
    root: { type: 'DOCUMENT', children: [page] },
    commitUndo: () => {
      committed++
    },
    variables: {
      getVariableByIdAsync: async () => variable,
      getLocalVariablesAsync: async () => [variable],
    },
    getLocalPaintStylesAsync: async () => [],
  } as unknown as PluginAPI

  const run = {
    id: 'remove-timeout',
    op: 'variables.remove',
    startedAt: Date.now() - 10,
    deadline: Date.now() + 10_000,
    cancelled: null,
    enforce: false,
  }
  expire = () => {
    run.deadline = Date.now() - 1
  }
  setCurrentRun(run)
  try {
    await assert.rejects(
      () => removeVariables.run({ variables: ['VariableID:source'], dryRun: false, force: false }),
      (error: unknown) => error instanceof RunStopped && error.reason === 'deadline'
    )
    assert.equal(removed, 0)
    assert.equal(committed, 0)
  } finally {
    setCurrentRun(null)
  }
})
