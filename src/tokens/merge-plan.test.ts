import test from 'node:test'
import assert from 'node:assert/strict'
import { planMerge } from './merge-plan.ts'

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
const one = {
  name: 'One',
  modes: { Light: 'One Light', Dark: 'One Dark' },
  variables: [
    { id: 'V:o1', name: 'background/base', type: 'COLOR', values: { Light: alias('C:white'), Dark: alias('C:black') } },
    { id: 'V:o2', name: 'border/subtle', type: 'COLOR', values: { Light: alias('C:grey'), Dark: alias('C:grey9') } },
    { id: 'V:o3', name: 'radius', type: 'FLOAT', values: { Light: 8, Dark: 8 } },
  ],
}
const business = {
  name: 'Business',
  modes: { Light: 'Business Light', Dark: 'Business Dark' },
  variables: [
    { id: 'V:b1', name: 'background/base', type: 'COLOR', values: { Light: alias('C:white'), Dark: alias('C:ink') } },
    { id: 'V:b2', name: 'status/positive', type: 'COLOR', values: { Light: alias('C:green'), Dark: alias('C:green9') } },
  ],
}
const FILL = { 'One Light': 'Business Light', 'One Dark': 'Business Dark', 'Business Light': 'One Light', 'Business Dark': 'One Dark' }

test('planMerge: one key set for every product, each borrowed cell named, a new product seeded', () => {
  const plan = planMerge([one, business], { fill: FILL, seed: [{ mode: 'Platform Light', from: 'Business Light' }] })
  assert.deepEqual(plan.modes, ['One Light', 'One Dark', 'Business Light', 'Business Dark', 'Platform Light'])
  assert.deepEqual(plan.rows.map((r) => r.name).sort(), ['background/base', 'border/subtle', 'radius', 'status/positive'])
  const base = plan.rows.find((r) => r.name === 'background/base')!
  assert.deepEqual(base.cells['Business Dark'], { value: alias('C:ink'), origin: 'source' }, 'a product keeps its own value')
  assert.deepEqual(base.sourceIds, ['V:o1', 'V:b1'])
  // border/subtle exists only in One: Business borrows it, and says so.
  assert.deepEqual(plan.filled.filter((f) => f.name === 'border/subtle'), [
    { name: 'border/subtle', mode: 'Business Light', from: 'One Light' },
    { name: 'border/subtle', mode: 'Business Dark', from: 'One Dark' },
  ])
  // Platform is a copy of Business Light — including what Business itself borrowed.
  assert.deepEqual(plan.rows.find((r) => r.name === 'border/subtle')!.cells['Platform Light'], { value: alias('C:grey'), origin: 'seed', from: 'Business Light' })
  assert.deepEqual(plan.holes, [])
})

test('planMerge: no fill leaves holes, a fill never borrows a fill, two types are a conflict', () => {
  const bare = planMerge([one, business])
  assert.ok(bare.holes.some((h) => h.name === 'status/positive' && h.mode === 'One Light'))
  // Business Light borrows from One Light, which itself only has a borrowed value for status/positive: not taken.
  const chained = planMerge([one, business], { fill: { 'One Light': 'Business Light', 'Business Dark': 'One Light' } })
  assert.ok(chained.holes.some((h) => h.name === 'status/positive' && h.mode === 'Business Dark') === false, 'Business Dark has its own value')
  assert.ok(chained.holes.some((h) => h.name === 'border/subtle' && h.mode === 'Business Light'))
  const clash = planMerge([one, { ...business, variables: [{ id: 'V:b3', name: 'radius', type: 'COLOR', values: { Light: alias('C:x') } }] }])
  assert.deepEqual(clash.conflicts, [{ name: 'radius', types: { One: 'FLOAT', Business: 'COLOR' } }])
  assert.equal(clash.rows.some((r) => r.name === 'radius'), false)
  assert.throws(() => planMerge([one, { ...business, modes: { Light: 'One Light' } }]), /mapped twice/)
  assert.throws(() => planMerge([one], { seed: [{ mode: 'Platform', from: 'Nope' }] }), /not a target mode/)
})
