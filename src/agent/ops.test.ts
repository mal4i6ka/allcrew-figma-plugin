import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_OPS, READ_OPS, summarizeComponentProperties, summarizeNode, summarizeReactions } from './ops.ts'

/* -------------------------------------------------------------- registry */

test('op names are unique across the whole registry', () => {
  const names = ALL_OPS.map((op) => op.name)
  assert.deepEqual(names, [...new Set(names)])
})

test('the read registry stays read-only — writes live behind their own gate', () => {
  assert.deepEqual(READ_OPS.filter((op) => op.mutates), [])
  assert.ok(ALL_OPS.some((op) => op.mutates), 'no mutating op is registered at all')
})

test('every op carries a summary and describes each param', () => {
  for (const op of ALL_OPS) {
    assert.ok(op.summary.length > 0, `${op.name} has no summary`)
    for (const [param, spec] of Object.entries(op.params)) {
      assert.ok(spec.description.length > 0, `${op.name}.${param} has no description`)
    }
  }
})

/* ------------------------------------------------------------- reactions */

test('summarizeReactions reads the current actions[] shape', () => {
  const summary = summarizeReactions([
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE' }] },
  ])
  assert.deepEqual(summary, [
    { trigger: 'ON_CLICK', action: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE' },
  ])
})

test('summarizeReactions still reads the legacy single action', () => {
  const summary = summarizeReactions([{ trigger: { type: 'ON_HOVER' }, action: { type: 'NODE', destinationId: '5:6' } }])
  assert.deepEqual(summary, [{ trigger: 'ON_HOVER', action: 'NODE', destinationId: '5:6' }])
})

test('summarizeReactions keeps destination-less actions but omits the key', () => {
  const summary = summarizeReactions([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] }])
  assert.deepEqual(summary, [{ trigger: 'ON_CLICK', action: 'CLOSE' }])
})

test('summarizeReactions tolerates a node with no reactions at all', () => {
  assert.deepEqual(summarizeReactions(undefined), [])
  assert.deepEqual(summarizeReactions([null, 'junk']), [])
})

/* ---------------------------------------------------- component properties */

test('summarizeComponentProperties flattens {type,value} entries', () => {
  const props = summarizeComponentProperties({
    Size: { type: 'VARIANT', value: 'Large' },
    Disabled: { type: 'BOOLEAN', value: false },
  })
  assert.deepEqual(props, { Size: 'Large', Disabled: false })
})

test('summarizeComponentProperties returns undefined when there is nothing to report', () => {
  assert.equal(summarizeComponentProperties({}), undefined)
  assert.equal(summarizeComponentProperties(null), undefined)
})

/* ------------------------------------------------------------------ nodes */

test('summarizeNode rounds float-noisy geometry to two places', () => {
  const summary = summarizeNode({ id: '1:1', name: 'Card', type: 'FRAME', x: 10.00000001, y: 3.456, width: 320.5, height: 200 })
  assert.equal(summary.x, 10)
  assert.equal(summary.y, 3.46)
  assert.equal(summary.width, 320.5)
})

test('summarizeNode reports auto-layout only when the node actually uses it', () => {
  const plain = summarizeNode({ id: '1:1', name: 'Group', type: 'FRAME', layoutMode: 'NONE' })
  assert.equal(plain.layout, undefined)

  const stack = summarizeNode({
    id: '1:2',
    name: 'Row',
    type: 'FRAME',
    layoutMode: 'HORIZONTAL',
    itemSpacing: 8,
    paddingTop: 12,
    paddingRight: 16,
    paddingBottom: 12,
    paddingLeft: 16,
    primaryAxisAlignItems: 'SPACE_BETWEEN',
  })
  assert.deepEqual(stack.layout, {
    mode: 'HORIZONTAL',
    itemSpacing: 8,
    padding: [12, 16, 12, 16],
    primaryAxisAlign: 'SPACE_BETWEEN',
  })
})

test('summarizeNode truncates long copy instead of shipping the whole deck', () => {
  const long = 'x'.repeat(400)
  const summary = summarizeNode({ id: '1:3', name: 'Body', type: 'TEXT', characters: long })
  assert.equal(summary.text!.length, 161)
  assert.ok(summary.text!.endsWith('…'))
})

test('summarizeNode keeps short text verbatim', () => {
  assert.equal(summarizeNode({ id: '1:4', name: 'CTA', type: 'TEXT', characters: 'Buy now' }).text, 'Buy now')
})

test('summarizeNode counts children without walking them', () => {
  const summary = summarizeNode({ id: '1:5', name: 'List', type: 'FRAME', children: [{}, {}, {}] })
  assert.equal(summary.childCount, 3)
  assert.equal(summary.children, undefined)
})

test('summarizeNode flags hidden nodes and stays quiet about visible ones', () => {
  assert.equal(summarizeNode({ id: '1:6', name: 'Off', type: 'FRAME', visible: false }).visible, false)
  assert.equal(summarizeNode({ id: '1:7', name: 'On', type: 'FRAME', visible: true }).visible, undefined)
})
