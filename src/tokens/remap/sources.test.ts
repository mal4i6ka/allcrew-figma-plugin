import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PALETTE_SETTINGS, generatePalette } from '../palette.ts'
import { buildRemapPlan, type ColorSite } from './plan.ts'
import { swatchesFromNamedColors, swatchesFromPalette } from './sources.ts'

test('the generator hands over its families and steps intact', () => {
  const palette = generatePalette(DEFAULT_PALETTE_SETTINGS)
  const swatches = swatchesFromPalette(palette)

  const expected = palette.spectra.reduce((total, spectrum) => total + spectrum.swatches.length, 0)
  assert.equal(swatches.length, expected)
  assert.ok(swatches.every((swatch) => swatch.family !== null && swatch.step !== null))

  const orange = swatches.filter((swatch) => swatch.family === 'Orange')
  assert.ok(orange.length >= 10)
  assert.deepEqual(
    orange.map((swatch) => swatch.step),
    palette.spectra.find((spectrum) => spectrum.label === 'Orange')!.swatches.map((swatch) => swatch.step)
  )
  assert.equal(orange[0].name, `Orange/${orange[0].step}`)
})

test('a generated palette maps step-for-step, with nothing interpolated', () => {
  // The point of using the generator as a source: the ladder the ramps were built on is the
  // ladder the matcher lands on, so no step has to be guessed at.
  const palette = generatePalette(DEFAULT_PALETTE_SETTINGS)
  const orange = palette.spectra.find((spectrum) => spectrum.label === 'Orange')!
  const sites: ColorSite[] = orange.swatches.map((swatch, index) => ({
    id: `v${index}`,
    kind: 'variable',
    name: `colors/Blue/${swatch.step}`,
    modeId: null,
    modeName: null,
    // Any blue-ish ramp; the family match is what routes it, the step numbers do the rest.
    rgba: { r: 0.1 + index * 0.08, g: 0.2 + index * 0.07, b: 0.9 - index * 0.05, a: 1 },
    usage: 1,
    editable: true,
    primitive: true,
  }))

  const plan = buildRemapPlan({ sites, palette: swatchesFromPalette(palette) })
  assert.ok(plan.entries.every((entry) => entry.via === 'step'))
  assert.deepEqual(
    plan.entries.map((entry) => entry.fromStep),
    plan.entries.map((entry) => entry.toStep)
  )
})

test('named colors keep whatever structure their names carry', () => {
  const { swatches } = swatchesFromNamedColors([
    { hex: '#7C3AED', name: 'Violet/500' },
    { hex: '#6D28D9', name: 'colors/Violet/600' },
    { hex: '#14B8A6', name: 'Brand accent' },
  ])
  assert.deepEqual(
    swatches.map((swatch) => [swatch.family, swatch.step]),
    [
      ['Violet', 500],
      ['Violet', 600],
      [null, null],
    ]
  )
})

test('a swatch board repeats itself, so identical colors collapse to the first name', () => {
  const { swatches, duplicates } = swatchesFromNamedColors([
    { hex: '#7C3AED', name: 'Violet/500' },
    { hex: '#7C3AED', name: 'Label' },
    { hex: '#7C3AED', alpha: 0.5, name: 'Overlay' },
  ])
  assert.equal(duplicates, 1)
  assert.deepEqual(
    swatches.map((swatch) => swatch.name),
    ['Violet/500', 'Overlay']
  )
  assert.equal(swatches[1].alpha, 0.5, 'a different alpha is a different swatch')
})

test('anything that is not a color is dropped rather than guessed at', () => {
  const { swatches } = swatchesFromNamedColors([
    { hex: 'not-a-color', name: 'x' },
    { hex: '#123', name: 'short' },
  ])
  assert.deepEqual(
    swatches.map((swatch) => swatch.hex),
    ['#123']
  )
})

test('when identical colors collapse, the rung outlives the alias that shares its color', () => {
  // A swatch board draws `background/base` before the `neutral/0` it aliases, and both are pure
  // white. Keeping whichever came first leaves the new neutral ramp with no `0` at all — and
  // then every white in the file, having nothing white left to land on, moves to the lightest
  // gray the ramp still has. Which name survives decides what the palette *is*.
  const { swatches, duplicates } = swatchesFromNamedColors([
    { hex: '#FFFFFF', name: 'background/base' },
    { hex: '#FFFFFF', name: 'neutral/0' },
    { hex: '#F7F8F8', name: 'neutral/50' },
    { hex: '#F7F8F8', name: 'surface/raised' },
  ])

  assert.equal(duplicates, 2)
  assert.deepEqual(
    swatches.map((swatch) => `${swatch.name}=${swatch.family}/${swatch.step}`),
    ['neutral/0=neutral/0', 'neutral/50=neutral/50']
  )
})

test('a name that describes nothing does not displace one that describes something', () => {
  const { swatches } = swatchesFromNamedColors([
    { hex: '#FFFFFF', name: 'Rectangle' },
    { hex: '#FFFFFF', name: 'neutral/0' },
    { hex: '#FFFFFF', name: 'neutral/25' },
  ])
  assert.equal(swatches.length, 1)
  assert.equal(swatches[0].name, 'neutral/0', 'the first rung wins; a later one is no better')
})
