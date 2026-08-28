import test from 'node:test'
import assert from 'node:assert/strict'
import { describeProperties, humanPropertyName, resolveProperties } from './components.ts'
import { planProps } from './props.ts'

/* --------------------------------------------------------------------- names */

test('the # suffix Figma adds is not part of the name anyone uses', () => {
  assert.equal(humanPropertyName('Label#12:34'), 'Label')
  assert.equal(humanPropertyName('Size'), 'Size')
  assert.equal(humanPropertyName('Icon on#0:1'), 'Icon on')
})

/* -------------------------------------------------------------- the one line */

test('a component reads as one line, options and defaults included', () => {
  const line = describeProperties({
    Size: { type: 'VARIANT', variantOptions: ['Small', 'Medium', 'Large'], defaultValue: 'Medium' },
    'Label#1:2': { type: 'TEXT', defaultValue: 'Continue' },
    'Icon#1:3': { type: 'BOOLEAN', defaultValue: true },
  })
  assert.equal(line, 'Size: Small|Medium|Large (=Medium) · Label: text (=Continue) · Icon: boolean (=true)')
})

test('a long list of options is cut with a count, not silently', () => {
  const options = Array.from({ length: 14 }, (_, index) => `o${index}`)
  const line = describeProperties({ Icon: { type: 'VARIANT', variantOptions: options } })
  assert.match(line, /\|…\+6$/)
})

test('a component with no properties says nothing rather than something empty', () => {
  assert.equal(describeProperties({}), '')
})

/* ----------------------------------------------------------------- resolution */

const DEFINED = {
  Size: { type: 'VARIANT', value: 'Medium' },
  'Label#1:2': { type: 'TEXT', value: 'Continue' },
  'Icon#1:3': { type: 'BOOLEAN', value: false },
}

test('a name off the catalogue resolves to the key setProperties wants', () => {
  const { resolved, problems } = resolveProperties({ Label: 'Get started', Size: 'Large' }, DEFINED)
  assert.deepEqual(problems, [])
  assert.deepEqual(resolved, { 'Label#1:2': 'Get started', Size: 'Large' })
})

test('the full key still works — a caller may echo back what it read', () => {
  const { resolved } = resolveProperties({ 'Label#1:2': 'Next' }, DEFINED)
  assert.deepEqual(resolved, { 'Label#1:2': 'Next' })
})

test('case is forgiven, because a prompt is where these names come from', () => {
  const { resolved, problems } = resolveProperties({ size: 'Small', icon: true }, DEFINED)
  assert.deepEqual(problems, [])
  assert.deepEqual(resolved, { Size: 'Small', 'Icon#1:3': true })
})

test('an unknown property is named, with the ones that do exist', () => {
  const { resolved, problems } = resolveProperties({ Colour: 'Brand' }, DEFINED)
  assert.deepEqual(resolved, {})
  assert.match(problems[0], /"Colour" is not a property here/)
  assert.match(problems[0], /Size, Label, Icon/)
})

test('two properties of the same name are a question, not a guess', () => {
  const { problems } = resolveProperties(
    { Label: 'x' },
    { 'Label#1:2': { type: 'TEXT' }, 'Label#9:9': { type: 'TEXT' } }
  )
  assert.match(problems[0], /matches 2 properties/)
  assert.match(problems[0], /name one in full/)
})

test('a boolean property refuses the string "true" here, where the message can still say why', () => {
  // Figma throws about the property, never about the value — so the check lives on this side.
  const { resolved, problems } = resolveProperties({ Icon: 'true' }, DEFINED)
  assert.deepEqual(resolved, {})
  assert.match(problems[0], /Icon is a boolean property/)
  assert.match(resolveProperties({ Size: true }, DEFINED).problems[0], /Size is a variant property/)
})

test('one bad property does not lose the good ones', () => {
  const { resolved, problems } = resolveProperties({ Size: 'Large', Nope: 'x' }, DEFINED)
  assert.deepEqual(resolved, { Size: 'Large' })
  assert.equal(problems.length, 1)
})

/* ------------------------------------------------------- the vocabulary itself */

test('what an instance is comes before what it looks like', () => {
  // A swap brings the new component's own size with it, and a variant is a different node
  // underneath — so a width set in the same call has to be applied after both.
  const { steps, problems } = planProps({
    width: 320,
    properties: { Size: 'Large' },
    swap: '1:2',
    reset: true,
    name: 'CTA',
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(
    steps.map((step) => (step.step === 'assign' ? step.property : step.step)),
    ['name', 'reset', 'swap', 'properties', 'resize']
  )
})

test('reset: false keeps the overrides and plans nothing', () => {
  assert.deepEqual(planProps({ reset: false }).steps, [])
  assert.match(planProps({ reset: 'yes' }).problems[0], /reset must be true or false/)
})

test('a property value that Figma could never take is refused in the plan', () => {
  const plan = planProps({ properties: { Size: 12 } })
  assert.match(plan.problems[0], /properties.Size must be a string or a boolean/)
  assert.match(planProps({ properties: {} }).problems[0], /must name at least one property/)
  assert.match(planProps({ properties: [] }).problems[0], /must be an object/)
  assert.match(planProps({ swap: '  ' }).problems[0], /swap must be a component id or a published key/)
})
