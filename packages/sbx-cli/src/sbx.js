#!/usr/bin/env node
// sbx — the SandboxOS Command Central CLI.
//
// Talks to a Gateway over a capability-scoped machine token, so it works from any
// network (docs/06). `sbx login` mints the token; everything else uses it.
//
//   sbx login [--url URL] [--slug SLUG]   mint + save a machine token for this device
//   sbx run "<line>"                      run one Command Central line
//   sbx call <server.tool> <json>         raw MCP call
//   sbx audit [n]                         recent audit events
//   sbx watch                             live-tail the audit stream
//   sbx token [--patterns a,b]            mint another (optionally narrower) token
//
// Zero dependencies (global fetch + node built-ins).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const CONFIG = process.env.SBX_CONFIG || path.join(os.homedir(), ".sbx", "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function flag(args, name, def) {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : def;
}
function die(msg) { console.error("sbx: " + msg); process.exit(1); }

async function ask(question, { hidden = false } = {}) {
  if (process.env.SBX_PASSWORD) return process.env.SBX_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl.output.write = () => {}; // best-effort no-echo
  return new Promise((res) => rl.question(question, (a) => { rl.close(); console.log(); res(a); }));
}

async function api(cfg, p, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(cfg.url + p, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function cmdLogin(args) {
  const url = (flag(args, "url", "http://127.0.0.1:3939")).replace(/\/$/, "");
  const password = await ask("password: ", { hidden: true });
  const login = await fetch(url + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const data = await login.json();
  if (!data.ok) die(data.error || "login failed");
  const slug = flag(args, "slug", data.slug);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const patterns = flag(args, "patterns");
  const mint = await fetch(`${url}/${slug}/tokens`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ label: os.hostname(), patterns: patterns ? patterns.split(",") : undefined }),
  });
  const m = await mint.json();
  if (!m.ok) die(m.error || "could not mint token");
  saveConfig({ url, slug, token: m.token });
  console.log(`logged in → ${url}/${slug}  (token scope: ${m.patterns.join(", ")})`);
}

async function cmdRun(line) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in — run `sbx login`");
  const res = await api(cfg, `/${cfg.slug}/exec`, { method: "POST", body: { line } });
  const data = await res.json();
  if (!data.ok) die(data.error || `http ${res.status}`);
  for (const l of data.lines || []) console.log(l);
}

async function cmdAudit(n) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const res = await api(cfg, `/${cfg.slug}/audit`);
  const data = await res.json();
  for (const e of (data.events || []).slice(-(Number(n) || 20))) {
    console.log(`${new Date(e.ts).toISOString().slice(11, 19)} ${String(e.result_kind).padEnd(7)} ${e.server}.${e.tool}${e.error ? " — " + e.error : ""}`);
  }
}

async function cmdWatch() {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const res = await api(cfg, `/${cfg.slug}/events`, { headers: { Accept: "text/event-stream" } });
  console.log(`watching ${cfg.url}/${cfg.slug} … (ctrl-c to stop)`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const e = JSON.parse(line.slice(5).trim());
        if (e.server) console.log(`${new Date(e.ts).toISOString().slice(11, 19)} ${String(e.resultKind).padEnd(7)} ${e.server}.${e.tool}`);
      } catch {}
    }
  }
}

async function cmdToken(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const patterns = flag(args, "patterns");
  // re-mint from the current (already attenuated) token
  const res = await api(cfg, `/${cfg.slug}/tokens`, { method: "POST", body: { patterns: patterns ? patterns.split(",") : undefined, label: "minted" } });
  const m = await res.json();
  if (!m.ok) die(m.error);
  console.log(m.token);
  console.error(`scope: ${m.patterns.join(", ")}`);
}

// ── agent subcommands ─────────────────────────────────────────────────────

async function cmdAgent(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0];
  if (sub === "spawn") {
    const name = args[1]; const rest = args.slice(2).join(" ");
    if (!name || !rest) die("usage: sbx agent spawn <name> <cmd>");
    const res = await api(cfg, `/${cfg.slug}/mcp`, { method: "POST", body: { server: "agents", tool: "spawn", args: { name, patterns: ["proc.exec"], cmd: rest } } });
    const d = await res.json();
    if (d.ok) console.log(`spawned ${d.result.id}`); else die(d.error || d.result?.error);
  } else if (sub === "list" || !sub) {
    const res = await api(cfg, `/${cfg.slug}/agents`);
    const d = await res.json();
    for (const a of d.agents ?? []) console.log(`${a.id.slice(0, 8)}  ${String(a.state).padEnd(8)}  ${a.name}  ${a.cmd ?? ""}`);
  } else if (sub === "get") {
    const res = await api(cfg, `/${cfg.slug}/agents/${args[1]}`);
    const d = await res.json();
    if (!d.ok) die(d.error);
    const a = d.agent;
    console.log(`${a.id}\n  state: ${a.state}\n  name:  ${a.name}\n  cmd:   ${a.cmd ?? ""}`);
    if (a.result) console.log("  result:\n" + a.result.split("\n").map((l) => "    " + l).join("\n"));
    if (a.error)  console.log("  error: " + a.error);
  } else if (sub === "kill") {
    const res = await api(cfg, `/${cfg.slug}/agents/${args[1]}`, { method: "DELETE" });
    const d = await res.json();
    console.log(d.ok && d.killed ? "killed" : d.reason ?? d.error ?? "not killed");
  } else {
    die(`unknown agent subcommand: ${sub}`);
  }
}

// ── sandbox subcommands ──────────────────────────────────────────────────

async function cmdSandbox(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0];
  if (sub === "list" || !sub) {
    const res = await api(cfg, "/api/sandboxes");
    const d = await res.json();
    if (!d.ok) die(d.error);
    for (const sb of d.sandboxes ?? []) {
      const marker = sb.slug === cfg.slug ? "*" : " ";
      console.log(`${marker} ${sb.slug.padEnd(24)} ${String(sb.state).padEnd(8)} ${sb.name}`);
    }
  } else if (sub === "create") {
    const slug = args[1];
    if (!slug) die("usage: sbx sandbox create <slug>");
    const res = await api(cfg, "/api/sandboxes", { method: "POST", body: { slug, name: slug } });
    const d = await res.json();
    if (d.ok) console.log(`created: ${d.slug}`); else die(d.error);
  } else if (sub === "wake") {
    const slug = args[1] ?? cfg.slug;
    const res = await api(cfg, `/${slug}/wake`, { method: "POST" });
    const d = await res.json();
    if (d.ok) console.log(`${slug}: ${d.state}`); else die(d.error);
  } else if (sub === "hibernate") {
    const slug = args[1] ?? cfg.slug;
    const res = await api(cfg, `/${slug}/hibernate`, { method: "POST" });
    const d = await res.json();
    if (d.ok) console.log(`${slug}: ${d.state}`); else die(d.error);
  } else if (sub === "delete") {
    const slug = args[1];
    if (!slug) die("usage: sbx sandbox delete <slug>");
    const res = await api(cfg, `/api/sandboxes/${slug}`, { method: "DELETE" });
    const d = await res.json();
    if (d.ok) console.log(`deleted: ${d.deleted}`); else die(d.error);
  } else {
    die(`unknown sandbox subcommand: ${sub}`);
  }
}

// ── app subcommands ───────────────────────────────────────────────────────

async function cmdApp(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0];
  if (sub === "list" || !sub) {
    const res = await api(cfg, `/${cfg.slug}/apps`);
    const d = await res.json();
    for (const a of d.apps ?? []) console.log(`${a.name.padEnd(16)}  ${a.url}  [${(a.patterns ?? []).join(",")}]`);
  } else if (sub === "install") {
    const [, name, url, ...pats] = args;
    if (!name || !url) die("usage: sbx app install <name> <url> [patterns…]");
    const res = await api(cfg, `/${cfg.slug}/mcp`, { method: "POST", body: { server: "apps", tool: "install", args: { name, url, patterns: pats.length ? pats : ["*"] } } });
    const d = await res.json();
    if (d.ok) console.log(`installed ${name}`); else die(d.error || d.result?.error);
  } else {
    die(`unknown app subcommand: ${sub}`);
  }
}

// ── secret subcommands ────────────────────────────────────────────────────

async function cmdSecret(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0];
  if (sub === "list" || !sub) {
    const res = await api(cfg, `/${cfg.slug}/secrets`);
    const d = await res.json();
    if (!d.ok) die(d.error);
    if (!(d.secrets ?? []).length) { console.log("(no secrets)"); return; }
    for (const s of d.secrets) console.log(`${s.name.padEnd(24)} ${s.ref}`);
  } else if (sub === "set") {
    const name = args[1]; const value = args.slice(2).join(" ");
    if (!name || !value) die("usage: sbx secret set <name> <value>");
    const res = await api(cfg, `/${cfg.slug}/secrets`, { method: "POST", body: { name, value } });
    const d = await res.json();
    if (d.ok) console.log(`stored → ${d.ref}`); else die(d.error);
  } else if (sub === "rm" || sub === "remove") {
    const name = args[1];
    if (!name) die("usage: sbx secret rm <name>");
    const res = await api(cfg, `/${cfg.slug}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    const d = await res.json();
    if (d.ok) console.log(d.removed ? "removed" : "not found"); else die(d.error);
  } else if (sub === "use") {
    const name = args[1]; const cmd = args.slice(2).join(" ");
    if (!name || !cmd) die("usage: sbx secret use <name> <cmd>");
    const res = await api(cfg, `/${cfg.slug}/secrets/${encodeURIComponent(name)}/use`, { method: "POST", body: { cmd } });
    const d = await res.json();
    if (!d.ok) die(d.error);
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (d.code && d.code !== 0) process.exitCode = d.code;
  } else {
    die(`unknown secret subcommand: ${sub}`);
  }
}

// ── distro subcommands ────────────────────────────────────────────────────

async function cmdDistro(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0];
  if (sub === "list" || !sub) {
    const res = await api(cfg, "/api/distros");
    const d = await res.json();
    if (!d.ok) die(d.error);
    if (!(d.distros ?? []).length) { console.log("(no distros)"); return; }
    for (const dt of d.distros) console.log(`${dt.name.padEnd(24)} ${dt.description ?? ""}`);
  } else if (sub === "create") {
    const name = args[1];
    if (!name) die("usage: sbx distro create <name> [--from <slug>] [--desc <description>]");
    const fromSlug = flag(args, "from", null);
    const desc = flag(args, "desc", null);
    const res = await api(cfg, "/api/distros", { method: "POST", body: { name, description: desc, slug: fromSlug } });
    const d = await res.json();
    if (d.ok) console.log(`created: ${d.name} (${d.id})`); else die(d.error);
  } else if (sub === "delete" || sub === "rm") {
    const name = args[1];
    if (!name) die("usage: sbx distro delete <name>");
    const res = await api(cfg, `/api/distros/${encodeURIComponent(name)}`, { method: "DELETE" });
    const d = await res.json();
    if (d.ok) console.log(d.deleted ? `deleted: ${name}` : "not found"); else die(d.error);
  } else if (sub === "snapshot") {
    const slug = args[1] ?? cfg.slug;
    const name = args[2];
    if (!name) die("usage: sbx distro snapshot [slug] <name>");
    const res = await api(cfg, `/api/sandboxes/${slug}/snapshot`, { method: "POST", body: { name } });
    const d = await res.json();
    if (d.ok) console.log(`snapshot saved as distro: ${d.name}`); else die(d.error);
  } else {
    die(`unknown distro subcommand: ${sub}`);
  }
}

// ── quota subcommand ──────────────────────────────────────────────────────

async function cmdQuota(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  if (!args[0] || args[0] === "get") {
    const res = await api(cfg, "/api/quota");
    const d = await res.json();
    if (!d.ok) die(d.error);
    const q = d.quota;
    console.log(`max_sandboxes: ${q.max_sandboxes}`);
    console.log(`max_agents:    ${q.max_agents}`);
    console.log(`max_running:   ${q.max_running}`);
    console.log(`mem_mb:        ${q.mem_mb}`);
    console.log(`cpu_shares:    ${q.cpu_shares}`);
  } else if (args[0] === "set") {
    const maxSandboxes = flag(args, "max-sandboxes", null);
    const maxAgents    = flag(args, "max-agents",    null);
    const maxRunning   = flag(args, "max-running",   null);
    const memMb        = flag(args, "mem-mb",        null);
    const cpuShares    = flag(args, "cpu-shares",    null);
    const body = {};
    if (maxSandboxes) body.maxSandboxes = Number(maxSandboxes);
    if (maxAgents)    body.maxAgents    = Number(maxAgents);
    if (maxRunning)   body.maxRunning   = Number(maxRunning);
    if (memMb)        body.memMb        = Number(memMb);
    if (cpuShares)    body.cpuShares    = Number(cpuShares);
    const res = await api(cfg, "/api/quota", { method: "POST", body });
    const d = await res.json();
    if (!d.ok) die(d.error);
    const q = d.quota;
    console.log(`quota updated: max_sandboxes=${q.max_sandboxes} max_agents=${q.max_agents} max_running=${q.max_running} mem_mb=${q.mem_mb} cpu_shares=${q.cpu_shares}`);
  } else {
    die(`unknown quota subcommand: ${args[0]}`);
  }
}

// ── stream subcommand ─────────────────────────────────────────────────────

async function cmdStream(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const cmd = args.join(" ");
  if (!cmd) die("usage: sbx stream <cmd>");
  const res = await api(cfg, `/${cfg.slug}/stream`, { method: "POST", body: { cmd } });
  if (!res.ok) { const d = await res.json(); die(d.error || `http ${res.status}`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === "stdout") process.stdout.write(ev.chunk);
        else if (ev.type === "stderr") process.stderr.write(ev.chunk);
        else if (ev.type === "done" && ev.code !== 0) process.exitCode = ev.code;
      } catch {}
    }
  }
}

// ── backup subcommand ─────────────────────────────────────────────────────

async function cmdBackup(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const outFile = args[0] ?? `sandboxos-backup-${Date.now()}.db`;
  const res = await api(cfg, "/api/admin/backup");
  if (!res.ok) { const d = await res.json(); die(d.error || `http ${res.status}`); }
  const buf = await res.arrayBuffer();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, Buffer.from(buf));
  console.log(`backup saved: ${outFile} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "login": await cmdLogin(args); break;
  case "run": await cmdRun(args.join(" ")); break;
  case "call": await cmdRun(`:call ${args[0]} ${args.slice(1).join(" ") || "{}"}`); break;
  case "audit": await cmdAudit(args[0]); break;
  case "watch": await cmdWatch(); break;
  case "token": await cmdToken(args); break;
  case "agent": await cmdAgent(args); break;
  case "sandbox": await cmdSandbox(args); break;
  case "app": await cmdApp(args); break;
  case "secret": await cmdSecret(args); break;
  case "stream": await cmdStream(args); break;
  case "distro": await cmdDistro(args); break;
  case "quota": await cmdQuota(args); break;
  case "backup": await cmdBackup(args); break;
  case undefined: case "help": case "-h": case "--help":
    console.log("usage: sbx <login|run|call|audit|watch|token|agent|sandbox|app|secret|distro|quota|stream|backup> …");
    console.log("       sbx sandbox <list|create|wake|hibernate|delete> …");
    console.log("       sbx secret  <list|set|rm|use> …");
    console.log("       sbx distro  <list|create|delete|snapshot> …");
    console.log("       sbx quota   [get|set --max-sandboxes N --max-agents N --mem-mb N --cpu-shares N]");
    console.log("       sbx backup  [output-file.db]"); break;
  default: await cmdRun([cmd, ...args].join(" ")); // `sbx ls` == `sbx run "ls"`
}
