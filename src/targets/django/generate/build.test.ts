import test from 'node:test'
import assert from 'node:assert/strict'
import { gridPositions, bootstrapVarForVariantValue, variantFillTokenPath, buildReport } from './build.ts'
import { planKit } from './plan.ts'
import { BOOTSTRAP_SPECS } from '../bootstrap/specs.ts'

test('gridPositions lays out row-major with the given columns and gap', () => {
  const cells = gridPositions(5, 2, 100, 40, 10)
  assert.deepEqual(cells[0], { x: 0, y: 0 })
  assert.deepEqual(cells[1], { x: 110, y: 0 })
  assert.deepEqual(cells[2], { x: 0, y: 50 }) // wraps to row 2
  assert.deepEqual(cells[4], { x: 0, y: 100 })
  assert.equal(gridPositions(3, 0, 100, 40, 10).length, 3) // columns clamped to ≥1
})

test('bootstrapVarForVariantValue maps role colors only', () => {
  assert.equal(bootstrapVarForVariantValue('Primary'), '--bs-primary')
  assert.equal(bootstrapVarForVariantValue('danger'), '--bs-danger')
  assert.equal(bootstrapVarForVariantValue('sm'), null) // a size, not a role
  assert.equal(bootstrapVarForVariantValue('hover'), null) // a state
})

test('variantFillTokenPath binds a variant value to the matching token, else null', () => {
  const paths = ['color.primary', 'color.danger', 'spacing.md']
  assert.equal(variantFillTokenPath('Primary', paths), 'color.primary')
  assert.equal(variantFillTokenPath('Danger', paths), 'color.danger')
  assert.equal(variantFillTokenPath('Success', paths), null) // no success token in the file
  assert.equal(variantFillTokenPath('sm', paths), null) // not a role color
})

test('variantFillTokenPath honors the candidate priority order (accent as a primary fallback)', () => {
  assert.equal(variantFillTokenPath('Primary', ['accent']), 'accent') // accent is a --bs-primary candidate
  assert.equal(variantFillTokenPath('Primary', ['brand.primary']), 'brand.primary')
})

test('buildReport rolls up components, variants, and binding outcomes', () => {
  const plans = planKit(BOOTSTRAP_SPECS)
  const report = buildReport(plans, 42)
  assert.equal(report.components, BOOTSTRAP_SPECS.length)
  assert.ok(report.variants > 108)
  assert.equal(report.bound, 42)
  assert.equal(report.unbound, report.variants - 42)
})
