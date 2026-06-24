#!/usr/bin/env node
/*
 * Altery token receiver — the "dumb executor" half of the delivery pipeline.
 * The Figma plugin (Delivery settings) POSTs the generated package here; this script
 * runs the actual git / PR / npm / folder action. It is intentionally portable:
 * no dependencies, just Node built-ins + the host's own git/gh/npm CLIs.
 *
 * Run it on any host (your machine now, someone else's later — the plugin's endpoint
 * is configurable, so nothing is pinned to one person):
 *
 *     ALTERY_SECRET=your-shared-secret node server/receiver.js
 *
 * Environment:
 *   ALTERY_SECRET       (required) must equal the "Shared secret" in the plugin.
 *   PORT                (default 8787)
 *   ALTERY_FOLDER_BASE  base dir for the "folder" target; route.path is resolved under it.
 *   ALTERY_WORK_DIR     scratch dir for git/pr/npm clones (default <tmp>/altery-tokens).
 *
 * Credentials stay HERE, never in the plugin:
 *   git/pr  → the host's git auth (SSH key or credential helper); PRs use the `gh` CLI.
 *   npm     → the host's `npm login` (~/.npmrc).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PORT = parseInt(process.env.PORT || "8787", 10);
const SECRET = process.env.ALTERY_SECRET || "";
const FOLDER_BASE = process.env.ALTERY_FOLDER_BASE || "";
const WORK_DIR = process.env.ALTERY_WORK_DIR || path.join(os.tmpdir(), "altery-tokens");

if (!SECRET) {
  console.error("FATAL: set ALTERY_SECRET (must match the plugin's Shared secret).");
  process.exit(1);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Run a CLI, returning stdout. On failure, throw an Error carrying the last lines of stderr. */
function run(cmd, cwd, args) {
  try {
    return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    const err = ((e.stderr && e.stderr.toString()) || e.message || "").trim();
    throw new Error(cmd + " " + args.join(" ") + " → " + err.split("\n").slice(-3).join(" ").trim());
  }
}
const git = (cwd, args) => run("git", cwd, args);

/** Normalize to a relative path with no leading slash and no `..` traversal. */
function sanitizeRel(p) {
  const norm = path.posix
    .normalize(String(p || "").replace(/\\/g, "/"))
    .replace(/^\/+/, "");
  if (norm === ".." || norm.split("/").indexOf("..") !== -1) throw new Error("invalid path (traversal): " + p);
  return norm === "." ? "" : norm;
}

function writeFiles(destDir, files) {
  const written = [];
  for (const name of Object.keys(files)) {
    const full = path.join(destDir, sanitizeRel(name));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(files[name]));
    written.push(path.relative(destDir, full));
  }
  return written;
}

function ensureRepo(repo) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const dir = path.join(WORK_DIR, "repo-" + crypto.createHash("sha1").update(repo).digest("hex").slice(0, 12));
  if (!fs.existsSync(path.join(dir, ".git"))) git(WORK_DIR, ["clone", repo, dir]);
  else git(dir, ["fetch", "--all", "--prune"]);
  return dir;
}

function commitInto(dir, branch, route, files, fresh) {
  git(dir, ["checkout", branch]);
  git(dir, ["reset", "--hard", "origin/" + branch]);
  if (fresh) git(dir, ["checkout", "-b", fresh]);
  writeFiles(path.join(dir, sanitizeRel(route.path || "")), files);
  git(dir, ["add", "-A"]);
  if (!git(dir, ["status", "--porcelain"])) return false;
  git(dir, ["-c", "user.name=Altery Tokens", "-c", "user.email=tokens@altery.local",
    "commit", "-m", "chore(tokens): sync design tokens from Figma"]);
  return true;
}

const TARGETS = {
  folder(route, files) {
    if (!FOLDER_BASE) throw new Error("folder target needs ALTERY_FOLDER_BASE set on the receiver");
    const dest = path.join(FOLDER_BASE, sanitizeRel(route.path || ""));
    const w = writeFiles(dest, files);
    return "wrote " + w.length + " file(s) to " + dest;
  },
  git(route, files) {
    if (!route.repo) throw new Error("git target needs route.repo");
    const branch = route.branch || "main";
    const dir = ensureRepo(route.repo);
    if (!commitInto(dir, branch, route, files, null)) return "no changes on " + branch;
    git(dir, ["push", "origin", branch]);
    return "committed + pushed to " + branch;
  },
  pr(route, files) {
    if (!route.repo) throw new Error("pr target needs route.repo");
    const base = route.branch || "main";
    const head = "altery/tokens-" + Date.now();
    const dir = ensureRepo(route.repo);
    if (!commitInto(dir, base, route, files, head)) return "no changes vs " + base;
    git(dir, ["push", "origin", head]);
    const url = run("gh", dir, ["pr", "create", "--base", base, "--head", head,
      "--title", "chore(tokens): sync design tokens", "--body", "Automated token sync from Figma."]);
    return "opened PR: " + url;
  },
  npm(route, files) {
    if (!route.package) throw new Error("npm target needs route.package");
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const dir = path.join(WORK_DIR, "npm-" + crypto.createHash("sha1").update(route.package).digest("hex").slice(0, 12));
    fs.rmSync(dir, { recursive: true, force: true });
    writeFiles(path.join(dir, sanitizeRel(route.path || "")), files);
    let version = "0.0.1";
    try {
      const cur = run("npm", dir, ["view", route.package, "version"]);
      if (cur) { const p = cur.split("."); p[2] = String((parseInt(p[2], 10) || 0) + 1); version = p.join("."); }
    } catch (e) { /* unpublished package → start at 0.0.1 */ }
    fs.writeFileSync(path.join(dir, "package.json"),
      JSON.stringify({ name: route.package, version, files: ["**/*"], publishConfig: { access: "public" } }, null, 2));
    run("npm", dir, ["publish"]);
    return "published " + route.package + "@" + version;
  },
};

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-altery-secret");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "altery-tokens-receiver" })); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  let body = "", tooBig = false;
  req.on("data", (c) => { body += c; if (body.length > 10 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on("end", () => {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (tooBig) return reply(413, { error: "payload too large" });
      if (!safeEqual(req.headers["x-altery-secret"], SECRET)) return reply(401, { error: "bad or missing secret" });
      const msg = JSON.parse(body);
      const fn = TARGETS[msg.target || "folder"];
      if (!fn) return reply(400, { error: "unknown target: " + msg.target });
      if (!msg.files || typeof msg.files !== "object") return reply(400, { error: "no files in payload" });
      const detail = fn(msg.route || {}, msg.files);
      console.log(new Date().toISOString(), (msg.target || "folder"), "OK —", detail);
      return reply(200, { ok: true, target: msg.target || "folder", detail });
    } catch (e) {
      const m = (e && e.message) || String(e);
      console.error(new Date().toISOString(), "ERROR —", m);
      return reply(500, { error: m });
    }
  });
});

server.listen(PORT, () => {
  console.log("altery-tokens-receiver listening on :" + PORT + "  (targets: folder, git, pr, npm)");
  if (FOLDER_BASE) console.log("  folder base: " + FOLDER_BASE);
  console.log("  work dir:    " + WORK_DIR);
});
