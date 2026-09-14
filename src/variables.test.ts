import test from 'node:test'
import assert from 'node:assert/strict'
import { readLibraryVariables } from './variables.ts'

/**
 * The sweep is network-bound by construction — one round trip per variable — so what is worth
 * pinning is not the values it returns but the three promises it makes about COST: it imports
 * only the collection it was asked for, it stops when the budget runs out, and it says where to
 * resume in units a caller can pass straight back.
 */

interface FakeVariable {
  key: string
  name: string
}

function setFigma(collections: Array<{ key: string; name: string; variables: FakeVariable[] }>, onImport?: () => void) {
  const byKey = new Map(collections.map((entry) => [entry.key, entry]))
  ;(globalThis as { figma?: unknown }).figma = {
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => collections.map(({ key, name }) => ({ key, name })),
      getVariablesInLibraryCollectionAsync: async (key: string) => byKey.get(key)?.variables ?? [],
    },
    variables: {
      importVariableByKeyAsync: async (key: string) => {
        onImport?.()
        return {
          id: `VariableID:${key}`,
          key,
          name: key,
          variableCollectionId: 'VariableCollectionId:1',
          scopes: [],
          resolvedType: 'COLOR',
          valuesByMode: {},
        }
      },
      getVariableCollectionByIdAsync: async () => ({
        id: 'VariableCollectionId:1',
        name: 'Palette',
        defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Mode 1' }],
      }),
    },
  }
}

const palette = (name: string, key: string, count: number) => ({
  key,
  name,
  variables: Array.from({ length: count }, (_, index) => ({ key: `${key}-${index}`, name: `${name}/${index}` })),
})

test('naming a collection imports that one and not the other eight', async () => {
  // The filter used to run on the result, which still paid for every library on the file —
  // the difference between one palette and a four-hundred-second sweep.
  let imported = 0
  setFigma([palette('Colour', 'c1', 3), palette('Typography', 'c2', 5)], () => (imported += 1))

  const snapshot = await readLibraryVariables({ collection: 'Colour' })

  assert.equal(imported, 3)
  assert.equal(snapshot.variables.length, 3)
  assert.equal(snapshot.nextOffset, undefined, 'it finished, so there is nothing to resume')
})

test('a collection can be named by key as well as by name', async () => {
  setFigma([palette('Colour', 'c1', 2), palette('Typography', 'c2', 2)])

  const snapshot = await readLibraryVariables({ collection: 'c2' })

  assert.deepEqual(snapshot.variables.map((entry) => entry.key), ['c2-0', 'c2-1'])
})

test('a sweep that runs out of budget answers with what it read and where to resume', async () => {
  // The alternative is the one that actually happened: a call that dies at the bridge ceiling
  // after four minutes with nothing at all.
  const realNow = Date.now
  let offsetMs = 0
  Date.now = () => realNow() + offsetMs
  try {
    setFigma([palette('Colour', 'c1', 10)], () => (offsetMs += 400))

    const snapshot = await readLibraryVariables({ budgetMs: 1000 })

    assert.ok(snapshot.variables.length > 0 && snapshot.variables.length < 10)
    assert.equal(snapshot.stoppedOn, 'budgetMs')
    assert.equal(snapshot.nextOffset, snapshot.variables.length)
  } finally {
    Date.now = realNow
  }
})

test('resuming from nextOffset picks up exactly where the last call stopped', async () => {
  setFigma([palette('Colour', 'c1', 6)])

  const second = await readLibraryVariables({ offset: 4 })

  assert.deepEqual(second.variables.map((entry) => entry.key), ['c1-4', 'c1-5'])
})

test('a library service that refuses answers empty rather than throwing', async () => {
  // A file with no library access is a normal file; the export that needs nothing but local
  // variables must not fail because the team-library endpoint said no.
  ;(globalThis as { figma?: unknown }).figma = {
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => {
        throw new Error('no permission')
      },
    },
  }

  const snapshot = await readLibraryVariables()

  assert.deepEqual(snapshot, { collections: [], variables: [] })
})
