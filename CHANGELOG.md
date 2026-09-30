# Changelog

All notable changes to AllCrew Figma Workspace are documented here.

## 1.7.0 — 2026-09-30

### Added

- Added an opt-in Browser UI mirror setting, independent from agent read/write permissions. When enabled, the header shows a browser icon that opens the live plugin panel served by the paired loopback bridge.

## 1.6.0 — 2026-09-30

### Changed

- Added automatic semantic grid switching: stacked below 720 px and split layouts from 720 px.
- Grouped Django and Tauri setup and review cards into independent vertical lanes, eliminating the empty grid rows and foreign-looking two-column regeneration card caused by mismatched content heights.
- Added auto-fit module grids so declarative screens gain columns only when their declared blocks have enough room.
- Capped the internal workspace at 1200 px so cards stop scaling linearly with very large plugin windows.
- Stabilized the Agent skill pane at 48% of viewport height with a 520 px ceiling, and capped lone DS generator cards at 560 px in split layouts.
- Reduced the outer Figma panel ceiling to 1240×1200, matching the 1200 px workspace plus shell padding so the window itself cannot be stretched into a large empty frame.
- Replaced Agent Listener row spanning with independent vertical lanes, eliminating empty grid rows when card heights differ.
- Switched drag sizing to consecutive screen-space deltas with unrounded accumulators, falling back to event movement only when a captured screen coordinate is stationary.
- Coalesced live resize requests to animation frames while retaining a single final persistence write.
- Added a real-Chromium layout matrix covering every plugin screen across stack, breakpoint, wide and maximum viewports, including CI-safe sandbox flags and surfaced browser errors.

## 1.5.0 — 2026-09-30

### Changed

- Made every native plugin view consume the available width instead of keeping a fixed 394 px column.
- Added narrow-mode rules for the header, settings controls, theme mappings, palette editors, module tools, update actions and footer pipeline.
- Reworked table and action containers to wrap or scroll without pushing the panel beyond its viewport.
- Matched the footer resize handle to the referenced Figma component: a 24 px footer control with two restrained diagonal strokes.
- Matched decorative background insets to the 24 px compact footer on Settings, Agent Listener and module screens.

## 1.4.0 — 2026-09-30

### Added

- Added a draggable bottom-right panel resize handle with double-click height fitting.
- Added globally persisted, clamped plugin dimensions from 340×320 through 1400×1600.
- Added responsive narrow/wide layouts and viewport-driven heights for code, skill, table and diff regions.
- Added the read-only `UI_RESIZE` panel command; the live browser mirror follows its browser window and hides the Figma-only handle.
- Live drag frames resize without writing storage; the final clamped size is persisted once on pointer release or height autofit.
- Stored dimensions are applied before user-module discovery, avoiding a delayed startup jump.

## 1.3.0 — 2026-09-30

### Added

- Added manual GitHub Release checks under **Settings → Updates**.
- Added opt-in automatic update discovery, disabled by default and limited to one successful check every 24 hours.
- Added an update-available header banner with release details and direct archive download actions.

### Privacy and reliability

- Update preferences and discovery metadata now use their own `figma.clientStorage` key, separate from export options and presets.
- Release and download links open through `figma.openExternal()` after the sandbox validates an HTTPS GitHub URL.
- The installed version is injected from `package.json` during every build, preventing UI/version drift.

## 1.2.1 — 2026-09-30

### Fixed

- Replaced the stale version-specific archive name in the packaged installation guide with `allcrew-figma-workspace-v*.zip`, so future releases cannot ship instructions naming an older archive.

## 1.2.0 — 2026-09-30

### Added

- Added `component.instances`, a document-wide component inventory with copy counts, unused local masters, page/frame placement, nesting, and jump links.
- Added `component.orphans`, grouping deleted-local and missing-master instances by impact and exposing recovery candidates.
- Added `component.restore`, which rebuilds a dead master from an orphan and reassigns the group with per-field override recovery reporting.
- Added `instance.swap` with native swap, structural rebuild, and automatic fallback strategies for component ids, library keys, and exact set variants.
- Extended `node.focus` to select same-page batches and return cross-page targets as grouped jump links.

### Reliability

- Rebuilds are transactional: a failed property copy removes the partial replacement and leaves the original instance intact.
- Override reports now distinguish preserved, restored, lost, and unsupported fields.
- Rebuilds preserve Figma auto-layout sizing modes alongside geometry, layout flags, plugin data, and reactions.

## 1.1.1 — 2026-09-28

### Changed

- Renamed the public product from **AllCrew Channel** to **AllCrew Figma Workspace**.
- Renamed GitHub Release archives to `allcrew-figma-workspace-v<version>.zip`.
- Kept established `allcrew-channel` CLI commands, environment variables, secret paths, wire headers, and module format identifiers for compatibility.

## 1.1.0 — 2026-09-28

### Added

- Local Agent Listener with separate read and write gates, loopback bridge, MCP front, browser mirror, and REST fallback.
- Design-token, Django, React, Tauri, native iOS, and Android export paths.
- DS Tools for palette generation, color remapping, rebinds, documentation boards, typography, and breakpoints.
- Declarative AllCrew SDK user modules and an in-plugin agent prompt for creating custom screens.
- Free-plan theme collection folding, including multi-theme table configuration.
- GitHub Release packaging for Figma development-plugin installation.

### Security

- Development-plugin Agent Listener grants are session-only when Figma provides no stable `fileKey`; grants are never restored by file name.
- Bridge defaults to loopback and uses a per-machine pairing secret.
