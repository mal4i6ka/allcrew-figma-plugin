import test from 'node:test'
import assert from 'node:assert/strict'
import { BINDABLE_FIELDS, WRITE_OPS, bindFieldType, expandBindField } from './write-ops.ts'

test('a group field expands to the fields the API actually takes', () => {
  assert.deepEqual(expandBindField('cornerRadius'), [
    'topLeftRadius',
    'topRightRadius',
    'bottomLeftRadius',
    'bottomRightRadius',
  ])
  assert.deepEqual(expandBindField('padding'), ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'])
})

test('a plain field stands for itself', () => {
  assert.deepEqual(expandBindField('width'), ['width'])
  assert.deepEqual(expandBindField('fill'), ['fill'])
})

test('every field declares the variable type it takes', () => {
  assert.equal(bindFieldType('fill'), 'COLOR')
  assert.equal(bindFieldType('stroke'), 'COLOR')
  assert.equal(bindFieldType('itemSpacing'), 'FLOAT')
  assert.equal(bindFieldType('characters'), 'STRING')
  assert.equal(bindFieldType('visible'), 'BOOLEAN')
})

test('an unbindable field is refused rather than passed to the API blind', () => {
  assert.equal(bindFieldType('rotation'), null)
  assert.equal(bindFieldType(''), null)
})

test('a group name is advertised but is not itself typed — it only expands', () => {
  assert.ok(BINDABLE_FIELDS.includes('cornerRadius'), 'cornerRadius is not offered to agents')
  assert.equal(bindFieldType('cornerRadius'), null)
  for (const field of expandBindField('cornerRadius')) {
    assert.equal(bindFieldType(field), 'FLOAT', `${field} lost its type`)
  }
})

test('every advertised field either expands or is directly bindable', () => {
  for (const field of BINDABLE_FIELDS) {
    const expanded = expandBindField(field)
    const resolvable = expanded.every((one) => bindFieldType(one) !== null)
    assert.ok(resolvable, `"${field}" is advertised but nothing can bind it`)
  }
})

test('node.bind binds and unbinds a FLOAT variable on layer opacity', async (t) => {
  const variable = {
    id: 'VariableID:opacity',
    name: 'opacity/muted',
    resolvedType: 'FLOAT',
    scopes: ['OPACITY'],
  } as unknown as Variable
  const page = { type: 'PAGE', parent: null }
  const boundVariables: Record<string, VariableAlias> = {}
  const node = {
    id: '1:2',
    name: 'Muted card',
    type: 'RECTANGLE',
    parent: page,
    opacity: 0.4,
    boundVariables,
    setBoundVariable(field: string, next: Variable | null) {
      if (next) boundVariables[field] = { type: 'VARIABLE_ALIAS', id: next.id }
      else delete boundVariables[field]
    },
  }
  const previousFigma = globalThis.figma
  // Tests replace the host global with the exact API surface node.bind calls.
  const writableGlobal = globalThis as unknown as { figma: unknown }
  writableGlobal.figma = {
    commitUndo: () => undefined,
    notify: () => undefined,
    getNodeByIdAsync: async (id: string) => (id === node.id ? node : null),
    variables: {
      getLocalVariablesAsync: async () => [variable],
      getVariableByIdAsync: async (id: string) => (id === variable.id ? variable : null),
    },
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })

  const op = WRITE_OPS.find((entry) => entry.name === 'node.bind')!
  const bound = (await op.run({
    bindings: [{ node: node.id, field: 'opacity', variable: variable.name }],
  })) as { bound: number; failed: number }
  assert.deepEqual(bound, { dryRun: false, total: 1, bound: 1, failed: 0, results: [{
    node: '1:2',
    name: 'Muted card',
    field: 'opacity',
    variable: 'opacity/muted',
    ok: true,
    target: 'node',
    detail: 'opacity',
    before: 'unbound',
  }] })
  assert.equal(boundVariables.opacity.id, variable.id)

  const unbound = (await op.run({
    bindings: [{ node: node.id, field: 'opacity', variable: null }],
  })) as { bound: number; failed: number }
  assert.equal(unbound.bound, 1)
  assert.equal(unbound.failed, 0)
  assert.equal(boundVariables.opacity, undefined)
})
