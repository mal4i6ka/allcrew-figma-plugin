import test from 'node:test'
import assert from 'node:assert/strict'
import { compare, kindOf, sendable } from './roundtrip.ts'

test('a reading the write understands passes through whole', () => {
  const { props, dropped } = sendable({ fill: '#FF5B0A', cornerRadius: 8, opacity: 0.5 })
  assert.deepEqual(dropped, [])
  assert.deepEqual(props, { fill: '#FF5B0A', cornerRadius: 8, opacity: 0.5 })
})

test('what the write refuses is named, not silently left out', () => {
  // The point of the instrument: an unsendable reading is the finding, so it has to come back
  // with the property and the planner's own sentence.
  const { props, dropped } = sendable({ fill: '#FF5B0A', invented: 3 })
  assert.deepEqual(props, { fill: '#FF5B0A' })
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].property, 'invented')
  assert.match(dropped[0].why!, /unknown property "invented"/)
})

test('"mixed" is an answer, not a value, and never counts as a defect', () => {
  const { props, dropped, notValues } = sendable({ fontSize: 'mixed', fill: '#000000' })
  assert.deepEqual(props, { fill: '#000000' })
  assert.deepEqual(dropped, [])
  assert.deepEqual(notValues, ['fontSize'])
})

test('what a reading says about the node is not a candidate for the write', () => {
  const { props, dropped } = sendable({ id: '1:2', type: 'FRAME', parent: { id: '0:1' }, component: 'Chip', fill: '#FFFFFF' })
  assert.deepEqual(props, { fill: '#FFFFFF' })
  assert.deepEqual(dropped, [], 'an id is not a property that failed to travel')
})

test('the comparison reports what changed, and ignores where the copy sits', () => {
  const { same, diverged } = compare(
    { x: 10, y: 20, fill: '#FF5B0A', width: 100 },
    { x: 999, y: 999, fill: '#000000', width: 100 },
    new Set()
  )
  assert.deepEqual(same, ['width'])
  assert.deepEqual(diverged, [{ property: 'fill', was: '#FF5B0A', became: '#000000' }])
})

test('a node type NODE_CREATE cannot make says so rather than half-trying', () => {
  assert.equal(kindOf('FRAME'), 'frame')
  assert.equal(kindOf('TEXT_PATH'), 'textPath')
  assert.equal(kindOf('GROUP'), null)
  assert.equal(kindOf('SLICE'), null)
})
