# Altery Design System Export

A self-contained Figma plugin that exports the current file's **local variables**
as a design-token package — mode-aware CSS, JSON and TypeScript — ready to drop
into a frontend.

It reads variables **in-editor via the Figma Plugin API**, so it works on **any
Figma plan** (no Enterprise Variables REST access, no server, no network).

---

## Install (development plugin)

1. In Figma desktop: **Menu → Plugins → Development → Import plugin from manifest…**
2. Pick `manifest.json` from this folder.
3. The plugin now shows under **Plugins → Development → Altery Design System Export**.

No build step — `code.js` and `ui.html` are ready to run as-is.

## Use

1. Open the Figma file that holds your design-system variables & collections.
2. Run the plugin. It scans automatically and shows a summary:
   collections, modes (themes) and variable counts.
3. Click **⚙Settings** (top-right) to open the settings page and tune the
   output (see below). Choices persist per-user via `figma.clientStorage` and
   re-apply on every run.
4. **Download package (.zip)** — or grab any single file. **Rescan** after you
   edit variables.

## What you get

| File | Contents |
|------|----------|
| `tokens.css` | CSS custom properties. **One self-contained block per theme.** The merged single file. |
| `<theme>.module.css` | The same blocks split **one CSS Module per theme** (`light.module.css`, `dark.module.css`, …), wrapped in `:global(…)`. Merged by your bundler (which strips `:global`), they're equivalent to `tokens.css`. |
| `tokens.json` | Canonical W3C token tree — every mode under `$extensions.modes`, source collection under `$extensions.figma`. For diffing / re-import. |
| `tokens.ts` | Typed `tokens` object (values are `var(--…)` refs) + a `themes` list and `Theme` type. |
| `README.md` | Auto-generated usage notes for that specific export. |

##Settings

The **Export Settings** page (open it from the gear in the header) isolates the
opinionated parts of the output so different consumers can keep their own
preferences (the choices persist per-user):

| Setting | Default | What it does |
|---------|---------|--------------|
| **Inline primitives** | on | Resolves aliases that point at a *primitive* (raw, single-mode value) into the literal, and drops the primitive layer. Aliases **between semantic tokens** stay as `var(--…)`. |
| **Flatten all aliases** | off | With Inline primitives on, also resolves the *semantic→semantic* `var(--…)` refs into literals, so **no** references remain in the output. Off keeps the readable, themeable semantic layer. |
| **Theme attribute** | `data-theme-name` | The attribute the theme blocks key off (`[<attr>="Dark"]`). Set it to `data-theme` to match the Altery board, or anything else. |
| **Per-theme `.module.css`** | on | Whether to emit the per-theme module files alongside `tokens.css`. |
| **CSS Modules `:global()`** | on | Wrap module-file selectors in `:global(…)` (valid CSS Modules) or leave them plain. |

### tokens.css shape

Every **mode** becomes one self-contained block declaring **all** variables for
that theme. The default theme also occupies `:root`, so an un-themed page still
renders.

With **Inline primitives** on (the default), the raw scale is collapsed into the
tokens that use it — no primitive variables in the output:

```css
:root,
[data-theme-name="Light"] {
  /* Tokens */
  --colors-action-default: #002780;
  --spacing-md: 8px;
}

/* add a "Dark" mode to the collection in Figma → a second full block appears */
[data-theme-name="Dark"] {
  /* …all variables again, dark values… */
}
```

Turn it **off** to keep the primitive layer and reference it via aliases instead
(byte-identical to the Altery board, modulo the attribute name):

```css
:root,
[data-theme-name="Light"] {
  /* Primitives */
  --colors-b-800: #002780;
  --sizes-1: 8px;
  /* Tokens */
  --colors-action-default: var(--colors-b-800);
  --spacing-md: var(--sizes-1);
}
```

> A primitive used **directly in code** (not via an alias) can't be detected by the
> plugin — it will be inlined away. Turn Inline primitives off if you rely on the
> raw scale at call sites.

Switch theme by setting the attribute on any ancestor:

```html
<html data-theme-name="Dark">
```

### Per-theme `<theme>.module.css`

The same theme blocks are also emitted one file per theme, named after the mode
(`light.module.css`, `dark.module.css`, … — slugified), wrapped in `:global(…)`
so they're valid in a CSS-Modules project (Next.js, etc.):

```css
/* light.module.css */
:global(:root),
:global([data-theme-name="Light"]) {
  --colors-action-default: var(--colors-b-800);
  --spacing-md: var(--sizes-1);
}
```

The default theme also lands on `:global(:root)`. Concatenating every
`*.module.css` (or letting your bundler merge the ones you import) reproduces
`tokens.css` — that's the "merged single file". For **runtime** theme-switching,
keep every theme present (use `tokens.css`, or import all `*.module.css`) and
toggle `data-theme-name`.

## Automated delivery

Reading variable **values** over REST is Enterprise-only, so on Organization the
plugin itself is the extractor — but everything around it is automated. The designer
publishing the library is the trigger; the plugin ships the package; a small receiver
does the git/npm/folder work.

**Plugin side** (Export Settings → *Delivery*):

- **Receiver endpoint** — where to POST (configurable; nothing is pinned to one host).
- **Shared secret** — sent as `x-altery-secret`; must match the receiver. *(This is the
  only secret in the plugin — git/npm credentials never leave the receiver.)*
- **Target** — `folder` / `git` (commit + push) / `pr` (branch + `gh pr`) / `npm` (publish),
  plus the non-secret route (repo / branch / path / package).
- **Triggers** — *Deliver now* (manual), *Auto-deliver on change* (re-scan every ~7s while
  the plugin is open and push on real change), *Deliver on open*.

**Receiver side** (`server/receiver.mjs`) — a dependency-free Node script you run on any
host; it executes the target using the host's own git / `gh` / `npm` auth:

```bash
ALTERY_SECRET=your-shared-secret \
ALTERY_FOLDER_BASE=/abs/path/for/folder/target \
node server/receiver.mjs          # listens on :8787 (override with PORT)
```

The plugin only ever HTTP-POSTs, so the receiver is portable: point the plugin's endpoint
at wherever it runs (localhost, a Tailscale host, CI). The contract is one POST of
`{ files, target, route, options, meta }`; the receiver verifies the secret, runs the
target, and returns `{ ok, detail }`.

> Fully hands-off (no designer either) would need the **Variables REST API** = Enterprise.
> The transform is already shareable, so that upgrade is a small step if you ever take it.

## Deployment & Integration

### Prerequisites

The receiver uses only Node.js built-ins — no `npm install`. The host needs:

| Target | Required on the host |
|--------|----------------------|
| `folder` | Node.js only |
| `git` | `git` + SSH key / credential helper for the repo |
| `pr` | `git` + `gh` CLI authenticated (`gh auth login`) |
| `npm` | `node` + `npm login` (or `~/.npmrc` with token) |

---

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALTERY_SECRET` | **yes** | — | Shared secret; must match the plugin's "Shared secret" field |
| `PORT` | no | `8787` | HTTP port |
| `ALTERY_FOLDER_BASE` | for `folder` | — | Absolute base dir; `route.path` resolves under it |
| `ALTERY_WORK_DIR` | no | `<tmp>/altery-tokens` | Scratch dir for git clones |

---

### Option 1: developer machine (Tailscale)

The simplest setup — run the receiver locally, expose it to other Figma sessions via Tailscale:

```bash
# .env (keep out of git)
ALTERY_SECRET=some-random-string
ALTERY_FOLDER_BASE=/Users/you/projects/design-tokens/src

# run
ALTERY_SECRET=some-random-string \
ALTERY_FOLDER_BASE=/Users/you/projects/design-tokens/src \
node server/receiver.mjs
```

Plugin endpoint: `http://<tailscale-hostname>:8787`

---

### Option 2: long-running server with pm2

```bash
npm install -g pm2

# create ecosystem file — .cjs, since this repo is "type": "module"
# (do NOT commit — contains the secret)
cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "altery-receiver",
    script: "server/receiver.mjs",
    env: {
      ALTERY_SECRET: "your-secret-here",
      ALTERY_FOLDER_BASE: "/srv/tokens",
      PORT: "8787"
    }
  }]
}
EOF

pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # survive reboots
```

---

### Option 3: systemd service

```ini
# /etc/systemd/system/altery-receiver.service
[Unit]
Description=Altery token receiver
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/altery/server/receiver.mjs
Restart=on-failure
Environment=PORT=8787
Environment=ALTERY_SECRET=your-secret-here
Environment=ALTERY_FOLDER_BASE=/srv/tokens
WorkingDirectory=/opt/altery

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now altery-receiver
```

---

### Option 4: Docker

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache git github-cli npm
WORKDIR /app
COPY server/receiver.mjs ./
EXPOSE 8787
CMD ["node", "receiver.mjs"]
```

```bash
docker build -t altery-receiver .
docker run -d \
  -p 8787:8787 \
  -e ALTERY_SECRET=your-secret \
  -e ALTERY_FOLDER_BASE=/tokens \
  -v /host/tokens:/tokens \
  altery-receiver
```

---

### Option 5: GitHub Actions (webhook-style)

The receiver itself is a push-side HTTP server, not a pull-side CI job. But you can use the `git` or `pr` target and let the receiver commit into the repo — Actions will then pick it up on push.

```
Designer triggers delivery in Figma
  → receiver commits tokens to `tokens` branch
    → Actions workflow runs on push to that branch
      → (optional) opens PR into main, runs style-dictionary, etc.)
```

Example Actions workflow for the downstream step:

```yaml
name: Sync design tokens
on:
  push:
    branches: [tokens]
    paths: ["tokens/**"]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx style-dictionary build   # or whatever your pipeline is
      - run: |
          git config user.name "tokens-bot"
          git config user.email "tokens@altery.local"
          git add -A && git diff --cached --quiet || git commit -m "chore: rebuild tokens"
          git push
```

---

### Credentials

The receiver inherits credentials from the host environment — never from the plugin or the POST body.

| Target | How to auth |
|--------|------------|
| `git` / `pr` | SSH key in `~/.ssh` configured for the repo host (GitHub, GitLab, etc.) — or HTTPS with a credential helper (`gh auth setup-git`) |
| `pr` | `gh auth login` — `gh` CLI must be authenticated |
| `npm` | `npm login` or `NPM_TOKEN` in `~/.npmrc`: `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` |

---

### Health check

```bash
curl http://localhost:8787
# {"ok":true,"service":"altery-tokens-receiver"}
```

---

### Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `401 bad or missing secret` | Secret in plugin doesn't match `ALTERY_SECRET` |
| `git push` fails | Host's git auth not set up for that remote |
| `gh pr create` fails | `gh auth login` not done on the receiver host |
| `folder target needs ALTERY_FOLDER_BASE` | Env var not set |
| No changes committed | Tokens were already up-to-date (not an error) |

## Notes

- **Themes = the modes of your semantic (alias-bearing) collection.** A raw
  primitives collection with a single placeholder mode (e.g. `Mode 1`) is *not*
  treated as a theme; its values fold into every theme block.
- **Offline / private:** `manifest.json` declares no network access. Fonts
  (Museo Sans, Geist Mono) are embedded in `ui.html`.
- **Editors & plan:** runs in both **Figma Design** and **Dev Mode**
  (`editorType: ["figma", "dev"]`, `capabilities: ["inspect"]`). It reads variables
  through the in-editor Plugin API, so **no Enterprise / Variables REST API is
  required — it works on any plan**, including Organization. Dev Mode itself is gated
  by Figma to a **Dev or Full seat** (no manifest setting bypasses that); anyone with
  a normal editor seat can still run it in **Design mode** with no extra cost.
- **Selector:** defaults to `[data-theme-name="…"]` (per spec) but is configurable
  in **Export settings** — set it to `data-theme` to match the Altery board.
- **`tokens.json` is always the full, un-inlined tree** regardless of the Inline
  primitives setting, so it stays lossless for diffing / re-import.

## Maintenance

The transform in `code.js` is a dependency-free port of the Altery board's
`src/lib/figma.ts` (`variablesToW3CMultiMode`) + `src/lib/design-system/tokens-transform.ts`.
With **Inline primitives off** and the **theme attribute** set to `data-theme`, the
output is byte-identical to the board. The export options layer on top of that core
transform; keep the core in sync with the board if the token format changes.

Files:

```
manifest.json   plugin manifest (Figma)
code.js         sandbox: reads variables → builds the token package
ui.html         the panel UI (styles, fonts, preview, zip download — all inlined)
```
