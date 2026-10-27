import test from 'node:test'
import assert from 'node:assert/strict'
import { decorationWords, planDecoration } from './decoration.ts'
import { planProps } from './props.ts'

test('a wavy, offset, coloured underline is five Figma properties from one object', () => {
  const planned = planDecoration({ style: 'wavy', offset: 2, thickness: '10%', color: '#FB5B0A @0.5', skipInk: false })
  assert.ok('values' in planned)
  assert.deepEqual(planned.values, {
    textDecorationStyle: 'WAVY',
    textDecorationOffset: { value: 2, unit: 'PIXELS' },
    textDecorationThickness: { value: 10, unit: 'PERCENT' },
    textDecorationColor: { value: { type: 'SOLID', color: { r: 251 / 255, g: 91 / 255, b: 10 / 255 }, opacity: 0.5 } },
    textDecorationSkipInk: false,
  })
  // What was written reads back as what was asked.
  assert.deepEqual(decorationWords(planned.values as Record<string, unknown>), {
    style: 'WAVY', offset: 2, thickness: '10%', color: '#FB5B0A @0.5', skipInk: false,
  })
})

test('Figma\'s defaults read as nothing, so a plain underline adds no noise', () => {
  assert.equal(
    decorationWords({
      textDecorationStyle: 'SOLID',
      textDecorationOffset: { unit: 'AUTO' },
      textDecorationThickness: { unit: 'AUTO' },
      textDecorationColor: { value: 'AUTO' },
      textDecorationSkipInk: true,
    }),
    null
  )
  assert.deepEqual(planDecoration({ color: 'AUTO', offset: 'AUTO' }), {
    values: { textDecorationOffset: { unit: 'AUTO' }, textDecorationColor: { value: 'AUTO' } },
  })
})

test('a wrong decoration is named, on the node and in a run', () => {
  assert.match(planProps({ decoration: { style: 'ZIGZAG' } }).problems[0], /SOLID, WAVY, DOTTED/)
  assert.match(planProps({ decoration: { blur: 2 } }).problems[0], /not blur/)
  assert.match(planProps({ runs: [{ from: 0, to: 3, decoration: { offset: 'far' } }] }).problems[0], /offset must be/)
  assert.deepEqual(planProps({ decoration: { style: 'DOTTED' } }).steps, [{ step: 'decoration', values: { textDecorationStyle: 'DOTTED' } }])
})
