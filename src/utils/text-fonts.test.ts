import test from 'node:test'
import assert from 'node:assert/strict'
import { fontsToLoad } from './text-fonts.ts'

const inter = { family: 'Inter', style: 'Regular' }
const bold = { family: 'Inter', style: 'Bold' }

/** `getRangeAllFontNames` as Figma answers it, refusals included (both read live). */
const layer = (characters: string, fontName: unknown, ranged: unknown[] = [inter]) => ({
  characters,
  fontName,
  getRangeAllFontNames(start: number, end: number) {
    if (end <= start) throw new Error("in getRangeAllFontNames: Empty range selected. 'end' must be greater than 'start'")
    if (end > characters.length) throw new Error('in getRangeAllFontNames: Range outside of available characters.')
    return ranged as FontName[]
  },
})

test('a layer with text asks for every font in it', () => {
  assert.deepEqual(fontsToLoad(layer('Hello', Symbol('mixed'), [inter, bold])), [inter, bold])
})

test('an empty layer is never asked for a range — its own font is the one to load', () => {
  assert.deepEqual(fontsToLoad(layer('', inter)), [inter])
})

test('an empty layer with nothing usable in fontName loads nothing rather than throwing', () => {
  assert.deepEqual(fontsToLoad(layer('', Symbol('mixed'))), [])
  assert.deepEqual(fontsToLoad(layer('', undefined)), [])
})
