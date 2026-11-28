import test from 'node:test'
import assert from 'node:assert/strict'
import { planArc, planExports, planProps, readArc, readExports, readNetwork } from './props.ts'

const stepsOf = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return plan.steps
}

/* ------------------------------------------------------------------ shapes */

test('an arc is written in degrees and stored in radians, and a plain ellipse reads as nothing', () => {
  const arc = planArc({ start: 0, end: 270, inner: 0.5 })
  assert.ok(typeof arc !== 'string')
  assert.equal(arc.startingAngle, 0)
  assert.ok(Math.abs(arc.endingAngle - (3 * Math.PI) / 2) < 1e-9)
  assert.equal(arc.innerRadius, 0.5)
  assert.deepEqual(readArc(arc), { end: 270, inner: 0.5 })
  assert.equal(readArc({ startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 }), null)
  assert.match(String(planArc({ sweep: 90 })), /unknown key "sweep"/)
  assert.match(String(planArc({ inner: 2 })), /inner must be between 0 and 1/)
})

test('stars and polygons take their points, a boolean its operation, a mask its kind — in loose spelling', () => {
  assert.deepEqual(stepsOf({ pointCount: 6, innerRadius: 0.4, booleanOperation: 'subtract', maskType: 'luminance', isMask: true }), [
    { step: 'assign', property: 'isMask', value: true },
    { step: 'assign', property: 'maskType', value: 'LUMINANCE' },
    { step: 'assign', property: 'pointCount', value: 6 },
    { step: 'assign', property: 'innerRadius', value: 0.4 },
    { step: 'assign', property: 'booleanOperation', value: 'SUBTRACT' },
  ])
  assert.match(planProps({ pointCount: 2 }).problems[0], /pointCount must be a whole number of at least 3/)
  assert.match(planProps({ cornerSmoothing: 1.5 }).problems[0], /cornerSmoothing must be <= 1/)
})

test('a flip and a matrix wait until the node stands where it will stand', () => {
  const steps = stepsOf({ flip: 'horizontal', transform: [[1, 0, 10], [0, 1, 20]] })
  assert.deepEqual(steps, [
    { step: 'assign', property: 'relativeTransform', value: [[1, 0, 10], [0, 1, 20]] },
    { step: 'flip', axis: 'HORIZONTAL' },
  ])
  assert.match(planProps({ transform: [[1, 0], [0, 1]] }).problems[0], /six numbers in two rows/)
})

test('Figma’s own names are pointed at ours rather than refused with the whole list', () => {
  assert.match(planProps({ arcData: {} }).problems[0], /here it is "arc"/)
  assert.match(planProps({ exportSettings: [] }).problems[0], /here it is "exports"/)
  assert.match(planProps({ explicitVariableModes: {} }).problems[0], /here it is "modes"/)
  assert.match(planProps({ layoutGrow: 1 }).problems[0], /here it is "sizing"/)
  assert.match(planProps({ gridRowAnchorIndex: 1 }).problems[0], /here it is "gridCell"/)
})

/* ----------------------------------------------------------------- exports */

test('export presets: a bare format, a density, a target width — refused key by key', () => {
  assert.deepEqual(planExports(['SVG', { format: 'png', scale: 2, suffix: '@2x' }, { format: 'JPEG', width: 320 }]), [
    { format: 'SVG' },
    { format: 'PNG', constraint: { type: 'SCALE', value: 2 }, suffix: '@2x' },
    { format: 'JPG', constraint: { type: 'WIDTH', value: 320 } },
  ])
  assert.match(String(planExports([{ format: 'SVG', scale: 2 }])), /a SVG is vector — it takes no scale/)
  assert.match(String(planExports([{ format: 'PNG', scale: 2, width: 10 }])), /one of scale, width or height/)
  assert.match(String(planExports([{ format: 'PNG', svgIdAttribute: true }])), /is an SVG setting/)
  assert.match(String(planExports([{ format: 'GIF' }])), /format must be one of/)
})

test('export presets read back the way they are written, defaults left unsaid', () => {
  assert.deepEqual(
    readExports([
      { format: 'PNG', constraint: { type: 'SCALE', value: 1 }, suffix: '', contentsOnly: true },
      { format: 'PNG', constraint: { type: 'SCALE', value: 2 }, suffix: '@2x', contentsOnly: true },
      { format: 'SVG', svgOutlineText: true, svgIdAttribute: true, svgSimplifyStroke: true, contentsOnly: true, suffix: '' },
    ] as unknown as ExportSettings[]),
    ['PNG', { format: 'PNG', scale: 2, suffix: '@2x' }, { format: 'SVG', svgIdAttribute: true }]
  )
})

/* ------------------------------------------------------------------- wraps */

test('a wrap takes its line alignment, and nothing else', () => {
  const [step] = stepsOf({ layout: { mode: 'HORIZONTAL', wrap: true, alignContent: 'SPACE_BETWEEN' } })
  assert.deepEqual(step, { step: 'layout', layout: { mode: 'HORIZONTAL', wrap: true, alignContent: 'SPACE_BETWEEN' } })
  assert.match(planProps({ layout: { alignContent: 'CENTER' } }).problems[0], /alignContent must be AUTO or SPACE_BETWEEN/)
})

/* ---------------------------------------------------- handoff and plumbing */

test('Dev Mode status, modes, guides and documentation, as a designer would say them', () => {
  assert.deepEqual(
    stepsOf({
      devStatus: 'ready_for_dev',
      modes: { Business: 'Dark', One: null },
      guides: [{ axis: 'X', offset: 24 }],
      description: 'Primary **action**',
      documentation: ['https://example.com/button'],
    }),
    [
      { step: 'modes', modes: { Business: 'Dark', One: null } },
      { step: 'assign', property: 'devStatus', value: { type: 'READY_FOR_DEV' } },
      { step: 'assign', property: 'guides', value: [{ axis: 'X', offset: 24 }] },
      { step: 'assign', property: 'descriptionMarkdown', value: 'Primary **action**' },
      { step: 'assign', property: 'documentationLinks', value: [{ uri: 'https://example.com/button' }] },
    ]
  )
  assert.deepEqual(stepsOf({ devStatus: null }), [{ step: 'assign', property: 'devStatus', value: null }])
  assert.match(planProps({ devStatus: 'DONE' }).problems[0], /devStatus must be READY_FOR_DEV or COMPLETED/)
  assert.match(planProps({ modes: { Business: 3 } }).problems[0], /modes\.Business must be a mode name or id, or null/)
})

test('shared plugin data keeps to Figma’s namespace rule, and relaunch data is plain text', () => {
  assert.deepEqual(stepsOf({ sharedData: { tokens_studio: { ref: 'x', old: null } } }), [
    { step: 'sharedData', data: { tokens_studio: { ref: 'x', old: null } } },
  ])
  assert.match(planProps({ sharedData: { ab: { k: 'v' } } }).problems[0], /namespace: 3\+ letters/)
  // Figma refuses a hyphen (found live), however plugin ids are usually spelled.
  assert.match(planProps({ sharedData: { 'tokens-studio': { k: 'v' } } }).problems[0], /namespace: 3\+ letters, numbers, _ or \./)
  assert.deepEqual(stepsOf({ relaunch: { reexport: 'Re-export' } }), [{ step: 'relaunch', data: { reexport: 'Re-export' } }])
})

test('scale and the aspect lock come after the size they act on', () => {
  assert.deepEqual(stepsOf({ aspectLock: true, scale: 2, width: 100 }).map((step) => step.step), ['resize', 'rescale', 'aspect'])
})

/* ------------------------------------------------------------ replaced words */

test('words are replaced after the text is set and before the runs that may style them', () => {
  const steps = stepsOf({ runs: [{ match: 'Log in', fontSize: 20 }], replace: [{ match: 'Sign in', with: 'Log in' }], text: 'Sign in' })
  assert.deepEqual(steps.map((step) => step.step), ['text', 'replace', 'runs'])
  assert.deepEqual(stepsOf({ replace: { from: 0, to: 4, with: '' } }), [{ step: 'replace', edits: [{ from: 0, to: 4, with: '' }] }])
  assert.match(planProps({ replace: [{ match: 'a', from: 0, to: 1, with: 'b' }] }).problems[0], /either a match or a from\/to range/)
  assert.match(planProps({ replace: [{ match: 'a' }] }).problems[0], /must be \{ match, with \}/)
  assert.deepEqual(stepsOf({ scaleFactor: 1.5 }), [{ step: 'assign', property: 'scaleFactor', value: 1.5 }])
})

/* --------------------------------------------------------------- grid tokens */

test('a grid’s numbers may name variables, bound on the grid once the list is built', () => {
  const [step] = stepsOf({
    grid: [
      { columns: { variable: 'grid/columns' }, gutter: { variable: 'spacing/m' }, margin: 24 },
      { square: { variable: 'grid/baseline' } },
    ],
  })
  assert.equal(step.step, 'grid')
  const grid = step as Extract<typeof step, { step: 'grid' }>
  assert.deepEqual(grid.bind, [
    { index: 0, field: 'count', variable: 'grid/columns' },
    { index: 0, field: 'gutterSize', variable: 'spacing/m' },
    { index: 1, field: 'sectionSize', variable: 'grid/baseline' },
  ])
  assert.equal((grid.grids[0] as RowsColsLayoutGrid).offset, 24)
  assert.match(grid.summary, /grid\/columns column\(s\) stretch gutter spacing\/m margin 24/)
})

test('a token margin keeps its offset even when the stand-in is zero', () => {
  const [step] = stepsOf({ grid: [{ columns: 12, margin: { variable: 'grid/margin' } }] })
  const grid = step as Extract<typeof step, { step: 'grid' }>
  assert.equal((grid.grids[0] as RowsColsLayoutGrid).offset, 0)
  assert.deepEqual(grid.bind, [{ index: 0, field: 'offset', variable: 'grid/margin' }])
})

/* ------------------------------------------------------------------ vectors */

test('a vector network reads in the short forms the write takes, and plans back unchanged', () => {
  const network = {
    vertices: [
      { x: 0, y: 0 },
      { x: 80, y: 0, strokeCap: 'ROUND', handleMirroring: 'ANGLE' },
      { x: 40, y: 70 },
    ],
    segments: [
      { start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
      { start: 1, end: 2, tangentStart: { x: 10, y: 0 }, tangentEnd: { x: 0, y: -10 } },
      { start: 2, end: 0 },
    ],
    regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2]] }],
  } as unknown as VectorNetwork
  const read = readNetwork(network)
  assert.deepEqual(read, {
    vertices: [[0, 0], { x: 80, y: 0, cap: 'ROUND', mirror: 'ANGLE' }, [40, 70]],
    segments: [[0, 1], { start: 1, end: 2, curve: [10, 0, 0, -10] }, [2, 0]],
    regions: [{ loops: [[0, 1, 2]] }],
  })
  const [step] = stepsOf({ network: read })
  assert.equal(step.step, 'network')
  const planned = (step as { network: VectorNetwork }).network
  assert.equal(planned.vertices[1].handleMirroring, 'ANGLE')
  assert.deepEqual(planned.segments[1].tangentStart, { x: 10, y: 0 })
})
