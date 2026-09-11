/**
 * Single entry point for the Django export (T3.1): serializes IR + live node styles into the
 * `templates/<name>.html` and `static/<name>.css` pair E3 consumers write to disk.
 */

import type { IrContainerNode, IrNode } from './ir.ts'
import { emitCss, type DjangoNodeSource, type EmitterNote } from './css-emitter.ts'
import { emitHtml } from './html-emitter.ts'
import {
  buildComponentRegistry,
  collectComponents,
  collectOverriddenTextNodeIds,
  emitBaseHtml,
  emitComponentPartial,
  emitPage,
  navMapKey,
  pageTemplatePath,
  partialPath,
  type BaseHtmlAnimationLinks,
  type BaseHtmlFrameworkLinks,
  renderOverlayFragment,
} from './component-emitter.ts'
import { emitPageTransitions } from './transitions.ts'
import { wrapGenerated } from './regenerate.ts'
import {
  detectBreakpointGroups,
  emitBreakpointCss,
  mergeBreakpointVariants,
  type BreakpointTokenMap,
} from './breakpoint-frames.ts'
import { emitInteractions } from './interactions.ts'
import { applyBootstrapUtilities } from './bootstrap/utilities.ts'
import { buildBootstrapTheme, collectThemedInstanceMasters, type ThemableSetData } from './bootstrap/theme.ts'
import { injectTriggerAttributes } from './bootstrap/components.ts'

export type { DjangoNodeSource } from './css-emitter.ts'
export { toClassName } from './css-emitter.ts'
export {
  partialPath,
  emitBaseHtml,
  type BaseHtmlAnimationLinks,
  type BaseHtmlFrameworkLinks,
  type BaseHtmlInteractionLinks,
} from './component-emitter.ts'
export * from './regenerate.ts'

/** Node id `wrapGenerated`/`planRegeneration` key `base.html` under — it isn't produced from any
 * single Figma node, but still needs a stable marker identity for regeneration matching. */
export const BASE_HTML_NODE_ID = 'base.html'

export interface EmitDjangoOptions {
  /** `static`-relative path the emitted HTML links to, e.g. `"css/project.css"`. */
  cssFile: string
  /** `static`-relative path of the design-token variables stylesheet base.html links before
   * `cssFile`, or `null` when the tokens module is off. Defaults to the tree layout
   * `buildExportTree` writes (`css/tokens.css`). */
  tokensCssFile?: string | null
  /** M10: animation asset links to include in base.html when Motion timelines emitted files. */
  animationLinks?: BaseHtmlAnimationLinks
  /** REFORM phase 4: framework (Bootstrap) links for base.html; null/absent = no framework. */
  framework?: BaseHtmlFrameworkLinks | null
  /** REFORM phase 14 (B): component sets the export references, collected plugin-side (code.ts
   * `collectThemableSets`) at `theme` fidelity — `buildBootstrapTheme` turns them into
   * bootstrap-theme.css. Absent/empty below theme fidelity. */
  themeSets?: readonly ThemableSetData[]
  /** M4b: token-driven breakpoint widths extracted from a Figma "Breakpoints" variable
   * collection (via `extractBreakpointTokens`). When present, overrides the hardcoded
   * `NAMED_WIDTHS` for `<slug>/desktop|tablet|mobile` frame-name keywords. Absent/empty =
   * fall back to the canonical widths. */
  breakpointTokens?: BreakpointTokenMap
  /** The prototype's start frame id (`figma.currentPage.flowStartingPoints[0]`), when it is one of
   * the exported roots — its page serves at the site root instead of `/<slug>/`. Absent = the
   * first rendered root takes the root URL, because a site whose every page hangs off a slug has
   * no home page at all. */
  startPageId?: string
  /** Render the language switcher include in base.html — on when the export ships more than one
   * locale catalog. The partial itself comes from the Django scaffold. */
  languageSwitcher?: boolean
  /** Image-fill url()s for state variants living outside the exported page tree, keyed by node id
   * (`src/code.ts` exports those images with the page assets). Without them a hover state that
   * swaps a photo can only drop the declaration — see `emitInteractions`. */
  stateImageUrlsByNodeId?: ReadonlyMap<string, readonly string[]>
}

export interface DjangoOutput {
  html: string
  css: string
}

export async function emitDjango(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  opts: EmitDjangoOptions
): Promise<DjangoOutput> {
  const css = await emitCss(nodes, sceneNodesById, variableNamesById)
  const html = emitHtml(nodes, sceneNodesById, opts.cssFile)
  return { html, css }
}

export interface EmitDjangoProjectOutput {
  /** `base.html` skeleton every page extends. */
  baseHtml: string
  /** Page templates keyed by their `pages/<name>--<node id>.html` path (docs §3.1). */
  pages: Record<string, string>
  /** Component partials keyed by their `components/<name>--<node id>.html` path (docs §2). */
  partials: Record<string, string>
  css: string
  /** `static/css/interactions.css` content (M9) — `:hover`/`:active` transition rules from
   * ON_HOVER/ON_PRESS CHANGE_TO reactions. Empty string when no interactions exist. */
  interactionsCss: string
  /** `static/js/interactions.js` content (M9) — overlay `showModal()` wiring. Empty string
   * when no overlays need JS. */
  interactionsJs: string
  /** `static/css/bootstrap-theme.css` content (REFORM phase 14 B) — per-component Bootstrap
   * variable sets extracted from the kit masters. Empty string below theme fidelity or when
   * nothing themable was referenced. */
  themeCss: string
  /** `static/css/transitions.css` content — prototype page-to-page transitions (view transitions,
   * directional keyframes, Smart Animate shared elements). Empty when no cross-page reaction exists. */
  transitionsCss: string
  /** `static/js/transitions.js` content. Empty whenever the transitions need no script, which is
   * the normal case: cross-document view transitions are declarative. */
  transitionsJs: string
  /** One entry per emitted page template — everything the Django scaffold needs to route it. */
  pageRoutes: readonly DjangoPageRoute[]
  /** What the CSS pass could only approximate or could not draw at all (squircle corners,
   * NOISE/TEXTURE/GLASS/SHADER effects and fills). Folded into `export-report.json` so a missing
   * layer is stated rather than left for someone to notice in the screenshot. */
  notes: readonly EmitterNote[]
  /** The Figma node id (or `BASE_HTML_NODE_ID`) behind each `baseHtml`/`pages`/`partials` path —
   * feed straight into `planRegeneration`'s `FreshFile.nodeId` (T3.3) to merge a re-export against
   * a previous one without clobbering hand edits. */
  fileNodeIds: Record<string, string>
}

/** The routing facts one exported page carries: the scaffold turns these into `urls.py` entries and
 * the `navMap` context the templates' `{{ navMap.nav_… }}` hrefs already look up. */
export interface DjangoPageRoute {
  /** `pages/home--1-2.html`, relative to `templates/` — the same key `pages` is written under. */
  readonly templatePath: string
  readonly nodeId: string
  /** `navMapKey(nodeId)` — the dotted key the emitted markup uses. */
  readonly navKey: string
  /** URL segment (`about-us`), unique across the export. */
  readonly slug: string
  /** `<title>` text: the frame's own name, which is what the designer named the screen. */
  readonly title: string
  readonly isStart: boolean
}

/**
 * Components → partials (T3.2): unlike `emitDjango` (one flat template per export), this splits
 * every ComponentNode found under `pageRoots` into its own `{% include %}`-able partial, and
 * emits each page root as `{% extends "base.html" %}` + `{% block content %}` referencing those
 * partials instead of inlining component markup.
 *
 * Every emitted file is `wrapGenerated` (T3.3): only the marked region is replaced on a later
 * `planRegeneration` pass, so hand edits made outside it (or a whole file with no marker, meaning
 * it predates a generator run) survive regeneration.
 */
export async function emitDjangoProject(
  pageRoots: readonly IrContainerNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  opts: EmitDjangoOptions
): Promise<EmitDjangoProjectOutput> {
  // M4b: named breakpoint frames (`Home/desktop` + `Home/mobile`, …) collapse into one page —
  // only the widest frame of each group renders a DOM/page; the narrower ones become `@media`
  // blocks appended to the CSS below. Ungrouped roots (incl. lone breakpoint-named frames) render
  // unchanged, so single-frame exports are unaffected.
  const detected = detectBreakpointGroups(pageRoots, opts.breakpointTokens)
  const groups = detected.groups
  // A node the designer drew ONLY in the narrow frame (the burger, a stacked CTA) has no element
  // in the widest frame's tree, so a `@media` block had nothing to target and the whole subtree
  // fell out of the export. `mergeBreakpointVariants` splices those subtrees into the widest tree
  // tagged `breakpointOnly`; `emitBreakpointCss` hides them at base width and reveals them in the
  // matching block. The merged root keeps the widest frame's id, so page paths, `fileNodeIds` and
  // navMap keys are unchanged.
  const mergedByWidestId = new Map(groups.map((group) => [group.frames[0].node.id, mergeBreakpointVariants(group)]))
  const rendered = detected.rendered.map((root) => mergedByWidestId.get(root.id) ?? root)

  const components = collectComponents(rendered)
  const registry = buildComponentRegistry(components)
  const overriddenTextNodeIds = collectOverriddenTextNodeIds(rendered, registry)
  // M9: every rendered page becomes a NAVIGATE destination candidate — a reaction targeting a
  // node outside this set (an unrendered frame, or one collapsed into a breakpoint group above)
  // has no template of its own to link to, so it's left out and degrades to "skip with warning".
  const navMap = new Map<string, string>(rendered.map((root) => [root.id, navMapKey(root.id)]))

  const fileNodeIds: Record<string, string> = {}

  // REFORM phase 7 / B3: at components fidelity, recognized components render native
  // Bootstrap markup and click-overlays become data-API modals (no generated JS).
  // `theme` sits above `components` on the fidelity ladder — recognition stays on.
  const bootstrapComponents = opts.framework?.fidelity === 'components' || opts.framework?.fidelity === 'theme'

  const partials: Record<string, string> = {}
  for (const component of components) {
    const path = partialPath(component)
    partials[path] = wrapGenerated(
      component.id,
      emitComponentPartial(
        component,
        sceneNodesById,
        registry,
        overriddenTextNodeIds.get(component.id) ?? new Set(),
        navMap,
        bootstrapComponents
      )
    )
    fileNodeIds[path] = component.id
  }

  // A merged breakpoint page is named by the group slug ("One Main"), not the widest frame's
  // full name ("One Main / 1920px") — the file represents every breakpoint at once.
  const groupSlugByWidestId = new Map(groups.map((group) => [group.frames[0].node.id, group.slug]))

  const pages: Record<string, string> = {}
  const pageRoutes: DjangoPageRoute[] = []
  const usedSlugs = new Set<string>()
  const startPageId = opts.startPageId && rendered.some((root) => root.id === opts.startPageId) ? opts.startPageId : rendered[0]?.id
  for (const root of rendered) {
    const groupSlug = groupSlugByWidestId.get(root.id)
    const path = pageTemplatePath(root, groupSlug)
    pages[path] = wrapGenerated(root.id, emitPage(root, sceneNodesById, registry, navMap, bootstrapComponents))
    fileNodeIds[path] = root.id
    // The URL slug follows the template name, minus its node-id suffix — two frames named the same
    // would otherwise route to one URL and the second page would be unreachable, so a collision
    // falls back to the id-suffixed form the template file already uses.
    const name = groupSlug ?? root.name
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page'
    const slug = usedSlugs.has(base) ? `${base}-${root.id.replace(/[^a-zA-Z0-9]+/g, '-')}` : base
    usedSlugs.add(slug)
    pageRoutes.push({
      templatePath: path,
      nodeId: root.id,
      navKey: navMapKey(root.id),
      slug,
      title: name.trim(),
      isStart: root.id === startPageId,
    })
  }

  // REFORM phase 14 (C): at theme fidelity, themed kit-button instances trade their mapped pixel
  // props for `--bs-btn-*` var overrides (designer deltas) or drop them (theme-carried). Built
  // before emitCss so the css pass can consult it per node.
  const themedInstances =
    opts.framework?.fidelity === 'theme' && opts.themeSets?.length
      ? collectThemedInstanceMasters(rendered, opts.themeSets)
      : undefined

  // The notes sink was never passed, so every approximation the CSS pass makes (a squircle
  // rounded by a factor, an effect or fill CSS cannot draw) was dropped on the floor: the designer
  // saw a picture missing a layer and nothing anywhere said which layer or why.
  const notes: EmitterNote[] = []
  let css = await emitCss(rendered, sceneNodesById, variableNamesById, { themedInstances, notes })
  for (const group of groups) {
    const mediaCss = await emitBreakpointCss(group, sceneNodesById, variableNamesById)
    if (mediaCss.length > 0) css += `\n\n${mediaCss}`
  }

  // REFORM phase 13 / P2h: safety net for Bootstrap state vars that are UNDEFINED on a bare `.btn`
  // (they're only defined per-variant, e.g. `.btn-primary`). `.btn:active`/`.btn.active`/`.btn.show`
  // declare `border-color: var(--bs-btn-active-border-color)` — an undefined var is invalid at
  // computed-value time → `unset` → border-color: currentColor → a 1px text-color border flashes on
  // every click (and STAYS on an open dropdown toggle, which keeps `.show`). The cascade layer can't
  // help: no un-layered rule declares border-color for stroke-less Figma buttons, so the layered rule
  // wins by default. A `:root`-level definition resolves the var to a no-op; real variant buttons
  // define their own on the element, which always beats the inherited value. (Verified live: click
  // border rgb(29,29,31) → transparent, custom background untouched.)
  if (opts.framework) {
    css =
      `/* Bootstrap bare-.btn state-var safety net — see emitDjangoProject (P2h). */\n` +
      `:root {\n  --bs-btn-active-border-color: transparent;\n}\n\n` +
      // btn-group's -1px sibling overlap exists to collapse borders of FUSED buttons; a Figma
      // group spaces its buttons with the design's own gap, so the overlap just shifts them.
      `.btn-group > :not(.btn-check:first-child) + .btn {\n  margin-left: 0;\n}\n\n` + css
  }

  // Overlay destinations are ordinary frames somewhere in the export scope, not necessarily among
  // the rendered page roots — index every node so the dialog body can be rendered from the same
  // markup path a page would use. Without this the emitter ships `<dialog>` shells with nothing
  // inside them and a modal-heavy prototype exports as blank sheets.
  const irNodesById = new Map<string, IrNode>()
  const indexNode = (node: IrNode): void => {
    irNodesById.set(node.id, node)
    if ('children' in node) for (const child of node.children) indexNode(child)
  }
  for (const root of pageRoots) indexNode(root)
  for (const root of rendered) indexNode(root)

  // M9: emit interactions.css (hover/press transitions) + interactions.js (overlay dialogs).
  const {
    css: interactionsCss,
    js: interactionsJs,
    overlayDialogs,
    triggerAttributes,
  } = await emitInteractions(rendered, sceneNodesById, {
    bootstrapModals: bootstrapComponents,
    imageUrlsByNodeId: opts.stateImageUrlsByNodeId,
    renderOverlayBody: (destinationId) => {
      const destination = irNodesById.get(destinationId)
      return destination
        ? renderOverlayFragment(destination, sceneNodesById, registry, navMap, bootstrapComponents)
        : undefined
    },
  })

  // Prototype page-to-page transitions (DISSOLVE/PUSH/MOVE/SLIDE/SMART_ANIMATE). Django serves a
  // multi-page document, so these are cross-document view transitions: declarative CSS, no router.
  const { css: transitionsCss, js: transitionsJs } = emitPageTransitions({
    nodes: rendered,
    pageRootIds: new Set(rendered.map((root) => root.id)),
  })

  // Thread overlay <dialog> markup into the page templates that carry overlay triggers. Membership
  // is decided by walking each page's own tree: matching the trigger's id against the FILE PATH
  // (the previous rule) only ever hit pages whose own root id happened to contain the trigger id
  // as a substring — so a trigger anywhere below the root, which is every real case, produced a
  // dialog with no markup on any page and a JS opener pointing at a missing element.
  if (overlayDialogs.size > 0) {
    const pagePathByNodeId = new Map<string, string>()
    for (const [path, html] of Object.entries(pages)) {
      const root = rendered.find((candidate) => fileNodeIds[path] === candidate.id)
      if (!root || !html) continue
      const claim = (node: IrNode): void => {
        if (!pagePathByNodeId.has(node.id)) pagePathByNodeId.set(node.id, path)
        if ('children' in node) for (const child of node.children) claim(child)
      }
      claim(root)
    }
    for (const [nodeId, dialogs] of overlayDialogs) {
      // A trigger that only renders inside a component partial has no single owning page; the
      // start page hosts the dialog so the markup exists at least once, and `<dialog>` outside the
      // trigger's own subtree is fine — `showModal()` finds it by id.
      const path = pagePathByNodeId.get(nodeId) ?? Object.keys(pages).find((candidate) => fileNodeIds[candidate] === startPageId)
      if (!path) continue
      pages[path] = pages[path].replace('{% endblock %}', `  ${dialogs.join('\n  ')}\n{% endblock %}`)
    }
  }

  // REFORM phase 7: wire modal triggers through Bootstrap's data API — the trigger element
  // (wherever it renders: page or partial) gains data-bs-toggle/-target attributes.
  if (triggerAttributes.size > 0) {
    for (const [path, html] of Object.entries(pages)) pages[path] = injectTriggerAttributes(html, triggerAttributes)
    for (const [path, html] of Object.entries(partials)) partials[path] = injectTriggerAttributes(html, triggerAttributes)
  }

  // REFORM phase 6 / B2: at utilities fidelity (or above), exact-scale layout declarations
  // move from project.css onto Bootstrap utility classes in the templates. Runs AFTER the
  // breakpoint @media merge and interactions emit so their overrides can protect properties
  // from `!important` utilities (see frameworks/bootstrap/utilities.ts).
  if (opts.framework && (opts.framework.fidelity === 'utilities' || opts.framework.fidelity === 'components' || opts.framework.fidelity === 'theme')) {
    const utilized = applyBootstrapUtilities({ css, interactionsCss, pages, partials })
    css = utilized.css
    Object.assign(pages, utilized.pages)
    Object.assign(partials, utilized.partials)
  }

  // REFORM phase 14 (B): the kit masters ARE the theme — per-component Bootstrap variable sets
  // extracted from the sets this export references. Empty below theme fidelity.
  const themeCss = opts.framework?.fidelity === 'theme' && opts.themeSets?.length ? buildBootstrapTheme(opts.themeSets) : ''

  // The families the CSS actually uses become best-effort webfont links in base.html.
  const fontFamilies = [...new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((match) => match[1]))]
  const baseHtml = wrapGenerated(
    BASE_HTML_NODE_ID,
    emitBaseHtml(
      opts.cssFile,
      opts.tokensCssFile ?? 'css/tokens.css',
      fontFamilies,
      {
        interactionsCss: interactionsCss.length > 0,
        interactionsJs: interactionsJs.length > 0,
        ...(opts.animationLinks ?? { animationsCss: false, animationsJs: false, gsapPlugins: [] }),
      },
      opts.framework ? { ...opts.framework, themeCssFile: themeCss.length > 0 ? 'css/bootstrap-theme.css' : null } : null,
      {
        transitionsCss: transitionsCss.length > 0,
        transitionsJs: transitionsJs.length > 0,
        languageSwitcher: opts.languageSwitcher === true,
      }
    )
  )
  fileNodeIds['base.html'] = BASE_HTML_NODE_ID

  return {
    baseHtml,
    pages,
    partials,
    css,
    interactionsCss,
    interactionsJs,
    themeCss,
    transitionsCss,
    transitionsJs,
    pageRoutes,
    notes,
    fileNodeIds,
  }
}
