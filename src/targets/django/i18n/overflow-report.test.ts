import test from 'node:test'
import assert from 'node:assert/strict'
import { detectOverflows } from './overflow-report.ts'

function makeFrame(overrides: any): any {
  return {
    layoutMode: 'HORIZONTAL',
    primaryAxisSizingMode: 'FIXED',
    counterAxisSizingMode: 'AUTO',
    width: 160,
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
