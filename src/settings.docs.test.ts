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

test('the old pair field migrates into editable theme rows', () => {
  const options = normalizeExportOptions({
    tokens: { collectionMerges: '  Theme = Semantic light + Semantic dark  ' },
  })
  assert.deepEqual(options.themeMerges, {
    groups: [{
      name: 'Theme',
      modes: [
        { collection: 'Semantic light', name: 'Light' },
        { collection: 'Semantic dark', name: 'Dark' },
      ],
    }],
  })
})

test('choosing a preset preserves file-specific theme rows', () => {
  const options = normalizeExportOptions({
    themeMerges: {
      groups: [{
        name: 'Theme',
        modes: [
          { collection: 'theme-light', name: 'Light' },
          { collection: 'theme-dark', name: 'Dark' },
          { collection: 'theme-contrast', name: 'High contrast' },
        ],
      }],
    },
  })
  assert.deepEqual(applyPreset(options, 'design-tokens').themeMerges, options.themeMerges)
})

test('choosing a preset does not reset the documentation settings', () => {
  // Like `lint` and `delivery`: a team's docs policy is theirs, not part of a package preset.
  const options = normalizeExportOptions({
    docs: { componentDocs: false, componentPreviews: true, previewBudgetMb: 32 },
  })
  const applied = applyPreset(options, 'design-tokens')
  assert.deepEqual(applied.docs, { componentDocs: false, componentPreviews: true, previewBudgetMb: 32 })
})

test('browser UI mirroring is explicit, normalized and preserved across presets', () => {
  const defaults = normalizeExportOptions({})
  assert.equal(defaults.agent.uiMirror, false)
  assert.equal(normalizeExportOptions({ agent: { uiMirror: 'yes' } }).agent.uiMirror, false)

  const enabled = normalizeExportOptions({
    agent: {
      endpoint: 'http://127.0.0.1:8788',
      secret: 'paired',
      read: false,
      write: false,
      uiMirror: true,
    },
  })
  assert.equal(enabled.agent.uiMirror, true)
  assert.equal(applyPreset(enabled, 'design-tokens').agent.uiMirror, true)
})
