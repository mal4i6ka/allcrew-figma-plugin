/**
 * M12: `export-report.json` — an audit-trail artifact shipped alongside every export, stamped with
 * `figma.currentUser`/`figma.activeUsers` (docs/1TO1-FIDELITY.md M12). Kept free of the `figma`
 * global: `src/code.ts` reads `figma.currentUser`/`figma.activeUsers`/`new Date()` and passes plain
 * values in, so the JSON shape itself is testable without a live sandbox.
 */

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
}

/** Serializes the export report to the JSON written at the zip root as `export-report.json`. */
export function buildExportReport(input: ExportReportInput): string {
  return JSON.stringify(input, null, 2) + '\n'
}
