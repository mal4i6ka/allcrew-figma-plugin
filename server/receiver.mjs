#!/usr/bin/env node
/*
 * AllCrew Channel receiver — the "dumb executor" half of the delivery pipeline.
 * The Figma plugin (Delivery settings) POSTs the generated package here; this script
 * runs the actual git / PR / npm / folder action. It is intentionally portable:
 * no dependencies, just Node built-ins + the host's own git/gh/npm CLIs.
 *
 * Run it on any host (your machine now, someone else's later — the plugin's endpoint
 * is configurable, so nothing is pinned to one person):
 *
 *     node receiver.mjs
 *
 * Nobody types a secret for the common case. On a host with none configured this mints one
 * into ~/.allcrew-channel/receiver-secret (0600) and opens a five-minute pairing window; the plugin's
 * "Pair" button in Delivery settings collects it. Every machine therefore has a different
 * secret and none of them was ever distributed. For a shared or remote host, set
 * ALLCREW_CHANNEL_SECRET yourself — that suppresses pairing entirely (loopback-only in any case).
 *
 * Environment:
 *   ALLCREW_CHANNEL_SECRET       manage the secret by hand; suppresses pairing (--pair forces a window)
 *   ALLCREW_CHANNEL_SECRET_FILE  where a minted secret lives (default ~/.allcrew-channel/receiver-secret)
 *   PORT                (default 8787)
 *   ALLCREW_CHANNEL_FOLDER_BASE  base dir for the "folder" target; route.path is resolved under it.
 *   ALLCREW_CHANNEL_WORK_DIR     scratch dir for git/pr/npm clones (default <tmp>/allcrew-channel-tokens).
 *
 * Credentials stay HERE, never in the plugin:
 *   git/pr  → the host's git auth (SSH key or credential helper); PRs use the `gh` CLI.
 *   npm     → the host's `npm login` (~/.npmrc).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const PORT = parseInt(process.env.PORT || "8787", 10);
const FOLDER_BASE = process.env.ALLCREW_CHANNEL_FOLDER_BASE || "";
const WORK_DIR = process.env.ALLCREW_CHANNEL_WORK_DIR || path.join(os.tmpdir(), "allcrew-channel-tokens");
const SECRET_FILE =
  process.env.ALLCREW_CHANNEL_SECRET_FILE || path.join(os.homedir(), ".allcrew-channel", "receiver-secret");

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
  git(dir, ["-c", "user.name=AllCrew Channel Tokens", "-c", "user.email=tokens@allcrew-channel.local",
    "commit", "-m", "chore(tokens): sync design tokens from Figma"]);
  return true;
}

const TARGETS = {
  folder(route, files) {
    if (!FOLDER_BASE) throw new Error("folder target needs ALLCREW_CHANNEL_FOLDER_BASE set on the receiver");
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
    const head = "allcrew-channel/tokens-" + Date.now();
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-allcrew-channel-secret");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "allcrew-channel-tokens-receiver", pairing: pairingOpen() })); return; }
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

  let body = "", tooBig = false;
  req.on("data", (c) => { body += c; if (body.length > 10 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on("end", () => {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (tooBig) return reply(413, { error: "payload too large" });
      if (!safeEqual(req.headers["x-allcrew-channel-secret"], SECRET)) return reply(401, { error: "bad or missing secret" });
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
  console.log("AllCrew Channel receiver listening on :" + PORT + "  (targets: folder, git, pr, npm)");
  console.log("  secret:      " + (SECRET_SOURCE === "env"
    ? "ALLCREW_CHANNEL_SECRET (yours to manage)"
    : SECRET_FILE + " (" + (SECRET_SOURCE === "minted" ? "just created" : "existing") + ")"));
  console.log("  pairing:     " + (pairingOpen()
    ? "OPEN for " + PAIR_WINDOW_MS / 60000 + " min — press Pair in the plugin's Delivery settings"
    : "closed (secret came from the environment) — restart with --pair to open it"));
  if (FOLDER_BASE) console.log("  folder base: " + FOLDER_BASE);
  console.log("  work dir:    " + WORK_DIR);
});
