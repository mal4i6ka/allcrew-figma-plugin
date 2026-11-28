/**
 * 3D transforms where they land on a node: which node types hold a scene, and which 3D keyframe
 * tracks Figma can animate. The nodes are stand-ins that hold what Figma holds; what Figma itself
 * does with a value is for a live check.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProps } from './apply.ts'
import { planProps } from './props.ts'

const stepsOf = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return plan.steps
}

const rectangle = (over: Record<string, unknown> = {}) =>
  ({
    id: '1:2',
    type: 'RECTANGLE',
    transform3d: { type: 'NONE' },
    transformOrigin: { x: { unit: 'PERCENT', value: 50 }, y: { unit: 'PERCENT', value: 50 } },
    ...over,
  }) as unknown as SceneNode

const frame = (over: Record<string, unknown> = {}) => rectangle({ id: '1:1', type: 'FRAME', scene3d: null, ...over })

test('only a frame, component or instance takes a scene, and a refusal says so', async () => {
  const container = frame()
  const report = await applyProps(container, stepsOf({ scene3d: { perspective: 800 } }))
  assert.equal(report.failed, 0)
  assert.deepEqual((container as unknown as { scene3d: unknown }).scene3d, { perspective: 800, preserve3d: false })

  const refused = await applyProps(rectangle(), stepsOf({ scene3d: { perspective: 800 } }))
  assert.equal(refused.failed, 1)
  assert.match(String(refused.applied[0].error), /a RECTANGLE has no 3D scene — only a FRAME, COMPONENT or INSTANCE does/)
  // A group even if a future Figma hangs the property on it: the type decides.
  const group = await applyProps(rectangle({ type: 'GROUP', scene3d: null }), stepsOf({ scene3d: { perspective: 800 } }))
  assert.match(String(group.applied[0].error), /a GROUP has no 3D scene/)
})

const animatable = (over: Record<string, unknown> = {}) => {
  const written: string[] = []
  const node = rectangle({
    manualKeyframeTracks: {},
    applyManualKeyframeTrack: (field: { name: string }) => written.push(field.name),
    ...over,
  })
  return { node, written }
}

const turnY = { keyframes: [{ field: 'rotateY', at: [{ time: 1, value: 180 }] }] }

test('a flat layer takes a 3D track as it is — Figma converts it — and only an imported transform is refused', async () => {
  // Seen live: applying TRANSFORM_3D_ROTATION_X to a layer with `{ type: 'NONE' }` succeeds and
  // leaves it FIXED_ORDER with zeros. The stand-in does not convert; the point is that we do not refuse.
  const flat = animatable()
  const report = await applyProps(flat.node, stepsOf(turnY))
  assert.equal(report.failed, 0)
  assert.deepEqual(flat.written, ['TRANSFORM_3D_ROTATION_Y'])

  const imported = animatable({ transform3d: { type: 'FREEFORM', backfaceVisible: true } })
  const second = await applyProps(imported.node, stepsOf(turnY))
  assert.equal(second.failed, 1)
  assert.match(String(second.applied[0].error), /TRANSFORM_3D_ROTATION_Y: this layer has an imported \(FREEFORM\) 3D transform, which cannot be animated/)
  assert.deepEqual(imported.written, [])
})

test('a layer with no 3D transform at all — an older Figma — says so', async () => {
  const written: string[] = []
  const old = { id: '1:9', type: 'RECTANGLE', manualKeyframeTracks: {}, applyManualKeyframeTrack: (field: { name: string }) => written.push(field.name) }
  const report = await applyProps(old as unknown as SceneNode, stepsOf(turnY))
  assert.match(String(report.applied[0].error), /a RECTANGLE has no 3D transform to animate/)
  assert.deepEqual(written, [])
})

test('a refused 3D track does not take the other tracks down with it', async () => {
  const imported = animatable({ transform3d: { type: 'FREEFORM', backfaceVisible: true } })
  const report = await applyProps(
    imported.node,
    stepsOf({ keyframes: [{ field: 'rotateY', at: [{ time: 1, value: 180 }] }, { field: 'opacity', at: [{ time: 1, value: 0 }] }] })
  )
  assert.equal(report.failed, 1)
  assert.deepEqual(imported.written, ['OPACITY'])
})

test('replacing an imported transform and animating it can travel in one call, dry or not', async () => {
  const both = { transform3d: { rotateY: 0 }, ...turnY }

  const real = animatable({ transform3d: { type: 'FREEFORM', backfaceVisible: true } })
  const report = await applyProps(real.node, stepsOf(both))
  assert.equal(report.failed, 0)
  assert.deepEqual(real.written, ['TRANSFORM_3D_ROTATION_Y'])

  const dry = animatable()
  const dryReport = await applyProps(dry.node, stepsOf(both), true)
  assert.equal(dryReport.failed, 0)
  assert.deepEqual(dry.written, [])
})

test('a perspective track belongs on the container that holds the scene', async () => {
  const track = { keyframes: [{ field: 'perspective', at: [{ time: 1, value: 400 }] }] }
  const shape = animatable()
  const refused = await applyProps(shape.node, stepsOf(track))
  assert.match(String(refused.applied[0].error), /a RECTANGLE has no perspective to animate — only a FRAME, COMPONENT or INSTANCE/)

  const container = animatable({ type: 'FRAME', scene3d: { perspective: 800, preserve3d: false } })
  const report = await applyProps(container.node, stepsOf(track))
  assert.equal(report.failed, 0)
  assert.deepEqual(container.written, ['SCENE_3D_PERSPECTIVE'])
})
