import test from 'node:test'
import assert from 'node:assert/strict'
import { grainSize, planProps } from './props.ts'
import { readEffects } from './effect-reader.ts'

test('grain is one number for both axes, or [x, y] stretched — and x is what noiseSize says', () => {
  assert.deepEqual(grainSize(undefined), { noiseSize: 1 })
  assert.deepEqual(grainSize(2), { noiseSize: 2 })
  assert.deepEqual(grainSize([2, 2]), { noiseSize: 2 })
  assert.deepEqual(grainSize([1, 4]), { noiseSize: 1, noiseSizeVector: { x: 1, y: 4 } })
  for (const bad of [0, -1, [1], [1, 0], 'big']) assert.equal(grainSize(bad), null)
  assert.match(planProps({ effects: [{ texture: 4, size: [1, 0] }] }).problems[0], /\[x, y\]/)
})

test('a stretched grain reads back as the pair a write takes', async () => {
  const read = await readEffects([
    { type: 'TEXTURE', radius: 4, noiseSize: 1, noiseSizeVector: { x: 1, y: 4 }, clipToShape: true, visible: true },
    { type: 'TEXTURE', radius: 4, noiseSize: 2, noiseSizeVector: { x: 2, y: 2 }, clipToShape: true, visible: true },
  ])
  assert.deepEqual(read?.map((one) => (one as { size: unknown }).size), [[1, 4], 2])
})
