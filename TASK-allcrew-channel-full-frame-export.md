# Task: export enough Figma structure for 1:1 AllCrew Channel implementation

## Problem

The current generated package is useful for tokens and isolated component
documentation, but it does not let an implementation agent reconstruct the
AllCrew Channel desktop frame at Figma node `1:16` without guessing. In the current
environment the Figma API also rejects design-context access, so the export
must be a complete offline authority rather than a partial convenience dump.

## Required export additions

- Full page/frame instance tree rooted at a requested node, including stable
  source node IDs, component-set/variant names, slot/instance overrides and
  child order.
- Auto Layout axis, sizing mode, min/max/fixed dimensions, wrapping,
  alignment, padding, gap, absolute positioning, constraints and clipping.
- All resolved typography, fills, strokes, radii, effects, opacity and
  interaction states expressed as semantic token references where available.
- Asset manifest with deterministic file names, source node IDs, dimensions,
  content hashes and SVG/raster output; retain text as text.
- Viewport-sized PNG reference for every requested top-level frame plus the
  exact export dimensions and scale.
- Machine-readable JSON/TypeScript schema beside `COMPONENTS.md`; Markdown
  previews alone are not sufficient for code generation.
- Component state matrix for Sidebar, Board, Board Column, Board Column Header,
  Button, Card and runner/workspace panel, including hover/pressed/disabled/
  selected/collapsed variants.
- Incremental provenance: Figma file key/version, root node, plugin version,
  timestamp, per-artifact digest and a clear stale/missing marker.
- Target-brand metadata: generated shipping names/assets must support
  **AllCrew Channel** even when legacy `allcrew-channel-*` package paths remain for compatibility.

## Acceptance

From a clean checkout, an agent with no Figma API access can reconstruct node
`1:16` at the target viewport using only the exported package. The result uses
no guessed raw colours/spacing/radii, preserves the collapsed icon rail,
board-column density and right runner panel, and produces a reviewable visual
diff against the exported full-frame PNG. Missing/unsupported Figma properties
must be emitted as explicit diagnostics rather than silently omitted.
