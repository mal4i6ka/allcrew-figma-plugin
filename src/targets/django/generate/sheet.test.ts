import test from 'node:test'
import assert from 'node:assert/strict'
import { packShelves, variantCells, gridDims, clusterSubtitle } from './sheet.ts'
import { planComponent } from './plan.ts'
import type { ComponentSpec } from '../bootstrap/specs.ts'

test('packShelves wraps at maxWidth and stacks rows by the tallest box', () => {
  const pos = packShelves([{ w: 100, h: 40 }, { w: 100, h: 60 }, { w: 100, h: 30 }], 250, 10, 20)
  assert.deepEqual(pos[0], { x: 0, y: 0 })
  assert.deepEqual(pos[1], { x: 110, y: 0 }) // fits (100+10+100 = 210 ≤ 250)
  assert.deepEqual(pos[2], { x: 0, y: 80 }) // wraps; row height 60 + gapY 20
})

const twoAxis: ComponentSpec = {
  name: 'Button',
  props: [
    { name: 'Variant', type: 'VARIANT', options: ['Primary', 'Secondary', 'Success'] },
    { name: 'Size', type: 'VARIANT', options: ['sm', 'md'] },
  ],
}

test('variantCells: rows = first prop (color down), cols = the rest (size across)', () => {
  const plan = planComponent(twoAxis)
  const cells = variantCells(plan)
  assert.equal(cells.length, 6)
  assert.deepEqual(cells[0], { x: 0, y: 0 }) // Primary sm
  assert.deepEqual(cells[1], { x: 1, y: 0 }) // Primary md
  assert.deepEqual(cells[2], { x: 0, y: 1 }) // Secondary sm
  assert.deepEqual(gridDims(plan), { cols: 2, rows: 3 })
})

test('variantCells: single / zero variant props lay out as one column', () => {
  const oneAxis = planComponent({ name: 'Badge', props: [{ name: 'Variant', type: 'VARIANT', options: ['Primary', 'Secondary'] }] })
  assert.deepEqual(variantCells(oneAxis), [{ x: 0, y: 0 }, { x: 0, y: 1 }])
  const lone = planComponent({ name: 'Card', props: [] })
  assert.deepEqual(variantCells(lone), [{ x: 0, y: 0 }])
})

test('clusterSubtitle summarizes axes, variant count, and boolean props', () => {
  const s = clusterSubtitle(
    planComponent({
      name: 'Alert',
      props: [
        { name: 'Variant', type: 'VARIANT', options: ['Primary', 'Secondary'] },
        { name: 'Dismissible', type: 'BOOLEAN', boolDefault: false },
      ],
    })
  )
  assert.match(s, /Variant \(2\)/)
  assert.match(s, /2 variants/)
  assert.match(s, /Dismissible/)
})

test('clusterSubtitle for a lone component reads "single frame · 1 variant"', () => {
  const s = clusterSubtitle(planComponent({ name: 'Card', props: [] }))
  assert.match(s, /single frame/)
  assert.match(s, /1 variant\b/)
})
