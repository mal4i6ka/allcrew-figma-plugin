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
| `page.frames` | top-level frames, sections and components on a page |
| `node.get` | one node by id — geometry, auto-layout, text, instance bindings, children |
| `node.find` | search by name substring and/or node type, per page or whole document |
| `selection.get` | what the designer has selected right now |
| `components.list` | local components and sets, with property/variant definitions |
| `styles.list` | local text, paint, effect and grid styles |
| `variables.get` | collections, modes and values — the token export's own snapshot |
| `flow.map` | prototype graph of a page: starting points and every reaction edge |
| `node.focus` | selects a node and scrolls the designer to it — "this one, look", and a link when the plugin is Organization-private |
| `node.screenshot` | renders a node to PNG — how an agent checks what it actually drew |
| `design.context` | reference HTML + CSS + PNG for a node, plus the tokens it binds |
| `motion.context` | keyframe tracks with easing, the CSS/GSAP they compile to, and which backend fits |
| `motion.preview` | a standalone page that actually plays the animation |
| `transition.context` | Smart Animate between variants → CSS transitions, a FLIP toggle or View Transitions |
| `library.collections` | variable collections published by libraries enabled in this file |
| `library.variables` | variables inside one library collection — read another file's palette |
| `lint.colors` | layers painted with a raw colour instead of a variable |
| `sandbox.capabilities` | what this plugin runtime allows |

Four more **change** the document, and `altery-figma ops` marks them with a leading `!`:

| Op | Does |
|----|------|
| `variables.set` | sets variable values or aliases in batch — including an alias onto a *library* variable, which is how one library inherits another's tokens |
| `variables.create` | creates variables in a collection |
| `node.bind` | binds layer properties to variables — turns a lint finding into a fix |
| `board.render` | draws a documentation board: headings, callouts, swatch grids, before/after rows |

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

### What that buys an agent

`components.list` + `page.frames` + `flow.map` is the discovery half of "assemble a flow from
components". An agent can name the button variant it wants, name the frame it belongs on, and
read back how the prototype already wires the screens together — before anything is allowed to
touch the document.

---

## Adding an op

Register it in `src/agent/ops.ts`:

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
