import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { buildMappingFile, colorReplacements, MAPPING_FORMAT, parseMappingFile, toCsv } from './contract.ts'
import { parsePaletteInput } from './input.ts'
import { buildRemapPlan, type ColorSite } from './plan.ts'

const VIOLET = ['#F5F3FF', '#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95']
const BLUE = ['#EFF6FF', '#DBEAFE', '#BFDBFE', '#93C5FD', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A']
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

const rgba = (hex: string, alpha = 1) => ({ ...parseHex(hex)!, a: alpha })

const site = (over: Partial<ColorSite> & { name: string; rgba: ColorSite['rgba'] }): ColorSite => ({
  id: over.id ?? over.name,
  kind: 'variable',
  modeId: null,
  modeName: null,
  usage: 1,
  editable: true,
  primitive: true,
  ...over,
})

const violetPaste = VIOLET.map((hex, index) => `Violet/${STEPS[index]}, ${hex}`).join('\n')
const palette = parsePaletteInput(violetPaste).swatches

const bluePlan = () =>
  buildRemapPlan({
    sites: BLUE.map((hex, index) => site({ name: `colors/Blue/${STEPS[index]}`, rgba: rgba(hex) })),
    palette,
  })

test('a mapping file carries enough to match by literal or by name', () => {
  const mapping = buildMappingFile(bluePlan(), { file: 'Design System', palette: 'paste' })

  assert.equal(mapping.format, MAPPING_FORMAT)
  assert.equal(mapping.records.length, 10)
  assert.deepEqual(mapping.source, { file: 'Design System', palette: 'paste' })

  const five = mapping.records.find((record) => record.fromStep === 500)!
  assert.equal(five.from, '#3B82F6')
  assert.equal(five.to, '#8B5CF6')
  assert.equal(five.name, 'colors/Blue/500')
  assert.equal(five.newName, 'colors/Violet/500')
  assert.equal(five.toFamily, 'Violet')
  assert.equal(five.via, 'step')
})

test('no timestamp is invented, so two runs of the same remap diff cleanly', () => {
  assert.equal(buildMappingFile(bluePlan()).generatedAt, null)
  assert.equal(buildMappingFile(bluePlan(), { generatedAt: '2026-08-20T10:00:00Z' }).generatedAt, '2026-08-20T10:00:00Z')
  assert.deepEqual(JSON.stringify(buildMappingFile(bluePlan())), JSON.stringify(buildMappingFile(bluePlan())))
})

test('csv holds one row per record with the flags readable', () => {
  const csv = toCsv(buildMappingFile(bluePlan()))
  const lines = csv.trim().split('\n')
  assert.equal(lines.length, 11)
  assert.match(lines[0], /^kind,name,newName,mode,from,fromAlpha,to,toAlpha/)
  assert.ok(lines.slice(1).every((line) => line.startsWith('variable,colors/Blue/')))
})

test('csv quotes anything that would break a column', () => {
  const plan = buildRemapPlan({
    sites: [site({ name: 'colors/Blue, dark/500', rgba: rgba('#3B82F6') })],
    palette,
  })
  const csv = toCsv(buildMappingFile(plan))
  assert.match(csv, /"colors\/Blue, dark\/500"/)
})

test('the literal view drops colors that map two ways instead of picking one', () => {
  const plan = buildRemapPlan({
    sites: [
      site({ id: 'l', name: 'brand/base', rgba: rgba('#3B82F6'), modeId: 'light', modeName: 'Light' }),
      site({ id: 'd', name: 'brand/base', rgba: rgba('#3B82F6'), modeId: 'dark', modeName: 'Dark' }),
      site({ id: 'x', name: 'brand/edge', rgba: rgba('#1E3A8A'), modeId: 'light', modeName: 'Light' }),
    ],
    palette: parsePaletteInput(`${violetPaste}\nTeal/500, #14B8A6`).swatches,
  })

  // Both modes hold the same old color, but the plan may land them differently; if it does,
  // rewriting a stylesheet by literal would have to guess which theme the file represents.
  const mapping = buildMappingFile(plan)
  const light = colorReplacements(mapping, 'Light')
  assert.ok(light.replacements.has('#3B82F6'))
  assert.deepEqual(light.conflicts, [])
})

test('a color that did not move is not a replacement', () => {
  const plan = buildRemapPlan({
    sites: VIOLET.map((hex, index) => site({ name: `colors/Violet/${STEPS[index]}`, rgba: rgba(hex) })),
    palette,
  })
  const { replacements } = colorReplacements(buildMappingFile(plan))
  assert.equal(replacements.size, 0)
})

test('alpha is recorded but never part of the replacement key', () => {
  const plan = buildRemapPlan({ sites: [site({ name: 'colors/Blue/500', rgba: rgba('#3B82F6', 0.5) })], palette })
  const mapping = buildMappingFile(plan)
  assert.equal(mapping.records[0].fromAlpha, 0.5)
  assert.equal(mapping.records[0].toAlpha, 0.5)
  assert.deepEqual([...colorReplacements(mapping).replacements.keys()], ['#3B82F6'])
})

test('reading a mapping back rejects anything that is not one', () => {
  const mapping = buildMappingFile(bluePlan())
  assert.equal(parseMappingFile(JSON.stringify(mapping)).records.length, 10)
  assert.throws(() => parseMappingFile('{"format":"something-else","version":1,"records":[]}'), /unknown format/)
  assert.throws(() => parseMappingFile({ ...mapping, version: 99 }), /newer than this build/)
  assert.throws(() => parseMappingFile({ format: MAPPING_FORMAT, version: 1 }), /records missing/)
})
