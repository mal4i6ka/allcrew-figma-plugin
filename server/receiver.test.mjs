/*
 * Receiver tests. Everything happens against throwaway state in one temp dir: a bare git
 * repository standing in for the remote, a clone the receiver treats as any other repo, and a
 * stub GitLab REST root — so the MR path is exercised end to end without a network and without
 * anyone's credentials. The dry-run tests hash the whole temp tree except the receiver's own
 * work dir and assert it is byte-identical afterwards; that is the claim "a dry run writes
 * nothing" in a form that cannot quietly stop being true.
 *
 *     node --test server/receiver.test.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "allcrew-channel-receiver-test-")));
const WORK = path.join(TMP, "work");
const FOLDER = path.join(TMP, "folder");
const REMOTE = path.join(TMP, "remote.git");
const SECRET = "test-secret";

process.env.ALLCREW_CHANNEL_SECRET = SECRET;
process.env.ALLCREW_CHANNEL_WORK_DIR = WORK;
process.env.ALLCREW_CHANNEL_FOLDER_BASE = FOLDER;
process.env.ALLCREW_CHANNEL_GITLAB_TOKEN = "stub-token";
delete process.env.ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const gitBytes = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

// ── the "remote" and its first commit ───────────────────────────────────────────────────────
// Default branch is `trunk`, not `main`: a receiver that hardcodes `main` cannot pass.
execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=trunk", REMOTE]);
const SEED = path.join(TMP, "seed");
git(TMP, "clone", "--quiet", REMOTE, SEED);
fs.writeFileSync(path.join(SEED, "README.md"), "# site\n");
fs.mkdirSync(path.join(SEED, "src"), { recursive: true });
fs.writeFileSync(path.join(SEED, "src", "tokens.css"), "a\nb\nc\n");
git(SEED, "add", "-A");
git(SEED, "-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "--quiet", "-m", "seed");
git(SEED, "push", "--quiet", "origin", "trunk");
const SEED_SHA = git(REMOTE, "rev-parse", "refs/heads/trunk");

// ── stub GitLab ─────────────────────────────────────────────────────────────────────────────
const gitlabCalls = [];
const PROTECTED = [{ name: "trunk" }, { name: "main" }, { name: "release/*" }];
const gitlab = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    gitlabCalls.push({
      method: req.method,
      url: req.url,
      token: req.headers["private-token"],
      body: raw ? JSON.parse(raw) : null,
    });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url.endsWith("/protected_branches")) return send(200, PROTECTED);
    if (req.method === "POST" && req.url.endsWith("/merge_requests")) {
      return send(201, { iid: 42, web_url: "https://gitlab.example/team/site/-/merge_requests/42" });
    }
    send(404, { message: "404 Not Found" });
  });
});
await new Promise((r) => gitlab.listen(0, "127.0.0.1", r));
process.env.ALLCREW_CHANNEL_GITLAB_API = "http://127.0.0.1:" + gitlab.address().port;

// Imported only now: the secret is resolved at import time and must be the one above, never a
// minted file in the real ~/.allcrew-channel.
const { receiver } = await import("./receiver.mjs");
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
const ENDPOINT = "http://127.0.0.1:" + receiver.address().port;

after(() => {
  receiver.close();
  gitlab.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.equal(fs.existsSync(TMP), false, "temp dir left behind");
});

async function post(body, secret = SECRET) {
  const res = await fetch(ENDPOINT + "/deliver", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-allcrew-channel-secret": secret },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Every file under `dir` (minus `skip`) as path→sha1, so "nothing moved" is one assertion. */
function treeHash(dir, skip) {
  const out = {};
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (full === skip) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out[path.relative(dir, full)] = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

const workClone = () => {
  const name = fs.readdirSync(WORK).find((n) => n.startsWith("repo-"));
  return name ? path.join(WORK, name) : null;
};
const remoteBranches = () =>
  git(REMOTE, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
const byPath = (plan) => Object.fromEntries(plan.files.map((f) => [f.path, f]));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe, 0x00]);

test("GET / reports the five targets and which capabilities are configured", async () => {
  const res = await fetch(ENDPOINT + "/");
  const body = await res.json();
  assert.equal(body.service, "allcrew-channel-tokens-receiver");
  assert.deepEqual(body.targets, ["folder", "git", "pr", "mr", "npm"]);
  assert.equal(body.capabilities.gitlabToken, true);
  assert.equal(body.capabilities.folderBase, FOLDER);
  assert.equal(body.capabilities.workDir, WORK);
  assert.equal(body.capabilities.allowDefaultBranchPush, false);
});

test("a wrong secret is refused and writes nothing", async () => {
  const r = await post({ target: "folder", files: { "nope.txt": "x" } }, "not-the-secret");
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /secret/);
  assert.equal(fs.existsSync(path.join(FOLDER, "nope.txt")), false);
});

test("folder writes UTF-8 text and base64 bytes verbatim", async () => {
  const r = await post({
    target: "folder",
    route: { path: "site" },
    files: {
      "css/tokens.css": "body { color: #fff }\n",
      "static/img/logo.png": { base64: PNG.toString("base64") },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dryRun, false);
  assert.equal(fs.readFileSync(path.join(FOLDER, "site/css/tokens.css"), "utf8"), "body { color: #fff }\n");
  assert.deepEqual(fs.readFileSync(path.join(FOLDER, "site/static/img/logo.png")), PNG);
});

test("a traversing path is refused before anything is written", async () => {
  const r = await post({ target: "folder", files: { "../escaped.txt": "x" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /traversal/);
  assert.equal(fs.existsSync(path.join(TMP, "escaped.txt")), false);
});

test("a file value that is neither text nor { base64 } is refused", async () => {
  const r = await post({ target: "folder", files: { "a.txt": { bytes: [1, 2] } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /base64/);
});

test("folder dry run plans against what is on disk and writes nothing", async () => {
  const before = treeHash(TMP, WORK);
  const r = await post({
    target: "folder",
    dryRun: true,
    route: { path: "site" },
    files: {
      "css/tokens.css": "body { color: #000 }\n",
      "css/new.css": ".x {}\n",
      "static/img/logo.png": { base64: PNG.toString("base64") },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  const files = byPath(r.body.plan);
  assert.equal(files["css/tokens.css"].action, "update");
  assert.equal(files["css/tokens.css"].added, 1);
  assert.equal(files["css/tokens.css"].removed, 1);
  assert.equal(files["css/new.css"].action, "create");
  assert.equal(files["static/img/logo.png"].action, "unchanged");
  assert.match(r.body.plan.diff, /--- a\/css\/tokens\.css/);
  assert.equal(r.body.plan.truncated, false);
  assert.deepEqual(treeHash(TMP, WORK), before);
});

test("git dry run returns per-file counts, leaves the worktree clean and the remote untouched", async () => {
  const before = treeHash(TMP, WORK);
  const r = await post({
    target: "git",
    dryRun: true,
    route: { repo: REMOTE, branch: "feature/tokens-one" },
    files: {
      "src/tokens.css": "a\nB\nc\nd\n",
      "README.md": "# site\n",
      "static/img/logo.png": { base64: PNG.toString("base64") },
    },
  });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.dryRun, true);
  const files = byPath(r.body.plan);
  assert.deepEqual(files["src/tokens.css"], {
    path: "src/tokens.css", action: "update", added: 2, removed: 1, binary: false,
  });
  assert.deepEqual(files["README.md"], {
    path: "README.md", action: "unchanged", added: 0, removed: 0, binary: false,
  });
  assert.deepEqual(files["static/img/logo.png"], {
    path: "static/img/logo.png", action: "create", added: 0, removed: 0, binary: true,
  });
  assert.match(r.body.plan.diff, /\+B/);
  assert.equal(r.body.url, undefined);

  assert.equal(git(workClone(), "status", "--porcelain"), "");
  assert.deepEqual(remoteBranches(), ["trunk"]);
  assert.equal(git(REMOTE, "rev-parse", "refs/heads/trunk"), SEED_SHA);
  assert.deepEqual(treeHash(TMP, WORK), before, "a dry run wrote outside the work dir");
});

test("git refuses main, and the remote's own default branch, without the override", async () => {
  const main = await post({ target: "git", route: { repo: REMOTE, branch: "main" }, files: { "x.txt": "x\n" } });
  assert.equal(main.status, 400);
  assert.match(main.body.error, /default branch name/);
  assert.match(main.body.error, /ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1/);

  const trunk = await post({ target: "git", route: { repo: REMOTE, branch: "trunk" }, files: { "x.txt": "x\n" } });
  assert.equal(trunk.status, 400);
  assert.match(trunk.body.error, /the remote default branch/);

  assert.deepEqual(remoteBranches(), ["trunk"]);
  assert.equal(git(REMOTE, "rev-parse", "refs/heads/trunk"), SEED_SHA);
});

test("git commits and pushes a working branch, bytes intact", async () => {
  const r = await post({
    target: "git",
    route: { repo: REMOTE, branch: "feature/tokens-one", title: "chore(tokens): sync one" },
    files: {
      "src/tokens.css": "a\nB\nc\nd\n",
      "static/img/logo.png": { base64: PNG.toString("base64") },
    },
  });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.detail, /pushed/);
  assert.deepEqual(remoteBranches(), ["feature/tokens-one", "trunk"]);
  assert.equal(git(REMOTE, "show", "feature/tokens-one:src/tokens.css"), "a\nB\nc\nd");
  assert.deepEqual(gitBytes(REMOTE, "cat-file", "blob", "feature/tokens-one:static/img/logo.png"), PNG);
  assert.equal(git(REMOTE, "log", "-1", "--format=%an <%ae>%n%s", "feature/tokens-one"),
    "AllCrew Tokens <tokens@allcrew.local>\nchore(tokens): sync one");
  assert.equal(git(REMOTE, "rev-parse", "refs/heads/trunk"), SEED_SHA, "the base branch moved");
});

test("git pushes the default branch once ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH=1 is set", async () => {
  process.env.ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH = "1";
  try {
    const r = await post({ target: "git", route: { repo: REMOTE, branch: "trunk" }, files: { "NOTES.md": "hi\n" } });
    assert.equal(r.status, 200, r.body.error);
    assert.notEqual(git(REMOTE, "rev-parse", "refs/heads/trunk"), SEED_SHA);
    assert.equal(git(REMOTE, "show", "trunk:NOTES.md"), "hi");
  } finally {
    delete process.env.ALLCREW_CHANNEL_ALLOW_DEFAULT_BRANCH_PUSH;
  }
});

test("mr refuses a bad, base, default, protected or existing branch before writing anything", async () => {
  const before = treeHash(TMP, WORK);
  const route = { repo: REMOTE, project: "team/site" };
  const files = { "src/tokens.css": "z\n" };

  const cases = [
    [{ ...route, branch: "feature/missing-project" }, /route\.project/, { project: undefined }],
    [{ ...route, branch: "" }, /route\.branch is required/],
    [{ ...route, branch: "../evil" }, /not a usable branch name/],
    [{ ...route, branch: "feature/@{upstream}" }, /not a usable branch name/],
    [{ ...route, branch: "trunk" }, /is the base branch/],
    [{ ...route, branch: "main" }, /default branch name/],
    [{ ...route, branch: "release/1.0" }, /protected on GitLab by rule "release\/\*"/],
    [{ ...route, branch: "feature/tokens-one" }, /already exists on the remote/],
  ];
  for (const [r, expected, patch] of cases) {
    const res = await post({ target: "mr", route: { ...r, ...(patch || {}) }, files });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, expected);
  }

  assert.deepEqual(remoteBranches(), ["feature/tokens-one", "trunk"]);
  assert.deepEqual(treeHash(TMP, WORK), before, "a refusal wrote something");
  assert.equal(git(workClone(), "status", "--porcelain"), "");
});

test("mr refuses without a GitLab token and says where the token belongs", async () => {
  const token = process.env.ALLCREW_CHANNEL_GITLAB_TOKEN;
  delete process.env.ALLCREW_CHANNEL_GITLAB_TOKEN;
  try {
    const r = await post({
      target: "mr",
      route: { repo: REMOTE, project: "team/site", branch: "feature/tokens-two" },
      files: { "src/tokens.css": "z\n" },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ALLCREW_CHANNEL_GITLAB_TOKEN/);
  } finally {
    process.env.ALLCREW_CHANNEL_GITLAB_TOKEN = token;
  }
});

test("mr dry run targets the remote's default branch and creates no branch", async () => {
  const before = treeHash(TMP, WORK);
  const r = await post({
    target: "mr",
    dryRun: true,
    route: { repo: REMOTE, project: "team/site", branch: "feature/tokens-two" },
    files: { "src/tokens.css": "a\nb\nc\nd\n", "docs/report.md": "# report\n" },
  });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.detail, /→ trunk/, "base must come from the remote HEAD, not a hardcoded main");
  const files = byPath(r.body.plan);
  assert.equal(files["src/tokens.css"].action, "update");
  assert.equal(files["docs/report.md"].action, "create");
  assert.equal(r.body.url, undefined);
  assert.deepEqual(remoteBranches(), ["feature/tokens-one", "trunk"]);
  assert.deepEqual(treeHash(TMP, WORK), before, "a dry run wrote outside the work dir");
  assert.equal(gitlabCalls.at(-1).method, "GET", "a dry run must not POST a merge request");
});

test("mr pushes the branch and opens the merge request over the GitLab REST API", async () => {
  const r = await post({
    target: "mr",
    route: {
      repo: REMOTE, project: "team/site", branch: "feature/tokens-two",
      title: "chore(tokens): sync two", description: "body text",
    },
    files: { "src/tokens.css": "a\nb\nc\nd\n", "static/img/logo.png": { base64: PNG.toString("base64") } },
  });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.url, "https://gitlab.example/team/site/-/merge_requests/42");
  assert.deepEqual(remoteBranches(), ["feature/tokens-one", "feature/tokens-two", "trunk"]);
  assert.equal(git(REMOTE, "show", "feature/tokens-two:src/tokens.css"), "a\nb\nc\nd");

  const call = gitlabCalls.at(-1);
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/projects/team%2Fsite/merge_requests");
  assert.equal(call.token, "stub-token");
  assert.deepEqual(call.body, {
    source_branch: "feature/tokens-two",
    target_branch: "trunk",
    title: "chore(tokens): sync two",
    description: "body text",
    remove_source_branch: true,
  });
});

test("the body cap returns JSON 413 without buffering the excess", async () => {
  process.env.ALLCREW_CHANNEL_MAX_BODY_MB = "1";
  try {
    const r = await post({ target: "folder", files: { "large.txt": "x".repeat(1024 * 1024) } });
    assert.equal(r.status, 413);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /payload too large/);
    assert.equal(fs.existsSync(path.join(FOLDER, "large.txt")), false);
  } finally {
    delete process.env.ALLCREW_CHANNEL_MAX_BODY_MB;
  }
});

test("a JSON primitive and an empty file path are caller errors", async () => {
  const primitive = await post(null);
  assert.equal(primitive.status, 400);
  assert.match(primitive.body.error, /JSON object/);

  const empty = await post({ target: "folder", files: { "": "x" } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /non-empty/);
});

test("an unknown target names the ones that exist", async () => {
  const r = await post({ target: "svn", files: { "a.txt": "x" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /folder, git, pr, mr, npm/);
});
