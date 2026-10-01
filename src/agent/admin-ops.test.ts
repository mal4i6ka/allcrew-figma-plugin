import test from 'node:test'
import assert from 'node:assert/strict'
import { auditVariables, planCollectionUpdates, planPageUpdates } from './admin-ops.ts'

interface Fixture {
  collections: VariableCollection[]
  variables: Variable[]
  pages?: PageNode[]
  getVariable?: (id: string) => Promise<Variable | null>
}

function install(t: test.TestContext, fixture: Fixture): void {
  const previous = globalThis.figma
  ;(globalThis as unknown as { figma: unknown }).figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => fixture.collections,
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
  install(t, { collections: [collection()], variables: [mixed, missing, literal, target] })
  const result = await auditVariables({ aliasOnly: ['Semantic'] })
  assert.deepEqual(result.counts, { MIXED: 1, MISSING_MODE: 1, LITERAL: 3 })
})

test('an absent local alias is unresolved without touching the network', async (t) => {
  let reads = 0
  const broken = variable({ valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' }, m2: '#000' } })
  install(t, { collections: [collection()], variables: [broken], getVariable: async () => { reads++; return null } })
  const result = await auditVariables({ libraries: true })
  assert.equal(reads, 0)
  assert.equal((result.counts as Record<string, number>).UNRESOLVED_ALIAS, 1)
})

test('a library read failure is unread, never a false unresolved alias', async (t) => {
  const remote = variable({ valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:0123456789012345678901234567890123456789/1:2' }, m2: '#000' } })
  install(t, { collections: [collection()], variables: [remote], getVariable: async () => { throw new Error('Unable to establish connection') } })
  const result = await auditVariables({ libraries: true })
  assert.equal((result.libraries as Record<string, unknown>).errors, 1)
  assert.equal((result.counts as Record<string, number>).UNRESOLVED_ALIAS, undefined)
  assert.equal(result.clean, false)
})
