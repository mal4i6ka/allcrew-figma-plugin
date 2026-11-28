import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ATTRIBUTE_SOURCES, COLLECTION_ROLES, ROLE_LABELS, mappingToSettings } from '../../tokens/mapping.ts'
import { parseCollectionModes } from '../../tokens/engine.ts'

/**
 * The Tokens screen in Settings is a hand-written menu over the mapping. A role or a source the
 * menu offers but `normalizeMapping` refuses is shown as chosen and then fails to save; a label
 * that drifts from ROLE_LABELS tells the person one thing and the agent another. This keeps the
 * menus honest.
 */
const ui = readFileSync(new URL('../../../ui.html', import.meta.url), 'utf8')
const menu = (name: string) => {
  const block = new RegExp(`var ${name} = \\[([\\s\\S]*?)\\n\\s*\\]`).exec(ui)
  assert.ok(block, `${name} in ui.html`)
  return [...block[1].matchAll(/\['([a-z]+)', '([^']+)'\]/g)].map((m) => [m[1], m[2].replace(/\\u2014/g, '—')])
}

test('the Tokens screen offers exactly the mapping\'s collection roles, under the names the mapping gives them', () => {
  const offered = menu('MAP_ROLES')
  assert.deepEqual(offered.map(([role]) => role), [...COLLECTION_ROLES])
  for (const [role, label] of offered) assert.equal(label, ROLE_LABELS[role as keyof typeof ROLE_LABELS], role)
})

test('the Tokens screen offers exactly the sources an attribute can take its values from', () => {
  assert.deepEqual(menu('MAP_SOURCES').map(([source]) => source), [...ATTRIBUTE_SOURCES])
})

test('every collection role reaches the engine as a role it reads, and columns read off one collection make it the themes', () => {
  const settings = mappingToSettings({
    version: 1,
    attributes: [{ name: 'data-theme', from: 'columns', collections: ['Product'], values: [{ value: 'light', columns: ['Light'] }, { value: 'dark', columns: ['Dark'] }] }],
    collections: { Colors: 'palette', Old: 'skip', Viewports: 'breakpoints' },
  })
  assert.deepEqual(parseCollectionModes(settings.collectionRoles), { hidden: ['Colors', 'Old'], breakpoints: ['Viewports'], products: [], themes: ['Product'] })
})
