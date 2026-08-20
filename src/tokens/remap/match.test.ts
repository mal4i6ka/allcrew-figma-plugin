import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { assignFamilies, deltaE, familyCost, hungarian, ladderOutliers, matchStops, nearestByColor } from './match.ts'
import { inferSpectra, spectrumSteps, type InferredSpectrum, type SpectrumMember } from './spectrum.ts'

const BLUE = ['#EFF6FF', '#DBEAFE', '#BFDBFE', '#93C5FD', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A']
const VIOLET = ['#F5F3FF', '#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95']
const ORANGE = ['#FFF7ED', '#FFEDD5', '#FED7AA', '#FDBA74', '#FB923C', '#F97316', '#EA580C', '#C2410C', '#9A3412', '#7C2D12']
const TEAL = ['#F0FDFA', '#CCFBF1', '#99F6E4', '#5EEAD4', '#2DD4BF', '#14B8A6', '#0D9488', '#0F766E', '#115E59', '#134E4A']
const SLATE = ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#475569', '#334155', '#1E293B', '#0F172A']
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]
const TWELVE = [25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

const rgba = (hex: string) => ({ ...parseHex(hex)!, a: 1 })

const ramp = (family: string, hexes: readonly string[], steps: readonly number[] | null = STEPS): SpectrumMember[] =>
  hexes.map((hex, index) => ({
    ref: `${family}/${index}`,
    name: steps ? `${family}/${steps[index]}` : family,
    rgba: rgba(hex),
    family,
    step: steps ? steps[index] : null,
  }))

const only = (members: SpectrumMember[]): InferredSpectrum => {
  const { spectra } = inferSpectra(members)
  assert.equal(spectra.length, 1, 'fixture should infer exactly one spectrum')
  return spectra[0]
}

/** Twelve stops sampled from a ten-stop ramp, so the target ladder has numbers 10 does not. */
const twelveStopViolet = (): InferredSpectrum => {
  const hexes = [VIOLET[0], ...VIOLET, VIOLET[VIOLET.length - 1]]
  return only(
    hexes.map((hex, index) => ({
      ref: `v12/${index}`,
      name: `Violet/${TWELVE[index]}`,
      rgba: rgba(hex),
      family: 'Violet',
      step: TWELVE[index],
    }))
  )
}

test('deltaE reads on the familiar scale: a 1-bit difference is invisible, a step is not', () => {
  assert.ok(deltaE(rgba('#2563EB'), rgba('#2563EA')) < 0.5)
  assert.ok(deltaE(rgba('#2563EB'), rgba('#1D4ED8')) > 5, 'adjacent ramp steps are far apart')
  assert.equal(deltaE(rgba('#2563EB'), rgba('#2563EB')), 0)
})

test('hungarian finds the optimum a greedy pass would miss', () => {
  // Greedy on row 0 takes column 0 (cost 1) and forces row 1 onto column 1 for 9, total 10.
  // The optimum concedes row 0 to column 1 and lands at 4.
  const cost = [
    [1, 2],
    [3, 9],
  ]
  assert.deepEqual(hungarian(cost), [1, 0])
  assert.deepEqual(hungarian([[5]]), [0])
  assert.deepEqual(hungarian([]), [])
})

test('hungarian refuses a matrix it cannot assign rather than returning junk', () => {
  assert.throws(() => hungarian([[1], [2]]), /rows must not exceed cols/)
})

test('families land on their own hue, not on whatever was read first', () => {
  const oldSide = inferSpectra([...ramp('Orange', ORANGE), ...ramp('Blue', BLUE), ...ramp('Slate', SLATE)]).spectra
  const newSide = inferSpectra([...ramp('Teal', TEAL), ...ramp('Violet', VIOLET), ...ramp('Gray', SLATE)]).spectra

  const { assignments, unused } = assignFamilies(oldSide, newSide)
  const byFrom = new Map(assignments.map((assignment) => [assignment.from.label, assignment.to.label]))
  assert.equal(byFrom.get('Blue'), 'Violet', 'blue is nearer violet than teal')
  assert.equal(byFrom.get('Orange'), 'Teal', 'orange takes what is left rather than fighting for violet')
  assert.equal(byFrom.get('Slate'), 'Gray', 'a neutral ramp only ever matches a neutral ramp')
  assert.deepEqual(unused, [])
  assert.ok(assignments.every((assignment) => !assignment.shared))
})

test('a neutral family is never handed a colored one while any neutral remains', () => {
  const grays = only(ramp('Slate', SLATE))
  const violet = only(ramp('Violet', VIOLET))
  assert.ok(familyCost(grays, violet) > familyCost(grays, grays))
  assert.ok(familyCost(grays, violet) >= 2, 'the mismatch penalty outweighs any hue distance')
})

test('a shrinking palette merges families and says which ones merged', () => {
  const oldSide = inferSpectra([...ramp('Blue', BLUE), ...ramp('Indigo', VIOLET), ...ramp('Orange', ORANGE)]).spectra
  const newSide = inferSpectra([...ramp('Violet', VIOLET), ...ramp('Teal', TEAL)]).spectra

  const { assignments } = assignFamilies(oldSide, newSide)
  assert.equal(assignments.length, 3, 'nothing is dropped when the palette shrinks')

  const violetIntake = assignments.filter((assignment) => assignment.to.label === 'Violet')
  assert.equal(violetIntake.length, 2, 'blue and indigo both land on violet')
  assert.ok(violetIntake.every((assignment) => assignment.shared))
  assert.equal(violetIntake.filter((assignment) => assignment.overflow).length, 1)
})

test('a growing palette leaves the new families nothing landed on visible', () => {
  const oldSide = inferSpectra(ramp('Blue', BLUE)).spectra
  const newSide = inferSpectra([...ramp('Violet', VIOLET), ...ramp('Teal', TEAL)]).spectra
  const { assignments, unused } = assignFamilies(oldSide, newSide)
  assert.equal(assignments.length, 1)
  assert.deepEqual(
    unused.map((spectrum) => spectrum.label),
    ['Teal']
  )
})

test('an identical name wins over a marginally closer hue', () => {
  const oldSide = inferSpectra(ramp('Brand', BLUE)).spectra
  const newSide = inferSpectra([...ramp('Brand', VIOLET), ...ramp('Indigo', VIOLET)]).spectra
  const { assignments } = assignFamilies(oldSide, newSide)
  assert.equal(assignments[0].to.label, 'Brand')
})

test('a stop keeps its number when the new scale has it', () => {
  const matches = matchStops(only(ramp('Blue', BLUE)), twelveStopViolet())
  const five = matches.find((match) => match.from.step === 500)!
  assert.equal(five.to.step, 500)
  assert.equal(five.via, 'step')
  assert.ok(matches.every((match) => match.via === 'step'), 'every ten-scale number exists in the twelve-scale')
})

test('a stop with no counterpart lands on the nearest existing step, never an invented one', () => {
  const source = only(
    [450, 550].map((step, index) => ({
      ref: `odd/${index}`,
      name: `Odd/${step}`,
      rgba: rgba(index === 0 ? '#60A5FA' : '#3B82F6'),
      family: 'Odd',
      step,
    }))
  )
  const target = only(ramp('Violet', VIOLET))
  const matches = matchStops(source, target)

  assert.ok(matches.every((match) => match.via === 'lightness'))
  const allowed = new Set(spectrumSteps(target))
  for (const match of matches) {
    assert.ok(allowed.has(match.to.step!), `${match.to.step} is not a step the designer shipped`)
  }
})

test('a target that carries no step numbers at all still matches by lightness', () => {
  const target = only(ramp('Violet', VIOLET, null))
  const matches = matchStops(only(ramp('Blue', BLUE)), target)
  assert.equal(matches.length, 10)
  assert.ok(matches.every((match) => match.via === 'lightness'))
  assert.ok(matches.every((match) => match.to.step === null), 'no step numbers are conjured for the target')
})

test('mapping ten stops onto twelve keeps the ladder ordered', () => {
  const matches = matchStops(only(ramp('Blue', BLUE)), twelveStopViolet())
  const landings = matches.map((match) => match.to.l)
  for (let i = 1; i < landings.length; i++) {
    assert.ok(landings[i] <= landings[i - 1] + 1e-9, 'light stops must not land darker than dark ones')
  }
})

test('nearest by color is the fallback for anything that belongs to no ramp', () => {
  const candidates = [{ rgba: rgba('#7C3AED') }, { rgba: rgba('#14B8A6') }, { rgba: rgba('#F97316') }]
  assert.deepEqual(nearestByColor(candidates, rgba('#0D9488')), candidates[1])
  assert.equal(nearestByColor([], rgba('#000000')), null)
})

/* ------------------------------------------------------------------ untrustworthy steps */

/** Altery's own library: `10` is the brand colour and `50…900` are tints of it. */
const ALTERY_RED = [
  [10, '#D63A36'],
  [50, '#FFF0F0'],
  [100, '#FFCFC6'],
  [200, '#F7BBBB'],
  [300, '#EE9A9A'],
  [400, '#E06764'],
  [500, '#D63A36'],
  [600, '#B32B28'],
  [700, '#8C1F1D'],
  [800, '#661513'],
] as const

const alteryRed = (): InferredSpectrum =>
  only(
    ALTERY_RED.map(([step, hex], index) => ({
      ref: `alx/${index}`,
      name: `colors/red/${step}`,
      rgba: rgba(hex),
      family: 'red',
      step,
    }))
  )

/** A conventional scale: 10 is the lightest tint, 900 the darkest shade. */
const CONVENTIONAL_RED = [
  [10, '#FFE6E6'],
  [50, '#FFC0BF'],
  [100, '#F99D99'],
  [200, '#EE7D73'],
  [300, '#E35C50'],
  [400, '#D63A36'],
  [500, '#C22B27'],
  [600, '#A31F1C'],
  [700, '#851714'],
  [800, '#66100E'],
] as const

const conventionalRed = (): InferredSpectrum =>
  only(
    CONVENTIONAL_RED.map(([step, hex], index) => ({
      ref: `old/${index}`,
      name: `colors/red/${step}`,
      rgba: rgba(hex),
      family: 'red',
      step,
    }))
  )

test('a step that breaks its own ladder is not trusted as a number', () => {
  // `10` sits far outside the run 50…800 descends through, so in that scale the number means
  // something else — the brand colour rather than the lightest tint.
  assert.deepEqual([...ladderOutliers(alteryRed())], [10])
  assert.deepEqual([...ladderOutliers(conventionalRed())], [], 'a monotone ladder has none')
})

test('an old light tint does not become a saturated fill just because the numbers agree', () => {
  const matches = matchStops(conventionalRed(), alteryRed())
  const ten = matches.find((match) => match.from.step === 10)!

  assert.notEqual(ten.via, 'step', 'the number was declined, not the colour')
  assert.ok(ten.to.l > 0.9, `landed on ${ten.to.name} at L ${ten.to.l.toFixed(2)}`)
  assert.ok(ten.lightnessShift < 0.1)

  // Nothing else piles onto that one dark rung either.
  const landings = matches.map((match) => match.to.name)
  assert.equal(new Set(landings).size >= matches.length - 1, true, 'at most one pair shares a rung')
})

test('the untrusted stop is still reachable as a colour', () => {
  // Declining `10` as a *number* must not remove #D63A36 from the palette: something in the
  // old ramp is that dark, and it should land there.
  const matches = matchStops(conventionalRed(), alteryRed())
  assert.ok(matches.some((match) => match.to.name === 'colors/red/10' || match.to.rgba.r < 0.9))
})

test('a short scale is left alone — there is not enough of it to call anything an outlier', () => {
  const short = only(
    [
      [10, '#FFE6E6'],
      [500, '#C22B27'],
      [900, '#3D0908'],
    ].map(([step, hex], index) => ({
      ref: `s/${index}`,
      name: `red/${step}`,
      rgba: rgba(hex as string),
      family: 'red',
      step: step as number,
    }))
  )
  assert.deepEqual([...ladderOutliers(short)], [])
})

/* ------------------------------------------------------------------ real ladders */

const rungs = (family: string, steps: Array<[number, string]>): InferredSpectrum => {
  const { spectra } = inferSpectra(
    steps.map(([step, hex], index) => ({
      ref: `${family}/${index}`,
      name: `${family}/${step}`,
      rgba: rgba(hex),
      family,
      step,
    }))
  )
  return spectra[0]
}

/** The two ladders that produced the collapsed tails, taken from the real exports. */
const OLD_RED: Array<[number, string]> = [
  [10, '#FFE6E6'], [50, '#FFC0BF'], [100, '#F99D99'], [200, '#EE7D73'], [300, '#DF5F4D'], [400, '#CC4426'],
  [500, '#B42B02'], [600, '#A61C00'], [700, '#931000'], [800, '#790700'], [900, '#5A0200'],
]
const NEW_RED: Array<[number, string]> = [
  [50, '#fff0f0'], [100, '#ffcfc6'], [150, '#ffbbbc'], [200, '#f7bbbb'], [300, '#ee8f8f'], [400, '#e05e5e'],
  [500, '#d63a36'], [600, '#cd1918'], [700, '#a81413'], [800, '#7e1c19'], [850, '#651616'], [900, '#521614'],
]

test('a tail with nowhere to go takes the first rung, and the ends stay pinned', () => {
  // The old ladder starts at 10 where the new one starts at 50. Landing both on 50 is what made
  // a pale background and its border the same colour.
  const matches = matchStops(rungs('red', OLD_RED), rungs('red', NEW_RED))
  assert.equal(matches.find((match) => match.from.step === 10)!.to.step, 50)
  assert.equal(matches.find((match) => match.from.step === 900)!.to.step, 900)
  assert.equal(
    new Set(matches.map((match) => match.to.step)).size,
    matches.length,
    'nothing shares a rung — this new ladder had room'
  )
})

test('when there is no room, the sharing lands in the middle rather than at an end', () => {
  const shorter = NEW_RED.slice(0, 9)
  const matches = matchStops(rungs('red', OLD_RED), rungs('red', shorter))

  assert.equal(matches[0].to.step, 50, 'the light end is pinned')
  assert.equal(matches[matches.length - 1].to.step, shorter[shorter.length - 1][0], 'so is the dark end')

  const landings = matches.map((match) => match.to.step)
  const shared = landings.filter((step, index) => landings.indexOf(step) !== index)
  assert.ok(shared.length > 0, 'eleven rungs cannot fit nine without sharing')
  for (const step of shared) {
    const position = shorter.findIndex(([number]) => number === step)
    assert.ok(position > 0 && position < shorter.length - 1, `sharing at ${step} is at an end, not the middle`)
  }
})

test('a target family does not drag a gray ramp in just to have a source', () => {
  // A file that is mostly grays against a palette that is mostly colours. Solving so that every
  // target gets its best source means every target gets *a* source — which is how red and
  // orange ended up holding the gray ramps, thirty ΔE away.
  const grey = (family: string, hexes: readonly string[]) => ramp(family, hexes, [100, 200, 300, 400, 500, 600])
  const oldSide = inferSpectra([
    ...grey('grey', ['#FFFFFF', '#D4D4D4', '#A3A3A3', '#7C7C7C', '#4C4C4C', '#000000']),
    ...grey('slate', ['#F5F5F5', '#E0E0E0', '#BDBDBD', '#757575', '#424242', '#212121']),
    ...grey('Neutral', ['#FAFAFA', '#DDDDDD', '#AAAAAA', '#777777', '#444444', '#111111']),
    ...ramp('blue', BLUE),
  ]).spectra
  const newSide = inferSpectra([
    ...grey('neutral', ['#F7F8F8', '#D9DCDE', '#B8BBBD', '#797979', '#333434', '#0F1011']),
    ...ramp('orange', ORANGE),
    ...ramp('red', ['#FFF0F0', '#F7BBBB', '#EE8F8F', '#D63A36', '#A81413', '#521614', '#3D1010', '#2A0B0B', '#1C0707', '#0E0303']),
    ...ramp('blue', VIOLET),
  ]).spectra

  const { assignments, unused } = assignFamilies(oldSide, newSide)
  for (const assignment of assignments) {
    assert.equal(
      assignment.from.neutral,
      assignment.to.neutral,
      `${assignment.from.label} → ${assignment.to.label} crosses the gray line`
    )
  }
  assert.deepEqual(
    unused.map((spectrum) => spectrum.label).sort(),
    ['orange', 'red'],
    'the colours nothing landed on are reported, not filled with grays'
  )
})

test('a rung the new ladder cannot name still sits above the one it can', () => {
  // The old ladder starts at 10 where the new one starts at 0/50. Taking the rung nearest its
  // lightness puts 10 on the 100 that the 50 is about to claim by name, and the ramp comes out
  // inverted at the top — 10 darker than 50, which no gradient should ever be.
  const grey = (steps: Array<[number, string]>) => rungs('grey', steps)
  const from = grey([
    [10, '#F4F4F4'], [50, '#E4E4E4'], [100, '#D4D4D4'], [200, '#C4C4C4'],
    [300, '#B3B3B3'], [400, '#A3A3A3'], [500, '#939393'], [600, '#7C7C7C'],
  ])
  const to = grey([
    [0, '#FFFFFF'], [50, '#F7F8F8'], [100, '#F2F4F5'], [150, '#E8EBEC'], [200, '#D9DCDE'],
    [300, '#B8BBBD'], [400, '#8C8C8C'], [500, '#797979'], [600, '#616161'],
  ])

  const matches = matchStops(from, to)
  const landings = matches.map((match) => match.to.l)
  for (let i = 1; i < landings.length; i++) {
    assert.ok(landings[i] < landings[i - 1], `${matches[i].from.step} landed lighter than ${matches[i - 1].from.step}`)
  }
  assert.equal(matches[0].to.step, 0, 'the unnamed rung takes the one above the first anchor')
  assert.equal(matches[1].to.step, 50, 'and the anchor keeps its own number')
})
