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

/* ------------------------------------------------------------ the file's own token config */

function setFigmaWithRoot(options: { readOnly?: boolean } = {}) {
  setFigma()
  const store = new Map<string, string>()
  ;(globalThis as { figma: Record<string, unknown> }).figma.root = {
    getSharedPluginData: (ns: string, key: string) => store.get(`${ns}:${key}`) ?? '',
    setSharedPluginData: (ns: string, key: string, value: string) => {
      if (options.readOnly) throw new Error('Cannot call setSharedPluginData in read-only mode')
      store.set(`${ns}:${key}`, value)
    },
  }
  return store
}

test('tokens.configure pins the file\'s token settings, verifies them, and previews the themes', async () => {
  const store = setFigmaWithRoot()
  const op = OPS_BY_NAME.get('tokens.configure')!
  const read = (await op.run({})) as { before: unknown; after: unknown; changed: boolean }
  assert.equal(read.before, null)
  assert.equal(read.changed, false)

  const dry = (await op.run({ set: { slugThemes: true, themeAttribute: 'data-theme-name' }, dryRun: true })) as any
  assert.equal(store.size, 0, 'a dry run writes nothing')
  assert.deepEqual(dry.preview.themes, ['light', 'dark'])
  assert.equal(dry.preview.selector, '[data-theme-name="light"]')

  const done = (await op.run({ set: { slugThemes: true, themeAttribute: 'data-theme-name', collectionRoles: 'Theme: themes, Nope: hidden' } })) as any
  assert.equal(done.verified, true)
  assert.deepEqual(JSON.parse(store.get('allcrewChannel:tokenExport')!), { slugThemes: true, themeAttribute: 'data-theme-name', collectionRoles: 'Theme: themes, Nope: hidden' })
  assert.deepEqual(done.preview.unknownCollections, ['Nope'], 'a role naming no collection is pointed out')

  // null unpins one field; a bad value refuses the whole call.
  const unpinned = (await op.run({ set: { themeAttribute: null } })) as any
  assert.equal('themeAttribute' in unpinned.after, false)
  await assert.rejects(op.run({ set: { slugThemes: 'yes' } }), /nothing was written: "slugThemes" must be true or false/)
  await assert.rejects(op.run({ set: { delivery: 'git' } }), /unknown setting "delivery"/)

  const cleared = (await op.run({ clear: true })) as any
  assert.equal(cleared.after, null)
  assert.equal(store.get('allcrewChannel:tokenExport'), '')
})

test('tokens.configure says plainly when the file is read-only', async () => {
  setFigmaWithRoot({ readOnly: true })
  await assert.rejects(OPS_BY_NAME.get('tokens.configure')!.run({ set: { slugThemes: true } }), /read-only here \(Dev Mode or view access\)/)
})

test('tokens.emit builds with the file\'s config unless the call says otherwise', async () => {
  const store = setFigmaWithRoot()
  store.set('allcrewChannel:tokenExport', JSON.stringify({ slugThemes: true, themeAttribute: 'data-theme-name' }))
  const op = OPS_BY_NAME.get('tokens.emit')!
  const pinned = (await op.run({ platform: 'web', library: false })) as any
  assert.deepEqual(pinned.themes, ['light', 'dark'])
  assert.deepEqual(pinned.fileConfig, { slugThemes: true, themeAttribute: 'data-theme-name' })
  const own = (await op.run({ platform: 'web', library: false, fileConfig: false })) as any
  assert.deepEqual(own.themes, ['Light', 'Dark'])
  assert.equal(own.fileConfig, undefined)
})
