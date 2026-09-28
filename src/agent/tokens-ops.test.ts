// `ops.ts` first — the registry and the op modules import each other (see context-ops.test.ts).
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'

/** One colour that differs between themes and one length that does not — enough for every
 *  emitter to have something to say, on all three platforms. */
const SNAPSHOT = {
  collections: [
    {
      id: 'c1',
      name: 'Theme',
      modes: [
        { modeId: 'm1', name: 'Light' },
        { modeId: 'm2', name: 'Dark' },
      ],
      defaultModeId: 'm1',
      variableIds: ['v1', 'v2'],
    },
  ],
  variables: [
    {
      id: 'v1',
      name: 'text/primary',
      resolvedType: 'COLOR',
      variableCollectionId: 'c1',
      valuesByMode: {
        m1: { r: 0.06, g: 0.06, b: 0.06, a: 1 },
        m2: { r: 1, g: 1, b: 1, a: 1 },
      },
    },
    {
      id: 'v2',
      name: 'space/md',
      resolvedType: 'FLOAT',
      variableCollectionId: 'c1',
      valuesByMode: { m1: 16, m2: 16 },
    },
  ],
}

function setFigma() {
  ;(globalThis as { figma?: unknown }).figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => SNAPSHOT.collections,
      getLocalVariablesAsync: async () => SNAPSHOT.variables,
      getVariableByIdAsync: async (id: string) => SNAPSHOT.variables.find((v) => v.id === id) ?? null,
      getVariableCollectionByIdAsync: async (id: string) =>
        SNAPSHOT.collections.find((c) => c.id === id) ?? null,
    },
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalPaintStylesAsync: async () => [],
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => [],
    },
  }
}
async function emit(platform: string) {
  const op = OPS_BY_NAME.get('tokens.emit')!
  return (await op.run({
    platform,
    library: false,
    inlinePrimitives: true,
    themeAttribute: 'data-theme',
  })) as {
    platform: string
    themes: string[]
    manifest: Array<{ file: string; path: string }>
  }
}

/** Where each file belongs in the repository — the flat basenames the bridge hands back say
 *  nothing about layout, the manifest does. */
function paths(result: { manifest: Array<{ path: string }> }): string[] {
  return result.manifest.map((entry) => entry.path)
}

test('the platform decides the files, not the panel', async () => {
  setFigma()
  const web = await emit('web')
  const ios = await emit('ios')
  const android = await emit('android')

  assert.ok(paths(web).some((name) => name.endsWith('tokens.css')))
  assert.equal(paths(web).some((name) => name.endsWith('Tokens.swift')), false)

  // iOS themes below the language: a colourset, not a Swift literal the app has to branch on.
  assert.ok(paths(ios).some((name) => name.endsWith('Contents.json')))
  assert.ok(paths(ios).some((name) => name.endsWith('Tokens.swift')))

  assert.ok(paths(android).some((name) => name.endsWith('Tokens.kt')))
  assert.ok(paths(android).some((name) => name.includes('colors.xml')))
})

test('every platform at once is the union, and the themes are reported', async () => {
  setFigma()
  const all = await emit('all')

  assert.deepEqual(all.themes, ['Light', 'Dark'])
  for (const expected of ['tokens.css', 'Tokens.swift', 'Tokens.kt']) {
    assert.ok(paths(all).some((name) => name.endsWith(expected)), `missing ${expected}`)
  }
})
