import test from 'node:test'
import assert from 'node:assert/strict'
import { figmaSettingsPath, keyFromTabPath, matchTab, parseDesktopTabs, runRecentHistory } from './desktop-tabs.mjs'

test('desktop settings parser reads open tabs and shared history without trusting malformed rows', () => {
  const parsed = parseDesktopTabs({
    windows: [{ tabs: [{ path: '/file/abcdefghijklmnopqrstuv', title: 'Cards', editorType: 'design', editedAt: 20 }, null] }],
    sharedTabHistory: [{ path: '/design/zyxwvutsrqponmlkjihgfe/Name', title: 'Past', dateClosed: '2026-10-01T05:00:00Z' }, { nope: true }],
  })
  assert.deepEqual(parsed.open.map((tab) => tab.key), ['abcdefghijklmnopqrstuv'])
  assert.deepEqual(parsed.recent.map((tab) => tab.key), ['zyxwvutsrqponmlkjihgfe'])
})

test('a branch path chooses the branch key rather than the base file key', () => {
  assert.deepEqual(
    keyFromTabPath('/design/aaaaaaaaaaaaaaaaaaaaaa/branch/bbbbbbbbbbbbbbbbbbbbbb/Cards'),
    { key: 'bbbbbbbbbbbbbbbbbbbbbb', isBranch: true }
  )
})

test('settings path follows platform conventions and accepts an override', () => {
  assert.equal(figmaSettingsPath('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/Figma/settings.json')
  assert.equal(figmaSettingsPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\Figma\\settings.json')
  assert.equal(figmaSettingsPath('linux', { ALLCREW_CHANNEL_FIGMA_SETTINGS: '/tmp/figma.json' }, '/home/a'), '/tmp/figma.json')
})

test('one matching title resolves without a REST request', async () => {
  let reads = 0
  const found = await matchTab(
    { title: 'Cards', pages: [] },
    [{ key: 'one', title: 'Cards' }],
    async () => { reads++; return [] }
  )
  assert.equal(found.key, 'one')
  assert.equal(found.via, 'desktop-title')
  assert.equal(reads, 0)
})

test('same-titled files are disambiguated only by the full page identity set', async () => {
  const found = await matchTab(
    { title: 'Cards', pages: [{ id: '1:1', name: 'One' }, { id: '2:1', name: 'Two' }] },
    [{ key: 'a', title: 'Cards' }, { key: 'b', title: 'Cards' }],
    async (key) => key === 'b'
      ? [{ id: '2:1', name: 'Two' }, { id: '1:1', name: 'One' }]
      : [{ id: '9:1', name: 'Other' }]
  )
  assert.equal(found.key, 'b')
  assert.equal(found.via, 'desktop-pages')
})

test('history.recent groups touched, quiet and unavailable files and aggregates authors', async () => {
  const base = Date.parse('2026-10-01T12:00:00Z')
  const tabs = {
    open: [{ key: 'a', title: 'Alpha', open: true }],
    recent: [{ key: 'b', title: 'Beta', open: false }, { key: 'c', title: 'Gamma', open: false }],
  }
  const result = await runRecentHistory(
    { since: '2026-10-01T00:00:00Z' },
    {
      tabs,
      now: () => base,
      fileMeta: async (key) => ({ name: key.toUpperCase() }),
      listVersions: async (key) => {
        if (key === 'c') throw new Error('HTTP 403')
        if (key === 'b') return [{ id: 'old', created_at: '2026-09-30T23:00:00Z', user: { handle: 'Old' } }]
        return [
          { id: '1', created_at: '2026-10-01T10:00:00Z', user: { handle: 'Alex' }, label: 'Checkpoint' },
          { id: '2', created_at: '2026-10-01T09:00:00Z', user: { handle: 'Alex' } },
        ]
      },
    }
  )
  assert.equal(result.touched[0].name, 'A')
  assert.equal(result.touched[0].checkpoints, 2)
  assert.equal(result.quiet[0].fileKey, 'b')
  assert.equal(result.unavailable[0].fileKey, 'c')
  assert.deepEqual(result.authors, [{ author: 'Alex', checkpoints: 2 }])
})
