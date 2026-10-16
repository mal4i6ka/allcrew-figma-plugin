# AllCrew Figma Workspace Receiver

Dependency-free Node.js HTTP server that receives a design-token package from the
AllCrew Figma Workspace plugin and executes the requested delivery action — write to a local folder,
commit to git, open a GitHub PR, open a GitLab merge request, or publish to npm.

The plugin POSTs one JSON object; this script verifies the shared secret, runs the target
using the **host's own credentials**, and returns what happened. Credentials (SSH keys,
`gh` auth, the GitLab token, `~/.npmrc`) stay on the host — they are never sent to or
stored in the plugin.

> **The receiver is the guard.** The plugin's branch checks, path allowlist and dry-run
> button are a convenience for the person clicking. The checks that actually hold — protected
> branches, "never rewrite an existing branch", "never push to the default branch", path
> traversal — are the ones in this file, because they are the ones an attacker, a stale plugin
> build or an automated caller cannot skip.

---

## Quickstart

You do not need this repo. The plugin ships the receiver: **Export Settings → Delivery →
Download receiver.mjs**, then

```bash
node receiver.mjs
# → listening on :8787, secret minted into ~/.allcrew-channel/receiver-secret, pairing open 5 min
```

Press **Pair** in the plugin's Delivery settings and it fills in the endpoint and secret.

Health check — it also reports the pairing window, the targets this build knows and which
optional capabilities are configured:

```bash
curl http://localhost:8787
# {"ok":true,"service":"allcrew-channel-tokens-receiver","pairing":true,
#  "targets":["folder","git","pr","mr","npm"],
#  "capabilities":{"gitlabToken":false,"gitlabApi":"https://gitlab.com/api/v4",
#                  "folderBase":"/srv/tokens","workDir":"/tmp/allcrew-channel-tokens",
#                  "allowDefaultBranchPush":false}}
```

---

## The wire contract

One request shape, one response shape. Anything else is a bug in the caller.

```http
POST <endpoint>
x-allcrew-channel-secret: <secret>
Content-Type: application/json
```

```jsonc
{
  "target": "folder" | "git" | "pr" | "mr" | "npm",
  "dryRun": false,
  "route": {
    "repo": "",        // clone URL (git/pr/mr)
    "branch": "",      // working branch to create/update
    "base": "",        // MR/PR target branch; defaults to the remote HEAD branch
    "path": "",        // subdirectory inside the repo/folder
    "package": "",     // npm only
    "project": "",     // GitLab project path or numeric id (mr only)
    "title": "",       // commit subject and MR/PR title
    "description": ""  // MR/PR body
  },
  "files": {
    "path/to/file.css": "text content",
    "path/to/image.png": { "base64": "…" }
  }
}
```

A file value is either a string (UTF-8 text) or `{ "base64": "…" }` (bytes). Nothing else —
that is what lets binary assets travel through the same plan and the same diff as CSS.

```jsonc
{
  "ok": true,
  "target": "mr",
  "dryRun": true,
  "detail": "human-readable one-liner",
  "plan": {                          // present whenever the receiver could compute one
    "files": [{ "path": "…", "action": "create"|"update"|"unchanged",
                "added": 0, "removed": 0, "binary": false }],
    "diff": "unified diff text, may be truncated",
    "truncated": false
  },
  "url": "https://…/merge_requests/42"   // present after a real mr/pr run
}
```

Failures are non-2xx with `{ "ok": false, "error": "…" }`. `400` means the caller has
something to fix (bad payload, a branch the receiver refuses); `401` a bad secret; `413` a
body over `ALLCREW_CHANNEL_MAX_BODY_MB`; `500` a CLI or API that failed on the host.

Counts and the `binary` flag come from `git diff --numstat` on the real checkout, so they are
the same judgement the commit itself would make. The diff text is capped at 200 KB, with
`truncated: true` when it was cut.

---

## Dry run

`"dryRun": true` on any target. It writes nothing outside `ALLCREW_CHANNEL_WORK_DIR` and never
commits, pushes, publishes or opens a merge request.

For the repo targets the receiver clones/fetches, checks out the branch point, applies the
files into that worktree, reads the diff back out of git, and then `git reset --hard` +
`git clean -fd` puts the worktree back as it was found. The `folder` target has no repository
to diff against, so it borrows one: a throwaway repo in the work dir seeded with whatever is
already on disk at those paths, which keeps one plan implementation rather than two.

Branch refusals (protected, base, default, already exists) are enforced on a dry run too — a
safety check that only shows up at the last moment is the one that surprises people.

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
| `ALLCREW_CHANNEL_FOLDER_BASE` | for `folder` | — | Absolute base dir; `route.path` resolves under it |
| `ALLCREW_CHANNEL_WORK_DIR` | no | `<tmp>/allcrew-channel-tokens` | Clones and staging. The only place a dry run is allowed to write |
| `ALLCREW_CHANNEL_MAX_BODY_MB` | no | `64` | Request body cap — base64 assets make payloads big |
| `ALLCREW_CHANNEL_GITLAB_API` | no | `https://gitlab.com/api/v4` | GitLab REST root; set it for a self-hosted instance |
| `ALLCREW_CHANNEL_GITLAB_TOKEN` | for `mr` | — | GitLab token with `api` scope. Also what lets `git` consult protected-branch rules |
| `ALLCREW_CHANNEL_GIT_AUTHOR_NAME` | no | `AllCrew Tokens` | Commit author name |
| `ALLCREW_CHANNEL_GIT_AUTHOR_EMAIL` | no | `tokens@allcrew.local` | Commit author email |
| `ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH` | no | unset | `1` lets `git` push to `main`/`master`/the remote default branch |

---

## Targets

| Target | What it does | Needs in `route` | Host requirements |
|--------|-------------|------------------|-------------------|
| `folder` | Writes files under `ALLCREW_CHANNEL_FOLDER_BASE/route.path` | `path` | Node (`git` as well for a dry-run plan) |
| `git` | Checks out `branch` (from `base` if new), commits, `push -u origin <branch>`. Refuses `main`/`master`/the remote default branch without `ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1`, and refuses a GitLab-protected branch when `project` + token make that knowable | `repo`, `branch`, `base?`, `path?`, `project?` | `git` + SSH key / credential helper |
| `pr` | Creates `branch` off `base`, pushes, opens a **GitHub** pull request | `repo`, `branch?`, `base?`, `path?` | `git` + `gh` CLI (`gh auth login`) |
| `mr` | Creates `branch` off `base`, pushes, opens a **GitLab** merge request over the REST API (`POST /projects/:id/merge_requests`, `remove_source_branch: true`) and returns its `web_url` | `repo`, `project`, `branch`, `base?`, `path?`, `title?`, `description?` | `git` + `ALLCREW_CHANNEL_GITLAB_TOKEN` |
| `npm` | Writes files, bumps the patch version, runs `npm publish` | `package`, `path?` | `npm login` or `~/.npmrc` token |

`base` defaults to the remote's own HEAD branch (`git symbolic-ref refs/remotes/origin/HEAD`),
never a hardcoded `main` — plenty of repositories are not on `main`, and guessing aims the
merge request at a branch nobody merges into.

### What `mr` refuses, in order

1. missing `route.repo` / `route.project` / `route.branch`, or a branch name that is not
   `^[A-Za-z][A-Za-z0-9._/-]*$` (no `..`, no `@{`, no trailing `/`);
2. missing `ALLCREW_CHANNEL_GITLAB_TOKEN` — the credential belongs on this host, not in the plugin;
3. `branch` equal to `base`, or `main`/`master`;
4. `branch` matched by a GitLab protected-branch rule (`GET /projects/:id/protected_branches`;
   a wildcard rule such as `release/*` counts as a match);
5. `branch` that already exists on the remote — a second run must not silently rewrite
   someone else's work.

All five run **before any file is written**. Each refusal says what to change.

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
Description=AllCrew Figma Workspace receiver
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
          git config user.email "tokens@allcrew.local"
          git add -A && git diff --cached --quiet || git commit -m "chore: rebuild tokens"
          git push
```

---

## Credentials

Every credential below lives on the receiver host. None of them is ever sent to, stored in,
or readable by the plugin — the plugin only ever holds the endpoint and the shared secret.

| Target | How to configure on the host |
|--------|------------------------------|
| `git` / `pr` / `mr` | SSH key in `~/.ssh` for the repo host, or HTTPS via a credential helper |
| `pr` | `gh auth login` (GitHub CLI) |
| `mr` | `ALLCREW_CHANNEL_GITLAB_TOKEN` — a GitLab personal or project access token with `api` scope. Nothing shells out to `gh` for GitLab |
| `npm` | `npm login` or `NPM_TOKEN` in `~/.npmrc`: `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `401 bad or missing secret` | The plugin paired with a different receiver, or `ALLCREW_CHANNEL_SECRET` was set after pairing — re-pair, or align the two |
| `pairing window is closed` | More than five minutes since the receiver started — restart it, or run `node receiver.mjs --pair` |
| `git push` fails | Host git auth not configured for that remote |
| `gh pr create` fails | `gh auth login` not done on the receiver host |
| `GitLab GET … → HTTP 404` | `route.project` is not the full path (`group/subgroup/project`) or numeric id, or the token cannot see it |
| `GitLab GET … → HTTP 401` | `ALLCREW_CHANNEL_GITLAB_TOKEN` expired or lacks `api` scope |
| `refuses to push to "main"` | Deliver to a working branch, or set `ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1` if the receiver really is meant to push there |
| `is protected on GitLab by rule …` | The branch name is covered by a protection rule — pick another |
| `already exists on the remote` | Pick a new branch name; the receiver never force-updates someone else's branch |
| `folder target needs ALLCREW_CHANNEL_FOLDER_BASE` | Env var not set |
| No changes committed | Tokens already up-to-date — not an error |

---

## Tests

```bash
node --test server/receiver.test.mjs
```

Runs the server in-process against a throwaway bare repository and a stub GitLab REST root in
a temp dir: secret gate, text and base64 writes, path traversal, the dry-run plan, every `mr`
refusal, and the real push + merge-request call. The dry-run tests hash the whole temp tree
except the work dir and assert it is byte-identical afterwards.
