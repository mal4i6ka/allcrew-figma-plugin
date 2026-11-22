/**
 * 3D transforms (beta, typings 1.143.0): the write is checked, a partial write keeps what it did
 * not name, and a read gives back the shape the write takes — so reading a tilted card and
 * writing the answer back tilts it the same way.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { describe3d, merge3d, plan3d } from './space3d.ts'
import { planProps } from './props.ts'
import { appearanceOf } from '../agent/appearance.ts'

test('a partial transform keeps the rotations it does not name', () => {
  const problems: string[] = []
  const value = plan3d('transform3d', { rotateY: 45 }, 'props', problems)
  assert.deepEqual(problems, [])
  const before = { type: 'FIXED_ORDER', translateZ: 40, rotateX: 10, rotateY: 30, rotateZ: 0, backfaceVisible: false }
  assert.deepEqual(merge3d('transform3d', before, value!), {
    type: 'FIXED_ORDER',
    translateZ: 40,
    rotateX: 10,
    rotateY: 45,
    rotateZ: 0,
    backfaceVisible: false,
  })
})

test('a transform on a flat layer starts from zero', () => {
  const value = plan3d('transform3d', { rotateX: 20 }, 'props', [])
  assert.deepEqual(merge3d('transform3d', { type: 'NONE' }, value!), {
    type: 'FIXED_ORDER',
    translateZ: 0,
    rotateX: 20,
    rotateY: 0,
    rotateZ: 0,
  })
})

test('"none" and null take the transform and the scene off', () => {
  assert.deepEqual(merge3d('transform3d', {}, plan3d('transform3d', 'none', 'props', [])!), { type: 'NONE' })
  assert.equal(merge3d('scene3d', { perspective: 800, preserve3d: true }, plan3d('scene3d', null, 'props', [])!), null)
})

test('a FREEFORM transform, a string rotation and an unknown field are refused by name', () => {
  const problems: string[] = []
  assert.equal(plan3d('transform3d', { type: 'FREEFORM' }, 'props', problems), null)
  assert.equal(plan3d('transform3d', { rotateY: '30deg' }, 'props', problems), null)
  assert.equal(plan3d('transform3d', { rotY: 30 }, 'props', problems), null)
  assert.equal(plan3d('transform3d', {}, 'props', problems), null)
  assert.equal(problems.length, 4)
  assert.match(problems[0], /FREEFORM/)
  assert.match(problems[1], /rotateY must be a number \(degrees\)/)
  assert.match(problems[2], /unknown field "rotY"/)
})

test('an origin takes percent, pixels and Figma\'s own shape, and defaults the missing axis to the centre', () => {
  const value = plan3d('transformOrigin', { x: 0, y: '25%' }, 'props', [])
  assert.deepEqual(merge3d('transformOrigin', undefined, value!), {
    x: { unit: 'PIXELS', value: 0 },
    y: { unit: 'PERCENT', value: 25 },
  })
  const half = plan3d('transformOrigin', { x: { unit: 'PIXELS', value: 12 } }, 'props', [])
  assert.deepEqual(merge3d('transformOrigin', undefined, half!), {
    x: { unit: 'PIXELS', value: 12 },
    y: { unit: 'PERCENT', value: 50 },
  })
  const problems: string[] = []
  assert.equal(plan3d('transformOrigin', { x: 'left' }, 'props', problems), null)
  assert.match(problems[0], /transformOrigin\.x/)
})

test('a scene write keeps the other half of the scene', () => {
  const value = plan3d('scene3d', { perspective: 1200 }, 'props', [])
  assert.deepEqual(merge3d('scene3d', { perspective: 800, preserve3d: true }, value!), { perspective: 1200, preserve3d: true })
  const fresh = plan3d('scene3d', { preserve3d: true }, 'props', [])
  assert.deepEqual(merge3d('scene3d', null, fresh!), { perspective: -1, preserve3d: true })
})

test('the read says nothing for defaults and gives back the write\'s shape otherwise', () => {
  assert.equal(
    describe3d({ transform3d: { type: 'NONE' }, transformOrigin: { x: { unit: 'PERCENT', value: 50 }, y: { unit: 'PERCENT', value: 50 } }, scene3d: null }),
    undefined
  )
  assert.deepEqual(
    describe3d({
      transform3d: { type: 'FIXED_ORDER', translateZ: 40, rotateX: 0, rotateY: 30, rotateZ: 0, backfaceVisible: false },
      transformOrigin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 50 } },
      scene3d: { perspective: 800, preserve3d: true },
    }),
    {
      transform3d: { translateZ: 40, rotateY: 30, backfaceVisible: false },
      transformOrigin: { x: 0, y: '50%' },
      scene3d: { perspective: 800, preserve3d: true },
    }
  )
})

test('the read round-trips through the planner', () => {
  const read = describe3d({
    transform3d: { type: 'FIXED_ORDER', translateZ: 0, rotateX: 15, rotateY: 0, rotateZ: 5 },
    transformOrigin: { x: { unit: 'PERCENT', value: 0 }, y: { unit: 'PIXELS', value: 10 } },
    scene3d: { perspective: 600, preserve3d: false },
  })!
  const plan = planProps(read)
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(
    plan.steps.map((step) => step.step === 'space3d' && step.property),
    ['transformOrigin', 'transform3d', 'scene3d']
  )
})

test('the 3D props are in the write vocabulary and refused when malformed', () => {
  const plan = planProps({ transform3d: 'sideways', scene3d: { depth: 3 } })
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.problems.length, 2)
})

test('the five 3D tracks are animatable, and a negative perspective track is refused', () => {
  const plan = planProps({
    keyframes: [
      { field: 'rotateY', at: [{ time: 0, value: 0 }, { time: 1, value: 180 }] },
      { field: 'perspective', at: [{ time: 0, value: -1 }] },
    ],
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /perspective track/)
  const ok = planProps({ keyframes: [{ field: 'translateZ', at: [{ time: 0, value: 0 }, { time: 0.5, value: 40 }] }] })
  assert.deepEqual(ok.problems, [])
})

test('appearance reports a tilted card', async () => {
  const got = await appearanceOf({
    transform3d: { type: 'FIXED_ORDER', translateZ: 0, rotateX: 0, rotateY: 30, rotateZ: 0 },
    transformOrigin: { x: { unit: 'PERCENT', value: 50 }, y: { unit: 'PERCENT', value: 50 } },
  }, async () => null)
  assert.deepEqual(got?.transform3d, { rotateY: 30 })
  assert.equal(got?.transformOrigin, undefined)
})
