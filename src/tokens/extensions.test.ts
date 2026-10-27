import test from 'node:test'
import assert from 'node:assert/strict'
import { foldExtensions, type ExtensionReading } from './extensions.ts'

const theme = { id: 'C:1', name: 'Theme', defaultModeId: 'L', modes: [{ modeId: 'L', name: 'Light' }, { modeId: 'D', name: 'Dark' }] }
const brandEntry = { id: 'C:2', name: 'Brand B', defaultModeId: 'BL', modes: [{ modeId: 'BL', name: 'Light' }, { modeId: 'BD', name: 'Dark' }] }
const primary = { id: 'V:1', name: 'color/primary', collectionId: 'C:1', valuesByMode: { L: 'blue', D: 'navy' } }
const surface = { id: 'V:2', name: 'color/surface', collectionId: 'C:1', valuesByMode: { L: 'white', D: 'black' } }

const brand = (rootId: string, values: ExtensionReading['values']): ExtensionReading => ({
  id: 'C:2',
  name: 'Brand B',
  rootId,
  modes: [{ modeId: 'BL', name: 'Light', parentModeId: 'L' }, { modeId: 'BD', name: 'Dark', parentModeId: 'D' }],
  values,
  variables: [primary, surface],
})

test('a brand extension becomes more themes of the tokens it extends, not an empty collection', () => {
  const folded = foldExtensions(
    { collections: [theme, brandEntry], variables: [primary, surface] },
    [brand('C:1', { 'V:1': { BL: 'orange', BD: 'rust' } })]
  )
  assert.deepEqual(folded.collections.map((c) => c.name), ['Theme'])
  assert.deepEqual(folded.collections[0].modes.map((m) => m.name), ['Light', 'Dark', 'Brand B Light', 'Brand B Dark'])
  const byName = Object.fromEntries(folded.variables.map((v) => [v.name, v.valuesByMode]))
  assert.deepEqual(byName['color/primary'], { L: 'blue', D: 'navy', BL: 'orange', BD: 'rust' })
  // Nothing overridden and nothing read: the parent mode's value is what Figma renders.
  assert.deepEqual(byName['color/surface'], { L: 'white', D: 'black', BL: 'white', BD: 'black' })
})

test('an extension of a library stands as its own collection, carrying what it inherits', () => {
  const folded = foldExtensions(
    { collections: [brandEntry], variables: [] },
    [brand('LIB:9', { 'V:1': { BL: 'orange', BD: 'rust' }, 'V:2': {} })]
  )
  assert.deepEqual(folded.collections.map((c) => [c.name, c.modes.map((m) => m.name)]), [['Brand B', ['Light', 'Dark']]])
  assert.deepEqual(folded.variables, [{ ...primary, collectionId: 'C:2', valuesByMode: { BL: 'orange', BD: 'rust' } }])
})

test('over a single-mode root the extension is named by itself', () => {
  const flat = { ...theme, modes: [{ modeId: 'L', name: 'Value' }] }
  const one: ExtensionReading = { ...brand('C:1', {}), modes: [{ modeId: 'BL', name: 'Value', parentModeId: 'L' }] }
  const folded = foldExtensions({ collections: [flat, brandEntry], variables: [primary] }, [one])
  assert.deepEqual(folded.collections[0].modes.map((m) => m.name), ['Value', 'Brand B'])
})

test('no extensions leaves the snapshot as it was', () => {
  const snapshot = { collections: [theme], variables: [primary] }
  assert.equal(foldExtensions(snapshot, []), snapshot)
})
