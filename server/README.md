# AllCrew Channel Receiver

Dependency-free Node.js HTTP server that receives a design-token package from the
AllCrew Channel plugin and executes the requested delivery action — commit to git, open
a PR, publish to npm, or write to a local folder.

The plugin POSTs `{ files, target, route, options, meta }`; this script verifies the
shared secret, runs the target using the **host's own credentials**, and returns
`{ ok, detail }`. Credentials (SSH keys, `gh` auth, `~/.npmrc`) stay on the host —
they are never sent to or stored in the plugin.

---

## Quickstart

You do not need this repo. The plugin ships the receiver: **Export Settings → Delivery →
Download receiver.mjs**, then

```bash
node receiver.mjs
# → listening on :8787, secret minted into ~/.allcrew-channel/receiver-secret, pairing open 5 min
```

Press **Pair** in the plugin's Delivery settings and it fills in the endpoint and secret.

Health check (also reports whether the pairing window is open):

```bash
curl http://localhost:8787
# {"ok":true,"service":"allcrew-channel-tokens-receiver","pairing":true}
```

---

## Secrets

Each host mints its own on first run — 0600 under a 0700 `~/.allcrew-channel/`. Nothing is baked
into the plugin build and nothing is distributed, so ten designers end up with ten
different secrets. Rotate one by deleting the file and restarting.

Pairing (`POST …/pair`, matched by suffix so a path or proxy prefix still works) is
unauthenticated, bounded three ways: loopback only, five minutes from a hand-typed start,
and closed by the first success. It grants nothing a local process could not get by reading
the secret file directly.

**Remote or shared hosts:** set `ALLCREW_CHANNEL_SECRET` yourself. The receiver uses it and opens no
pairing window at all — pass `--pair` if you want one — and you type the same value into the
plugin's Shared secret field. Never ship one secret to everyone: it cannot be rotated
without a rebuild, and it is a key to every host running it.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALLCREW_CHANNEL_SECRET` | no | minted | Set it to manage the secret by hand; suppresses pairing |
| `ALLCREW_CHANNEL_SECRET_FILE` | no | `~/.allcrew-channel/receiver-secret` | Where a minted secret is stored |
| `PORT` | no | `8787` | HTTP port |
| `ALLCREW_CHANNEL_FOLDER_BASE` | for `folder` target | — | Absolute base dir; `route.path` resolves under it |
| `ALLCREW_CHANNEL_WORK_DIR` | no | `<tmp>/allcrew-channel-tokens` | Scratch dir for git clones |

---

## Targets

| Target | What it does | Host requirements |
|--------|-------------|-------------------|
| `folder` | Writes files under `ALLCREW_CHANNEL_FOLDER_BASE/route.path` | Node only |
| `git` | Clones repo, commits, pushes to `route.branch` | `git` + SSH key / credential helper |
| `pr` | Same as `git` but pushes a new branch and opens a PR | `git` + `gh` CLI (`gh auth login`) |
| `npm` | Writes files, bumps patch version, runs `npm publish` | `npm login` or `~/.npmrc` token |

---

## Deployment options

### Developer machine (Tailscale)

```bash
ALLCREW_CHANNEL_SECRET=your-secret \
ALLCREW_CHANNEL_FOLDER_BASE=/path/to/tokens \
node receiver.mjs
```

(Remote host, so the secret is set by hand — pairing is loopback-only and would be
unreachable from the designer's machine anyway.)

Plugin endpoint: `http://<tailscale-hostname>:8787`

---

### pm2 (long-running, survives restarts)

```bash
npm install -g pm2

# .cjs, so the CommonJS config loads whether or not the deploy dir is "type": "module"
cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "allcrew-channel-receiver",
    script: "receiver.mjs",
    env: {
      ALLCREW_CHANNEL_SECRET: "your-secret-here",
      ALLCREW_CHANNEL_FOLDER_BASE: "/srv/tokens",
      PORT: "8787"
    }
  }]
}
EOF

pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

---

### systemd

```ini
# /etc/systemd/system/allcrew-channel-receiver.service
[Unit]
Description=AllCrew Channel receiver
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/allcrew-channel/receiver.mjs
Restart=on-failure
Environment=PORT=8787
Environment=ALLCREW_CHANNEL_SECRET=your-secret-here
Environment=ALLCREW_CHANNEL_FOLDER_BASE=/srv/tokens
WorkingDirectory=/opt/allcrew-channel

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now allcrew-channel-receiver
```

---

### Docker

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache git github-cli npm
WORKDIR /app
COPY receiver.mjs ./
EXPOSE 8787
CMD ["node", "receiver.mjs"]
```

```bash
docker build -t allcrew-channel-receiver .
docker run -d \
  -p 8787:8787 \
  -e ALLCREW_CHANNEL_SECRET=your-secret \
  -e ALLCREW_CHANNEL_FOLDER_BASE=/tokens \
  -v /host/tokens:/tokens \
  allcrew-channel-receiver
```

---

### GitHub Actions (downstream pipeline)

The receiver commits tokens directly into a branch; Actions picks up on push:

```
Designer triggers delivery in Figma
  → receiver commits to `tokens` branch
    → Actions runs on push → rebuilds, opens PR into main, etc.
```

```yaml
# .github/workflows/sync-tokens.yml
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
      - run: npx style-dictionary build
      - run: |
          git config user.name "tokens-bot"
          git config user.email "tokens@allcrew-channel.local"
          git add -A && git diff --cached --quiet || git commit -m "chore: rebuild tokens"
          git push
```

---

## Credentials

| Target | How to configure on the host |
|--------|------------------------------|
| `git` / `pr` | SSH key in `~/.ssh` for the repo host, or HTTPS via `gh auth setup-git` |
| `pr` | `gh auth login` |
| `npm` | `npm login` or `NPM_TOKEN` in `~/.npmrc`: `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `401 bad or missing secret` | The plugin paired with a different receiver, or `ALLCREW_CHANNEL_SECRET` was set after pairing — re-pair, or align the two |
| `pairing window is closed` | More than five minutes since the receiver started — restart it, or run `node receiver.mjs --pair` |
| `git push` fails | Host git auth not configured for that remote |
| `gh pr create` fails | `gh auth login` not done on the receiver host |
| `folder target needs ALLCREW_CHANNEL_FOLDER_BASE` | Env var not set |
| No changes committed | Tokens already up-to-date — not an error |
