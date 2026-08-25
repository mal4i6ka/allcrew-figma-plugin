import test from 'node:test'
import assert from 'node:assert/strict'
import { describeColor, parseColor, resolveModes } from './values.ts'

/* ------------------------------------------------------------------ colour */

test('parseColor reads the hex forms an agent actually types', () => {
  assert.deepEqual(parseColor('#FFF'), { r: 1, g: 1, b: 1, a: 1 })
  assert.deepEqual(parseColor('FB5B0A'), parseColor('#fb5b0a'))
  assert.equal(parseColor('#000000FF')?.a, 1)
  assert.equal(parseColor('#00000080')?.a, 128 / 255)
})

test('parseColor reads the "hex at percent" form the variables panel shows', () => {
  const color = parseColor('#000000 40%')
  assert.equal(color?.a, 0.4)
  assert.equal(parseColor('#FB5B0A @ 25%')?.a, 0.25)
})

test('parseColor passes Figma’s own float shape straight through', () => {
  assert.deepEqual(parseColor({ r: 0, g: 0.5, b: 1 }), { r: 0, g: 0.5, b: 1, a: 1 })
  assert.equal(parseColor({ r: 0, g: 0, b: 0, a: 0.72 })?.a, 0.72)
})

test('parseColor refuses anything it cannot read rather than guessing', () => {
  assert.equal(parseColor('orange'), null)
  assert.equal(parseColor('#GGGGGG'), null)
  assert.equal(parseColor(42), null)
  assert.equal(parseColor(null), null)
})

test('describeColor states alpha as a percentage, matching how the token reads', () => {
  assert.equal(describeColor({ r: 1, g: 1, b: 1, a: 1 }), '#FFFFFF')
  assert.equal(describeColor({ r: 0, g: 0, b: 0, a: 0.4 }), '#000000 40%')
})

test('a colour survives a round trip through both forms', () => {
  const parsed = parseColor('#FB5B0A 64%')!
  assert.equal(describeColor(parsed), '#FB5B0A 64%')
})

/* ------------------------------------------------------------------- modes */

const collection = {
  name: 'One',
  defaultModeId: '510:0',
  modes: [
    { modeId: '510:0', name: 'Light' },
    { modeId: '510:1', name: 'Dark' },
  ],
} as unknown as VariableCollection

test('an omitted mode means the collection default, not every mode', () => {
  assert.deepEqual(resolveModes(collection, undefined), [{ modeId: '510:0', name: 'Light' }])
})

test('a mode resolves by name or by id, and "*" means all of them', () => {
  assert.deepEqual(resolveModes(collection, 'dark'), [{ modeId: '510:1', name: 'Dark' }])
  assert.deepEqual(resolveModes(collection, '510:1'), [{ modeId: '510:1', name: 'Dark' }])
  assert.equal(resolveModes(collection, '*').length, 2)
})

test('an unknown mode names the modes that do exist', () => {
  assert.throws(() => resolveModes(collection, 'Midnight'), /Light, Dark/)
})
