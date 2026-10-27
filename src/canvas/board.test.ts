import test from 'node:test'
import assert from 'node:assert/strict'
import {
  connectorWords,
  editorFeatures,
  editorProblem,
  fileUrlPath,
  gridPlace,
  planConnector,
  planTable,
  planTransition,
  tableWords,
  transitionWords,
} from './board.ts'
import { kindProblem, planCreate } from './create.ts'
import { gridSpecsOf, planProps } from './props.ts'
import { specFrom } from './roundtrip.ts'

test('a feature used in the wrong editor is refused by naming the right one', () => {
  assert.equal(editorProblem('stickies', 'figjam'), null)
  assert.equal(editorProblem('stickies', 'figma', 'sticky'), 'sticky needs FigJam — this file is open in Figma Design')
  assert.equal(editorProblem('canvasGrid', 'buzz'), null)
  assert.match(editorProblem('canvasGrid', 'figjam')!, /Figma Slides or Figma Buzz/)
  // A runtime that does not say is not refused — it is a test double or an older host.
  assert.equal(editorProblem('stickies', undefined), null)
  assert.equal(editorFeatures('slides').slides, true)
  assert.equal(editorFeatures('slides').stickies, false)
})

test('a kind is made only in the editor that has its constructor', () => {
  assert.equal(kindProblem('frame', 'figjam'), null)
  assert.equal(kindProblem('sticky', 'figjam'), null)
  assert.match(kindProblem('sticky', 'slides')!, /needs FigJam/)
  assert.match(kindProblem('component', 'buzz')!, /needs Figma Design/)
  assert.match(kindProblem('slide', 'figma')!, /needs Figma Slides/)
  assert.equal(kindProblem('asset', 'buzz'), null)
})

test('links point at the kind of file it is', () => {
  assert.equal(fileUrlPath('figma'), 'design')
  assert.equal(fileUrlPath('dev'), 'design')
  assert.equal(fileUrlPath('figjam'), 'board')
  assert.equal(fileUrlPath('slides'), 'slides')
  assert.equal(fileUrlPath('buzz'), 'buzz')
})

test('a connector end is a node, a node and a side, a node and a point, or a canvas point', () => {
  const planned = planConnector({ start: '1:2', end: { node: '1:3', magnet: 'top' }, line: 'curved', endCap: 'arrow_lines' })
  assert.deepEqual(planned, {
    values: {
      connectorStart: { endpointNodeId: '1:2', magnet: 'AUTO' },
      connectorEnd: { endpointNodeId: '1:3', magnet: 'TOP' },
      connectorLineType: 'CURVED',
      connectorEndStrokeCap: 'ARROW_LINES',
    },
  })
  assert.deepEqual(planConnector({ start: [10, 20], end: { node: '1:3', at: [0.5, 1] } }), {
    values: {
      connectorStart: { position: { x: 10, y: 20 } },
      connectorEnd: { endpointNodeId: '1:3', position: { x: 0.5, y: 1 } },
    },
  })
  assert.ok('problem' in planConnector({ start: { node: '1:2', magnet: 'TOP', at: [0, 0] } }))
  assert.ok('problem' in planConnector({ start: { node: '1:2', magnet: 'SIDEWAYS' } }))
  assert.ok('problem' in planConnector({ from: '1:2' }))
  assert.ok('problem' in planConnector({}))
})

test('a connector reads back in the words it is written with', () => {
  const values = (planConnector({ start: '1:2', end: { node: '1:3', magnet: 'TOP' }, line: 'STRAIGHT', startCap: 'CIRCLE_FILLED' }) as {
    values: Record<string, unknown>
  }).values
  assert.deepEqual(connectorWords(values), { start: '1:2', end: { node: '1:3', magnet: 'TOP' }, line: 'STRAIGHT', startCap: 'CIRCLE_FILLED' })
  // The defaults say nothing.
  assert.deepEqual(
    connectorWords({ connectorStart: { position: { x: 1, y: 2 } }, connectorEnd: { position: { x: 3, y: 4 } }, connectorLineType: 'ELBOWED', connectorEndStrokeCap: 'NONE' }),
    { start: [1, 2], end: [3, 4] }
  )
})

test('a table plan is checked for shape before anything is touched', () => {
  assert.deepEqual(planTable({ rows: 2, columns: 3, cells: [['a', null, 'c']] }), {
    value: { rows: 2, columns: 3, cells: [['a', null, 'c']] },
  })
  assert.ok('problem' in planTable({ rows: 1, cells: [['a'], ['b']] }))
  assert.ok('problem' in planTable({ columns: 1, cells: [['a', 'b']] }))
  assert.ok('problem' in planTable({ rows: 0 }))
  assert.ok('problem' in planTable({ cells: [[1]] }))
  assert.ok('problem' in planTable({ columnWidths: [0] }))
  assert.ok('problem' in planTable({ colour: 'red' }))
})

test('a table reads as its cells and its track sizes', () => {
  const sizes = [[100, 40], [120, 40]]
  const table = {
    numRows: 2,
    numColumns: 2,
    cellAt: (row: number, column: number) => ({ text: { characters: `${row}${column}` }, width: sizes[column][0], height: row === 0 ? 40 : 60 }),
  }
  assert.deepEqual(tableWords(table), {
    rows: 2,
    columns: 2,
    cells: [['00', '01'], ['10', '11']],
    columnWidths: [100, 120],
    rowHeights: [40, 60],
  })
})

test('a slide transition is a word, or the word with what differs from the default', () => {
  const plain = planTransition('dissolve')
  assert.deepEqual(plain, { value: { style: 'DISSOLVE', duration: 0.3, curve: 'EASE_OUT', timing: { type: 'ON_CLICK' } } })
  assert.equal(transitionWords((plain as { value: never }).value), 'DISSOLVE')
  const timed = planTransition({ style: 'SMART_ANIMATE', duration: 0.6, after: 2 })
  assert.deepEqual(transitionWords((timed as { value: never }).value), { style: 'SMART_ANIMATE', duration: 0.6, after: 2 })
  assert.equal(transitionWords({ style: 'NONE', duration: 0, curve: 'LINEAR', timing: { type: 'ON_CLICK' } }), null)
  assert.ok('problem' in planTransition('SPIN'))
  assert.ok('problem' in planTransition({ style: 'DISSOLVE', curve: 'WOBBLY' }))
  assert.ok('problem' in planTransition({ style: 'DISSOLVE', after: -1 }))
})

test('the board properties are part of the one vocabulary', () => {
  const plan = planProps({
    shapeType: 'diamond',
    wide: true,
    code: 'const a = 1',
    codeLanguage: 'typescript',
    connector: { start: '1:2', end: '1:3' },
    skipped: true,
    transition: 'DISSOLVE',
    assetType: 'insta_story',
    stuckTo: '5:6',
  })
  assert.deepEqual(plan.problems, [])
  const steps = plan.steps.map((step) => (step.step === 'assign' ? `${step.property}=${step.value}` : step.step))
  assert.deepEqual(steps, [
    'shapeType=DIAMOND',
    'isWideWidth=true',
    'codeLanguage=TYPESCRIPT',
    'code=const a = 1',
    'connector',
    'isSkippedSlide=true',
    'transition',
    'stuckTo',
    'assetType',
  ])
  assert.match(planProps({ shapeType: 'BLOB' }).problems[0], /shapeType must be one of/)
  assert.match(planProps({ assetType: 'MYSPACE' }).problems[0], /assetType must be one of/)
  assert.match(planProps({ isWideWidth: true }).problems[0], /here it is "wide"/)
})

test('slides and assets take a grid place; a slide row takes only a row', () => {
  assert.deepEqual(gridPlace([1, 2]), { row: 1, column: 2 })
  assert.deepEqual(gridPlace(3), { row: 3 })
  assert.equal(gridPlace([1, -1]), null)
  const problems: string[] = []
  assert.ok(planCreate({ kind: 'slide', at: [0, 2] }, 'nodes[0]', problems))
  planCreate({ kind: 'slideRow', at: [0, 2] }, 'nodes[1]', problems)
  planCreate({ kind: 'frame', at: [0, 2] }, 'nodes[2]', problems)
  planCreate({ kind: 'linkPreview' }, 'nodes[3]', problems)
  assert.equal(problems.length, 3)
  assert.match(problems[0], /nodes\[1\]\.at must be \[row\]/)
  assert.match(problems[1], /at is for textPath, slide, slideRow and asset/)
  assert.match(problems[2], /of must be the URL/)
})

test('a sticky round-trips without its size, which is not its to be told', () => {
  const made = specFrom(
    { type: 'STICKY', name: 'Idea', props: { x: 0, y: 0, width: 240, height: 240, text: 'Ship it', wide: true, fill: '#FFD966' } },
    []
  )
  assert.deepEqual(made?.dropped, [])
  assert.deepEqual(made?.spec, { kind: 'sticky', props: { text: 'Ship it', wide: true, fill: '#FFD966', name: 'Idea' } })
})

test('a connector label colour travels both ways, and no background says nothing', () => {
  const planned = planConnector({ label: '#000000 @0.5' }) as { values: { labelFills: Array<Record<string, unknown>> } }
  assert.deepEqual(planned.values.labelFills, [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }])
  assert.deepEqual((planConnector({ label: 'none' }) as { values: unknown }).values, { labelFills: [] })
  assert.ok('problem' in planConnector({ label: 'mauve-ish' }))
  assert.deepEqual(connectorWords({ textBackground: { fills: planned.values.labelFills } }), { label: '#000000 @0.5' })
  assert.deepEqual(connectorWords({ textBackground: { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] } }), { label: '#FFFFFF' })
  assert.deepEqual(connectorWords({ textBackground: { fills: [] } }), {})
})

test('table rows and columns move by index pairs', () => {
  assert.deepEqual(planTable({ moveRows: [[2, 0]], moveColumns: [[0, 1]] }), { value: { moveRows: [[2, 0]], moveColumns: [[0, 1]] } })
  assert.ok('problem' in planTable({ moveRows: [2, 0] }))
  assert.ok('problem' in planTable({ moveColumns: [[0, -1]] }))
})

test('a free connector end reads as a point, though Figma names the page as its node', () => {
  assert.deepEqual(
    connectorWords({ connectorStart: { endpointNodeId: '0:1', position: { x: 0, y: 0 } }, connectorEnd: { endpointNodeId: '1:2', magnet: 'AUTO' } }, '0:1'),
    { start: [0, 0], end: '1:2' }
  )
})

test('a connector label is set after the words, which would otherwise wipe it', () => {
  const plan = planProps({ connector: { start: '1:2', label: '#FFF3C4' }, text: 'yes' })
  assert.deepEqual(plan.problems, [])
  const order = plan.steps.map((step) => (step.step === 'connector' ? `connector:${Object.keys(step.values).join('+')}` : step.step))
  assert.deepEqual(order, ['connector:connectorStart', 'text', 'connector:labelFills'])
})

test('layout grids read in the shape the write takes, and plan back to the same grids', () => {
  const figmaGrids = [
    { pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 168, count: 1, offset: 168, sectionSize: 1, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } },
    { pattern: 'ROWS', alignment: 'MIN', gutterSize: 0, count: 4, sectionSize: 120, visible: false, color: { r: 0, g: 0, b: 1, a: 0.25 } },
    { pattern: 'GRID', sectionSize: 8, visible: true, color: { r: 1, g: 1, b: 1, a: 0.1 } },
  ]
  const read = gridSpecsOf(figmaGrids)
  assert.deepEqual(read, [
    { columns: 1, gutter: 168, margin: 168, color: '#FF0000' },
    { rows: 4, height: 120, color: '#0000FF', opacity: 0.25, visible: false },
    { square: 8, color: '#FFFFFF' },
  ])
  const plan = planProps({ grid: read })
  assert.deepEqual(plan.problems, [])
  const step = plan.steps[0] as { grids: Array<Record<string, unknown>> }
  assert.equal(step.grids[0].alignment, 'STRETCH')
  assert.equal(step.grids[0].offset, 168)
  assert.equal(step.grids[1].alignment, 'MIN')
  assert.equal(step.grids[1].sectionSize, 120)
})

test('a framed Buzz asset round-trips as an asset, the only thing that can carry a format', () => {
  const made = specFrom({ type: 'FRAME', name: 'Post', props: { assetType: 'INSTA_STORY', fill: '#0A1F44' } }, [])
  assert.equal(made?.spec.kind, 'asset')
  assert.equal(specFrom({ type: 'FRAME', name: 'Card', props: {} }, [])?.spec.kind, 'frame')
})
