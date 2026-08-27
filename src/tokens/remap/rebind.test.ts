import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { parsePaletteInput } from './input.ts'
import { buildRemapPlan, type ColorSite } from './plan.ts'
import { describeRebind, emptyCounts, rebindTargets, sameRgba } from './rebind.ts'

const rgba = (hex: string, a = 1) => ({ ...parseHex(hex)!, a })

const site = (over: Partial<ColorSite> & { id: string; name: string; rgba: ColorSite['rgba'] }): ColorSite => ({
  kind: 'variable',
  modeId: null,
  modeName: null,
  usage: 1,
  editable: true,
  primitive: true,
  ...over,
})

/** A palette whose swatches carry library keys, the way the library reader hands them over. */
const keyedPalette = () => {
  const swatches = parsePaletteInput('Violet/500, #7C3AED\nViolet/600, #6D28D9').swatches
  return swatches.map((swatch) => ({ ...swatch, variableKey: `key:${swatch.name}` }))
}

test('a variable whose modes agree gets one rebind target', () => {
  const sites = [
    site({ id: 'V:1|light', name: 'colors/Blue/500', rgba: rgba('#8B5CF6'), modeId: 'light', modeName: 'Light' }),
    site({ id: 'V:1|dark', name: 'colors/Blue/500', rgba: rgba('#8B5CF6'), modeId: 'dark', modeName: 'Dark' }),
  ]
  const plan = buildRemapPlan({ sites, palette: keyedPalette() })
  const { byVariable, divergent } = rebindTargets(plan)

  assert.deepEqual(divergent, [])
  assert.equal(byVariable.get('V:1')?.key, 'key:Violet/500')
  assert.equal(byVariable.get('V:1')?.toName, 'Violet/500')
})

test('a variable whose modes land on different tokens is refused, not guessed', () => {
  const sites = [
    site({ id: 'V:1|light', name: 'brand/base', rgba: rgba('#7C3AED'), modeId: 'light', modeName: 'Light' }),
    site({ id: 'V:1|dark', name: 'brand/base', rgba: rgba('#6D28D9'), modeId: 'dark', modeName: 'Dark' }),
  ]
  const plan = buildRemapPlan({ sites, palette: keyedPalette() })
  const { byVariable, divergent } = rebindTargets(plan)

  assert.deepEqual(divergent, ['V:1'])
  assert.equal(byVariable.has('V:1'), false)
})

test('an excluded mode loses its vote, and a fully excluded variable does not move', () => {
  const sites = [
    site({ id: 'V:1|light', name: 'brand/base', rgba: rgba('#7C3AED'), modeId: 'light', modeName: 'Light' }),
    site({ id: 'V:1|dark', name: 'brand/base', rgba: rgba('#6D28D9'), modeId: 'dark', modeName: 'Dark' }),
    site({ id: 'V:2|light', name: 'brand/other', rgba: rgba('#7C3AED'), modeId: 'light', modeName: 'Light' }),
  ]
  const plan = buildRemapPlan({ sites, palette: keyedPalette(), excluded: ['V:1|dark', 'V:2|light'] })
  const { byVariable, divergent } = rebindTargets(plan)

  // With the diverging dark mode struck out, the light mode's landing stands alone.
  assert.equal(byVariable.get('V:1')?.key, 'key:Violet/500')
  assert.deepEqual(divergent, [])
  assert.equal(byVariable.has('V:2'), false, 'a fully excluded variable is out of everything the run writes')
})

test('a paste palette carries no keys, so nothing gains a rebind target', () => {
  const plan = buildRemapPlan({
    sites: [site({ id: 'V:1|m', name: 'colors/Blue/500', rgba: rgba('#8B5CF6'), modeId: 'm' })],
    palette: parsePaletteInput('Violet/500, #7C3AED').swatches,
  })
  assert.equal(rebindTargets(plan).byVariable.size, 0)
})

test('sameRgba is byte-equality with alpha as a full citizen', () => {
  assert.ok(sameRgba(rgba('#7C3AED'), rgba('#7C3AED')))
  assert.ok(!sameRgba(rgba('#7C3AED'), rgba('#7C3AEC')))
  assert.ok(!sameRgba(rgba('#7C3AED', 0.5), rgba('#7C3AED', 1)), 'an alias takes the target alpha — a mismatch bars the bind')
  assert.ok(sameRgba(rgba('#7C3AED', 0.5), rgba('#7C3AED', 0.5)))
})

test('the report line says what moved and what stayed', () => {
  const counts = emptyCounts()
  counts.aliases = 122
  counts.styles = 4
  counts.nodes = 310
  counts.instanceOverrides = 12
  counts.thirdParty = 7
  counts.skipped.alphaMismatch = 2
  const line = describeRebind(counts)
  assert.match(line, /122 variable/)
  assert.match(line, /310 canvas binding/)
  assert.match(line, /12 in instances/)
  assert.match(line, /7 from other libraries/)
  assert.match(line, /2 left as-is/)
})

test('a keyless mode is a vote against moving the variable, not an abstention', () => {
  // The alias rewrite is per variable: moving the keyed mode would drag the keyless one onto
  // a token it never chose. Not reachable from today's all-or-nothing sources, and locked
  // down so a future partially-keyed source cannot turn it on silently.
  const keyed = keyedPalette()
  const half = [keyed[0], { ...keyed[1], variableKey: null }]
  const sites = [
    site({ id: 'V:1|light', name: 'brand/base', rgba: rgba('#7C3AED'), modeId: 'light', modeName: 'Light' }),
    site({ id: 'V:1|dark', name: 'brand/base', rgba: rgba('#6D28D9'), modeId: 'dark', modeName: 'Dark' }),
  ]
  const plan = buildRemapPlan({ sites, palette: half })
  const { byVariable, divergent } = rebindTargets(plan)
  assert.equal(byVariable.has('V:1'), false)
  assert.deepEqual(divergent, ['V:1'])
})
