import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFileTokenConfig, normalizeFileTokenConfig, pickFileTokenConfig, readFileTokenConfig } from './file-config.ts'
import { normalizeExportOptions } from '../settings.ts'

test('a file config keeps only what it may pin, and says what it dropped', () => {
  const { config, problems } = normalizeFileTokenConfig({ collectionRoles: ' Product: themes ', slugThemes: true, typoNaming: 'size', delivery: {} })
  assert.deepEqual(config, { collectionRoles: 'Product: themes', slugThemes: true })
  assert.equal(problems.length, 2)
})

test('the file wins over the person for what the tokens are, and only for that', () => {
  const mine = normalizeExportOptions({ tokens: { themeAttribute: 'data-theme', includeLibraries: true, slugThemes: false } })
  const effective = applyFileTokenConfig(mine, { themeAttribute: 'data-theme-name', slugThemes: true })
  assert.equal(effective.tokens.themeAttribute, 'data-theme-name')
  assert.equal(effective.tokens.slugThemes, true)
  assert.equal(effective.tokens.includeLibraries, true, 'a per-person setting is left alone')
  assert.equal(applyFileTokenConfig(mine, null), mine)
})

test('a panel save writes back only the fields the file pins', () => {
  const tokens = normalizeExportOptions({ tokens: { themeAttribute: 'x', slugThemes: true, collectionRoles: 'A: hidden' } }).tokens
  assert.deepEqual(pickFileTokenConfig(tokens, ['slugThemes', 'collectionRoles']), { slugThemes: true, collectionRoles: 'A: hidden' })
})

test('a stored config that no longer parses reads as no config, never as a crash', () => {
  const host = (value: string) => ({ getSharedPluginData: () => value, setSharedPluginData: () => undefined })
  assert.equal(readFileTokenConfig(host('{not json')), null)
  assert.equal(readFileTokenConfig(host('')), null)
  assert.deepEqual(readFileTokenConfig(host('{"slugThemes":true,"bogus":1}')), { slugThemes: true })
})

test('a file can pin its theme axes, so every export of it ships the same two attributes', () => {
  const { config, problems } = normalizeFileTokenConfig({ themeAxes: ' data-product: One, Business; data-theme: Light, Dark ' })
  assert.deepEqual(problems, [])
  assert.equal(config.themeAxes, 'data-product: One, Business; data-theme: Light, Dark')
  assert.deepEqual(normalizeFileTokenConfig({ themeAxes: ['data-theme'] }).problems, ['"themeAxes" must be a string or an object'])
  // The picker's object form is checked, not trusted.
  const picked = normalizeFileTokenConfig({ themeAxes: { axes: [{ attribute: 'data-theme', values: [{ label: 'Light' }, { label: 'Dark' }] }] } })
  assert.deepEqual(picked.problems, [])
  assert.deepEqual(normalizeFileTokenConfig({ themeAxes: { axes: [] } }).problems, ['"themeAxes": theme axes take one or two attributes, 0 given'])
})
