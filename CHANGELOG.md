# Changelog

All notable changes to AllCrew Figma Workspace are documented here.

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
