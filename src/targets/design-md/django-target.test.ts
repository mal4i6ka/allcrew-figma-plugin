import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDjangoDesignMd, type DjangoDesignMdInput } from './django-target.ts'
import { buildTokenAudit } from './audit.ts'
import type { TokenTree, TokenValue, W3CToken } from '../../tokens/engine.ts'

function token(value: TokenValue, type: string, modes: Record<string, TokenValue> = {}): W3CToken {
  return { $type: type, $value: value, $extensions: { modes, figma: { collection: 'Colors', defaultMode: 'Light' } } }
}

const TREE: TokenTree = {
  Color: { Surface: { Page: token('#ffffff', 'color', { Light: '#ffffff', Dark: '#0f0f12' }) } },
  Spacing: { md: token(16, 'number', { Light: 16, Dark: 16 }) },
}

function input(overrides: Partial<DjangoDesignMdInput> = {}): DjangoDesignMdInput {
  return {
    fileName: 'AllCrew Channel',
    scope: { mode: 'page' },
    modules: { tokens: true, templates: true, i18n: true, animation: false },
    package: {
      pages: ['pages/home--1-23.html'],
      partials: ['components/button--4-56.html'],
      cssFile: 'css/project.css',
      interactionsCss: false,
      interactionsJs: false,
      animationsCss: false,
      animationsJs: false,
      assetCount: 3,
      manualAssets: [],
    },
    tokens: {
      tree: TREE,
      themes: ['Light', 'Dark'],
      defaultTheme: 'Light',
      themeAttribute: 'data-bs-theme',
      audit: buildTokenAudit({ collections: [], variables: [] }),
      emitJson: true,
    },
    i18n: { entryCount: 42, sourceLanguage: 'en', wrapTranslate: true },
    lint: { counts: {}, total: 0, nodeCount: 120 },
    ...overrides,
  }
}

test('the Django DESIGN.md fences off the generated regions', () => {
  const md = buildDjangoDesignMd(input())
  assert.match(md, /target: django/)
  assert.match(md, /GENERATED:BEGIN/)
  assert.match(md, /Never edit inside a `\{# GENERATED:BEGIN … #\}`/)
  assert.match(md, /`templates\/pages\/home--1-23\.html`/)
})

test('lint findings become hard DO-NOTs with their counts', () => {
  const md = buildDjangoDesignMd(
    input({ lint: { counts: { 'unbound-fill': 4, 'missing-auto-layout': 2 }, total: 6, nodeCount: 900 } })
  )
  assert.match(md, /\*\*4 layer\(s\) ship a solid fill that is NOT bound to a color variable\.\*\*/)
  assert.match(md, /\*\*2 frame\(s\) have no Auto Layout\*\*/)
  // A rule with no findings must not be mentioned at all.
  assert.equal(/text node\(s\) have no Figma text style/.test(md), false)
})

test('a clean audit is reported as clean, not as silence', () => {
  const md = buildDjangoDesignMd(input())
  assert.match(md, /found no issues/)
})

test('with the tokens module off the token sections are dropped and the contract adapts', () => {
  const md = buildDjangoDesignMd(
    input({ modules: { tokens: false, templates: true, i18n: false, animation: false }, tokens: undefined })
  )
  assert.match(md, /The tokens module was OFF for this export/)
  assert.equal(/## \d+\. Token reference/.test(md), false)
  assert.equal(/## \d+\. Themes/.test(md), false)
  assert.match(md, /The i18n module was OFF for this export/)
  const numbers = [...md.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]))
  assert.deepEqual(numbers, numbers.map((_, index) => index))
})

test('the Bootstrap section states the fidelity in force and what stayed stock', () => {
  const md = buildDjangoDesignMd(
    input({
      bootstrap: {
        fidelity: 'utilities',
        source: 'cdn',
        version: '5.3',
        matched: [{ bsVar: '--bs-body-bg', slug: 'color-surface-page' }],
        unmatched: ['--bs-warning'],
        themeCss: false,
      },
    })
  )
  assert.match(md, /fidelity \*\*`utilities`\*\*/)
  assert.match(md, /\| `--color-surface-page` \| `--bs-body-bg` \|/)
  assert.match(md, /Not covered by a token .*`--bs-warning`/)
})

test('untokenized typography is called out instead of left to guesswork', () => {
  const md = buildDjangoDesignMd(input())
  assert.match(md, /Typography is \*\*not tokenized\*\* in this export/)
})
