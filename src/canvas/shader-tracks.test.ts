import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProps, unseenUnderPreserve3d } from './apply.ts'
import { readKeyframes, shaderSettingNames } from './keyframes.ts'
import { planProps } from './props.ts'
import { animatedShaderProperties, describeShader } from '../agent/paints.ts'

/**
 * Keyframes on a shader's settings, and what a preserve-3D container does not draw. The ids and
 * the shape of the tracks are the ones Figma returned for a Water caustic fill (19.11.2026, read upstream).
 */

const SCALE = '2793279086:389096460'
const INTENSITY = '3753036810:3652539474'

const stepsOf = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  return plan.steps
}

/** A rectangle wearing a solid and a shader, that keeps tracks and plugin data the way Figma does. */
function shaderNode(over: Record<string, unknown> = {}) {
  const data = new Map<string, string>()
  const calls: Array<{ op: 'apply' | 'remove'; field: Record<string, unknown>; track?: unknown }> = []
  const node = {
    id: '13:14',
    type: 'RECTANGLE',
    fills: [
      { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } },
      {
        type: 'SHADER',
        id: '40f03f78/8370',
        properties: { [SCALE]: 1, [INTENSITY]: 0.5 },
        propertyMetadata: { [SCALE]: { name: 'scale', type: 'NUMBER', defaultValue: 1 }, [INTENSITY]: { name: 'intensity', type: 'NUMBER', defaultValue: 0.5 } },
      },
    ],
    manualKeyframeTracks: {} as Record<string, unknown>,
    applyManualKeyframeTrack(field: Record<string, unknown>, track: unknown) {
      calls.push({ op: 'apply', field, track })
    },
    removeManualKeyframeTrack(field: Record<string, unknown>) {
      calls.push({ op: 'remove', field })
    },
    getPluginData: (key: string) => data.get(key) ?? '',
    setPluginData: (key: string, value: string) => void data.set(key, value),
    ...over,
  }
  return { node: node as unknown as SceneNode, calls, raw: node }
}

/* ---------------------------------------------------------------- planning */

test('a shader setting is a track of its own kind: by stack, place and setting', () => {
  const [step] = stepsOf({ keyframes: [{ shader: { setting: 'scale' }, at: [{ time: 0, value: 0.25 }, { time: 2, value: 3, easing: 'LINEAR' }] }] })
  const planned = step as { step: string; tracks: unknown[]; shaderTracks: Array<{ collection: string; index?: number; setting: string; track: { keyframes: Array<{ timelinePosition: number; value: unknown; easing?: { type: string } }> } }> }
  assert.equal(planned.step, 'keyframes')
  assert.deepEqual(planned.tracks, [])
  const [one] = planned.shaderTracks
  assert.equal(one.collection, 'fills')
  assert.equal(one.index, undefined)
  assert.equal(one.setting, 'scale')
  assert.deepEqual(one.track.keyframes.map((frame) => [frame.timelinePosition, frame.value, frame.easing?.type]), [
    [0, { type: 'FLOAT', value: 0.25 }, undefined],
    [2, { type: 'FLOAT', value: 3 }, 'LINEAR'],
  ])
})

test('the stack and the place can be named, and a layer’s own tracks travel beside a shader’s', () => {
  const [step] = stepsOf({
    keyframes: [
      { field: 'opacity', at: [{ time: 1, value: 0 }] },
      { shader: { setting: SCALE, in: 'effect', index: 2 }, from: 1, at: [{ time: 1, value: 2 }] },
    ],
  }) as Array<{ tracks: unknown[]; shaderTracks: Array<Record<string, unknown>> }>
  assert.equal(step.tracks.length, 1)
  assert.equal(step.shaderTracks[0].collection, 'effects')
  assert.equal(step.shaderTracks[0].index, 2)
  assert.deepEqual((step.shaderTracks[0].track as { baseValue: unknown }).baseValue, { type: 'FLOAT', value: 1 })
})

test('a shader value is typed by its shape: number, point, switch or colour', () => {
  const value = (v: unknown) =>
    ((stepsOf({ keyframes: [{ shader: { setting: 's' }, at: [{ time: 0, value: v }] }] })[0] as { shaderTracks: Array<{ track: { keyframes: Array<{ value: unknown }> } }> }).shaderTracks[0].track.keyframes[0].value)
  assert.deepEqual(value(0.5), { type: 'FLOAT', value: 0.5 })
  assert.deepEqual(value({ x: 50, y: 25 }), { type: 'VECTOR', value: { x: 50, y: 25 } })
  assert.deepEqual(value(true), { type: 'BOOL', value: true })
  assert.deepEqual(value('#0063B4'), { type: 'COLOR', value: { r: 0, g: 99 / 255, b: 180 / 255, a: 1 } })
  assert.deepEqual(value({ r: 0, g: 0.5, b: 1, a: 0.5 }), { type: 'COLOR', value: { r: 0, g: 0.5, b: 1, a: 0.5 } })
})

test('a shader track that cannot be written says why', () => {
  const problem = (track: unknown) => planProps({ keyframes: [track] }).problems[0]
  assert.match(problem({ shader: {}, at: [{ time: 0, value: 1 }] }), /shader must be \{ setting, in\?, index\? \}/)
  assert.match(problem({ shader: { setting: 'scale', in: 'text' }, at: [{ time: 0, value: 1 }] }), /shader\.in must be fill, stroke or effect/)
  assert.match(problem({ shader: { setting: 'scale', index: -1 }, at: [{ time: 0, value: 1 }] }), /shader\.index must be the shader's place/)
  assert.match(problem({ shader: { setting: 'scale', layer: 1 }, at: [{ time: 0, value: 1 }] }), /shader\.layer is not accepted/)
  assert.match(problem({ shader: { setting: 'scale' }, at: [{ time: 0, value: 'wide' }] }), /must be a number, \{ x, y \}, true\/false or a colour/)
  assert.match(problem({ shader: { setting: 'scale' }, at: [] }), /at must be a non-empty array/)
  // And a track with neither says what both spellings are.
  assert.match(problem({ at: [{ time: 0, value: 1 }] }), /or give shader: \{ setting \}/)
})

/* ----------------------------------------------------------------- applying */

const scaleTrack = { keyframes: [{ shader: { setting: 'scale' }, at: [{ time: 0, value: 0.25 }, { time: 2, value: 3 }] }] }

test('the setting is found by name on the first shader in the stack, and written as Figma addresses it', async () => {
  const { node, calls } = shaderNode()
  const report = await applyProps(node, stepsOf(scaleTrack))
  assert.equal(report.failed, 0)
  assert.equal(report.applied[0].after, 'fills[1].scale')
  assert.deepEqual(calls[0].field, { type: 'INDEXED_ITEM', collection: 'fills', index: 1, propertyId: SCALE })
})

test('the name is kept on the layer, because Figma stops giving it once the setting is animated', async () => {
  const { node, raw } = shaderNode()
  await applyProps(node, stepsOf(scaleTrack))
  assert.deepEqual(shaderSettingNames(node), { [SCALE]: 'scale' })

  // What Figma does next (seen live): the setting leaves `properties` and `propertyMetadata`.
  const shader = raw.fills[1] as { properties: Record<string, unknown>; propertyMetadata: Record<string, unknown> }
  delete shader.properties[SCALE]
  delete shader.propertyMetadata[SCALE]
  raw.manualKeyframeTracks = { fills: { 1: { properties: { [SCALE]: { baseValue: { type: 'FLOAT', value: 1 }, keyframes: [{}, {}] } } } } }

  // A read still names it…
  const tracks = animatedShaderProperties(node, 'fills', 1)
  assert.equal(tracks?.[SCALE].name, 'scale')
  const described = await describeShader(raw.fills[1] as never, undefined, tracks)
  assert.deepEqual(described.properties?.at(-1), { id: SCALE, name: 'scale', value: 1, animated: true, keyframes: 2 })

  // …and a second write by name still finds it.
  const { calls } = { calls: [] as unknown[] }
  const again = await applyProps(node, stepsOf({ keyframes: [{ shader: { setting: 'Scale' }, at: [{ time: 0, value: 2 }] }] }))
  assert.equal(again.failed, 0)
  assert.equal(calls.length, 0)
})

test('an id is taken as it is, and a track is taken off the same way it was put on', async () => {
  const { node, calls } = shaderNode()
  await applyProps(node, stepsOf({ keyframes: [{ shader: { setting: INTENSITY, index: 1 }, at: [{ time: 0, value: 1 }] }] }))
  assert.equal((calls[0].field as { propertyId: string }).propertyId, INTENSITY)

  const report = await applyProps(node, stepsOf({ keyframes: [{ shader: { setting: 'intensity' }, at: null }] }))
  assert.equal(report.failed, 0)
  assert.deepEqual(calls[1], { op: 'remove', field: { type: 'INDEXED_ITEM', collection: 'fills', index: 1, propertyId: INTENSITY } })
  assert.equal(report.applied[0].after, '-fills[1].intensity')
})

test('a layer without a shader, a place that is not one, and a setting it does not have are refused by name', async () => {
  const plain = shaderNode({ fills: [{ type: 'SOLID' }] })
  assert.match(String((await applyProps(plain.node, stepsOf(scaleTrack))).applied[0].error), /shader scale: this layer has no shader fill — put one on it first/)

  const wrongPlace = shaderNode()
  const report = await applyProps(wrongPlace.node, stepsOf({ keyframes: [{ shader: { setting: 'scale', index: 0 }, at: [{ time: 0, value: 1 }] }] }))
  assert.match(String(report.applied[0].error), /fills\[0\] is not a shader — it is SOLID/)

  const unknown = shaderNode()
  const second = await applyProps(unknown.node, stepsOf({ keyframes: [{ shader: { setting: 'speed' }, at: [{ time: 0, value: 1 }] }] }))
  assert.match(String(second.applied[0].error), /no setting called "speed" — it has: scale, intensity/)
  assert.deepEqual(unknown.calls, [])
})

test('a dry run resolves the setting and writes nothing', async () => {
  const { node, calls } = shaderNode()
  const report = await applyProps(node, stepsOf(scaleTrack), true)
  assert.equal(report.failed, 0)
  assert.equal(report.applied[0].after, 'fills[1].scale')
  assert.deepEqual(calls, [])
  assert.deepEqual(shaderSettingNames(node), {})
})

/* ------------------------------------------------------------------ reading */

test('a read of shader tracks is a write that would make them again', () => {
  // The shape Figma returned for the Water caustic fill.
  const read = readKeyframes({
    fills: {
      1: {
        properties: {
          [SCALE]: {
            id: 'KeyframeTrackId:22:4',
            baseValue: { type: 'FLOAT', value: 1 },
            keyframes: [
              { id: '22:5', easing: { type: 'CUSTOM_CUBIC_BEZIER' }, value: { type: 'FLOAT', value: 0.25 }, timelinePosition: 0 },
              { id: '22:6', easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 3 }, timelinePosition: 2 },
            ],
          },
        },
      },
    },
    OPACITY: { baseValue: { type: 'FLOAT', value: 1 }, keyframes: [{ timelinePosition: 1, value: { type: 'FLOAT', value: 0 } }] },
  })
  assert.deepEqual(read, {
    // In the order Figma keeps the tracks: the paint slots first here, as the object has them.
    keyframes: [
      { shader: { setting: SCALE, in: 'fill', index: 1 }, from: 1, at: [{ time: 0, value: 0.25 }, { time: 2, value: 3, easing: 'LINEAR' }] },
      { field: 'opacity', from: 1, at: [{ time: 1, value: 0 }] },
    ],
  })
  assert.deepEqual(planProps(read).problems, [])
})

test('a paint track that is not a shader’s is still left out rather than half-read', () => {
  assert.deepEqual(readKeyframes({ fills: { 0: { baseValue: { type: 'COLOR', value: {} }, keyframes: [] } } }), {})
})

/* ------------------------------------------- what a preserve-3D frame does not draw */

const sceneFrame = (over: Record<string, unknown> = {}) =>
  ({ id: '1:1', type: 'FRAME', scene3d: { perspective: -1, preserve3d: true }, opacity: 1, blendMode: 'PASS_THROUGH', effects: [], clipsContent: false, ...over }) as unknown as SceneNode

test('a write that lands on a preserve-3D container and will not show says so', async () => {
  // Seen live through the plugin: Figma takes opacity 0.5 on such a frame, keeps it and draws it at 100%.
  const node = sceneFrame()
  const report = await applyProps(node, stepsOf({ opacity: 0.5 }))
  assert.equal(report.failed, 0)
  assert.equal((node as unknown as { opacity: number }).opacity, 0.5)
  assert.match(String(report.applied[0].note), /Figma does not draw opacity on a preserve-3D container — the value is kept, the canvas does not change; put it on a parent frame/)
})

test('switching preserve-3D on over an opacity and a clip names both', async () => {
  const node = sceneFrame({ scene3d: null, opacity: 0.4, clipsContent: true })
  const report = await applyProps(node, stepsOf({ scene3d: { preserve3d: true } }))
  assert.match(String(report.applied[0].note), /does not draw opacity, clip on a preserve-3D container.*put them on a parent/)
})

test('nothing is said on a flat container, for a value that draws, or for an unrelated property', async () => {
  assert.equal((await applyProps(sceneFrame({ scene3d: { perspective: 800, preserve3d: false } }), stepsOf({ opacity: 0.5 }))).applied[0].note, undefined)
  assert.equal((await applyProps(sceneFrame(), stepsOf({ opacity: 1 }))).applied[0].note, undefined)
  assert.equal((await applyProps(sceneFrame({ opacity: 0.5, name: 'a' }), stepsOf({ name: 'Scene' }))).applied[0].note, undefined)
  assert.deepEqual(unseenUnderPreserve3d(sceneFrame({ opacity: 0.5, blendMode: 'MULTIPLY', effects: [{ type: 'DROP_SHADOW' }], clipsContent: true })), ['opacity', 'blend mode', 'effects', 'clip'])
  assert.deepEqual(unseenUnderPreserve3d({ opacity: 0.5 }), [])
})

test('a setting animated by someone else is named from another layer wearing the same shader', async () => {
  // Read live: a track written outside this plugin leaves no kept name, and the paint has lost it.
  const animatedLayer = {
    id: '13:14',
    type: 'RECTANGLE',
    fills: [{ type: 'SHADER', id: '40f03f78/8370', properties: {}, propertyMetadata: {} }],
    manualKeyframeTracks: { fills: { 0: { properties: { [SCALE]: { baseValue: { type: 'FLOAT', value: 1 }, keyframes: [{}, {}] } } } } },
  }
  const page: { children: unknown[] } = { children: [animatedLayer] }
  ;(globalThis as { figma?: unknown }).figma = { currentPage: page }
  try {
    // Nobody on the page names it yet — and that miss must not stick.
    assert.equal(animatedShaderProperties(animatedLayer, 'fills', 0)?.[SCALE].name, undefined)
    page.children.push({
      id: '12:1',
      type: 'FRAME',
      children: [{ id: '12:2', type: 'RECTANGLE', fills: [{ type: 'SHADER', id: '40f03f78/8370', propertyMetadata: { [SCALE]: { name: 'scale' } } }] }],
    })
    assert.equal(animatedShaderProperties(animatedLayer, 'fills', 0)?.[SCALE].name, 'scale')
    // A different shader with a setting of the same id is not believed.
    const other = { ...animatedLayer, fills: [{ type: 'SHADER', id: 'another/1', properties: {}, propertyMetadata: {} }] }
    assert.equal(animatedShaderProperties(other, 'fills', 0)?.[SCALE].name, undefined)
  } finally {
    delete (globalThis as { figma?: unknown }).figma
  }
})
