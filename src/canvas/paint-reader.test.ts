import test from 'node:test'
import assert from 'node:assert/strict'
import { readPaintsForWrite } from './paint-reader.ts'
import { gradientEnds, gradientHandles, gradientTransform, normalisePaint, paintProblem } from './props.ts'

const names: Record<string, string> = { 'VariableID:1': 'surface/inverse', 'VariableID:2': 'brand/primary' }
const nameOf = async (id: string) => names[id] ?? null
const sendable = (read: unknown) => paintProblem(normalisePaint(read))

test('the ordinary case is still the short string', async () => {
  assert.equal(await readPaintsForWrite([{ type: 'SOLID', color: { r: 1, g: 0.357, b: 0.039 } }], nameOf), '#FF5B0A')
  assert.equal(await readPaintsForWrite([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.4 }], nameOf), '#000000 @0.4')
  assert.equal(
    await readPaintsForWrite([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: 'VariableID:1' } } }], nameOf),
    'var:surface/inverse'
  )
  assert.equal(await readPaintsForWrite([], nameOf), 'none')
})

test('a bound scrim keeps its opacity, which the token does not carry', async () => {
  const read = await readPaintsForWrite(
    [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.4, boundVariables: { color: { id: 'VariableID:1' } } }],
    nameOf
  )
  assert.deepEqual(read, { variable: 'surface/inverse', opacity: 0.4 })
  assert.equal(sendable(read), null)
})

test('a picture and a video read as the hash a write puts back', async () => {
  const image = await readPaintsForWrite([{ type: 'IMAGE', imageHash: 'abc', scaleMode: 'FIT', opacity: 0.5 }], nameOf)
  assert.deepEqual(image, { image: { hash: 'abc' }, scaleMode: 'FIT', opacity: 0.5 })
  assert.equal(sendable(image), null)
  const video = await readPaintsForWrite([{ type: 'VIDEO', videoHash: 'v1', scaleMode: 'FILL' }], nameOf)
  assert.deepEqual(video, { video: { hash: 'v1' } })
  assert.equal(sendable(video), null)
  assert.match(String(paintProblem({ video: { url: 'https://x' } })), /bytes only/)
})

test('a gradient reads back to the handles it was written with, bound stops included', async () => {
  for (const kind of ['LINEAR', 'RADIAL'] as const) {
    const { from, to } = gradientHandles({ gradient: kind, angle: 30 })
    const read = (await readPaintsForWrite(
      [
        {
          type: `GRADIENT_${kind}`,
          gradientTransform: gradientTransform(from, to, kind),
          gradientStops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 0.5 } },
            { position: 1, color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { id: 'VariableID:2' } } },
          ],
        },
      ],
      nameOf
    )) as { from: number[]; to: number[]; stops: unknown[] }
    assert.equal(sendable(read), null, kind)
    for (const [got, want] of [[read.from, from], [read.to, to]]) {
      got.forEach((value, i) => assert.ok(Math.abs(value - want[i]) < 1e-3, `${kind}: ${got} vs ${want}`))
    }
    assert.deepEqual(read.stops, [
      { at: 0, color: '#FFFFFF', opacity: 0.5 },
      { at: 1, color: { variable: 'brand/primary' } },
    ])
  }
})

test('a sheared gradient is said to be one, because two handles cannot describe it', () => {
  assert.equal(gradientEnds([[1, 0, 0], [0, 1, 0]])?.skewed, false)
  assert.equal(gradientEnds([[1, 0.5, 0], [0, 1, 0]])?.skewed, true)
  assert.equal(gradientEnds([[0, 0, 0], [0, 0, 0]]), null)
})

test('a stack reads as a list, bottom-up, and is sendable as one', async () => {
  const read = await readPaintsForWrite(
    [
      { type: 'IMAGE', imageHash: 'abc', scaleMode: 'FILL' },
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.3 },
    ],
    nameOf
  )
  assert.deepEqual(read, [{ image: { hash: 'abc' } }, '#000000 @0.3'])
  assert.equal(sendable(read), null)
})

test('a filtered, turned, tiled or cropped picture reads with what makes it so, filters to three places', async () => {
  const filtered = await readPaintsForWrite(
    [{ type: 'IMAGE', imageHash: 'abc', scaleMode: 'FILL', filters: { exposure: 0.30000001192092896, contrast: 0, shadows: -0.4 }, rotation: 90 }],
    nameOf
  )
  assert.deepEqual(filtered, { image: { hash: 'abc' }, filters: { exposure: 0.3, shadows: -0.4 }, rotation: 90 })
  assert.equal(sendable(filtered), null)
  const tiled = await readPaintsForWrite([{ type: 'IMAGE', imageHash: 'abc', scaleMode: 'TILE', scalingFactor: 0.5 }], nameOf)
  assert.deepEqual(tiled, { image: { hash: 'abc' }, scaleMode: 'TILE', tile: 0.5 })
  assert.equal(sendable(tiled), null)
  const cropped = await readPaintsForWrite(
    [{ type: 'IMAGE', imageHash: 'abc', scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]] }],
    nameOf
  )
  assert.deepEqual(cropped, { image: { hash: 'abc' }, scaleMode: 'CROP', crop: [[0.5, 0, 0.25], [0, 0.5, 0.25]] })
  assert.equal(sendable(cropped), null)
})

test('an image takes the panel’s sliders, quarter turns, a tile size and a crop — each only where it means something', () => {
  assert.equal(paintProblem({ image: { hash: 'h' }, filters: { exposure: 0.2, shadows: -0.4 }, rotation: 90 }), null)
  assert.equal(paintProblem({ image: { hash: 'h' }, scaleMode: 'TILE', tile: 0.5 }), null)
  assert.equal(paintProblem({ video: { hash: 'v' }, filters: { tint: 0.1 }, rotation: 180 }), null)
  assert.match(String(paintProblem({ image: { hash: 'h' }, filters: { blur: 1 } })), /unknown "blur"/)
  assert.match(String(paintProblem({ image: { hash: 'h' }, filters: { contrast: 2 } })), /between -1 and 1/)
  assert.match(String(paintProblem({ image: { hash: 'h' }, rotation: 45 })), /rotation must be 0, 90, 180 or 270/)
  assert.match(String(paintProblem({ image: { hash: 'h' }, tile: 2 })), /needs scaleMode TILE/)
  assert.match(String(paintProblem({ image: { hash: 'h' }, scaleMode: 'FILL', crop: [[1, 0, 0], [0, 1, 0]] })), /needs scaleMode CROP/)
})
