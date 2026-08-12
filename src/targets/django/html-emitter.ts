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

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** `{name}` tokens a designer typed as a placeholder (docs/research/03-i18n-figma-django.md §3.2). */
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

/** Wraps already-`escapeHtml`-escaped text for E4/T4.3's Django i18n integration: plain text
 * becomes `{% translate %}`, text carrying `{name}` placeholders becomes `{% blocktranslate %}`
 * with an explicit `with name=name` clause per placeholder — `blocktranslate` is required because
 * `translate` only takes a literal string or a single variable, never an interpolated one.
 *
 * Newline runs collapse to a single space first: Django's tag lexer does not match `{% … %}`
 * across lines, so a multi-line Figma text node would emit a tag the engine serves as literal
 * text. This mirrors i18n/normalize.ts, keeping the msgid identical to the one figma.po carries. */
function wrapTranslatable(escaped: string): string {
  if (!escaped) return escaped
  escaped = escaped.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
  const names = [...new Set([...escaped.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))]
  if (names.length === 0) return `{% translate "${escaped}" %}`

  const withClause = names.map((name) => `${name}=${name}`).join(' ')
  const body = escaped.replace(PLACEHOLDER_PATTERN, (_match, name: string) => `{{ ${name} }}`)
  return `{% blocktranslate with ${withClause} %}${body}{% endblocktranslate %}`
}

interface TextSpanLike {
  readonly characters: string
  readonly hyperlink?: { readonly type: 'URL' | 'NODE'; readonly value: string } | null
}

/** A `NODE` hyperlink targets another Figma node, not a URL this export can resolve to a Django
 * route — rendered as plain text, same as `i18n/extract.ts`'s po markup (`buildMarkup` only
 * special-cases `type === 'URL'` too), so the visible markup and the msgid stay in sync. */
function renderSegmentSpan(className: string, index: number, segment: TextSpanLike): string {
  const span = `<span class="${segmentClassName(className, index)}">${wrapTranslatable(escapeHtml(segment.characters))}</span>`
  if (segment.hyperlink?.type === 'URL') return `<a href="${escapeHtml(segment.hyperlink.value)}">${span}</a>`
  return span
}

/** Renders one `<span>` per `getStyledTextSegments` run, each wrapping its own translatable text
 * (docs §3.2) — shared by the single-page emitter and the components/pages emitter so both sides
 * of a `{% include %}` produce identically-tagged msgids. A `URL` hyperlink segment additionally
 * wraps its span in `<a href>`. */
export function renderTextSpans(className: string, segments: readonly TextSpanLike[]): string {
  return segments.map((segment, index) => renderSegmentSpan(className, index, segment)).join('')
}

function renderParagraphRuns(className: string, runs: readonly { readonly segment: TextSpanLike; readonly index: number }[]): string {
  return runs.map(({ segment, index }) => renderSegmentSpan(className, index, segment)).join('')
}

/** Builds nested `<ul>`/`<ol>` markup from a flat run of same-block list paragraphs, using each
 * paragraph's `listDepth` (Figma's `getRangeIndentation`) to nest — a depth increase opens a new
 * list inside the current `<li>`, a decrease (or run end) closes back out. Depth jumps of more
 * than one level (skipping an indentation step) collapse onto the next level down rather than
 * inserting empty intermediate lists — an edge case Figma's own UI doesn't produce today. */
function renderTextList<T extends TextSpanLike>(items: readonly TextParagraph<T>[], className: string, indent: string): string {
  let i = 0
  function parseLevel(depth: number, ind: string): string {
    const tag = items[i].listType === 'ORDERED' ? 'ol' : 'ul'
    const lines: string[] = [`${ind}<${tag} class="${className}--list">`]
    while (i < items.length && items[i].listDepth === depth) {
      const item = items[i]
      i++
      let content = `${renderParagraphRuns(className, item.runs)}`
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
function renderTextBody<T extends TextSpanLike>(paragraphs: readonly TextParagraph<T>[], className: string, indent: string): string {
  const blocks: string[] = []
  let i = 0
  while (i < paragraphs.length) {
    if (paragraphs[i].listType === 'NONE') {
      blocks.push(`${indent}<p class="${className}">${renderParagraphRuns(className, paragraphs[i].runs)}</p>`)
      i++
      continue
    }
    const run: TextParagraph<T>[] = []
    while (i < paragraphs.length && paragraphs[i].listType !== 'NONE') {
      run.push(paragraphs[i])
      i++
    }
    blocks.push(renderTextList(run, className, indent))
  }
  return blocks.join('\n')
}

/** Renders a text node's full content: a single `<p>` for the common case (one paragraph, no
 * list), or a `<div class="…--box">` wrapper carrying the node's position/sizing around several
 * `<p>`/`<ul>`/`<ol>` children when the text has multiple paragraphs and/or a list — see
 * css-emitter.ts's `collectNodeCss` for why the box rule has to move to that wrapper in that
 * case. Shared by the single-page emitter and the components/pages emitter (`component-emitter.ts`)
 * so every text node renders identically regardless of which template it lands in. */
export function renderTextBlock(
  node: { readonly id: string; readonly characters: string },
  source: DjangoNodeSource | undefined,
  className: string,
  indent: string
): string {
  const segments: readonly TextSpanLike[] = source?.getStyledTextSegments?.(TEXT_SEGMENT_FIELDS) ?? [{ characters: node.characters }]
  const paragraphs = splitTextParagraphs(segments)
  if (!isMultiBlockText(paragraphs)) {
    return `${indent}<p class="${className}">${renderTextSpans(className, segments)}</p>`
  }
  const inner = renderTextBody(paragraphs, className, `${indent}  `)
  return `${indent}<div class="${className}--box">\n${inner}\n${indent}</div>`
}

function renderTextNode(
  node: Extract<IrNode, { type: 'text' }>,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  indent: string
): string {
  const className = toClassName(node.id)
  return renderTextBlock(node, sceneNodesById.get(node.id), className, indent)
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
  if (node.type === 'vector' && !node.assetSrc && node.inlineSvg) {
    // Tag the <svg> root with the node's class so the emitted sizing/position rules apply to it.
    return `${indent}${node.inlineSvg.replace(/<svg\b/, `<svg class="${className}"`)}`
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
  return `${indent}<img class="${className}" src="{% static '${src}' %}" alt="${escapeHtml(node.name)}">`
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

function renderNode(
  node: IrNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  indent: string,
  navMap: ReadonlyMap<string, string>
): string {
  const className = toClassName(node.id)

  const rendered = (() => {
    switch (node.type) {
      case 'text':
        return renderTextNode(node, sceneNodesById, indent)
      case 'image':
      case 'vector':
        return renderAssetLeaf(node, indent)
      case 'container':
      case 'instance-ref': {
        // M11: a VideoPaint background fill renders as a positioned <video> layer behind content.
        const bgVideo = renderBackgroundVideoLayer(node, `${indent}  `)
        if (node.children.length === 0 && !bgVideo) return `${indent}<div class="${className}"></div>`
        const inner = node.children.map((child) => renderNode(child, sceneNodesById, `${indent}  `, navMap)).join('\n')
        // The background video layer goes first (lowest z-index), children stack above it.
        const parts = [bgVideo, inner].filter(Boolean)
        return `${indent}<div class="${className}">\n${parts.join('\n')}\n${indent}</div>`
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
  const body = nodes.map((node) => renderNode(node, sceneNodesById, '    ', navMap)).join('\n')
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
