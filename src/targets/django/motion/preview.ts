/**
 * Live preview (T5.8): assembles one standalone HTML document — suitable for a UI-iframe's
 * `srcdoc`, delivered over `postMessage` — straight from the CSS (`emitNodeAnimationCss`,
 * T5.4) or GSAP (`emitGsapTimeline`, T5.5) emitters. Backend choice reuses T5.3's
 * `pickBackend`. Because this module calls the very same emitter functions the export
 * pipeline calls, the preview can never drift from what actually ships — there is no
 * second HTML/CSS/JS implementation to keep in sync.
 */

import { pickBackend, type MotionBackend, type MotionTrigger } from './backend.ts'
import { emitNodeAnimationCss } from './css-emitter.ts'
import { emitGsapTimeline, NODE_ID_ATTRIBUTE } from './gsap-emitter.ts'
import type { MotionTrack } from './types.ts'

export interface PreviewNode {
  readonly nodeId: string
  readonly tracks: readonly MotionTrack[]
  /** Node's static markup (position/size/content) — everything preview needs besides motion. */
  readonly html: string
}

export interface PreviewTimelineInput {
  readonly timelineId: string
  readonly duration: number
  readonly nodes: readonly PreviewNode[]
  readonly trigger: MotionTrigger
  /** UI's per-timeline backend override (T6.1) — passed straight through to `pickBackend`. */
  readonly backendOverride?: MotionBackend | null
  /**
   * Inlined GSAP core (+ used plugins) source. Required whenever the picked backend needs a
   * GSAP plugin: a `srcdoc` iframe can't reach a CDN or a Django `{% static %}` URL, and the
   * plugin manifest's `networkAccess: { allowedDomains: ["none"] }` blocks fetching one anyway.
   */
  readonly gsapRuntimeJs?: string
}

export interface PreviewDocument {
  readonly html: string
  readonly backend: MotionBackend
  /** Why this backend was picked (T5.3) — surfaced next to the preview so it's not a black box. */
  readonly reason: string
}

function nodeSelector(nodeId: string): string {
  return `[${NODE_ID_ATTRIBUTE}="${nodeId}"]`
}

function wrapHtmlDocument(timelineId: string, bodyHtml: string, headExtra: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${headExtra}</head>
<body data-timeline="${timelineId}">
${bodyHtml}
</body>
</html>
`
}

function buildCssDocument(input: PreviewTimelineInput): string {
  const css = input.nodes
    .filter((node) => node.tracks.length > 0)
    .map((node) => emitNodeAnimationCss({ selector: nodeSelector(node.nodeId), tracks: node.tracks }))
    .join('\n\n')
  const bodyHtml = input.nodes.map((node) => node.html).join('\n')
  return wrapHtmlDocument(input.timelineId, bodyHtml, `<style>\n${css}\n</style>\n`)
}

function buildGsapDocument(input: PreviewTimelineInput): string {
  const { js, usedPlugins } = emitGsapTimeline({
    timelineId: input.timelineId,
    duration: input.duration,
    nodes: input.nodes.map((node) => ({ nodeId: node.nodeId, tracks: node.tracks })),
  })

  if (usedPlugins.length > 0 && !input.gsapRuntimeJs) {
    throw new Error(`GSAP preview needs plugins [${usedPlugins.join(', ')}] but no gsapRuntimeJs was supplied`)
  }

  const bodyHtml = input.nodes.map((node) => node.html).join('\n')
  const scripts = `<script>\n${input.gsapRuntimeJs ?? ''}\n</script>\n<script>\n${js}\n</script>`
  return wrapHtmlDocument(input.timelineId, `${bodyHtml}\n${scripts}`, '')
}

/** Builds the exact `srcdoc` HTML for one Motion timeline, picking CSS or GSAP via T5.3's rule. */
export function buildPreviewDocument(input: PreviewTimelineInput): PreviewDocument {
  const allTracks = input.nodes.flatMap((node) => node.tracks)
  const decision = pickBackend({ tracks: allTracks, nodeCount: input.nodes.length, trigger: input.trigger }, input.backendOverride)

  const html = decision.backend === 'css' ? buildCssDocument(input) : buildGsapDocument(input)
  return { html, backend: decision.backend, reason: decision.reason }
}
