# Agent listener

Lets a CLI agent — Claude Code, Codex, a shell script, `curl` — ask questions about the Figma
file the designer currently has open, through the Altery plugin's own Plugin API access.

It is MCP-shaped without being MCP: there is no server to register, no client library, and
nothing to keep in sync but the op names. If a tool can run a shell command, it can drive
Figma.

**Read-only today.** Every shipped op only looks. The write gate exists and is enforced, but
no mutating op is registered yet.

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

**1. Run the bridge** (loopback only, no dependencies, no arguments):

```bash
node agent/bridge.mjs
```

First run mints a secret into `~/.altery/agent-secret` (0600) and opens a five-minute pairing
window.

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

or with the bundled CLI, which resolves the same secret file:

```bash
node agent/altery-figma.mjs status
node agent/altery-figma.mjs ops
node agent/altery-figma.mjs call document.info
```

---

## Secrets across machines

Nothing is baked into the build and nothing is shared. Each machine's bridge mints its own
secret on first run; each designer's plugin pairs with the bridge on their own machine. Ten
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

---

## The switches

Both gates are **off every time the plugin opens**, whatever was set last session. The bridge
URL and secret persist (that's setup); the permission does not (that's consent).

- **Allow reads** — the agent may inspect the file. On its own it is a real disclosure, which
  is why it is a switch rather than an always-on default.
- **Allow changes** — never implied by reads. Turning reads off also forces writes off: the
  more dangerous half of the channel can't outlive the safer one.

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

Params are a JSON argument, or `-` to read stdin:

```bash
altery-figma call page.frames '{"pageId":"0:1"}'
altery-figma call node.find '{"types":["INSTANCE"],"name":"button","scope":"document"}'
echo '{"nodeId":"12:345","depth":2}' | altery-figma call node.get -
```

Results go to **stdout** as JSON and nothing else does, so `$(altery-figma call …)` and
`… | jq` are always clean. Human text goes to stderr. Exit code is non-zero on any failure.

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
| Works on desktop, not in the browser | browser Figma may block loopback (Private Network Access). Use the desktop app, or put the bridge behind HTTPS. |

The bridge logs every call with its op and duration; the plugin's status line shows the same
thing to the designer.
