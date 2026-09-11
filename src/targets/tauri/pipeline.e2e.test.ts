/**
 * Tauri pipeline e2e: the same Card/Landing IR the django e2e uses runs through the REAL
 * `emitDjangoProject`, then `buildTauriExportTree` — asserting the static render leaves no
 * template syntax behind, prototype navigation becomes working relative links with a
 * view-transitions stylesheet, and the Tauri scaffold is complete and valid JSON.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { emitDjangoProject, type DjangoNodeSource } from '../django/index.ts'
import type { IrContainerNode, IrInstanceRefNode, IrTextNode } from '../django/ir.ts'
import { buildTauriExportTree } from './index.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

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

function buildLandingPage(card: IrContainerNode, detailId: string): IrContainerNode {
  const instance: IrInstanceRefNode = {
    ...makeBase(),
    id: '20:2',
    name: 'Card',
    type: 'instance-ref',
    layout: { kind: 'absolute' },
    componentId: card.id,
    componentKey: card.component!.key,
    componentProperties: {
      title: { type: 'TEXT', value: 'Open detail' },
      visible: { type: 'BOOLEAN', value: true },
    },
    children: [],
    navigate: {
      destinationId: detailId,
      transition: { style: 'SMART_ANIMATE', durationMs: 420, timingFunction: 'ease-in-out' },
    },
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

function buildDetailPage(card: IrContainerNode): IrContainerNode {
  const instance: IrInstanceRefNode = {
    ...makeBase(),
    id: '30:2',
    name: 'Card',
    type: 'instance-ref',
    layout: { kind: 'absolute' },
    componentId: card.id,
    componentKey: card.component!.key,
    componentProperties: {
      title: { type: 'TEXT', value: 'Card title' },
      visible: { type: 'BOOLEAN', value: true },
    },
    children: [],
  }
  return {
    ...makeBase(),
    id: '30:1',
    name: 'Detail',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [instance],
  }
}

test('tauri e2e: real emitDjangoProject output renders static with nav links, transitions, scaffold', async () => {
  const card = buildCardComponent()
  const detail = buildDetailPage(card)
  const landing = buildLandingPage(card, detail.id)
  const pageRoots = [card, landing, detail]

  const project = await emitDjangoProject(pageRoots, new Map<string, DjangoNodeSource>(), new Map(), {
    cssFile: 'css/site.css',
  })

  const { files, pageHrefs } = buildTauriExportTree({
    project,
    pageRoots,
    cssFile: 'css/site.css',
    tokensCss: ':root { --x: 1; }',
    animation: { css: '', js: '' },
    motionTokensJs: null,
    assets: [],
    productName: 'Reference Stand',
    startPageId: landing.id,
    window: { width: 1200, height: 800 },
  })

  // Landing is the flow start → index.html; every page renders to a document.
  assert.equal(pageHrefs[landing.id], 'index.html')
  const landingDoc = String(files['src/index.html'])
  const detailDoc = String(files[`src/${pageHrefs[detail.id]}`])

  // No template syntax survives the render, on any emitted document.
  for (const doc of [landingDoc, detailDoc]) {
    assert.ok(!doc.includes('{%'), 'no {% tags in rendered output')
    assert.ok(!doc.includes('{{'), 'no {{ vars in rendered output')
    assert.ok(!doc.includes('{#'), 'no {# comments in rendered output')
  }

  // The navigate reaction became a real relative link to the detail page.
  assert.ok(landingDoc.includes(`<a href="${pageHrefs[detail.id]}"`))

  // The include rendered inline with its bound TEXT property.
  assert.ok(landingDoc.includes('Open detail'))
  // The detail instance falls back to the component's default characters.
  assert.ok(detailDoc.includes('Card title'))

  // Smart-animate navigation produced the transitions stylesheet, linked from the pages, with the
  // Card layer matched across both documents. The morph name is keyed by the export's own class
  // (`.n<node id>`), not by the layer's display name: two differently-placed layers can share a
  // name, and a name-keyed ident then collides into a transition the browser skips.
  const transitions = String(files['src/assets/css/transitions.css'])
  assert.ok(transitions.includes('@view-transition'))
  assert.ok(transitions.includes('animation-duration: 420ms;'))
  const morph = /^(?<selectors>[^\n{]+)\{ view-transition-name: (?<ident>[\w-]+); \}$/m.exec(transitions)
  assert.ok(morph, `expected a view-transition-name rule, got:\n${transitions}`)
  const selectors = morph.groups!.selectors.trim().split(', ')
  // An instance of the same master on both pages renders with one class, so one selector carries
  // the name — what matters is that the element it names exists in BOTH documents, which is the
  // condition the browser morphs on.
  for (const selector of selectors) {
    assert.ok(landingDoc.includes(selector.slice(1)), `${selector} missing from the landing document`)
    assert.ok(detailDoc.includes(selector.slice(1)), `${selector} missing from the detail document`)
  }
  assert.ok(landingDoc.includes('assets/css/transitions.css'))

  // Assets: the linked stylesheet paths exist in the tree.
  assert.ok(landingDoc.includes('assets/css/site.css'))
  assert.equal(files['src/assets/css/site.css'], project.css)
  assert.equal(files['src/assets/css/tokens.css'], ':root { --x: 1; }')

  // Scaffold completeness + valid JSON configs.
  const conf = JSON.parse(String(files['src-tauri/tauri.conf.json']))
  assert.equal(conf.build.frontendDist, '../src')
  assert.equal(conf.app.windows[0].width, 1200)
  JSON.parse(String(files['src-tauri/capabilities/default.json']))
  JSON.parse(String(files['package.json']))
  for (const path of ['src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/src/main.rs', 'src-tauri/src/lib.rs', 'README.md', '.gitignore']) {
    assert.ok(files[path], `${path} present`)
  }
})
