#!/usr/bin/env node
/*
 * AllCrew Figma Workspace receiver — the "dumb executor" half of the delivery pipeline.
 * The Figma plugin (Delivery settings) POSTs the generated package here; this script
 * runs the actual folder / git / PR / MR / npm action. It is intentionally portable:
 * no dependencies, just Node built-ins + the host's own git/gh/npm CLIs.
 *
 * Run it on any host (your machine now, someone else's later — the plugin's endpoint
 * is configurable, so nothing is pinned to one person):
 *
 *     node receiver.mjs
 *
 * ─── The wire contract (one shape, no variants) ────────────────────────────────────────
 *
 *   POST <endpoint>   x-allcrew-channel-secret: <secret>   Content-Type: application/json
 *
 *     { "target": "folder" | "git" | "pr" | "mr" | "npm",
 *       "dryRun": false,
 *       "route": { "repo": "", "branch": "", "base": "", "path": "",
 *                  "package": "", "project": "", "title": "", "description": "" },
 *       "files": { "src/tokens.css": "text content",
 *                  "static/img/logo.png": { "base64": "…" } } }
 *
 *   A file value is either a string (UTF-8 text) or { "base64": "…" } (bytes). Nothing else.
 *
 *     → 200 { "ok": true, "target": "mr", "dryRun": true, "detail": "…",
 *             "plan": { "files": [{ "path", "action", "added", "removed", "binary" }],
 *                       "diff": "unified diff text", "truncated": false },
 *             "url": "https://…/merge_requests/42" }
 *
 *   `plan` is present whenever the receiver could compute one, `url` after a real mr/pr run.
 *   Failures are non-2xx with { "ok": false, "error": "…" }.
 *
 * `dryRun: true` writes nothing outside ALLCREW_CHANNEL_WORK_DIR and never commits, pushes, publishes
 * or opens a merge request. The receiver — not the plugin — is the guard: the plugin's checks
 * are a convenience for the person clicking, these are the ones that actually hold.
 *
 * Nobody types a secret for the common case. On a host with none configured this mints one
 * into ~/.allcrew-channel/receiver-secret (0600) and opens a five-minute pairing window; the plugin's
 * "Pair" button in Delivery settings collects it. Every machine therefore has a different
 * secret and none of them was ever distributed. For a shared or remote host, set
 * ALLCREW_CHANNEL_SECRET yourself — that suppresses pairing entirely (loopback-only in any case).
 *
 * Environment:
 *   ALLCREW_CHANNEL_SECRET        manage the secret by hand; suppresses pairing (--pair forces a window)
 *   ALLCREW_CHANNEL_SECRET_FILE   where a minted secret lives (default ~/.allcrew-channel/receiver-secret)
 *   PORT                 (default 8787)
 *   ALLCREW_CHANNEL_FOLDER_BASE   base dir for the "folder" target; route.path is resolved under it.
 *   ALLCREW_CHANNEL_WORK_DIR      scratch dir for clones and staging (default <tmp>/allcrew-channel-tokens).
 *   ALLCREW_CHANNEL_MAX_BODY_MB   request body cap (default 64 — base64 assets make payloads big).
 *   ALLCREW_CHANNEL_GITLAB_API    GitLab REST root for the "mr" target (default https://gitlab.com/api/v4)
 *   ALLCREW_CHANNEL_GITLAB_TOKEN  GitLab token with `api` scope — required by "mr", and what lets "git"
 *                        consult the project's protected-branch rules before pushing.
 *   ALLCREW_CHANNEL_GIT_AUTHOR_NAME / ALLCREW_CHANNEL_GIT_AUTHOR_EMAIL   commit identity (default AllCrew Tokens)
 *   ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1  let "git" push to main/master/the remote default branch
 *
 * Credentials stay HERE, never in the plugin:
 *   git/pr/mr → the host's git auth (SSH key or credential helper)
 *   pr        → the `gh` CLI (GitHub)
 *   mr        → ALLCREW_CHANNEL_GITLAB_TOKEN (GitLab REST)
 *   npm       → the host's `npm login` (~/.npmrc)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = parseInt(process.env.PORT || "8787", 10);
const SECRET_FILE =
  process.env.ALLCREW_CHANNEL_SECRET_FILE || path.join(os.homedir(), ".allcrew-channel", "receiver-secret");

/* Policy and location knobs are read where they are used, not captured at import. It keeps the
 * defaults in one place next to the thing that needs them, and a harness can drive the server
 * without re-importing the module. */
const env = (key, fallback = "") => process.env[key] || fallback;
const folderBase = () => env("ALLCREW_CHANNEL_FOLDER_BASE");
const workDir = () => env("ALLCREW_CHANNEL_WORK_DIR", path.join(os.tmpdir(), "allcrew-channel-tokens"));
const maxBodyBytes = () => (parseInt(env("ALLCREW_CHANNEL_MAX_BODY_MB", "64"), 10) || 64) * 1024 * 1024;
const gitlabApi = () => env("ALLCREW_CHANNEL_GITLAB_API", "https://gitlab.com/api/v4").replace(/\/+$/, "");
const gitlabToken = () => env("ALLCREW_CHANNEL_GITLAB_TOKEN");
const authorName = () => env("ALLCREW_CHANNEL_GIT_AUTHOR_NAME", "AllCrew Tokens");
const authorEmail = () => env("ALLCREW_CHANNEL_GIT_AUTHOR_EMAIL", "tokens@allcrew.local");
const allowDefaultBranchPush = () => env("ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH") === "1";

const DEFAULT_TITLE = "chore(tokens): sync design tokens from Figma";
const DEFAULT_DESCRIPTION = "Automated delivery from the AllCrew Figma Workspace plugin.";
const DIFF_CAP = 200 * 1024;

/** env → file → mint. Minting writes 0600 under a 0700 directory: the secret ends up exactly
 * as private as the account running the receiver, which is the whole trust boundary. */
function resolveSecret() {
  if (process.env.ALLCREW_CHANNEL_SECRET) return { secret: process.env.ALLCREW_CHANNEL_SECRET, source: "env" };
  try {
    const stored = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (stored) return { secret: stored, source: "file" };
  } catch {
    /* not written yet — mint below */
  }
  const secret = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRET_FILE, secret + "\n", { mode: 0o600 });
  return { secret, source: "minted" };
}

const { secret: SECRET, source: SECRET_SOURCE } = resolveSecret();

/** Pairing hands the secret to a plugin that asks, unauthenticated — bounded three ways:
 * loopback only, five minutes from a start someone typed by hand, and closed by the first
 * success. It grants nothing a local process could not get by reading SECRET_FILE itself. */
const PAIR_WINDOW_MS = 5 * 60 * 1000;
let pairOpenUntil =
  SECRET_SOURCE !== "env" || process.argv.includes("--pair") ? Date.now() + PAIR_WINDOW_MS : 0;
const pairingOpen = () => Date.now() < pairOpenUntil;

function isLoopback(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** A refusal the caller can act on: wrong input or a branch the receiver will not touch. Kept
 * apart from a CLI blowing up, which is a 500 and needs the operator, not the designer. */
class Refusal extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const refuse = (message) => new Refusal(message);

/** Run a CLI, returning stdout. On failure, throw an Error carrying the last lines of stderr. */
function run(cmd, cwd, args) {
  const r = tryRun(cmd, cwd, args);
  if (r.status !== 0) {
    throw new Error(cmd + " " + args.join(" ") + " → " + r.err.split("\n").slice(-3).join(" ").trim());
  }
  return r.out;
}

/** Same, but hands back the exit status instead of throwing — some git commands answer a
 * question with their exit code (`ls-remote --exit-code`: 2 means "no such branch", anything
 * else means we never got an answer and must not pretend we did). */
function tryRun(cmd, cwd, args) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, out: out.toString().trim(), err: "" };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: ((e.stdout && e.stdout.toString()) || "").trim(),
      err: ((e.stderr && e.stderr.toString()) || e.message || "").trim(),
    };
  }
}
const git = (cwd, args) => run("git", cwd, args);
const gitCommit = (cwd, message, allowEmpty) =>
  git(cwd, ["-c", "user.name=" + authorName(), "-c", "user.email=" + authorEmail(),
    "commit", "--quiet", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message]);

/** Normalize to a relative path with no leading slash and no `..` traversal. */
function sanitizeRel(p) {
  const norm = path.posix
    .normalize(String(p || "").replace(/\\/g, "/"))
    .replace(/^\/+/, "");
  if (norm === ".." || norm.split("/").indexOf("..") !== -1) throw refuse("invalid path (traversal): " + p);
  return norm === "." ? "" : norm;
}
const joinRel = (a, b) => [a, b].filter(Boolean).join("/");

/** A file is UTF-8 text or base64 bytes — the two things a design-token package contains.
 * Checked before anything is written so a malformed payload cannot land half a delivery. */
function assertFileValue(name, value) {
  if (typeof value === "string") return;
  if (value && typeof value === "object" && typeof value.base64 === "string") return;
  throw refuse('file "' + name + '" must be a string (UTF-8 text) or { "base64": "…" } (bytes)');
}

function fileBytes(value) {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value.base64, "base64");
}

function writeFiles(destDir, files) {
  const written = [];
  for (const name of Object.keys(files)) {
    const full = path.join(destDir, sanitizeRel(name));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, fileBytes(files[name]));
    written.push(path.relative(destDir, full));
  }
  return written;
}

function ensureRepo(repo) {
  const base = workDir();
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, "repo-" + crypto.createHash("sha1").update(repo).digest("hex").slice(0, 12));
  if (!fs.existsSync(path.join(dir, ".git"))) git(base, ["clone", "--quiet", repo, dir]);
  else git(dir, ["fetch", "--quiet", "--all", "--prune"]);
  return dir;
}

/** The branch a merge request targets by default is whatever the remote says its default is —
 * plenty of repositories are not on `main`, and guessing would aim the MR at a branch nobody
 * merges into. A fresh clone usually knows already; `set-head --auto` asks the remote. */
function remoteHead(dir) {
  const read = () => tryRun("git", dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let r = read();
  if (r.status !== 0) {
    tryRun("git", dir, ["remote", "set-head", "origin", "--auto"]);
    r = read();
  }
  const name = r.status === 0 ? r.out.replace(/^origin\//, "") : "";
  if (!name) {
    throw refuse("could not work out the remote's default branch — pass route.base explicitly");
  }
  return name;
}

function remoteHasBranch(dir, branch) {
  const r = tryRun("git", dir, ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/" + branch]);
  if (r.status === 0) return true;
  if (r.status === 2) return false;
  throw new Error("could not ask the remote whether branch \"" + branch + "\" exists → " +
    r.err.split("\n").slice(-2).join(" ").trim() + " — fix the receiver host's git access to that repo");
}

const BRANCH_RE = /^[A-Za-z][A-Za-z0-9._/-]*$/;

function assertBranchName(branch) {
  if (!branch) {
    throw refuse("route.branch is required — name the working branch to create, e.g. feature/design-tokens");
  }
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.includes("@{")) {
    throw refuse('route.branch "' + branch + '" is not a usable branch name — start it with a letter and ' +
      'use only letters, digits and . _ - / , with no "..", no "@{" and no trailing "/"');
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** GitLab protection rules are globs (`release/*`, and plenty of projects have a bare `*`). */
const branchMatchesRule = (branch, rule) =>
  new RegExp("^" + String(rule).split("*").map(escapeRe).join(".*") + "$").test(branch);

async function gitlabJson(method, endpoint, body) {
  const res = await fetch(gitlabApi() + endpoint, {
    method,
    headers: {
      "PRIVATE-TOKEN": gitlabToken(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("GitLab " + method + " " + endpoint + " → HTTP " + res.status + " " +
      text.slice(0, 300) + " — check ALLCREW_CHANNEL_GITLAB_TOKEN has `api` scope on this project and that " +
      "route.project is the full path (group/subgroup/project) or the numeric id");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitLab " + method + " " + endpoint + " returned something that is not JSON — " +
      "is ALLCREW_CHANNEL_GITLAB_API (" + gitlabApi() + ") pointing at a GitLab REST root?");
  }
}

/** Returns the rule that covers `branch`, or null. Asking GitLab is the only way to know: the
 * remote will happily let a push to a protected branch get as far as the server's refusal. */
async function protectedRule(project, branch) {
  const rules = await gitlabJson("GET", "/projects/" + encodeURIComponent(project) + "/protected_branches");
  if (!Array.isArray(rules)) return null;
  const hit = rules.find((r) => r && r.name && branchMatchesRule(branch, r.name));
  return hit ? hit.name : null;
}

function parseNumstat(out) {
  const rows = new Map();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let p = m[3];
    if (p === "") { p = parts[i + 2]; i += 2; } // rename record: counts, then <from>, <to>
    rows.set(p, {
      added: m[1] === "-" ? 0 : parseInt(m[1], 10),
      removed: m[2] === "-" ? 0 : parseInt(m[2], 10),
      binary: m[1] === "-",
    });
  }
  return rows;
}

function parseNameStatus(out) {
  const actions = new Map();
  const parts = out.split("\0").filter((s) => s !== "");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    if (code === "R" || code === "C") { actions.set(parts[i + 2], code); i += 1; continue; }
    actions.set(parts[i + 1], code);
  }
  return actions;
}

/** Apply the payload into a checked-out worktree and let git describe the result. git, not a
 * hand-rolled differ, decides line counts and what counts as binary — the same judgement the
 * commit itself would make. With `restore` the worktree is put back exactly as it was found,
 * which is the whole of what makes a dry run dry. */
function applyAndPlan(dir, subPath, files, restore) {
  const sub = sanitizeRel(subPath || "");
  writeFiles(path.join(dir, sub), files);
  // --force: the payload is an explicit instruction. A repository that happens to ignore
  // static/img/ would otherwise drop the assets from both the plan and the commit, silently.
  git(dir, ["add", "-A", "--force"]);

  const quiet = ["-c", "core.quotePath=false", "diff", "--cached"];
  const rows = parseNumstat(git(dir, [...quiet, "--numstat", "-z"]));
  const actions = parseNameStatus(git(dir, [...quiet, "--name-status", "-z"]));
  let diff = git(dir, [...quiet]);

  const planFiles = [];
  const seen = new Set();
  const add = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    const row = rows.get(p);
    planFiles.push({
      path: p,
      action: !row ? "unchanged" : actions.get(p) === "A" ? "create" : "update",
      added: row ? row.added : 0,
      removed: row ? row.removed : 0,
      binary: row ? row.binary : false,
    });
  };
  for (const name of Object.keys(files)) add(joinRel(sub, sanitizeRel(name)));
  for (const p of rows.keys()) add(p);

  const truncated = diff.length > DIFF_CAP;
  if (truncated) diff = diff.slice(0, DIFF_CAP) + "\n… diff truncated at " + DIFF_CAP + " bytes\n";

  if (restore) {
    git(dir, ["reset", "--quiet", "--hard"]);
    git(dir, ["clean", "-qfd"]);
  }
  return { files: planFiles, diff, truncated };
}

const changedCount = (plan) => plan.files.filter((f) => f.action !== "unchanged").length;

function summarize(plan) {
  const n = (action) => plan.files.filter((f) => f.action === action).length;
  return n("create") + " new, " + n("update") + " changed, " + n("unchanged") + " unchanged";
}

/** The folder target has no repository to diff against, so it borrows one: a throwaway repo in
 * the work dir seeded with whatever is already on disk at those paths. The plan then comes out
 * of the same code path — and the same idea of "binary" — as the repo targets, instead of a
 * second differ that would drift from the first. */
function planAgainstDisk(destDir, files) {
  const scratch = path.join(workDir(), "plan-" + crypto.randomBytes(6).toString("hex"));
  try {
    fs.mkdirSync(scratch, { recursive: true });
    git(scratch, ["init", "--quiet", "--initial-branch=base", "."]);
    for (const name of Object.keys(files)) {
      const rel = sanitizeRel(name);
      const existing = path.join(destDir, rel);
      if (!fs.existsSync(existing)) continue;
      fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      fs.copyFileSync(existing, path.join(scratch, rel));
    }
    git(scratch, ["add", "-A"]);
    gitCommit(scratch, "on disk now", true);
    return applyAndPlan(scratch, "", files, false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Checks that must pass before a single byte is written, shared by git/pr/mr. `mr` and `pr`
 * build a new branch and refuse to reuse one; `git` updates a branch on purpose, so it only
 * refuses the branches nobody should be pushed to unattended. */
async function guardBranch({ dir, branch, base, defaultBranch, project, target }) {
  assertBranchName(branch);

  const named = /^(main|master)$/i.test(branch);
  if (target === "git") {
    if ((named || branch === defaultBranch) && !allowDefaultBranchPush()) {
      throw refuse('the git target refuses to push to "' + branch + '": it is ' +
        (named ? "a default branch name" : 'the remote default branch') +
        " — deliver to a working branch instead, or set ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1 on the receiver host if you really mean it");
    }
  } else {
    if (branch === base) {
      throw refuse('route.branch "' + branch + '" is the base branch — a merge request needs a working ' +
        "branch distinct from route.base (" + base + "), e.g. feature/design-tokens");
    }
    if (named) {
      throw refuse('route.branch "' + branch + '" is a default branch name — name a working branch, e.g. feature/design-tokens');
    }
  }

  if (project && gitlabToken()) {
    const rule = await protectedRule(project, branch);
    if (rule) {
      throw refuse('route.branch "' + branch + '" is protected on GitLab by rule "' + rule +
        '" — pick a working branch name no protection rule covers, e.g. feature/design-tokens');
    }
  }

  if (target !== "git" && remoteHasBranch(dir, branch)) {
    throw refuse('branch "' + branch + '" already exists on the remote — the receiver never rewrites ' +
      "someone else's branch; pick a new name, or delete it there first");
  }
}

const TARGETS = {
  async folder(route, files, dryRun) {
    if (!folderBase()) {
      throw refuse("folder target needs ALLCREW_CHANNEL_FOLDER_BASE set on the receiver host — point it at the directory the files should land in");
    }
    const dest = path.join(folderBase(), sanitizeRel(route.path || ""));
    if (dryRun) {
      const plan = planAgainstDisk(dest, files);
      return { detail: "dry run for " + dest + ": " + summarize(plan) + " (nothing written)", plan };
    }
    const written = writeFiles(dest, files);
    return { detail: "wrote " + written.length + " file(s) to " + dest };
  },

  async git(route, files, dryRun) {
    if (!route.repo) throw refuse("git target needs route.repo — the clone URL of the repository to commit into");
    const dir = ensureRepo(route.repo);
    const head = remoteHead(dir);
    const base = route.base || head;
    const branch = route.branch || base;
    await guardBranch({ dir, branch, base, defaultBranch: head, project: route.project, target: "git" });

    const start = remoteHasBranch(dir, branch) ? "origin/" + branch : "origin/" + base;
    git(dir, ["checkout", "--quiet", "-B", branch, start]);
    const plan = applyAndPlan(dir, route.path, files, dryRun);
    if (dryRun) {
      return { detail: "dry run on " + branch + ": " + summarize(plan) + " (nothing committed, nothing pushed)", plan };
    }
    if (!changedCount(plan)) return { detail: "no changes on " + branch, plan };
    gitCommit(dir, route.title || DEFAULT_TITLE);
    git(dir, ["push", "--quiet", "-u", "origin", branch]);
    return { detail: "committed + pushed " + changedCount(plan) + " file(s) to " + branch, plan };
  },

  async pr(route, files, dryRun) {
    if (!route.repo) throw refuse("pr target needs route.repo — the clone URL the receiver should push to");
    const dir = ensureRepo(route.repo);
    const base = route.base || remoteHead(dir);
    const branch = route.branch || "allcrew/tokens-" + Date.now();
    await guardBranch({ dir, branch, base, project: route.project, target: "pr" });

    git(dir, ["checkout", "--quiet", "-B", branch, "origin/" + base]);
    const plan = applyAndPlan(dir, route.path, files, dryRun);
    if (dryRun) {
      return { detail: "dry run for " + branch + " → " + base + ": " + summarize(plan) + " (no branch pushed, no PR opened)", plan };
    }
    if (!changedCount(plan)) return { detail: "no changes vs " + base + " — nothing to open a pull request for", plan };
    gitCommit(dir, route.title || DEFAULT_TITLE);
    git(dir, ["push", "--quiet", "-u", "origin", branch]);
    const url = run("gh", dir, ["pr", "create", "--base", base, "--head", branch,
      "--title", route.title || DEFAULT_TITLE, "--body", route.description || DEFAULT_DESCRIPTION]);
    return { detail: "opened pull request " + url, plan, url };
  },

  /* GitLab. Deliberately not the `pr` target with a different word in it: `gh` is GitHub's CLI
   * and knows nothing about GitLab, so the merge request is created over the REST API with a
   * token that lives on this host. */
  async mr(route, files, dryRun) {
    if (!route.repo) throw refuse("mr target needs route.repo — the clone URL the receiver pushes the working branch to");
    if (!route.project) {
      throw refuse("mr target needs route.project — the GitLab project the merge request is opened on, " +
        "either the full path (group/subgroup/project) or its numeric id");
    }
    assertBranchName(route.branch);
    if (!gitlabToken()) {
      throw refuse("mr target needs ALLCREW_CHANNEL_GITLAB_TOKEN on the receiver host (a token with `api` scope) — " +
        "GitLab credentials live on the receiver, never in the plugin");
    }
    const dir = ensureRepo(route.repo);
    const base = route.base || remoteHead(dir);
    await guardBranch({ dir, branch: route.branch, base, project: route.project, target: "mr" });

    git(dir, ["checkout", "--quiet", "-B", route.branch, "origin/" + base]);
    const plan = applyAndPlan(dir, route.path, files, dryRun);
    if (dryRun) {
      return {
        detail: "dry run for " + route.branch + " → " + base + ": " + summarize(plan) +
          " (no branch pushed, no merge request created)",
        plan,
      };
    }
    if (!changedCount(plan)) {
      return { detail: "no changes vs " + base + " — nothing to open a merge request for", plan };
    }
    gitCommit(dir, route.title || DEFAULT_TITLE);
    git(dir, ["push", "--quiet", "-u", "origin", route.branch]);
    const mr = await gitlabJson("POST", "/projects/" + encodeURIComponent(route.project) + "/merge_requests", {
      source_branch: route.branch,
      target_branch: base,
      title: route.title || DEFAULT_TITLE,
      description: route.description || DEFAULT_DESCRIPTION,
      remove_source_branch: true,
    });
    if (!mr || !mr.web_url) {
      throw new Error("GitLab accepted the merge request but returned no web_url — the branch \"" +
        route.branch + "\" is pushed, so open the merge request by hand");
    }
    return { detail: "opened merge request " + mr.web_url, plan, url: mr.web_url };
  },

  async npm(route, files, dryRun) {
    if (!route.package) throw refuse("npm target needs route.package — the package name to publish");
    const dir = path.join(workDir(), "npm-" + crypto.createHash("sha1").update(route.package).digest("hex").slice(0, 12));
    fs.rmSync(dir, { recursive: true, force: true });
    const written = writeFiles(path.join(dir, sanitizeRel(route.path || "")), files);
    let version = "0.0.1";
    const cur = tryRun("npm", dir, ["view", route.package, "version"]);
    if (cur.status === 0 && cur.out) {
      const p = cur.out.split(".");
      p[2] = String((parseInt(p[2], 10) || 0) + 1);
      version = p.join(".");
    }
    fs.writeFileSync(path.join(dir, "package.json"),
      JSON.stringify({ name: route.package, version, files: ["**/*"], publishConfig: { access: "public" } }, null, 2));
    if (dryRun) {
      return { detail: "dry run: would publish " + route.package + "@" + version + " with " + written.length + " file(s) (nothing published)" };
    }
    run("npm", dir, ["publish"]);
    return { detail: "published " + route.package + "@" + version };
  },
};

/* Every target drives the same work-directory checkout through blocking git calls, so two
 * deliveries arriving together would fight over one worktree. They queue instead. */
let queue = Promise.resolve();
function serialize(job) {
  const result = queue.then(job, job);
  queue = result.then(() => {}, () => {});
  return result;
}

async function handleDelivery(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    throw refuse("body must be a JSON object");
  }
  const target = typeof msg.target === "string" && msg.target ? msg.target : "folder";
  if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) {
    throw refuse('unknown target "' + target + '" — expected one of ' + Object.keys(TARGETS).join(", "));
  }
  const files = msg.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw refuse('no files in payload — expected an object of { "path": "text" | { "base64": "…" } }');
  }
  const names = Object.keys(files);
  if (!names.length) throw refuse("no files in payload");
  for (const name of names) {
    if (!sanitizeRel(name)) throw refuse("file paths must be non-empty");
    assertFileValue(name, files[name]);
  }

  const dryRun = msg.dryRun === true;
  const route = msg.route && typeof msg.route === "object" ? msg.route : {};
  const result = await serialize(() => TARGETS[target](route, files, dryRun));
  return { ok: true, target, dryRun, ...result };
}

function health() {
  return {
    ok: true,
    service: "allcrew-channel-tokens-receiver",
    pairing: pairingOpen(),
    targets: Object.keys(TARGETS),
    capabilities: {
      gitlabToken: Boolean(gitlabToken()),
      gitlabApi: gitlabApi(),
      folderBase: folderBase() || null,
      workDir: workDir(),
      allowDefaultBranchPush: allowDefaultBranchPush(),
    },
  };
}

export const receiver = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-allcrew-channel-secret");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(health())); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  // Ahead of the secret gate on purpose: this is how a plugin gets the secret at all. Matched
  // by suffix, so a configured endpoint like https://host/allcrew-channel-tokens pairs at .../pair and
  // a reverse-proxy prefix does not break it.
  const routePath = (req.url || "/").split("?")[0].replace(/\/+$/, "");
  if (routePath.endsWith("/pair")) {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!isLoopback(req)) return reply(403, { ok: false, error: "pairing is loopback-only" });
    if (!pairingOpen()) {
      return reply(403, { ok: false, error: "pairing window is closed — restart the receiver (or run it with --pair) and pair within 5 minutes" });
    }
    pairOpenUntil = 0; // one-shot: the first plugin to ask closes the window behind itself
    console.log(new Date().toISOString(), "paired — secret handed to the plugin, window closed");
    return reply(200, { ok: true, secret: SECRET });
  }

  const chunks = [];
  let size = 0, tooBig = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > maxBodyBytes()) { tooBig = true; return; }
    chunks.push(c);
  });
  req.on("end", () => {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const fail = (code, message) => {
      console.error(new Date().toISOString(), "ERROR —", message);
      return reply(code, { ok: false, error: message });
    };
    if (tooBig) return fail(413, "payload too large (cap is ALLCREW_CHANNEL_MAX_BODY_MB=" + maxBodyBytes() / 1024 / 1024 + " MB)");
    if (!safeEqual(req.headers["x-allcrew-channel-secret"], SECRET)) return fail(401, "bad or missing secret");

    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (e) {
      return fail(400, "body is not JSON — POST the delivery object described in the receiver header");
    }
    handleDelivery(msg).then(
      (result) => {
        console.log(new Date().toISOString(), result.target, result.dryRun ? "DRY-RUN" : "OK", "—", result.detail);
        reply(200, result);
      },
      (e) => fail((e && e.status) || 500, (e && e.message) || String(e)),
    );
  });
});

// Real paths on both sides: run through a symlinked directory (macOS /tmp → /private/tmp) the
// two spellings differ and the receiver would exit without ever listening.
const invokedDirectly = Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  receiver.listen(PORT, () => {
    const cap = health().capabilities;
    console.log("allcrew-channel-tokens-receiver listening on :" + receiver.address().port +
      "  (targets: " + Object.keys(TARGETS).join(", ") + ")");
    console.log("  secret:      " + (SECRET_SOURCE === "env"
      ? "ALLCREW_CHANNEL_SECRET (yours to manage)"
      : SECRET_FILE + " (" + (SECRET_SOURCE === "minted" ? "just created" : "existing") + ")"));
    console.log("  pairing:     " + (pairingOpen()
      ? "OPEN for " + PAIR_WINDOW_MS / 60000 + " min — press Pair in the plugin's Delivery settings"
      : "closed (secret came from the environment) — restart with --pair to open it"));
    console.log("  folder base: " + (cap.folderBase || "unset — the folder target will refuse"));
    console.log("  gitlab:      " + (cap.gitlabToken
      ? "ALLCREW_CHANNEL_GITLAB_TOKEN set, API " + cap.gitlabApi
      : "no ALLCREW_CHANNEL_GITLAB_TOKEN — the mr target will refuse, and git cannot check protected branches"));
    console.log("  work dir:    " + cap.workDir);
    if (cap.allowDefaultBranchPush) console.log("  ⚠ ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1 — git may push to main/master");
  });
}
