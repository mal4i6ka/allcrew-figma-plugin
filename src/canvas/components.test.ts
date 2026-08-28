import test from 'node:test'
import assert from 'node:assert/strict'
import { bindingField, describeProperties, humanPropertyName, planComponentProperties, resolveProperties } from './components.ts'
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

/* ------------------------------------------------------------- authoring */

test('a property type decides which field of a layer it drives', () => {
  // The half everyone forgets: addComponentProperty puts a row in the panel and changes nothing
  // until some layer points at it.
  assert.equal(bindingField('BOOLEAN'), 'visible')
  assert.equal(bindingField('TEXT'), 'characters')
  assert.equal(bindingField('INSTANCE_SWAP'), 'mainComponent')
  assert.equal(bindingField('VARIANT'), null)
})

test('an add carries its default in the type the property will hold', () => {
  const plan = planComponentProperties({
    add: [
      { name: 'Label', type: 'text', default: 'Continue', bind: ['1:2'] },
      { name: 'Icon', type: 'BOOLEAN', default: true, bind: ['1:3'] },
    ],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.add[0].type, 'TEXT')
  assert.deepEqual(plan.add[0].bind, ['1:2'])
  assert.equal(plan.add[1].default, true)
})

test('a default of the wrong type is refused where the message can still explain', () => {
  assert.match(
    planComponentProperties({ add: [{ name: 'Icon', type: 'BOOLEAN', default: 'true' }] }).problems[0],
    /default must be true or false for a BOOLEAN property/
  )
  assert.match(
    planComponentProperties({ add: [{ name: 'Label', type: 'TEXT', default: 3 }] }).problems[0],
    /default must be a string for a TEXT property/
  )
  assert.match(
    planComponentProperties({ add: [{ name: 'Size', type: 'SLIDER', default: 'L' }] }).problems[0],
    /type must be one of: BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT/
  )
})

test('a variant property cannot be bound to a layer, and says why', () => {
  assert.match(
    planComponentProperties({ add: [{ name: 'Size', type: 'VARIANT', default: 'L', bind: ['1:2'] }] }).problems[0],
    /its values are the components' names/
  )
})

test('an edit that changes nothing is refused rather than run', () => {
  assert.match(planComponentProperties({ edit: [{ name: 'Label' }] }).problems[0], /changes nothing/)
  assert.deepEqual(planComponentProperties({ edit: [{ name: 'Label', rename: 'Text' }] }).problems, [])
})

test('an empty request is a mistake, not a no-op', () => {
  assert.match(planComponentProperties({}).problems[0], /nothing to do/)
  assert.match(planComponentProperties({ add: 'Label' }).problems[0], /add must be an array/)
  assert.match(planComponentProperties([]).problems[0], /must be an object/)
})

test('a bind on its own names the layer and the property', () => {
  const plan = planComponentProperties({ bind: [{ node: '1:2', property: 'Label' }] })
  assert.deepEqual(plan.bind, [{ node: '1:2', property: 'Label' }])
  assert.match(planComponentProperties({ bind: [{ node: '1:2' }] }).problems[0], /must be \{ node: "<layer id>", property/)
})

/* ---------------------------------------------------------------------- slots */

test('a slot takes no default, because it holds layers rather than a value', () => {
  const plan = planComponentProperties({
    add: [{ name: 'Content', type: 'SLOT', settings: { minChildren: 1, maxChildren: 3 } }],
  })
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.add[0], {
    name: 'Content',
    type: 'SLOT',
    settings: { minChildren: 1, maxChildren: 3 },
  })
  assert.match(
    planComponentProperties({ add: [{ name: 'Content', type: 'SLOT', default: 'x' }] }).problems[0],
    /a SLOT has no default/
  )
})

test('slot settings belong to a slot, and every field of them is checked', () => {
  assert.match(
    planComponentProperties({ add: [{ name: 'Label', type: 'TEXT', default: 'x', settings: {} }] }).problems[0],
    /settings belongs to a SLOT property, not to a TEXT one/
  )
  assert.match(
    planComponentProperties({ add: [{ name: 'C', type: 'SLOT', settings: { maxChildren: -1 } }] }).problems[0],
    /maxChildren must be a whole number >= 0, or null for no limit/
  )
  assert.match(
    planComponentProperties({ add: [{ name: 'C', type: 'SLOT', settings: { stretch: true } }] }).problems[0],
    /unknown key "stretch"/
  )
  // null is how a limit is removed, and it is a value rather than an absence.
  assert.deepEqual(
    planComponentProperties({ add: [{ name: 'C', type: 'SLOT', settings: { maxChildren: null } }] }).problems,
    []
  )
})

test('a slot needs no binding, because creating one creates its node', () => {
  assert.equal(bindingField('SLOT'), null)
  assert.match(
    planComponentProperties({ add: [{ name: 'C', type: 'SLOT', bind: ['1:2'] }] }).problems[0],
    /is not bound to layers/
  )
})
