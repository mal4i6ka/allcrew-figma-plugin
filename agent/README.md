# Agent listener

Lets a CLI agent — Claude Code, Codex, a shell script, `curl` — ask questions about the Figma
file the designer currently has open, through the Altery plugin's own Plugin API access.

It is MCP-shaped without being MCP: there is no server to register, no client library, and
nothing to keep in sync but the op names. If a tool can run a shell command, it can drive
Figma.

**Reads and writes, gated separately.** Most ops only look; four of them change the document
and sit behind their own switch, which reads never imply.

---

## Why it is built inside-out

A Figma plugin cannot be reached from outside. The sandbox has no listening socket, and there
is no headless mode — a plugin only exists while a person has it open. So the plugin dials
*out*, and a local bridge gives the CLI something conventional to talk to:

```
   agent (Claude Code, curl, …)                plugin (UI iframe → sandbox)
       │  POST /call {op, params}                  │
       ▼                                           │  GET /plugin/poll   (parked ~25s)
   bridge.mjs ─────── hands the request over ──────┤
       │                                           │  POST /plugin/result
       ◄────────────── answers the waiting call ───┘
```

Two consequences worth knowing before you build on this:

- **The plugin must be open.** Close it and the channel is dead. An agent cannot open a Figma
  file by itself.
- **The transport lives in the UI iframe,** not the sandbox — the sandbox has `fetch` but no
  socket, and keeping the poll out of it also keeps the main thread free. The iframe only
  relays; the sandbox decides what may run.

---

## Setup

Pick **Agent Listener** in the plugin's header picker. That screen is the whole setup: a
button that opens and closes the channel, the bridge command, and the skill to hand your
agent.

**1. Get the bridge and run it.** Press **Download bridge.mjs** on that screen — a designer
who installed the plugin from Figma has no checkout of this repo, so the plugin carries the
script itself (injected at build time from `agent/bridge.mjs`, so it can never be a different
version). From a checkout, `node agent/bridge.mjs` is the same file.

```bash
node ~/Downloads/bridge.mjs
```

Loopback only, no dependencies, no arguments; needs Node 18+, which the CLI agent you are
wiring up already requires. First run mints a secret into `~/.altery/agent-secret` (0600) and
opens a five-minute pairing window.

**2. Press "Pair with bridge"** in the plugin. It collects the secret and stores it in that
designer's own Figma client storage. The window closes behind the first pair.

**3. Press "Start listening."** The channel is open; every call an agent makes is listed
right there as it happens.

**4. Copy the skill** from the same screen and save it as `.claude/skills/figma/SKILL.md` in
whatever project your agent works in. Claude Code picks it up from then on. Any other CLI:
paste it wherever that tool reads standing instructions.

Then, from anywhere:

```bash
curl -s localhost:8788/call -H "x-altery-secret: $(cat ~/.altery/agent-secret)" -d '{"op":"document.info"}'
```

or, from a checkout of this repo, with the bundled CLI — it resolves the same secret file:

```bash
node agent/altery-figma.mjs status
node agent/altery-figma.mjs ops
node agent/altery-figma.mjs call document.info
```

---

## Through an MCP client (no skill, no curl)

The CLI above is deliberately MCP-*shaped* without being MCP. `agent/mcp.mjs` closes that last
gap for clients that already speak the protocol — Claude Desktop, Claude Code, Cursor, Codex:
it is an **MCP stdio server** that fronts the very same bridge, so the client lists tools and
calls them like any other server, with no `SKILL.md` to paste and no `curl`.

```
   MCP client (Claude Desktop, Cursor, …)            plugin (open in Figma)
      │  stdio: initialize, tools/list, tools/call      │
      ▼                                                 │  GET /plugin/poll
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
{ "mcpServers": { "altery-figma": { "command": "node", "args": ["~/Downloads/mcp.mjs"] } } }
```

No secret to configure — it resolves `~/.altery/agent-secret` the same way the CLI does. The
same environment variables apply (`ALTERY_AGENT_URL`, `ALTERY_AGENT_SECRET`,
`ALTERY_AGENT_FILE`).

**The tool surface.** Two tools are always present, so a client that lists tools before the
plugin is open still has a usable surface:

- `altery_status` — which files are connected and what each allows.
- `altery_call` — run any op by name; the universal doorway, including `plugin.call`.

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
altery-figma comments -k https://figma.com/design/<key>/…   # threads, replies grouped
altery-figma versions -k <key or URL>                       # named versions vs autosaves
altery-figma activity --since 2026-08-01                    # Enterprise, org-admin token
```

`$FIGMA_TOKEN`, else `~/.altery/figma-token` — the same resolution order as the bridge secret,
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
curl -s localhost:8788/call -H "x-altery-secret: $(cat ~/.altery/agent-secret)" \
  -d '{"op":"node.get","fileKey":"https://figma.com/design/<key>/…","params":{"nodeId":"4008:55632"}}'
# → { ok: true, source: "rest", fileKey: "…", result: { id, name, type, width, layout, children } }
```

A file key, a file URL, `target: "rest:<key>"`, or `ALTERY_FIGMA_FILE_KEY` for a default. The
token is the same `$FIGMA_TOKEN` / `~/.altery/figma-token` the REST commands above already use.

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
them can be rotated by deleting `~/.altery/agent-secret` and restarting.

**Never bake a secret into the plugin at build time.** One secret shared by every install is
a key to every teammate's machine that can't be rotated without a rebuild.

Pairing is unauthenticated, which is deliberate and bounded three ways: it accepts loopback
connections only, it lasts five minutes from a start someone typed by hand, and the first
successful pair closes it. It is also not a privilege escalation — a local process that could
POST to the window could equally well read `~/.altery/agent-secret`, since both are gated by
the same user account.

Managing the secret yourself is still supported: set `ALTERY_AGENT_SECRET` and the bridge uses
it and opens **no** pairing window (pass `--pair` if you want one anyway). Then type the same
value into Settings → Agent listener → Shared secret.

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALTERY_AGENT_SECRET` | — | manage the secret by hand; suppresses pairing |
| `ALTERY_AGENT_SECRET_FILE` | `~/.altery/agent-secret` | where the minted secret lives |
| `ALTERY_AGENT_PORT` | `8788` | HTTP port |
| `ALTERY_AGENT_HOST` | `127.0.0.1` | loopback on purpose |
| `ALTERY_AGENT_CALL_TIMEOUT_MS` | `180000` | how long one call may take |
| `ALTERY_AGENT_FILES` | `~/.altery/agent-files` | where ops that return files write them |

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
`127.0.0.1` for that reason; `ALTERY_AGENT_HOST` can widen it, but think first.

---

## Ops

```
altery-figma ops              # what the connected plugin is offering, with params
altery-figma ops --json       # the same, machine-readable
```

| Op | Answers |
|----|---------|
| `document.info` | file name, editor type, current page, all pages |
| `guide.list` / `guide.get` | playbooks: named tasks with the ops they take, in order, and what to check when done — the first call on an unfamiliar file |
| `page.frames` | top-level frames, sections and components on a page |
| `node.get` | one node by id — geometry, auto-layout, text, instance bindings, children |
| `node.find` | search by name substring and/or node type, per page or whole document |
| `selection.get` | what the designer has selected right now |
| `components.list` | local components and sets, with property/variant definitions, descriptions and documentation links |
| `component.api` | one component as an API: axes with options and defaults, the variant that isolates each option, what it changes (with the token behind each value), and which layer every boolean/text/swap property drives |
| `styles.list` | local text, paint, effect and grid styles |
| `variables.get` | collections, modes and values, with each token's description, scopes and per-platform `codeSyntax` |
| `flow.map` | prototype graph of a page: starting points and every reaction edge, each carrying the navigation kind and its transition (duration, easing, curve) |
| `node.focus` | selects a node and scrolls the designer to it — "this one, look", and a link when the plugin is Organization-private |
| `node.screenshot` | renders a node to PNG — how an agent checks what it actually drew |
| `image.fills` | the uploaded files behind a subtree's image fills, on a time budget it always answers within |
| `design.context` | reference HTML + CSS + PNG for a node, plus the tokens it binds, the hover/press CSS it computed, and — with `pair` — the other breakpoint's frame merged into `@media` |
| `design.ir` | a screen as a framework-neutral tree: stacks, sizing, paints by token name, text, interactions — plus the table of type styles it is set in and what its system bands, pinned layers and scrolling are, for targets that are not web pages |
| `assets.export` | the pictures a screen references, at the densities and in the formats a platform asks for, with the paths each file belongs at (`ios`, `android`, `web`, `plain`) |
| `design.measure` | Figma's own CSS and boxes for every layer of a section, addressed by path — the assertion behind an implementation, where a screenshot diff can only say "90% similar" |
| `node.states` | what actually changes on hover, press or overlay: property-level deltas between the state variants, not a wall of CSS |
| `frames.compare` | how the 375 frame differs from the 1440 one — matched layers with their deltas, plus what only exists on one side |
| `paints.stack` | every layer of one node's fill sandwich, bottom to top — opacity, blend mode and shader settings included |
| `motion.context` | keyframe tracks with easing (as a name and as a curve), the CSS/GSAP they compile to, and which backend fits — `target: "native"` drops that verdict and its files, which are a browser answer |
| `motion.preview` | a standalone page that actually plays the animation |
| `transition.context` | Smart Animate between variants → CSS transitions, a FLIP toggle or View Transitions; an empty answer says WHICH empty it is (instant links, or states that live in a variant axis instead of the prototype) |
| `library.collections` | variable collections published by libraries enabled in this file |
| `library.variables` | variables inside one library collection — read another file's palette, with `resolve: true` to follow the alias chains a theme collection is made of |
| `lint.colors` | layers painted with a raw colour instead of a variable |
| `sandbox.capabilities` | what this plugin runtime allows |

Five more **change** the document, and `altery-figma ops` marks them with a leading `!`:

| Op | Does |
|----|------|
| `variables.set` | sets variable values or aliases in batch — including an alias onto a *library* variable, which is how one library inherits another's tokens |
| `variables.create` | creates variables in a collection |
| `node.bind` | binds layer properties to variables — turns a lint finding into a fix |
| `board.render` | draws a documentation board: headings, callouts, swatch grids, before/after rows |
| `image.plate` | renders a node with its children hidden — the photo without the badge baked over it. Sits behind the write gate because it clones: the clone is created, hidden, exported and deleted inside the one call, and the document is back to itself when it returns |

Params are a JSON argument, or `-` to read stdin:

```bash
altery-figma call page.frames '{"pageId":"0:1"}'
altery-figma call node.find '{"types":["INSTANCE"],"name":"button","scope":"document"}'
echo '{"nodeId":"12:345","depth":2}' | altery-figma call node.get -
```

Results go to **stdout** as JSON and nothing else does, so `$(altery-figma call …)` and
`… | jq` are always clean. Human text goes to stderr. Exit code is non-zero on any failure.

### Files instead of payloads

`node.screenshot` and `design.context` answer with *paths*, not bytes. The sandbox has no
filesystem and the agent has no way into the sandbox, so an op wraps a file in an envelope and
the bridge — which does have a disk — writes it out and substitutes the path it wrote:

```bash
altery-figma call design.context '{"nodeId":"1:16"}'
# → { node: {…}, layers: 412, tokens: [{token:"colors/neutral/100", uses:23}, …],
#     files: [ {path:"~/.altery/agent-files/design.context-6f2a/board.html", bytes:18422}, … ] }
```

Keeping base64 out of the answer is the point: a whole template and its screenshot cost the
agent three paths of context instead of a megabyte of it. Files land under
`ALTERY_AGENT_FILES` (default `~/.altery/agent-files`), one directory per call, and the oldest
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
inert: the plugin ships no GSAP runtime and `networkAccess: none` stops the page fetching one,
so that preview will open and sit still. "The animation is wrong" and "nothing ran" are
different bugs.

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
request after 300 s with a bare `fetch failed`, whatever `ALTERY_AGENT_CALL_TIMEOUT_MS` says.
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
`Row`. Colours and spacing carry the token that produced them. The tree itself comes back as a
file; `stats`, `tokens`, `components` (each set with the property values it was instantiated
with) and `assets` come back inline, so an agent can decide what is worth opening.

It is deliberately *not* a code generator. No framework is assumed and none is emitted —
which is what makes it usable for a target this plugin has never heard of.

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

---

## The rest of the plugin: `plugin.call`

The ops above are hand-written. The plugin itself is much bigger than them — the colour-token
remap, the token and Django exporters, the palette generator, the lint batch-fix, the
standardised old/new board — and all of it already exists as one `case` in the UI→sandbox
switch in `src/code.ts`. Writing an op per feature would keep the channel permanently one
step behind the panel, so it isn't done that way:

```bash
curl -s "$BASE/call" -H "x-altery-secret: $SECRET" \
  -d '{"op":"plugin.commands"}'                                  # what exists
curl -s "$BASE/call" -H "x-altery-secret: $SECRET" \
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
curl -s "$BASE/call" -H "x-altery-secret: $SECRET" \
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

`params` is both validation and documentation — it is what `altery-figma ops` prints and what
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
| `bridge rejected the secret (401)` | the plugin paired with a different bridge, or you set `ALTERY_AGENT_SECRET` after pairing — re-pair, or align the two |
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
