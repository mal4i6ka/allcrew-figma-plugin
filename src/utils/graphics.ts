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
