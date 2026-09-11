/**
 * Export file tree assembly (T6.2, docs/PLAN.md E6): combines every emitter's output — Django
 * templates/partials (T3.1/T3.2), `tokens.css` (T1.3), the generated layout/component stylesheet
 * (T3.1), image/vector assets (T2.4), and `figma.po` (T4.1) — into the flat `{ path: content }`
 * map the UI iframe zips and downloads (`ui.html`'s `FILES_READY` handler).
 */

import type { EmitDjangoProjectOutput } from '../index.ts'
import type { ExportAsset } from './assets.ts'

export type ExportFileContent = string | Uint8Array

export interface BuildExportTreeOptions {
  project: EmitDjangoProjectOutput
  /** `tokens.css` content (T1.3's `emitTokensCss`). */
  tokensCss: string
  /** `static`-relative path the stylesheet is written under (e.g. `css/project.css`) — the same
   * `cssFile` passed to `emitDjangoProject`, whose base.html links `{% static '<cssFile>' %}`.
   * The zip path is `static/<cssFile>` so the template reference and the staticfiles finder
   * resolve to the same file. */
  cssFile: string
  /** `locale/figma.po` content (T4.1 extraction serialized by `emitPo`); omitted when there is nothing to translate. */
  po?: string
  /** Per-locale catalogs (`emitLocaleCatalogs`), keyed by their full `locale/<lang>/LC_MESSAGES/
   * django.po` path — the files `makemessages`/`compilemessages` and Django's own `LOCALE_PATHS`
   * expect. `figma.po` alone is a translation source, not something Django ever loads. */
  localeCatalogs?: Record<string, string>
  /** The Django project itself (`emitDjangoScaffold`) — `manage.py`, settings/urls/views, the page
   * registry. Absent when the package is laid onto a project that already has one. */
  scaffold?: Record<string, string>
  assets?: readonly ExportAsset[]
  /** M10 Motion outputs; empty strings mean the selected export produced no timelines for that backend. */
  animation?: {
    readonly css: string
    readonly js: string
  }
}

/**
 * Assembles the file tree docs/research/04-figma-to-django-templates.md §3.3 describes:
 * `templates/base.html` + `templates/pages/…` + `templates/components/…`, `static/css/tokens.css`
 * + `static/<cssFile>`, `static/img/…`, and `locale/figma.po`.
 *
 * M9: also writes `static/css/interactions.css` and `static/js/interactions.js` when the project
 * produced them (non-empty `interactionsCss`/`interactionsJs` on `EmitDjangoProjectOutput`).
 */
export function buildExportTree(opts: BuildExportTreeOptions): Record<string, ExportFileContent> {
  const files: Record<string, ExportFileContent> = {}

  files['templates/base.html'] = opts.project.baseHtml
  for (const [path, html] of Object.entries(opts.project.pages)) files[`templates/${path}`] = html
  for (const [path, html] of Object.entries(opts.project.partials)) files[`templates/${path}`] = html

  files['static/css/tokens.css'] = opts.tokensCss
  // NOT `static/css/${cssFile}` — cssFile already carries its directory ('css/project.css');
  // prefixing css/ again made base.html's {% static %} link point at a file that didn't exist.
  files[`static/${opts.cssFile}`] = opts.project.css

  // M9: interaction assets — only shipped when the project produced them (non-empty content),
  // so exports without reactions don't get empty files the templates would try to {% static %} link.
  if (opts.project.interactionsCss) files['static/css/interactions.css'] = opts.project.interactionsCss
  if (opts.project.interactionsJs) files['static/js/interactions.js'] = opts.project.interactionsJs
  // REFORM phase 14 (B): the kit-extracted Bootstrap theme — base.html links it when non-empty.
  if (opts.project.themeCss) files['static/css/bootstrap-theme.css'] = opts.project.themeCss
  if (opts.animation?.css) files['static/css/animations.css'] = opts.animation.css
  if (opts.animation?.js) files['static/js/animations.js'] = opts.animation.js
  // Prototype page transitions — same rule: linked from base.html only when they exist.
  if (opts.project.transitionsCss) files['static/css/transitions.css'] = opts.project.transitionsCss
  if (opts.project.transitionsJs) files['static/js/transitions.js'] = opts.project.transitionsJs

  for (const asset of opts.assets ?? []) files[`static/img/${asset.filename}`] = asset.content

  if (opts.po) files['locale/figma.po'] = opts.po
  for (const [path, catalog] of Object.entries(opts.localeCatalogs ?? {})) files[path] = catalog
  // Written last and without overwriting: a scaffold file never replaces a generated template or
  // stylesheet that shares its path (`templates/404.html` is the scaffold's, `templates/base.html`
  // is the emitter's), so the design always wins over the boilerplate.
  for (const [path, content] of Object.entries(opts.scaffold ?? {})) {
    if (!(path in files)) files[path] = content
  }

  return files
}

/**
 * Regeneration download (EMIT_DJANGO_PROJECT → "Preview changes" → Download): the `static/…` assets
 * base.html `{% static %}`-links but `planRegeneration` never diffs — they're regenerated wholesale,
 * not hand-merged like the templates. This assembles the map the UI must add to the zip alongside
 * the merged templates (and the project stylesheet, which travels separately) so the downloaded
 * project doesn't 404 the files its base.html references — the same interactions/tokens set
 * `buildExportTree` writes for a full export. Empty/absent inputs are omitted so no file ships that
 * base.html wouldn't link, and none is linked that doesn't ship.
 *
 * NOTE: `img/` assets (raster/vector/video bytes) are intentionally NOT included — the regen path is
 * a lightweight text-only diff preview that doesn't run the binary asset pass, so a `url(img/…)`
 * reference inside the generated CSS can still 404. That is a pre-existing gap of this path, separate
 * from the base.html `{% static %}`-link 404s this covers.
 */
export function buildRegenStaticFiles(opts: {
  /** `EmitDjangoProjectOutput.interactionsCss` — shipped as `static/css/interactions.css` when non-empty. */
  interactionsCss: string
  /** `EmitDjangoProjectOutput.interactionsJs` — shipped as `static/js/interactions.js` when non-empty. */
  interactionsJs: string
  /** Themed `tokens.css` (`emitTokenArtifacts().css`) — present only when the tokens module is on. */
  tokensCss?: string
  /** Bootstrap `--bs-*` overrides (`emitBootstrapArtifacts().css`) — present only for a bootstrap+tokens export. */
  bootstrapTokensCss?: string
  /** `EmitDjangoProjectOutput.themeCss` (REFORM phase 14 B) — shipped as `static/css/bootstrap-theme.css` when non-empty. */
  themeCss?: string
  /** `EmitDjangoProjectOutput.transitionsCss/Js` — base.html links them, so a regen preview that
   * left them out would 404 exactly the files the page transitions need. */
  transitionsCss?: string
  transitionsJs?: string
}): Record<string, string> {
  const files: Record<string, string> = {}
  if (opts.tokensCss) files['static/css/tokens.css'] = opts.tokensCss
  if (opts.bootstrapTokensCss) files['static/css/bootstrap-tokens.css'] = opts.bootstrapTokensCss
  if (opts.themeCss) files['static/css/bootstrap-theme.css'] = opts.themeCss
  if (opts.interactionsCss) files['static/css/interactions.css'] = opts.interactionsCss
  if (opts.interactionsJs) files['static/js/interactions.js'] = opts.interactionsJs
  if (opts.transitionsCss) files['static/css/transitions.css'] = opts.transitionsCss
  if (opts.transitionsJs) files['static/js/transitions.js'] = opts.transitionsJs
  return files
}
