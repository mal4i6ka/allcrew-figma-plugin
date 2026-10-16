import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROLE_INFO } from './model.ts'
import { parseCollectionModes } from '../../tokens/engine.ts'

/**
 * The Collection roles list in Settings is a hand-written menu over two parsers. A role the
 * menu offers but no parser knows is saved, shown as chosen, and silently does nothing — the
 * failure the free-text field had, moved into a dropdown. This keeps the menu honest.
 */
const ui = readFileSync(new URL('../../../ui.html', import.meta.url), 'utf8')

test('every DESIGN.md role the settings menu offers is one parseCollectionRoles accepts', () => {
  const block = /var ROLE_DOC_CHOICES = \[([\s\S]*?)\n\s*\]/.exec(ui)
  assert.ok(block, 'ROLE_DOC_CHOICES in ui.html')
  const offered = [...block[1].matchAll(/\['([a-z-]+)'/g)].map((m) => m[1])
  assert.ok(offered.length > 10)
  for (const role of offered) assert.ok(role in ROLE_INFO, `"${role}" is not a ROLE_INFO key`)
})

test('the two export roles the menu writes are the ones the engine reads', () => {
  assert.match(ui, /value: 'hidden', label: 'Hide from code'/)
  assert.match(ui, /value: 'breakpoints', label: 'Breakpoints → --bp-\*'/)
  assert.match(ui, /value: 'product', label: 'Separate file → name\.css'/)
  // The menu serialises rows as "Name: role, Name: role".
  assert.deepEqual(parseCollectionModes('Primitives: hidden, Viewports: breakpoints, One: product'), {
    hidden: ['Primitives'],
    breakpoints: ['Viewports'],
    products: ['One'],
  })
})
