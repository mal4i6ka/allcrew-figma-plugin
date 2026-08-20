import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePaletteInput } from './input.ts'

test('reads a plain list of hexes with no names at all', () => {
  const { swatches, format } = parsePaletteInput('#F5F3FF\n#EDE9FE\n#7C3AED\n')
  assert.equal(format, 'text')
  assert.deepEqual(
    swatches.map((swatch) => swatch.hex),
    ['#F5F3FF', '#EDE9FE', '#7C3AED']
  )
  assert.deepEqual(swatches.map((swatch) => swatch.name), ['', '', ''])
  assert.equal(swatches[0].family, null)
})

test('reads a two-column paste in either column order', () => {
  const nameFirst = parsePaletteInput('Violet/500, #7C3AED\nViolet/600, #6D28D9')
  assert.deepEqual(
    nameFirst.swatches.map((swatch) => [swatch.family, swatch.step, swatch.hex]),
    [
      ['Violet', 500, '#7C3AED'],
      ['Violet', 600, '#6D28D9'],
    ]
  )

  const colorFirst = parsePaletteInput('#7C3AED\tViolet/500')
  assert.equal(colorFirst.swatches[0].family, 'Violet')
  assert.equal(colorFirst.swatches[0].step, 500)
})

test('keeps alpha and normalises notation to hex plus alpha', () => {
  const { swatches } = parsePaletteInput('overlay: rgba(37, 99, 235, 0.5)\nscrim #00000080')
  assert.equal(swatches[0].hex, '#2563EB')
  assert.ok(Math.abs(swatches[0].alpha - 0.5) < 1e-3)
  assert.equal(swatches[0].name, 'overlay')
  assert.equal(swatches[1].hex, '#000000')
  assert.ok(Math.abs(swatches[1].alpha - 0x80 / 255) < 1e-3)
})

test('reads a nested JSON tree, including W3C $value wrappers', () => {
  const json = JSON.stringify({
    colors: {
      violet: {
        '500': { $value: '#7C3AED', $type: 'color', $description: 'ignored' },
        '600': { $value: '#6D28D9' },
      },
      teal: { '500': '#14B8A6' },
    },
  })
  const { swatches, format } = parsePaletteInput(json)
  assert.equal(format, 'json')
  assert.deepEqual(
    swatches.map((swatch) => [swatch.family, swatch.step, swatch.hex]),
    [
      ['violet', 500, '#7C3AED'],
      ['violet', 600, '#6D28D9'],
      ['teal', 500, '#14B8A6'],
    ]
  )
})

test('reads an array of records with explicit name/value fields', () => {
  const json = JSON.stringify([
    { name: 'Violet/500', value: '#7C3AED' },
    { token: 'Violet/600', hex: 'rgb(109, 40, 217)' },
    { name: 'Accent', color: '#14B8A6', family: 'Teal', step: 500 },
  ])
  const { swatches } = parsePaletteInput(json)
  assert.deepEqual(
    swatches.map((swatch) => [swatch.name, swatch.family, swatch.step, swatch.hex]),
    [
      ['Violet/500', 'Violet', 500, '#7C3AED'],
      ['Violet/600', 'Violet', 600, '#6D28D9'],
      ['Accent', 'Teal', 500, '#14B8A6'],
    ]
  )
})

test('an array of bare colors under a key keeps the family and invents no steps', () => {
  const { swatches } = parsePaletteInput(JSON.stringify({ violet: ['#F5F3FF', '#7C3AED'] }))
  assert.deepEqual(
    swatches.map((swatch) => [swatch.family, swatch.step]),
    [
      ['violet', null],
      ['violet', null],
    ]
  )
})

test('reports what it could not read instead of dropping it silently', () => {
  const { swatches, warnings } = parsePaletteInput('#7C3AED\nsome heading\n\n#14B8A6')
  assert.equal(swatches.length, 2)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /line 2/)
})

test('a row of several swatches yields the colors and says the names were lost', () => {
  const { swatches, warnings } = parsePaletteInput('ramp: #F5F3FF #EDE9FE #7C3AED')
  assert.equal(swatches.length, 3)
  assert.deepEqual(swatches.map((swatch) => swatch.name), ['', '', ''])
  assert.match(warnings[0], /names ignored/)
})

test('drops repeated rows but keeps distinct colors sharing a name', () => {
  const repeated = parsePaletteInput('Violet/500 #7C3AED\nViolet/500 #7C3AED')
  assert.equal(repeated.swatches.length, 1)
  assert.match(repeated.warnings[0], /duplicate/)

  const sameName = parsePaletteInput(JSON.stringify({ violet: ['#F5F3FF', '#7C3AED'] }))
  assert.equal(sameName.swatches.length, 2)
})

test('malformed JSON falls back to line reading rather than failing', () => {
  const { swatches, warnings } = parsePaletteInput('{ "violet": "#7C3AED", }')
  assert.equal(swatches.length, 1)
  assert.equal(swatches[0].hex, '#7C3AED')
  assert.match(warnings[0], /does not parse/)
})

test('empty input is empty, not an error', () => {
  assert.deepEqual(parsePaletteInput('   \n  '), { swatches: [], warnings: [], format: 'text' })
})
