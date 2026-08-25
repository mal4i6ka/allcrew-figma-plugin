# Altery Token Receiver

Dependency-free Node.js HTTP server that receives a design-token package from the
Altery Figma plugin and executes the requested delivery action — commit to git, open
a PR, publish to npm, or write to a local folder.

The plugin POSTs `{ files, target, route, options, meta }`; this script verifies the
shared secret, runs the target using the **host's own credentials**, and returns
`{ ok, detail }`. Credentials (SSH keys, `gh` auth, `~/.npmrc`) stay on the host —
they are never sent to or stored in the plugin.

---

## Quickstart

```bash
ALTERY_SECRET=your-shared-secret node receiver.mjs
# → listening on :8787
```

Health check:

```bash
curl http://localhost:8787
# {"ok":true,"service":"altery-tokens-receiver"}
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALTERY_SECRET` | **yes** | — | Must match the "Shared secret" field in the plugin |
| `PORT` | no | `8787` | HTTP port |
| `ALTERY_FOLDER_BASE` | for `folder` target | — | Absolute base dir; `route.path` resolves under it |
| `ALTERY_WORK_DIR` | no | `<tmp>/altery-tokens` | Scratch dir for git clones |

---

## Targets

| Target | What it does | Host requirements |
|--------|-------------|-------------------|
| `folder` | Writes files under `ALTERY_FOLDER_BASE/route.path` | Node only |
| `git` | Clones repo, commits, pushes to `route.branch` | `git` + SSH key / credential helper |
| `pr` | Same as `git` but pushes a new branch and opens a PR | `git` + `gh` CLI (`gh auth login`) |
| `npm` | Writes files, bumps patch version, runs `npm publish` | `npm login` or `~/.npmrc` token |

---

## Deployment options

### Developer machine (Tailscale)

```bash
ALTERY_SECRET=your-secret \
ALTERY_FOLDER_BASE=/path/to/tokens \
node receiver.mjs
```

Plugin endpoint: `http://<tailscale-hostname>:8787`

---

### pm2 (long-running, survives restarts)

```bash
npm install -g pm2

cat > ecosystem.config.js <<'EOF'
module.exports = {
  apps: [{
    name: "altery-receiver",
    script: "receiver.mjs",
    env: {
      ALTERY_SECRET: "your-secret-here",
      ALTERY_FOLDER_BASE: "/srv/tokens",
      PORT: "8787"
    }
  }]
}
EOF

pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

### systemd

```ini
# /etc/systemd/system/altery-receiver.service
[Unit]
Description=Altery token receiver
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/altery/receiver.mjs
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
docker build -t altery-receiver .
docker run -d \
  -p 8787:8787 \
  -e ALTERY_SECRET=your-secret \
  -e ALTERY_FOLDER_BASE=/tokens \
  -v /host/tokens:/tokens \
  altery-receiver
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
          git config user.email "tokens@altery.local"
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
| `401 bad or missing secret` | Secret in the plugin doesn't match `ALTERY_SECRET` |
| `git push` fails | Host git auth not configured for that remote |
| `gh pr create` fails | `gh auth login` not done on the receiver host |
| `folder target needs ALTERY_FOLDER_BASE` | Env var not set |
| No changes committed | Tokens already up-to-date — not an error |
