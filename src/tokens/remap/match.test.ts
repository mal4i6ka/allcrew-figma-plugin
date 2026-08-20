import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { assignFamilies, deltaE, familyCost, hungarian, matchStops, nearestByColor } from './match.ts'
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
