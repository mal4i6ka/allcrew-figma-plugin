import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBootstrapUtilities, declarationUtilities } from './utilities.ts'
import { emitDjangoProject } from '../../django/index.ts'
import type { IrContainerNode, IrTextNode } from '../../ir.ts'

test('declarationUtilities: exact-scale hits map, everything else returns null', () => {
  assert.deepEqual(declarationUtilities('display', 'flex'), ['d-flex'])
  assert.deepEqual(declarationUtilities('flex-direction', 'column'), ['flex-column'])
  assert.deepEqual(declarationUtilities('justify-content', 'space-between'), ['justify-content-between'])
  assert.deepEqual(declarationUtilities('gap', '16px'), ['gap-3'])
  assert.deepEqual(declarationUtilities('gap', '8px 16px'), ['row-gap-2', 'column-gap-3'])
  assert.deepEqual(declarationUtilities('padding', '24px 24px 24px 24px'), ['p-4'])
  assert.deepEqual(declarationUtilities('padding', '8px 16px 8px 16px'), ['py-2', 'px-3'])
  assert.deepEqual(declarationUtilities('padding', '0px 16px 8px 4px'), ['pt-0', 'pe-3', 'pb-2', 'ps-1'])
  assert.deepEqual(declarationUtilities('width', '100%'), ['w-100'])
  assert.deepEqual(declarationUtilities('font-weight', '700'), ['fw-bold'])
  assert.deepEqual(declarationUtilities('text-align', 'center'), ['text-center'])

  assert.equal(declarationUtilities('gap', '12px'), null) // off the Bootstrap scale
  assert.equal(declarationUtilities('padding', '24px 24px 12px 24px'), null) // one side off — all-or-nothing
  assert.equal(declarationUtilities('margin', '-8px'), null) // no negative-margin scale
  assert.equal(declarationUtilities('text-align', 'left'), null) // logical start/end flips under RTL
  assert.equal(declarationUtilities('border-radius', '6px'), null) // rounded-* resolves to theme vars
  assert.equal(declarationUtilities('background', 'red'), null)
})

const HERO_CSS = `*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 24px 24px 24px;
  background: red;
}

.title {
  font-weight: 700;
  text-align: center;
}`

function heroInput(overrides: Partial<Parameters<typeof applyBootstrapUtilities>[0]> = {}) {
  return {
    css: HERO_CSS,
    pages: { 'pages/home.html': '<div class="hero">\n  <p class="title">Hi</p>\n</div>' },
    partials: {},
    ...overrides,
  }
}

test('exact-scale declarations move onto utility classes; off-scale and visual CSS stays', () => {
  const result = applyBootstrapUtilities(heroInput())

  assert.deepEqual(result.utilities.get('hero'), ['d-flex', 'flex-column', 'gap-3', 'p-4'])
  assert.match(result.pages['pages/home.html'], /class="hero d-flex flex-column gap-3 p-4"/)
  assert.match(result.pages['pages/home.html'], /class="title fw-bold text-center"/)
  // background stays custom; the extracted declarations are gone; preamble untouched.
  assert.match(result.css, /\.hero \{\n {2}background: red;\n\}/)
  assert.doesNotMatch(result.css, /display: flex/)
  assert.match(result.css, /\*, \*::before, \*::after \{/)
  // .title extracted whole → its rule is dropped, no dangling blank blocks.
  assert.doesNotMatch(result.css, /\.title/)
  assert.doesNotMatch(result.css, /\n{3,}/)
  assert.equal(result.stats.extractedDeclarations, 6)
  assert.equal(result.stats.keptDeclarations, 1)
})

test('a property overridden in @media (breakpoint frames) is protected from !important utilities', () => {
  const css =
    HERO_CSS +
    `\n\n@media (max-width: 767px) {\n.hero {\n  flex-direction: row;\n  gap: 8px;\n}\n}`
  const result = applyBootstrapUtilities(heroInput({ css }))

  // flex-direction/gap have @media overrides → stay in plain CSS (family "flex"/"gap" protected;
  // display shares the "display" family and is NOT protected).
  const utils = result.utilities.get('hero')!
  assert.ok(utils.includes('d-flex'))
  assert.ok(utils.includes('p-4'))
  assert.ok(!utils.includes('flex-column'))
  assert.ok(!utils.includes('gap-3'))
  assert.match(result.css, /\.hero \{\n {2}flex-direction: column;\n {2}gap: 16px;\n {2}background: red;\n\}/)
  assert.match(result.css, /@media \(max-width: 767px\)/)
})

test('a property overridden in interactions.css (:hover) is protected across files', () => {
  const interactionsCss = `.title:hover {\n  font-weight: 400;\n}`
  const result = applyBootstrapUtilities(heroInput({ interactionsCss }))

  assert.deepEqual(result.utilities.get('title'), ['text-center']) // fw protected, text-align not
  assert.match(result.css, /\.title \{\n {2}font-weight: 700;\n\}/)
})

test('a complex selector in project.css itself protects its property family', () => {
  const css = HERO_CSS + `\n\n.title:not(:first-child) {\n  margin-top: 12px;\n}\n\n.title {\n  margin: 8px 8px 8px 8px;\n}`
  const result = applyBootstrapUtilities(heroInput({ css }))

  // margin-top override protects the margin family → the m-2 extraction is refused.
  assert.ok(!(result.utilities.get('title') ?? []).includes('m-2'))
  assert.match(result.css, /margin: 8px 8px 8px 8px;/)
  assert.match(result.css, /\.title:not\(:first-child\)/)
})

test('utility append deduplicates and leaves segment/list classes untouched', () => {
  const result = applyBootstrapUtilities(
    heroInput({
      pages: {
        'pages/home.html':
          '<div class="hero hero--wide">\n  <span class="title--segment-0">a</span>\n  <ul class="title--list"></ul>\n</div>',
      },
    })
  )

  assert.match(result.pages['pages/home.html'], /class="hero hero--wide d-flex flex-column gap-3 p-4"/)
  assert.match(result.pages['pages/home.html'], /class="title--segment-0"/)
  assert.match(result.pages['pages/home.html'], /class="title--list"/)
})

// --- integration: emitDjangoProject at utilities fidelity ------------------------------

/** Same minimal IR base as pipeline.e2e.test.ts's makeBase. */
function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

test('emitDjangoProject at utilities fidelity rewrites the page markup and shrinks project.css', async () => {
  const title: IrTextNode = {
    ...makeBase(),
    id: '40:2',
    name: 'Title',
    type: 'text',
    characters: 'Hello',
  }
  const hero: IrContainerNode = {
    ...makeBase(),
    id: '40:1',
    name: 'Hero',
    type: 'container',
    component: null,
    layout: {
      kind: 'flex',
      direction: 'column',
      wrap: false,
      gap: 16,
      justifyContent: 'center',
      alignItems: 'center',
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
    },
    children: [title],
  }

  const plain = await emitDjangoProject([hero], new Map(), new Map(), { cssFile: 'css/site.css' })
  const utilized = await emitDjangoProject([hero], new Map(), new Map(), {
    cssFile: 'css/site.css',
    framework: { source: 'assume', version: '5.3', bootstrapTokensCssFile: null, fidelity: 'utilities' },
  })

  const pagePath = Object.keys(utilized.pages)[0]
  assert.match(utilized.pages[pagePath], /d-flex/)
  assert.match(utilized.pages[pagePath], /flex-column/)
  assert.match(utilized.pages[pagePath], /gap-3/)
  assert.match(utilized.pages[pagePath], /p-4/)
  assert.doesNotMatch(plain.pages[pagePath], /d-flex/) // tokens fidelity → untouched
  assert.ok(utilized.css.length < plain.css.length, 'extracted declarations shrink project.css')
  assert.doesNotMatch(utilized.css, /display: flex/)
})

test('same-rule kept longhand blocks extracting its shorthand sibling (scroll axis survives)', () => {
  // The kanban-column case: clip → `overflow: hidden`, Figma scroll behavior → `overflow-y: auto`.
  // Extracting `.overflow-hidden` (!important) would kill the scroll axis — the whole rule's
  // overflow group must stay inline instead.
  const css = ['.col {', '  display: flex;', '  overflow: hidden;', '  overflow-y: auto;', '}', ''].join('\n')
  const result = applyBootstrapUtilities({ css, pages: {}, partials: {} })
  assert.deepEqual(result.utilities.get('col'), ['d-flex'])
  assert.match(result.css, /overflow: hidden;/)
  assert.match(result.css, /overflow-y: auto;/)

  // Same-family-prefix but different property group must still extract: `flex: 1 0 0` (kept)
  // does not block `flex-direction` → `.flex-column`.
  const flexCss = ['.fill {', '  flex: 1 0 0;', '  flex-direction: column;', '}', ''].join('\n')
  const flexResult = applyBootstrapUtilities({ css: flexCss, pages: {}, partials: {} })
  assert.deepEqual(flexResult.utilities.get('fill'), ['flex-column'])
  assert.match(flexResult.css, /flex: 1 0 0;/)

  // A rule whose overflow has no kept sibling still extracts.
  const plain = applyBootstrapUtilities({ css: ['.clip {', '  overflow: hidden;', '}', ''].join('\n'), pages: {}, partials: {} })
  assert.deepEqual(plain.utilities.get('clip'), ['overflow-hidden'])
})
