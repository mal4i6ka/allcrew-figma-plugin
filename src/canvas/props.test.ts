import test from 'node:test'
import assert from 'node:assert/strict'
import { gradientHandles, gradientTransform, paintProblem, planProps } from './props.ts'
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
    // Sizing is two steps and the split is the point: FIXED goes BEFORE the resize, because a
    // hugging frame swallows a resize whole; HUG and FILL go after — after the resize that would
    // otherwise re-pin the axis, after the text a hugging frame measures itself against, and
    // after any reparent, since FILL means nothing until the node is inside what it fills.
    ['name', 'layout', 'sizing', 'resize', 'font', 'text', 'sizing']
  )
})

test('turning auto-layout on makes a frame hug, because 100x100 clips what you put in it', () => {
  // A frame Figma hands out is 100x100 and FIXED. `{ layout: { mode: 'VERTICAL' } }` alone used
  // to leave exactly that, so the first thing put inside it was cut off.
  assert.deepEqual(stepsOf({ layout: { mode: 'VERTICAL' } }).at(-1), {
    step: 'sizing',
    horizontal: 'HUG',
    vertical: 'HUG',
  })
  // A dimension the caller gave is a dimension they meant: that axis is PINNED before the resize,
  // because a hugging frame swallows one whole — a 260-wide frame came out 320.
  const pinned = stepsOf({ layout: { mode: 'VERTICAL' }, width: 320 })
  assert.deepEqual(pinned[1], { step: 'sizing', horizontal: 'FIXED' })
  assert.equal(pinned[2].step, 'resize')
  assert.deepEqual(pinned.at(-1), { step: 'sizing', vertical: 'HUG' })
  // And an explicit sizing wins over both.
  assert.deepEqual(stepsOf({ layout: { mode: 'HORIZONTAL', sizing: { horizontal: 'FILL' } } }).at(-1), {
    step: 'sizing',
    horizontal: 'FILL',
    vertical: 'HUG',
  })
  // No auto-layout, no sizing: a plain frame is left alone.
  assert.deepEqual(stepsOf({ layout: { padding: 8 } }).length, 1)
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

test('leading and tracking take pixels or a percentage, and carry the unit', () => {
  // Figma stores both as { value, unit } and refuses a bare number, so the unit is decided here
  // rather than assumed to be pixels at the far end.
  assert.deepEqual(stepsOf({ lineHeight: 24 }), [{ step: 'lineHeight', value: 24, unit: 'PIXELS' }])
  assert.deepEqual(stepsOf({ lineHeight: '150%' }), [{ step: 'lineHeight', value: 150, unit: 'PERCENT' }])
  assert.deepEqual(stepsOf({ lineHeight: 'AUTO' }), [{ step: 'lineHeight', value: 'AUTO' }])
  assert.deepEqual(stepsOf({ letterSpacing: 1 }), [{ step: 'letterSpacing', value: 1, unit: 'PIXELS' }])
  assert.deepEqual(stepsOf({ letterSpacing: '-2.5%' }), [{ step: 'letterSpacing', value: -2.5, unit: 'PERCENT' }])
  assert.match(planProps({ letterSpacing: '5em' }).problems[0], /pixels or a percentage/)
  assert.match(planProps({ lineHeight: 0 }).problems[0], /positive/)
})

test('textAlign and autoResize are renamed to what Figma calls them', () => {
  // The vocabulary is the caller's; the property names are Figma's.
  // autoResize sits after the characters: set before them it freezes an empty box, and the
  // resize that follows has nothing to hold on to.
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
  // GRID joined the list in 2026 — Figma's two-dimensional auto-layout — so the refusal that
  // used to name it has to name something else.
  assert.match(planProps({ layout: { mode: 'DIAGONAL' } }).problems[0], /NONE, HORIZONTAL, VERTICAL, GRID/)
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
  assert.deepEqual(
    [...NODE_KINDS],
    [
      'frame',
      'text',
      'rectangle',
      'ellipse',
      'line',
      'section',
      'component',
      'instance',
      'vector',
      'svg',
      'star',
      'polygon',
      'textPath',
    ]
  )
})

test('svg carries the markup, and is refused without it', () => {
  const problems: string[] = []
  assert.ok(planCreate({ kind: 'svg', of: '<svg viewBox="0 0 2 2"><path d="M0 0 L2 2"/></svg>' }, 'n', problems))
  assert.deepEqual(problems, [])
  planCreate({ kind: 'svg', of: 'a circle' }, 'n', problems)
  assert.match(problems[0], /must be the SVG markup itself, starting with <svg/)
})

test('a path is SVG data, and both spellings land in one step', () => {
  assert.deepEqual(stepsOf({ path: 'M 0 0 L 10 0 L 10 10 Z' }), [
    { step: 'paths', paths: [{ data: 'M 0 0 L 10 0 L 10 10 Z', windingRule: 'NONZERO' }] },
  ])
  assert.deepEqual(stepsOf({ paths: [{ data: 'M 0 0 L 1 1', windingRule: 'EVENODD' }] }), [
    { step: 'paths', paths: [{ data: 'M 0 0 L 1 1', windingRule: 'EVENODD' }] },
  ])
  // Saying both is not two shapes; the first one planned wins and nothing is applied twice.
  assert.equal(stepsOf({ path: 'M 0 0 L 1 1', paths: [{ data: 'M 2 2 L 3 3' }] }).length, 1)
  assert.match(planProps({ path: '' }).problems[0], /must be SVG path data/)
  assert.match(planProps({ paths: [{ data: 'M 0 0', windingRule: 'ROUND' }] }).problems[0], /NONZERO or EVENODD/)
})

test('a shape is set before the paints that fill it', () => {
  assert.deepEqual(
    planProps({ fill: '#FF5B0A', path: 'M 0 0 L 1 1' }).steps.map((step) => step.step),
    ['paths', 'paint']
  )
})

test('an unknown key on a spec is named rather than ignored', () => {
  const problems: string[] = []
  planCreate({ kind: 'frame', styles: [] }, 'nodes[0]', problems)
  assert.match(problems[0], /unknown key "styles" — accepted: kind, of, props, children, at/)
})

/* ------------------------------------------------------------------- effects */

test('a shadow is two words and the rest is what a designer would have picked', () => {
  const steps = stepsOf({ effects: [{ shadow: 'drop' }] })
  assert.deepEqual(steps, [
    {
      step: 'effects',
      bind: [],
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

/* ----------------------------------------------------------------- gradients */

test('an angle is the line through the middle: 0 left to right, 90 top to bottom', () => {
  assert.deepEqual(gradientHandles({ angle: 0 }), { from: [0, 0.5], to: [1, 0.5] })
  const down = gradientHandles({ angle: 90 })
  assert.deepEqual(down.from.map((n) => Math.round(n * 1e6) / 1e6), [0.5, 0])
  assert.deepEqual(down.to.map((n) => Math.round(n * 1e6) / 1e6), [0.5, 1])
  // Top to bottom is what Figma gives a designer who clicks "Linear", so it is the default.
  assert.deepEqual(gradientHandles({}), gradientHandles({ angle: 90 }))
  assert.deepEqual(gradientHandles({ from: [0, 0], to: [1, 1] }), { from: [0, 0], to: [1, 1] })
})

test('the identity matrix is a gradient running left to right — the fact the derivation is pinned to', () => {
  assert.deepEqual(gradientTransform([0, 0], [1, 0]), [
    [1, 0, 0],
    [0, 1, 0],
  ])
})

test('the matrix reads 0 at the start handle and 1 at the end, whichever way it points', () => {
  // What the matrix is FOR: gradient-space x is the position along the gradient.
  const along = (t: number[][], p: number[]) => t[0][0] * p[0] + t[0][1] * p[1] + t[0][2]
  for (const [from, to] of [
    [[0, 0.5], [1, 0.5]],
    [[0.5, 0], [0.5, 1]],
    [[0.2, 0.8], [0.9, 0.1]],
  ] as Array<[number[], number[]]>) {
    const matrix = gradientTransform(from as [number, number], to as [number, number])
    assert.ok(Math.abs(along(matrix, from)) < 1e-9, `starts at 0 for ${from}`)
    assert.ok(Math.abs(along(matrix, to) - 1) < 1e-9, `ends at 1 for ${to}`)
  }
})

test('the second row is the first turned a quarter, so a circle stays a circle', () => {
  const [[a, b], [c, d]] = gradientTransform([0.5, 0], [0.5, 1])
  assert.ok(Math.abs(a * c + b * d) < 1e-9, 'the rows are perpendicular')
  assert.ok(Math.abs(Math.hypot(a, b) - Math.hypot(c, d)) < 1e-9, 'and the same length')
})

test('a gradient is refused for every way of getting it wrong', () => {
  assert.equal(paintProblem({ gradient: 'linear', stops: ['#FFFFFF', '#000000'] }), null)
  assert.equal(paintProblem({ gradient: 'RADIAL', stops: [{ at: 0, color: { variable: 'brand/base' } }, { at: 1, color: '#000' }] }), null)
  assert.match(paintProblem({ gradient: 'SPIRAL', stops: ['#FFF', '#000'] }) ?? '', /LINEAR, RADIAL, ANGULAR, DIAMOND/)
  assert.match(paintProblem({ gradient: 'LINEAR', stops: ['#FFF'] }) ?? '', /at least two colours/)
  assert.match(paintProblem({ gradient: 'LINEAR', stops: ['#FFF', 'teal'] }) ?? '', /stops\[1\]: "teal" is not a #RRGGBB/)
  assert.match(paintProblem({ gradient: 'LINEAR', stops: [{ at: 2, color: '#FFF' }, '#000'] }) ?? '', /at must be between 0 and 1/)
  assert.match(
    paintProblem({ gradient: 'LINEAR', stops: ['#FFF', '#000'], angle: 45, from: [0, 0], to: [1, 1] }) ?? '',
    /either an angle or from\/to, not both/
  )
  assert.match(paintProblem({ gradient: 'LINEAR', stops: ['#FFF', '#000'], from: [0, 0] }) ?? '', /from and to travel together/)
  assert.match(paintProblem({ gradient: 'LINEAR', stops: ['#FFF', '#000'], stop: 1 }) ?? '', /unknown key "stop"/)
})

test('a radial gradient measures from the middle, not from a corner', () => {
  // Using the linear form for a radial put the centre of every one of them on the left edge —
  // algebraically fine, visibly wrong, and only a render said so.
  const { from, to } = gradientHandles({ gradient: 'RADIAL' })
  assert.deepEqual(from, [0.5, 0.5])
  assert.deepEqual(to, [1, 0.5])
  // The middle of the layer with a radius reaching half way IS the identity, the same way left
  // to right is for a linear one.
  assert.deepEqual(gradientTransform(from, to, 'RADIAL'), [
    [1, 0, 0],
    [0, 1, 0],
  ])
})

test('the centred form puts the centre at the middle of gradient space and the edge half a unit off', () => {
  const at = (t: number[][], p: number[]) => [
    t[0][0] * p[0] + t[0][1] * p[1] + t[0][2],
    t[1][0] * p[0] + t[1][1] * p[1] + t[1][2],
  ]
  const from: [number, number] = [0.3, 0.7]
  const to: [number, number] = [0.8, 0.2]
  const matrix = gradientTransform(from, to, 'DIAMOND')
  const centre = at(matrix, from)
  const edge = at(matrix, to)
  assert.ok(Math.hypot(centre[0] - 0.5, centre[1] - 0.5) < 1e-9, 'the centre lands in the middle')
  assert.ok(Math.abs(Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) - 0.5) < 1e-9, 'the edge is half a unit out')
})

test('an angle turns a radial radius rather than moving its centre', () => {
  const turned = gradientHandles({ gradient: 'ANGULAR', angle: 90 })
  assert.deepEqual(turned.from, [0.5, 0.5])
  assert.deepEqual(turned.to.map((n) => Math.round(n * 1e6) / 1e6), [0.5, 1])
})

/* ------------------------------------------------------------------ binding */

const bindingsOf = (bind: unknown) => {
  const plan = planProps({ bind })
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return (plan.steps[0] as { step: 'bind'; bindings: Array<{ field: string; variable: string | null; wants: string }> })
    .bindings
}

test('one word for the padding binds all four sides, because that is what it means', () => {
  // Making somebody write four lines to say "the padding follows the spacing token" is how
  // people stop using tokens.
  assert.deepEqual(bindingsOf({ padding: 'space/16' }), [
    { field: 'paddingTop', variable: 'space/16', wants: 'FLOAT' },
    { field: 'paddingRight', variable: 'space/16', wants: 'FLOAT' },
    { field: 'paddingBottom', variable: 'space/16', wants: 'FLOAT' },
    { field: 'paddingLeft', variable: 'space/16', wants: 'FLOAT' },
  ])
})

test('this vocabulary keeps its own words, and Figma’s are accepted too', () => {
  assert.deepEqual(bindingsOf({ gap: 'space/8' }), [{ field: 'itemSpacing', variable: 'space/8', wants: 'FLOAT' }])
  assert.deepEqual(bindingsOf({ text: 'copy/cta' }), [{ field: 'characters', variable: 'copy/cta', wants: 'STRING' }])
  assert.deepEqual(bindingsOf({ itemSpacing: 'space/8' }), [{ field: 'itemSpacing', variable: 'space/8', wants: 'FLOAT' }])
  assert.deepEqual(bindingsOf({ visible: 'flag/promo' }), [{ field: 'visible', variable: 'flag/promo', wants: 'BOOLEAN' }])
})

test('null unbinds, and it is a value not an absence', () => {
  assert.deepEqual(bindingsOf({ width: null }), [{ field: 'width', variable: null, wants: 'FLOAT' }])
})

test('a paint says where paints are bound instead of failing obscurely', () => {
  assert.match(planProps({ bind: { fill: 'brand/base' } }).problems[0], /fill: \{ variable: "…" \} paints and binds in one go/)
})

test('a field that cannot be bound is named against the ones that can', () => {
  const problem = planProps({ bind: { shadow: 'x' } }).problems[0]
  assert.match(problem, /"shadow" is not a bindable field/)
  assert.match(problem, /padding/)
  assert.match(planProps({ bind: { width: 4 } }).problems[0], /must be a variable name, id or key — or null/)
  assert.match(planProps({ bind: [] }).problems[0], /must be an object of \{ field: "variable name" \}/)
  assert.match(planProps({ bind: {} }).problems[0], /names nothing to bind/)
})

test('the expected variable type travels with the field, so the applier can say which is wrong', () => {
  assert.equal(bindingsOf({ cornerRadius: 'radius/md' })[0].wants, 'FLOAT')
  assert.equal(bindingsOf({ fontFamily: 'type/family' })[0].wants, 'STRING')
})

/* -------------------------------------------------------------------- styles */

test('a style is named per slot, so nothing has to be guessed from the value', () => {
  assert.deepEqual(stepsOf({ fillStyle: 'Surface/Card' }), [
    { step: 'style', kind: 'paint', slot: 'fillStyle', ref: 'Surface/Card' },
  ])
  assert.deepEqual(stepsOf({ textStyle: 'Body/Regular' }), [
    { step: 'style', kind: 'text', slot: 'textStyle', ref: 'Body/Regular' },
  ])
  // A stroke follows a paint style too — the same kind, a different slot.
  assert.equal((stepsOf({ strokeStyle: 'Border/Subtle' })[0] as { kind: string }).kind, 'paint')
})

test('null detaches, and is a value rather than an absence', () => {
  assert.deepEqual(stepsOf({ fillStyle: null }), [{ step: 'style', kind: 'paint', slot: 'fillStyle', ref: null }])
  assert.match(planProps({ fillStyle: 4 }).problems[0], /must be a style name, id or key — or null to detach/)
})

test('a style is followed before the paints that override it', () => {
  // Following a style and then setting one colour means the colour wins, which is the order
  // anybody means by writing both.
  const plan = planProps({ fill: '#FFFFFF', fillStyle: 'Surface/Card', name: 'Card' })
  assert.deepEqual(
    plan.steps.map((step) => (step.step === 'assign' ? step.property : step.step === 'style' ? step.slot : step.step)),
    ['name', 'fillStyle', 'paint']
  )
})

/* --------------------------------------------------------------------- grids */

test('a column grid is said the way a designer says it', () => {
  const step = stepsOf({ grid: [{ columns: 12, gutter: 16, margin: 24 }] })[0] as {
    grids: unknown[]
    summary: string
  }
  assert.deepEqual(step.grids[0], {
    pattern: 'COLUMNS',
    // A margin only means anything when the sections stretch into what is left of the frame.
    alignment: 'STRETCH',
    gutterSize: 16,
    count: 12,
    offset: 24,
    visible: true,
  })
  assert.equal(step.summary, '12 column(s) stretch gutter 16 margin 24')
})

test('naming a width pins the columns instead of stretching them', () => {
  const step = stepsOf({ grid: [{ columns: 4, width: 80, gutter: 8 }] })[0] as { grids: Array<Record<string, unknown>> }
  assert.equal(step.grids[0].alignment, 'MIN')
  assert.equal(step.grids[0].sectionSize, 80)
})

test('rows and the square grid are the same vocabulary', () => {
  assert.equal((stepsOf({ grid: [{ rows: 5, height: 40 }] })[0] as { grids: Array<Record<string, unknown>> }).grids[0].pattern, 'ROWS')
  assert.deepEqual((stepsOf({ grid: [{ square: 8 }] })[0] as { grids: unknown[] }).grids[0], {
    pattern: 'GRID',
    sectionSize: 8,
    visible: true,
  })
})

test('an empty list removes the grids, and every mistake is named', () => {
  assert.deepEqual((stepsOf({ grid: [] })[0] as { grids: unknown[] }).grids, [])
  assert.match(planProps({ grid: [{ columns: 0 }] }).problems[0], /columns must be a whole number of at least 1/)
  assert.match(planProps({ grid: [{ columns: 12, align: 'MIDDLE' }] }).problems[0], /align must be one of: MIN, MAX/)
  assert.match(planProps({ grid: [{ columns: 12, gap: 8 }] }).problems[0], /unknown key "gap"/)
  assert.match(planProps({ grid: [{}] }).problems[0], /must be \{ columns \}, \{ rows \} or \{ square \}/)
  assert.match(planProps({ grid: {} }).problems[0], /must be an array of grids/)
})

/* ------------------------------------------------- effects that follow a token */

test('an effect field may name a variable, and the binding travels beside the effect', () => {
  const step = stepsOf({
    effects: [{ shadow: 'drop', color: { variable: 'shadow/ambient' }, radius: { variable: 'scale/16' }, offset: [0, { variable: 'scale/4' }] }],
  })[0] as { effects: Array<Record<string, unknown>>; bind: unknown[] }
  assert.deepEqual(step.bind, [
    { index: 0, field: 'color', variable: 'shadow/ambient' },
    { index: 0, field: 'offsetY', variable: 'scale/4' },
    { index: 0, field: 'radius', variable: 'scale/16' },
  ])
  // Figma wants a number in the effect whatever happens; the binding replaces it afterwards.
  assert.equal(step.effects[0].radius, 8)
  assert.deepEqual(step.effects[0].offset, { x: 0, y: 4 })
})

test('a field that is neither a number nor a variable is refused', () => {
  assert.match(planProps({ effects: [{ shadow: 'drop', radius: 'big' }] }).problems[0], /radius must be a number or \{ variable \}/)
  assert.match(planProps({ effects: [{ shadow: 'drop', color: 42 }] }).problems[0], /color must be a #RRGGBB colour or \{ variable \}/)
})

/* ------------------------------------------------------------------- network */

const networkOf = (network: unknown) => {
  const plan = planProps({ network })
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return plan.steps[0] as { step: 'network'; network: { vertices: unknown[]; segments: unknown[]; regions?: unknown[] }; summary: string }
}

test('the short forms are the point: pairs for points, pairs for the lines between them', () => {
  const step = networkOf({
    vertices: [[0, 0], [100, 0], [50, 80]],
    segments: [[0, 1], [1, 2], [2, 0]],
    regions: [{ loops: [[0, 1, 2]] }],
  })
  assert.deepEqual(step.network.vertices[0], { x: 0, y: 0 })
  assert.deepEqual(step.network.segments[0], { start: 0, end: 1 })
  assert.deepEqual(step.network.regions, [{ windingRule: 'NONZERO', loops: [[0, 1, 2]] }])
  assert.equal(step.summary, '3 point(s), 3 segment(s), 1 region(s)')
})

test('a point may carry its own cap, join and rounding, and a segment its curve', () => {
  const step = networkOf({
    vertices: [{ x: 0, y: 0, cap: 'ROUND', cornerRadius: 4 }, { x: 10, y: 0, join: 'BEVEL' }],
    segments: [{ start: 0, end: 1, curve: [3, 0, -3, 0] }],
  })
  assert.deepEqual(step.network.vertices[0], { x: 0, y: 0, strokeCap: 'ROUND', cornerRadius: 4 })
  assert.deepEqual(step.network.segments[0], {
    start: 0,
    end: 1,
    tangentStart: { x: 3, y: 0 },
    tangentEnd: { x: -3, y: 0 },
  })
})

test('a segment to a point that does not exist is named, with how many there are', () => {
  // Figma reports this as a failure with no index in it; here the index is still in hand.
  assert.match(
    planProps({ network: { vertices: [[0, 0], [1, 1]], segments: [[0, 5]] } }).problems[0],
    /segments\[0\]: there is no vertex 5 — the network has 2/
  )
  assert.match(
    planProps({ network: { vertices: [[0, 0], [1, 1]], segments: [[1, 1]] } }).problems[0],
    /cannot start and end at the same point/
  )
})

test('a region pointing at a segment that does not exist is named the same way', () => {
  assert.match(
    planProps({ network: { vertices: [[0, 0], [1, 1]], segments: [[0, 1]], regions: [{ loops: [[0, 3]] }] } }).problems[0],
    /there is no segment 3 — the network has 1/
  )
})

test('a network needs points and something joining them', () => {
  assert.match(planProps({ network: { vertices: [[0, 0]], segments: [[0, 0]] } }).problems[0], /at least two points/)
  assert.match(planProps({ network: { vertices: [[0, 0], [1, 1]], segments: [] } }).problems[0], /at least one \{ start, end \}/)
  assert.match(planProps({ network: 'triangle' }).problems[0], /must be \{ vertices, segments, regions\? \}/)
  assert.match(
    planProps({ network: { vertices: [[0, 0], [1, 1]], segments: [[0, 1]], points: [] } }).problems[0],
    /unknown key "points"/
  )
})

test('a network is set before the paints, like every other shape', () => {
  assert.deepEqual(
    planProps({ fill: '#FF5B0A', network: { vertices: [[0, 0], [1, 1]], segments: [[0, 1]] } }).steps.map((s) => s.step),
    ['network', 'paint']
  )
})

/* ------------------------------------------------------------------- motion */

test('an animation names a style and whatever settings that style takes', () => {
  const step = stepsOf({
    animation: { style: 'Position', duration: 0.4, props: { direction: 'right', distance: 120 } },
  })[0] as { styles: unknown[]; summary: string }
  assert.deepEqual(step.styles, [
    { style: 'Position', duration: 0.4, props: { direction: 'right', distance: 120 } },
  ])
  assert.equal(step.summary, 'Position 0.4s (direction=right, distance=120)')
})

test('the one prop every style calls easing takes the link vocabulary', () => {
  const step = stepsOf({ animation: { style: 'Position', props: { easing: 'BOUNCY' } } })[0] as {
    styles: Array<{ props: Record<string, unknown> }>
  }
  assert.deepEqual(step.styles[0].props.easing, { type: 'BOUNCY' })
  const bent = stepsOf({ animation: { style: 'Position', props: { easing: { bezier: [0.2, 0, 0, 1] } } } })[0] as {
    styles: Array<{ props: Record<string, unknown> }>
  }
  assert.deepEqual(bent.styles[0].props.easing, {
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 },
  })
  assert.match(planProps({ animation: { style: 'Position', props: { easing: 'WOBBLY' } } }).problems[0], /easing must be one of/)
})

test('a prop may follow a variable, and anything Figma cannot hold is refused', () => {
  const step = stepsOf({ animation: { style: 'Position', props: { distance: { variable: 'scale/16' } } } })[0] as {
    styles: Array<{ props: Record<string, unknown> }>
  }
  assert.deepEqual(step.styles[0].props.distance, { variable: 'scale/16' })
  assert.match(
    planProps({ animation: { style: 'Position', props: { distance: [1, 2] } } }).problems[0],
    /props.distance must be a string, a number, a boolean or \{ variable \}/
  )
})

test('null and [] both take the animation off, and a nameless style is refused', () => {
  assert.deepEqual((stepsOf({ animation: null })[0] as { styles: unknown[]; summary: string }).styles, [])
  assert.equal((stepsOf({ animation: [] })[0] as { summary: string }).summary, 'none')
  assert.match(planProps({ animation: { duration: 1 } }).problems[0], /style must name one of the styles MOTION_STYLES lists/)
  assert.match(planProps({ animation: { style: 'Position', speed: 2 } }).problems[0], /unknown key "speed"/)
  assert.match(planProps({ animation: { style: 'Position', duration: -1 } }).problems[0], /duration must be a number of seconds >= 0/)
})

/* --------------------------------------------------------------- figma draw */

test('a brush is named, and a wrong name is answered with the ten that exist', () => {
  assert.deepEqual(stepsOf({ brush: 'BASIC' }), [
    { step: 'brush', brush: { type: 'BASIC' }, loads: null, summary: 'basic' },
  ])
  const scattered = stepsOf({ brush: { scatter: 'DRONE', gap: 2 } })[0] as {
    brush: Record<string, unknown>
    loads: string
  }
  // Every field is required by Figma and none has a documented default, so the neutral end of
  // each range is filled in — a scatter with no settings is even, not random.
  assert.deepEqual(scattered.brush, {
    type: 'BRUSH',
    brushType: 'SCATTER',
    brushName: 'DRONE',
    gap: 2,
    wiggle: 0,
    sizeJitter: 0,
    angularJitter: 0,
    rotation: 0,
  })
  assert.equal(scattered.loads, 'SCATTER', 'the brush type has to be loaded before it can be set')
  assert.match(planProps({ brush: { scatter: 'TECHNO' } }).problems[0], /must be one of: BUBBLEGUM, WITCH_HOUSE/)
  assert.match(planProps({ brush: { stretch: 'TECHNO' } }).problems[0], /must be one of: HEIST, BLOCKBUSTER/)
})

test('a dynamic stroke is checked against the ranges the API documents', () => {
  const step = stepsOf({ brush: { dynamic: { frequency: 4, smoothen: 0.5 } } })[0] as { brush: Record<string, unknown> }
  assert.deepEqual(step.brush, { type: 'DYNAMIC', frequency: 4, wiggle: 0, smoothen: 0.5 })
  assert.match(planProps({ brush: { dynamic: { frequency: 40 } } }).problems[0], /between 0.01 and 20/)
  assert.match(planProps({ brush: { dynamic: { smoothen: 2 } } }).problems[0], /between 0 and 1/)
  assert.match(planProps({ brush: { scatter: 'DRONE', sizeJitter: 9 } }).problems[0], /between 0 and 3/)
  assert.match(planProps({ brush: { scatter: 'DRONE', gap: 0.1 } }).problems[0], /between 0.25 and/)
  assert.match(planProps({ brush: { dynamic: { speed: 1 } } }).problems[0], /unknown key "speed"/)
  assert.match(planProps({ brush: {} }).problems[0], /must name one of: dynamic, scatter, stretch/)
  assert.match(planProps({ brush: 'FANCY' }).problems[0], /must be "BASIC", \{ dynamic \}/)
})

test('a brush is drawn before the shadows and after the stroke it draws', () => {
  assert.deepEqual(
    planProps({ effects: [], brush: 'BASIC', stroke: '#000000' }).steps.map((step) => step.step),
    ['paint', 'brush', 'effects']
  )
})

test('text on a path names the vector it follows, and where along it', () => {
  const problems: string[] = []
  const plan = planCreate({ kind: 'textPath', of: '1:2', at: [2, 0.5] }, 'n', problems)
  assert.deepEqual(problems, [])
  assert.deepEqual(plan?.at, [2, 0.5])
  planCreate({ kind: 'textPath' }, 'n', problems)
  assert.match(problems[0], /of must name the VECTOR whose outline the text will follow/)
  const more: string[] = []
  planCreate({ kind: 'textPath', of: '1:2', at: [0, 4] }, 'n', more)
  assert.match(more[0], /at must be \[segment, position\]/)
})

test('commas in path data become spaces, because Figma refuses them', () => {
  // Every SVG in the world writes `C 30 0, 60 80, 90 40`; Figma answers "Failed to convert path.
  // Invalid command at ," — a refusal nobody would predict from an SVG they pasted.
  assert.deepEqual(stepsOf({ path: 'M 0 40 C 30 0, 60 80, 90 40' }), [
    { step: 'paths', paths: [{ data: 'M 0 40 C 30 0  60 80  90 40', windingRule: 'NONZERO' }] },
  ])
})

/* -------------------------------------------------------------------- shaders */

test('a shader is a paint and an effect, named by the id SHADER_LIST gives', () => {
  assert.equal(paintProblem({ shader: '78022e92', properties: { coverage: 0.4 } }), null)
  assert.deepEqual(planProps({ fill: { shader: 'abc' } }).steps[0], {
    step: 'paint',
    property: 'fills',
    ref: { shader: 'abc' },
  })
  const effect = stepsOf({ effects: [{ shader: 'abc', properties: { amount: 2 } }] })[0] as {
    effects: Array<Record<string, unknown>>
  }
  assert.deepEqual(effect.effects[0], { type: 'SHADER', id: 'abc', visible: true, properties: { amount: 2 } })
})

test('every way of naming a shader wrongly is refused', () => {
  assert.match(paintProblem({ shader: '' }) ?? '', /shader must be the id SHADER_LIST gives/)
  assert.match(paintProblem({ shader: 'abc', props: {} }) ?? '', /unknown key "props"/)
  assert.match(paintProblem({ shader: 'abc', properties: [] }) ?? '', /properties must be an object/)
  assert.match(paintProblem({ shader: 'abc', opacity: 3 }) ?? '', /opacity must be between 0 and 1/)
})

/* ------------------------------------------------------- auto-layout, in full */

test('the second gap, the stacking order and the grid tracks all reach the layout', () => {
  const step = stepsOf({
    layout: { mode: 'HORIZONTAL', gap: 8, wrap: true, wrapGap: 12, reverseZ: true, strokesInLayout: false },
  })[0] as { layout: Record<string, unknown> }
  assert.deepEqual(step.layout, {
    mode: 'HORIZONTAL',
    gap: 8,
    wrap: true,
    wrapGap: 12,
    reverseZ: true,
    strokesInLayout: false,
  })
  const grid = stepsOf({ layout: { mode: 'GRID', rows: 2, columns: 3, autoTracks: 'ROWS' } })[0] as {
    layout: Record<string, unknown>
  }
  assert.deepEqual(grid.layout, { mode: 'GRID', rows: 2, columns: 3, autoTracks: 'ROWS' })
})

test('a child may step out of the layout, and its x and y then mean something', () => {
  assert.deepEqual(stepsOf({ absolute: true }), [
    { step: 'assign', property: 'layoutPositioning', value: 'ABSOLUTE' },
  ])
  assert.deepEqual(stepsOf({ absolute: false })[0], { step: 'assign', property: 'layoutPositioning', value: 'AUTO' })
  // And it is planned before the geometry it makes meaningful.
  assert.deepEqual(
    planProps({ x: 10, absolute: true, layout: { mode: 'VERTICAL' } }).steps.map((s) =>
      s.step === 'assign' ? s.property : s.step
    ),
    ['layout', 'layoutPositioning', 'x', 'sizing']
  )
})

test('bounds are numbers or null, and null is how one comes off', () => {
  assert.deepEqual(stepsOf({ maxWidth: 320 }), [{ step: 'bound', property: 'maxWidth', value: 320 }])
  assert.deepEqual(stepsOf({ maxWidth: null }), [{ step: 'bound', property: 'maxWidth', value: null }])
  assert.match(planProps({ minHeight: -4 }).problems[0], /minHeight must be >= 0/)
})

test('a grid child says how many tracks it covers and how it sits in them', () => {
  assert.deepEqual(stepsOf({ gridSpan: { rows: 2, columns: 3 } }), [
    { step: 'assign', property: 'gridRowSpan', value: 2 },
    { step: 'assign', property: 'gridColumnSpan', value: 3 },
  ])
  assert.deepEqual(stepsOf({ gridAlign: 'CENTER' }), [
    { step: 'assign', property: 'gridChildVerticalAlign', value: 'CENTER' },
  ])
  assert.match(planProps({ gridSpan: {} }).problems[0], /must name rows, columns or both/)
  assert.match(planProps({ gridSpan: { rows: 0 } }).problems[0], /whole number of at least 1/)
  assert.match(planProps({ gridAlign: 'TOP' }).problems[0], /MIN, CENTER, MAX, AUTO/)
})

test('an unknown layout key lists the whole set, which is now thirteen words', () => {
  const problem = planProps({ layout: { spacing: 4 } }).problems[0]
  assert.match(problem, /unknown key "spacing"/)
  assert.match(problem, /mode, gap, wrapGap, padding/)
  assert.match(problem, /rows, columns, autoTracks/)
})
