/**
 * Accessibility/SEO semantic markup (docs items 1-4): landmarks, headings, real buttons/links,
 * and honest `alt` text — layered onto the default `<div>`/`<p>` rendering so a rule that doesn't
 * genuinely match keeps emitting byte-identical markup (golden fixtures pin the default path).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { emitHtml, isDecorativeLayerName, resolveHeadingTag, createHeadingState, resolveContainerTag, NO_LANDMARK_ANCESTRY } from './html-emitter.ts'
import { emitPage, emitComponentPartial, buildComponentRegistry } from './component-emitter.ts'
import type { IrContainerNode, IrImageNode, IrInteraction, IrTextNode, IrVectorNode } from './ir.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function container(id: string, name: string, children: IrContainerNode['children'] = []): IrContainerNode {
  return { ...makeBase(), id, name, type: 'container', component: null, layout: { kind: 'absolute' }, children } as IrContainerNode
}

function text(id: string, name: string, characters: string): IrTextNode {
  return { ...makeBase(), id, name, type: 'text', characters } as IrTextNode
}

function image(id: string, name: string, assetSrc: string): IrImageNode {
  return { ...makeBase(), id, name, type: 'image', imageHash: null, assetSrc } as IrImageNode
}

function vector(id: string, name: string, inlineSvg: string): IrVectorNode {
  return { ...makeBase(), id, name, type: 'vector', inlineSvg } as IrVectorNode
}

const CLICK_INTERACTION: IrInteraction = { trigger: 'ON_CLICK', destinationId: '9:9', durationMs: 0, timingFunction: 'linear' }

// --- item 1: landmarks -------------------------------------------------------------------------

test('emitHtml: a Header frame renders <header>, its nested "Header content" child stays a <div>', () => {
  const header = container('1:1', 'Header', [container('1:2', 'Header content', [])])
  const html = emitHtml([header], new Map(), 'css/site.css')
  assert.match(html, /<header class="n1-1">/)
  assert.match(html, /<\/header>/)
  assert.match(html, /<div class="n1-2"><\/div>/)
  assert.doesNotMatch(html, /<header class="n1-2"/)
})

test('emitHtml: Nav/Footer/Sidebar names map to <nav>/<footer>/<aside>, tolerant of a "/ Desktop" suffix', () => {
  const nodes = [
    container('2:1', 'Navigation / Desktop', []),
    container('2:2', 'Footer', []),
    container('2:3', 'Sidebar', []),
  ]
  const html = emitHtml(nodes, new Map(), 'css/site.css')
  assert.match(html, /<nav class="n2-1"><\/nav>/)
  assert.match(html, /<footer class="n2-2"><\/footer>/)
  assert.match(html, /<aside class="n2-3"><\/aside>/)
})

test('emitPage: a component-emitter Header frame also renders <header>, not a <div>', () => {
  const root: IrContainerNode = container('3:1', 'Landing', [container('3:2', 'Header', [text('3:3', 'Label', 'Hi')])])
  const registry = buildComponentRegistry([])
  const page = emitPage(root, new Map(), registry)
  assert.match(page, /<header class="n3-2">/)
})

test('emitHtml: a plain, unnamed container still emits exactly the golden <div class="n…"> markup', () => {
  const plain = container('4:1', 'Content Wrapper', [text('4:2', 'Label', 'Hello')])
  const html = emitHtml([plain], new Map(), 'css/site.css')
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>')).trim()
  assert.equal(body, '<div class="n4-1">\n      <p class="n4-2"><span class="n4-2--segment-0">{% translate "Hello" %}</span></p>\n    </div>')
})

// --- item 2: headings ---------------------------------------------------------------------------

test('emitHtml: an explicitly-named heading layer renders <hN> instead of <p>, same class/span markup', () => {
  const h2 = text('5:1', 'Heading 2', 'Section title')
  const html = emitHtml([h2], new Map(), 'css/site.css')
  assert.match(html, /<h2 class="n5-1"><span class="n5-1--segment-0">\{% translate "Section title" %\}<\/span><\/h2>/)
})

test('emitHtml: a second <h1> claimant degrades to <h2> — exactly one <h1> per page', () => {
  const first = text('6:1', 'H1', 'Primary title')
  const second = text('6:2', 'Title/H1', 'Duplicate title')
  const html = emitHtml([first, second], new Map(), 'css/site.css')
  assert.match(html, /<h1 class="n6-1">[^]*Primary title/)
  assert.match(html, /<h2 class="n6-2">[^]*Duplicate title/)
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, 'exactly one <h1> ships')
})

test('emitHtml: a layer name with no explicit level keeps <p> — never inferred from anything else', () => {
  const html = emitHtml([text('7:1', 'Big Label', 'Not a heading')], new Map(), 'css/site.css')
  assert.match(html, /<p class="n7-1">/)
})

test('resolveHeadingTag: "Title/H3" and "Heading 2" both resolve explicitly; a bare word does not', () => {
  const state = createHeadingState()
  assert.equal(resolveHeadingTag('Title/H3', state), 'h3')
  assert.equal(resolveHeadingTag('Heading 2', createHeadingState()), 'h2')
  assert.equal(resolveHeadingTag('Header', createHeadingState()), null)
  assert.equal(resolveHeadingTag('Title', createHeadingState()), null)
})

// --- item 3: real buttons/links -----------------------------------------------------------------

test('emitHtml: a click-interaction node renders <button type="button">, not a <div>', () => {
  const cta = { ...container('8:1', 'CTA', []), interactions: [CLICK_INTERACTION] } as IrContainerNode
  const html = emitHtml([cta], new Map(), 'css/site.css')
  assert.match(html, /<button type="button" class="n8-1"><\/button>/)
})

test('emitHtml: a navigate node stays wrapped in <a>, never becomes a <button>, even with a click interaction', () => {
  const link = {
    ...container('9:1', 'CTA', []),
    interactions: [CLICK_INTERACTION],
    navigate: { destinationId: '9:9' },
  } as IrContainerNode
  const navMap = new Map([['9:9', 'home']])
  const html = emitHtml([link], new Map(), 'css/site.css', navMap)
  assert.match(html, /<a href="\{\{ navMap\.home \}\}"/)
  assert.match(html, /<div class="n9-1"><\/div>/)
  assert.doesNotMatch(html, /<button/)
})

test('emitPage: a click-interaction node renders <button type="button"> through the multi-page fallback path too', () => {
  const root = container('10:1', 'Landing', [{ ...container('10:2', 'CTA', []), interactions: [CLICK_INTERACTION] } as IrContainerNode])
  const page = emitPage(root, new Map(), buildComponentRegistry([]))
  assert.match(page, /<button type="button" class="n10-2"><\/button>/)
})

test('emitComponentPartial: a click-interaction node renders <button type="button"> inside a partial too', () => {
  const cta = { ...container('11:1', 'CTA', []), interactions: [CLICK_INTERACTION] } as IrContainerNode
  const component: IrContainerNode = {
    ...container('11:0', 'Card', [cta]),
    component: { key: 'card', properties: [] },
  }
  const registry = buildComponentRegistry([component])
  const html = emitComponentPartial(component, new Map(), registry)
  assert.match(html, /<button class="n11-1" type="button"><\/button>/)
})

// --- item 4: honest alt text ---------------------------------------------------------------------

test('emitHtml: an auto-named "Rectangle 12" image gets alt="", a meaningful "Team photo" keeps its alt', () => {
  const html = emitHtml([image('12:1', 'Rectangle 12', 'img/decor.png'), image('12:2', 'Team photo', 'img/team.png')], new Map(), 'css/site.css')
  assert.match(html, /<img class="n12-1" src="\{% static 'img\/decor\.png' %\}" alt="">/)
  assert.match(html, /<img class="n12-2" src="\{% static 'img\/team\.png' %\}" alt="Team photo">/)
})

test('emitHtml: a decorative inline <svg> gets aria-hidden, a meaningfully-named one does not', () => {
  const html = emitHtml(
    [vector('13:1', 'Vector', '<svg viewBox="0 0 10 10"></svg>'), vector('13:2', 'Company logo', '<svg viewBox="0 0 10 10"></svg>')],
    new Map(),
    'css/site.css'
  )
  assert.match(html, /<svg class="n13-1" aria-hidden="true" viewBox="0 0 10 10"><\/svg>/)
  assert.match(html, /<svg class="n13-2" viewBox="0 0 10 10"><\/svg>/)
  assert.doesNotMatch(html.match(/<svg class="n13-2"[^>]*>/)![0], /aria-hidden/)
})

test('isDecorativeLayerName: auto-named shapes, punctuation-only, and underscore-prefixed names are decorative', () => {
  for (const name of ['Rectangle 12', 'Vector', 'Ellipse 3', 'Image 4', 'Frame 1', 'Group 7', '123', '---', '_ignore', '']) {
    assert.equal(isDecorativeLayerName(name), true, `"${name}" should be decorative`)
  }
  for (const name of ['Team photo', 'Company logo', 'Hero banner']) {
    assert.equal(isDecorativeLayerName(name), false, `"${name}" should keep its name`)
  }
})

// --- resolveContainerTag: precedence and ancestry dedup -----------------------------------------

test('resolveContainerTag: landmark wins over button; a same-kind landmark never nests inside itself', () => {
  const header = { ...container('14:1', 'Header', []), interactions: [CLICK_INTERACTION] } as IrContainerNode
  const resolved = resolveContainerTag(header, NO_LANDMARK_ANCESTRY, false)
  assert.equal(resolved.tag, 'header')

  const nestedHeader = container('14:2', 'Header', [])
  const nestedResolved = resolveContainerTag(nestedHeader, new Set(['header']), false)
  assert.equal(nestedResolved.tag, 'div')
})

test('resolveContainerTag: an unnamed, childful direct child of the page root becomes <section>; a leaf child does not', () => {
  const withChildren = container('15:1', 'Promo', [container('15:2', 'Inner', [])])
  assert.equal(resolveContainerTag(withChildren, NO_LANDMARK_ANCESTRY, true).tag, 'section')

  const leaf = container('15:3', 'Promo', [])
  assert.equal(resolveContainerTag(leaf, NO_LANDMARK_ANCESTRY, true).tag, 'div')

  assert.equal(resolveContainerTag(withChildren, NO_LANDMARK_ANCESTRY, false).tag, 'div', 'not eligible unless it is a page-root child')
})
