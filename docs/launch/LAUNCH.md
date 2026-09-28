# AllCrew Figma Workspace launch kit

Primary goal: get technically qualified users to install the development plugin, connect the loopback bridge, and run one real read operation. Primary CTA: **Try `document.info` and `node.get`, then report the missing operation.**

## X / Twitter

Figma Community does not allow plugins that expose an independent MCP bridge, so I shipped AllCrew Figma Workspace as a local development plugin instead.

It gives Claude Code, Codex and Cursor structured access to the Figma file currently open on your desktop, with separate visible switches for reads and writes.

It also exports design tokens, React, Django, Tauri, iOS and Android artifacts, and lets an agent build declarative custom plugin screens.

No hosted relay. No telemetry. The bridge stays on loopback.

Try one real file: run `document.info`, then `node.get` on a frame. Tell me which operation is missing.

https://github.com/mal4i6ka/allcrew-figma-plugin

## LinkedIn

I wanted an agent to work with the Figma file a designer actually has open: not a flattened screenshot, but variables, component behavior, prototype edges, assets and the ability to make an explicit, reviewable change.

That became **AllCrew Figma Workspace**, a local-first Figma development plugin with a loopback MCP bridge for Claude Code, Codex and Cursor.

The important constraint is consent:

- reads and writes are separate switches in Figma;
- development-plugin grants last only for the current session;
- the bridge listens on loopback by default;
- every operation is visible in the plugin;
- there is no hosted AllCrew relay or telemetry.

The workspace also emits mode-aware tokens, React, Django, Tauri and native mobile artifacts, and supports declarative custom screens through the AllCrew SDK.

The first public release is available on GitHub. I am looking for five people willing to test it on a real design-system file. Run `document.info` and `node.get`, then tell me where the workflow breaks.

https://github.com/mal4i6ka/allcrew-figma-plugin

## Reddit / forum post

**Title:** Local-first Figma development plugin + MCP bridge with explicit read/write gates

I built AllCrew Figma Workspace for workflows where an agent needs the state of the Figma file currently open on the designer's desktop.

It exposes variables, components, layout, prototypes and assets through a loopback bridge, and can make Figma changes only after the designer enables a separate **Allow writes** switch. It also generates token packages and React/Django/Tauri/native outputs.

This is distributed as a GitHub development-plugin release rather than a Figma Community plugin. Installation is manual: download the ZIP, import `manifest.json` in Figma Desktop, then run the bundled bridge locally.

I would value feedback on the trust model and the first-run experience more than stars. If you try it, please run `document.info` and `node.get` against one real frame and share what was unclear.

Repository: https://github.com/mal4i6ka/allcrew-figma-plugin

## Hacker News

**Title:** Show HN: AllCrew Figma Workspace – local Figma plugin and MCP bridge for coding agents

AllCrew Figma Workspace is a development plugin that connects the Figma file open on your desktop to Claude Code, Codex, Cursor or another MCP client through a loopback bridge.

Unlike a generic screenshot handoff, operations can read variables, components, layout, prototype edges and assets. Writes are behind a separate switch in the open plugin, grants are session-only for development installs, and the project runs no hosted relay.

It also exports design tokens and project structures for React, Django, Tauri, iOS and Android. The release ZIP includes the plugin, bridge, MCP front and checksums.

GitHub: https://github.com/mal4i6ka/allcrew-figma-plugin

I would particularly appreciate criticism of the permission model and installation flow.

## awesome-mcp-servers submission

Target: https://github.com/punkpeye/awesome-mcp-servers

Suggested entry under **Design tools** in alphabetical order:

```markdown
- [AllCrew Figma Workspace](https://github.com/mal4i6ka/allcrew-figma-plugin) - Local-first Figma development plugin and loopback MCP bridge with explicit read/write gates, structured design context, code generation, token export, and agent-built custom screens.
```

Suggested PR title:

```text
Add AllCrew Figma Workspace 🤖🤖🤖
```

PR body:

```markdown
Adds AllCrew Figma Workspace, a self-hosted loopback MCP bridge bundled with a Figma development plugin. The repository is public, installation is documented, and the latest release includes the bridge, MCP front, plugin bundle, and SHA-256 checksums.
```

## Launch tracking

Record the baseline immediately before each post, then again after 24 hours and 7 days:

| Metric | Baseline | 24h | 7d |
|---|---:|---:|---:|
| GitHub views / uniques | 0 / 0 | | |
| Clones / unique cloners | 0 / 0 | | |
| Stars | 0 | | |
| Release ZIP downloads | 0 | | |
| Issues opened | 0 | | |
| Successful installs reported | 0 | | |
| Bridge pairings reported | 0 | | |
| Users completing a write | 0 | | |

Success for the first launch is five successful installs, three bridge pairings, two users completing an intentional write, and one returning for the next release. Stars are secondary.
