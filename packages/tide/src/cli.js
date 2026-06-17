#!/usr/bin/env node
// tide — the SandboxOS data-sync CLI. Git-like vocabulary over a versioned core,
// plus a live mirror (docs/05). Reuses the sbx machine token for auth.
//
//   tide clone <workspace> [dir]   pull a Sandbox workspace into a local dir
//   tide status                    working-tree changes since the last mark
//   tide mark -m "msg"             snapshot a tide mark
//   tide log                       history
//   tide push | tide pull          explicit snapshot sync
//   tide link                      live bidirectional mirror (watch + sync)
//
// Glyph: ⇌   (name provisional). Zero dependencies.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Repo } from "./repo.js";
import { TideClient } from "./client.js";
import { runDaemon } from "./daemon.js";

const SBX_CONFIG = process.env.SBX_CONFIG || path.join(os.homedir(), ".sbx", "config.json");
const die = (m) => { console.error("tide: " + m); process.exit(1); };

function creds() {
  try { return JSON.parse(fs.readFileSync(SBX_CONFIG, "utf8")); }
  catch { die("not logged in — run `sbx login` first"); }
}
function findRoot(start) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, ".tide", "config.json"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
function localCtx() {
  const root = findRoot(process.cwd());
  if (!root) die("not a Tide workspace (no .tide/) — run `tide clone <workspace>` first");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".tide", "config.json"), "utf8"));
  const repo = new Repo(path.join(root, ".tide", "store"));
  if (!repo.has(cfg.workspace)) repo.init(cfg.workspace, root);
  return { root, cfg, repo, client: new TideClient(creds()) };
}
const fmtChanges = (c) => (c.length ? c.map((x) => `  ${x.status.padEnd(9)} ${x.path}`) : ["  (clean)"]);

async function cmdClone(args) {
  const workspace = args[0] || die("usage: tide clone <workspace> [dir]");
  const dir = path.resolve(args[1] || workspace);
  fs.mkdirSync(path.join(dir, ".tide"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".tide", "config.json"), JSON.stringify({ workspace }, null, 2));
  const repo = new Repo(path.join(dir, ".tide", "store"));
  const client = new TideClient(creds());
  const r = await client.clone(repo, workspace, dir);
  console.log(`cloned ${client.slug}/${workspace} → ${dir}  (head ${r.head ? r.head.slice(0, 8) : "—"})`);
}

async function cmdStatus() {
  const { cfg, repo } = localCtx();
  console.log(fmtChanges(repo.status(cfg.workspace)).join("\n"));
}

async function cmdMark(args) {
  const { cfg, repo } = localCtx();
  const i = args.indexOf("-m");
  const message = i > -1 ? args[i + 1] : "mark";
  const c = repo.mark(cfg.workspace, { message, author: "local" });
  console.log(c ? `marked ${c.slice(0, 8)}  ${message}` : "(no changes)");
}

async function cmdLog() {
  const { cfg, repo } = localCtx();
  for (const m of repo.log(cfg.workspace)) {
    console.log(`${m.hash.slice(0, 8)}  ${new Date(m.ts).toISOString().slice(0, 19).replace("T", " ")}  ${m.message}`);
  }
}

async function cmdPush() {
  const { cfg, repo, client } = localCtx();
  if (repo.status(cfg.workspace).length) repo.mark(cfg.workspace, { message: "push", author: "local" });
  let r = await client.push(repo, cfg.workspace);
  if (r.applied === false && r.reason === "non-fast-forward") {
    await client.pull(repo, cfg.workspace);
    r = await client.push(repo, cfg.workspace);
  }
  console.log(r.applied ? `pushed → head ${r.head.slice(0, 8)}` : `push failed: ${r.reason}`);
}

async function cmdPull() {
  const { cfg, repo, client } = localCtx();
  const r = await client.pull(repo, cfg.workspace);
  console.log(r.changed ? `pulled → head ${r.head.slice(0, 8)}${r.merged ? " (merged)" : ""}` : "up to date");
}

async function cmdLink() {
  const { root, cfg, repo, client } = localCtx();
  await runDaemon({ client, repo, workspace: cfg.workspace, dir: root, log: console.error });
  await new Promise(() => {}); // run until killed
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = { clone: cmdClone, status: cmdStatus, mark: cmdMark, log: cmdLog, push: cmdPush, pull: cmdPull, link: cmdLink };
if (!cmds[cmd]) console.log("usage: tide <clone|status|mark|log|push|pull|link> …");
else await cmds[cmd](args);
