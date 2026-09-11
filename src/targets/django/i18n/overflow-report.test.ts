import test from 'node:test'
import assert from 'node:assert/strict'
import { detectOverflows } from './overflow-report.ts'

function makeFrame(overrides: any): any {
  return {
    layoutMode: 'HORIZONTAL',
    primaryAxisSizingMode: 'FIXED',
    counterAxisSizingMode: 'AUTO',
    width: 160,
    height: 40,
    absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 40 },
    parent: null,
    ...overrides,
  }
}

function makeTextNode(overrides: any): any {
  return {
    id: 'text:1',
    name: 'CTA label',
    absoluteBoundingBox: { x: 8, y: 8, width: 100, height: 20 },
    parent: null,
    ...overrides,
  }
}

test('detectOverflows flags a node that extends past its FIXED-width auto-layout parent', () => {
  const frame = makeFrame({ width: 160, absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 40 } })
  const node = makeTextNode({ absoluteBoundingBox: { x: 8, y: 8, width: 200, height: 20 }, parent: frame })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].nodeId, 'text:1')
  assert.equal(reports[0].nodeName, 'CTA label')
  assert.equal(reports[0].expected, 160)
  assert.equal(reports[0].actual, 208)
})

test('detectOverflows does not flag a node that still fits inside its container', () => {
  const frame = makeFrame({})
  const node = makeTextNode({ absoluteBoundingBox: { x: 8, y: 8, width: 100, height: 20 }, parent: frame })

  assert.deepEqual(detectOverflows([node]), [])
})

test('detectOverflows ignores an AUTO-sizing (hug) container even if the child grows', () => {
  const frame = makeFrame({ primaryAxisSizingMode: 'AUTO' })
  const node = makeTextNode({ absoluteBoundingBox: { x: 8, y: 8, width: 400, height: 20 }, parent: frame })

  assert.deepEqual(detectOverflows([node]), [])
})

test('detectOverflows skips nodes with no auto-layout ancestor', () => {
  const plainGroup = { layoutMode: 'NONE', parent: null }
  const node = makeTextNode({ absoluteBoundingBox: { x: 0, y: 0, width: 999, height: 20 }, parent: plainGroup })

  assert.deepEqual(detectOverflows([node]), [])
})

test('detectOverflows walks past a non-auto-layout group to find the nearest FIXED ancestor', () => {
  const frame = makeFrame({ width: 100, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } })
  const plainGroup = { parent: frame }
  const node = makeTextNode({ absoluteBoundingBox: { x: 0, y: 0, width: 150, height: 20 }, parent: plainGroup })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].expected, 100)
})

test('detectOverflows checks the counter axis width for a VERTICAL (column) container', () => {
  const column = makeFrame({
    layoutMode: 'VERTICAL',
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'FIXED',
    width: 120,
    absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 300 },
  })
  const node = makeTextNode({ absoluteBoundingBox: { x: 0, y: 0, width: 180, height: 20 }, parent: column })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].expected, 120)
  assert.equal(reports[0].actual, 180)
})

test('detectOverflows flags vertical overrun on a VERTICAL auto-layout parent with a FIXED primary axis', () => {
  const column = makeFrame({
    layoutMode: 'VERTICAL',
    primaryAxisSizingMode: 'FIXED',
    counterAxisSizingMode: 'AUTO',
    height: 100,
    absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 100 },
  })
  const node = makeTextNode({ absoluteBoundingBox: { x: 8, y: 8, width: 100, height: 150 }, parent: column })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].axis, 'vertical')
  assert.equal(reports[0].expected, 100)
  assert.equal(reports[0].actual, 158)
})

test('detectOverflows flags vertical overrun on a HORIZONTAL row whose height is FIXED (counter axis)', () => {
  const row = makeFrame({
    layoutMode: 'HORIZONTAL',
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'FIXED',
    height: 40,
    absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 40 },
  })
  const node = makeTextNode({ absoluteBoundingBox: { x: 8, y: 8, width: 100, height: 60 }, parent: row })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].axis, 'vertical')
  assert.equal(reports[0].expected, 40)
  assert.equal(reports[0].actual, 68)
})

test('detectOverflows treats a plain clipsContent frame as fixed on both axes, even without auto-layout', () => {
  const clipper = {
    layoutMode: 'NONE',
    clipsContent: true,
    width: 100,
    height: 50,
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    parent: null,
  }
  const node = makeTextNode({ absoluteBoundingBox: { x: 0, y: 0, width: 140, height: 70 }, parent: clipper })

  const reports = detectOverflows([node])

  assert.equal(reports.length, 2)
  assert.deepEqual(
    reports.map((r) => r.axis).sort(),
    ['horizontal', 'vertical']
  )
})

test('detectOverflows ignores a plain frame with clipsContent off even if the child overruns its box', () => {
  const frame = {
    layoutMode: 'NONE',
    clipsContent: false,
    width: 100,
    height: 50,
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    parent: null,
  }
  const node = makeTextNode({ absoluteBoundingBox: { x: 0, y: 0, width: 140, height: 70 }, parent: frame })

  assert.deepEqual(detectOverflows([node]), [])
})

test('detectOverflows estimates an overrun for a fixed-size (textAutoResize: NONE) text box from font metrics, with no ancestor involved', () => {
  const node: any = {
    id: 'text:9',
    name: 'Body copy',
    parent: null,
    textAutoResize: 'NONE',
    fontSize: 16,
    lineHeight: { unit: 'PIXELS', value: 20 },
    absoluteBoundingBox: { x: 0, y: 0, width: 96, height: 40 },
    characters: 'This translated sentence is far too long for the fixed box and will not fit on two lines',
  }

  const reports = detectOverflows([node])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].nodeId, 'text:9')
  assert.equal(reports[0].axis, 'vertical')
  assert.equal(reports[0].expected, 40)
  assert.ok(reports[0].actual > 40)
})

test('detectOverflows does not flag a textAutoResize: NONE node whose translated text still fits the estimated capacity', () => {
  const node: any = {
    id: 'text:10',
    name: 'Short label',
    parent: null,
    textAutoResize: 'NONE',
    fontSize: 16,
    lineHeight: { unit: 'PIXELS', value: 20 },
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 60 },
    characters: 'Short and fits',
  }

  assert.deepEqual(detectOverflows([node]), [])
})

test('detectOverflows stays conservative for a textAutoResize: NONE node with a mixed (non-numeric) font size', () => {
  const node: any = {
    id: 'text:11',
    name: 'Mixed styles',
    parent: null,
    textAutoResize: 'NONE',
    fontSize: Symbol('figma.mixed'),
    lineHeight: { unit: 'PIXELS', value: 20 },
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
    characters: 'x'.repeat(500),
  }

  assert.deepEqual(detectOverflows([node]), [])
})
