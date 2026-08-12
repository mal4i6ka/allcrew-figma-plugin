import test from 'node:test'
import assert from 'node:assert/strict'
import { diffProperties, diffStates } from './diff-properties.ts'
import { MIXED } from './types.ts'
import type { DiffableNode } from './types.ts'

function node(overrides: Partial<DiffableNode> & { name: string }): DiffableNode {
  return { type: 'FRAME', x: 0, y: 0, width: 100, height: 100, ...overrides }
}

test('diffProperties reports position, size, rotation, opacity changes', () => {
  const a = node({ name: 'n', x: 0, y: 0, width: 100, height: 50, rotation: 0, opacity: 1 })
  const b = node({ name: 'n', x: 10, y: -5, width: 120, height: 50, rotation: 15, opacity: 0.5 })

  const changes = diffProperties(a, b)

  assert.deepEqual(
    changes.map((c) => c.prop).sort(),
    ['opacity', 'rotation', 'width', 'x', 'y']
  )
})

test('diffProperties ignores changes within the epsilon tolerance', () => {
  const a = node({ name: 'n', x: 10 })
  const b = node({ name: 'n', x: 10.001 })

  assert.deepEqual(diffProperties(a, b), [])
})

test('diffProperties collapses a single solid fill change to fillColor with opacity folded into alpha', () => {
  const a = node({ name: 'n', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1 }] })
  const b = node({ name: 'n', fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 }, opacity: 0.5 }] })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [
    { prop: 'fillColor', from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 1, b: 0, a: 0.5 } },
  ])
})

test('diffProperties skips fills when either side is figma.mixed', () => {
  const a = node({ name: 'n', fills: MIXED })
  const b = node({ name: 'n', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] })

  assert.deepEqual(diffProperties(a, b), [])
})

test('diffProperties reports a uniform cornerRadius change as one scalar', () => {
  const a = node({ name: 'n', cornerRadius: 4 })
  const b = node({ name: 'n', cornerRadius: 12 })

  assert.deepEqual(diffProperties(a, b), [{ prop: 'cornerRadius', from: 4, to: 12 }])
})

test('diffProperties reports a per-corner radius change as cornerRadii when either side is mixed', () => {
  const a = node({ name: 'n', cornerRadius: MIXED, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 8, bottomLeftRadius: 8 })
  const b = node({ name: 'n', cornerRadius: 16 })

  assert.deepEqual(diffProperties(a, b), [{ prop: 'cornerRadii', from: [0, 0, 8, 8], to: [16, 16, 16, 16] }])
})

test('diffStates combines matchLayers + diffProperties, and drops matched pairs with no changes', () => {
  const base = node({
    name: 'root',
    children: [node({ name: 'Label', x: 0 }), node({ name: 'Icon', x: 0 }), node({ name: 'Badge' })],
  })
  const target = node({
    name: 'root',
    children: [node({ name: 'Label', x: 20 }), node({ name: 'Icon', x: 0 }), node({ name: 'Spinner' })],
  })

  const diff = diffStates(base, target)

  assert.deepEqual(diff.pairs.map((p) => p.path), ['Label#0'])
  assert.deepEqual(diff.fadeOut, ['Badge#0'])
  assert.deepEqual(diff.fadeIn, ['Spinner#0'])
})
