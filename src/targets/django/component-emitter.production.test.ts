import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildComponentRegistry,
  collectComponents,
  emitBaseHtml,
  emitComponentPartial,
  partialPath,
  renderOverlayFragment,
} from './component-emitter.ts'
import type { IrContainerNode, IrTextNode } from './ir.ts'
import type { DjangoNodeSource } from './css-emitter.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

// --- emitBaseHtml: production document skeleton -----------------------------------------------

test('emitBaseHtml emits a production skeleton: charset/viewport first, lang/dir, title/description blocks, skip link + main landmark', () => {
  const html = emitBaseHtml('css/project.css')

  const headStart = html.indexOf('<head>')
  const charsetIndex = html.indexOf('<meta charset="utf-8">')
  const viewportIndex = html.indexOf('name="viewport"')
  assert.ok(charsetIndex > headStart && charsetIndex < viewportIndex, 'charset comes right after <head>, before viewport')
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  assert.match(html, /<html lang="\{\{ LANGUAGE_CODE\|default:'en' \}\}"\{% if LANGUAGE_BIDI %\} dir="rtl"\{% endif %\}>/)
  assert.match(html, /<title>\{% block title %\}\{\{ page_title\|default:'' \}\}\{% endblock %\}<\/title>/)
  assert.match(html, /<meta name="description" content="\{% block meta_description %\}\{\{ page_description\|default:'' \}\}\{% endblock %\}">/)
  assert.match(html, /\{% block head_meta %\}\{% endblock %\}/)
  assert.match(html, /\{% block extra_head %\}\{% endblock %\}\n<\/head>/)
  assert.match(html, /\{% block body_end %\}\{% endblock %\}\n<\/body>/)

  const bodyStart = html.indexOf('<body>')
  const bodyChildren = html.slice(bodyStart).split('\n')
  assert.equal(bodyChildren[1].trim(), '<a class="skip-to-content" href="#content">Skip to content</a>')
  assert.match(html, /<main id="content">\n\s*\{% block content %\}\{% endblock %\}\n\s*<\/main>/)
})

test('emitBaseHtml shell options: transitions links only when requested, language switcher wires {% load i18n %} + the include', () => {
  const bare = emitBaseHtml('css/project.css')
  assert.doesNotMatch(bare, /transitions\.css/)
  assert.doesNotMatch(bare, /transitions\.js/)
  assert.doesNotMatch(bare, /language-switcher/)
  assert.doesNotMatch(bare, /\{% load i18n %\}/)

  const shelled = emitBaseHtml(
    'css/project.css',
    null,
    [],
    { interactionsCss: true, interactionsJs: false },
    null,
    { transitionsCss: true, transitionsJs: true, languageSwitcher: true }
  )
  assert.match(shelled, /<link rel="stylesheet" href="\{% static 'css\/interactions\.css' %\}">\n\s*<link rel="stylesheet" href="\{% static 'css\/transitions\.css' %\}">/)
  assert.match(shelled, /<script src="\{% static 'js\/transitions\.js' %\}" defer><\/script>/)
  assert.match(shelled, /\{% load static %\}\n\{% load i18n %\}/)
  assert.match(shelled, /\{% block language_switcher %\}\{% include 'partials\/language-switcher\.html' %\}\{% endblock %\}/)

  // The skip link still leads — a language switcher must never precede it (a11y: skip-link is
  // always the very first stop for keyboard/screen-reader navigation).
  const skipIndex = shelled.indexOf('skip-to-content')
  const switcherIndex = shelled.indexOf('language_switcher')
  assert.ok(skipIndex > 0 && skipIndex < switcherIndex)
})

// --- component-set variant collapsing ------------------------------------------------------

function buttonVariant(id: string, name: string, key: string, label: string): IrContainerNode {
  const text: IrTextNode = {
    ...makeBase(),
    id: `${id};label`,
    name: 'Label',
    type: 'text',
    characters: label,
  }
  return {
    ...makeBase(),
    id,
    name,
    type: 'container',
    layout: { kind: 'absolute' },
    component: {
      key,
      setName: 'Button',
      properties: [{ name: 'Size', type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] }],
    },
    children: [text],
  }
}

test('collectComponents collapses a structurally-uniform component set into ONE shared partial path, keyed by the set name', () => {
  const lg = buttonVariant('50:1', 'Size=lg', 'k-lg', 'LG LABEL')
  const md = buttonVariant('50:2', 'Size=md', 'k-md', 'MD LABEL') // matches the declared default ('md')

  const collected = collectComponents([lg, md])
  assert.equal(collected.length, 2, 'both variants still flow through buildComponentRegistry')

  const paths = collected.map((component) => partialPath(component))
  assert.equal(paths[0], 'components/button.html')
  assert.equal(paths[1], 'components/button.html')

  const registry = buildComponentRegistry(collected)
  assert.equal(registry.pathByComponentKey.get('k-lg'), 'components/button.html')
  assert.equal(registry.pathByComponentKey.get('k-md'), 'components/button.html')

  // Simulates emitDjangoProject's per-component loop (index.ts): each collected member renders
  // and gets written to the SAME path key, so whichever is processed LAST wins. The default
  // variant must be last, or the shared partial would carry an arbitrary non-default body.
  const partials: Record<string, string> = {}
  for (const component of collected) {
    partials[partialPath(component)] = emitComponentPartial(component, new Map(), registry)
  }
  assert.match(partials['components/button.html'], /MD LABEL/)
  assert.doesNotMatch(partials['components/button.html'], /LG LABEL/)
  // The collapsed partial's root still carries the variant modifier class — its CSS delta is
  // css-emitter's job, but the class must be there for that CSS to ever match anything.
  assert.match(partials['components/button.html'], /n50-2--\{\{ size\|default:'md' \}\}/)
})

test('collectComponents keeps a structurally divergent component set uncollapsed (per-variant fallback)', () => {
  const withIcon = buttonVariant('51:1', 'Size=lg', 'k2-lg', 'LG LABEL')
  const plain: IrContainerNode = { ...buttonVariant('51:2', 'Size=md', 'k2-md', 'MD LABEL'), children: [] } // no text child — different shape

  const collected = collectComponents([withIcon, plain])
  const paths = collected.map((component) => partialPath(component))
  assert.notEqual(paths[0], paths[1], 'structurally divergent variants keep their own distinct partial paths')
})

test('collectComponents leaves a standalone (non-set) component completely unaffected', () => {
  const card: IrContainerNode = {
    ...makeBase(),
    id: '52:1',
    name: 'Card',
    type: 'container',
    layout: { kind: 'absolute' },
    component: { key: 'card-key', properties: [] },
    children: [],
  }
  const collected = collectComponents([card])
  assert.equal(collected.length, 1)
  assert.equal(partialPath(collected[0]), 'components/card--52-1.html')
})

// --- renderOverlayFragment -------------------------------------------------------------------

test('renderOverlayFragment renders markup with no {% extends %}/{% block %} template-inheritance tags', () => {
  const overlay: IrContainerNode = {
    ...makeBase(),
    id: '60:1',
    name: 'Tooltip',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [
      { ...makeBase(), id: '60:2', name: 'Text', type: 'text', characters: 'Hello' } as IrTextNode,
    ],
  }
  const sceneNodesById = new Map<string, DjangoNodeSource>()
  const fragment = renderOverlayFragment(overlay, sceneNodesById, { pathByComponentKey: new Map(), nodeByComponentId: new Map() }, new Map(), false)

  assert.doesNotMatch(fragment, /\{% extends/)
  assert.doesNotMatch(fragment, /\{% block/)
  assert.match(fragment, /<div class="n60-1">/)
})
