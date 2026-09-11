/**
 * Tauri target assembly: takes the django project emit (pages/partials/css/interactions —
 * the platform-neutral heavy lifting), renders it static (`render-static.ts`), wires
 * prototype navigation into cross-document view transitions (`transitions.ts`), and wraps
 * everything in a Tauri v2 vanilla-shape project (`scaffold.ts`):
 *
 *   src/                  ← frontendDist (static, no bundler)
 *     index.html          ← the flow-start page
 *     <page>.html         ← every other exported page
 *     assets/css|js|img/  ← same internal layout as the django static/ tree, so the
 *                           emitted CSS's `../img/…` fill references resolve unchanged
 *   src-tauri/            ← config, Rust shell, capabilities
 */

import type { EmitDjangoProjectOutput } from '../django/index.ts'
import { navMapKey } from '../django/component-emitter.ts'
import type { IrContainerNode } from '../django/ir.ts'
import type { ExportAsset } from '../django/export/assets.ts'
import type { ExportFileContent } from '../django/export/file-tree.ts'
import { renderStaticPage } from './render-static.ts'
import { emitPageTransitions } from '../django/transitions.ts'
import { emitScrollGuardsCss } from './scroll-guards.ts'
import { buildTauriScaffold } from './scaffold.ts'

export interface TauriBuildInput {
  project: EmitDjangoProjectOutput
  /** The exported page IR roots (post breakpoint-collapse — the same set `project.pages` renders). */
  pageRoots: readonly IrContainerNode[]
  /** `static`-relative project stylesheet path, e.g. `css/project.css`. */
  cssFile: string
  /** tokens.css content, or null when the tokens module is off. */
  tokensCss: string | null
  /** M10 Motion outputs (empty strings = nothing emitted). */
  animation: { css: string; js: string }
  /** `motion-tokens.js` content, or null when the animation module is off. */
  motionTokensJs: string | null
  assets: readonly ExportAsset[]
  /** Figma file name — product name, window title. */
  productName: string
  /** `figma.currentPage.flowStartingPoints[0]?.nodeId` — picks index.html. Absent → first page. */
  startPageId?: string
  /** Flow-start frame size → initial window size. */
  window: { width: number; height: number }
  /** Bootstrap CDN pin for `vendor/bootstrap/…` rewrites (framework != none only). */
  bootstrapVersion?: string
  /** Videos the Figma API refused to export (README section). */
  manualAssetNotes?: readonly string[]
}

export interface TauriBuildOutput {
  files: Record<string, ExportFileContent>
  /** Page href by Figma node id — export-report/DESIGN.md hooks. */
  pageHrefs: Record<string, string>
}

/** `pages/<name-slug>--<id-slug>.html` → `<name-slug>`. */
function pageSlug(pagePath: string): string {
  const base = pagePath.replace(/^pages\//, '').replace(/\.html$/, '')
  const sep = base.lastIndexOf('--')
  return sep === -1 ? base : base.slice(0, sep)
}

/** A base.html that a project hand-edited back to vendored GSAP paths still has to resolve in a
 * webview with no vendor step, so those paths keep their CDN rewrite. The generated base.html no
 * longer produces them — it links the pinned jsDelivr build directly (component-emitter.ts). */
const GSAP_CDN: Record<string, string> = {
  'vendor/gsap/gsap.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js',
  'vendor/gsap/CustomEase.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3/dist/CustomEase.min.js',
  'vendor/gsap/DrawSVGPlugin.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3/dist/DrawSVGPlugin.min.js',
  'vendor/gsap/TextPlugin.min.js': 'https://cdn.jsdelivr.net/npm/gsap@3/dist/TextPlugin.min.js',
}

export function buildTauriExportTree(input: TauriBuildInput): TauriBuildOutput {
  const { project } = input

  /* ---- page hrefs: flow start → index.html, the rest → <slug>.html (id-suffixed on collision) */
  const pagePaths = Object.keys(project.pages)
  const startPath =
    (input.startPageId && pagePaths.find((path) => project.fileNodeIds[path] === input.startPageId)) ?? pagePaths[0]

  const slugCounts = new Map<string, number>()
  for (const path of pagePaths) slugCounts.set(pageSlug(path), (slugCounts.get(pageSlug(path)) ?? 0) + 1)

  const hrefByPath = new Map<string, string>()
  for (const path of pagePaths) {
    if (path === startPath) {
      hrefByPath.set(path, 'index.html')
      continue
    }
    const slug = pageSlug(path)
    hrefByPath.set(path, (slugCounts.get(slug) ?? 0) > 1 ? path.replace(/^pages\//, '') : `${slug}.html`)
  }

  const hrefByNavKey = new Map<string, string>()
  const pageHrefs: Record<string, string> = {}
  for (const [path, href] of hrefByPath) {
    const nodeId = project.fileNodeIds[path]
    if (nodeId) {
      hrefByNavKey.set(navMapKey(nodeId), href)
      pageHrefs[nodeId] = href
    }
  }

  /* ---- view transitions from prototype NAVIGATE reactions. Only rendered pages participate:
   * a breakpoint-collapsed frame has no document of its own to navigate to or morph against.
   * Shared with the Django export (`django/transitions.ts`): both targets serve a multi-page
   * document, so the same cross-document view-transition CSS is correct for both — and a second
   * copy of it here was already drifting (name-keyed morph selectors that the id-keyed export
   * classes never matched). */
  const renderedRoots = input.pageRoots.filter((root) => pageHrefs[root.id])
  const { css: transitionsCss } = emitPageTransitions({
    nodes: renderedRoots,
    pageRootIds: new Set(renderedRoots.map((root) => root.id)),
  })

  /* ---- static render */
  const partials = new Map(Object.entries(project.partials))
  const bootstrapCdn: Record<string, string> = input.bootstrapVersion
    ? {
        'vendor/bootstrap/bootstrap.min.css': `https://cdn.jsdelivr.net/npm/bootstrap@${input.bootstrapVersion}/dist/css/bootstrap.min.css`,
        'vendor/bootstrap/bootstrap.bundle.min.js': `https://cdn.jsdelivr.net/npm/bootstrap@${input.bootstrapVersion}/dist/js/bootstrap.bundle.min.js`,
      }
    : {}
  const renderOpts = {
    staticHref: (path: string): string => GSAP_CDN[path] ?? bootstrapCdn[path] ?? `assets/${path}`,
    navHref: (key: string): string => hrefByNavKey.get(key) ?? '#',
    partials,
  }

  const files: Record<string, ExportFileContent> = {}

  for (const [path, pageHtml] of Object.entries(project.pages)) {
    let doc = renderStaticPage(project.baseHtml, pageHtml, renderOpts)
    // Per-page head extras the platform-neutral base emitter doesn't know about. It now emits the
    // charset/viewport pair and an (empty, context-driven) <title> itself, so this fills the title
    // in from the frame name instead of injecting a second copy of each tag.
    const nodeId = project.fileNodeIds[path]
    const pageRoot = input.pageRoots.find((root) => root.id === nodeId)
    const title = `<title>${(pageRoot?.name ?? input.productName).replace(/</g, '&lt;')}</title>`
    doc = /<title>[^<]*<\/title>/.test(doc)
      ? doc.replace(/<title>[^<]*<\/title>/, () => title)
      : doc.replace('<head>', () => `<head>\n  ${title}`)
    if (!doc.includes('name="viewport"')) {
      doc = doc.replace(
        '<head>',
        () => '<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">'
      )
    }
    if (transitionsCss) {
      doc = doc.replace('</head>', () => '  <link rel="stylesheet" href="assets/css/transitions.css">\n</head>')
    }
    files[`src/${hrefByPath.get(path) ?? path.replace(/^pages\//, '')}`] = doc
  }

  /* ---- assets, same internal layout as the django static/ tree */
  if (input.tokensCss) files['src/assets/css/tokens.css'] = input.tokensCss
  // Squeeze guards append AFTER the emitted rules so they win same-specificity overflow ties.
  const scrollGuards = emitScrollGuardsCss(renderedRoots)
  files[`src/assets/${input.cssFile}`] = scrollGuards ? `${project.css}\n\n${scrollGuards}` : project.css
  if (project.interactionsCss) files['src/assets/css/interactions.css'] = project.interactionsCss
  if (project.interactionsJs) files['src/assets/js/interactions.js'] = project.interactionsJs
  if (project.themeCss) files['src/assets/css/bootstrap-theme.css'] = project.themeCss
  if (input.animation.css) files['src/assets/css/animations.css'] = input.animation.css
  if (input.animation.js) files['src/assets/js/animations.js'] = input.animation.js
  if (input.motionTokensJs) files['src/assets/js/motion-tokens.js'] = input.motionTokensJs
  if (transitionsCss) files['src/assets/css/transitions.css'] = transitionsCss
  for (const asset of input.assets) files[`src/assets/img/${asset.filename}`] = asset.content

  /* ---- Tauri shell */
  const slug = input.productName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  Object.assign(
    files,
    buildTauriScaffold({
      productName: input.productName,
      slug,
      window: input.window,
      manualAssetNotes: input.manualAssetNotes,
      usesGsapCdn: Boolean(input.animation.js),
    })
  )

  return { files, pageHrefs }
}
