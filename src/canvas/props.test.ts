import test from 'node:test'
import assert from 'node:assert/strict'
import { paintProblem, planProps } from './props.ts'
import { planCreate, NODE_KINDS } from './create.ts'

const stepsOf = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return plan.steps
}

/* ------------------------------------------------------------------- ordering */

test('the plan comes out in our order, not the order it was typed in', () => {
  // Auto-layout has to be set before sizing means anything, and a font before characters can be
  // written. Honouring key order would make a screen depend on how somebody typed it.
  const steps = stepsOf({
    text: 'Hello',
    fontName: { family: 'Inter', style: 'Bold' },
    width: 320,
    layout: { mode: 'VERTICAL', gap: 8 },
    name: 'Card',
  })
  assert.deepEqual(
    steps.map((step) => (step.step === 'assign' ? step.property : step.step)),
    ['name', 'layout', 'resize', 'font', 'text']
  )
})

test('width and height become one resize, never two', () => {
  const steps = stepsOf({ width: 100, height: 50 })
  assert.deepEqual(steps, [{ step: 'resize', width: 100, height: 50 }])
})

test('one dimension alone is still a resize, and keeps the other', () => {
  assert.deepEqual(stepsOf({ height: 44 }), [{ step: 'resize', height: 44 }])
})

/* ---------------------------------------------------------------- vocabulary */

test('a colour, a colour with opacity, a variable and null are all paints', () => {
  assert.deepEqual(stepsOf({ fill: '#FB5B0A' }), [{ step: 'paint', property: 'fills', ref: '#FB5B0A' }])
  assert.deepEqual(stepsOf({ fill: { color: '#000000', opacity: 0.5 } })[0], {
    step: 'paint',
    property: 'fills',
    ref: { color: '#000000', opacity: 0.5 },
  })
  assert.deepEqual(stepsOf({ stroke: { variable: 'border/default' } })[0], {
    step: 'paint',
    property: 'strokes',
    ref: { variable: 'border/default' },
  })
  // null is how a caller says "no fill" — distinct from not mentioning fill at all.
  assert.deepEqual(stepsOf({ fill: null }), [{ step: 'paint', property: 'fills', ref: null }])
})

test('padding takes one number or four, and comes out as four', () => {
  const one = stepsOf({ layout: { padding: 12 } })[0]
  assert.deepEqual(one, { step: 'layout', layout: { padding: [12, 12, 12, 12] } })
  const four = stepsOf({ layout: { padding: [8, 16, 8, 16] } })[0]
  assert.deepEqual(four, { step: 'layout', layout: { padding: [8, 16, 8, 16] } })
})

test('a radius is one number or named corners', () => {
  assert.deepEqual(stepsOf({ cornerRadius: 8 })[0], {
    step: 'radius',
    corners: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
  })
  assert.deepEqual(stepsOf({ cornerRadius: { topLeft: 4, bottomRight: 12 } })[0], {
    step: 'radius',
    corners: { topLeft: 4, bottomRight: 12 },
  })
})

test('a line height is a number of pixels or AUTO', () => {
  assert.deepEqual(stepsOf({ lineHeight: 24 }), [{ step: 'lineHeight', value: 24 }])
  assert.deepEqual(stepsOf({ lineHeight: 'AUTO' }), [{ step: 'lineHeight', value: 'AUTO' }])
})

test('textAlign and autoResize are renamed to what Figma calls them', () => {
  // The vocabulary is the caller's; the property names are Figma's.
  assert.deepEqual(stepsOf({ textAlign: 'CENTER', autoResize: 'HEIGHT' }), [
    { step: 'assign', property: 'textAlignHorizontal', value: 'CENTER' },
    { step: 'assign', property: 'textAutoResize', value: 'HEIGHT' },
  ])
})

test('a parent and an index travel together as one placement', () => {
  assert.deepEqual(stepsOf({ parent: '1:2', index: 0 }), [{ step: 'reparent', parent: '1:2', index: 0 }])
  // An index with no parent is a move within the parent the node already has.
  assert.deepEqual(stepsOf({ index: 3 }), [{ step: 'reparent', parent: '', index: 3 }])
})

/* ------------------------------------------------------------------ refusals */

test('an unknown property is named, with the list of what was accepted', () => {
  // A silently ignored `fontWeight` is a caller who thinks they set the weight.
  const plan = planProps({ fontWeight: 700 })
  assert.equal(plan.steps.length, 0)
  assert.match(plan.problems[0], /unknown property "fontWeight"/)
  // The whole accepted set, so a caller who guessed can see the one they meant.
  assert.match(plan.problems[0], /accepted: name, /)
  assert.match(plan.problems[0], /fontSize/)
})

test('a value of the wrong type is refused, and the rest of the object still plans', () => {
  const plan = planProps({ name: 'Card', opacity: 'half', width: 100 })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /opacity must be a number/)
  // Per-property, like every report in this plugin: one bad key does not lose the others.
  assert.deepEqual(
    plan.steps.map((step) => (step.step === 'assign' ? step.property : step.step)),
    ['name', 'resize']
  )
})

test('a number outside its range says which way', () => {
  assert.match(planProps({ opacity: 4 }).problems[0], /must be <= 1/)
  assert.match(planProps({ width: 0 }).problems[0], /must be >= 0.01/)
  assert.match(planProps({ rotation: 400 }).problems[0], /must be <= 180/)
})

test('an enum lists its options rather than saying no', () => {
  assert.match(planProps({ textAlign: 'MIDDLE' }).problems[0], /LEFT, CENTER, RIGHT, JUSTIFIED/)
  assert.match(planProps({ layout: { mode: 'GRID' } }).problems[0], /NONE, HORIZONTAL, VERTICAL/)
  assert.match(planProps({ layout: { sizing: { horizontal: 'STRETCH' } } }).problems[0], /FIXED, HUG, FILL/)
})

test('an unknown layout key is named too', () => {
  assert.match(planProps({ layout: { spacing: 4 } }).problems[0], /unknown key "spacing"/)
})

test('props that are not an object are refused as such', () => {
  assert.deepEqual(planProps([1, 2]).problems, ['props must be an object of properties'])
  assert.deepEqual(planProps(undefined), { steps: [], problems: [] })
})

test('paintProblem accepts what a paint can be and explains what it cannot', () => {
  assert.equal(paintProblem('#FFF'), null)
  assert.equal(paintProblem('#ff5b0a'), null)
  assert.equal(paintProblem(null), null)
  assert.equal(paintProblem({ variable: 'x' }), null)
  assert.match(paintProblem('red') ?? '', /not a #RRGGBB colour/)
  assert.match(paintProblem({}) ?? '', /must carry either `color`, `variable` or `image`/)
  assert.match(paintProblem({ color: '#000', opacity: 2 }) ?? '', /between 0 and 1/)
})

/* -------------------------------------------------------------------- create */

test('a create tree plans whole, children and all', () => {
  const problems: string[] = []
  const plan = planCreate(
    {
      kind: 'frame',
      props: { name: 'Card', layout: { mode: 'VERTICAL', gap: 8 }, fill: '#FFFFFF' },
      children: [
        { kind: 'text', props: { text: 'Title', fontSize: 18 } },
        { kind: 'rectangle', props: { height: 2, fill: { variable: 'border/default' } } },
      ],
    },
    'nodes[0]',
    problems
  )
  assert.deepEqual(problems, [])
  assert.equal(plan?.kind, 'frame')
  assert.equal(plan?.children.length, 2)
  assert.equal(plan?.children[0].kind, 'text')
})

test('every problem in the tree is reported with the path that caused it', () => {
  // One bad grandchild should not leave half a card on the canvas — so the whole tree is read
  // before anything is made.
  const problems: string[] = []
  planCreate(
    {
      kind: 'frame',
      children: [{ kind: 'text', props: { fontSize: 'big' } }, { kind: 'carousel' }],
    },
    'nodes[0]',
    problems
  )
  assert.equal(problems.length, 2)
  assert.match(problems[0], /^nodes\[0\]\.children\[0\]\.props\.fontSize must be a number/)
  assert.match(problems[1], /^nodes\[0\]\.children\[1\]\.kind must be one of/)
})

test('an instance must name what it is an instance of', () => {
  const problems: string[] = []
  assert.equal(planCreate({ kind: 'instance' }, 'nodes[0]', problems), null)
  assert.match(problems[0], /must name the component to instantiate/)
  problems.length = 0
  assert.ok(planCreate({ kind: 'instance', of: '1:2' }, 'nodes[0]', problems))
  assert.deepEqual(problems, [])
})

test('the kinds are the ones the applier knows how to make', () => {
  assert.deepEqual([...NODE_KINDS], ['frame', 'text', 'rectangle', 'ellipse', 'line', 'section', 'component', 'instance'])
})

test('an unknown key on a spec is named rather than ignored', () => {
  const problems: string[] = []
  planCreate({ kind: 'frame', styles: [] }, 'nodes[0]', problems)
  assert.match(problems[0], /unknown key "styles" — accepted: kind, of, props, children/)
})

/* ------------------------------------------------------------------- effects */

test('a shadow is two words and the rest is what a designer would have picked', () => {
  const steps = stepsOf({ effects: [{ shadow: 'drop' }] })
  assert.deepEqual(steps, [
    {
      step: 'effects',
      effects: [
        {
          type: 'DROP_SHADOW',
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 0,
          visible: true,
          blendMode: 'NORMAL',
        },
      ],
      summary: 'drop shadow #000000 @0.25 0,4 blur 8',
    },
  ])
})

test('every field of a shadow can be said, and an inner one is a different type', () => {
  const step = stepsOf({
    effects: [{ shadow: 'inner', color: '#FF5B0A', opacity: 1, offset: [2, -2], radius: 12, spread: 3, visible: false }],
  })[0] as Extract<(typeof stepsOf extends never ? never : ReturnType<typeof stepsOf>)[number], { step: 'effects' }>
  assert.equal(step.effects[0].type, 'INNER_SHADOW')
  assert.deepEqual(step.effects[0], {
    type: 'INNER_SHADOW',
    color: { r: 1, g: 0x5b / 255, b: 0x0a / 255, a: 1 },
    offset: { x: 2, y: -2 },
    radius: 12,
    spread: 3,
    visible: false,
    blendMode: 'NORMAL',
  })
  assert.match(step.summary, /inner shadow #FF5B0A 2,-2 blur 12 spread 3/)
})

test('a blur names which kind, and carries the blurType Figma insists on', () => {
  const step = stepsOf({ effects: [{ blur: 'background', radius: 20 }] })[0] as { effects: unknown[] }
  assert.deepEqual(step.effects[0], { type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: 20, visible: true })
})

test('an empty list removes what a node has, like every other whole-value property here', () => {
  const step = stepsOf({ effects: [] })[0] as { effects: unknown[]; summary: string }
  assert.deepEqual(step.effects, [])
  assert.equal(step.summary, 'none')
})

test('a wrong effect is named where it sits, and the others still plan', () => {
  const plan = planProps({ effects: [{ shadow: 'drop' }, { shadow: 'sideways' }, { blur: 'layer' }] })
  assert.equal(plan.problems.length, 2)
  assert.match(plan.problems[0], /effects\[1\]: shadow must be "drop" or "inner"/)
  assert.match(plan.problems[1], /effects\[2\]: radius must be a number >= 0/)
  assert.match(planProps({ effects: [{ shadow: 'drop', blurRadius: 4 }] }).problems[0], /unknown key "blurRadius"/)
  assert.match(planProps({ effects: {} }).problems[0], /must be an array of shadows and blurs/)
})

/* --------------------------------------------------------------------- paint */

test('a list of paints is a stack of layers', () => {
  const plan = planProps({ fill: ['#FFFFFF', { variable: 'brand/base' }] })
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.steps[0], { step: 'paint', property: 'fills', ref: ['#FFFFFF', { variable: 'brand/base' }] })
})

test('a bad paint inside a stack says which layer', () => {
  assert.match(planProps({ fill: ['#FFFFFF', 'chartreuse'] }).problems[0], /\[1\] "chartreuse" is not a #RRGGBB colour/)
})

test('an image names exactly one source', () => {
  assert.equal(paintProblem({ image: { hash: 'abc' } }), null)
  assert.equal(paintProblem({ image: { url: 'https://example.com/a.png' }, scaleMode: 'FIT' }), null)
  assert.match(paintProblem({ image: {} }) ?? '', /must name one of hash, url or bytes/)
  assert.match(paintProblem({ image: { url: 'x', bytes: 'y' } }) ?? '', /names url and bytes — pick one/)
  assert.match(paintProblem({ image: { hash: 'a' }, scaleMode: 'STRETCH' }) ?? '', /scaleMode must be one of: FILL, FIT/)
})

/* -------------------------------------------------------------------- stroke */

test('the rest of a stroke is plain vocabulary', () => {
  assert.deepEqual(stepsOf({ strokeAlign: 'OUTSIDE' }), [{ step: 'assign', property: 'strokeAlign', value: 'OUTSIDE' }])
  assert.deepEqual(stepsOf({ strokeDashes: [4, 2] }), [{ step: 'dashes', dashes: [4, 2] }])
  assert.deepEqual(stepsOf({ strokeDashes: [] }), [{ step: 'dashes', dashes: [] }])
  assert.match(planProps({ strokeAlign: 'MIDDLE' }).problems[0], /INSIDE, OUTSIDE, CENTER/)
  assert.match(planProps({ blendMode: 'BURN' }).problems[0], /blendMode must be one of/)
  assert.match(planProps({ strokeDashes: [-1] }).problems[0], /array of numbers >= 0/)
})
