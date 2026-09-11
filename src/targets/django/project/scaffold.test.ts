import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emitDjangoScaffold, type DjangoScaffoldInput, type ScaffoldPage } from './index.ts'

function makePage(overrides: Partial<ScaffoldPage> = {}): ScaffoldPage {
  return {
    templatePath: 'pages/home--1-2.html',
    nodeId: '1:2',
    navKey: 'nav_1_2',
    slug: 'home',
    title: 'Home',
    isStart: true,
    ...overrides,
  }
}

function makeInput(overrides: Partial<DjangoScaffoldInput> = {}): DjangoScaffoldInput {
  return {
    pages: [
      makePage(),
      makePage({ templatePath: 'pages/about--3-4.html', nodeId: '3:4', navKey: 'nav_3_4', slug: 'about', title: 'About', isStart: false }),
    ],
    projectName: 'config',
    appName: 'design',
    languages: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
    ],
    defaultLanguage: 'en',
    staticCssFile: 'css/project.css',
    ...overrides,
  }
}

const EXPECTED_PATHS = [
  'manage.py',
  'config/__init__.py',
  'config/settings.py',
  'config/urls.py',
  'config/wsgi.py',
  'config/asgi.py',
  'design/__init__.py',
  'design/apps.py',
  'design/urls.py',
  'design/views.py',
  'design/pages.py',
  'design/context_processors.py',
  'templates/404.html',
  'templates/500.html',
  'templates/partials/language-switcher.html',
  'requirements.txt',
  '.gitignore',
  '.env.example',
  'README.md',
  'Makefile',
]

test('emitDjangoScaffold emits every expected path', () => {
  const files = emitDjangoScaffold(makeInput())
  for (const expected of EXPECTED_PATHS) {
    assert.ok(expected in files, `missing ${expected}`)
  }
  assert.equal(Object.keys(files).length, EXPECTED_PATHS.length)
})

test('emitDjangoScaffold routes the start page at "" and every other page at "<slug>/"', () => {
  const files = emitDjangoScaffold(makeInput())
  const urls = files['design/urls.py']

  // urls.py is data-driven off PAGES rather than hardcoding any slug, so the routing rule
  // lives in one conditional expression: the start page's `is_start` flag selects `''`.
  assert.match(urls, /path\('' if entry\['is_start'\] else f"\{entry\['slug'\]\}\/"/)

  const pages = files['design/pages.py']
  assert.match(pages, /'slug': 'home',[\s\S]*?'is_start': True/)
  assert.match(pages, /'slug': 'about',[\s\S]*?'is_start': False/)
})

test('emitDjangoScaffold wraps routes in i18n_patterns only when languages are configured', () => {
  const localized = emitDjangoScaffold(makeInput())
  assert.match(localized['config/urls.py'], /i18n_patterns\(/)
  assert.match(localized['config/urls.py'], /path\('i18n\/', include\('django\.conf\.urls\.i18n'\)\)/)
  assert.match(localized['config/settings.py'], /django\.middleware\.locale\.LocaleMiddleware/)
  assert.match(localized['config/settings.py'], /LANGUAGES = \[/)

  const unlocalized = emitDjangoScaffold(makeInput({ languages: [] }))
  assert.doesNotMatch(unlocalized['config/urls.py'], /i18n_patterns\(/)
  assert.doesNotMatch(unlocalized['config/urls.py'], /path\('i18n\//)
  assert.doesNotMatch(unlocalized['config/settings.py'], /django\.middleware\.locale\.LocaleMiddleware/)
  assert.doesNotMatch(unlocalized['config/settings.py'], /LANGUAGES = \[/)
})

test('emitDjangoScaffold builds a navMap whose keys are the given navKeys', () => {
  const files = emitDjangoScaffold(makeInput())
  const pages = files['design/pages.py']
  const processors = files['design/context_processors.py']

  assert.match(pages, /'nav_key': 'nav_1_2'/)
  assert.match(pages, /'nav_key': 'nav_3_4'/)
  // The processor builds navMap generically from every page's nav_key/slug rather than
  // hardcoding keys — this is the structural guarantee that every navKey in `pages.py`
  // surfaces as a navMap entry at request time.
  assert.match(processors, /'navMap': \{/)
  assert.match(processors, /page\['nav_key'\]: reverse\(f'design:page-\{page\["slug"\]\}'\)/)
})

test('emitDjangoScaffold is a pure function of its input (byte-stable across runs)', () => {
  const input = makeInput()
  const first = emitDjangoScaffold(input)
  const second = emitDjangoScaffold(input)
  assert.deepEqual(first, second)
})

test('emitDjangoScaffold escapes single quotes and backslashes in page titles', () => {
  const files = emitDjangoScaffold(makeInput({ pages: [makePage({ title: "Founder's \\ Pick" })] }))
  assert.match(files['design/pages.py'], /'title': 'Founder\\'s \\\\ Pick'/)
})

test('every generated .py file parses under a real python3 interpreter', async () => {
  const files = emitDjangoScaffold(makeInput())
  const workDir = await mkdtemp(path.join(tmpdir(), 'django-scaffold-'))
  try {
    const pyFiles = Object.entries(files).filter(([filePath]) => filePath.endsWith('.py'))
    assert.ok(pyFiles.length > 0)
    for (const [filePath, content] of pyFiles) {
      const absolute = path.join(workDir, filePath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
    }
    for (const [filePath] of pyFiles) {
      const absolute = path.join(workDir, filePath)
      const result = spawnSync('python3', ['-m', 'py_compile', absolute], { encoding: 'utf8' })
      assert.equal(result.status, 0, `${filePath} failed to compile: ${result.stderr}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('emitDjangoScaffold falls back to makemessages --all when no languages are configured', () => {
  const files = emitDjangoScaffold(makeInput({ languages: [] }))
  assert.match(files['Makefile'], /makemessages --all/)

  const localized = emitDjangoScaffold(makeInput())
  assert.match(localized['Makefile'], /makemessages -l en -l fr/)
})
