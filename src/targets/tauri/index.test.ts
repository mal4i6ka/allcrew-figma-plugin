import test from 'node:test'
import assert from 'node:assert/strict'
import type { EmitDjangoProjectOutput } from '../django/index.ts'
import type { IrContainerNode, IrNode } from '../django/ir.ts'
import { buildTauriExportTree, type TauriBuildInput } from './index.ts'
import { buildTauriScaffold } from './scaffold.ts'

function container(id: string, name: string, children: IrNode[] = [], extra: object = {}): IrContainerNode {
  return {
    id,
    name,
    type: 'container',
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'fixed', px: 100 }, height: { mode: 'fixed', px: 100 } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    children,
    layout: { mode: 'none' },
    component: null,
    ...extra,
  } as unknown as IrContainerNode
}

const BASE = [
  '{% load static %}',
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  `  <link rel="stylesheet" href="{% static 'css/tokens.css' %}">`,
  `  <link rel="stylesheet" href="{% static 'css/project.css' %}">`,
  '</head>',
  '<body>',
  '  {% block content %}{% endblock %}',
  '</body>',
  '</html>',
].join('\n')

function page(id: string, body: string): string {
  return [
    `{# GENERATED:BEGIN ${id} — edits outside this block survive regeneration #}`,
    '{% extends "base.html" %}',
    '{% load i18n %}',
    '{% load static %}',
    '{% block content %}',
    body,
    '{% endblock %}',
    `{# GENERATED:END ${id} #}`,
  ].join('\n')
}

function makeInput(overrides: Partial<TauriBuildInput> = {}): TauriBuildInput {
  const goBtn = container('1:5', 'Go', [], {
    navigate: { destinationId: 'p:2', transition: { style: 'SMART_ANIMATE', durationMs: 300, timingFunction: 'ease' } },
  })
  const home = container('p:1', 'Home', [goBtn])
  const settings = container('p:2', 'Settings')
  const project: EmitDjangoProjectOutput = {
    baseHtml: BASE,
    pages: {
      'pages/home--p-1.html': page('p:1', '    <div class="np-1"><a href="{{ navMap.nav_p_2 }}" style="display:contents">\n    <div class="n1-5"></div>\n    </a></div>'),
      'pages/settings--p-2.html': page('p:2', '    <div class="np-2">{% include "components/btn--c-1.html" with label="Back" only %}</div>'),
    },
    partials: {
      'components/btn--c-1.html': '{# GENERATED:BEGIN c:1 #}\n<button class="nc-1">{{ label }}</button>\n{# GENERATED:END c:1 #}',
    },
    css: '.np-1 { background: url(../img/bg.png); }',
    interactionsCss: '.n1-5:hover { opacity: 0.8; }',
    interactionsJs: '',
    themeCss: '',
    fileNodeIds: {
      'base.html': 'base.html',
      'pages/home--p-1.html': 'p:1',
      'pages/settings--p-2.html': 'p:2',
      'components/btn--c-1.html': 'c:1',
    },
  } as unknown as EmitDjangoProjectOutput

  return {
    project,
    pageRoots: [home, settings],
    cssFile: 'css/project.css',
    tokensCss: ':root { --x: 1; }',
    animation: { css: '', js: '' },
    motionTokensJs: null,
    assets: [{ filename: 'bg.png', content: new Uint8Array([1, 2, 3]) } as never],
    productName: 'My App',
    startPageId: 'p:1',
    window: { width: 1440, height: 900 },
    ...overrides,
  }
}

test('flow start page becomes index.html, others keep slug names, nav links resolve', () => {
  const { files, pageHrefs } = buildTauriExportTree(makeInput())
  assert.ok(files['src/index.html'])
  assert.ok(files['src/settings.html'])
  assert.deepEqual(pageHrefs, { 'p:1': 'index.html', 'p:2': 'settings.html' })

  const home = String(files['src/index.html'])
  assert.ok(home.includes('<a href="settings.html"'))
  assert.ok(!home.includes('{%'))
  assert.ok(!home.includes('{{'))
  assert.ok(home.includes('<link rel="stylesheet" href="assets/css/tokens.css">'))
  assert.ok(home.includes('<title>Home</title>'))
  assert.ok(home.includes('<meta charset="utf-8">'))
})

test('includes render inside pages; assets and css land under src/assets', () => {
  const { files } = buildTauriExportTree(makeInput())
  const settings = String(files['src/settings.html'])
  assert.ok(settings.includes('<button class="nc-1">Back</button>'))
  assert.equal(files['src/assets/css/project.css'], '.np-1 { background: url(../img/bg.png); }')
  assert.equal(files['src/assets/css/tokens.css'], ':root { --x: 1; }')
  assert.equal(files['src/assets/css/interactions.css'], '.n1-5:hover { opacity: 0.8; }')
  assert.ok(files['src/assets/img/bg.png'] instanceof Uint8Array)
})

test('smart-animate navigation emits transitions.css and links it from every page', () => {
  const { files } = buildTauriExportTree(makeInput())
  const css = String(files['src/assets/css/transitions.css'])
  assert.ok(css.includes('@view-transition'))
  assert.ok(css.includes('animation-duration: 300ms;'))
  assert.ok(String(files['src/index.html']).includes('assets/css/transitions.css'))
  assert.ok(String(files['src/settings.html']).includes('assets/css/transitions.css'))
})

test('scaffold ships the Tauri v2 vanilla shape', () => {
  const { files } = buildTauriExportTree(makeInput())
  const conf = JSON.parse(String(files['src-tauri/tauri.conf.json']))
  assert.equal(conf.build.frontendDist, '../src')
  assert.equal(conf.app.withGlobalTauri, true)
  assert.equal(conf.productName, 'My App')
  assert.equal(conf.identifier, 'com.figma-export.my-app')
  assert.deepEqual(conf.app.windows[0], {
    label: 'main',
    title: 'My App',
    width: 1440,
    height: 900,
    resizable: true,
  })
  assert.ok(String(files['src-tauri/Cargo.toml']).includes('name = "my_app"'))
  assert.ok(String(files['src-tauri/src/main.rs']).includes('my_app_lib::run()'))
  const caps = JSON.parse(String(files['src-tauri/capabilities/default.json']))
  assert.deepEqual(caps.windows, ['main'])
  assert.ok(String(files['README.md']).includes('npm run dev'))
  assert.ok(files['package.json'])
  assert.ok(files['src-tauri/build.rs'])
  assert.ok(files['src-tauri/src/lib.rs'])
})

test('no flow start point → first page is index.html', () => {
  const { pageHrefs } = buildTauriExportTree(makeInput({ startPageId: undefined }))
  assert.equal(pageHrefs['p:1'], 'index.html')
})

test('gsap vendor links rewrite to CDN and README notes it', () => {
  const base = BASE.replace(
    '</head>',
    `  <script src="{% static 'vendor/gsap/gsap.min.js' %}"></script>\n  <script src="{% static 'js/animations.js' %}" defer></script>\n</head>`
  )
  const input = makeInput({ animation: { css: '', js: 'gsap.to()' } })
  ;(input.project as { baseHtml: string }).baseHtml = base
  const { files } = buildTauriExportTree(input)
  const home = String(files['src/index.html'])
  assert.ok(home.includes('https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js'))
  assert.ok(home.includes('assets/js/animations.js'))
  assert.equal(files['src/assets/js/animations.js'], 'gsap.to()')
  assert.ok(String(files['README.md']).includes('jsdelivr'))
})

test('scaffold window size clamps tiny frames to a usable minimum', () => {
  const files = buildTauriScaffold({ productName: 'X', slug: 'x', window: { width: 20, height: 40 } })
  const conf = JSON.parse(files['src-tauri/tauri.conf.json'])
  assert.equal(conf.app.windows[0].width, 200)
  assert.equal(conf.app.windows[0].height, 200)
})
