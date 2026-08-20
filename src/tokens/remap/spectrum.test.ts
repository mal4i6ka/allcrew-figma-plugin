import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { hueName, inferSpectra, spectrumSteps, type SpectrumMember } from './spectrum.ts'

const BLUE = ['#EFF6FF', '#DBEAFE', '#BFDBFE', '#93C5FD', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A']
const VIOLET = ['#F5F3FF', '#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95']
const INDIGO = ['#EEF2FF', '#E0E7FF', '#C7D2FE', '#A5B4FC', '#818CF8', '#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81']
const SLATE = ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#475569', '#334155', '#1E293B', '#0F172A']
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

const member = (name: string, hex: string, family: string | null, step: number | null): SpectrumMember => ({
  ref: `${name}:${hex}`,
  name,
  rgba: { ...parseHex(hex)!, a: 1 },
  family,
  step,
})

const ramp = (family: string, hexes: readonly string[], withSteps = true): SpectrumMember[] =>
  hexes.map((hex, index) =>
    member(`${family}/${STEPS[index]}`, hex, family, withSteps ? STEPS[index] : null)
  )

const bare = (hexes: readonly string[]): SpectrumMember[] => hexes.map((hex) => member('', hex, null, null))

test('named ramps stay exactly as named, light to dark', () => {
  const { spectra, loose } = inferSpectra([...ramp('Blue', BLUE), ...ramp('Violet', VIOLET)])
  assert.deepEqual(
    spectra.map((spectrum) => spectrum.label),
    ['Blue', 'Violet']
  )
  assert.ok(spectra.every((spectrum) => spectrum.source === 'named'))
  assert.equal(loose.length, 0)

  const blue = spectra[0]
  assert.equal(blue.stops.length, 10)
  assert.ok(blue.stops[0].l > blue.stops[9].l, 'stops run light → dark')
  assert.deepEqual(spectrumSteps(blue), STEPS)
})

test('a tinted gray ramp is recognised as neutral rather than split mid-ladder', () => {
  const { spectra } = inferSpectra(ramp('Slate', SLATE))
  assert.equal(spectra.length, 1)
  assert.equal(spectra[0].neutral, true, 'slate peaks at C≈0.041 and must stay one neutral family')
})

test('a named group spanning many hues is a bag of roles, not a ramp', () => {
  // status/success, status/warning, status/danger share a folder and nothing else. Trusting
  // the folder would enter them into the family assignment as though they were one ramp.
  const roles = [
    member('status/success', '#16A34A', 'status', null),
    member('status/warning', '#F59E0B', 'status', null),
    member('status/danger', '#DC2626', 'status', null),
  ]
  const { spectra } = inferSpectra(roles)
  assert.ok(
    spectra.every((spectrum) => spectrum.source === 'clustered'),
    'the group is dissolved and its members re-grouped by color'
  )
  assert.ok(!spectra.some((spectrum) => spectrum.label === 'status'))
})

test('an all-gray named group is kept as a neutral family', () => {
  // text/primary, text/secondary, text/inverse have no steps either — but nothing separates
  // them from a gray ramp that also has no steps, so they are treated as one. Either way
  // their members land on the new neutrals by lightness; keeping the name costs nothing.
  const { spectra } = inferSpectra([
    member('text/primary', '#0F172A', 'text', null),
    member('text/secondary', '#64748B', 'text', null),
    member('text/inverse', '#FFFFFF', 'text', null),
  ])
  assert.deepEqual(
    spectra.map((spectrum) => [spectrum.label, spectrum.neutral]),
    [['text', true]]
  )
})

test('unnamed colors cluster by hue and get the name a designer would use', () => {
  const { spectra } = inferSpectra([...bare(VIOLET), ...bare(SLATE)])
  const labels = spectra.map((spectrum) => spectrum.label)
  assert.ok(labels.includes('Violet'), `expected a Violet family, got ${labels.join(', ')}`)
  assert.ok(labels.includes('Neutral'))
  assert.ok(spectra.every((spectrum) => spectrum.source === 'clustered'))
  assert.ok(spectra.every((spectrum) => spectrumSteps(spectrum).length === 0), 'no steps are invented')
})

test('two unnamed families 16° apart merge, and the merge is reported rather than hidden', () => {
  // Nothing in the geometry separates blue from indigo — their nearest members are 6° apart,
  // closer than blue's own widest internal step. The honest answer is to say so.
  const { spectra, warnings } = inferSpectra([...bare(BLUE), ...bare(INDIGO)])
  const merged = spectra.find((spectrum) => spectrum.stops.length === 20)
  assert.ok(merged, 'blue and indigo cluster together')
  assert.equal(merged!.crowded, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /may be two families/)
})

test('names beat geometry: the same two ramps stay separate when the file named them', () => {
  const { spectra, warnings } = inferSpectra([...ramp('Blue', BLUE), ...ramp('Indigo', INDIGO)])
  assert.deepEqual(
    spectra.map((spectrum) => spectrum.stops.length),
    [10, 10]
  )
  assert.deepEqual(warnings, [])
})

test('a color belonging to no ramp is reported loose, not forced into one', () => {
  const { spectra, loose } = inferSpectra([...ramp('Blue', BLUE), member('', '#F97316', null, null)])
  assert.equal(spectra.length, 1)
  assert.deepEqual(
    loose.map((stop) => stop.name),
    ['']
  )
  assert.equal(loose[0].ref, ':#F97316')
})

test('clusters straddling 0° are found wherever the walk starts', () => {
  const pinks = bare(['#FDF2F8', '#FBCFE8', '#EC4899', '#DB2777', '#9D174D'])
  const { spectra } = inferSpectra(pinks)
  assert.equal(spectra.length, 1, 'a hue-wrapping family is one cluster, not two')
  assert.equal(spectra[0].stops.length, 5)
})

test('hue sectors name the colors they are supposed to', () => {
  assert.equal(hueName(293), 'Violet')
  assert.equal(hueName(277), 'Indigo')
  assert.equal(hueName(260), 'Blue')
  assert.equal(hueName(183), 'Teal')
  assert.equal(hueName(48), 'Orange')
  assert.equal(hueName(354), 'Pink')
  assert.equal(hueName(2), 'Pink', 'the wheel wraps')
})
