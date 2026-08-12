import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLayers } from './match-layers.ts'
import type { DiffableNode } from './types.ts'

function node(overrides: Partial<DiffableNode> & { name: string }): DiffableNode {
  return { type: 'FRAME', x: 0, y: 0, width: 0, height: 0, ...overrides }
}

test('matchLayers matches same-named children at the same path', () => {
  const base = node({ name: 'root', children: [node({ name: 'Icon', type: 'VECTOR' })] })
  const target = node({ name: 'root', children: [node({ name: 'Icon', type: 'VECTOR', x: 10 })] })

  const result = matchLayers(base, target)

  assert.equal(result.matched.length, 1)
  assert.equal(result.matched[0].path, 'Icon#0')
  assert.equal(result.removed.length, 0)
  assert.equal(result.added.length, 0)
})

test('matchLayers keys by nesting path — a same-named child in a different group does not match', () => {
  const base = node({ name: 'root', children: [node({ name: 'Group A', children: [node({ name: 'Icon' })] })] })
  const target = node({ name: 'root', children: [node({ name: 'Group B', children: [node({ name: 'Icon' })] })] })

  const result = matchLayers(base, target)

  assert.equal(result.matched.length, 0)
  assert.deepEqual(
    result.removed.map((r) => r.path).sort(),
    ['Group A#0', 'Group A#0/Icon#0']
  )
  assert.deepEqual(
    result.added.map((a) => a.path).sort(),
    ['Group B#0', 'Group B#0/Icon#0']
  )
})

test('matchLayers matches duplicate-named siblings by order (i-th to i-th)', () => {
  const base = node({ name: 'root', children: [node({ name: 'Rect', x: 0 }), node({ name: 'Rect', x: 100 })] })
  const target = node({ name: 'root', children: [node({ name: 'Rect', x: 5 }), node({ name: 'Rect', x: 105 })] })

  const result = matchLayers(base, target)

  assert.equal(result.matched.length, 2)
  assert.equal(result.matched[0].path, 'Rect#0')
  assert.equal(result.matched[0].a.x, 0)
  assert.equal(result.matched[0].b.x, 5)
  assert.equal(result.matched[1].path, 'Rect#1')
  assert.equal(result.matched[1].a.x, 100)
  assert.equal(result.matched[1].b.x, 105)
})

test('matchLayers treats a node missing from target as removed (fade-out) and vice versa (fade-in)', () => {
  const base = node({ name: 'root', children: [node({ name: 'Badge' })] })
  const target = node({ name: 'root', children: [node({ name: 'Spinner' })] })

  const result = matchLayers(base, target)

  assert.equal(result.matched.length, 0)
  assert.deepEqual(result.removed.map((r) => r.path), ['Badge#0'])
  assert.deepEqual(result.added.map((a) => a.path), ['Spinner#0'])
})

test('matchLayers treats a type mismatch at the same path as dissolve, not a match', () => {
  const base = node({ name: 'root', children: [node({ name: 'Icon', type: 'VECTOR' })] })
  const target = node({ name: 'root', children: [node({ name: 'Icon', type: 'ELLIPSE' })] })

  const result = matchLayers(base, target)

  assert.equal(result.matched.length, 0)
  assert.deepEqual(result.removed.map((r) => r.path), ['Icon#0'])
  assert.deepEqual(result.added.map((a) => a.path), ['Icon#0'])
})
