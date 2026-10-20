# Changelog

All notable changes to AllCrew Figma Workspace are documented here.

## 1.12.0 — 2026-10-21

### Added

- Code Connect ops answered by the bridge, running the pinned official CLI (`@figma/code-connect` 2.0.2) on a repository directory: `codeconnect.parse` and `codeconnect.map` (offline), `codeconnect.preview`, `codeconnect.publish` (a dry run unless `dryRun: false`) and `codeconnect.unpublish`. Publishing needs the plugin's write gate; the token reaches the CLI only as `FIGMA_ACCESS_TOKEN` and is redacted from the log.
- `codeconnect.map` reports which Figma components already have code — from the repository's templates and, where Figma offers it, the desktop Dev Mode MCP's `get_code_connect_map`.
- `figma.mcp.tools` / `figma.mcp` relay Figma's own desktop Dev Mode MCP server (`ALLCREW_CHANNEL_FIGMA_MCP_URL`, default `http://127.0.0.1:3845/mcp`), so an agent connected only to AllCrew can call `get_design_context`, `get_metadata`, `get_variable_defs` or `get_screenshot`. A tool's own refusal comes back as an error.
- `library.reuse` playbook: search with the official MCP (`search_design_system`), check `codeconnect.map`, then insert or bind by published key with AllCrew's typed ops.
- The MCP server speaks the 2026-07-28 revision (`server/discover`, per-request `_meta`, `resultType`) alongside the `initialize` era (2024-11-05 through 2025-11-25, negotiated rather than echoed); tools carry `title` and `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`, results carry `structuredContent`, and `notifications/cancelled` aborts the in-flight bridge request.
- `org.projects` / `org.files` walk nested folders (`recursive`, `depth`, page/node/time ceilings, folder `path`).
- `EMIT_REACT` takes `fileUrl`; through the bridge it is filled in from Figma Desktop's open tab when omitted.

### Changed

- `org.projects` / `org.files` use Figma's folder v2 endpoints (`/v2/teams/:id/folders`, `/v2/folders/:id/folders|files`) instead of the deprecated v1 project routes; they need `folders:read`.
- OAuth refresh uses `POST /v1/oauth/token` with a refresh-token grant instead of `/v1/oauth/refresh`.

### Fixed

- The React export's Code Connect output works with Code Connect 2: it writes `<Component>.figma.ts` template files (stable node-derived `id`, props read through `figma.selectedInstance` and rendered with `figma.helpers.react.renderProp`), a parserless `figma.config.json`, `@figma/code-connect` in devDependencies and a separate `tsconfig.figma.json`. The retired `figma.connect(...)` parser files it wrote before are refused by the 2.x CLI.
- Code Connect templates are written outside private Organization plugins too: the file key comes from `fileUrl` when `figma.fileKey` is unavailable, and the export report says how to provide it otherwise.
- The Code Connect docs no longer say a personal access token cannot publish: per Figma's current docs a PAT with Code Connect: Write and File content: Read works, Professional plan included.

## 1.11.2 — 2026-10-20

### Fixed

- **Generate Breakpoints** now works on plans that cap a collection at one mode: the first step stays in `Breakpoints` and each further step goes into a linked single-mode `Breakpoints-<step>` collection with the same `Width`/`Layout` variables — the same layout the palette generator uses for a dark theme. Frame sync, Django breakpoints and the token export fold them back into one `Breakpoints` collection with a mode per step; regenerating replaces every collection the previous run made.

## 1.11.1 — 2026-10-19

### Added

- Colours may be given as Plugin API 1.142 `ColorWithColorSpace` objects — `{ "space": "OKLCH", "l": 0.7, "c": 0.2, "h": 140, "alpha"?: 0.5 }` — wherever the canvas vocabulary takes a colour (fills, strokes, gradient stops, shadows, noise, layout grids), with `alpha` passed to Figma as `alphaOverride`.
- `variables.set` accepts CSS colour functions and colour-space objects for COLOR variables; Figma converts them to the RGBA a variable holds.

### Known limitations

- Figma does not keep a colour's authored space (`sourceColor`) on a solid fill or stroke whose opacity is below 1 — verified in a live file through both a hand-built `SolidPaint` and `figma.util.solidPaint`. Such paints read and export as their sRGB projection; gradient stops with alpha keep the space.

## 1.11.0 — 2026-10-16

### Added

- Added Figma Plugin API 1.142 colour spaces: colours authored in Display P3, OKLCH, OKLAB, HSL or HSB keep their space — paints, gradient stops and effects read back an `authored` colour, the canvas vocabulary accepts CSS colour functions (parsed by Figma itself), and the token, Django and Smart Animate exports write `oklch()`, `oklab()` or `color(display-p3 …)` instead of flattening to hex. Plain hex output is unchanged.
- Added organisation and library-analytics ops answered by the bridge over REST: `org.capabilities`, `org.activity` (OAuth), `org.projects`, `org.files`, `library.actions` and `library.usages`, plus the CLI `allcrew-channel auth` OAuth flow (`--status`, `--refresh`). `allcrew-channel activity` now reads the audit log through that grant.
- Added the design-to-site fidelity tool (`npm run fidelity`, `npm run fidelity:deliver`): compares Figma frames with built pages by text and reports style, position, wrapping, vertical-shift, text-in-image and missing-content findings as an HTML report, ticket drafts carrying the design spec, section comments and a CSS fix brief.
- Added the `mr` (GitLab merge request) delivery target, dry-run delivery plans with per-file actions and diffs, route `base`/`project`/`title`/`description`, branch guards, and Settings → Delivery target, route, dry-run and **Preview** controls; PR/MR results carry their link.
- Added `node.find` `text` (search what a TEXT layer says) and `within` (one frame or section); text matches name their top-level frame.
- Added library styles to `node.style` — by the id `node.get` reports or a published key, imported on first use — and `like: <layer id>` to copy a neighbour's style; writes are verified by style id.
- Added text-style field binding to `style.bind` (`fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`).
- Added `STYLE_MOVE` for reordering paint, text, effect and grid styles or folders; `STYLE_LIST`/`STYLE_REMOVE` accept `kind: animation` for custom animation styles.
- Added the Motion playhead: `motion.context` reports it and a keyframe `time` may be `"playhead"`.
- Added per-region paints on vectors: `node.get`/`paints.stack` report `regions`, `node.bind` takes `region`, and `variables.rebind`, `variables.usage` and `lint.colors` reach region paints.
- Added `component.instances` targeting and scope (`nodeId`, `name`, `exact`, `scope`, `pageId`, `components`, `nested`, `unused`, `budgetMs`) with per-page and per-variant breakdowns; `component.orphans` scope, ranked `restoreFrom` candidates and a `detached` report; `component.restore` placement, relink matching and dry-run listing; `instance.swap` `preserveOverrides`; and the `component.repair` playbook.
- Added `history.recent` `files` and `recent` params with per-file checkpoint rows, `skipped` and `truncated`.
- Added a **Collections in the export** list in Settings: each collection's role is picked from a menu (Export, Hide from code, Breakpoints, Separate file, or a DESIGN.md role) instead of typed.
- Added separate token files per product collection (`<name>.css`, prefixed theme modules) with a cross-product gap summary.
- Added `TIMING` and `EASING` variable export (milliseconds; `cubic-bezier()` or a sampled `linear()` spring), `text-wrap-style` balance/pretty and `font-variation-settings` in the Django CSS, and binary image assets in the Django regeneration preview and download.

### Changed

- Updated `@figma/plugin-typings` from 1.141.0 to 1.142.0.
- The token export is shaped for code: themes come only from multi-mode collections (a single `:root` otherwise), non-default theme blocks hold only what they change, alias-only and hidden collections are substituted and dropped, `_`/`.`-prefixed variables stay private, and `--bp-*` come only from breakpoint threshold variables.
- A consumer file now exports the values it takes from libraries (aliases are resolved by id) instead of `var(--variableid-…)`; **Include library variables** only adds the libraries' own collections and reports progress.
- Delivery uses one JSON contract (`{ target, dryRun, route, files }`, bytes as `{ base64 }`) from the plugin, the Node receiver and `allcrew-channel receive`; dry run is on by default.
- Upgraded the component recovery engine: deleted local mains are detected (they are unparented, not `removed`), component properties are carried across mains by name when their keys differ, nested instance properties and text/layout fields are restored, and swaps keep names and export settings.
- `collections.update`, `pages.update`, `variables.extend` and `variables.audit` match names case-insensitively and verify against a fresh read; `variables.extend` validates every row before writing and can read or edit an existing extension; `variables.audit` follows library aliases by default (`libraries: false` stays local) and skips single-mode collections unless `singleMode: true`.
- REST 429 handling reads HTTP-date `Retry-After`, backs off exponentially without one, and fails fast on waits over 20 s; cached `page.frames` answers say `cached: true`; a file key missing at hello is looked up again at call time.
- Shader settings fall back per setting from applied `propertyMetadata` to the catalogue; variable-font validation names the offending key or axis tag.
- An unknown canvas property is answered with the name the vocabulary uses.

### Fixed

- Fixed the release archive's `tools/bridge.mjs` and `tools/mcp.mjs`, which imported sibling modules the archive does not ship; both are now self-contained bundles.
- Fixed plugin-to-receiver delivery, which sent zip bodies the receiver could not parse.
- Fixed `selectionchange` throwing when a selected node was swapped or deleted under the panel.
- Fixed hidden primitive layers deleting the semantic tokens that alias them.
- Fixed distributed auto-layout wraps losing their cross-axis gap in the CSS export.
- Fixed composed colour variables exporting as `[object Object]`, including a composed colour whose colour half aliases another composed colour.
- Fixed opacity tokens exporting Figma's percentage (`opacity: var(--opacity-10)` became `opacity: 10`, fully opaque): CSS, Swift and Kotlin now receive the 0–1 fraction.
- Fixed video export of a nested layer, which now names the top-level frame that can export it.
- Fixed `code.ts` being detected as binary because of literal NUL separators.
- Fixed `node.remove` reporting a forced main-component deletion as failed: Figma unparents a main whose instances still exist instead of marking it removed.

## 1.10.0 — 2026-10-07

### Added

- Added local custom Motion animation styles from Figma Plugin API 1.140: `MOTION_STYLES` lists ordered custom entries, `MOTION_STYLE_SET` creates or atomically replaces them, `MOTION_STYLE_MOVE` reorders styles or folders, and `NODE_SET` applies them with the required `CUSTOM` discriminator.
- Added `FONT_FAMILY_AXES` plus variable-font reads and writes through `fontName.variationSettings`; omitting `style` lets Figma select the closest named instance.
- Added vertical auto-layout wrapping and the `SPACE_AROUND` / `SPACE_EVENLY` primary-axis distributions to the canvas vocabulary.

### Changed

- Updated `@figma/plugin-typings` from 1.139.0 to 1.141.0.
- Shader paints and effects now use Plugin API 1.141 `propertyMetadata`, so setting names are readable without importing the shader into the file.
- `MOTION_STYLES` now reports the current Motion playhead position.

## 1.9.0 — 2026-10-02

### Added

- Added a fidelity-first product-design contract published through the generated agent skill, MCP initialization, bridge `/ops`, and a new `product.fidelity` playbook.
- Added `design.evidence`, a bounded read of Figma annotations, Dev Resources, component documentation, variable/style/component usage, prototype signals, layout grids, and inferred auto layout.
- Added machine-readable provenance labels and deterministic preflight decisions for existing-screen work, missing product briefs, platform defaults, and repository-contract conflicts.

### Changed

- Split Design System tools into dedicated picker screens for palette generation, exact color replacement, palette migration, typography, and breakpoints.
- Clarified that palette generation creates variables and boards rather than recoloring existing content; palette migration now uses a numbered workflow with its Apply result kept beside the action and secondary tools collapsed.
- Grouped exact replacement into **A · Find color** and **B · Replace with**; Generator, Selection, and Library now feed the replacement picker, while editing that picker or HEX automatically switches the source to Custom.

### Fixed

- Fixed one-color replacements by adding an exact RGB workflow for variables, paint/effect styles, and loose canvas colors. It previews writable matches, preserves each site's opacity, uses the existing undo snapshot, and never renames or rebinds tokens.

## 1.8.0 — 2026-10-01

### Added

- Added atomic `collections.update`, `pages.update`, Enterprise `variables.extend`, and read-only `variables.audit` operations.
- Added a self-contained downloadable bridge bundle with source-set fingerprint parity between checkout and downloaded forms.
- Added authenticated loopback WebSocket transport for agent calls, with HTTP polling fallback and transport status reporting.
- Added Figma Desktop tab discovery, automatic file-key matching, and `history.recent` across open and recently viewed files.

### Changed

- Browser mirror polling no longer parks a connection or forwards sandbox events while no browser viewer is present.
- Plugin window size persistence is delayed until 400 ms after the last persisted resize request.

### Fixed

- REST history and comment calls now use the addressed plugin window's discovered file key.
- REST `page.frames` shares one 30-second cached file-tree request across pages, `node.get` recursively honors requested depth, and nested `params.fileKey` consistently selects REST.
- Figma REST requests are limited to four concurrent calls and retry HTTP 429 responses up to three attempts using bounded `Retry-After`.
- CLI call output now identifies Figma REST and bridge-owned answers instead of printing an undefined plugin window.

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
