/**
 * M12: `export-report.json` — an audit-trail artifact shipped alongside every export, stamped with
 * `figma.currentUser`/`figma.activeUsers` (docs/1TO1-FIDELITY.md M12). Kept free of the `figma`
 * global: `src/code.ts` reads `figma.currentUser`/`figma.activeUsers`/`new Date()` and passes plain
 * values in, so the JSON shape itself is testable without a live sandbox.
 */

import type { IrNode } from '../ir.ts'
import { summarizeSpringPresetObservations, type SpringPresetObservation } from '../easing/index.ts'
import type { EmitterNote } from '../css-emitter.ts'

export interface ExportReportScope {
  mode: 'page' | 'selection' | 'frame'
  frameId?: string
}

export interface ExportReportModules {
  tokens: boolean
  templates: boolean
  i18n: boolean
  animation: boolean
}

export interface ExportReportInput {
  /** ISO-8601 timestamp of the export. */
  exportedAt: string
  /** `figma.currentUser?.name`, or `'unknown'` when the plugin runs outside a multiplayer session. */
  exportedBy: string
  /** `figma.activeUsers.length` — includes the exporting user. */
  activeUserCount: number
  scope: ExportReportScope
  modules: ExportReportModules
  fileCount: number
  /** `static`-relative paths the templates reference but the zip cannot ship — the Figma Plugin
   * API has no video-byte access (`Video` carries only a `hash`; `exportAsync({format:'MP4'})`
   * throws "Cannot export node as video" in Design files). Drop each file manually at this path
   * under the app's `static/`; the poster renders until then, and a manually placed file
   * survives re-exports (the apply script only overwrites zip entries). Omitted when empty. */
  manualAssets?: string[]
  /** Springs whose curve was solved from the reverse-engineered `NAMED_SPRING_BOUNCE` table
   * because Figma stated no physics for the preset — the one part of the emitted motion that is
   * an estimate. `{ GENTLE: 3 }` means three reactions animate on a guessed GENTLE. Omitted when
   * every spring in the export came from numbers Figma itself supplied. */
  estimatedSpringPresets?: Record<string, number>
  /** What the file's own springs say the preset table SHOULD hold, whenever a named preset
   * arrived carrying its numbers: `delta` is how far the shipped table is off, and `matches:false`
   * means the emitted curves for that preset are wrong by that much. Omitted when the file
   * offered nothing to measure against. */
  springPresetCalibration?: Record<string, { observedBounce: number; tableBounce: number; delta: number; matches: boolean; samples: number }>
  /** What the CSS pass approximated or could not draw, grouped by kind and detail:
   * `{ "unsupported-fill": { SHADER: ["4:12"] } }`. A designer's noise/glass layer silently not
   * shipping is the kind of fidelity loss nobody finds by reading the CSS. Omitted when clean. */
  fidelityNotes?: Record<string, Record<string, string[]>>
  /** Page templates whose `{% block content %}` holds nothing but one `<img>`/`<svg>` element —
   * a frame that carried export settings and so rendered as a single flattened picture instead of
   * real markup. A caller reading only the HTML has no way to tell "one image" from "a genuine
   * one-image page" apart from this list. Omitted when no page flattened. */
  flattenedPages?: Array<{ templatePath: string; nodeId: string; asset: string }>
  /** The source Figma file behind this export, so every emitted template can be traced back to
   * the frame it came from — and so another tool (Figma's official MCP takes `fileKey` + `nodeId`
   * on every call) can join up with this package. `key` is `null` when `figma.fileKey` is withheld
   * (Organization-plan private plugins only); `pageUrls` is then empty rather than a broken link. */
  figmaFile?: { key: string | null; name: string; pageUrls: Record<string, string> }
}

/** Serializes the export report to the JSON written at the zip root as `export-report.json`. */
export function buildExportReport(input: ExportReportInput): string {
  return JSON.stringify(input, null, 2) + '\n'
}

/**
 * Walks the exported IR for spring-eased reactions and answers the two questions the report exists
 * to answer about them: which emitted curves are estimates, and what the file itself says the
 * estimate should have been. Both fields are omitted when there is nothing to say, so an export
 * without springs (or without guessed ones) carries no noise.
 */
export function collectSpringReport(nodes: readonly IrNode[]): {
  estimatedSpringPresets?: Record<string, number>
  springPresetCalibration?: ExportReportInput['springPresetCalibration']
} {
  const estimated: Record<string, number> = {}
  const observations: SpringPresetObservation[] = []

  const record = (spring: {
    springSource?: string
    springPreset?: string
    springObservation?: SpringPresetObservation
  }): void => {
    if (spring.springSource === 'preset-table' && spring.springPreset) {
      estimated[spring.springPreset] = (estimated[spring.springPreset] ?? 0) + 1
    }
    if (spring.springObservation) observations.push(spring.springObservation)
  }

  const visit = (node: IrNode): void => {
    if (node.navigate?.transition) record(node.navigate.transition)
    for (const interaction of node.interactions ?? []) record(interaction)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)

  // Sorted so two exports of the same file produce byte-identical reports.
  const counts: Record<string, number> = {}
  for (const preset of Object.keys(estimated).sort()) counts[preset] = estimated[preset]

  return {
    ...(observations.length > 0 ? { springPresetCalibration: summarizeSpringPresetObservations(observations) } : {}),
    ...(Object.keys(counts).length > 0 ? { estimatedSpringPresets: counts } : {}),
  }
}

/**
 * Groups the CSS pass's notes into the report's `fidelityNotes` shape: kind → detail → node ids.
 * Ids are deduped and sorted, so re-exporting an unchanged file produces an unchanged report.
 */
export function summarizeEmitterNotes(notes: readonly EmitterNote[]): ExportReportInput['fidelityNotes'] {
  if (notes.length === 0) return undefined
  const byKind: Record<string, Record<string, Set<string>>> = {}
  for (const note of notes) {
    const detail =
      note.type === 'squircle-approx' ? `smoothing-${note.smoothing}` : note.type === 'unsupported-effect' ? note.effect : note.fill
    const details = byKind[note.type] ?? {}
    const ids = details[detail] ?? new Set<string>()
    ids.add(note.node)
    details[detail] = ids
    byKind[note.type] = details
  }

  const summary: Record<string, Record<string, string[]>> = {}
  for (const kind of Object.keys(byKind).sort()) {
    const details: Record<string, string[]> = {}
    for (const detail of Object.keys(byKind[kind]).sort()) details[detail] = [...byKind[kind][detail]].sort()
    summary[kind] = details
  }
  return summary
}

/** Matches a page template's `{% block content %}...{% endblock %}` body — the region `emitPage`
 * (component-emitter.ts) writes the page root's rendered markup into. Non-greedy: a page carries
 * exactly one such pair. */
const CONTENT_BLOCK = /\{%\s*block\s+content\s*%\}([\s\S]*?)\{%\s*endblock\s*%\}/

/** A flattened page's single element still renders through `wrapNavigate` (html-emitter.ts) when
 * the frame itself carries a NAVIGATE reaction, wrapping it in a `display:contents` anchor that
 * adds a link, not markup. Unwrapped so a clickable flattened image is still recognized as one. */
function unwrapNavigateAnchor(html: string): string {
  const match = /^<a\b[^>]*style="display:contents"[^>]*>([\s\S]*)<\/a>$/i.exec(html)
  return match ? match[1].trim() : html
}

// A container with real markup always wraps its children in its own tag (`renderNode`'s
// container branch) — only a page root that itself serialized as a leaf (`renderAssetLeaf`)
// produces a block body that IS one of these, with nothing before or after it.
const SINGLE_IMG = /^<img\b[^>]*>$/i
const SINGLE_SVG = /^<svg\b[\s\S]*<\/svg>$/i
const STATIC_ASSET_SRC = /\{%\s*static\s+'([^']+)'\s*%\}/

/**
 * Finds page templates whose content block holds nothing but one image/svg element — a frame that
 * carried Figma export settings and so flattened into a single picture instead of real markup
 * (docs/1TO1-FIDELITY.md M12). A page merely containing an image among other markup is left alone:
 * its content block is wrapped in the container tag that markup lives in, so it never matches
 * `SINGLE_IMG`/`SINGLE_SVG` whole. Sorted by template path for a byte-stable report.
 */
export function collectFlattenedPages(
  pages: Record<string, string>,
  fileNodeIds: Record<string, string>
): NonNullable<ExportReportInput['flattenedPages']> {
  const flattened: NonNullable<ExportReportInput['flattenedPages']> = []
  for (const templatePath of Object.keys(pages).sort()) {
    const block = CONTENT_BLOCK.exec(pages[templatePath])
    if (!block) continue
    const content = unwrapNavigateAnchor(block[1].trim())
    if (!SINGLE_IMG.test(content) && !SINGLE_SVG.test(content)) continue
    const nodeId = fileNodeIds[templatePath]
    if (!nodeId) continue
    flattened.push({ templatePath, nodeId, asset: STATIC_ASSET_SRC.exec(content)?.[1] ?? '' })
  }
  return flattened
}

/** A Figma file name turned into a URL path segment the way Figma's own share links do: spaces
 * become dashes, case is kept (real links read e.g. `.../design/AbC123/Altery-Mobile-DS?...`),
 * anything else URL-unsafe is dropped rather than escaped. Never empty, so a nameless file still
 * produces a followable link. */
function figmaFileSlug(name: string): string {
  const slug = name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]+/g, '')
  return slug || 'file'
}

/**
 * Builds the report's `figmaFile` reference: one URL per template, back to the frame it came from,
 * so a developer (or another tool — Figma's official MCP takes `fileKey` + `nodeId` on every call)
 * can join this package up with the source file. `fileNodeIds` also carries synthetic entries with
 * no real Figma node behind them (`BASE_HTML_NODE_ID`, regenerate.ts) — recognized by having no
 * `:` in the id — which get no URL. `key` is `null` when `figma.fileKey` is withheld from the
 * plugin (Organization-plan private plugins only, ops.ts); `pageUrls` then stays empty instead of
 * carrying a URL with no file key to put in it.
 */
export function buildFigmaFileReference(input: {
  key: string | null
  name: string
  fileNodeIds: Record<string, string>
}): NonNullable<ExportReportInput['figmaFile']> {
  if (!input.key) return { key: null, name: input.name, pageUrls: {} }
  const slug = figmaFileSlug(input.name)
  const pageUrls: Record<string, string> = {}
  for (const templatePath of Object.keys(input.fileNodeIds).sort()) {
    const nodeId = input.fileNodeIds[templatePath]
    if (!nodeId.includes(':')) continue
    // A compound instance id (`I4357:109443;823:99714`, docs §4.4 point 7) carries both `:` and
    // `;` separators — Figma's own node-id query param uses dashes for either, same as
    // `assets.ts`'s `idSegment` sanitizes a node id into a filesystem-safe segment.
    const anchor = nodeId.replace(/[^a-zA-Z0-9_-]+/g, '-')
    pageUrls[templatePath] = `https://www.figma.com/design/${input.key}/${slug}?node-id=${anchor}`
  }
  return { key: input.key, name: input.name, pageUrls }
}
