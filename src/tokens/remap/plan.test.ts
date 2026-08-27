import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { parsePaletteInput } from './input.ts'
import { buildRemapPlan, type ColorSite } from './plan.ts'

const BLUE = ['#EFF6FF', '#DBEAFE', '#BFDBFE', '#93C5FD', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A']
const VIOLET = ['#F5F3FF', '#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95']
const ORANGE = ['#FFF7ED', '#FFEDD5', '#FED7AA', '#FDBA74', '#FB923C', '#F97316', '#EA580C', '#C2410C', '#9A3412', '#7C2D12']
const TEAL = ['#F0FDFA', '#CCFBF1', '#99F6E4', '#5EEAD4', '#2DD4BF', '#14B8A6', '#0D9488', '#0F766E', '#115E59', '#134E4A']
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

const rgba = (hex: string, alpha = 1) => ({ ...parseHex(hex)!, a: alpha })

const site = (over: Partial<ColorSite> & { name: string; rgba: ColorSite['rgba'] }): ColorSite => ({
  id: over.id ?? `${over.name}|${over.modeId ?? ''}`,
  kind: 'variable',
  modeId: null,
  modeName: null,
  usage: 1,
  editable: true,
  primitive: true,
  ...over,
})

const rampSites = (family: string, hexes: readonly string[], modeId: string | null = null): ColorSite[] =>
  hexes.map((hex, index) =>
    site({ name: `colors/${family}/${STEPS[index]}`, rgba: rgba(hex), modeId, modeName: modeId })
  )

const pasted = (family: string, hexes: readonly string[]): string =>
  hexes.map((hex, index) => `${family}/${STEPS[index]}, ${hex}`).join('\n')

const palette = (text: string) => parsePaletteInput(text).swatches

test('a whole ramp moves onto the new family, keeping every step number', () => {
  const plan = buildRemapPlan({ sites: rampSites('Blue', BLUE), palette: palette(pasted('Violet', VIOLET)) })

  assert.equal(plan.entries.length, 10)
  assert.ok(plan.entries.every((entry) => entry.via === 'step'))
  assert.deepEqual(
    plan.entries.map((entry) => entry.fromStep),
    plan.entries.map((entry) => entry.toStep)
  )
  assert.deepEqual(plan.families.map((family) => [family.fromLabel, family.toLabel]), [['Blue', 'Violet']])
})

test('alpha is carried through untouched — a remap moves color, not transparency', () => {
  const sites = [site({ name: 'colors/Blue/500', rgba: rgba('#3B82F6', 0.4) })]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })
  assert.equal(plan.entries[0].to.a, 0.4)
  assert.notEqual(plan.entries[0].to.r, plan.entries[0].from.r)
})

test('each mode is matched on its own, and divergence is reported not corrected', () => {
  // The light value is a blue and the dark value a teal — nothing forces them together.
  const sites = [
    site({ name: 'brand/base', rgba: rgba('#3B82F6'), modeId: 'light', modeName: 'Light' }),
    site({ name: 'brand/base', rgba: rgba('#0D9488'), modeId: 'dark', modeName: 'Dark' }),
  ]
  const plan = buildRemapPlan({
    sites,
    palette: palette(`${pasted('Violet', VIOLET)}\n${pasted('Teal', TEAL)}`),
    primaryModeId: 'light',
  })

  const families = plan.entries.map((entry) => entry.toFamily)
  assert.equal(new Set(families).size, 2, 'the two modes landed in different families')
  assert.ok(plan.entries.every((entry) => entry.flags.includes('mode-divergence')))
  assert.ok(plan.warnings.some((warning) => /different families per mode/.test(warning)))
})

test('primitives are renamed onto their new family, semantic names are left alone', () => {
  const sites = [
    ...rampSites('Blue', BLUE),
    site({ name: 'text/primary', rgba: rgba('#1E3A8A'), primitive: false }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })

  const renamed = new Map(plan.renames.map((rename) => [rename.from, rename.to]))
  assert.equal(renamed.get('colors/Blue/500'), 'colors/Violet/500')
  assert.ok(!renamed.has('text/primary'), 'the semantic layer keeps its keys')
})

test('a name collision parks the less used variable under legacy/ instead of deleting it', () => {
  const sites = [
    site({ name: 'colors/Blue/500', rgba: rgba('#3B82F6'), usage: 40 }),
    site({ name: 'colors/Indigo/500', rgba: rgba('#6366F1'), usage: 3 }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })

  const renamed = new Map(plan.renames.map((rename) => [rename.from, rename]))
  assert.equal(renamed.get('colors/Blue/500')!.to, 'colors/Violet/500', 'the more used name wins the claim')
  assert.equal(renamed.get('colors/Indigo/500')!.to, 'legacy/colors/Indigo/500')
  assert.equal(renamed.get('colors/Indigo/500')!.legacy, true)
  assert.ok(plan.warnings.some((warning) => /parked as legacy/.test(warning)))
  assert.equal(plan.entries.length, 2, 'both variables survive — nothing is consolidated away')
})

test('two tokens landing on one color are flagged, and left alone when they never touch', () => {
  const sites = [
    site({ id: 'a', name: 'colors/Blue/500', rgba: rgba('#3B82F6') }),
    site({ id: 'b', name: 'colors/Blue/500b', rgba: rgba('#3B82F6') }),
    site({ id: 'c', name: 'colors/Blue/900', rgba: rgba('#1E3A8A') }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })
  const duplicates = plan.entries.filter((entry) => entry.flags.includes('duplicate'))
  assert.equal(duplicates.length, 0, 'colors that were already identical are not a new collision')
})

test('adjacent tokens that collide are separated onto a step the new palette actually has', () => {
  // A border and its fill, one ramp step apart in the old file, land on one violet step.
  const sites = [
    site({ id: 'fill', name: 'surface/default', rgba: rgba('#60A5FA'), usage: 30 }),
    site({ id: 'border', name: 'border/default', rgba: rgba('#63A7F7'), usage: 2 }),
  ]
  const swatches = palette(pasted('Violet', VIOLET))
  const plan = buildRemapPlan({ sites, palette: swatches, adjacency: [['fill', 'border']] })

  const fill = plan.entries.find((entry) => entry.site.id === 'fill')!
  const border = plan.entries.find((entry) => entry.site.id === 'border')!
  assert.notDeepEqual(border.to, fill.to, 'the pair was pulled apart')
  assert.ok(border.flags.includes('separated'))
  assert.equal(fill.site.usage > border.site.usage, true, 'the more used token kept its color')

  const shipped = new Set(swatches.map((swatch) => swatch.step))
  assert.ok(shipped.has(border.toStep!), `${border.toStep} is not a step the designer shipped`)
})

test('an orphan takes its nearest replacement however far away it is', () => {
  const sites = [site({ name: 'accent/lime', rgba: rgba('#84CC16') })]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })
  const entry = plan.entries[0]
  assert.equal(entry.via, 'nearest')
  assert.ok(entry.flags.includes('orphan'))
  assert.ok(entry.deltaE > 10, 'the distance is reported rather than hidden')
})

test('a shrinking palette merges families and marks every affected row', () => {
  const plan = buildRemapPlan({
    sites: [...rampSites('Blue', BLUE), ...rampSites('Orange', ORANGE)],
    palette: palette(pasted('Violet', VIOLET)),
  })
  assert.equal(plan.entries.length, 20, 'nothing is dropped')
  assert.ok(plan.entries.every((entry) => entry.flags.includes('shared-family')))
  assert.deepEqual(plan.families.map((family) => family.toLabel), ['Violet', 'Violet'])
})

test('library tokens are planned and reported but marked unwritable', () => {
  const sites = [site({ name: 'colors/Blue/500', rgba: rgba('#3B82F6'), editable: false })]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)) })
  assert.ok(plan.entries[0].flags.includes('library'))
  assert.ok(plan.warnings.some((warning) => /library/.test(warning)))
  assert.equal(plan.renames.length, 0, 'a library variable is never renamed from a consuming file')
})

test('new families nothing landed on are surfaced', () => {
  const plan = buildRemapPlan({
    sites: rampSites('Blue', BLUE),
    palette: palette(`${pasted('Violet', VIOLET)}\n${pasted('Teal', TEAL)}`),
  })
  assert.deepEqual(plan.unusedFamilies, ['Teal'])
})

test('an empty palette produces no writes and says why', () => {
  const plan = buildRemapPlan({ sites: rampSites('Blue', BLUE), palette: [] })
  assert.deepEqual(plan.entries, [])
  assert.deepEqual(plan.warnings, ['the new palette is empty'])
})

test('a color that maps onto itself is marked rather than written twice', () => {
  const plan = buildRemapPlan({ sites: rampSites('Violet', VIOLET), palette: palette(pasted('Violet', VIOLET)) })
  assert.ok(plan.entries.every((entry) => entry.flags.includes('unchanged')))
})

test('a variable in a second collection is renamed even though its modes are different ids', () => {
  // Collections do not share mode ids, so anything keyed on the primary mode alone silently
  // skips every variable outside the primary collection.
  const sites = [
    site({ id: 'v1|m-light', groupId: 'v1', name: 'colors/Blue/500', rgba: rgba('#3B82F6'), modeId: 'm-light' }),
    site({ id: 'v1|m-dark', groupId: 'v1', name: 'colors/Blue/500', rgba: rgba('#1D4ED8'), modeId: 'm-dark' }),
    site({ id: 'v2|other', groupId: 'v2', name: 'brandB/Blue/700', rgba: rgba('#1E40AF'), modeId: 'other' }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)), primaryModeId: 'm-light' })
  assert.deepEqual(plan.renames.map((rename) => rename.from).sort(), ['brandB/Blue/700', 'colors/Blue/500'])
})

test('a variable with several modes is renamed once, decided by the primary mode', () => {
  const sites = [
    site({ id: 'v1|m-dark', groupId: 'v1', name: 'colors/Blue/500', rgba: rgba('#1D4ED8'), modeId: 'm-dark' }),
    site({ id: 'v1|m-light', groupId: 'v1', name: 'colors/Blue/500', rgba: rgba('#3B82F6'), modeId: 'm-light' }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)), primaryModeId: 'm-light' })
  assert.equal(plan.renames.length, 1)
  assert.equal(plan.renames[0].siteId, 'v1|m-light')
})

test('a family that would collide at every rung keeps its names instead of burying half a ramp', () => {
  // Renaming teal onto neutral means teal/100 meets the neutral/100 that is already there, and
  // so on down the ladder. Parking those one by one is how ten variables end up in legacy/.
  const sites = [
    ...[50, 100, 200, 300].map((step) =>
      site({ name: `colors/teal/${step}`, rgba: rgba(['#BFD6D9', '#A1BCC0', '#93AEB2', '#60797D'][[50, 100, 200, 300].indexOf(step)]) })
    ),
    ...[50, 100, 200, 300].map((step) =>
      site({ name: `colors/neutral/${step}`, rgba: rgba(['#F5F5F5', '#E0E0E0', '#BDBDBD', '#757575'][[50, 100, 200, 300].indexOf(step)]) })
    ),
  ]
  const greys = [50, 100, 200, 300].map((step, index) => `neutral/${step}, ${['#F7F8F8', '#F2F4F5', '#D9DCDE', '#B8BBBD'][index]}`)
  const plan = buildRemapPlan({ sites, palette: palette(greys.join('\n')) })

  const parked = plan.renames.filter((rename) => rename.legacy)
  assert.deepEqual(parked, [], 'nothing is buried')
  assert.ok(
    plan.warnings.some((warning) => /keeps its names/.test(warning)),
    `expected a family-level note, got ${JSON.stringify(plan.warnings)}`
  )
})

test('a color the new palette already holds does not move, wherever it was filed', () => {
  // The zeroth rule. `brand/cultured` is byte-for-byte the new teal/50; the white lives in an
  // oddly named group. Neither is allowed to "move" — they are already the reference.
  const sites = [
    site({ name: 'colour/white', rgba: rgba('#FFFFFF') }),
    site({ id: 'v2', name: 'colors/brand/cultured', rgba: rgba('#F3F8F9') }),
    site({ id: 'v3', name: 'colors/grey/500', rgba: rgba('#939393') }),
  ]
  const plan = buildRemapPlan({
    sites,
    palette: palette('neutral/0, #FFFFFF\nneutral/500, #797979\nteal/50, #F3F8F9\nteal/500, #2F7882'),
  })

  const white = plan.entries.find((entry) => entry.site.name === 'colour/white')!
  assert.equal(white.via, 'exact')
  assert.ok(white.flags.includes('unchanged'))
  assert.equal(white.toName, 'neutral/0')

  const cultured = plan.entries.find((entry) => entry.site.name === 'colors/brand/cultured')!
  assert.equal(cultured.via, 'exact')
  assert.equal(cultured.toName, 'teal/50')

  const gray = plan.entries.find((entry) => entry.site.name === 'colors/grey/500')!
  assert.notEqual(gray.via, 'exact', 'a color the palette does not hold still maps normally')
})

test('an excluded pair is out of everything the run writes — renames included', () => {
  // Refuted by the adversarial pass twice over: the phantom rename not only wrote a name the
  // human struck out, it claimed that name in collision resolution, parking a variable the
  // human kept in legacy/.
  const sites = [
    site({ id: 'kept', name: 'colors/Indigo/500', rgba: rgba('#6366F1'), usage: 3 }),
    site({ id: 'struck', name: 'colors/Blue/500', rgba: rgba('#8B5CF6'), usage: 40 }),
  ]
  const plan = buildRemapPlan({ sites, palette: palette(pasted('Violet', VIOLET)), excluded: ['struck'] })

  assert.ok(!plan.renames.some((rename) => rename.siteId === 'struck'), 'the excluded variable is not renamed')
  const kept = plan.renames.find((rename) => rename.siteId === 'kept')
  assert.ok(kept && !kept.legacy, 'the kept variable takes the name — no phantom claim parks it in legacy/')
})

test('separation never moves an identity match, and never forks a pair that was already one color', () => {
  const twin = [
    site({ id: 'fill', name: 'surface/brand', rgba: rgba('#8B5CF6'), usage: 30 }),
    site({ id: 'border', name: 'border/brand', rgba: rgba('#8B5CF6'), usage: 2 }),
  ]
  const already = buildRemapPlan({
    sites: twin,
    palette: palette(pasted('Violet', VIOLET)),
    adjacency: [['fill', 'border']],
  })
  for (const entry of already.entries) {
    assert.ok(!entry.flags.includes('separated'), 'a pair the designer drew as one color stays one color')
    assert.equal(entry.via, 'exact')
  }

  const mixed = [
    site({ id: 'fill', name: 'surface/brand', rgba: rgba('#8D5EF4'), usage: 30 }),
    site({ id: 'border', name: 'border/brand', rgba: rgba('#8B5CF6'), usage: 2 }),
  ]
  const plan = buildRemapPlan({
    sites: mixed,
    palette: palette(pasted('Violet', VIOLET)),
    adjacency: [['fill', 'border']],
  })
  const border = plan.entries.find((entry) => entry.site.id === 'border')!
  assert.equal(border.via, 'exact', 'the identity match is never the mover, whatever its usage')
  assert.ok(!border.flags.includes('separated'))
})

test('identity holds for palette colors that sit off the 8-bit grid', () => {
  // hsl() parses to channels that need not land on n/255; a variable a hair under the rounding
  // boundary is the same color by this module's own equality and must not miss the exact pass.
  const swatches = parsePaletteInput('blue/300, hsl(210, 40%, 50%)\nblue/500, #1D4ED8').swatches
  const nudge = 1.6e-6
  const sites = [
    site({
      name: 'colors/blue/500',
      rgba: { r: 0.3 - nudge, g: 0.5 - nudge, b: 0.7 - nudge, a: 1 },
    }),
  ]
  const plan = buildRemapPlan({ sites, palette: swatches })
  assert.equal(plan.entries[0].via, 'exact', 'equal is equal, wherever the rounding boundary falls')
})

test('separation moves the variable key along with the color', () => {
  // A stale key here and the rebind later moves the separated variable onto the very token
  // it was just separated away from — re-merging the pair for every alias consumer.
  const keyed = palette(pasted('Violet', VIOLET)).map((swatch) => ({
    ...swatch,
    variableKey: `key:${swatch.name}`,
  }))
  const sites = [
    site({ id: 'fill', name: 'surface/brand', rgba: rgba('#8D5EF4'), usage: 30 }),
    site({ id: 'border', name: 'border/brand', rgba: rgba('#8C5DF5'), usage: 2 }),
  ]
  const plan = buildRemapPlan({ sites, palette: keyed, adjacency: [['fill', 'border']] })
  const border = plan.entries.find((entry) => entry.site.id === 'border')!
  if (border.flags.includes('separated')) {
    assert.equal(border.toVariableKey, `key:${border.toName}`, 'the key names the rung the color landed on')
  }
  for (const entry of plan.entries) {
    if (entry.toName === null) continue
    assert.equal(entry.toVariableKey, `key:${entry.toName}`, `${entry.site.name}: key and name agree`)
  }
})
