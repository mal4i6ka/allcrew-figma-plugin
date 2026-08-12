import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeExportOptions,
  mergeExportOptions,
  derivePresetId,
  applyPreset,
  resolveThemeAttribute,
  normalizeUserPresets,
  upsertUserPreset,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_PRESETS,
} from './options.ts'

test('normalizeExportOptions returns the defaults when clientStorage has nothing stored yet', () => {
  assert.deepEqual(normalizeExportOptions(undefined), DEFAULT_EXPORT_OPTIONS)
})

test('the defaults ARE the "Django × Bootstrap" preset — first run shows a preset, not Custom', () => {
  assert.equal(derivePresetId(DEFAULT_EXPORT_OPTIONS), 'django-bootstrap')
})

test('normalizeExportOptions passes through a fully-valid stored value', () => {
  const stored = {
    scopeMode: 'selection',
    modules: { tokens: true, templates: false, i18n: false, animation: false },
    target: {
      platform: 'django',
      framework: 'bootstrap',
      bootstrapFidelity: 'utilities',
      bootstrapSource: 'cdn',
      bootstrapVersion: '5.3.3',
    },
    tokens: { inlinePrimitives: false, flattenAliases: false, themeAttribute: 'data-mode', emitJson: true, emitScss: true },
    i18n: { wrapTranslate: false, sourceLanguage: 'de' },
    delivery: { endpoint: 'http://localhost:8765', secret: 's3cret', onExport: true },
    lint: { maxNestingDepth: 12 },
  }
  assert.deepEqual(normalizeExportOptions(stored), stored)
})

test('normalizeExportOptions falls back to defaults for an invalid scopeMode', () => {
  const result = normalizeExportOptions({ scopeMode: 'not-a-mode', modules: DEFAULT_EXPORT_OPTIONS.modules })
  assert.equal(result.scopeMode, 'page')
})

test('a pre-REFORM {scopeMode, modules} shape reads cleanly with the new groups defaulted', () => {
  const result = normalizeExportOptions({ scopeMode: 'frame', modules: { tokens: false } })
  assert.equal(result.scopeMode, 'frame')
  assert.deepEqual(result.modules, { tokens: false, templates: true, i18n: true, animation: true })
  assert.deepEqual(result.target, DEFAULT_EXPORT_OPTIONS.target)
  assert.deepEqual(result.tokens, DEFAULT_EXPORT_OPTIONS.tokens)
  assert.deepEqual(result.i18n, DEFAULT_EXPORT_OPTIONS.i18n)
  assert.deepEqual(result.delivery, { endpoint: '', secret: '', onExport: false })
})

test('normalizeExportOptions handles a stale non-object shape from an older plugin version', () => {
  assert.deepEqual(normalizeExportOptions('css/project.css'), DEFAULT_EXPORT_OPTIONS)
  assert.deepEqual(normalizeExportOptions(null), DEFAULT_EXPORT_OPTIONS)
})

test('unknown enum values in target fall back individually, not by discarding the group', () => {
  const result = normalizeExportOptions({
    target: { framework: 'tailwind', bootstrapFidelity: 'full', bootstrapSource: 'npm', bootstrapVersion: '   ' },
  })
  assert.deepEqual(result.target, DEFAULT_EXPORT_OPTIONS.target)
})

test('every built-in preset round-trips: apply → derive returns its id', () => {
  for (const preset of EXPORT_PRESETS) {
    const applied = applyPreset(DEFAULT_EXPORT_OPTIONS, preset.id)
    assert.equal(derivePresetId(applied), preset.id)
  }
})

test('a manual deviation from a preset derives as custom', () => {
  const applied = applyPreset(DEFAULT_EXPORT_OPTIONS, 'bootstrap-tokens')
  applied.tokens.flattenAliases = true
  assert.equal(derivePresetId(applied), 'custom')
})

test('scopeMode is not package-forming: it neither affects derivation nor is touched by applyPreset', () => {
  const scoped = normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, scopeMode: 'selection' })
  assert.equal(derivePresetId(scoped), 'django-bootstrap')
  assert.equal(applyPreset(scoped, 'design-tokens').scopeMode, 'selection')
})

test('applyPreset returns fresh objects — mutating the result cannot corrupt the definitions', () => {
  const first = applyPreset(DEFAULT_EXPORT_OPTIONS, 'design-tokens')
  first.modules.tokens = false
  first.target.framework = 'bootstrap'
  const second = applyPreset(DEFAULT_EXPORT_OPTIONS, 'design-tokens')
  assert.equal(second.modules.tokens, true)
  assert.equal(second.target.framework, 'none')
})

test('resolveThemeAttribute: auto follows the framework, an explicit attribute wins', () => {
  assert.equal(resolveThemeAttribute(DEFAULT_EXPORT_OPTIONS), 'data-bs-theme')
  assert.equal(resolveThemeAttribute(applyPreset(DEFAULT_EXPORT_OPTIONS, 'design-tokens')), 'data-theme')
  const explicit = normalizeExportOptions({ tokens: { themeAttribute: 'data-mode' } })
  assert.equal(resolveThemeAttribute(explicit), 'data-mode')
})

test('mergeExportOptions: a pre-REFORM partial save must not reset the new groups', () => {
  const stored = applyPreset(DEFAULT_EXPORT_OPTIONS, 'bootstrap-tokens')
  const merged = mergeExportOptions(stored, {
    scopeMode: 'selection',
    modules: { tokens: true, templates: true, i18n: true, animation: true },
  })
  assert.equal(merged.scopeMode, 'selection') // replaced by the incoming payload
  assert.equal(merged.modules.templates, true) // replaced by the incoming payload
  assert.equal(merged.target.bootstrapFidelity, 'tokens') // survived from the stored value
})

test('mergeExportOptions tolerates garbage on either side', () => {
  assert.deepEqual(mergeExportOptions(undefined, undefined), DEFAULT_EXPORT_OPTIONS)
  assert.deepEqual(mergeExportOptions('stale', null), DEFAULT_EXPORT_OPTIONS)
})

test('delivery is machine-specific: it never affects preset derivation and survives applyPreset', () => {
  const options = normalizeExportOptions({
    ...DEFAULT_EXPORT_OPTIONS,
    delivery: { endpoint: 'http://localhost:8765', secret: 's3cret', onExport: true },
  })
  assert.equal(derivePresetId(options), 'django-bootstrap') // delivery deviation ≠ Custom

  const applied = applyPreset(options, 'design-tokens')
  assert.deepEqual(applied.delivery, { endpoint: 'http://localhost:8765', secret: 's3cret', onExport: true })
  assert.equal(derivePresetId(applied), 'design-tokens')
})

test('normalizeUserPresets drops garbage, built-in-colliding ids and duplicate ids', () => {
  assert.deepEqual(normalizeUserPresets(undefined), [])
  assert.deepEqual(normalizeUserPresets('junk'), [])
  const presets = normalizeUserPresets([
    { id: 'user-mine', label: 'Mine', values: {} },
    { id: 'django-bootstrap', label: 'Impostor', values: {} }, // shadows a built-in → dropped
    { label: '   ', values: {} }, // unusable label → dropped
    { id: 'user-mine', label: 'Duplicate', values: {} }, // duplicate id → first wins
    { label: 'No id but fine', values: {} }, // id derived from the label
  ])
  assert.deepEqual(presets.map((preset) => preset.id), ['user-mine', 'user-no-id-but-fine'])
  assert.deepEqual(presets[0].values.target, DEFAULT_EXPORT_OPTIONS.target) // normalized fallbacks
})

test('upsertUserPreset: id from the label slug; saving the same name REPLACES, not merges', () => {
  const first = upsertUserPreset([], 'My Landing Kit', { target: { framework: 'none' } })
  assert.equal(first.length, 1)
  assert.equal(first[0].id, 'user-my-landing-kit')
  assert.equal(first[0].values.target.framework, 'none')
  assert.equal(first[0].values.target.platform, 'django') // missing fields normalized to defaults

  const updated = upsertUserPreset(first, 'My Landing Kit', { tokens: { emitScss: true } })
  assert.equal(updated.length, 1)
  assert.equal(updated[0].values.tokens.emitScss, true)
  assert.equal(updated[0].values.target.framework, 'bootstrap') // full replace — framework reset
})

test('user presets participate in derive/apply; a built-in always wins on identical values', () => {
  const saved = upsertUserPreset([], 'Kit', {
    modules: { tokens: true, templates: false, i18n: true, animation: false },
  })
  const applied = applyPreset(DEFAULT_EXPORT_OPTIONS, 'user-kit', saved)
  assert.equal(derivePresetId(applied, saved), 'user-kit')
  assert.equal(applied.scopeMode, 'page') // scope and delivery stay out of presets
  assert.deepEqual(applied.delivery, DEFAULT_EXPORT_OPTIONS.delivery)

  const dupe = upsertUserPreset([], 'Copy of default', {
    modules: DEFAULT_EXPORT_OPTIONS.modules,
    target: DEFAULT_EXPORT_OPTIONS.target,
    tokens: DEFAULT_EXPORT_OPTIONS.tokens,
    i18n: DEFAULT_EXPORT_OPTIONS.i18n,
  })
  assert.equal(derivePresetId(DEFAULT_EXPORT_OPTIONS, dupe), 'django-bootstrap')
})
