import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DOCS, applyPreset, normalizeExportOptions } from './settings.ts'

test('documentation defaults: contracts on, previews opt-in', () => {
  const options = normalizeExportOptions({})
  assert.deepEqual(options.docs, DEFAULT_DOCS)
  assert.equal(options.docs.componentDocs, true)
  assert.equal(options.docs.componentPreviews, false)
  assert.equal(options.docs.previewBudgetMb, 8)
})

test('the preview budget is clamped to something a repository can hold', () => {
  assert.equal(normalizeExportOptions({ docs: { previewBudgetMb: 0 } }).docs.previewBudgetMb, 1)
  assert.equal(normalizeExportOptions({ docs: { previewBudgetMb: 9999 } }).docs.previewBudgetMb, 512)
  assert.equal(normalizeExportOptions({ docs: { previewBudgetMb: 12.4 } }).docs.previewBudgetMb, 12)
  // Junk falls back instead of disabling the capture with a NaN budget.
  assert.equal(normalizeExportOptions({ docs: { previewBudgetMb: 'lots' } }).docs.previewBudgetMb, 8)
})

test('choosing a preset does not reset the documentation settings', () => {
  // Like `lint` and `delivery`: a team's docs policy is theirs, not part of a package preset.
  const options = normalizeExportOptions({
    docs: { componentDocs: false, componentPreviews: true, previewBudgetMb: 32 },
  })
  const applied = applyPreset(options, 'design-tokens')
  assert.deepEqual(applied.docs, { componentDocs: false, componentPreviews: true, previewBudgetMb: 32 })
})
