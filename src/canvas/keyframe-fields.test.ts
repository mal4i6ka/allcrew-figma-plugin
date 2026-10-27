import test from 'node:test'
import assert from 'node:assert/strict'
import { formatKeyframeColour, indexedWord, keyframeColour, parseIndexedField } from './keyframe-fields.ts'
import { readKeyframes } from './keyframes.ts'

const none = () => null

test('a paint is addressed by its collection and index, the first one without a number', () => {
  assert.deepEqual(parseIndexedField('fill'), { field: { type: 'INDEXED_ITEM', collection: 'fills', index: 0 }, value: 'COLOR' })
  assert.deepEqual(parseIndexedField('stroke[2]'), { field: { type: 'INDEXED_ITEM', collection: 'strokes', index: 2 }, value: 'COLOR' })
  // A paint moves as one colour; there is nothing inside it to name.
  assert.equal(parseIndexedField('fill.radius'), null)
})

test('an effect setting uses the word the effects vocabulary builds it with', () => {
  assert.deepEqual(parseIndexedField('effect.radius'), {
    field: { type: 'INDEXED_ITEM', collection: 'effects', index: 0, field: 'RADIUS' },
    value: 'FLOAT',
  })
  assert.deepEqual(parseIndexedField('effect[1].color')?.value, 'COLOR')
  assert.deepEqual(parseIndexedField('effect.refraction')?.field, {
    type: 'INDEXED_ITEM', collection: 'effects', index: 0, field: 'REFRACTION_INTENSITY',
  })
  // `effect` alone says which effect but not what about it.
  for (const bad of ['effect', 'effect.wobble', 'opacity', 'fills', 'fill[x]']) assert.equal(parseIndexedField(bad), null, bad)
})

test('the word a read prints is the word a write takes', () => {
  for (const word of ['fill', 'stroke[1]', 'effect.radius', 'effect[3].second', 'effect.lightAngle']) {
    const parsed = parseIndexedField(word)!
    const field = parsed.field as { collection: string; index: number; field?: string }
    assert.equal(indexedWord(field.collection, field.index, field.field), word)
  }
  assert.equal(indexedWord('effects', 0, 'SOMETHING_NEW'), null)
})

test('a keyframe colour reads back in the spelling the write takes', () => {
  const faded = keyframeColour('#FF0000 @0.4', none)!
  assert.deepEqual(faded, { r: 1, g: 0, b: 0, a: 0.4 })
  assert.equal(formatKeyframeColour(faded), '#FF0000 @0.4')
  assert.equal(formatKeyframeColour(keyframeColour('#00FF0080', none)!), '#00FF00 @0.502')
  assert.equal(formatKeyframeColour({ r: 0, g: 0, b: 1, a: 1 }), '#0000FF')
  assert.equal(keyframeColour('#FF0000 @2', none), null)
  assert.equal(keyframeColour('red', none), null)
})

test('paint and effect tracks are read, and a component-property paint is left out whole', () => {
  const colour = (r: number, a = 1) => ({ type: 'COLOR', value: { r, g: 0, b: 0, a } })
  const read = readKeyframes({
    OPACITY: { keyframes: [{ timelinePosition: 0, value: { type: 'FLOAT', value: 1 } }] },
    fills: {
      0: { baseValue: colour(0), keyframes: [{ timelinePosition: 0.3, value: colour(1, 0.5), easing: { type: 'EASE_OUT' } }] },
      1: { properties: {} },
    },
    effects: { 1: { RADIUS: { keyframes: [{ timelinePosition: 0.2, value: { type: 'FLOAT', value: 24 } }] } } },
  })
  assert.deepEqual(read.keyframes, [
    { field: 'opacity', at: [{ time: 0, value: 1 }] },
    { field: 'fill', from: '#000000', at: [{ time: 0.3, value: '#FF0000 @0.5', easing: 'EASE_OUT' }] },
    { field: 'effect[1].radius', at: [{ time: 0.2, value: 24 }] },
  ])
})
