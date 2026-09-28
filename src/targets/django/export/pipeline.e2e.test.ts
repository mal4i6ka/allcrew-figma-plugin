/**
 * End-to-end pipeline test (T7.2, docs/PLAN.md E7): эталонный Figma-файл (tests/fixtures/
 * figma-reference.json — токены + `Card` компонент) прогоняется через весь реальный конвейер
 * (`emitDjangoProject` → `emitTokenArtifacts` → `buildExportTree` → zip) и применяется поверх
 * копии эталонного Django-проекта (tests/fixtures/django-reference) настоящим `allcrew-channel apply`
 * (cli/, REFORM фаза 5), затем проверяется, что итоговая структура файлов manage.py-совместима
 * и что содержимое, дошедшее до диска, побайтово совпадает с тем, что выдали эмиттеры.
 * Полноценное визуальное (пиксельное) сравнение недоступно в этой среде без headless-браузера;
 * здесь "визуальное сравнение" — это снапшот сгенерированной разметки/стилей против golden-
 * фикстур (tokens.fixture.test.ts, component-emitter.snapshot.test.ts), которые уже проверяют
 * содержимое каждого файла — этот тест проверяет, что тот же контент действительно долетает
 * до правильных путей внутри настоящего Django-приложения (tests/test_django_export_e2e.py
 * идёт на шаг дальше и рендерит эти шаблоны настоящим Django template engine).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, cp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { emitDjangoProject, partialPath, type DjangoNodeSource } from '../index.ts'
import { emitTokenArtifacts } from '../../../tokens/index.ts'
import { buildExportTree } from './file-tree.ts'
import { collectExportAssets } from './assets.ts'
import { spawnSync } from 'node:child_process'
import { generatedBeginMarker, generatedEndMarker } from '../regenerate.ts'
import type { IrContainerNode, IrImageNode, IrInstanceRefNode, IrTextNode } from '../ir.ts'
import type { VariableSnapshot } from '../../../variables.ts'

const fixturesDir = fileURLToPath(new URL('../../../../tests/fixtures/', import.meta.url))

function readFixture(relativePath: string): Promise<string> {
  return readFile(path.join(fixturesDir, relativePath), 'utf8')
}

/** Strips `wrapGenerated`'s marker lines so a written file can be compared to its unwrapped golden fixture. */
function stripGeneratedMarkers(content: string, nodeId: string): string {
  return content
    .replace(`${generatedBeginMarker(nodeId)}\n`, '')
    .replace(`\n${generatedEndMarker(nodeId)}`, '')
}

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

/** Rebuilds the reference stand's `Card` component (see component-emitter.snapshot.test.ts). */
function buildCardComponent(): IrContainerNode {
  const title: IrTextNode = {
    ...makeBase(),
    id: '10:2',
    name: 'Title',
    type: 'text',
    characters: 'Card title',
    componentPropertyReferences: { characters: 'title' },
  }

  return {
    ...makeBase(),
    id: '10:1',
    name: 'Card',
    type: 'container',
    layout: { kind: 'absolute' },
    component: {
      key: 'component-card',
      properties: [
        { name: 'title', type: 'TEXT', defaultValue: 'Card title', variantOptions: null },
        { name: 'visible', type: 'BOOLEAN', defaultValue: true, variantOptions: null },
      ],
    },
    componentPropertyReferences: { visible: 'visible' },
    children: [title],
  }
}

/** A page root instancing `Card` once, so `emitDjangoProject` emits both the partial and a page. */
function buildLandingPage(card: IrContainerNode): IrContainerNode {
  const instance: IrInstanceRefNode = {
    ...makeBase(),
    id: '20:2',
    name: 'Card',
    type: 'instance-ref',
    layout: { kind: 'absolute' },
    componentId: card.id,
    componentKey: card.component!.key,
    componentProperties: {},
    children: [],
  }

  return {
    ...makeBase(),
    id: '20:1',
    name: 'Landing',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [instance],
  }
}

test('full pipeline: figma-reference.json + Card component → Django export → applied onto the reference Django project', async (t) => {
  const card = buildCardComponent()
  const landing = buildLandingPage(card)
  const noSceneNodes = new Map<string, DjangoNodeSource>()
  const noVariableNames = new Map<string, string>()

  const project = await emitDjangoProject([card, landing], noSceneNodes, noVariableNames, { cssFile: 'css/site.css' })

  const cardPath = `templates/${partialPath(card)}`
  // `card` is itself a pageRoot (needed so `collectComponents` picks it up), so it also gets its
  // own page — pick Landing's page by the node id `fileNodeIds` records for it, not by key order.
  const landingRelativePath = Object.keys(project.pages).find((p) => project.fileNodeIds[p] === landing.id)!
  const landingPath = `templates/${landingRelativePath}`

  const reference = JSON.parse(await readFixture('figma-reference.json'))
  const snapshot: VariableSnapshot = { collections: reference.collections, variables: reference.variables }
  const tokensCss = emitTokenArtifacts(snapshot, {
    inlinePrimitives: true,
    flattenAliases: false,
    themeAttribute: 'data-bs-theme',
  }).css

  const files = buildExportTree({ project, tokensCss, cssFile: 'css/site.css' })

  await t.test('export tree lands the Card partial and Landing page at their expected paths', () => {
    assert.equal(files[cardPath], project.partials[partialPath(card)])
    assert.equal(files[landingPath], project.pages[landingRelativePath])
    assert.equal(files['templates/base.html'], project.baseHtml)
    assert.equal(files['static/css/tokens.css'], tokensCss)
    assert.equal(files['static/css/site.css'], project.css)
    assert.match(String(files[landingPath]), new RegExp(`\\{% include "${partialPath(card)}"`))
  })

  await t.test('base.html\'s {% static %} link resolves to the path the stylesheet is written at', () => {
    // Regression: cssFile carries its directory ('css/site.css'); writing it under static/css/
    // again produced static/css/css/site.css while base.html linked {% static 'css/site.css' %}.
    assert.ok(project.baseHtml.includes(`{% static 'css/site.css' %}`))
    assert.ok('static/css/site.css' in files, 'the linked path must exist under static/')
  })

  const zip = new JSZip()
  for (const [filePath, content] of Object.entries(files)) zip.file(filePath, content)
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })

  const workRoot = await mkdtemp(path.join(tmpdir(), 'django-export-e2e-'))
  try {
    const projectDir = path.join(workRoot, 'django-reference')
    await cp(path.join(fixturesDir, 'django-reference'), projectDir, { recursive: true })
    const appDir = path.join(projectDir, 'pages')

    // REFORM phase 5: the layout step is the REAL `allcrew-channel apply` (cli/allcrew_channel) run the way
    // users run it — this test is the parity gate that replaced scripts/apply-django-export.mjs.
    const zipPath = path.join(workRoot, 'export.zip')
    await writeFile(zipPath, zipBuffer)
    const cliDir = fileURLToPath(new URL('../../../../cli/', import.meta.url))
    const applyResult = spawnSync('python3', ['-m', 'allcrew_channel', 'apply', zipPath, '--app', appDir], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: cliDir },
    })
    if (applyResult.error && (applyResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('python3 not found on PATH — required for the allcrew-channel apply e2e step')
    }

    // The CLI prints fully-resolved paths; macOS tempdirs are symlinks (/var → /private/var).
    const realProjectDir = await realpath(projectDir)

    await t.test('allcrew-channel apply lays the zip onto the reference project\'s manage.py-relative app dir', () => {
      assert.equal(applyResult.status, 0, applyResult.stdout + applyResult.stderr)
      assert.ok(applyResult.stdout.includes(`manage.py found at ${realProjectDir}`))
      for (const written of ['templates/base.html', landingPath, cardPath, 'static/css/tokens.css', 'static/css/site.css']) {
        assert.ok(applyResult.stdout.includes(written), `apply output lists ${written}`)
      }
    })

    await t.test('written files are byte-identical to the emitted content, at manage.py-compatible paths', async () => {
      const writtenBase = await readFile(path.join(appDir, 'templates/base.html'), 'utf8')
      const writtenLanding = await readFile(path.join(appDir, landingPath), 'utf8')
      const writtenCard = await readFile(path.join(appDir, cardPath), 'utf8')
      const writtenTokens = await readFile(path.join(appDir, 'static/css/tokens.css'), 'utf8')

      assert.equal(writtenBase, project.baseHtml)
      assert.equal(writtenLanding, project.pages[landingRelativePath])
      assert.equal(writtenCard, project.partials[partialPath(card)])
      assert.equal(writtenTokens, tokensCss)
    })

    await t.test('written Card partial matches the golden snapshot used for the direct emitter test', async () => {
      const writtenCard = await readFile(path.join(appDir, cardPath), 'utf8')
      const unwrapped = stripGeneratedMarkers(writtenCard, card.id).trimEnd()
      const expected = (await readFixture('expected/component_card.html')).trimEnd()
      assert.equal(unwrapped, expected)
    })

    await t.test('reference project\'s pre-existing pages/index.html is left untouched', async () => {
      const original = await readFixture('django-reference/pages/templates/pages/index.html')
      const untouched = await readFile(path.join(appDir, 'templates/pages/index.html'), 'utf8')
      assert.equal(untouched, original)
    })
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

test('full pipeline: a GIF-fill image leaf ships as real GIF bytes end-to-end (M5), not a rasterized PNG render', async () => {
  // `serializeShape` (ir.ts) is what actually decides the .gif extension when it sniffs a non-PNG
  // fill — this test works with a hand-built IR literal (like the rest of this file), so it sets
  // assetSrc directly to what that decision produces, and proves collectExportAssets +
  // buildExportTree + zip carry the real fill bytes through to the final archive untouched.
  const spinner: IrImageNode = {
    ...makeBase(),
    id: '30:1',
    name: 'Spinner',
    type: 'image',
    imageHash: 'hash-spinner',
    assetSrc: 'img/30-1-spinner.gif',
  }
  const page: IrContainerNode = {
    ...makeBase(),
    id: '30:2',
    name: 'Loading',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [spinner],
  }

  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  const sceneNodesById = new Map<string, DjangoNodeSource>([
    [
      spinner.id,
      {
        id: spinner.id,
        name: spinner.name,
        exportAsync: async () => {
          throw new Error('exportAsync must not be called for a raw GIF-fill leaf')
        },
      } as unknown as DjangoNodeSource,
    ],
  ])
  const getImageByHash = (hash: string) => (hash === 'hash-spinner' ? { getBytesAsync: async () => gifBytes } : null)

  const project = await emitDjangoProject([page], new Map(), new Map(), { cssFile: 'css/site.css' })
  const assets = await collectExportAssets([page], sceneNodesById, getImageByHash)
  const files = buildExportTree({ project, tokensCss: '', cssFile: 'css/site.css', assets })

  const pageRelativePath = Object.keys(project.pages).find((p) => project.fileNodeIds[p] === page.id)!
  const pageHtml = String(files[`templates/${pageRelativePath}`])
  assert.ok(pageHtml.includes(`{% static 'img/30-1-spinner.gif' %}`), 'the <img> tag must reference the raw-fill filename')

  const zip = new JSZip()
  for (const [filePath, content] of Object.entries(files)) zip.file(filePath, content)
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
  const readBack = await JSZip.loadAsync(zipBuffer)
  const zippedGif = await readBack.file('static/img/30-1-spinner.gif')!.async('uint8array')

  assert.deepEqual(zippedGif, gifBytes, 'the zip must carry the raw GIF bytes, not a rasterized PNG render')
})

test('full pipeline: a container backgroundVideo fill renders its <video> layer on a real multi-page export (M5/M11)', async () => {
  // Regression: `component-emitter.ts`'s `renderPageNode`/`renderPartialContainer`/
  // `renderPartialInstanceRef` (the multi-page project emitter `emitDjangoProject` actually uses)
  // never called `html-emitter.ts`'s `renderBackgroundVideoLayer` — only the single-template
  // `emitHtml` path did. A container with `backgroundVideo` set silently rendered as a bare empty
  // `<div>` with no `<video>` tag anywhere in the real Django export.
  const videoClip: IrContainerNode = {
    ...makeBase(),
    id: '40:1',
    name: 'VideoClip',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    backgroundVideo: {
      videoHash: 'vid-1',
      assetSrc: 'img/40-1-videoclip-clip.mp4',
      posterSrc: 'img/40-1-videoclip-clip-poster.png',
      scaleMode: 'CROP',
    },
    children: [],
  }

  const project = await emitDjangoProject([videoClip], new Map(), new Map(), { cssFile: 'css/site.css' })
  const pageRelativePath = Object.keys(project.pages).find((p) => project.fileNodeIds[p] === videoClip.id)!
  const pageHtml = String(project.pages[pageRelativePath])

  assert.match(pageHtml, /<video class="n40-1__bg-video"[^>]*autoplay loop muted playsinline/)
  assert.ok(pageHtml.includes(`{% static 'img/40-1-videoclip-clip.mp4' %}`), 'the <video> src must reference the exported clip')
  assert.ok(pageHtml.includes(`{% static 'img/40-1-videoclip-clip-poster.png' %}`), 'the <video> poster must reference the exported poster')
})
