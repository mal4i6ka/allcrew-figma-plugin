/**
 * Emits the Django template for a Django export (T3.1): a `{% load static %}` header, a
 * `<link>` to the CSS file `emitCss` produced, and the IR tree walked depth-first into
 * class-only markup (no inline styles — every visual property lives in the CSS file).
 *
 * T4.3/E4 integration: text nodes render as `{% translate %}`/`{% blocktranslate %}` instead of
 * raw characters (docs/research/03-i18n-figma-django.md §3.2, §2.2) — see `renderTextSpans`.
 */

import type { IrNode } from './ir.ts'
import { isVideoAssetPath, rasterFilename, scaleModeToObjectFit } from './assets.ts'
import { toClassName, type DjangoNodeSource } from './css-emitter.ts'
import { segmentClassName, splitTextParagraphs, isMultiBlockText, TEXT_SEGMENT_FIELDS, type TextParagraph } from './text-styles.ts'
import { parsePluginData, PluginDataKey, PLUGIN_DATA_NAMESPACE } from '../../utils/plugin-data.ts'

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** `%(name)s` tokens a designer typed as a placeholder (docs/research/03-i18n-figma-django.md
 * §3.2). Gettext's own form, which is what `i18n/keys.ts`'s `applyPlaceholders` writes into the
 * msgid: the older `{name}` spelling here meant the catalog and the template disagreed about what
 * a placeholder even looks like, so a `{% blocktranslate %}` was emitted for text no catalog entry
 * matched (and vice versa). */
const PLACEHOLDER_PATTERN = /%\((\w+)\)s/g

/** Wraps already-`escapeHtml`-escaped text for E4/T4.3's Django i18n integration: plain text
 * becomes `{% translate %}`, text carrying `%(name)s` placeholders becomes `{% blocktranslate %}`
 * with an explicit `with name=name` clause per placeholder — `blocktranslate` is required because
 * `translate` only takes a literal string or a single variable, never an interpolated one.
 *
 * Newline runs collapse to a single space first: Django's tag lexer does not match `{% … %}`
 * across lines, so a multi-line Figma text node would emit a tag the engine serves as literal
 * text. This mirrors i18n/normalize.ts, keeping the msgid identical to the one figma.po carries. */
function wrapTranslatable(escaped: string, msgctxt = ''): string {
  if (!escaped) return escaped
  escaped = escaped.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
  // `msgctxt` is a string literal in the tag, not markup: it needs gettext's own `\`/`"` escaping
  // (what `i18n/po.ts` writes into the catalog), never `escapeHtml` — an HTML-escaped context
  // would look up a msgctxt no catalog entry carries, which fails by silently not translating.
  const context = msgctxt ? ` context "${msgctxt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
  const names = [...new Set([...escaped.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))]
  if (names.length === 0) return `{% translate "${escaped}"${context} %}`

  const withClause = names.map((name) => `${name}=${name}`).join(' ')
  const body = escaped.replace(PLACEHOLDER_PATTERN, (_match, name: string) => `{{ ${name} }}`)
  return `{% blocktranslate${context} with ${withClause} %}${body}{% endblocktranslate %}`
}

/** The manual `msgctxt` a designer attached to a TEXT node through the annotation panel
 * (`i18n/annotation.ts`, stored under `pluginData('i18nKey')`). `i18n/extract.ts` already writes
 * it into the catalog; without reading it back here the template asks gettext for the
 * NO-context translation, which no entry in that catalog has — the string renders untranslated
 * with nothing anywhere reporting a miss. */
function readMsgctxt(source: DjangoNodeSource | undefined): string {
  const annotation = parsePluginData<{ context?: unknown }>(
    source?.getSharedPluginData?.(PLUGIN_DATA_NAMESPACE, PluginDataKey.I18N_KEY)
  )
  return typeof annotation?.context === 'string' ? annotation.context : ''
}

interface TextSpanLike {
  readonly characters: string
  readonly hyperlink?: { readonly type: 'URL' | 'NODE'; readonly value: string } | null
}

/** A `NODE` hyperlink targets another Figma node, not a URL this export can resolve to a Django
 * route — rendered as plain text, same as `i18n/extract.ts`, which emits one plain-text entry per
 * styled run and never special-cases a `NODE` link either, so the visible markup and the msgid
 * stay in sync. */
function renderSegmentSpan(className: string, index: number, segment: TextSpanLike, msgctxt = ''): string {
  const span = `<span class="${segmentClassName(className, index)}">${wrapTranslatable(escapeHtml(segment.characters), msgctxt)}</span>`
  if (segment.hyperlink?.type === 'URL') return `<a href="${escapeHtml(segment.hyperlink.value)}">${span}</a>`
  return span
}

/** Renders one `<span>` per `getStyledTextSegments` run, each wrapping its own translatable text
 * (docs §3.2) — shared by the single-page emitter and the components/pages emitter so both sides
 * of a `{% include %}` produce identically-tagged msgids. A `URL` hyperlink segment additionally
 * wraps its span in `<a href>`. */
export function renderTextSpans(className: string, segments: readonly TextSpanLike[], msgctxt = ''): string {
  return segments.map((segment, index) => renderSegmentSpan(className, index, segment, msgctxt)).join('')
}

function renderParagraphRuns(
  className: string,
  runs: readonly { readonly segment: TextSpanLike; readonly index: number }[],
  msgctxt: string
): string {
  return runs.map(({ segment, index }) => renderSegmentSpan(className, index, segment, msgctxt)).join('')
}

/** Builds nested `<ul>`/`<ol>` markup from a flat run of same-block list paragraphs, using each
 * paragraph's `listDepth` (Figma's `getRangeIndentation`) to nest — a depth increase opens a new
 * list inside the current `<li>`, a decrease (or run end) closes back out. Depth jumps of more
 * than one level (skipping an indentation step) collapse onto the next level down rather than
 * inserting empty intermediate lists — an edge case Figma's own UI doesn't produce today. */
function renderTextList<T extends TextSpanLike>(
  items: readonly TextParagraph<T>[],
  className: string,
  indent: string,
  msgctxt: string
): string {
  let i = 0
  function parseLevel(depth: number, ind: string): string {
    const tag = items[i].listType === 'ORDERED' ? 'ol' : 'ul'
    const lines: string[] = [`${ind}<${tag} class="${className}--list">`]
    while (i < items.length && items[i].listDepth === depth) {
      const item = items[i]
      i++
      let content = `${renderParagraphRuns(className, item.runs, msgctxt)}`
      if (i < items.length && items[i].listDepth > depth) {
        content += `\n${parseLevel(depth + 1, `${ind}  `)}\n${ind}  `
      }
      lines.push(`${ind}  <li class="${className}">${content}</li>`)
    }
    lines.push(`${ind}</${tag}>`)
    return lines.join('\n')
  }
  return parseLevel(items[0].listDepth, indent)
}

/** Renders a text node's paragraphs/list items once it's been determined they don't fit on one
 * `<p>` — a run of consecutive non-list paragraphs becomes one `<p>` each, a run of consecutive
 * list paragraphs becomes one nested `<ul>`/`<ol>`. */
function renderTextBody<T extends TextSpanLike>(
  paragraphs: readonly TextParagraph<T>[],
  className: string,
  indent: string,
  msgctxt: string
): string {
  const blocks: string[] = []
  let i = 0
  while (i < paragraphs.length) {
    if (paragraphs[i].listType === 'NONE') {
      blocks.push(`${indent}<p class="${className}">${renderParagraphRuns(className, paragraphs[i].runs, msgctxt)}</p>`)
      i++
      continue
    }
    const run: TextParagraph<T>[] = []
    while (i < paragraphs.length && paragraphs[i].listType !== 'NONE') {
      run.push(paragraphs[i])
      i++
    }
    blocks.push(renderTextList(run, className, indent, msgctxt))
  }
  return blocks.join('\n')
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
export type HeadingTag = `h${HeadingLevel}`

/** Tracks whether this document has already emitted its one `<h1>` (docs item 2 — "exactly one
 * `<h1>` per page"). Threaded by reference through every text node a single `emitHtml`/`emitPage`/
 * `emitComponentPartial` call renders, in document order, so a second level-1 claimant degrades to
 * `<h2>` instead of the page shipping two `<h1>`s. */
export interface HeadingState {
  usedH1: boolean
}

export function createHeadingState(): HeadingState {
  return { usedH1: false }
}

/** The ONLY heading evidence trusted here: an explicit level spelled out in the TEXT node's own
 * layer name — "H2", "Heading 2", "Title/H3" (docs item 2). Neither `ir.ts` nor `DjangoNodeSource`
 * exposes the Figma *text style*'s own name the way `IrStyleRefs` resolves a fill/stroke/effect
 * style to one (`ir.ts`'s `readStyleRefs` never reads `textStyleId` at all) — the layer name is
 * genuinely the only heading signal this emitter can read. Font size (`TextStyleSegment.fontSize`)
 * is deliberately never consulted: a big label isn't necessarily structural, and mistagging body
 * copy as a heading misleads a screen reader worse than leaving it a plain `<p>`. */
function explicitHeadingLevel(name: string): HeadingLevel | null {
  const tokens = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].toLowerCase()
    const explicit = /^h([1-6])$/.exec(token) ?? /^heading([1-6])$/.exec(token)
    if (explicit) return Number(explicit[1]) as HeadingLevel
    if (token === 'heading' && /^[1-6]$/.test(tokens[i + 1] ?? '')) return Number(tokens[i + 1]) as HeadingLevel
  }
  return null
}

/** Resolves the `<hN>` tag a TEXT node's layer name claims, enforcing "exactly one `<h1>` per
 * page": the first level-1 claimant in document order keeps `<h1>`, every later one degrades to
 * `<h2>` (still a heading, just not a second top-level one). `null` means no explicit level was
 * found — the caller keeps its default `<p>`. */
export function resolveHeadingTag(name: string, state: HeadingState): HeadingTag | null {
  const level = explicitHeadingLevel(name)
  if (level === null) return null
  if (level === 1) {
    if (state.usedH1) return 'h2'
    state.usedH1 = true
    return 'h1'
  }
  return `h${level}`
}

/** Renders a text node's full content: a single `<p>` (or, per `headingTag`, `<h1>`…`<h6>` — docs
 * item 2) for the common case (one paragraph, no list), or a `<div class="…--box">` wrapper
 * carrying the node's position/sizing around several `<p>`/`<ul>`/`<ol>` children when the text
 * has multiple paragraphs and/or a list — see css-emitter.ts's `collectNodeCss` for why the box
 * rule has to move to that wrapper in that case. A heading is a single run of text, never a
 * wrapper around block children, so `headingTag` is only honored on the single-`<p>` path — the
 * multi-block branch always keeps its plain `<p>`/`<div>` shape. Shared by the single-page emitter
 * and the components/pages emitter (`component-emitter.ts`) so every text node renders
 * identically regardless of which template it lands in. */
export function renderTextBlock(
  node: { readonly id: string; readonly characters: string },
  source: DjangoNodeSource | undefined,
  className: string,
  indent: string,
  headingTag: HeadingTag | null = null
): string {
  const segments: readonly TextSpanLike[] = source?.getStyledTextSegments?.(TEXT_SEGMENT_FIELDS) ?? [{ characters: node.characters }]
  const paragraphs = splitTextParagraphs(segments)
  const msgctxt = readMsgctxt(source)
  if (!isMultiBlockText(paragraphs)) {
    const tag = headingTag ?? 'p'
    return `${indent}<${tag} class="${className}">${renderTextSpans(className, segments, msgctxt)}</${tag}>`
  }
  const inner = renderTextBody(paragraphs, className, `${indent}  `, msgctxt)
  return `${indent}<div class="${className}--box">\n${inner}\n${indent}</div>`
}

function renderTextNode(
  node: Extract<IrNode, { type: 'text' }>,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  indent: string,
  headingState: HeadingState
): string {
  const className = toClassName(node.id)
  const headingTag = resolveHeadingTag(node.name, headingState)
  return renderTextBlock(node, sceneNodesById.get(node.id), className, indent, headingTag)
}

/** Figma's own auto-generated name for a layer nobody renamed — "Rectangle 12", "Vector",
 * "Ellipse 3", "Image 4", "Frame 1", "Group 7" (shape/type keyword + optional index) — carries no
 * information a screen reader can use; neither does a name that's only digits/punctuation, nor
 * one starting with `_` (Figma's community "ignore me" convention). Reading any of those out loud
 * is worse than reading nothing (docs item 4), so `renderAssetLeaf` emits an empty `alt` for them
 * instead of the raw layer name. */
const AUTO_NAMED_LAYER = /^(rectangle|vector|ellipse|image|frame|group)\s*\d*$/i

export function isDecorativeLayerName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.startsWith('_')) return true
  if (!/[a-zA-Z]/.test(trimmed)) return true
  return AUTO_NAMED_LAYER.test(trimmed)
}

/** `static`-relative path for an unmarked image leaf — must name the exact file the asset pass
 * writes for it (`exportRasterAsset` → T2.4's `rasterFilename`, 1x PNG under `static/img/`),
 * or the template references a file that never ships. */
export function imageStaticPath(node: Extract<IrNode, { type: 'image' }>): string {
  return `img/${rasterFilename(node.id, node.name, 'png', 1)}`
}

/** Renders an image/vector asset leaf — shared by the single-template emitter and the project
 * emitter's page/partial renderers so marked graphics reference the same exported file everywhere.
 * A graphic with an exported file (`assetSrc`) renders as a `<video>` for MP4/WEBM primaries and
 * an `<img>` otherwise; a small unmarked vector inlines its SVG (`inlineSvg`, annotated by
 * `annotateVectorLeaves`); a vector with neither stays a placeholder div. M11: `<video>` carries
 * `poster`, `preload="metadata"`, and `object-fit` derived from the VideoPaint `scaleMode`. */
export function renderAssetLeaf(node: Extract<IrNode, { type: 'image' | 'vector' }>, indent: string): string {
  const className = toClassName(node.id)
  const decorative = isDecorativeLayerName(node.name)
  if (node.type === 'vector' && !node.assetSrc && node.inlineSvg) {
    // Tag the <svg> root with the node's class so the emitted sizing/position rules apply to it.
    // A decorative/auto-named layer additionally gets aria-hidden (docs item 4) — there's no
    // `alt` attribute on `<svg>`, so this is how the same "don't announce this" signal reaches
    // assistive tech for an inlined vector.
    const svgAttrs = decorative ? ` class="${className}" aria-hidden="true"` : ` class="${className}"`
    return `${indent}${node.inlineSvg.replace(/<svg\b/, `<svg${svgAttrs}`)}`
  }
  const src = node.type === 'image' ? node.assetSrc ?? imageStaticPath(node) : node.assetSrc
  if (!src) return `${indent}<div class="${className}"></div>`
  if (isVideoAssetPath(src)) {
    // M11: full video attributes — autoplay/loop/muted/playsinline for canvas-playback parity,
    // poster for a still before load, preload="metadata" for fast first paint, object-fit from
    // the VideoPaint scaleMode. The poster path is on the IR node (serializeShape set it); when
    // absent (a designer-marked MP4 with no separate poster export), the attribute is omitted.
    const poster = node.type === 'image' && node.posterSrc ? ` poster="{% static '${node.posterSrc}' %}"` : ''
    const objectFit = scaleModeToObjectFit(node.type === 'image' ? node.videoScaleMode : undefined)
    return `${indent}<video class="${className}" data-autoplay-video src="{% static '${src}' %}"${poster} autoplay loop muted playsinline preload="metadata" style="object-fit:${objectFit}"></video>`
  }
  return `${indent}<img class="${className}" src="{% static '${src}' %}" alt="${decorative ? '' : escapeHtml(node.name)}">`
}

/** Wraps `rendered` in `<a href="{{ navMap.<slug> }}">` when `node` carries an `ON_CLICK`/
 * `MOUSE_UP` NAVIGATE reaction (M9, `ir.ts`'s `readNavigateReaction`) whose destination resolved
 * to a slug in `navMap` — the DoD's replacement for a JS click-listener/`window.location`
 * approach. The actual URL isn't known at export time; the Django view supplies a
 * `{ <slug>: <url> }` context dict named `navMap`, so this only has to emit the right lookup.
 * `display:contents` keeps the anchor from changing the wrapped element's box model regardless of
 * whether it renders as a block `<div>` or an inline `<img>`/`<svg>` — every kind this emitter
 * produces is sized/positioned by its own class, not by the wrapping tag. A destination outside
 * the exported page set (no `navMap` entry) is logged and left unwrapped rather than aborting the
 * export — the same "warn and skip" pattern `ir.ts`'s `readComponentProperties` comment documents
 * for unreadable component properties. */
export function wrapNavigate(node: IrNode, rendered: string, indent: string, navMap: ReadonlyMap<string, string>): string {
  const destinationId = node.navigate?.destinationId
  if (!destinationId) return rendered
  const slug = navMap.get(destinationId)
  if (!slug) {
    console.warn(`"${node.name}" has a NAVIGATE reaction to "${destinationId}", which isn't in the exported page set — skipping <a> wrap`)
    return rendered
  }
  return `${indent}<a href="{{ navMap.${slug} }}" style="display:contents">\n${rendered}\n${indent}</a>`
}

/** M11: renders a positioned `<video>` background layer for a container/instance carrying a
 * `backgroundVideo` (VideoPaint fill). The layer sits behind the content with absolute positioning,
 * fills the container (inset:0), and gets `object-fit` from the VideoPaint `scaleMode`. The
 * container's own CSS class handles `overflow:hidden` + `position:relative` (clip + positioning
 * context). The video carries autoplay/loop/muted/playsinline + poster + preload for canvas-parity
 * playback; a `data-autoplay-video` attribute lets the reduced-motion JS find and pause it. */
export function renderBackgroundVideoLayer(node: IrNode, indent: string): string | null {
  const bv = 'backgroundVideo' in node ? node.backgroundVideo : undefined
  if (!bv) return null
  const objectFit = scaleModeToObjectFit(bv.scaleMode)
  const className = toClassName(node.id)
  // videoUnavailable (annotateVideoFills): the Figma API refused the MP4 export, so the zip ships
  // only the poster — but the markup stays a full <video src poster>. The browser shows the poster
  // while the src 404s, and the moment the user drops the real file at the assetSrc path (listed
  // in export-report.json manualAssets) it plays — no re-export needed, and the apply script never
  // deletes manually placed files.
  return (
    `${indent}<video class="${className}__bg-video" data-autoplay-video src="{% static '${bv.assetSrc}' %}"` +
    ` poster="{% static '${bv.posterSrc}' %}" autoplay loop muted playsinline preload="metadata"` +
    // z-index:-2 (was 0): Figma paints fills bottom-up with the video usually at the bottom and
    // scrims/gradients ABOVE it — as a child element at z:0 the video covered the container's css
    // background (the upper fills), inverting the order. Now: video (-2) < upper-fills ::before
    // (-1, css-emitter) < content. The css-emitter puts `isolation: isolate` on every bg-video
    // container so the negative-z layers can't escape behind ancestor backgrounds.
    ` style="position:absolute;inset:0;width:100%;height:100%;object-fit:${objectFit};z-index:-2;pointer-events:none"></video>`
  )
}

/** Chrome landmark kinds a container's Figma layer name can identify (docs item 1) — matching is
 * EXACT (case-insensitive, trimmed) against Figma's own naming convention for these regions, not
 * a loose substring: "Header Section" or "Navigation Bar Wrapper" stay plain `<div>`s rather than
 * risk mistagging an unrelated frame that merely mentions the word. */
export type LandmarkKind = 'header' | 'nav' | 'footer' | 'aside'

const LANDMARK_KIND_BY_NAME: Record<string, LandmarkKind> = {
  header: 'header',
  'top bar': 'header',
  navbar: 'header',
  nav: 'nav',
  menu: 'nav',
  navigation: 'nav',
  footer: 'footer',
  sidebar: 'aside',
  aside: 'aside',
}

/** Figma's component-set/breakpoint suffix convention ("Header / Desktop", "Footer / Mobile")
 * doubles as noise here — only the part before the first "/" carries the semantic name. */
function landmarkKindByName(name: string): LandmarkKind | null {
  const firstSegment = name.split('/')[0].trim().toLowerCase()
  return LANDMARK_KIND_BY_NAME[firstSegment] ?? null
}

/** Landmark kinds already emitted on the path from the document root to this node — threaded
 * through the recursive renderer so a landmark-named node nested inside a SAME-kind landmark (a
 * duplicated/synthetic layer, not a pattern Figma's own UI encourages) never emits a second
 * `<header>`/`<nav>`/`<footer>`/`<aside>`: only the outermost match of each kind fires. A
 * DIFFERENT kind nested inside (a `<nav>` inside a `<header>`, say — a Navbar's own nav list) is
 * left alone; that's valid HTML and a real pattern. */
export type LandmarkAncestry = ReadonlySet<LandmarkKind>
export const NO_LANDMARK_ANCESTRY: LandmarkAncestry = new Set()

/** `<button>`-worthy: an `ON_CLICK`/`MOUSE_UP` CHANGE_TO interaction (`ir.ts`'s `readInteractions`
 * already normalizes MOUSE_UP into the same `'ON_CLICK'` trigger) with no NAVIGATE reaction — a
 * real click target belongs behind a `<button>` a keyboard/screen reader can reach, not the `<div>`
 * neither can. A `navigate` reaction wins outright instead: `wrapNavigate` already puts the node
 * behind a real `<a href>`, and a `<button>` nested inside an `<a>` is invalid HTML (interactive
 * content cannot contain further interactive content) — the two paths can never both fire. */
function isClickButton(node: IrNode): boolean {
  if (node.navigate) return false
  return (node.interactions ?? []).some((interaction) => interaction.trigger === 'ON_CLICK')
}

/** Resolves the semantic element for a `container`/`instance-ref` node that would otherwise emit
 * a bare `<div>`: a landmark name wins outright (item 1); failing that, a click interaction makes
 * it a real `<button type="button">` (item 3); failing that, an unnamed direct child of the page
 * root with content of its own becomes a `<section>` — the one generic promotion item 1 asks for,
 * since a page's own top-level regions are structure worth surfacing even with no specific chrome
 * name. Everything else keeps the conservative default: `<div>`. Returns the matched
 * `landmarkKind` too (or `null`), so the caller can extend `LandmarkAncestry` for this node's own
 * children without re-deriving it. */
export function resolveContainerTag(
  node: Extract<IrNode, { type: 'container' | 'instance-ref' }>,
  ancestry: LandmarkAncestry,
  isPageRootChild: boolean
): { tag: string; attrs: string; landmarkKind: LandmarkKind | null } {
  const landmarkKind = landmarkKindByName(node.name)
  if (landmarkKind && !ancestry.has(landmarkKind)) return { tag: landmarkKind, attrs: '', landmarkKind }
  if (isClickButton(node)) return { tag: 'button', attrs: ' type="button"', landmarkKind: null }
  if (isPageRootChild && node.children.length > 0) return { tag: 'section', attrs: '', landmarkKind: null }
  return { tag: 'div', attrs: '', landmarkKind: null }
}

function renderNode(
  node: IrNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  indent: string,
  navMap: ReadonlyMap<string, string>,
  headingState: HeadingState,
  ancestry: LandmarkAncestry = NO_LANDMARK_ANCESTRY,
  isPageRootChild = false,
  isPageRoot = true
): string {
  const className = toClassName(node.id)

  const rendered = (() => {
    switch (node.type) {
      case 'text':
        return renderTextNode(node, sceneNodesById, indent, headingState)
      case 'image':
      case 'vector':
        return renderAssetLeaf(node, indent)
      case 'container':
      case 'instance-ref': {
        const { tag, attrs, landmarkKind } = resolveContainerTag(node, ancestry, isPageRootChild)
        const childAncestry = landmarkKind ? new Set([...ancestry, landmarkKind]) : ancestry
        // M11: a VideoPaint background fill renders as a positioned <video> layer behind content.
        const bgVideo = renderBackgroundVideoLayer(node, `${indent}  `)
        if (node.children.length === 0 && !bgVideo) return `${indent}<${tag}${attrs} class="${className}"></${tag}>`
        const inner = node.children
          .map((child) => renderNode(child, sceneNodesById, `${indent}  `, navMap, headingState, childAncestry, isPageRoot, false))
          .join('\n')
        // The background video layer goes first (lowest z-index), children stack above it.
        const parts = [bgVideo, inner].filter(Boolean)
        return `${indent}<${tag}${attrs} class="${className}">\n${parts.join('\n')}\n${indent}</${tag}>`
      }
    }
  })()
  return wrapNavigate(node, rendered, indent, navMap)
}

/** M11: the shared JS snippet that pauses every autoplay `<video>` (leaf or background layer) under
 * `prefers-reduced-motion: reduce`. One script per page, sourced via a `<script>` tag at the end
 * of `<body>` so it runs after the DOM is parsed. The `data-autoplay-video` attribute (set on every
 * `<video>` the emitter produces) is the selector hook — no class-name coupling. */
const REDUCED_MOTION_VIDEO_SNIPPET = `<script>
(function(){var mq=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)');
if(mq&&mq.matches){document.querySelectorAll('video[data-autoplay-video]').forEach(function(v){v.pause();v.removeAttribute('autoplay');});}})();
</script>`

/** Emits the full Django template. `cssFile` is a `static`-relative path, e.g. `"css/project.css"`.
 * `navMap` maps a NAVIGATE reaction's Figma destination node id to its exported-page slug — see
 * `wrapNavigate`. Defaults to empty: a flat single-template export has no other page to link to,
 * so any NAVIGATE reaction here degrades to "skip with warning". M11: when the body contains at
 * least one autoplay `<video>`, the reduced-motion pause snippet is injected before `</body>`. */
export function emitHtml(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  cssFile: string,
  navMap: ReadonlyMap<string, string> = new Map()
): string {
  const headingState = createHeadingState()
  const body = nodes.map((node) => renderNode(node, sceneNodesById, '    ', navMap, headingState)).join('\n')
  const hasAutoplayVideo = body.includes('data-autoplay-video')

  return [
    '{% load static %}',
    '{% load i18n %}',
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <link rel="stylesheet" href="{% static '${cssFile}' %}">`,
    '</head>',
    '<body>',
    body,
    hasAutoplayVideo ? REDUCED_MOTION_VIDEO_SNIPPET : '',
    '</body>',
    '</html>',
  ].filter(Boolean).join('\n')
}
