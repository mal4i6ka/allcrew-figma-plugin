import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_OPS,
  auditVariables,
  classifyModeColumns,
  expectedPageOrder,
  isLibraryId,
  planCollectionUpdates,
  planPageUpdates,
  resolveMode,
} from './admin-ops.ts'

interface Fixture {
  collections: VariableCollection[]
  variables: Variable[]
  pages?: PageNode[]
  getVariable?: (id: string) => Promise<Variable | null>
}

const op = (name: string) => ADMIN_OPS.find((entry) => entry.name === name)!

function install(t: test.TestContext, fixture: Fixture): void {
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => fixture.collections,
      getVariableCollectionByIdAsync: async (id: string) =>
        fixture.collections.find((entry) => entry.id === id) ?? null,
      getLocalVariablesAsync: async () => fixture.variables,
      getVariableByIdAsync: fixture.getVariable ?? (async (id: string) => fixture.variables.find((variable) => variable.id === id) ?? null),
    },
    root: { children: fixture.pages ?? [] },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })
}

function collection(
  overrides: Partial<VariableCollection> & { modes?: Array<{ modeId: string; name: string }> } = {}
): VariableCollection {
  return {
    id: 'VariableCollectionId:1:1',
    key: 'collection-key',
    name: 'Semantic',
    remote: false,
    isExtension: false,
    hiddenFromPublishing: false,
    defaultModeId: 'm1',
    modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }],
    variableIds: [],
    ...overrides,
  } as VariableCollection
}

function variable(overrides: Partial<Variable> = {}): Variable {
  return {
    id: 'VariableID:1:1',
    name: 'surface/default',
    variableCollectionId: 'VariableCollectionId:1:1',
    resolvedType: 'COLOR',
    remote: false,
    valuesByMode: { m1: '#fff', m2: '#000' },
    ...overrides,
  } as unknown as Variable
}

function page(id: string, name: string, children = 0): PageNode {
  return {
    id,
    name,
    type: 'PAGE',
    children: Array.from({ length: children }, (_, index) => ({ id: `${id}:${index}` })),
    loadAsync: async () => {},
    findAllWithCriteria: () => [],
  } as unknown as PageNode
}

test('collection mode steps are simulated in order and catch a rename/add collision', async (t) => {
  install(t, { collections: [collection()], variables: [] })
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', modes: [{ mode: 'Dark', newName: 'Night' }, { add: 'Night' }] }]),
    /already exists/
  )
})

test('the default mode cannot be removed even with force', async (t) => {
  install(t, { collections: [collection()], variables: [] })
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', modes: [{ mode: 'Light', remove: true }] }], true),
    /default mode/
  )
})

test('the last mode cannot be removed', async (t) => {
  install(t, { collections: [collection({ modes: [{ modeId: 'm2', name: 'Dark' }], defaultModeId: 'm1' })], variables: [] })
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', modes: [{ mode: 'Dark', remove: true }] }], true),
    /last mode/
  )
})

test('mode removal refuses data loss without force and reports it with force', async (t) => {
  const token = variable()
  const coll = collection({ variableIds: [token.id] })
  install(t, { collections: [coll], variables: [token] })
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', modes: [{ mode: 'Dark', remove: true }] }]),
    /1 value/
  )
  const plan = await planCollectionUpdates([{ collection: 'Semantic', modes: [{ mode: 'Dark', remove: true }] }], true)
  assert.equal(plan[0].modes[0].lostValues, 1)
  assert.deepEqual(plan[0].modes[0].lostVariables, ['surface/default'])
})

test('non-empty collection removal requires force', async (t) => {
  const token = variable()
  install(t, { collections: [collection({ variableIds: [token.id] })], variables: [token] })
  await assert.rejects(() => planCollectionUpdates([{ collection: 'Semantic', remove: true }]), /contains 1 variables/)
  assert.equal((await planCollectionUpdates([{ collection: 'Semantic', remove: true }], true))[0].remove, true)
})

test('an extended collection cannot add a mode', async (t) => {
  install(t, { collections: [collection({ isExtension: true })], variables: [] })
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', modes: [{ add: 'Contrast' }] }]),
    /extended collection/
  )
})

test('a page with content requires force and reports component count', async (t) => {
  const filled = page('1:1', 'Filled', 2)
  filled.findAllWithCriteria = (() => [{ id: 'component' }]) as PageNode['findAllWithCriteria']
  const spare = page('2:1', 'Spare')
  install(t, { collections: [], variables: [], pages: [filled, spare] })
  await assert.rejects(() => planPageUpdates([{ page: 'Filled', remove: true }]), /contains 2 top-level/)
  const plan = await planPageUpdates([{ page: 'Filled', remove: true }], true)
  assert.equal(plan[0].before.components, 1)
})

test('the last page cannot be removed', async (t) => {
  install(t, { collections: [], variables: [], pages: [page('1:1', 'Only')] })
  await assert.rejects(() => planPageUpdates([{ page: 'Only', remove: true }], true), /last page/)
})

test('one page cannot occur twice in an atomic batch', async (t) => {
  install(t, { collections: [], variables: [], pages: [page('1:1', 'One'), page('2:1', 'Two')] })
  await assert.rejects(
    () => planPageUpdates([{ page: 'One', newName: 'A' }, { page: '1:1', index: 1 }]),
    /occurs more than once/
  )
})

test('audit distinguishes mixed aliases, missing modes and alias-only literals', async (t) => {
  const mixed = variable({
    id: 'VariableID:1:2',
    name: 'surface/mixed',
    valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:9' }, m2: '#000' },
  })
  const missing = variable({ id: 'VariableID:1:3', name: 'surface/missing', valuesByMode: { m1: '#fff' } })
  const literal = variable({ id: 'VariableID:1:4', name: 'surface/literal' })
  const target = variable({ id: 'VariableID:1:9', name: 'primitive/base' })
  install(t, {
    collections: [collection({ variableIds: [mixed.id, missing.id, literal.id, target.id] })],
    variables: [mixed, missing, literal, target],
  })
  const result = await auditVariables({ aliasOnly: ['Semantic'] })
  assert.deepEqual(result.counts, { MIXED: 1, MISSING_MODE: 1, LITERAL: 3 })
})

test('an absent local alias is unresolved without touching the network', async (t) => {
  let reads = 0
  const broken = variable({ valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' }, m2: '#000' } })
  install(t, {
    collections: [collection({ variableIds: [broken.id] })],
    variables: [broken],
    getVariable: async () => { reads++; return null },
  })
  const result = await auditVariables({ libraries: true })
  assert.equal(reads, 0)
  assert.equal((result.counts as Record<string, number>).UNRESOLVED_ALIAS, 1)
})

test('a library read failure is unread, never a false unresolved alias', async (t) => {
  const remote = variable({ valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:0123456789012345678901234567890123456789/1:2' }, m2: '#000' } })
  install(t, {
    collections: [collection({ variableIds: [remote.id] })],
    variables: [remote],
    getVariable: async () => { throw new Error('Unable to establish connection') },
  })
  const result = await auditVariables({ libraries: true })
  assert.equal((result.libraries as Record<string, unknown>).errors, 1)
  assert.equal((result.counts as Record<string, number>).UNRESOLVED_ALIAS, undefined)
  assert.equal(result.clean, false)
})

test('collection and mode names resolve case-insensitively and conflicting changes are refused', async (t) => {
  install(t, {
    collections: [
      collection(),
      collection({ id: 'VariableCollectionId:2:1', key: 'other-key', name: 'Primitives' }),
    ],
    variables: [],
  })
  const plan = await planCollectionUpdates([
    { collection: 'semantic', modes: [{ mode: 'dark', newName: 'Night' }] },
  ])
  assert.equal(plan[0].modes[0].before, 'Dark')
  assert.equal(resolveMode(collection().modes, 'LIGHT', 'mode').modeId, 'm1')
  await assert.rejects(
    () => planCollectionUpdates([{ collection: 'Semantic', newName: 'primitives' }]),
    /already exists/
  )
  await assert.rejects(
    () => planCollectionUpdates([
      { collection: 'Semantic', modes: [{ mode: 'Dark', remove: true, newName: 'Night' }] },
    ], true),
    /cannot combine/
  )
})

test('collections.update verifies each mode change from a fresh collection read', async (t) => {
  const live = collection()
  live.renameMode = ((modeId: string, name: string) => {
    live.modes.find((mode) => mode.modeId === modeId)!.name = name
  }) as VariableCollection['renameMode']
  live.addMode = ((name: string) => {
    live.modes.push({ modeId: 'm3', name })
    return 'm3'
  }) as VariableCollection['addMode']
  live.removeMode = ((modeId: string) => {
    live.modes = live.modes.filter((mode) => mode.modeId !== modeId)
  }) as VariableCollection['removeMode']
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    commitUndo() {},
    variables: {
      getLocalVariableCollectionsAsync: async () => [live],
      getLocalVariablesAsync: async () => [],
    },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })
  const result = await op('collections.update').run({
    collections: [{
      collection: 'semantic',
      modes: [{ mode: 'light', newName: 'Day' }, { add: 'Contrast' }, { mode: 'dark', remove: true }],
    }],
  }) as { failed: number; results: Array<{ ok: boolean }> }
  assert.equal(result.failed, 0)
  assert.equal(result.results[0].ok, true)
})

test('page order verification follows sequential moves and deletion chooses a surviving refuge', async (t) => {
  const pages = [page('1:1', 'One'), page('2:1', 'Two'), page('3:1', 'Three')]
  const root = {
    children: pages,
    insertChild(index: number, moved: PageNode) {
      this.children = this.children.filter((candidate) => candidate !== moved)
      this.children.splice(index, 0, moved)
    },
  }
  for (const candidate of pages) {
    candidate.remove = (() => {
      root.children = root.children.filter((entry) => entry !== candidate)
    }) as PageNode['remove']
  }
  let current = pages[0]
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    commitUndo() {},
    root,
    get currentPage() { return current },
    async setCurrentPageAsync(next: PageNode) { current = next },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })
  const result = await op('pages.update').run({
    pages: [
      { page: 'One', remove: true },
      { page: 'Two', remove: true },
      { page: 'Three', index: 0 },
    ],
    force: true,
  }) as { failed: number }
  assert.equal(result.failed, 0)
  assert.equal(current.id, '3:1')

  assert.deepEqual(
    expectedPageOrder(['a', 'b', 'c'], [
      { id: 'b', before: { name: 'b', index: 1, children: 0, components: 0 }, index: 0, remove: false },
      { id: 'c', before: { name: 'c', index: 2, children: 0, components: 0 }, index: 0, remove: false },
    ]),
    ['c', 'b', 'a']
  )
})

test('variables.extend validates every row before creating and edits an existing extension by key', async (t) => {
  const token = variable({
    id: 'VariableID:1:7',
    key: '0123456789012345678901234567890123456789',
    resolvedType: 'FLOAT',
    valuesByMode: { m1: 1, m2: 2 },
    scopes: [],
  })
  const overrides: Record<string, Record<string, VariableValue>> = {}
  token.setValueForMode = ((modeId: string, value: VariableValue) => {
    overrides[token.id] ??= {}
    overrides[token.id][modeId] = value
  }) as Variable['setValueForMode']
  token.removeOverrideForMode = ((modeId: string) => {
    delete overrides[token.id]?.[modeId]
  }) as Variable['removeOverrideForMode']
  const extension = collection({
    id: 'VariableCollectionId:1:9',
    key: 'extension-key',
    name: 'Brand',
    isExtension: true,
    variableIds: [token.id],
  }) as ExtendedVariableCollection
  Object.assign(extension, {
    parentVariableCollectionId: 'VariableCollectionId:1:1',
    rootVariableCollectionId: 'VariableCollectionId:1:1',
    variableOverrides: overrides,
    removeOverridesForVariable(target: Variable) { delete overrides[target.id] },
  })
  let creations = 0
  const source = collection({ variableIds: [token.id] })
  source.extend = (() => { creations++; return extension }) as VariableCollection['extend']
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    commitUndo() {},
    variables: {
      getLocalVariableCollectionsAsync: async () => [source, extension],
      getLocalVariablesAsync: async () => [token],
      getVariableCollectionByIdAsync: async (id: string) => id === extension.id ? extension : source,
      getVariableByIdAsync: async (id: string) => id === token.id ? token : null,
      importVariableByKeyAsync: async (key: string) => key === token.key ? token : Promise.reject(new Error('missing')),
    },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })

  await assert.rejects(
    () => op('variables.extend').run({
      source: 'Semantic',
      name: 'Bad',
      overrides: [{ variable: 'missing/token', mode: 'Dark', value: 3 }],
    }),
    /no variable/
  )
  assert.equal(creations, 0)

  const result = await op('variables.extend').run({
    collection: 'brand',
    overrides: [{ variable: token.key, mode: 'dark', value: 3 }],
  }) as { created: boolean; extension: { overrides: Array<{ variable: string; mode: string }> } }
  assert.equal(result.created, false)
  assert.deepEqual(result.extension.overrides.map((entry) => [entry.variable, entry.mode]), [['surface/default', 'Dark']])
})

test('variables.audit follows library aliases, reports all kinds and skips single-mode collections by default', async (t) => {
  const remoteId = 'VariableID:0123456789012345678901234567890123456789/1:2'
  const local = variable({
    id: 'VariableID:1:2',
    valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: remoteId }, m2: '#000' },
  })
  const remote = variable({
    id: remoteId,
    name: 'library/mixed',
    variableCollectionId: 'VariableCollectionId:remote',
    remote: true,
    valuesByMode: { r1: 1, r2: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } },
  })
  const localCollection = collection({ variableIds: [local.id] })
  const remoteCollection = collection({
    id: 'VariableCollectionId:remote',
    key: 'remote-key',
    name: 'Library',
    remote: true,
    modes: [{ modeId: 'r1', name: 'Day' }, { modeId: 'r2', name: 'Night' }],
    variableIds: [remote.id],
  })
  const single = collection({
    id: 'VariableCollectionId:single',
    key: 'single-key',
    name: 'Solo',
    modes: [{ modeId: 'only', name: 'Only' }],
    variableIds: [],
  })
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [localCollection, single],
      getLocalVariablesAsync: async () => [local],
      getVariableByIdAsync: async (id: string) => id === remoteId ? remote : null,
      getVariableCollectionByIdAsync: async (id: string) => id === remoteCollection.id ? remoteCollection : null,
    },
  }
  t.after(() => { ;(globalThis as unknown as { figma: unknown }).figma = previous })
  const result = await auditVariables({ collections: ['semantic'] })
  const findings = result.findings as Array<{ collection: string; kinds: string[]; values: Record<string, string> }>
  assert.ok(findings.some((finding) => finding.collection === 'Semantic' && finding.kinds.includes('MIXED')))
  assert.ok(findings.some((finding) => finding.collection === 'Library' && finding.kinds.includes('MIXED')))
  assert.equal((result.collections as Array<{ collection: string }>).some((entry) => entry.collection === 'Library'), true)

  const all = await auditVariables({ libraries: false })
  assert.equal(
    (all.collections as Array<{ collection: string; skipped?: string }>).find((entry) => entry.collection === 'Solo')?.skipped,
    'single mode'
  )
  assert.deepEqual(
    classifyModeColumns({ m1: { type: 'VARIABLE_ALIAS', id: 'x' } }, ['m1', 'm2'], new Set(['x'])),
    ['MISSING_MODE', 'UNRESOLVED_ALIAS']
  )
  assert.equal(isLibraryId(remoteId), true)
})

/* ------------------------------------------------------------ merging */

const aliasTo = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
const setFigma = (mock: Record<string, unknown>) => {
  ;(globalThis as { figma?: unknown }).figma = mock
}

function fakeVariablesFile() {
  const vars = new Map<string, any>()
  const cols: any[] = []
  let n = 0
  const collection = (id: string, name: string, modes: Array<[string, string]>) => {
    const c: any = {
      id, name, remote: false, defaultModeId: modes[0][0], modes: modes.map(([modeId, name]) => ({ modeId, name })),
      renameMode(modeId: string, to: string) { this.modes.find((m: any) => m.modeId === modeId).name = to },
      addMode(to: string) { const modeId = `${id}:m${this.modes.length}`; this.modes.push({ modeId, name: to }); return modeId },
    }
    cols.push(c)
    return c
  }
  const variable = (id: string, name: string, col: any, type: string, valuesByMode: Record<string, unknown>) => {
    const v: any = {
      id, name, variableCollectionId: col.id, resolvedType: type, valuesByMode: { ...valuesByMode }, scopes: ['ALL_SCOPES'], description: '', hiddenFromPublishing: false, codeSyntax: {},
      setValueForMode(modeId: string, value: unknown) { this.valuesByMode[modeId] = value },
      setVariableCodeSyntax(platform: string, value: string) { this.codeSyntax[platform] = value },
    }
    vars.set(id, v)
    return v
  }
  const o = collection('C:one', 'One', [['o:0', 'Light'], ['o:1', 'Dark']])
  const b = collection('C:biz', 'Business', [['b:0', 'Light'], ['b:1', 'Dark']])
  variable('V:o1', 'background/base', o, 'COLOR', { 'o:0': aliasTo('P:white'), 'o:1': aliasTo('P:black') })
  variable('V:o2', 'background/raised', o, 'COLOR', { 'o:0': aliasTo('V:o1'), 'o:1': aliasTo('V:o1') }) // points inside One
  variable('V:b1', 'background/base', b, 'COLOR', { 'b:0': aliasTo('P:white'), 'b:1': aliasTo('P:ink') })
  setFigma({
    commitUndo() {},
    variables: {
      async getLocalVariableCollectionsAsync() { return cols },
      async getVariableCollectionByIdAsync(id: string) { return cols.find((c) => c.id === id) ?? null },
      async getLocalVariablesAsync() { return [...vars.values()] },
      async getVariableByIdAsync(id: string) { return vars.get(id) ?? null },
      createVariableCollection(name: string) { return collection(`C:new${++n}`, name, [[`new${n}:0`, 'Mode 1']]) },
      createVariable(name: string, col: any, type: string) { return variable(`V:new${++n}`, name, col, type, {}) },
    },
  })
  return { vars, cols }
}

const MERGE = {
  into: 'Product',
  sources: [
    { collection: 'One', modes: { Light: 'One Light', Dark: 'One Dark' } },
    { collection: 'Business', modes: { Light: 'Business Light', Dark: 'Business Dark' } },
  ],
  fill: { 'Business Light': 'One Light', 'Business Dark': 'One Dark' },
  seed: [{ mode: 'Platform Light', from: 'Business Light' }],
}

test('collections.merge writes one collection, re-aims inner aliases, leaves the sources alone and hands back the rebind map', async () => {
  const { vars, cols } = fakeVariablesFile()
  const dry = (await op('collections.merge').run({ ...MERGE, dryRun: true })) as any
  assert.equal(dry.dryRun, true)
  assert.equal(cols.length, 2, 'a dry run creates nothing')
  assert.deepEqual(dry.filled.map((f: any) => `${f.name}@${f.mode}`), ['background/raised@Business Light', 'background/raised@Business Dark'])

  const done = (await op('collections.merge').run(MERGE)) as any
  assert.equal(done.ok, true, JSON.stringify(done.mismatches))
  const product = cols.find((c) => c.name === 'Product')
  assert.deepEqual(product.modes.map((m: any) => m.name), ['One Light', 'One Dark', 'Business Light', 'Business Dark', 'Platform Light'], 'no "Mode 1" fossil')
  const merged = [...vars.values()].filter((v) => v.variableCollectionId === product.id)
  assert.deepEqual(merged.map((v) => v.name).sort(), ['background/base', 'background/raised'])
  const base = merged.find((v) => v.name === 'background/base')
  const raised = merged.find((v) => v.name === 'background/raised')
  const modeId = (name: string) => product.modes.find((m: any) => m.name === name).modeId
  assert.deepEqual(base.valuesByMode[modeId('Business Dark')], aliasTo('P:ink'))
  assert.deepEqual(raised.valuesByMode[modeId('One Dark')], aliasTo(base.id), 'an alias inside One now points at the merged variable')
  assert.deepEqual(raised.valuesByMode[modeId('Platform Light')], aliasTo(base.id))
  assert.deepEqual(vars.get('V:o2').valuesByMode, { 'o:0': aliasTo('V:o1'), 'o:1': aliasTo('V:o1') }, 'the source is untouched')
  assert.deepEqual(done.rebind.find((r: any) => r.from === 'V:b1'), { from: 'V:b1', fromName: 'background/base', to: base.id })

  await assert.rejects(op('collections.merge').run(MERGE), /already exists — pass update: true/)
  const again = (await op('collections.merge').run({ ...MERGE, update: true })) as any
  assert.equal(again.created, 0)
  assert.equal(again.updated, 2)
})

test('collections.merge refuses holes unless told, and writes nothing when it does', async () => {
  const { cols } = fakeVariablesFile()
  await assert.rejects(op('collections.merge').run({ ...MERGE, fill: undefined }), /3 cell\(s\) would have no value/)
  assert.equal(cols.length, 2)
})
