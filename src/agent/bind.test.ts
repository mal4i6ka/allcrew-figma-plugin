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

test('style.bind binds a text style field, loading its font first, and refuses a mistyped variable', async (t) => {
  // Corporate's Display styles are set in Onest while the only family variable holds Inter —
  // the export then claimed every style was Inter. A STRING variable bound to fontFamily fixes it.
  const onest = { id: 'VariableID:9:1', name: 'font-family/onest', resolvedType: 'STRING' } as unknown as Variable
  const size = { id: 'VariableID:9:2', name: 'font-size/lg', resolvedType: 'FLOAT' } as unknown as Variable
  const boundVariables: Record<string, VariableAlias> = {}
  const loaded: string[] = []
  const style = {
    id: 'S:abc,',
    key: 'abc',
    name: 'Display/Medium',
    fontName: { family: 'Onest', style: 'SemiBold' },
    boundVariables,
    setBoundVariable(field: string, next: Variable | null) {
      if (!loaded.includes('Onest')) throw new Error('font not loaded')
      if (next) boundVariables[field] = { type: 'VARIABLE_ALIAS', id: next.id }
      else delete boundVariables[field]
    },
  }
  const previousFigma = globalThis.figma
  const writableGlobal = globalThis as unknown as { figma: unknown }
  writableGlobal.figma = {
    commitUndo: () => undefined,
    getLocalPaintStylesAsync: async () => [],
    getLocalTextStylesAsync: async () => [style],
    getStyleByIdAsync: async (id: string) => (id === style.id ? style : null),
    loadFontAsync: async (font: { family: string }) => {
      loaded.push(font.family)
    },
    variables: {
      getLocalVariablesAsync: async () => [onest, size],
      getVariableByIdAsync: async (id: string) => [onest, size].find((v) => v.id === id) ?? null,
      getLocalVariableCollectionsAsync: async () => [],
    },
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })
  const op = WRITE_OPS.find((entry) => entry.name === 'style.bind')!

  const dry = (await op.run({ bindings: [{ style: 'Display/Medium', field: 'fontFamily', variable: onest.id }], dryRun: true })) as {
    results: Array<Record<string, unknown>>
  }
  assert.equal(dry.results[0].ok, true)
  assert.equal(boundVariables.fontFamily, undefined, 'a dry run wrote')

  const done = (await op.run({ bindings: [{ style: 'abc', field: 'fontFamily', variable: onest.id }] })) as {
    bound: number
    results: Array<Record<string, unknown>>
  }
  assert.equal(done.bound, 1)
  assert.equal(done.results[0].verified, true)
  assert.equal(boundVariables.fontFamily.id, onest.id)

  const wrong = (await op.run({ bindings: [{ style: 'Display/Medium', field: 'fontFamily', variable: size.id }] })) as {
    failed: number
    results: Array<Record<string, unknown>>
  }
  assert.equal(wrong.failed, 1)
  assert.match(String(wrong.results[0].error), /FLOAT, but fontFamily takes STRING/)
})

test('node.style applies a LIBRARY text style — by its id, by the key inside it, or like a neighbour', async (t) => {
  // The website's text styles all live in a library: a layer reads "S:<key>,<id>", remote. The
  // local-only lookup could not give five unstyled table labels the style their neighbours use.
  const body4 = { id: 'S:cb93dcd54e7d08916d268df81d6638465102a254,313:306', key: 'cb93dcd54e7d08916d268df81d6638465102a254', name: 'Text/Body 4', type: 'TEXT', remote: true }
  const legacy = { id: 'S:1:256', key: 'legacy', name: 'Navigation/M', type: 'TEXT', remote: false }
  const fill = { id: 'S:aa,1:1', key: 'aa', name: 'Brand/Primary', type: 'PAINT', remote: false }
  const known = new Map<string, unknown>([[legacy.id, legacy], [fill.id, fill]])
  const imported: string[] = []
  const text = (id: string, textStyleId: string) => ({
    id,
    name: id,
    type: 'TEXT',
    textStyleId,
    fills: [],
    async setTextStyleIdAsync(this: { textStyleId: string }, next: string) {
      this.textStyleId = next
    },
  })
  const neighbour = text('1:1', body4.id)
  const stray = text('1:2', '')
  const pound = text('1:3', legacy.id)
  const nodes = new Map<string, unknown>([[neighbour.id, neighbour], [stray.id, stray], [pound.id, pound]])
  const previousFigma = globalThis.figma
  const writableGlobal = globalThis as unknown as { figma: unknown }
  writableGlobal.figma = {
    mixed: Symbol('mixed'),
    commitUndo: () => undefined,
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    getLocalTextStylesAsync: async () => [legacy],
    getLocalPaintStylesAsync: async () => [fill],
    getStyleByIdAsync: async (id: string) => known.get(id) ?? null,
    importStyleByKeyAsync: async (key: string) => {
      if (key !== body4.key) throw new Error('not published')
      imported.push(key)
      known.set(body4.id, body4)
      return body4
    },
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })
  const op = WRITE_OPS.find((entry) => entry.name === 'node.style')!
  type Report = { applied: number; failed: number; results: Array<Record<string, unknown>> }

  // The file has not met Body 4 yet: the id's key imports it.
  const byId = (await op.run({ assignments: [{ node: '1:2', field: 'text', style: body4.id }] })) as Report
  assert.equal(byId.applied, 1)
  assert.deepEqual(imported, [body4.key])
  assert.equal(stray.textStyleId, body4.id)
  assert.equal(byId.results[0].verified, true)

  // "The same as its neighbour" — the way a designer says it.
  const like = (await op.run({ assignments: [{ node: '1:3', field: 'text', like: '1:1' }] })) as Report
  assert.equal(like.applied, 1)
  assert.equal(like.results[0].before, 'Navigation/M')
  assert.equal(pound.textStyleId, body4.id)

  // A local name still resolves as before; a paint style is not a text style; a library name is
  // refused with the way out rather than guessed.
  const local = (await op.run({ assignments: [{ node: '1:3', field: 'text', style: 'navigation/m' }] })) as Report
  assert.equal(local.applied, 1)
  const wrong = (await op.run({ assignments: [{ node: '1:3', field: 'text', style: fill.id }] })) as Report
  assert.match(String(wrong.results[0].error), /is a PAINT style, not TEXT/)
  const byName = (await op.run({ assignments: [{ node: '1:3', field: 'text', style: 'Text/Body 4' }] })) as Report
  assert.match(String(byName.results[0].error), /library style needs its id or key/)
  // Same name, other copy: a write that did not stick is caught by id.
  const stale = { ...body4, id: 'S:cb93dcd54e7d08916d268df81d6638465102a254,73:6' }
  known.set(stale.id, stale)
  const sticky = text('1:4', stale.id)
  sticky.setTextStyleIdAsync = async () => undefined
  nodes.set(sticky.id, sticky)
  const unstuck = (await op.run({ assignments: [{ node: '1:4', field: 'text', style: body4.id }] })) as Report
  assert.equal(unstuck.results[0].verified, false)

  const bare = (await op.run({ assignments: [{ node: '1:3', field: 'text', like: '1:2' }, { node: '1:3', field: 'text' }] })) as Report
  assert.equal(bare.applied, 1, 'like copies whatever the model has now')
  assert.match(String(bare.results[1].error), /missing "style"/)
})
