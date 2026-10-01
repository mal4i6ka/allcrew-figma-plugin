# Agent listener

Lets a CLI agent — Claude Code, Codex, a shell script, `curl` — ask questions about the Figma
file the designer currently has open, through the AllCrew Figma Workspace plugin's own Plugin API access.

It is MCP-shaped without being MCP: there is no server to register, no client library, and
nothing to keep in sync but the op names. If a tool can run a shell command, it can drive
Figma.

**Reads and writes, gated separately.** Most ops only look; twenty-eight of them change the
document or plugin-managed module storage and sit behind their own switch, which reads never imply.

---

## Why it is built inside-out

A Figma plugin cannot be reached from outside. The sandbox has no listening socket, and there
is no headless mode — a plugin only exists while a person has it open. So the plugin dials
*out*, and a local bridge gives the CLI something conventional to talk to:

```
   agent (Claude Code, curl, …)                plugin (UI iframe → sandbox)
       │  POST /call {op, params}                  │
       ▼                                           │  WebSocket /plugin/ws
   bridge.mjs ─────── hands the request over ──────┤
       │                                           │  result on the same socket
       ◄────────────── answers the waiting call ───┘
```

Two consequences worth knowing before you build on this:

- **The plugin must be open.** Close it and the channel is dead. An agent cannot open a Figma
  file by itself.
- **The transport lives in the UI iframe,** not the sandbox. A WebSocket avoids Chromium's
  six-HTTP-connection pool across all open Figma files; an older bridge falls back to long
  polling. The iframe only relays; the sandbox decides what may run.

---

## Setup

Pick **Agent Listener** in the plugin's header picker. That screen is the whole setup: a
button that opens and closes the channel, the bridge command, and the skill to hand your
agent.

**1. Get the bridge and run it.** Press **Download bridge.mjs** on that screen. The build bundles
the bridge and all of its local modules into one self-contained ESM file, then embeds that exact
file into the plugin. From a checkout, `node agent/bridge.mjs` runs the same logical source set;
both forms carry the same source-set fingerprint.

```bash
node ~/Downloads/bridge.mjs
```

Loopback only, no dependencies, no arguments; needs Node 18+, which the CLI agent you are
wiring up already requires. First run mints a secret into `~/.allcrew-channel/agent-secret` (0600) and
opens a five-minute pairing window.

**2. Press "Pair with bridge"** in the plugin. It collects the secret and stores it in that
designer's own Figma client storage. The window closes behind the first pair.

**3. Press "Start listening."** The channel is open; every call an agent makes is listed
right there as it happens.

**4. Install the skill.** Easiest is `node bridge.mjs --install-skill`: every hello carries the
plugin's own rendered skill text, so the bridge keeps the copies on disk current instead of you
re-pasting after an update. It writes three, because a skill an agent does not DISCOVER is a
skill nobody reads:

| path | read by |
|------|---------|
| `~/.claude/skills/allcrew-channel-listener/SKILL.md` | Claude Code (user-level skills) |
| `~/.agents/skills/allcrew-channel-listener/SKILL.md` | Oh My Pi and anything else on the `.agent[s]/skills` convention |
| `~/.allcrew-channel/SKILL.md` | nothing automatically — the agent-neutral copy to point a config at |

`ALLCREW_CHANNEL_AGENT_SKILL_FILE=/path/a,/path/b` replaces that list. Without the flag nothing is
written: the file becomes standing instructions for your agent, and the bridge does not install
those behind your back.

Two traps worth knowing. Oh My Pi treats `~/.agents/skills` as native and `~/.claude/skills` as a
*foreign user-level source* that stays invisible until its provider is listed in `enabledProviders`
— so a copy that only landed in the Claude directory will not appear in `omp`'s skill list. And
every agent reads its skill directory at startup, so restart the session after installing.
Otherwise: **Copy the skill** from the same plugin screen, or `curl localhost:8788/skill`, and
paste it wherever that tool reads standing instructions.

Then, from anywhere:

```bash
curl -s localhost:8788/call -H "x-allcrew-channel-secret: $(cat ~/.allcrew-channel/agent-secret)" -d '{"op":"document.info"}'
```

or, from a checkout of this repo, with the bundled CLI — it resolves the same secret file:

```bash
node agent/allcrew-channel.mjs status
node agent/allcrew-channel.mjs ops
node agent/allcrew-channel.mjs call document.info
```

## Live browser UI

With the paired plugin open, turn on **Browser UI mirror**. This opt-in is independent from
**Allow reads** and **Allow changes**, which gate external agents only. The browser icon that
appears in the plugin header opens the exact connected file. The direct bridge URL remains available:

```text
http://127.0.0.1:8788/ui
```

This is the same `ui.html`, not a mock or a screenshot. The Figma iframe uploads its exact built
source to the bridge, browser actions are relayed into the live plugin sandbox, and sandbox
messages are streamed back into the browser. Frame lists, variables, selection, scans, progress,
errors and disabled states therefore come from the open Figma file.

The bridge is loopback-only and injects its secret only into the top-level `/ui` response, which
cannot be framed. One browser tab holds a 45-second controller lease; additional tabs may watch
events but a second tab cannot write until the first stops polling. A command originating in the
browser executes once in the sandbox. Download side effects stay with the browser controller, so
the Figma iframe does not save a duplicate ZIP.

Several connected files produce a chooser at `/ui`; a direct URL is
`/ui?target=<handle>`. Turning off **Browser UI mirror** or closing the plugin disconnects the
mirror; changing the external-agent permission switches does not.

---


## Through an MCP client (no skill, no curl)

The CLI above is deliberately MCP-*shaped* without being MCP. `agent/mcp.mjs` closes that last
gap for clients that already speak the protocol — Claude Desktop, Claude Code, Cursor, Codex:
it is an **MCP stdio server** that fronts the very same bridge, so the client lists tools and
calls them like any other server, with no `SKILL.md` to paste and no `curl`.

```
   MCP client (Claude Desktop, Cursor, …)            plugin (open in Figma)
      │  stdio: initialize, tools/list, tools/call      │
      ▼                                                 │  WebSocket /plugin/ws
    mcp.mjs ── POST /call {op, params, target} ──▶ bridge.mjs ──┤
      ◄──────────────── the op's answer ────────────────────┘
```

It is a *client* of the bridge, exactly like the CLI — not a replacement. So the same model
holds: **one bridge per machine, and as many MCP clients as you like**, each spawning its own
`mcp.mjs` that forwards to that single bridge. Keep the bridge running; the MCP server does not
replace it.

**Setup, in one command.** Press **Download mcp.mjs** on the Agent Listener screen (or use
`agent/mcp.mjs` from a checkout), then:

```bash
node ~/Downloads/mcp.mjs --install claude    # or cursor, windsurf, vscode
```

It writes the server entry into that client's own config — merged, never overwritten: other
MCP servers configured there survive, and installing twice replaces our entry instead of
doubling it. The command it writes is the absolute path of the node running it and of the
script itself, so the client finds both whatever directory it starts in. For a client that
keeps TOML (Codex) or one not on the list, `--install` with an unknown name prints the snippet
to paste. By hand it is the same three facts:

```json
{ "mcpServers": { "allcrew-channel": { "command": "node", "args": ["~/Downloads/mcp.mjs"] } } }
```

No secret to configure — it resolves `~/.allcrew-channel/agent-secret` the same way the CLI does. The
same environment variables apply (`ALLCREW_CHANNEL_AGENT_URL`, `ALLCREW_CHANNEL_AGENT_SECRET`,
`ALLCREW_CHANNEL_AGENT_FILE`).

**The tool surface.** Two tools are always present, so a client that lists tools before the
plugin is open still has a usable surface:

- `allcrew_channel_status` — which files are connected and what each allows.
- `allcrew_channel_call` — run any op by name; the universal doorway, including `plugin.call`.

On top of those, **every op the connected files publish becomes its own typed tool**
(`document_info`, `node_get`, `variables_set`, …) with a JSON Schema built from the op's own
params, plus an optional `target` for choosing between several open files. The server watches
the roster and emits `notifications/tools/list_changed` when a file is opened, closed or
re-gated, so the tool list follows the panel.

Everything else carries over unchanged: the read/write gates still decide (a mutating op is
marked `[writes to the document]` in its tool description), the 409 ambiguity refusal comes back
with the roster attached, and large results are still written to disk as paths rather than
inlined.

---

## No Figma API token

Nothing in this channel uses one. The plugin already has the file open and the Plugin API needs
no credential, so there is no personal access token to create, store or rotate — which matters
more than convenience: on an Organization plan an admin can forbid members from creating one,
and an integration that depends on a token is an integration half the team cannot run.

What that costs is a real boundary rather than a gap to work around. **Comments, version history
and the audit log of who changed what do not exist in the Figma plugin API.** No op here can
reach them, and no future one will.

They live in the REST API, so they sit on the *agent's* side of the bridge rather than being
tunnelled through the sandbox — the agent already has a network, and routing a REST call through
a plugin would make the plugin channel depend on a credential it currently does not need:

```bash
allcrew-channel comments -k https://figma.com/design/<key>/…   # threads, replies grouped
allcrew-channel versions -k <key or URL>                       # named versions vs autosaves
allcrew-channel activity --since 2026-08-01                    # Enterprise, org-admin token
```

`$FIGMA_TOKEN`, else `~/.allcrew-channel/figma-token` — the same resolution order as the bridge secret,
so a machine that has one needs no setup for the other. Nothing writes that file for you: a
token is the designer's own credential and this tool never asks for it, prompts for it, or
puts it anywhere but where they chose.

| | plugin channel | REST commands |
|---|---|---|
| credential | none | personal access token |
| works when an admin disables tokens | yes | no |
| variables, bindings, geometry, screenshots | yes | no |
| comments, versions, audit log | no | yes |

---

## When no plugin is open: the REST fallback

The channel exists because a plugin cannot be reached from outside, and the price is that it
only exists while a person has the plugin open. Fine for a designer working alongside an agent;
useless for an agent that starts at three in the morning. So when nothing is connected — or
when a call names a `fileKey` outright — the bridge answers from Figma's REST API instead, and
says so: **every such answer carries `source: "rest"`.**

```bash
curl -s localhost:8788/call -H "x-allcrew-channel-secret: $(cat ~/.allcrew-channel/agent-secret)" \
  -d '{"op":"node.get","fileKey":"https://figma.com/design/<key>/…","params":{"nodeId":"4008:55632"}}'
# → { ok: true, source: "rest", fileKey: "…", result: { id, name, type, width, layout, children } }
```

A file key, a file URL, `target: "rest:<key>"`, or `ALLCREW_CHANNEL_FIGMA_FILE_KEY` for a default. The
token is the same `$FIGMA_TOKEN` / `~/.allcrew-channel/figma-token` the REST commands above already use.

What REST can answer: `document.info`, `page.frames`, `node.get`, `node.find`,
`components.list`, `styles.list`, `node.screenshot` (rendered server-side, downloaded, handed
back as a path like every other file) — and four more that the file payload answers outright:

- **`flow.map`.** REST puts `interactions` on a node in the same
  `{trigger, actions[{type, destinationId, navigation, transition}]}` shape the plugin reports,
  so the navigation graph is the plugin's, edge for edge — measured on the components page of a
  real file: 90 edges either way. The easing becomes `curve` here too, from the same
  reverse-engineered preset table (`bridge.test.mjs` asserts the copy still equals the plugin's).
  A **spring** is the one thing this side cannot answer: solving it is an ODE, so the transition
  carries `curveUnavailable` naming the easing instead of a `linear` that would be a wrong answer
  wearing the right shape. The legacy `transitionNodeID` triple is read as well, in milliseconds
  where the modern field is seconds.
- **`text.segments`.** Rebuilt from `characterStyleOverrides` (one style id per *character*) and
  `styleOverrideTable`. Runs are consecutive characters sharing an id, which is what
  `getStyledTextSegments` hands over directly. Bindings are the reason the op exists inside the
  plugin and the one thing REST does not carry, so the answer says so rather than reporting every
  run as bound to nothing.
- **`image.fills`.** `/v1/files/<key>/images` is an imageRef→URL map for the whole file; the
  fills under the node are deduplicated by hash, the bytes are downloaded and written beside
  every other file this channel produces. Figma's URLs are signed and short-lived — the files are
  the answer, the URLs are a courtesy.
- **`component.api`, its signature half.** A `COMPONENT_SET`'s `componentPropertyDefinitions` is
  in the node payload, and the nodes endpoint's own `components`/`componentSets` metadata
  resolves a member or an instance straight to its set — no library scope, which a personal
  token usually lacks. Axes, options, defaults, the variant id per combination and the
  boolean/text/swap properties all come back in the same field names the plugin uses, so a
  consumer cannot tell which half answered. What REST cannot give is named in the answer's
  `note`: `changes` (the delta needs `getCSSAsync`) and `targets` (`componentPropertyReferences`
  is never served). Axis values are parsed off each member's `Axis=Value, …` name, because REST
  carries no `variantProperties` either.

`GET /status` publishes that list, and `GET /ops` returns
it when the roster is empty, so an agent plans instead of discovering an empty list as a failure.

**What it cannot, by name and with the reason** — this is the half that matters, because a thin
answer that looks complete is worse than a refusal:

| Op | Why not |
|---|---|
| `variables.get` | reading variable *values* over REST is an Enterprise feature; the plugin reads them on any plan |
| `design.ir`, `design.context`, `design.measure` | built by the plugin from the live document — REST stores properties, Figma computes the CSS |
| `assets.export` | asset discovery comes from the IR; over REST, export one node with `node.screenshot` |
| `motion.*`, `transition.context`, `node.states`, `frames.compare` | Motion and variant diffing exist only inside a plugin |
| `component.api` — the `changes` and `targets` half | the delta is measured in `getCSSAsync`, and `componentPropertyReferences` is never in a REST payload. The SIGNATURE half answers over REST; the answer's `note` names what is missing |
| `plugin.commands`, `plugin.call` | the panel's command surface exists only while the panel is open |
| everything that writes | REST writes nothing here — by choice, not by omission |

The rule behind the table: **REST returns the rendered value, never the variable behind it.**
`#F2F4F5` instead of `colors/neutral/100` is exactly the guessing this channel was built to
remove, so an agent that has a choice should wait for the plugin — and one that has no choice
at least knows what it is missing.

---

## Secrets across machines

Nothing is baked into the build and nothing is shared. Each machine's bridge mints its own
secret on first run; each designer's plugin pairs with the bridge on their own machine. The
delivery receiver (`server/receiver.mjs`) works the same way and is downloadable from
Settings → Delivery. Ten
designers means ten different secrets, none of which anyone had to distribute, and any one of
them can be rotated by deleting `~/.allcrew-channel/agent-secret` and restarting.

**Never bake a secret into the plugin at build time.** One secret shared by every install is
a key to every teammate's machine that can't be rotated without a rebuild.

Pairing is unauthenticated, which is deliberate and bounded three ways: it accepts loopback
connections only, it lasts five minutes from a start someone typed by hand, and the first
successful pair closes it. It is also not a privilege escalation — a local process that could
POST to the window could equally well read `~/.allcrew-channel/agent-secret`, since both are gated by
the same user account.

Managing the secret yourself is still supported: set `ALLCREW_CHANNEL_AGENT_SECRET` and the bridge uses
it and opens **no** pairing window (pass `--pair` if you want one anyway). Then type the same
value into Settings → Agent listener → Shared secret.

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALLCREW_CHANNEL_AGENT_SECRET` | — | manage the secret by hand; suppresses pairing |
| `ALLCREW_CHANNEL_AGENT_SECRET_FILE` | `~/.allcrew-channel/agent-secret` | where the minted secret lives |
| `ALLCREW_CHANNEL_AGENT_PORT` | `8788` | HTTP port |
| `ALLCREW_CHANNEL_AGENT_HOST` | `127.0.0.1` | loopback on purpose |
| `ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS` | `180000` | how long one call may take |
| `ALLCREW_CHANNEL_AGENT_FILES` | `~/.allcrew-channel/agent-files` | where ops that return files write them |

---

## The switches

The bridge URL and secret persist — that's setup. So does the answer a designer has already
given about this file: **both gates are remembered per file.** Re-asking on every open does not
strengthen consent, it teaches the reflex to click through it, and the switches stay in the
panel either way.

- **Allow reads** — the agent may inspect the file.
- **Allow changes** — never *implied* by reads, and separately switched. Turning reads off still
  forces writes off: the more dangerous half can't outlive the safer one, stored or not.

Remembered under `figma.fileKey` where there is one, and under the *file name* where there is
not. Figma gives the key only to plugins published privately to an Organization, so outside one
two files sharing a name share the answer — a visible switch in the panel, not a silent grant.
Published privately, the collision disappears on its own and older name-keyed grants are still
honoured.

The sandbox holds the authoritative gate (`src/agent/listener.ts`). The bridge keeps a copy
purely so a waiting CLI gets a useful error instead of a timeout — it cannot grant anything.

Anyone who can reach the bridge's port and knows the secret can read the open file. It binds
`127.0.0.1` for that reason; `ALLCREW_CHANNEL_AGENT_HOST` can widen it, but think first.

---

## Ops

```
allcrew-channel ops              # what the connected plugin is offering, with params
allcrew-channel ops --json       # the same, machine-readable
```

| Op | Answers |
|----|---------|
| `document.info` | file name, editor type, current page, all pages |
| `guide.list` / `guide.get` | playbooks: named tasks with the ops they take, in order, and what to check when done — the first call on an unfamiliar file |
| `page.frames` | top-level frames, sections and components on a page |
| `page.warm` | loads a page on purpose and reports what it cost — the wait moved to where you chose it, instead of arriving inside the first read that touched a cold page |
| `node.get` | one node by id — geometry, auto-layout, text, instance bindings, children |
| `node.find` | search by name substring and/or node type, per page or whole document |
| `selection.get` | what the designer has selected right now |
| `components.list` | local components and sets, with property/variant definitions, descriptions and documentation links |
| `component.api` | one component as an API: axes with options and defaults, the variant that isolates each option, what it changes (with the token behind each value), and which layer every boolean/text/swap property drives |
| `component.instances` | document-wide inventory of every component copy: page, containing frame, nested status and jump link, plus local components with zero copies |
| `component.orphans` | orphan instances grouped by dead master, separating deleted local masters from missing masters and ranking groups by affected copies |
| `styles.list` | local text, paint, effect and grid styles |
| `variables.get` | collections, modes and values, with each token's description, scopes and per-platform `codeSyntax` |
| `flow.map` | prototype graph of a page: starting points and every reaction edge, each carrying the navigation kind and its transition (duration, easing, curve) |
| `node.focus` | selects one node or a same-page batch and scrolls the designer to it; cross-page nodes return grouped under `elsewhere` with one-line jump links |
| `node.screenshot` | renders a node to PNG — how an agent checks what it actually drew |
| `image.fills` | the uploaded files behind a subtree's image fills, on a time budget it always answers within |
| `export.settings` | the export marks a designer set on a subtree — format, constraint, suffix and the svg flags, with each marked node's box in pixels and as a share of the root. The only read that reports them: `node.get` and `design.ir` both drop `exportSettings`, so before this op the marks were reachable only over REST |
| `export.run` | renders nodes by THEIR OWN export rows — a node with 1x/2x/3x rows comes back as three files, each named with its own suffix |
| `text.inventory` | every TEXT node of a subtree, split into `content` (copy that must reach the CMS and the translation file) and `baked` (text drawn inside an illustration — `img/*`, `Img`, `Interface`, `Calculator` — which ships as pixels or an SVG overlay). The rule lives here rather than in each consumer, so a fresh checkout on another machine gets the same verdict |
| `export.plan` | how to get one slot out of Figma: `vector-over-plate`, `plate+vector` or a flat `raster`, the density that still fits the 3 MB one answer carries, and the exact calls to make. Turns four cheap reads — size, bitmap fill, which children are marked, the hop ceiling — into a strategy instead of a failed export |
| `tokens.emit` | the file's variables as token files for a named platform: `web` (tokens.css/json/ts), `ios` (`Assets.xcassets/*.colorset`, `Tokens.swift`), `android` (`values/colors.xml`, `values-night/colors.xml`, `Tokens.kt`). The platform is an argument, so the answer does not depend on the checkbox in one designer's panel |
| `text.segments` | the styled runs of one TEXT node — ranges, characters, and the variable bound to each run, which is the only place per-range typography is readable |
| `paints.stack` | every layer of one node's fill sandwich, bottom to top — opacity, blend mode and shader settings included |
| `variables.usage` | how many things actually use each token — layers, styles and gradient stops, counted, so a token nobody binds is visible before you delete it |
| `variables.match` | which token is this colour: exactly, or nearest, and whether the answer is ambiguous — the read behind turning a hex into a binding |
| `variables.external` | which variables this file binds to that it does not own — the library dependency a file has without saying so |
| `variables.audit` | mode-column defects: missing values, mixed aliases/literals, unresolved aliases, and literals in collections declared alias-only |
| `instances.external` | which foreign components are instantiated here, and how many external bindings each brings with it |
| `design.context` | reference HTML + CSS + PNG for a node, plus the tokens it binds, the hover/press CSS it computed, and — with `pair` — the other breakpoint's frame merged into `@media` |
| `design.ir` | a screen as a framework-neutral tree: stacks, sizing, paints by token name, text, interactions — plus the table of type styles it is set in and what its system bands, pinned layers and scrolling are, for targets that are not web pages |
| `assets.export` | the pictures a screen references, at the densities and in the formats a platform asks for, with the paths each file belongs at (`ios`, `android`, `web`, `plain`) |
| `design.measure` | Figma's own CSS and boxes for every layer of a section, addressed by path — the assertion behind a WEB implementation, where a screenshot diff can only say "90% similar" |
| `design.audit` | the same assertion for a build with no browser to measure: report what you emitted per layer and it names what you `dropped`, what `diverged`, and what this channel could not tell you (`missing`, collected in `wanted`) |
| `node.anchor` | where a comment pin goes for a node: the frame to address it to, the offset inside it, and all nine named points of its box — the aiming primitive behind `comments.post` |
| `comments.list` | comment threads on the file, replies grouped, each pin resolved to its node and offset. REST, not the plugin: the Plugin API has no comment surface at all |
| `history.recent` | version activity since local midnight (or a supplied time) across files Figma Desktop opened on this machine, four files at a time |
| `history.versions` | version checkpoints — who, when, and whether anybody named it. `autosave` separates Figma saving on its own from a person doing something; `named` is the only place intent is recorded |
| `history.diff` | what moved between two versions of a node: added, removed, changed, and which properties — the "what" version history itself never says |
| `history.blame` | which checkpoint changed a node, and who made it. Bisects the version list, so it costs log2(N) renders instead of N |
| `node.states` | what actually changes on hover, press or overlay: property-level deltas between the state variants, not a wall of CSS |
| `frames.compare` | how the 375 frame differs from the 1440 one — matched layers with their deltas, plus what only exists on one side |
| `motion.context` | keyframe tracks with easing (as a name and as a curve), the CSS/GSAP they compile to, and which backend fits — `target: "native"` drops that verdict and its files, which are a browser answer |
| `motion.preview` | a standalone page that actually plays the animation |
| `transition.context` | Smart Animate between variants → CSS transitions, a FLIP toggle or View Transitions; an empty answer says WHICH empty it is (instant links, or states that live in a variant axis instead of the prototype) |
| `library.collections` | variable collections published by libraries enabled in this file |
| `library.variables` | variables inside one library collection — read another file's palette, with `resolve: true` to follow the alias chains a theme collection is made of |
| `lint.colors` | layers painted with a raw colour instead of a variable |
| `sandbox.capabilities` | what this plugin runtime allows |
| `plugin.vocabulary` | every node property `NODE_CREATE`, `NODE_SET` and `NODE_CLONE` accept, extracted from the source at build time so it cannot drift from the code |
| `plugin.commands` | every command the plugin's own panel can run, and which of them need the write gate |
| `modules.schema` | the canonical JSON Schema, starter module, runtime rules and limits for authoring declarative plugin screens |
| `modules.list` | installed modules with versions, status, validation problems and derived capabilities |
| `modules.inspect` | one installed module&rsquo;s declarative file and current state, with secret fields redacted |
| `modules.export` | a transferable module file, optionally with non-secret state |

Twenty-eight **change** the document or plugin-managed module storage, and `allcrew-channel ops` marks them with a leading `!`. (This
table is checked against the registry by a test — an op that ships without a row here fails the
build rather than going quietly undocumented, which is how the count used to read "five".)

| Op | Does |
|----|------|
| `variables.set` | sets variable values or aliases in batch; opacity-scoped FLOAT values accept `"40%"`, and composed COLOR values accept `{ color, opacity }` with an alias on either or both channels |
| `variables.update` | edits a variable's name, description, picker scopes (including `OPACITY` / `COLOR_OPACITY`), publishing visibility and per-platform code syntax |
| `variables.create` | creates variables in a collection, including opacity-scoped FLOAT variables, creating the collection and its modes when absent |
| `collections.update` | atomically renames, hides, edits modes or removes local variable collections, with force guards and dry-run loss counts |
| `variables.extend` | creates an Enterprise extended collection and sets or clears inherited variable overrides |
| `pages.update` | atomically renames, removes and reorders pages; non-empty and last-page removal are guarded |
| `variables.rebind` | repoints every binding of one variable onto another, document-wide — the migration, with a dry run that says what it would move and what it would leave |
| `variables.remove` | deletes variables nothing references. Refuses while a binding or an alias still points at one; the guard IS a full document walk |
| `node.bind` | binds layer properties to variables; field `opacity` writes layer opacity. Figma's current Plugin API cannot yet bind a FLOAT token directly to paint opacity |
| `node.style` | applies a style to layers, or detaches them, and verifies it took — `null` detaches while keeping the pixels |
| `node.copy` | copies or instantiates nodes onto a page — how an agent builds a side-by-side out of real layers instead of a description |
| `node.remove` | deletes nodes. Refuses a page or the document outright, and a component or set without `force` |
| `style.bind` | binds a paint style — a solid paint, or ONE gradient stop by position — to a variable, and re-reads the style to check, because stop binding is undocumented API |
| `style.remove` | deletes styles nothing uses. Refuses while a consumer exists; reports publish status first |
| `instance.detach` | detaches instances from their main components. Bindings survive — plan a rebind after |
| `text.normalize` | rewrites the invisible end-of-text run so orphan variable references die — surgery, verified per node |
| `component.describe` | writes component descriptions and their documentation links — the field `COMPONENTS.md` is built from |
| `component.restore` | clones one orphan into a replacement master, reassigns its whole dead-master group and reports overrides as kept, restored or lost |
| `instance.swap` | swaps or rebuilds instances to a component id, library key or exact set variant; `auto` falls back only when native swap fails and reports the reason plus any new node id |
| `board.render` | draws a documentation board: headings, callouts, swatch grids, before/after rows. `replace: true` makes re-rendering idempotent |
| `image.plate` | renders a node with its children hidden — the photo without the badge baked over it. Sits behind the write gate because it clones: the clone is created, hidden, exported and deleted inside the one call, and the document is back to itself when it returns |
| `shader.define` | imports a shader by id so its settings get names — the one thing a read cannot do for itself |
| `plugin.call` | runs one of the panel's own commands — the whole feature set, not just the ops. Gated per command: each `case` carries an `// @agent read\|write\|deny` marker and an unmarked one counts as a write |
| `history.mark` | saves a NAMED version — the only write into version history any Figma API allows, and the only way an agent can leave intent behind rather than another anonymous checkpoint |
| `export.configure` | sets, appends or clears a layer's export rows — the export panel in batch, with `before`/`after` per node and a `dryRun` that writes nothing |
| `modules.install` | validates and installs or upgrades a declarative module, migrating compatible state and refusing implicit downgrades |
| `modules.configure` | enables or disables a module and atomically updates its declared state fields |
| `modules.remove` | removes a module and its persisted state; export first when it may be needed again |

Four more write into the file's **comments** rather than into the document. They are the only
ops the bridge answers itself — the Plugin API has no comment surface, so these go out over
REST — and they still sit behind the plugin's write gate, because a comment left in somebody's
file is as visible as a layer moved in it. See "Annotating a design" below.

| Op | Does |
|----|------|
| `comments.post` | leaves a comment, pinned to a node (aimed through `node.anchor`, so it moves with the frame), to a region, or to an absolute canvas point |
| `comments.reply` | replies to a thread — and the honest answer to "mark it done", since nothing can tick it |
| `comments.remove` | deletes a comment. Permanently, and only one the token's own user posted. Not an archive: Figma has none |
| `comments.react` | adds or removes an emoji reaction — the lightest acknowledgement the API has, and explicitly not resolution |

Params are a JSON argument, or `-` to read stdin:

```bash
allcrew-channel call page.frames '{"pageId":"0:1"}'
allcrew-channel call node.find '{"types":["INSTANCE"],"name":"button","scope":"document"}'
echo '{"nodeId":"12:345","depth":2}' | allcrew-channel call node.get -
```

Results go to **stdout** as JSON and nothing else does, so `$(allcrew-channel call …)` and
`… | jq` are always clean. Human text goes to stderr. Exit code is non-zero on any failure.

### Files instead of payloads

`node.screenshot` and `design.context` answer with *paths*, not bytes. The sandbox has no
filesystem and the agent has no way into the sandbox, so an op wraps a file in an envelope and
the bridge — which does have a disk — writes it out and substitutes the path it wrote:

```bash
allcrew-channel call design.context '{"nodeId":"1:16"}'
# → { node: {…}, layers: 412, tokens: [{token:"colors/neutral/100", uses:23}, …],
#     files: [ {path:"~/.allcrew-channel/agent-files/design.context-6f2a/board.html", bytes:18422}, … ] }
```

Keeping base64 out of the answer is the point: a whole template and its screenshot cost the
agent three paths of context instead of a megabyte of it. Files land under
`ALLCREW_CHANNEL_AGENT_FILES` (default `~/.allcrew-channel/agent-files`), one directory per call, and the oldest
runs beyond the most recent 40 are swept so a debugging session does not leak disk.

`motion.context` is the same trade one layer over. It reports every animated layer in a
subtree, each track's keyframes and easing, and the `@keyframes` and GSAP timeline they
compile to — and then it says **which backend fits and why**, because `pickBackend` already
decides that for the export and an agent implementing the animation deserves the reasoning
rather than the verdict. Easings bound to a variable come back as the token name, same rule as
everywhere else here. When the Motion beta is not enabled for the account the op says so
outright: "nothing animates here" and "I cannot see animation at all" are different answers,
and an agent that cannot tell them apart will confidently ship a static page.

`transition.context` covers the other half of motion, the half that is not keyframes at all:
Smart Animate between a component set's variants. It matches layers across the two states,
diffs what actually moved, maps the Figma trigger onto a mechanism a browser has — `:hover`, a
toggled class, a timeout — and emits it three ways. Plain CSS transitions where properties
tween; a FLIP toggle where layout changes and CSS cannot tween it; the native View Transitions
API where the browser will do the work. `strategy: "all"` emits every one, because which is
right depends on the target and the op is not in a position to know.

`motion.preview` builds a page that *runs*. Not a description of the animation — the
animation. It reports which backend it picked and why, and flags a GSAP-backed preview as
inert: the plugin ships no GSAP runtime and the preview is a standalone file with no CDN wired
into it, so that preview will open and sit still. "The animation is wrong" and "nothing ran"
are different bugs.

`design.context` is deliberately not a second design-to-code tool. Figma's own is better at
turning a screen into a component; this one is better at one thing, and it is the thing that
matters when the code has to *match the design system*: it reports the token that produced a
value rather than the value. `#F2F4F5` leaves an implementing agent guessing which variable to
reach for; `colors/neutral/100` does not.

`design.measure` is the other half of the same idea, pointed backwards. Generating markup from
a design is the easy direction; the expensive direction is finding out where the built page
drifted from it. A screenshot diff answers that with one number per section — "90% similar" —
which is true, useless, and names nothing. `design.measure` hands back Figma's own CSS for
every layer, addressed by a path that survives re-reading, so the check becomes an assertion a
test can make and a failure names the property: this padding is 40, the page renders 60.

`node.states` and `frames.compare` exist for the same reason. A file already says what hover
does to a chip and how the 375 frame differs from the 1440 one; before these ops that knowledge
stayed inside the exporter, and every consumer re-derived it by eye.

**`component.api` is the op for declaring a component in a language.** `components.list` gives
the signature for every component in the file — axes, options, defaults — and that is what an
`enum ButtonType { primary, secondary, tertiary }` is written from. The half it never answered is
what a value *does*: that derivation existed twice, both times below a formatter (the CSS emitter
diffs the default variant against single-axis siblings and prints rules; the React emitter aligns
variant subtrees), so a SwiftUI or Compose build could reach it only by generating a stylesheet it
has no use for and parsing that back.

The same walk, answering in properties:

```jsonc
// component.api { nodeId: "819:95512" } — axes[0].options[1], the Button's Secondary
{ "value": "Secondary", "variantId": "819:95530", "variantName": "Type=Secondary, Size=Large, State=Standart",
  "changes": [
    { "path": "", "property": "background",
      "from": "var(--Base-orange-O500---Main, #FB5B0A)", "to": "var(--Background-Neutral-0-Inverse, #000)",
      "fromToken": "Base/orange/O500 - Main", "toToken": "Background/Neutral 0 Inverse" },
    { "path": "arrow-right#0", "property": "presence", "from": "absent", "to": "added" }]}
```

Three decisions are load-bearing there. **One axis at a time:** `Secondary` is diffed against the
member where Type is Secondary and every *other* axis sits at its own default, because any other
sibling would attribute Small's padding to Secondary's colour. **The token, not the string:**
`getCSSAsync` answers `var(--Base-orange-O500---Main, #FB5B0A)`, a name mangled for CSS and
therefore not one a consumer can look back up — the variable is read off the node's own
`boundVariables`, so a Secondary button is built from `Background/Neutral 0 Inverse` instead of
from `#000`. **A layer that exists in only one of the two is a `presence` change**, which is how
"this variant has an icon and the resting one does not" arrives instead of being dropped.

A BOOLEAN or TEXT property cannot be diffed at all — it acts inside every variant — so each
reports `targets`: the layer it drives and the field it drives on it (`visible`, `characters`,
`mainComponent`). Those are searched across every member, not only the resting one: a boolean
that reveals an icon is wired on the variants that *have* the icon layer, and the default is
routinely not one of them, which is how `Right Icon` first came back "wired to nothing".

Two smaller repairs in the same place. `node.states` now accepts a **component set** — the id
`components.list` hands out — and says which member it answered about, instead of returning
`states: []` for a component whose hover is authored between its members. And `design.ir`'s
`components[]` carries `componentSetId` and `axes`, so the native path no longer needs a
document-wide `components.list` to turn a `componentKey` (which no read op accepts) into
something callable.

**A picture says whether it is a photograph or a cut-out.** `image.fills` reports `alpha` per
image (`none` / `alpha` / `unknown`), read from the file's own header — the bytes are already in
hand, so it costs nothing. That one bit decides how a picture is PLACED: a photo is a `cover`
fill under a scrim, a cut-out figure sits in a corner of a light card. Nothing in the Plugin API
states it, and getting it wrong is not subtle — a cut-out cropped as a photo puts the subject
under the headline. It reports what the format carries, not what the pixels use: an RGBA PNG
that happens to be opaque still answers `alpha`, because deciding otherwise needs a full decode.

**An image fill's crop arrives as numbers, not as a matrix.** Beside `imageTransform` (Figma's
own 2×3) every IMAGE paint now carries `placement`: `cover`/`contain`/`tile` for the scale modes
that need no matrix, and for a CROP the two quantities every consumer was deriving by hand —
`scale` (the image's size as a multiple of the layer's box) and `offset` (its top-left corner, in
the same multiples). This is the arithmetic behind Figma's own
`background-size: 265.451% 114.231%; background-position: -523.197px 0px`, done once. A rotated
crop answers `fit: "matrix"` rather than being flattened onto two axes: there is no honest
`background-position` for it, and a plausible wrong number is worse than a named refusal.

**A wait for a cold page is reported, not left to look like a hang.** Under
`documentAccess: "dynamic-page"` the first touch of a page loads it — measured at *forty seconds*
on a heavy page in a real file, and six milliseconds for the same call afterwards. From outside
the two are indistinguishable from a dead channel. Now any answer that paid that cost carries
`loading: [{ page, ms }]`, `document.info` reports `warmPages` (how much of the bill this session
has already paid), and a single node resolution gives up after 60 s with a sentence instead of
silence: *the load continues in the background — call again and it usually answers at once.*

One limit worth knowing, because it bit hard: while Figma is loading a page, **nothing in the
sandbox gets a turn** — the plugin's own `budgetMs` timers cannot fire either. The bridge's
ceiling is the only guard that still works there, and its timeout message now says so rather
than advising a longer wait.

**A page can be warmed on purpose.** `page.warm` loads one page and reports what it cost, so the
forty seconds are paid under a name that explains them instead of inside a working call that then
dies at the ceiling with nothing. `document.info` marks every page `warm: true|false` — the order
of work is the only lever a caller has over a cost it cannot avoid, and now it can see the map.

**`assets.export` says which assets are cut-outs.** With `alpha: true` every raster asset carries
`none` / `alpha` / `unknown`, read from the paint's uploaded SOURCE — never from the exported PNG,
which always has a channel and would answer `alpha` for everything. It is opt-in because
`getBytesAsync` hands back the whole original upload, unbounded by `maxPixels`; once asked for it
is cached per hash and charged against the same `budgetMs` as the exports. A vector, and a raster
with no image paint behind it, has no answer and the field is simply absent.

**A component set can be read in pieces.** `component.api` takes `budgetMs`: one option is a
`getCSSAsync` walk of two subtrees, and a wide set is minutes of that. Out of budget, the options
still carry their ids and names and the answer says `stoppedOn: "budgetMs"` — an option without
`changes` was not measured, which is not the same as measured and unchanged, and the note says so.

**Library variable reads page and budget.** Every variable in a library collection is a separate
round trip to Figma's team-library service: 213 of them measured 48 s on a good afternoon and
past 400 s on a bad one — which is how a token sync ends up dying at the ceiling with nothing.
Both routes now finish. `library.variables` answers inside `budgetMs` with what it read, hands
back `nextOffset`, and takes `offset` to continue; `values: false` skips the imports entirely and
answers in a second when names and types are all that is wanted. `variables.get { library: true }`
takes the same `budgetMs`/`offset` — and its `collection` filter now runs BEFORE the sweep, so
asking for one palette costs one palette instead of every enabled library. The repository's own
token sync (`packages/tokens/sync.mjs` in the site repo) loops on `nextOffset`, and the hand-added
token it needed while this was broken is gone: the value now comes from Figma.

**The bridge no longer promises a window its clients cannot wait.** Node's `fetch` drops a
request after 300 s with a bare `fetch failed`, whatever `ALLCREW_CHANNEL_AGENT_CALL_TIMEOUT_MS` says.
`/status` publishes `clientCeilingMs` beside `callTimeoutMs` and a `ceilingNote` when the two
disagree, and the startup banner says it once where a person will see it.

**Every easing now travels twice: as the CSS it renders to, and as the numbers it is.** A
timing-function string is a web answer. `EASE_OUT` is an opaque name whose control points live in
this repo's reverse-engineered table and nowhere in Figma's API; a spring is worse — the CSS path
solves its ODE and hands over eighty sampled points inside `linear(0, 0.018, 0.071, …)`. Neither
is usable by `Animation.spring(response:dampingFraction:)` or Compose's
`spring(dampingRatio, stiffness)`, so a native consumer either re-fit a spring from the curve
that was solved *from* those very numbers, or gave up and substituted `easeOut`.

So `curve` rides beside the string, built from what the solver already had in hand:

```jsonc
// node.get / flow.map / node.states — a preset, with the points it stands for
"curve": { "kind": "bezier", "x1": 0, "y1": 0, "x2": 0.58, "y2": 1, "preset": "EASE_OUT" }
// a spring: ζ and ω₀, plus the same numbers in each platform's vocabulary
"curve": { "kind": "spring", "dampingRatio": 0.75, "angularFrequency": 10, "responseMs": 628,
           "stiffness": 100, "damping": 15, "mass": 1, "initialVelocity": 0,
           "settlingMs": 729, "source": "physical" }
```

`settlingMs` is solved, not nominal: a spring ignores the duration field, so it is the only
honest answer to "how long does this run". `source` is the flag that matters before trusting the
rest — `preset-table` means the numbers rest on the reverse-engineered `NAMED_SPRING_BOUNCE`
estimate rather than on physics Figma stated, and that warning used to reach the Django export
report and no op. An easing this repo cannot name (a variable alias, a preset newer than the
table) omits `curve` rather than answering `linear`: a consumer that gets nothing falls back
knowingly, one that gets a wrong curve does not.

It travels everywhere a transition does — `node.get`, `node.states`, `design.ir`
(`interactions[]` and `transition`), `transition.context`, `motion.context` keyframes — and
`flow.map` edges now carry the `navigation` kind and the transition too. An edge used to be five
strings; "PUSH from the right, 300 ms, EASE_OUT" is a SwiftUI `NavigationTransition` or a Compose
`AnimatedContentTransitionScope`, and it was being computed one function away and dropped.

### What that buys an agent

`components.list` + `page.frames` + `flow.map` is the discovery half of "assemble a flow from
components". An agent can name the button variant it wants, name the frame it belongs on, and
read back how the prototype already wires the screens together — before anything is allowed to
touch the document.

### Playbooks: the order, not just the surface

The manifest says what each op does. It does not say which five to call, in which order, to
get a screen built — and that is what a fresh agent gets wrong: it screenshots a frame and
writes code from the pixels while the file could have told it the token, the variant and the
transition.

`guide.list` names the tasks (`file.bootstrap`, `screen.build`, `mobile.app`, `system.extract`,
`motion.implement`, `fidelity.check`, `document.write`); `guide.get` hands one back with its
steps, the example params for each, what to verify when it is finished, and the traps the task
has. Each step carries the op's *own* summary and guidance alongside it, so a playbook is one
call rather than one plus five lookups.

The rule is the module contract's: **nothing is named that the build does not have.** Every
step names a registered op and every example param is one that op declares — a test enforces
both, so a renamed op breaks CI rather than sending an agent at a command that no longer
exists.

### A screen without a framework: `design.ir` and `assets.export`

`design.context` answers with HTML and CSS. That is the right answer for a web page and the
wrong one for everything else: an agent building a React Native screen, a SwiftUI view or a
Compose screen has to *un-read* the markup to find the stack, the gap and the token under it.

`design.ir` hands over that layer directly — the same intermediate tree the plugin's own
exporters compile, before any of them turns it into a language. Layout arrives in flexbox
vocabulary (row/column, gap, padding, justify/align, fixed/hug/fill) because that is the model
every modern target expresses: `row` is RN's `flexDirection`, SwiftUI's `HStack`, Compose's
`Row`. The tree itself comes back as a file; `stats`, `tokens`, `components` (each set with the
property values it was instantiated with) and `assets` come back inline, so an agent can decide
what is worth opening.

It is deliberately *not* a code generator. No framework is assumed and none is emitted —
which is what makes it usable for a target this plugin has never heard of.

**The tree carries no colour until you ask: `appearance: true`.** This deserves saying plainly,
because it was the channel's largest hole and it looked like the opposite. `IrNode` is layout
and structure only — no fill, no stroke, no radius, no shadow, no opacity, no rotation. The
reason is honest and, for the web, correct: the CSS emitter reads all of that off the LIVE Figma
node at emit time, so putting it in the tree would be dead weight on the one path that ships.
It is not correct for anything else, and it is the same argument already made for typography one
paragraph down — a web target can afford re-reading the node and a SwiftUI one cannot, because
it runs after this window has closed.

So `appearance: true` puts it on every node, and every value arrives as `{ token, value }`:

```json
{ "id": "1:42", "name": "Card", "type": "container",
  "appearance": {
    "fills": [{ "type": "SOLID", "index": 0, "color": "#1A1A22", "bound": "colors/surface" }],
    "radius": { "token": "radius/lg", "value": 24 },
    "strokeWeight": { "value": 1 },
    "opacity": { "token": "opacity/muted", "value": 0.5 },
    "layoutTokens": { "itemSpacing": "spacing/xl", "paddingLeft": "spacing/lg" } } }
```

Build from `token` and fall back to `value`. A token present means the design system named this,
and emitting `Tokens.colorsSurface` is a different artifact from emitting `#1A1A22` — the first
follows a theme and the second does not. A token *absent* is not a gap in the answer: it means
the designer hard-coded that value, which is itself what a linting build wants to know.

`layoutTokens` is the same idea for the numbers the layout already carries in pixels. Keyed by
Figma's own field names (`itemSpacing`, `paddingLeft`, `width`) rather than CSS property names,
because `border-width` means nothing to Compose — and because those are the keys `node.bind`
writes back through, so a read and the write that would recreate it speak one vocabulary.

`painted` comes back beside the tree: how many nodes got an appearance, and how many this pass
could not reach. An export-flattened subtree has no single layer behind it to read paint from,
and claiming default paint for it would be a plausible wrong answer — so it gets none, and the
count says so rather than leaving a bare node ambiguous.

**`platform` says what one Figma pixel is.** Everything in the tree is raw Figma pixels. On a
logical artboard that is also one CSS pixel, one iOS point and one Android dp, and nothing needs
saying. On an artboard a designer drew at 2× — still common, and invisible in the data — every
number in the tree is twice what the build should emit, and the failure mode is a screen that is
correct in proportion and twice the size. `platform: "ios" | "android" | "web"` adds `units`:

```json
{ "platform": "ios", "unit": "pt", "textUnit": "pt", "scale": 2,
  "basis": "750px is 2× a 375pt ios width — divide every length by 2",
  "assetScales": [1, 2, 3], "assetNaming": "ios" }
```

The density is derived from the frame width against the widths the platforms actually ship, and
`basis` says what it concluded from — a frame matching nothing gets `scale: 1` and
`"matches no standard ios width — treated as 1×, check the artboard"`, because a guessed density
is worse than a named one. `textUnit` differs from `unit` on Android alone, and that asymmetry is
the whole reason it is a separate field: a font size, a line height or a letter spacing goes in
`sp` so the system font-size setting reaches it, and everything else goes in `dp`. A text metric
in `dp` is the most common accessibility defect in a generated Android UI, and nothing in the
build reports it. Pass the same `platform` to `assets.export` and its `naming` and `scales` come
from that one profile, so a manifest and a tree cannot disagree about the same screen.

**The type comes as a table, because the tree never carried it.** Font family, size, weight,
leading and tracking live on the Figma node, and the CSS emitter reads them off the live node
on its way out — which a web target can afford and a SwiftUI one cannot. `type` groups the
screen's text layers into the handful of distinct styles it actually uses, most used first,
each with the token behind each value where one is bound, the layers that use it and a sample
of its text. A 417-layer mobile screen comes back as twenty-two styles; ninety text layers of
body copy are one row, not ninety.

A property Figma reports as *mixed* says `mixed` rather than borrowing the value of the first
run — a paragraph set in the style of its first three characters is exactly the bug that would
cause. Per-run overrides are `text.segments`, which is the op for that question.

**The screen half is phone-shaped.** `screen` reports the size and what it usually means
(`phone`/`tablet`/`desktop`), whether the frame scrolls, how many children are placed by
coordinates rather than by a stack — zero means the whole screen maps onto stacks with no
absolute offsets — the layers the designer pinned while the rest scrolls, and **what sits in
the system bands** top and bottom.

That last one is deliberately reported as layers, never as an inset. **Figma has no safe-area
concept:** a status bar in a frame is a layer like any other, and whether to keep it, inset
around the real one, or drop it is the build's decision. A layer counts as being in the band
only when it sits *inside* it — a content column starting at y=60 is below the status bar, not
part of it, and listing it would make the report useless on every screen.

`assets.export` is the other half: the IR points at pictures, this produces the files. Formats
and densities are the caller's (`[1,2,3]` for mobile, `[1,2]` for web; SVG and PDF export once,
because three identical vectors is three files and a slower answer), and `naming` decides the
layout the manifest advises — an asset catalogue for `ios`, density buckets for `android`, an
`@2x` pair for `web`. The files themselves always arrive as flat basenames, because the bridge
refuses a path; where each belongs is in the manifest, so the agent moves them instead of
guessing a convention.

With `naming: "ios"` the call also hands back the `Contents.json` for each imageset, because
Xcode does not read loose files: an imageset is a directory plus the manifest that maps each
density to its file, and without it three PNGs are three PNGs. It arrives as one more file in
the answer, with the path it belongs at (`Assets.xcassets/<name>.imageset/Contents.json`). A
vector is a different entry rather than a 1x one: SVG and PDF go in as a single file with no
scale and `preserves-vector-representation`, which is what lets Xcode draw it at the size the
layout asks for instead of pinning it to the density it was exported at.

**One answer holds about 2.5 MB of image data, and a screen comes in pages.** That number is
measured, not chosen: a reply under ~2.5 MB comes back in under a second, and one over ~3 MB
never arrives at all — the sandbox→UI hop stalls and the call dies on the bridge's 180-second
ceiling with nothing to show for it. So `assets.export` stops *before* crossing the line, says
`remaining` and `nextOffset`, and the caller asks again with `offset`. A section whose six
pictures are 6.5 MB at three densities takes three calls of about a second each.

Two more limits guard the other ways one call can hang, and each names itself in the answer
rather than failing whole: `budgetMs` (checked between exports — one export already under way
runs to its end) and `maxPixels`, the one worth knowing. Figma's exporter is not linear in
size: the same 1440×756 section comes back in 0.6 s at `@2x` (2.2 MP) and takes over two
minutes at `@3x` (9.8 MP), with no way to interrupt it. Four megapixels is the default ceiling,
and the skip reason names the alternative — export the image or icon layer, not the frame
around it.

One thing that looks like a fix and is not: yielding to the host between exports. Figma's
watchdog does drop a plugin that holds the main thread for ten seconds, so a `setTimeout(0)`
between exports is the obvious guard — and it cost *six seconds per export* here, turning a
0.9-second batch into 39 seconds, because the UI iframe is parked on a long poll while the
sandbox waits for a timer it will not get promptly. The byte ceiling keeps calls short enough
that the watchdog never comes into it.

### Judging the build: `design.audit`

`design.measure` is the assertion for a web build — Figma's own CSS per layer, to compare
against the browser's computed styles. A SwiftUI or Compose build has no browser to measure, so
until now nothing checked a native screen at all, and the failure mode was silent: a screen that
is structurally right and painted from memory.

`design.audit` is the counterpart, and it works the way `NODE_ROUNDTRIP` does — the judge is the
thing that did the work, not a second list of what ought to happen. Report what you actually
emitted, per layer, keyed by Figma node id, in the channel's own property names:

```bash
allcrew-channel call design.audit '{
  "nodeId": "1:16", "platform": "ios",
  "built": [
    { "nodeId": "1:42", "properties": { "fill": "colors/surface", "radius": 12, "gap": 16 } },
    { "nodeId": "1:43", "properties": { "fontSize": 17, "text": "Hello" } } ] }'
```

Four verdicts, kept apart because they are four different bugs in four different places:

| Verdict | Means | Whose bug |
|---------|-------|-----------|
| `matched` | the design and the build agree. Naming the TOKEN counts, and is the better answer | — |
| `dropped` | the design said it and the build emitted nothing | the generator's |
| `diverged` | both have it and they disagree — usually a unit, a rounding or a mode | the mapping's |
| `missing` | the build needed it and **this channel could not answer** | **the channel's** |
| `unknown` | a property this channel does not describe, or a layer not in the tree | neither — a vocabulary gap |

`missing` is the one that matters most, and it is why the op exists. "The channel should reveal
as much of Figma as possible" is an instinct, and an instinct cannot be prioritised. `wanted`
collects the `missing` properties most-reached-for first, ordered by a real screen — these are
the properties a build actually went looking for and did not find, which is a very different
list from the one anybody would write from imagination. **Report them.** That list is how this
channel learns what to carry next.

A clean run answers with an empty `findings` array: a wall of agreement is not a report. Pass
the same `platform` and lengths are compared at the artboard's own density, so a 2× frame does
not come back with every number flagged. It needs `appearance` (on by default here) — without
it every paint property is `missing`, which is true and useless.

It is not a linter. It never says a value is wrong in the abstract, only that the design and the
build disagree — and which side could not speak.

---

## Who changed what, and when

Figma answers "who" and "when" directly and "what" **not at all**. Version history is a list of
snapshots — id, timestamp, author, optional label — and nothing in it says what moved. Measured
on a real file: **50 checkpoints over 12 days, one of them named**, and 16 authored by "Figma"
itself, which is autosave rather than a person. So the list is a record of contact, not of intent.

```bash
allcrew-channel call history.recent  '{"since":"2026-10-01T00:00:00Z"}'
allcrew-channel call history.versions '{"fileKey":"…","limit":30}'
allcrew-channel call history.blame    '{"fileKey":"…","nodeId":"4658:161435","property":"fills"}'
```

### `history.recent` — all files touched today

The bridge reads Figma Desktop's local `settings.json`, including open tabs and
`sharedTabHistory`, and checks version history four files at a time. The default window begins at
local midnight. It reports touched, quiet and unavailable files separately, plus checkpoint counts
per author. Only files opened on this machine are discoverable, and Figma checkpoints are periodic
rather than one per action.

### `history.versions` — the cheap, honest half

Works on any plan. Two fields decide what the list is worth:

- **`autosave`** — Figma saved this on its own. A point in time, not a decision. Counting these
  as history is how "50 versions" comes to mean nothing.
- **`named`** — somebody typed a label. The only place intent is recorded anywhere in the API.

`authors` counts checkpoints per person, which is the cheapest real answer to "who has been
working in here". When nothing in the window is named, the answer says so outright rather than
handing back a list that looks informative.

### `history.diff` — computing the "what"

`GET /v1/files/:key?version=X` renders the file as it stood at a version. Two of those, diffed,
is the answer. **Always pass `nodeId`:** one 200 KB subtree took **8–10 seconds per fetch**
against the live API, so an unscoped diff is two whole-document renders, and a walk of a version
list is minutes inside a 180-second ceiling. Every answer reports `fetches` and `ms`.

Read `properties` first. On a real 12-day span it said:

```
properties that moved:   37 fills   25 background   24 backgroundColor   5 overrides   3 boundVariables
```

That is a sentence — somebody went through and re-did the imagery. The list of 40 changed layers
underneath it was not. `changed[].moved` carries the before/after per property, clipped, because
a diff is a report and not a payload.

A change is the node's **own**: `children` is excluded from a node's identity, because otherwise
editing one label reports its card, its screen and its page as changed too, and the diff of a
real screen becomes a list of everything above the edit.

### Attribution has exactly one honest shape

A diff between **consecutive** checkpoints belongs to the author of the later one. A diff across
a span does not belong to anybody — and crediting the author of the endpoint would be a claim
about work that is not theirs. So `history.diff` answers `by: null` for a span and says why, and
`attribute: true` **refuses** unless the two versions are adjacent.

### `history.blame` — the op that answers the question

There is no blame primitive anywhere in Figma: nothing attributes a property to a person. So this
bisects. Render the node at the newest and oldest checkpoint in the window; if they differ, halve
the range until the single checkpoint that changed it is isolated. That checkpoint has one author
by construction, so the attribution is a fact rather than an inference.

`log2(N)` renders instead of `N` — about 6 for a 32-checkpoint window instead of 32, which at
8–10 seconds each is the difference between an op and a timeout. Renders are cached per version
because bisection revisits midpoints, and `budgetMs` stops the search and reports how far it got
rather than dying on the ceiling with nothing to show.

`property` narrows it, and that matters more than it sounds: without it, "who changed the fill"
stops on whoever last nudged the layer. A node that did not change in the window says so, instead
of blaming the nearest edit.

### `history.mark` — putting intent back in

`figma.saveVersionHistoryAsync` is the only write into version history in any Figma API — REST
cannot create a version at all. Call it **around** a batch of changes: a named checkpoint before
and after turns a diff across an anonymous span into "this is what that run did", which is the
difference between history an agent can interpret later and the 49-of-50 that nobody can.

Figma warns that changes made immediately before the call may not be included, so the op waits a
second first — a version missing the very work it was created to mark is worse than no version.

One measured surprise, documented nowhere: on a file with **no changes since the last autosave**,
`saveVersionHistoryAsync` renames that checkpoint instead of creating one, and returns its
existing id. So marking before and after a run that changed nothing leaves a single version with
the second title, not two. Verified live — the call reported a version id that already existed,
and the label appeared on it.

### What history cannot do

| Asked for | Why not |
|-----------|---------|
| `history.activity` | Activity logs need a **plan access token** with `org:activity_log_read` sent as an OAuth Bearer header. A personal access token answers 401 whatever its scopes, and the endpoint is organisation-level rather than per-file. This channel deliberately holds no org-wide credential. |
| `history.developerLogs` | Needs `org:developer_log_read`, and it records REST/MCP **API requests** — it answers "which token read this file", not "who changed this layer". |
| `history.restore` | No endpoint restores a version. Reverting is a person in the UI. An agent can read the old values with `history.diff` and write them back with the ordinary write ops, which is a different thing and leaves its own checkpoint. |

And the structural limit worth stating plainly: **no per-property authorship exists.** The finest
attribution the API supports is one checkpoint, and a checkpoint can contain an hour of work by
one person. `history.blame` gets you to that checkpoint and no finer, because there is nothing
finer to get to.

---

## Annotating a design: comments

Comments are the designer's half of the conversation, and until now the channel could not see
them. Not an oversight — **the Plugin API has no comment surface at all.** `grep -i comment`
over `@figma/plugin-typings` returns nothing. They exist only over REST, so comment ops are the
one class the **bridge answers itself**, whether or not a plugin is open, and the only ones that
need a Figma token.

```bash
allcrew-channel call comments.list '{"fileKey":"…","resolved":false}'      # what is still open
allcrew-channel call comments.list '{"fileKey":"…","nodeId":"4658:161435"}' # …on this screen
allcrew-channel call comments.post '{"fileKey":"…","nodeId":"I4658:161436;4296:60528",
                                  "message":"This gap is 14px; the token is spacing/md (16)."}'
```

`fileKey` is required and cannot be defaulted from the plugin: `figma.fileKey` is **null** for
an Organization-private plugin, which is the common case on a paid team. Pass a key or a Figma
URL — either is accepted.

### Aiming is the whole problem

Figma pins a comment with `{node_id, node_offset}` where the offset is measured **from the
top-left of a FRAME**. An agent has neither half: the node id it holds is a deep layer, and that
layer's own `position` in `design.ir` is relative to its *parent*, which is not the frame.
Composing one into the other means walking ancestors and summing transforms, and getting it
wrong is not a visible error — it is a pin a few hundred pixels off, which reads as the
designer's mistake rather than the tool's.

So `comments.post` takes a `nodeId` and does the aiming, through `node.anchor`:

```json
{ "node": { "id": "label", "name": "Label", "type": "TEXT" },
  "frame": { "id": "screen", "name": "Screen", "box": { "x": 1000, "y": 500, … } },
  "inFrame": { "x": 56, "y": 96, "width": 100, "height": 20 },
  "offsets": { "center": { "x": 106, "y": 106 }, "top-right": { "x": 156, "y": 96 }, … },
  "depth": 2,
  "pin": { "node_id": "screen", "node_offset": { "x": 106, "y": 106 } } }
```

Three things that matter about it:

- **It addresses the frame, not the canvas.** A frame-relative pin moves with the screen when the
  designer drags it across the page; an absolute point does not. That is why `nodeId` is the
  default path and `x`/`y` is the fallback, not the other way round.
- **Nine named points**, so "the top-right corner of the badge" is `anchor: "top-right"` rather
  than arithmetic. `center` is the default because that is what an annotation wants.
- **It subtracts two `absoluteBoundingBox`es** rather than accumulating `relativeTransform` up
  the tree. The accumulated version has to reproduce Figma's own rotation and scaling composition
  exactly and silently disagrees the first time a group is rotated; two absolute boxes subtracted
  is exact. A GROUP is skipped on the way up — a pin on a group tracks a bounding box that moves
  whenever any child moves — and a rotated layer answers `rotated: true`, because there is no
  honest single point for "the top-left of a rotated label" and `center` is still exact.

`width` + `height` make it a **region** pin instead of a dot, for "this whole block is wrong",
with `pinCorner` choosing which corner the marker hangs off.

### What Figma cannot do, said out loud

There are exactly six comment endpoints — GET/POST/DELETE for a comment and the same three for
its reactions. Everything below is refused **by name**, with the reason, rather than by letting a
call discover a 404:

| Asked for | Why not |
|-----------|---------|
| `comments.resolve` / `comments.unresolve` | **There is no resolve endpoint.** `resolved_at` is in the `Comment` schema as readable and read-only, and nothing in Figma's OpenAPI spec sets it. Ticking a thread done is a person in the UI, not an API operation. |
| `comments.archive` | There is no archive in Figma's model. A thread is open or resolved, and neither transition is in the API. |
| `comments.edit` | No PUT, no PATCH. Delete your own and post again, or reply with the correction so the thread keeps its history. |
| `comments.mention` | The message is plain text. An `@name` in it stays text and notifies nobody. |

This is the one that matters, so it is worth being blunt about: **an agent cannot mark work
done.** It can reply saying what changed, and it can leave a 👍 — `comments.react` is the closest
the API comes to a "seen" mark, and it is explicitly not resolution. What it must not do is post
"done" and report the thread closed, because the designer's inbox will still show it open. Every
`comments.list` answer carries that sentence in its `note` for the same reason.

### The gate

A comment **write** requires a connected plugin whose write gate is on, even though the plugin
does none of the work. The gates are how a designer consents to an agent touching their file, and
a comment posted into it is as visible as a layer moved in it. Reading the gate the plugin
*pushed* (on hello, and on every change) is not the bridge deciding for itself — it is the
plugin's own statement, the same authority `/call` round-trips for. With nothing connected there
is no statement and no designer, so a write is refused rather than allowed by default.

Reads follow the read gate the same way, and need no plugin at all when none is open: a
token-holder reading comments over REST is doing what the Figma web app does.

A personal token needs the **`file_comments:read`** scope to list and **`file_comments:write`**
to post. Both are chosen when the token is created and cannot be added afterwards — and a missing
scope arrives as the same 403 as an expired token, so the refusal names both possibilities.

---

## Many ops, one round trip

Composing a screen is dozens of calls, and one call each pays a full
stdio→HTTP→poll→postMessage→postMessage→HTTP crossing, gives the designer their own ⌘Z entry,
and stakes its own 180-second bet. Thirty node writes were thirty of each.

```bash
allcrew-channel batch '[{"op":"node.bind","params":{…}},{"op":"node.style","params":{…}}]'
echo '{"calls":[…],"continueOnError":true}' | allcrew-channel batch -
```

Through MCP the same thing is the `allcrew_channel_batch` tool. Two properties worth knowing:

**Strictly in order, one at a time.** Not an optimisation left on the table. The sandbox does
not serialize `handleAgentRequest`, so a parallel batch interleaves inside the plugin and the
module state the ops share — `loading.ts`'s page timings, `ui-post.ts`'s reply recorders — is
attributed to whichever call happens to finish first. A batch that builds a screen also means
its order.

**Stops at the first failure** unless `continueOnError` is set, and the answer always says how
far it got: `ran`, `of`, `failedAt`. A batch that keeps writing after step three refused leaves
a half-built screen nobody asked for; one that stops without saying where is worse. Thirty-two
ops per batch, sized so a batch cannot outlive the single-call ceiling it shares.

---

## Building a screen on any platform, in order

The ops answer different questions and the order matters more than any of them individually.
This is the sequence that survived a real build (a Django/Next site, and the same file's mobile
DS), with the thing each step exists to prevent:

| Step | Op | What it prevents |
|------|----|------------------|
| 1. warm the page | `page.warm` | the FIRST read of a heavy page loads it — 40 s of silence that eats a working call's budget and can wedge the session |
| 2. read the tree | `design.ir` (`appearance`, `platform`) or `design.context` for web | rebuilding layout from a screenshot; `platform` also converts every length into that platform's unit |
| 3. tokens | `tokens.emit platform:` | hard-coded hexes, and CSS custom properties handed to SwiftUI, where they type-check and render nothing |
| 4. copy | `text.inventory role: "content"` | a string that exists only in the picture: it never reaches the CMS, never reaches the translation file, and is English for ever |
| 5. assets | `export.plan` → `export.run` / `NODE_EXPORT` | an export refused by the 3 MB hop, a vector baked into a raster, or a widget drawn twice |
| 6. motion & states | `motion.context`, `node.states`, `transition.context`, `flow.map` | hover, press and navigation invented by hand; the numbers are in the file |
| 7. check | `design.measure` (web) or `design.audit` (everything else) | "looks about right" — both name the property that diverged |

Three things this channel taught the hard way, now encoded in the ops rather than in somebody's
notes:

- **One answer carries about 3 MB.** A 1296×580 hero at 2× is 3.5 MB of PNG and is refused
  whole; the same frame as SVG is 9 MB, because Figma embeds the photo as base64. `export.plan`
  reads the size and the fills and picks the density before the call, and says `oversized` when
  nothing fits rather than handing back a call that cannot work.
- **`withoutChildren` is all or nothing.** A slot whose children are ALL marked for export can be
  split into a plate plus vectors — that is the only way a crisp widget sits over a photo. Mark
  half of them and the split would drop the other half, so the plan stays a flat render.
- **Export marks were invisible.** `exportSettings` is reported by no other read — not
  `node.get`, not `design.ir`, not `NODE_QUERY props` — which pushed one consumer into Figma's
  REST API with a token just to see which frames the designer had flagged. `export.settings`
  closes that, and with it the last reason a build needed credentials of its own.

## Failures a program can act on

Every refusal carries a `code` and a `retryable` flag beside the prose. The prose is the good
part and it is not going anywhere — it names the switch to flip, the roster to choose from, the
environment variable to raise. But it is the wrong shape for the consumer that matters most
here: an agent deciding what to do next. `reads are off` means *ask a human, then retry*;
`unknown op` means *never retry, pick another op*; `no answer within 180s` means *retry as is*.
Telling those apart by matching English is not a policy, it is a guess that breaks the first
time someone improves the wording — and all three used to arrive as `HTTP 400 {ok:false,error}`.

| Code | Retry? | Raised when |
|------|--------|-------------|
| `bad_request` | no | no `op` in the body, or a malformed batch |
| `unknown_op` | no | the op is not in this build's registry |
| `param_invalid` | no | params failed the op's own spec — missing, mistyped, out of range, unknown key |
| `ambiguous_target` | no | more than one file is connected and none was named; the answer carries the roster |
| `no_route` | no | no such path on the bridge |
| `broadcast_write_refused` | no | a write addressed to every open file at once |
| `payload_too_large` | no | the answer will not fit the hop. The same call produces the same bytes — narrow it |
| `rest_unavailable` | no | this op needs the plugin open and only the REST fallback was there |
| `unauthorized` | yes | bad or missing secret, or a closed pairing window |
| `gate_closed` | yes | a switch the designer controls is off — one click from working |
| `no_plugin` | yes | nothing is connected |
| `figma_threw` | yes | the op ran and Figma (or the op) threw |
| `timeout` | yes | the bridge stopped waiting |
| `disconnected` / `reconnected` / `listener_off` | yes | the window went away, re-handshook, or was switched off mid-call |
| `file_write_failed` | yes | the bridge could not write the files an op returned |
| `internal` | yes | something the bridge did not anticipate |

`retryable` is not "whose fault": `unauthorized` and `gate_closed` are retryable because the
retry is the right next move once a human has acted, and an agent treating them as terminal
gives up on a channel that is one click from working.

**`timeout` is retryable and that is a trap worth stating.** The bridge giving up is not the op
stopping: a write that timed out may already have committed, and nothing in the transport can
tell you whether it landed. Check the document before retrying a write.

One failure used to lie outright. An answer past the ~3 MB the sandbox→bridge hop carries had
its delivery POST destroyed, the failure swallowed, and the caller waited out the full ceiling
to be told "no answer from <handle>" — about an op that ran, succeeded and, if it was a write,
committed. The size is now measured before the send and refused with `payload_too_large` and the
actual number, so the caller narrows the request instead of retrying a write it cannot tell
already landed.

---

## The rest of the plugin: `plugin.call`

The ops above are hand-written. The plugin itself is much bigger than them — the colour-token
remap, the token and Django exporters, the palette generator, the lint batch-fix, the
standardised old/new board — and all of it already exists as one `case` in the UI→sandbox
switch in `src/code.ts`. Writing an op per feature would keep the channel permanently one
step behind the panel, so it isn't done that way:

```bash
curl -s "$BASE/call" -H "x-allcrew-channel-secret: $SECRET" \
  -d '{"op":"plugin.commands"}'                                  # what exists
curl -s "$BASE/call" -H "x-allcrew-channel-secret: $SECRET" \
  -d '{"op":"plugin.call","params":{"command":"REMAP_SCAN"}}'     # run one
```

`plugin.call` sends the message a click would have sent and returns the replies the command
posted. Three things make that safe enough to be worth having:

- **The table is extracted, not maintained.** `build.mjs` parses the switch (and the
  `PluginMessage` union, for which params are required) into the registry the channel
  authorises against, on every build. A `case` added tomorrow is callable the moment it ships.
- **The gate is decided per command.** Each case carries an `// @agent read|write|deny:`
  marker — the one line to write when adding a command. Only `read` passes on the read gate;
  an unmarked case counts as a write, and `AGENT_*` is refused structurally so the channel
  cannot reach its own gates.
- **Replies are recorded, not intercepted.** The panel receives everything, so the designer
  watches what the agent did — and UI-side work (a zip built from an export) still happens.
  Long strings in a reply become files on disk, the same rule as the ops above.

**The token package is one of those commands, and it takes two decisions.** `SCAN_TOKENS` builds
it, and `params.tokens` overrides what the designer last saved — an agent must not depend on a UI
it cannot see:

```bash
curl -s "$BASE/call" -H "x-allcrew-channel-secret: $SECRET" \
  -d '{"op":"plugin.call","params":{"command":"SCAN_TOKENS",
        "params":{"tokens":{"includeLibraries":true,"emitNative":true}},"timeoutMs":300000}}'
```

- `includeLibraries` reads the variables of every enabled library, not only the local ones. It
  is a network read per token — 44 s on a file with 213 of them, so raise the timeout — and it is
  the only way to export a theme the file *consumes* rather than owns. A file whose Light/Dark
  lives in a shared library produced a package of stray local colours with no theme in it before
  this existed; left off, the answer's `summary.notes` now names the collections it skipped.
- `emitNative` adds the platform layouts beside the CSS: one `.colorset` per colour with a dark
  appearance *where the dark theme actually changes it*, `res/values{,-night}/colors.xml` (the
  night file carrying only the overrides), and `Tokens.swift`/`Tokens.kt` for the spacing, radii
  and type scale a catalogue cannot hold. `tokens.ts` is not an answer for those targets: its
  leaves are the *strings* `var(--text-primary)`, which type-check in Swift and resolve to
  nothing.

Sandbox state is shared with the panel, so multi-step features follow the panel's order:
`REMAP_SCAN` → `REMAP_PREVIEW` → `REMAP_APPLY` / `REMAP_BOARD`.

---

## Adding an op

Most features need no op at all — see `plugin.call` above, which reaches every panel command
for free. Write an op when an agent needs something the panel has no button for. Register it
in `src/agent/ops.ts`:

```ts
{
  name: 'frame.duplicate',
  summary: 'Copy a frame and offset it.',
  mutates: true,              // ← puts it behind "Allow changes"
  params: {
    nodeId: { type: 'string', description: 'Frame to copy.', required: true },
  },
  async run(params) { /* … */ },
}
```

`params` is both validation and documentation — it is what `allcrew-channel ops` prints and what
an agent reads to call correctly. Nothing else needs touching: the manifest, the gate and the
CLI all derive from the registry.

Two things a mutating op must do that a read op doesn't:

- call `figma.commitUndo()` when it finishes, so each agent step is its own ⌘Z rather than ten
  steps collapsing into one;
- return paths, not payloads, for anything large — route bulk output through
  `deliverPackage` (`src/delivery.ts`) and hand the agent a path to read.

`documentAccess: "dynamic-page"` applies throughout: `getNodeByIdAsync`, `page.loadAsync()`,
never the synchronous getters.

---

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `plugin: not connected` | plugin closed, or **Allow reads** is off |
| `bridge rejected the secret (401)` | the plugin paired with a different bridge, or you set `ALLCREW_CHANNEL_AGENT_SECRET` after pairing — re-pair, or align the two |
| `pairing window is closed` | more than five minutes since the bridge started — restart it, or run `node agent/bridge.mjs --pair` |
| `no secret found` (CLI) | the bridge has never run on this machine |
| `cannot reach the bridge` | `agent/bridge.mjs` isn't running |
| status shows `bridge unreachable — retrying` | plugin can see the URL but nothing is listening |
| a call hangs, then times out, against a file that looks connected | a closed window whose farewell never arrived. The plugin says goodbye on unload, but if the frame is killed outright the session lingers until the bridge's own idle window closes it — pick another handle from `status` |
| Works on desktop, not in the browser | browser Figma may block loopback (Private Network Access). Use the desktop app, or put the bridge behind HTTPS. |

The bridge logs every call with its op and duration; the plugin's status line shows the same
thing to the designer.

## Getting a build in front of Figma

Figma does not load this plugin from the repo. It loads it from whatever `manifest.json`
path is registered in `~/Library/Application Support/Figma/settings.json` — on this machine
an external volume, not the checkout you just built in. So a build is not a deploy, and
"restart the plugin" fixes nothing until the files move.

Deploy the pair with `agent/deploy-to-figma.sh`, which exists because the failure it prevents
is invisible: a `dist/code.js` from one build landing beside a `dist/ui.html` from another —
both files intact, nothing corrupt to notice, and a UI calling into code that has never heard
of it. rsync exiting 0 is not evidence that both arrived; the script compares md5 on both
sides and retries until they agree, then clears the `._*` stubs a dying network mount leaves
behind.

Then confirm with one call to something the new build introduced — `"unknown op"` means the
deploy did not land, whatever the terminal said. Reopening the plugin is not part of the
routine: on 2026-08-27 three consecutive deploys answered with the new behaviour within
seconds of the pair landing, and nobody touched the plugin window. Ask for a restart only
when that call says `"unknown op"` while md5 already matches on both sides — then the files
arrived and the runtime is holding an older copy.

Why it works is NOT established, and the difference matters before anyone builds on it. A
plugin session sometimes rotates on its own — one was seen replaced with no deploy anywhere
near it — so "answered immediately after the deploy" does not distinguish a runtime that
re-read the code from a session that happened to restart underneath us. The deploy script
therefore prints the session ids from `/status` on both sides of the transfer: the same id
plus new behaviour would settle it, a changed id means the run proves nothing. Until a
deploy is measured that way, treat the advice above as what was observed, not as how Figma
works.
