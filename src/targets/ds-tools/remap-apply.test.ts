import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../../tokens/color.ts'
import { parsePaletteInput } from '../../tokens/remap/input.ts'
import { buildRemapPlan, type ColorSite } from '../../tokens/remap/plan.ts'
import {
  DEFAULT_REMAP_APPLY_OPTIONS,
  estimateSnapshotBytes,
  foldRenames,
  parseStyleSiteId,
  SNAPSHOT_BUDGET_BYTES,
  splitSiteId,
} from './remap-apply.ts'

test('site ids split back into a variable and a mode', () => {
  assert.deepEqual(splitSiteId('VariableID:1:2|3:4'), { variableId: 'VariableID:1:2', modeId: '3:4' })
  assert.equal(splitSiteId('no-separator'), null)
  assert.equal(splitSiteId('|orphan'), null)
})

test('a second remap collapses the alias chain instead of nesting it', () => {
  const first = foldRenames({}, [{ from: 'colors/Blue/500', to: 'colors/Violet/500' }])
  assert.deepEqual(first, { 'colors/Blue/500': 'colors/Violet/500' })

  const second = foldRenames(first, [{ from: 'colors/Violet/500', to: 'colors/Teal/500' }])
  assert.deepEqual(second, {
    'colors/Blue/500': 'colors/Teal/500',
    'colors/Violet/500': 'colors/Teal/500',
  })
})

test('a rename that comes back keeps the name it passed through alive, but not itself', () => {
  // An export may have shipped `--violet-500` while the detour was in place, so that key has
  // to keep resolving. What must not survive is a variable aliasing its own current name.
  const there = foldRenames({}, [{ from: 'colors/Blue/500', to: 'colors/Violet/500' }])
  const back = foldRenames(there, [{ from: 'colors/Violet/500', to: 'colors/Blue/500' }])
  assert.deepEqual(back, { 'colors/Violet/500': 'colors/Blue/500' })
})

test('unrelated aliases survive a later rename untouched', () => {
  const map = foldRenames({ 'colors/Red/500': 'colors/Rose/500' }, [
    { from: 'colors/Blue/500', to: 'colors/Violet/500' },
  ])
  assert.equal(map['colors/Red/500'], 'colors/Rose/500')
  assert.equal(map['colors/Blue/500'], 'colors/Violet/500')
})

test('style site ids parse back into a style, a property and an index', () => {
  assert.deepEqual(parseStyleSiteId('style:S:1:2#paints:0'), {
    styleId: 'S:1:2',
    property: 'paints',
    index: 0,
    stop: null,
  })
  assert.deepEqual(parseStyleSiteId('style:S:1:2#paints:3.4'), {
    styleId: 'S:1:2',
    property: 'paints',
    index: 3,
    stop: 4,
  })
  assert.deepEqual(parseStyleSiteId('style:S#effects:1'), {
    styleId: 'S',
    property: 'effects',
    index: 1,
    stop: null,
  })
  assert.equal(parseStyleSiteId('VariableID:1|2:3'), null)
  assert.equal(parseStyleSiteId('style:S#widths:0'), null)
})

const rgba = (hex: string) => ({ ...parseHex(hex)!, a: 1 })

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

const palette = parsePaletteInput('Violet/500, #7C3AED\nViolet/600, #6D28D9').swatches

test('the undo budget is judged before anything is written, from how many places wear each color', () => {
  // A loose color on a hundred thousand layers is a hundred thousand undo records, and the
  // style and canvas passes only learn the old value while overwriting it — so a check after
  // the fact would come too late to refuse.
  const huge = buildRemapPlan({
    sites: [site({ id: 'loose:#3B82F6:1.000', name: '#3B82F6', rgba: rgba('#3B82F6'), kind: 'detached', usage: 100000 })],
    palette,
  })
  assert.ok(estimateSnapshotBytes(huge, DEFAULT_REMAP_APPLY_OPTIONS) > SNAPSHOT_BUDGET_BYTES)

  const small = buildRemapPlan({
    sites: [site({ name: 'colors/Blue/500', rgba: rgba('#3B82F6') })],
    palette,
  })
  assert.ok(estimateSnapshotBytes(small, DEFAULT_REMAP_APPLY_OPTIONS) < SNAPSHOT_BUDGET_BYTES)
})

test('turning off a write pass takes its undo cost with it', () => {
  const plan = buildRemapPlan({
    sites: [site({ id: 'loose:#3B82F6:1.000', name: '#3B82F6', rgba: rgba('#3B82F6'), kind: 'detached', usage: 100000 })],
    palette,
  })
  const without = estimateSnapshotBytes(plan, { ...DEFAULT_REMAP_APPLY_OPTIONS, canvas: false })
  assert.equal(without, 0)
})

test('the packed snapshot unfolds to exactly what was collected', () => {
  const collected = {
    version: 2 as const,
    values: [{ v: 'V:1', m: 'M:1', c: [0.9569, 0.9569, 0.9569, 1] as [number, number, number, number] }],
    names: [{ v: 'V:1', n: 'colors/old' }],
    styles: [{ s: 'S:1', p: 'paints' as const, i: 0, j: -1, c: [0.1, 0.2, 0.3, 1] as [number, number, number, number] }],
    paints: [
      ['1:2', 0, 0, -1, 0.9569, 0.9569, 0.9569, 1, 0],
      ['1:3', 0, 0, -1, 0.9569, 0.9569, 0.9569, 1, 1],
      ['1:4', 1, 2, 3, 0.5, 0.25, 0.125, 0.5, 0],
    ] as Array<[string, number, number, number, number, number, number, number, number]>,
  }
  const { packSnapshot, unpackSnapshot } = require('./remap-apply.ts') as typeof import('./remap-apply.ts')
  const restored = unpackSnapshot(JSON.parse(JSON.stringify(packSnapshot(collected))))
  assert.deepEqual(
    [...restored.paints].sort((a, b) => a[0].localeCompare(b[0])),
    collected.paints,
    'every place comes back with its exact channels and bind flag'
  )
  assert.deepEqual(restored.values, collected.values)
  assert.deepEqual(restored.styles, collected.styles)

  // The packed form is meaningfully smaller — that is its whole reason to exist.
  const before = JSON.stringify(collected).length
  const after = JSON.stringify(packSnapshot(collected)).length
  assert.ok(after < before, `packed ${after} < unpacked ${before}`)

  // A version this build does not know is refused, not misread.
  assert.throws(() => unpackSnapshot({ version: 9 }), /version 9/)
})
