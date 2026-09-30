# Changelog

All notable changes to AllCrew Figma Workspace are documented here.

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
