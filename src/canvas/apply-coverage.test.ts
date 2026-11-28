import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProps, readGrids } from './apply.ts'
import { planProps } from './props.ts'

const steps = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [])
  return plan.steps
}

const styles: Record<string, { name: string }> = { 'S:h1': { name: 'H1' } }
const variables: Record<string, { name: string }> = { 'VariableID:1': { name: 'grid/columns' } }
;(globalThis as unknown as { figma: unknown }).figma = {
  mixed: Symbol('mixed'),
  getStyleByIdAsync: async (id: string) => styles[id] ?? null,
  loadFontAsync: async () => undefined,
  variables: { getVariableByIdAsync: async (id: string) => variables[id] ?? null },
}

test('a write that only repeats what the followed style gives is left out, and says why', async () => {
  const text = { type: 'TEXT', textStyleId: 'S:h1', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32, characters: 'Hi' }
  const same = await applyProps(text as never, steps({ fontSize: 32 }))
  assert.deepEqual(same.applied, [{ property: 'fontSize', before: 32, after: 32, kept: 'follows H1' }])
  assert.equal(text.fontSize, 32)
  const other = await applyProps(text as never, steps({ fontSize: 40 }))
  assert.equal(other.applied[0].kept, undefined)
  assert.equal(text.fontSize, 40)
})

test('a flip mirrors the layer across its own centre, so it stays where it stands', async () => {
  const node = { type: 'RECTANGLE', width: 100, height: 40, relativeTransform: [[1, 0, 10], [0, 1, 20]] }
  const report = await applyProps(node as never, steps({ flip: 'HORIZONTAL' }))
  assert.equal(report.failed, 0)
  assert.deepEqual(node.relativeTransform, [[-1, 0, 110], [-0, 1, 20]])
})

test('a grid bound to a token reads back as the variable it follows', async () => {
  const read = await readGrids([
    {
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      gutterSize: 16,
      count: 12,
      offset: 24,
      visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.1 },
      boundVariables: { count: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
    },
  ])
  assert.deepEqual(read, [{ columns: { variable: 'grid/columns' }, gutter: 16, margin: 24, color: '#FF0000' }])
})
