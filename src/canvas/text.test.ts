import test from 'node:test'
import assert from 'node:assert/strict'
import { planProps, resolveRanges } from './props.ts'
import { styledRuns, writableFont } from './text-runs.ts'

const runsOf = (runs: unknown) => {
  const plan = planProps({ runs })
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return (plan.steps[0] as { step: 'runs'; runs: unknown[] }).runs
}

/* ------------------------------------------------------------------- ranges */

test('a match covers every occurrence, because "make the word bold" means all of them', () => {
  const { ranges, problem } = resolveRanges('pay now, pay later', { match: 'pay', textCase: 'UPPER' })
  assert.equal(problem, undefined)
  assert.deepEqual(ranges, [
    [0, 3],
    [9, 12],
  ])
})

test('overlapping matches are not double-counted', () => {
  // "aa" in "aaaa" is twice, not three times — the second search starts after the first match.
  assert.deepEqual(resolveRanges('aaaa', { match: 'aa', textCase: 'UPPER' }).ranges, [
    [0, 2],
    [2, 4],
  ])
})

test('a match that is not there is an error, never a quiet no-op', () => {
  const { ranges, problem } = resolveRanges('Continue', { match: 'Cancel', textCase: 'UPPER' })
  assert.deepEqual(ranges, [])
  assert.match(problem ?? '', /"Cancel" is not in this text/)
})

test('a range past the end is clamped, but a start past the end is refused', () => {
  assert.deepEqual(resolveRanges('Continue', { from: 4, to: 100, textCase: 'UPPER' }).ranges, [[4, 8]])
  assert.match(resolveRanges('Continue', { from: 12, to: 14, textCase: 'UPPER' }).problem ?? '', /past the end of 8 character/)
})

/* -------------------------------------------------------------------- plans */

test('a run keeps what it was told, and the vocabulary is the layer vocabulary', () => {
  assert.deepEqual(runsOf([{ match: '299 ₽', fontName: { family: 'Inter', style: 'Bold' }, fill: '#FF5B0A' }]), [
    { match: '299 ₽', fontName: { family: 'Inter', style: 'Bold' }, fill: '#FF5B0A' },
  ])
})

test('variable-font axes survive a styled-run read', async () => {
  const fontName = { family: 'Roboto Flex', style: 'Regular', variationSettings: { wght: 575, wdth: 90 } }
  const node = {
    fontName: { family: 'Roboto Flex', style: 'Regular', variationSettings: { wght: 400, wdth: 100 } },
    getStyledTextSegments() {
      return [{ start: 0, end: 4, fontName }]
    },
  }
  assert.deepEqual(await styledRuns(node as never), [{ from: 0, to: 4, fontName }])
})

test('a run that sets nothing is refused rather than applied to no effect', () => {
  assert.match(planProps({ runs: [{ match: 'x' }] }).problems[0], /a run that sets nothing styles nothing/)
})

test('naming both a match and a range is a question, not a guess', () => {
  assert.match(
    planProps({ runs: [{ match: 'x', from: 0, to: 2, textCase: 'UPPER' }] }).problems[0],
    /either a match or a from\/to range, not both/
  )
})

test('every wrong field of a run is named where it sits', () => {
  assert.match(planProps({ runs: [{ from: -1, to: 2, textCase: 'UPPER' }] }).problems[0], /from must be a whole number >= 0/)
  assert.match(planProps({ runs: [{ from: 4, to: 4, textCase: 'UPPER' }] }).problems[0], /to must be a whole number greater than from/)
  assert.match(planProps({ runs: [{ match: 'x', textCase: 'SHOUT' }] }).problems[0], /ORIGINAL, UPPER, LOWER, TITLE/)
  assert.match(planProps({ runs: [{ match: 'x', fill: 'red' }] }).problems[0], /fill: "red" is not a #RRGGBB colour/)
  assert.match(planProps({ runs: [{ match: 'x', weight: 700 }] }).problems[0], /unknown key "weight"/)
  assert.match(planProps({ runs: [{ match: 'x', link: 4 }] }).problems[0], /link must be a URL, or null/)
  assert.match(planProps({ runs: 'bold' }).problems[0], /must be an array of \{ from, to \} or \{ match \} runs/)
})

test('one bad run does not lose the good ones', () => {
  const plan = planProps({ runs: [{ match: 'a', textCase: 'UPPER' }, { match: '', textCase: 'UPPER' }] })
  assert.equal(plan.problems.length, 1)
  assert.equal((plan.steps[0] as { runs: unknown[] }).runs.length, 1)
})

test('runs are styled after the characters they style are written', () => {
  const plan = planProps({ runs: [{ match: 'a', textCase: 'UPPER' }], text: 'a b', name: 'Label' })
  assert.deepEqual(
    plan.steps.map((step) => (step.step === 'assign' ? step.property : step.step)),
    ['name', 'text', 'runs']
  )
})

/* -------------------------------------------------------------------- fonts */

test('a variable font keeps its axes through a read and back into a write', () => {
  // `writableFont` is what a read reports; `planProps` is what a write takes. A 550-weight
  // heading that lost its axes on the way out would come back as plain Regular.
  const read = writableFont({ family: 'Inter', style: 'Regular', variationSettings: { wght: 550, slnt: -4 } })
  assert.deepEqual(read, { family: 'Inter', style: 'Regular', variationSettings: { wght: 550, slnt: -4 } })
  assert.deepEqual(runsOf([{ match: '299 ₽', fontName: read }]), [{ match: '299 ₽', fontName: read }])
  assert.deepEqual(planProps({ fontName: read }).steps, [{ step: 'font', font: read }])
})

test('a font may be named by its axes alone, because no named face sits at 550', () => {
  assert.deepEqual(planProps({ fontName: { family: 'Inter', variationSettings: { wght: 550 } } }).steps, [
    { step: 'font', font: { family: 'Inter', variationSettings: { wght: 550 } } },
  ])
})

test('an axis that is not a four-letter tag is refused, because Figma throws on it', () => {
  assert.match(
    planProps({ fontName: { family: 'Inter', variationSettings: { weight: 550 } } }).problems[0],
    /"weight" is not a four-letter axis tag/
  )
  assert.match(
    planProps({ fontName: { family: 'Inter', variationSettings: { wght: 'bold' } } }).problems[0],
    /variationSettings\.wght must be a number/
  )
  assert.match(
    planProps({ runs: [{ match: 'x', fontName: { family: 'Inter', variationSettings: { wg: 1 } } }] }).problems[0],
    /"wg" is not a four-letter axis tag/
  )
  assert.match(planProps({ fontName: { family: 'Inter', weight: 700 } }).problems[0], /unknown key "weight"/)
  assert.match(planProps({ fontName: 'Inter Bold' }).problems[0], /must be \{ family, style\?, variationSettings\? \}/)
})
