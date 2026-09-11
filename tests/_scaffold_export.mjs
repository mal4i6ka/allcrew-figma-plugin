/**
 * Emits a two-page, two-locale Django export into the directory given as argv[2], using the real
 * emitters (`emitDjangoProject` → `emitDjangoScaffold` → `buildExportTree`). Used by
 * tests/test_django_export_e2e.py, which then runs Django against the result: the piece Node
 * cannot check on its own is whether the generated project actually routes, localizes and renders.
 *
 * Run with: node --experimental-transform-types tests/_scaffold_export.mjs <out-dir>
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { emitDjangoProject } from '../src/targets/django/index.ts'
import { buildExportTree } from '../src/targets/django/export/file-tree.ts'
import { emitDjangoScaffold } from '../src/targets/django/project/index.ts'
import { emitLocaleCatalogs, emitPo } from '../src/targets/django/i18n/po.ts'

const outDir = process.argv[2]
if (!outDir) throw new Error('usage: node tests/_scaffold_export.mjs <out-dir>')

const base = () => ({
  position: { x: 0, y: 0 },
  sizing: { width: { mode: 'hug' }, height: { mode: 'hug' } },
  gridPlacement: null,
  componentPropertyReferences: {},
  warnings: [],
})

const text = (id, name, characters) => ({ ...base(), id, name, type: 'text', characters })

const frame = (id, name, children, extra = {}) => ({
  ...base(),
  id,
  name,
  type: 'container',
  layout: {
    kind: 'flex',
    direction: 'column',
    gap: 16,
    wrap: false,
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
  },
  component: null,
  children,
  ...extra,
})

const detail = frame('20:1', 'Detail', [text('20:2', 'Headline', 'How much do you want to send?')])
const home = frame('10:1', 'Home', [
  text('10:2', 'Headline', 'Business finances without hassle'),
  frame('10:3', 'Cta', [text('10:4', 'Cta label', 'Send money')], {
    navigate: {
      destinationId: detail.id,
      transition: { style: 'SMART_ANIMATE', durationMs: 420, timingFunction: 'ease-in-out', direction: 'RIGHT' },
    },
  }),
])

const project = await emitDjangoProject([home, detail], new Map(), new Map(), {
  cssFile: 'css/project.css',
  tokensCssFile: 'css/tokens.css',
  startPageId: home.id,
  languageSwitcher: true,
})

const entries = [
  { msgid: 'Business finances without hassle', references: ['figma://file?node-id=10:2'], msgctxt: '' },
  { msgid: 'Send money', references: ['figma://file?node-id=10:4'], msgctxt: '' },
]

const files = buildExportTree({
  project,
  tokensCss: ':root { --brand: #002780; }',
  cssFile: 'css/project.css',
  po: emitPo(entries, { sourceLanguage: 'en' }),
  localeCatalogs: emitLocaleCatalogs(entries, ['ru'], 'en'),
  scaffold: emitDjangoScaffold({
    pages: project.pageRoutes,
    projectName: 'config',
    appName: 'design',
    languages: [
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
    ],
    defaultLanguage: 'en',
    staticCssFile: 'css/project.css',
  }),
})

await rm(outDir, { recursive: true, force: true })
for (const [relativePath, content] of Object.entries(files)) {
  const absolute = path.join(outDir, relativePath)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}
