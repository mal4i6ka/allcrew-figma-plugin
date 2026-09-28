import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportTree, buildRegenStaticFiles } from './file-tree.ts'
import { emitBaseHtml } from '../component-emitter.ts'
import type { EmitDjangoProjectOutput } from '../index.ts'

function makeProject(overrides: Partial<EmitDjangoProjectOutput> = {}): EmitDjangoProjectOutput {
  return {
    baseHtml: '<html>base</html>',
    pages: { 'pages/landing.html': '<div>landing</div>' },
    partials: { 'components/button.html': '<button></button>' },
    css: '.n1 { color: red; }',
    interactionsCss: '',
    interactionsJs: '',
    fileNodeIds: {},
    ...overrides,
  }
}

test('buildExportTree places base.html, pages and partials under templates/', () => {
  const files = buildExportTree({ project: makeProject(), tokensCss: ':root {}', cssFile: 'css/styles.css' })

  assert.equal(files['templates/base.html'], '<html>base</html>')
  assert.equal(files['templates/pages/landing.html'], '<div>landing</div>')
  assert.equal(files['templates/components/button.html'], '<button></button>')
})

test('buildExportTree writes tokens.css and the generated stylesheet under static/css/', () => {
  const files = buildExportTree({ project: makeProject(), tokensCss: ':root { --x: 1; }', cssFile: 'css/styles.css' })

  assert.equal(files['static/css/tokens.css'], ':root { --x: 1; }')
  assert.equal(files['static/css/styles.css'], '.n1 { color: red; }')
})

test('buildExportTree writes assets under static/img/', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const files = buildExportTree({
    project: makeProject(),
    tokensCss: '',
    cssFile: 'css/styles.css',
    assets: [{ filename: '1-2-hero.png', content: bytes }],
  })

  assert.equal(files['static/img/1-2-hero.png'], bytes)
})

test('buildExportTree writes locale/figma.po only when po content is provided', () => {
  const withPo = buildExportTree({ project: makeProject(), tokensCss: '', cssFile: 'css/styles.css', po: 'msgid ""\n' })
  const withoutPo = buildExportTree({ project: makeProject(), tokensCss: '', cssFile: 'css/styles.css' })

  assert.equal(withPo['locale/figma.po'], 'msgid ""\n')
  assert.ok(!('locale/figma.po' in withoutPo))
})

test('buildExportTree keeps multiple pages and partials as distinct files', () => {
  const files = buildExportTree({
    project: makeProject({
      pages: { 'pages/landing.html': 'A', 'pages/about.html': 'B' },
      partials: { 'components/button.html': 'C', 'components/card.html': 'D' },
    }),
    tokensCss: '',
    cssFile: 'css/styles.css',
  })

  assert.equal(files['templates/pages/landing.html'], 'A')
  assert.equal(files['templates/pages/about.html'], 'B')
  assert.equal(files['templates/components/button.html'], 'C')
  assert.equal(files['templates/components/card.html'], 'D')
})

// --- M9: interactions.css + interactions.js shipped when the project produces them ---

test('buildExportTree writes static/css/interactions.css and static/js/interactions.js when the project has them', () => {
  const files = buildExportTree({
    project: makeProject({ interactionsCss: '.btn:hover { opacity: 0.8; }', interactionsJs: 'console.log("overlay")' }),
    tokensCss: '',
    cssFile: 'css/styles.css',
  })

  assert.equal(files['static/css/interactions.css'], '.btn:hover { opacity: 0.8; }')
  assert.equal(files['static/js/interactions.js'], 'console.log("overlay")')
})

test('buildExportTree omits interactions files when the project produced no interactions', () => {
  const files = buildExportTree({
    project: makeProject({ interactionsCss: '', interactionsJs: '' }),
    tokensCss: '',
    cssFile: 'css/styles.css',
  })

  assert.ok(!('static/css/interactions.css' in files), 'no interactions.css when content is empty')
  assert.ok(!('static/js/interactions.js' in files), 'no interactions.js when content is empty')
})

test('buildExportTree writes animation CSS and JS when the export pipeline produced them', () => {
  const files = buildExportTree({
    project: makeProject(),
    tokensCss: '',
    cssFile: 'css/styles.css',
    animation: {
      css: '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
      js: 'gsap.timeline();',
    },
  })

  assert.equal(files['static/css/animations.css'], '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }')
  assert.equal(files['static/js/animations.js'], 'gsap.timeline();')
})

test('buildExportTree omits animation files when the export pipeline produced none', () => {
  const files = buildExportTree({
    project: makeProject(),
    tokensCss: '',
    cssFile: 'css/styles.css',
    animation: { css: '', js: '' },
  })

  assert.ok(!('static/css/animations.css' in files), 'no animations.css when content is empty')
  assert.ok(!('static/js/animations.js' in files), 'no animations.js when content is empty')
})

// --- buildRegenStaticFiles: the static assets the regeneration download must ship so a
// regenerated project doesn't 404 the files its base.html {% static %}-links (EMIT_DJANGO_PROJECT
// "Preview changes" → Download path). ---

test('buildRegenStaticFiles ships interactions.css/js at the exact paths base.html links, when non-empty', () => {
  const files = buildRegenStaticFiles({
    interactionsCss: '.btn:hover { opacity: 0.8; }',
    interactionsJs: 'document.querySelector("dialog").showModal()',
  })

  assert.equal(files['static/css/interactions.css'], '.btn:hover { opacity: 0.8; }')
  assert.equal(files['static/js/interactions.js'], 'document.querySelector("dialog").showModal()')
})

test('buildRegenStaticFiles omits interactions files when the project produced none', () => {
  const files = buildRegenStaticFiles({ interactionsCss: '', interactionsJs: '' })

  assert.ok(!('static/css/interactions.css' in files), 'no interactions.css when content is empty')
  assert.ok(!('static/js/interactions.js' in files), 'no interactions.js when content is empty')
})

test('buildRegenStaticFiles ships tokens.css and bootstrap-tokens.css when provided, omits them when absent', () => {
  const withTokens = buildRegenStaticFiles({
    interactionsCss: '',
    interactionsJs: '',
    tokensCss: ':root { --brand: #f00; }',
    bootstrapTokensCss: ':root { --bs-primary: #f00; }',
  })
  assert.equal(withTokens['static/css/tokens.css'], ':root { --brand: #f00; }')
  assert.equal(withTokens['static/css/bootstrap-tokens.css'], ':root { --bs-primary: #f00; }')

  // Tokens module off (undefined) — nothing shipped, so base.html (which then links no tokens.css) stays consistent.
  const without = buildRegenStaticFiles({ interactionsCss: '', interactionsJs: '' })
  assert.ok(!('static/css/tokens.css' in without), 'no tokens.css when not provided')
  assert.ok(!('static/css/bootstrap-tokens.css' in without), 'no bootstrap-tokens.css when not provided')
})

test('regen download ships every static asset base.html {% static %}-links (no 404 for interactions/tokens/bootstrap-tokens)', () => {
  // base.html at its maximal link set: fonts + vendored Bootstrap + bootstrap-tokens + tokens +
  // project stylesheet + interactions css/js.
  const cssFile = 'css/project.css'
  const baseHtml = emitBaseHtml(
    cssFile,
    'css/tokens.css',
    ['Inter'],
    { interactionsCss: true, interactionsJs: true },
    { source: 'vendored', version: '5.3.3', bootstrapTokensCssFile: 'css/bootstrap-tokens.css', fidelity: 'components' }
  )
  const regenFiles = buildRegenStaticFiles({
    interactionsCss: '.x{}',
    interactionsJs: 'x()',
    tokensCss: ':root{}',
    bootstrapTokensCss: ':root{--bs-primary:#000}',
  })

  const staticRefs = [...baseHtml.matchAll(/\{% static '([^']+)' %\}/g)].map((m) => m[1])
  assert.ok(staticRefs.length >= 4, 'base.html should link several static assets in this config')

  for (const ref of staticRefs) {
    // vendored Bootstrap ships via `allcrew-channel bootstrap vendor`, and the project stylesheet travels
    // separately as the plan's `css`; every OTHER {% static %} link must be in the regen download.
    if (ref.startsWith('vendor/') || ref === cssFile) continue
    assert.ok(`static/${ref}` in regenFiles, `base.html links {% static '${ref}' %} but the regen zip would not ship static/${ref}`)
  }
})

test('theme B: buildExportTree writes static/css/bootstrap-theme.css when the project produced a theme', () => {
  const project = {
    baseHtml: '<html>', pages: {}, partials: {}, css: '', interactionsCss: '', interactionsJs: '',
    themeCss: '.btn-primary { --bs-btn-bg: #FB5B0A; }', fileNodeIds: {},
  }
  const files = buildExportTree({ project: project as never, tokensCss: '', cssFile: 'css/project.css' })
  assert.equal(files['static/css/bootstrap-theme.css'], '.btn-primary { --bs-btn-bg: #FB5B0A; }')

  const empty = buildExportTree({ project: { ...project, themeCss: '' } as never, tokensCss: '', cssFile: 'css/project.css' })
  assert.ok(!('static/css/bootstrap-theme.css' in empty))
})

test('theme B: buildRegenStaticFiles ships the theme in the regen download too', () => {
  const files = buildRegenStaticFiles({ interactionsCss: '', interactionsJs: '', themeCss: '.btn { --bs-btn-padding-x: 12px; }' })
  assert.equal(files['static/css/bootstrap-theme.css'], '.btn { --bs-btn-padding-x: 12px; }')
})
