# AllCrew Figma Workspace 1.1.1

A local-first Figma development plugin and MCP workspace for Claude Code, Codex and Cursor.

## Install

1. Download `allcrew-figma-workspace-v1.1.1.zip` and `SHA256SUMS` below.
2. Verify the checksum and unzip the archive.
3. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest…**.
4. Select the extracted `manifest.json`.
5. Run `node tools/bridge.mjs`, pair from Agent Listener, and enable reads.

## Highlights

- Structured access to the Figma file open on the desktop: variables, components, layout, prototype edges and assets.
- Explicit, visible read/write gates; development-plugin grants are session-only.
- Mode-aware token packages plus React, Django, Tauri, iOS and Android outputs.
- Declarative AllCrew SDK screens that an agent can author and validate.
- No hosted AllCrew relay and no telemetry; the default bridge stays on loopback.

## Compatibility

The public product is now **AllCrew Figma Workspace**. Existing `allcrew-channel` CLI commands, environment variables, secret paths, wire headers and module format identifiers remain unchanged.

Full installation and security details: https://github.com/mal4i6ka/allcrew-figma-plugin
