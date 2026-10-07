import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProps } from './apply.ts'
import { planProps } from './props.ts'

const steps = (props: unknown) => {
  const plan = planProps(props)
  assert.deepEqual(plan.problems, [])
  return plan.steps
}

test('vertical auto layout can wrap with a counter-axis gap', async () => {
  const frame = {
    type: 'FRAME',
    layoutMode: 'VERTICAL',
    layoutWrap: 'NO_WRAP',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    itemSpacing: 8,
    counterAxisSpacing: 0,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
  }
  const report = await applyProps(frame as never, steps({ layout: { mode: 'VERTICAL', wrap: true, wrapGap: 12 } }))

  assert.equal(report.failed, 0)
  assert.equal(frame.layoutWrap, 'WRAP')
  assert.equal(frame.counterAxisSpacing, 12)
})

test('new primary-axis distribution values pass through to Figma', async () => {
  for (const value of ['SPACE_AROUND', 'SPACE_EVENLY'] as const) {
    const frame = {
      type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 0,
      primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN',
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    }
    const report = await applyProps(frame as never, steps({ layout: { primaryAxis: value } }))
    assert.equal(report.failed, 0)
    assert.equal(frame.primaryAxisAlignItems, value)
  }
})

test('variable font axes load and apply without requiring a named style', async () => {
  const loaded: FontNameInput[] = []
  Object.assign(globalThis, {
    figma: {
      mixed: Symbol('mixed'),
      loadFontAsync: async (font: FontNameInput) => { loaded.push(font) },
    },
  })
  const text = { type: 'TEXT', fontName: { family: 'Inter', style: 'Regular' } }
  const font = { family: 'Roboto Flex', variationSettings: { wght: 550, wdth: 92 } }
  const report = await applyProps(text as never, steps({ fontName: font }))

  assert.equal(report.failed, 0)
  assert.deepEqual(loaded, [font])
  assert.deepEqual(text.fontName, font)
  assert.match(String(report.applied[0].after), /wght=550.*wdth=92/)
})
