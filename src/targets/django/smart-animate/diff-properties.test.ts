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

test('diffStates diffs the two roots themselves, under the empty path', () => {
  // matchLayers indexes descendants only: a state that changes the trigger's own padding and
  // stroke — a button growing on hover — used to come back as an empty diff and emit no CSS.
  const pad = (value: number) => ({ paddingTop: 8, paddingRight: value, paddingBottom: 8, paddingLeft: value })
  const base = node({ name: 'root', ...pad(12), strokeWeight: 1, children: [node({ name: 'Label' })] })
  const target = node({ name: 'root', ...pad(20), strokeWeight: 2, children: [node({ name: 'Label' })] })

  const diff = diffStates(base, target)

  assert.deepEqual(diff.pairs.map((p) => p.path), [''])
  assert.deepEqual(
    diff.pairs[0].changes.map((c) => c.prop).sort(),
    ['padding', 'strokeWeight']
  )
})

test('diffProperties reports a stroke color + weight change as strokeColor/strokeWeight', () => {
  const a = node({ name: 'n', strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }], strokeWeight: 1 })
  const b = node({ name: 'n', strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }], strokeWeight: 3 })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [
    { prop: 'strokeColor', from: { r: 0, g: 0, b: 0, a: 1 }, to: { r: 1, g: 1, b: 1, a: 1 } },
    { prop: 'strokeWeight', from: 1, to: 3 },
  ])
})

test('diffProperties reports a solid fill replaced by a two-stop gradient as a non-interpolable background change', () => {
  const a = node({ name: 'n', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] })
  const gradient = {
    type: 'GRADIENT_LINEAR',
    gradientStops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ],
    gradientTransform: [[1, 0, 0], [0, 1, 0]] as const,
  }
  const b = node({ name: 'n', fills: [gradient] })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [{ prop: 'background', from: a.fills, to: [gradient], interpolable: false, images: [] }])
})

test('diffProperties composes a drop shadow change into boxShadow', () => {
  const a = node({ name: 'n', effects: [] })
  const b = node({
    name: 'n',
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true }],
  })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [
    {
      prop: 'boxShadow',
      from: [],
      to: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 0, offsetY: 4, radius: 8, spread: 0 }],
    },
  ])
})

test('diffProperties composes a layer blur radius change into layerBlur', () => {
  const a = node({ name: 'n', effects: [{ type: 'LAYER_BLUR', radius: 0, visible: true }] })
  const b = node({ name: 'n', effects: [{ type: 'LAYER_BLUR', radius: 12, visible: true }] })

  assert.deepEqual(diffProperties(a, b), [{ prop: 'layerBlur', from: [0], to: [12] }])
})

test('diffProperties reports a TEXT node fontSize + own fill color as fontSize/textColor, never fillColor/background', () => {
  const a = node({ name: 'n', type: 'TEXT', fontSize: 14, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] })
  const b = node({ name: 'n', type: 'TEXT', fontSize: 20, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] })

  const changes = diffProperties(a, b)

  assert.deepEqual(
    [...changes].sort((x, y) => x.prop.localeCompare(y.prop)),
    [
      { prop: 'fontSize', from: 14, to: 20 },
      { prop: 'textColor', from: { r: 0, g: 0, b: 0, a: 1 }, to: { r: 1, g: 1, b: 1, a: 1 } },
    ]
  )
})

test('diffProperties reports auto-layout padding and gap changes', () => {
  const a = node({ name: 'n', paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, itemSpacing: 4 })
  const b = node({ name: 'n', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, itemSpacing: 12 })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [
    { prop: 'padding', from: [8, 8, 8, 8], to: [16, 16, 16, 16] },
    { prop: 'gap', from: 4, to: 12 },
  ])
})

test('diffProperties reports a visible: true -> false flip', () => {
  const a = node({ name: 'n', visible: true })
  const b = node({ name: 'n', visible: false })

  assert.deepEqual(diffProperties(a, b), [{ prop: 'visible', from: true, to: false }])
})

test('diffProperties treats MIXED on strokes/strokeWeight/fontSize/letterSpacing/lineHeight as no change', () => {
  const a = node({ name: 'n', strokes: MIXED, strokeWeight: MIXED, fontSize: MIXED, letterSpacing: MIXED, lineHeight: MIXED })
  const b = node({
    name: 'n',
    strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokeWeight: 4,
    fontSize: 20,
    letterSpacing: { value: 2, unit: 'PIXELS' },
    lineHeight: { value: 24, unit: 'PIXELS' },
  })

  assert.deepEqual(diffProperties(a, b), [])
})

test('diffProperties reports a photo swap as a non-interpolable background change carrying the destination image paint', () => {
  const a = node({ name: 'n', fills: [{ type: 'IMAGE', imageHash: 'hash-a', scaleMode: 'FILL', opacity: 1 }] })
  const b = node({ name: 'n', fills: [{ type: 'IMAGE', imageHash: 'hash-b', scaleMode: 'FIT', opacity: 1 }] })

  const changes = diffProperties(a, b)

  assert.deepEqual(changes, [
    { prop: 'background', from: a.fills, to: b.fills, interpolable: false, images: [{ imageHash: 'hash-b', scaleMode: 'FIT', opacity: 1 }] },
  ])
})
