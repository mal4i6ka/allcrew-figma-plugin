import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportReport } from './report.ts'

test('buildExportReport serializes exportedBy/activeUserCount and the scope/modules used', () => {
  const json = buildExportReport({
    exportedAt: '2026-07-09T00:00:00.000Z',
    exportedBy: 'Alexander',
    activeUserCount: 3,
    scope: { mode: 'frame', frameId: '1:23' },
    modules: { tokens: true, templates: true, i18n: false, animation: false },
    fileCount: 12,
  })

  const parsed = JSON.parse(json)
  assert.equal(parsed.exportedBy, 'Alexander')
  assert.equal(parsed.activeUserCount, 3)
  assert.deepEqual(parsed.scope, { mode: 'frame', frameId: '1:23' })
  assert.equal(parsed.fileCount, 12)
})

test('buildExportReport passes an "unknown" exportedBy through unchanged (defaulting is the caller\'s job)', () => {
  const json = buildExportReport({
    exportedAt: '2026-07-09T00:00:00.000Z',
    exportedBy: 'unknown',
    activeUserCount: 0,
    scope: { mode: 'page' },
    modules: { tokens: false, templates: false, i18n: false, animation: false },
    fileCount: 0,
  })

  assert.equal(JSON.parse(json).exportedBy, 'unknown')
})

test('buildExportReport lists manualAssets when provided and omits the key entirely when absent', () => {
  const base = {
    exportedAt: '2026-07-10T00:00:00.000Z',
    exportedBy: 'Alexander',
    activeUserCount: 1,
    scope: { mode: 'page' as const },
    modules: { tokens: true, templates: true, i18n: false, animation: false },
    fileCount: 3,
  }

  const withManual = JSON.parse(buildExportReport({ ...base, manualAssets: ['img/1336-99854-banner.mp4'] }))
  assert.deepEqual(withManual.manualAssets, ['img/1336-99854-banner.mp4'])

  const without = JSON.parse(buildExportReport(base))
  assert.ok(!('manualAssets' in without), 'no empty manualAssets key on clean exports')
})
