import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPreset, derivePresetId, EXPORT_PRESETS, normalizeExportOptions, DEFAULT_EXPORT_OPTIONS } from '../../settings.ts'

test('tauri-app is a built-in preset with the tauri platform', () => {
  const preset = EXPORT_PRESETS.find((entry) => entry.id === 'tauri-app')
  assert.ok(preset)
  assert.equal(preset.label, 'Tauri app')
  assert.equal(preset.values.target, 'django')
  assert.equal(preset.values.targetOptions.platform, 'tauri')
  assert.equal(preset.values.targetOptions.framework, 'none')
  assert.deepEqual(preset.values.modules, { tokens: true, templates: true, i18n: false, animation: true })
})

test('applying the preset round-trips through derivePresetId', () => {
  const applied = applyPreset(DEFAULT_EXPORT_OPTIONS, 'tauri-app')
  assert.equal(applied.targetOptions.platform, 'tauri')
  assert.equal(derivePresetId(applied), 'tauri-app')
})

test('normalize keeps the tauri platform and rejects unknown platforms', () => {
  const normalized = normalizeExportOptions({ targetOptions: { platform: 'tauri' } })
  assert.equal(normalized.targetOptions.platform, 'tauri')
  const bogus = normalizeExportOptions({ targetOptions: { platform: 'electron' } })
  assert.equal(bogus.targetOptions.platform, 'django')
})
