import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportReport, collectSpringReport, summarizeEmitterNotes, collectFlattenedPages, buildFigmaFileReference } from './report.ts'
import type { IrContainerNode, IrNode } from '../ir.ts'

/** The two IR fields the collector reads, on a container with one child — nothing else matters. */
function tree(children: readonly Partial<IrNode>[]): IrContainerNode {
  const base = {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
  return {
    ...base,
    id: '1:1',
    name: 'Root',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: children.map((child, index) => ({
      ...base,
      id: `1:${index + 2}`,
      name: `Child ${index}`,
      type: 'container' as const,
      layout: { kind: 'absolute' as const },
      component: null,
      children: [],
      ...child,
    })) as IrNode[],
  }
}

test('collectSpringReport names the presets whose curves came from the estimated table', () => {
  const nodes = [
    tree([
      { interactions: [{ trigger: 'ON_HOVER', destinationId: '9:1', durationMs: 150, timingFunction: 'linear(0, 1)', springSource: 'preset-table', springPreset: 'BOUNCY' }] },
      { interactions: [{ trigger: 'ON_PRESS', destinationId: '9:2', durationMs: 150, timingFunction: 'linear(0, 1)', springSource: 'preset-table', springPreset: 'BOUNCY' }] },
      // A spring solved from real physics is not an estimate and must not be counted.
      { interactions: [{ trigger: 'ON_HOVER', destinationId: '9:3', durationMs: 200, timingFunction: 'linear(0, 1)', springSource: 'physical' }] },
    ]),
  ]

  const report = collectSpringReport(nodes)

  assert.deepEqual(report.estimatedSpringPresets, { BOUNCY: 2 })
  assert.ok(!('springPresetCalibration' in report), 'nothing measurable in this file')
})

test('collectSpringReport averages preset observations and flags a table that is off', () => {
  const nodes = [
    tree([
      {
        navigate: {
          destinationId: '2:1',
          transition: {
            style: 'SMART_ANIMATE',
            durationMs: 300,
            timingFunction: 'linear(0, 1)',
            springSource: 'physical',
            springPreset: 'GENTLE',
            springObservation: { preset: 'GENTLE', observedBounce: 0.3, tableBounce: 0 },
          },
        },
      },
      {
        interactions: [
          {
            trigger: 'ON_HOVER',
            destinationId: '9:1',
            durationMs: 300,
            timingFunction: 'linear(0, 1)',
            springSource: 'physical',
            springPreset: 'GENTLE',
            springObservation: { preset: 'GENTLE', observedBounce: 0.32, tableBounce: 0 },
          },
        ],
      },
    ]),
  ]

  const report = collectSpringReport(nodes)

  assert.deepEqual(report.springPresetCalibration, {
    GENTLE: { observedBounce: 0.31, tableBounce: 0, delta: 0.31, matches: false, samples: 2 },
  })
  assert.ok(!('estimatedSpringPresets' in report), 'these curves used the observed physics, not the table')
})

test('collectSpringReport says nothing about an export with no springs', () => {
  assert.deepEqual(collectSpringReport([tree([{}])]), {})
})

test('summarizeEmitterNotes groups what the CSS pass could not draw, deduped and sorted', () => {
  const summary = summarizeEmitterNotes([
    { type: 'unsupported-fill', node: '4:12', fill: 'SHADER' },
    { type: 'unsupported-fill', node: '4:12', fill: 'SHADER' },
    { type: 'unsupported-fill', node: '2:3', fill: 'SHADER' },
    { type: 'unsupported-effect', node: '9:1', effect: 'NOISE' },
    { type: 'squircle-approx', node: '1:1', smoothing: 0.6 },
  ])

  assert.deepEqual(summary, {
    'squircle-approx': { 'smoothing-0.6': ['1:1'] },
    'unsupported-effect': { NOISE: ['9:1'] },
    'unsupported-fill': { SHADER: ['2:3', '4:12'] },
  })
  assert.equal(summarizeEmitterNotes([]), undefined, 'a clean export says nothing')
})

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

test('collectFlattenedPages flags a page whose content block is one image and nothing else', () => {
  const pages = {
    'pages/hero--4008-55353.html': [
      '{% extends "base.html" %}',
      '{% load static %}',
      '{% block content %}',
      `    <img class="n4008-55353" src="{% static 'img/4008-55353-img-hero.png' %}" alt="Hero">`,
      '{% endblock %}',
    ].join('\n'),
  }
  const fileNodeIds = { 'pages/hero--4008-55353.html': '4008:55353' }

  assert.deepEqual(collectFlattenedPages(pages, fileNodeIds), [
    { templatePath: 'pages/hero--4008-55353.html', nodeId: '4008:55353', asset: 'img/4008-55353-img-hero.png' },
  ])
})

test('collectFlattenedPages flags a flattened page even when a NAVIGATE reaction wraps it in an anchor', () => {
  const pages = {
    'pages/logo--1-2.html': [
      '{% block content %}',
      '    <a href="{{ navMap.nav_3_4 }}" style="display:contents">',
      `      <img class="n1-2" src="{% static 'img/1-2-logo.svg' %}" alt="">`,
      '    </a>',
      '{% endblock %}',
    ].join('\n'),
  }
  assert.deepEqual(collectFlattenedPages(pages, { 'pages/logo--1-2.html': '1:2' }), [
    { templatePath: 'pages/logo--1-2.html', nodeId: '1:2', asset: 'img/1-2-logo.svg' },
  ])
})

test('collectFlattenedPages does not flag a page whose image sits inside real markup', () => {
  const pages = {
    'pages/about--9-1.html': [
      '{% block content %}',
      '    <div class="n9-1">',
      '      <h1 class="n9-2">{% translate "About us" %}</h1>',
      `      <img class="n9-3" src="{% static 'img/9-3-photo.png' %}" alt="Photo">`,
      '    </div>',
      '{% endblock %}',
    ].join('\n'),
  }
  assert.deepEqual(collectFlattenedPages(pages, { 'pages/about--9-1.html': '9:1' }), [])
})

test('collectFlattenedPages says nothing about an export with no pages', () => {
  assert.deepEqual(collectFlattenedPages({}, {}), [])
})

test('buildFigmaFileReference builds a design URL per template with : replaced by - in the node id', () => {
  const reference = buildFigmaFileReference({
    key: 'AbC123',
    name: 'AllCrew Figma Workspace',
    fileNodeIds: {
      'pages/home--1-2.html': '1:2',
      'components/button--I4357-109443-823-99714.html': 'I4357:109443;823:99714',
      'base.html': 'base.html',
    },
  })

  assert.equal(reference.key, 'AbC123')
  assert.equal(reference.name, 'AllCrew Figma Workspace')
  assert.deepEqual(reference.pageUrls, {
    'pages/home--1-2.html': 'https://www.figma.com/design/AbC123/AllCrew-Figma-Workspace?node-id=1-2',
    'components/button--I4357-109443-823-99714.html':
      'https://www.figma.com/design/AbC123/AllCrew-Figma-Workspace?node-id=I4357-109443-823-99714',
  })
  assert.ok(!('base.html' in reference.pageUrls), 'the synthetic base.html marker has no real Figma node to link to')
})

test('buildFigmaFileReference degrades to name-only with no URLs when the file key is withheld', () => {
  const reference = buildFigmaFileReference({
    key: null,
    name: 'AllCrew Figma Workspace',
    fileNodeIds: { 'pages/home--1-2.html': '1:2' },
  })

  assert.deepEqual(reference, { key: null, name: 'AllCrew Figma Workspace', pageUrls: {} })
})
