import test from 'node:test'
import assert from 'node:assert/strict'
import { normalisePaint, paintProblem, planProps, repeatModifier, repeatWords } from './props.ts'
import { readPaintsForWrite } from './paint-reader.ts'

test('a repeat in a person\'s words becomes the modifier Figma stores, and reads back the same', () => {
  const linear = repeatModifier({ type: 'linear', count: 5, offset: 12, unit: 'pixels', axis: 'vertical' })
  assert.deepEqual(linear, {
    modifier: { type: 'REPEAT', repeatType: 'LINEAR', count: 5, unitType: 'PIXELS', offset: 12, axis: 'VERTICAL' },
  })
  assert.deepEqual(repeatWords((linear as { modifier: Record<string, unknown> }).modifier), {
    type: 'LINEAR', count: 5, offset: 12, unit: 'PIXELS', axis: 'VERTICAL',
  })
  // The defaults NODE_GROUP always had, and a radial's axis ignored as it always was.
  assert.deepEqual(repeatModifier({}), { modifier: { type: 'REPEAT', repeatType: 'LINEAR', count: 3, unitType: 'RELATIVE', offset: 1, axis: 'HORIZONTAL' } })
  assert.deepEqual(repeatModifier({ type: 'RADIAL', count: 8, axis: 'VERTICAL' }), {
    modifier: { type: 'REPEAT', repeatType: 'RADIAL', count: 8, unitType: 'RELATIVE', offset: 0 },
  })
  assert.match((repeatModifier({ count: 1 }) as { problem: string }).problem, /at least 2/)
  assert.match((repeatModifier({ angle: 45 }) as { problem: string }).problem, /not angle/)
})

test('repeat is a property too, one spec for every child or one each', () => {
  const [one] = planProps({ repeat: { type: 'RADIAL', count: 6 } }).steps
  assert.equal(one.step, 'repeat')
  const [many] = planProps({ repeat: [{ count: 2 }, { count: 4 }] }).steps
  assert.equal(Array.isArray((many as { modifiers: unknown }).modifiers), true)
  assert.match(planProps({ repeat: [{ count: 2 }, { count: 0 }] }).problems[0], /repeat\[1\] count/)
})

test('a pattern fill reads as the node it tiles, and goes back on as one', async () => {
  const read = await readPaintsForWrite(
    [{ type: 'PATTERN', sourceNodeId: '12:34', tileType: 'HORIZONTAL_HEXAGONAL', scalingFactor: 0.5, spacing: { x: 0.1, y: 0 }, horizontalAlignment: 'CENTER' }],
    async () => null
  )
  assert.deepEqual(read, { pattern: '12:34', tile: 'HORIZONTAL_HEXAGONAL', scale: 0.5, spacing: [0.1, 0], align: 'CENTER' })
  assert.equal(paintProblem(normalisePaint(read)), null)
  assert.deepEqual(
    await readPaintsForWrite([{ type: 'PATTERN', sourceNodeId: '1:2', tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' }], async () => null),
    { pattern: '1:2' }
  )
  assert.match(String(paintProblem({ pattern: '1:2', tile: 'CIRCLES' })), /tile must be one of/)
  assert.match(String(paintProblem({ pattern: '1:2', rotate: 3 })), /not rotate/)
})
