/**
 * Single entry point for the Django export (T3.1): serializes IR + live node styles into the
 * `templates/<name>.html` and `static/<name>.css` pair E3 consumers write to disk.
 */

import type { IrContainerNode, IrNode } from './ir.ts'
import { emitCss, type DjangoNodeSource } from './css-emitter.ts'
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
} from './component-emitter.ts'
import { wrapGenerated } from './regenerate.ts'
import { detectBreakpointGroups, emitBreakpointCss, type BreakpointTokenMap } from './breakpoint-frames.ts'
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
  /** The Figma node id (or `BASE_HTML_NODE_ID`) behind each `baseHtml`/`pages`/`partials` path —
   * feed straight into `planRegeneration`'s `FreshFile.nodeId` (T3.3) to merge a re-export against
   * a previous one without clobbering hand edits. */
  fileNodeIds: Record<string, string>
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
  const { rendered, groups } = detectBreakpointGroups(pageRoots, opts.breakpointTokens)

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
  for (const root of rendered) {
    const path = pageTemplatePath(root, groupSlugByWidestId.get(root.id))
    pages[path] = wrapGenerated(root.id, emitPage(root, sceneNodesById, registry, navMap, bootstrapComponents))
    fileNodeIds[path] = root.id
  }

  // REFORM phase 14 (C): at theme fidelity, themed kit-button instances trade their mapped pixel
  // props for `--bs-btn-*` var overrides (designer deltas) or drop them (theme-carried). Built
  // before emitCss so the css pass can consult it per node.
  const themedInstances =
    opts.framework?.fidelity === 'theme' && opts.themeSets?.length
      ? collectThemedInstanceMasters(rendered, opts.themeSets)
      : undefined

  let css = await emitCss(rendered, sceneNodesById, variableNamesById, { themedInstances })
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

  // M9: emit interactions.css (hover/press transitions) + interactions.js (overlay dialogs).
  const {
    css: interactionsCss,
    js: interactionsJs,
    overlayDialogs,
    triggerAttributes,
  } = await emitInteractions(rendered, sceneNodesById, { bootstrapModals: bootstrapComponents })

  // Thread overlay <dialog> markup into the page templates that carry overlay triggers.
  if (overlayDialogs.size > 0) {
    for (const [nodeId, dialogs] of overlayDialogs) {
      for (const [path, html] of Object.entries(pages)) {
        if (path.includes(nodeId.replace(/[^a-zA-Z0-9]+/g, '-'))) {
          pages[path] = html.replace('{% endblock %}', `  ${dialogs.join('\n  ')}\n{% endblock %}`)
        }
      }
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
      opts.framework ? { ...opts.framework, themeCssFile: themeCss.length > 0 ? 'css/bootstrap-theme.css' : null } : null
    )
  )
  fileNodeIds['base.html'] = BASE_HTML_NODE_ID

  return { baseHtml, pages, partials, css, interactionsCss, interactionsJs, themeCss, fileNodeIds }
}
