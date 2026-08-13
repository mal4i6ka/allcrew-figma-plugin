/**
 * "Exported graphic" detection: a node the designer has given Figma export settings (the native
 * Export panel — SVG, PNG @2x, …) is treated as a flat, opaque graphic by this plugin. The linter
 * skips its subtree (its internals are art, not layout, so unbound-fill / nesting / auto-layout
 * rules don't apply), and the serializer emits it as asset files instead of walking its vector
 * tree — one file per configured export setting, exactly as the designer set them up
 * (src/assets.ts's `exportDesignerAssets`). This is the "mark this node as graphics" rule.
 */

/** Minimal shape needed to detect export settings — matches `SceneNode`'s `ExportMixin`, but stays
 * structural so unit-test mocks (and non-Figma callers) work without the full node type. */
export interface ExportMarkedNode {
  readonly exportSettings?: ReadonlyArray<{ readonly format?: string }>
}

/** True when the designer marked this node for export (any format) — the "treat as graphics" flag. */
export function isExportedGraphic(node: ExportMarkedNode): boolean {
  return Array.isArray(node.exportSettings) && node.exportSettings.length > 0
}

/** Structural instance shape for the master-settings lookup — `getMainComponentAsync` under
 * `documentAccess: dynamic-page`, `mainComponent` as the legacy/test fallback. */
export interface ExportMarkedInstanceNode extends ExportMarkedNode {
  readonly type?: string
  getMainComponentAsync?(): Promise<ExportMarkedNode | null>
  readonly mainComponent?: ExportMarkedNode | null
}

/**
 * The export settings that apply to `node` under the "marked graphic" rule: its own when it has
 * any, else — for an INSTANCE — its master component's. Figma does NOT mirror the master ROOT's
 * Export panel onto placed instances (`instance.exportSettings` stays empty), so without this
 * lookup marking an icon COMPONENT for export would still let every placed instance be walked
 * into its vector internals instead of collapsing to one asset.
 */
export async function resolveExportSettings(node: ExportMarkedInstanceNode): Promise<ReadonlyArray<{ readonly format?: string }>> {
  const own = node.exportSettings ?? []
  if (own.length > 0) return own
  if (node.type !== 'INSTANCE') return []
  try {
    const master = node.getMainComponentAsync ? await node.getMainComponentAsync() : node.mainComponent ?? null
    return master?.exportSettings ?? []
  } catch {
    return [] // detached / library-unavailable master — behave like an unmarked node
  }
}
