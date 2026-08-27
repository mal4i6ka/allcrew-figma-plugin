import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familyKey, parseTokenName, renameFamily } from './token-name.ts'

test('reads family and step out of the shapes real files use', () => {
  const cases: Array<[string, string | null, number | null]> = [
    ['colors/Orange/O500', 'Orange', 500],
    ['Violet/500', 'Violet', 500],
    ['violet-500', 'violet', 500],
    ['gray_50', 'gray', 50],
    ['B500', 'B', 500],
    ['Neutral/N0', 'Neutral', 0],
    ['colors.Blue.B200', 'Blue', 200],
    ['Brand Blue/700', 'Brand Blue', 700],
  ]
  for (const [name, family, step] of cases) {
    const parsed = parseTokenName(name)
    assert.equal(parsed.family, family, `family of ${name}`)
    assert.equal(parsed.step, step, `step of ${name}`)
  }
})

test('a group beats a leaf prefix — Orange/O500 is the Orange ramp, not the O ramp', () => {
  assert.equal(parseTokenName('colors/Orange/O500').family, 'Orange')
  assert.equal(parseTokenName('O500').family, 'O')
})

test('names without a step report no step, and keep their group as the family', () => {
  assert.deepEqual(
    { family: parseTokenName('text/primary').family, step: parseTokenName('text/primary').step },
    { family: 'text', step: null }
  )
  assert.equal(parseTokenName('accent').family, null)
  assert.equal(parseTokenName('').leaf, '')
})

test('family keys ignore case and separators', () => {
  assert.equal(familyKey('Brand Blue'), familyKey('brand-blue'))
  assert.equal(familyKey('Neutral'), 'neutral')
  assert.notEqual(familyKey('blue'), familyKey('blues'))
})

test('renaming swaps the family and follows the file’s own abbreviation style', () => {
  assert.equal(renameFamily('colors/Orange/O500', 'Violet'), 'colors/Violet/V500')
  assert.equal(renameFamily('Violet/500', 'Teal'), 'Teal/500', 'a bare numeric leaf has nothing to abbreviate')
  assert.equal(renameFamily('violet-500', 'teal'), 'teal-500')
  assert.equal(renameFamily('colors/Blue/Bl700', 'Magenta'), 'colors/Magenta/Ma700')
  assert.equal(renameFamily('colors/Orange/O500', 'Violet', 600), 'colors/Violet/V600', 'the step can move too')
})

test('renaming leaves a name it cannot read alone', () => {
  assert.equal(renameFamily('', 'Violet'), '')
  assert.equal(renameFamily('accent', 'Violet'), 'accent')
})
