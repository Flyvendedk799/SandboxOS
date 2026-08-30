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

// ── os subcommands ────────────────────────────────────────────────────────
// The desktop is a document, so the terminal can drive it like anything else:
// open a window on your machine from a script, restyle it from CI, or package
// the whole thing as a distro without touching a browser.

async function cmdOs(args) {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in");
  const sub = args[0] ?? "show";

  const desktop = async (tool, toolArgs = {}) => {
    const res = await api(cfg, `/${cfg.slug}/mcp`, {
      method: "POST", body: { server: "desktop", tool, args: toolArgs },
    });
    const d = await res.json();
    if (!d.ok) die(d.error || `desktop.${tool} failed`);
    return d.result;
  };

  switch (sub) {
    case "show": {
      const s = await desktop("get");
      const d = s.doc;
      console.log(`${d.name}  r${d.rev}  ${d.theme.base} · ${d.animation.preset} · ${d.wm.mode}`);
      console.log(`workspaces ${d.workspaces.length} · windows ${d.windows.length} · widgets ${d.widgets.length} · custom apps ${Object.keys(d.apps).length}`);
      for (const w of d.windows) {
        console.log(`  ${w.id.padEnd(16)} ${w.app.padEnd(12)} ws${w.ws} ${w.x},${w.y} ${w.w}x${w.h}${w.min ? " (min)" : ""}`);
      }
      break;
    }
    case "open": {
      if (!args[1]) die("usage: sbx os open <app>");
      const r = await desktop("open", { app: args[1] });
      console.log(`opened ${r.window.app} as ${r.window.id}`);
      break;
    }
    case "close":
      if (!args[1]) die("usage: sbx os close <window-id>");
      await desktop("close", { id: args[1] });
      console.log("closed");
      break;
    case "widget":
      if (!args[1]) die("usage: sbx os widget <kind>");
      console.log(`placed ${(await desktop("widgetAdd", { kind: args[1] })).widget.id}`);
      break;
    case "theme": {
      if (!args[1]) {
        for (const t of (await desktop("themeList")).themes) console.log(`${t.key.padEnd(12)} ${t.name}${t.builtin ? "" : "  (custom)"}`);
        break;
      }
      console.log(`theme → ${(await desktop("themeSet", { theme: args[1] })).theme.name}`);
      break;
    }
    case "motion":
      if (!args[1]) die("usage: sbx os motion <preset>");
      console.log(`motion → ${(await desktop("animationSet", { preset: args[1] })).animation.name}`);
      break;
    case "layout":
      if (!args[1]) die("usage: sbx os layout <floating|tiling>");
      await desktop("layoutSet", { mode: args[1] });
      console.log(`layout → ${args[1]}`);
      break;
    case "snap": {
      if (!args[1] || !args[2]) die("usage: sbx os snap <window-id> <left|right|full|topleft|…> [WxH]");
      const [vw, vh] = String(args[3] ?? "1440x900").split("x").map(Number);
      const r = await desktop("snap", { id: args[1], region: args[2], viewport: { w: vw, h: vh } });
      console.log(`${r.window.x},${r.window.y} ${r.window.w}x${r.window.h}`);
      break;
    }
    case "assoc": {
      if (!args[1]) {
        const d = (await desktop("state")).doc;
        for (const [ext, app] of Object.entries(d.shell.associations ?? {})) console.log(`${ext.padEnd(12)} ${app}`);
        break;
      }
      const r = await desktop("associate", { ext: args[1], app: args[2] ?? null });
      console.log(args[2] ? `${args[1]} → ${args[2]}` : `${args[1]} cleared`);
      void r;
      break;
    }
    case "apps":
      for (const a of (await desktop("appList")).apps) {
        console.log(`${a.id.padEnd(16)} ${a.kind.padEnd(8)} ${a.name}${a.permissions?.length ? `  [${a.permissions.join(",")}]` : ""}`);
      }
      break;
    case "history":
      for (const rev of (await desktop("history")).revisions) {
        console.log(`r${String(rev.rev).padEnd(5)} ${new Date(rev.ts).toISOString()}  ${rev.label}`);
      }
      break;
    case "revert":
      if (!args[1]) die("usage: sbx os revert <rev>");
      console.log(`now at r${(await desktop("revert", { rev: Number(args[1]) })).rev}`);
      break;
    case "publish": {
      if (!args[1]) die("usage: sbx os publish <name>");
      const r = await desktop("distroPublish", { name: args[1], replace: true });
      console.log(`published ${r.name} (${r.apps} custom apps)`);
      break;
    }
    case "fork":
      if (!args[1]) die("usage: sbx os fork <distro>");
      await desktop("distroFork", { id: args[1] });
      console.log(`forked ${args[1]}`);
      break;
    case "export":
      console.log(JSON.stringify((await desktop("distroExport")).payload, null, 2));
      break;
    case "notify":
      if (!args[1]) die('usage: sbx os notify "<title>" ["<body>"]');
      await desktop("notify", { title: args[1], body: args[2] ?? "", app: "sbx" });
      console.log("sent");
      break;
    default:
      die(`unknown os subcommand: ${sub}`);
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

// ── fs subcommands ────────────────────────────────────────────────────────
// The MCP surface moves file content as JSON; `get`/`put` use the streaming
// endpoints instead so a binary of any size round-trips byte for byte.

async function mcp(cfg, server, tool, args = {}) {
  const res = await api(cfg, `/${cfg.slug}/mcp`, { method: "POST", body: { server, tool, args } });
  const d = await res.json();
  if (!d.ok) die(d.error ?? `${server}.${tool} failed`);
  return d.result;
}

function requireLogin() {
  const cfg = loadConfig();
  if (!cfg.token) die("not logged in — run `sbx login`");
  return cfg;
}

const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function cmdFs(args) {
  const cfg = requireLogin();
  const sub = args[0];

  if (sub === "ls" || !sub) {
    const r = await mcp(cfg, "fs", "list", { path: args[1] ?? "." });
    for (const e of r.entries) {
      console.log(`${e.type === "dir" ? "d" : "-"} ${human(e.size).padStart(9)}  ${e.name}${e.type === "dir" ? "/" : ""}`);
    }
    return;
  }
  if (sub === "cat") {
    if (!args[1]) die("usage: sbx fs cat <path>");
    process.stdout.write((await mcp(cfg, "fs", "read", { path: args[1] })).content ?? "");
    return;
  }
  if (sub === "tree") {
    const r = await mcp(cfg, "fs", "tree", { path: args[1] ?? ".", depth: Number(flag(args, "depth", 3)) });
    const walk = (nodes, prefix) => nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      console.log(`${prefix}${last ? "└─ " : "├─ "}${n.name}${n.type === "dir" ? "/" : ""}`);
      if (n.children?.length) walk(n.children, prefix + (last ? "   " : "│  "));
    });
    walk(r.tree, "");
    if (r.truncated) console.log(`… truncated at ${r.nodes} nodes`);
    return;
  }
  if (sub === "grep") {
    if (!args[1]) die('usage: sbx fs grep <query> [path] [--include "*.js"]');
    const r = await mcp(cfg, "fs", "search", {
      query: args[1],
      path: args[2] && !args[2].startsWith("--") ? args[2] : ".",
      include: flag(args, "include"),
      regex: args.includes("--regex"),
    });
    for (const m of r.matches) console.log(`${m.path}:${m.line}  ${m.text.trim()}`);
    console.error(`— ${r.matches.length} match${r.matches.length === 1 ? "" : "es"} in ${r.scanned} file${r.scanned === 1 ? "" : "s"}`);
    return;
  }
  if (sub === "mkdir") {
    if (!args[1]) die("usage: sbx fs mkdir <path>");
    await mcp(cfg, "fs", "mkdir", { path: args[1] });
    console.log(`created ${args[1]}/`);
    return;
  }
  if (sub === "rm") {
    if (!args[1]) die("usage: sbx fs rm <path> [-r]");
    const r = await mcp(cfg, "fs", "remove", { path: args[1], recursive: args.includes("-r") || args.includes("--recursive") });
    console.log(r.removed ? `removed ${r.path}` : `not found: ${r.path}`);
    return;
  }
  if (sub === "get") {
    const remote = args[1];
    if (!remote) die("usage: sbx fs get <remote> [local]");
    const local = args[2] ?? path.basename(remote);
    const res = await api(cfg, `/${cfg.slug}/file?path=${encodeURIComponent(remote)}`);
    if (!res.ok) die((await res.json().catch(() => ({}))).error ?? `http ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (local === "-") process.stdout.write(buf);
    else { fs.writeFileSync(local, buf); console.log(`${remote} → ${local} (${human(buf.length)})`); }
    return;
  }
  if (sub === "put") {
    const local = args[1];
    if (!local) die("usage: sbx fs put <local> [remote]");
    const remote = args[2] ?? path.basename(local);
    const body = fs.readFileSync(local);
    const res = await fetch(`${cfg.url}/${cfg.slug}/file?path=${encodeURIComponent(remote)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${cfg.token}` }, body,
    });
    const d = await res.json();
    if (!d.ok) die(d.error);
    console.log(`${local} → ${remote} (${human(d.bytes)})`);
    return;
  }
  die(`unknown fs subcommand: ${sub}`);
}

// ── proc subcommands ──────────────────────────────────────────────────────
// Supervised background processes: the thing you want when a command must
// outlive the request that started it.

async function cmdProc(args) {
  const cfg = requireLogin();
  const sub = args[0];

  if (sub === "list" || !sub) {
    const r = await mcp(cfg, "proc", "jobs", {});
    if (!r.jobs.length) { console.log("(no background processes)"); return; }
    for (const j of r.jobs) {
      console.log(`${j.id}  ${String(j.state).padEnd(8)} ${String(j.name).padEnd(14)} ${j.lines} lines  ${j.cmd}`);
    }
    return;
  }
  if (sub === "start") {
    const cmd = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
    if (!cmd) die('usage: sbx proc start "<cmd>" [--name NAME]');
    const r = await mcp(cfg, "proc", "start", { cmd, name: flag(args, "name") });
    console.log(`${r.id}  ${r.state}  ${r.name}  (pid ${r.pid ?? "?"})`);
    return;
  }
  if (sub === "logs") {
    const id = args[1];
    if (!id) die("usage: sbx proc logs <id> [--follow]");
    const follow = args.includes("--follow") || args.includes("-f");
    let since = 0;
    for (;;) {
      const r = await mcp(cfg, "proc", "logs", { id, tail: 500, ...(since ? { since } : {}) });
      for (const l of r.logs) {
        (l.stream === "stderr" ? process.stderr : process.stdout).write(`${l.text}\n`);
        since = Math.max(since, l.ts);
      }
      if (!follow || r.state !== "running") return;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  if (sub === "stop") {
    if (!args[1]) die("usage: sbx proc stop <id>");
    const r = await mcp(cfg, "proc", "stop", { id: args[1] });
    console.log(r.stopped ? `stopped ${r.id}` : `not stopped: ${r.reason}`);
    return;
  }
  die(`unknown proc subcommand: ${sub}`);
}

// ── port subcommands ──────────────────────────────────────────────────────

async function cmdPort(args) {
  const cfg = requireLogin();
  const sub = args[0];

  if (sub === "list" || !sub) {
    const r = await mcp(cfg, "ports", "list", {});
    if (!r.ports.length) { console.log("(no exposed ports)"); return; }
    for (const p of r.ports) {
      console.log(`${String(p.port).padEnd(6)} ${p.up ? "up  " : "down"}  ${String(p.name).padEnd(12)} ${cfg.url}${p.path}`);
    }
    return;
  }
  if (sub === "expose" || sub === "open") {
    const port = Number(args[1]);
    if (!port) die("usage: sbx port expose <port> [name]");
    const r = await mcp(cfg, "ports", "expose", { port, name: args[2] });
    console.log(`${cfg.url}${r.path}`);
    return;
  }
  if (sub === "close" || sub === "unexpose") {
    const port = Number(args[1]);
    if (!port) die("usage: sbx port close <port>");
    const r = await mcp(cfg, "ports", "unexpose", { port });
    console.log(r.removed ? `closed :${r.port}` : `:${r.port} was not exposed`);
    return;
  }
  if (sub === "scan") {
    const r = await mcp(cfg, "ports", "scan", {});
    if (!r.listening.length) { console.log("(nothing is listening inside the Cell)"); return; }
    for (const p of r.listening) console.log(`${String(p.port).padEnd(6)} ${p.exposed ? "exposed" : "not exposed"}`);
    return;
  }
  die(`unknown port subcommand: ${sub}`);
}

// ── ask: the assistant, streamed to your terminal ─────────────────────────

async function cmdAsk(args) {
  const cfg = requireLogin();
  const question = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!question) die('usage: sbx ask "<question>"');

  const chatId = flag(args, "chat") ?? (await (async () => {
    const res = await api(cfg, `/${cfg.slug}/chats`, { method: "POST", body: {} });
    const d = await res.json();
    if (!d.ok) die(d.error);
    return d.chat.id;
  })());

  const res = await api(cfg, `/${cfg.slug}/chats/${chatId}/send`, { method: "POST", body: { input: question } });
  if (!res.ok) die((await res.json().catch(() => ({}))).error ?? `http ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawText = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "text") { process.stdout.write(ev.text); sawText = true; }
      else if (ev.type === "tool_call") {
        if (sawText) { process.stdout.write("\n"); sawText = false; }
        process.stderr.write(`  → ${ev.server}.${ev.tool} ${JSON.stringify(ev.args).slice(0, 120)}\n`);
      } else if (ev.type === "tool_result" && !ev.ok) {
        process.stderr.write(`  ✗ ${ev.error}\n`);
      } else if (ev.type === "error") {
        process.stderr.write(`\nsbx: ${ev.error}\n`);
        process.exitCode = 1;
      } else if (ev.type === "stopped") {
        process.stderr.write(`\n(stopped: ${ev.reason})\n`);
      }
    }
  }
  process.stdout.write("\n");
  console.error(`chat: ${chatId}  (continue with --chat ${chatId})`);
}

// ── access subcommands ────────────────────────────────────────────────────

async function cmdAccess(args) {
  const cfg = requireLogin();
  const sub = args[0];

  if (sub === "list" || !sub) {
    const res = await api(cfg, `/${cfg.slug}/access`);
    const d = await res.json();
    if (!d.ok) die(d.error);
    for (const a of d.access) {
      const who = a.username ?? a.name;
      console.log(`${who.padEnd(24)} ${String(a.kind).padEnd(8)} ${a.patterns.join(", ")}`);
    }
    return;
  }
  if (sub === "share") {
    const username = args[1];
    if (!username) die("usage: sbx access share <username> [--patterns fs.read,proc.list]");
    const patterns = flag(args, "patterns");
    const res = await api(cfg, `/${cfg.slug}/access`, {
      method: "POST",
      body: { username, patterns: patterns ? patterns.split(",").map((p) => p.trim()) : undefined },
    });
    const d = await res.json();
    if (!d.ok) die(d.error);
    console.log(`${username}: ${d.patterns.join(", ")}${d.added.length ? "" : " (already shared)"}`);
    return;
  }
  if (sub === "revoke") {
    const who = args[1];
    if (!who) die("usage: sbx access revoke <username|principalId>");
    const listed = await (await api(cfg, `/${cfg.slug}/access`)).json();
    const match = (listed.access ?? []).find((a) => a.username === who || a.principalId === who || a.name === who);
    if (!match) die(`no access entry for: ${who}`);
    const res = await api(cfg, `/${cfg.slug}/access/${match.principalId}`, { method: "DELETE" });
    const d = await res.json();
    if (!d.ok) die(d.error);
    console.log(`revoked ${who} (${d.removed} grant${d.removed === 1 ? "" : "s"}${d.tokensRevoked ? `, ${d.tokensRevoked} token${d.tokensRevoked === 1 ? "" : "s"}` : ""})`);
    return;
  }
  die(`unknown access subcommand: ${sub}`);
}

// ── metrics subcommand ────────────────────────────────────────────────────

async function cmdMetrics() {
  const cfg = requireLogin();
  const s = await mcp(cfg, "metrics", "snapshot", {});
  const line = (k, v) => console.log(`${k.padEnd(14)} ${v}`);
  line("sandbox", `${s.sandbox.slug} (${s.sandbox.state})`);
  line("cell", s.cell.backend);
  line("load", s.load ? s.load.map((n) => n.toFixed(2)).join("  ") : "—");
  line("memory", s.memory?.used != null ? `${human(s.memory.used)} of ${human(s.memory.total)}` : "—");
  line("disk", s.disk.bytes != null ? `${human(s.disk.bytes)} in ${s.disk.files} files` : "—");
  line("processes", s.processes ?? "—");
  line("servers", s.servers.join(", "));
  line("tools", s.tools);
  line("ports", s.ports.length ? s.ports.join(", ") : "none");
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

const HELP = `sbx — drive a SandboxOS machine from anywhere.

  connect     login [--url URL] [--slug SLUG] [--patterns a,b]
              token [--patterns a,b]              mint a narrower token
              sandbox <list|create|wake|hibernate|delete>

  work        run "<line>"                        one Command Central line
              <anything else>                     shorthand for run
              call <server.tool> '<json>'         raw MCP call
              stream "<cmd>"                      run a command, streaming output
              ask "<question>" [--chat ID]        the assistant, with live tool calls

  files       fs ls [path] · fs cat <path> · fs tree [path] [--depth N]
              fs grep <query> [path] [--include "*.js"] [--regex]
              fs mkdir <path> · fs rm <path> [-r]
              fs get <remote> [local] · fs put <local> [remote]

  processes   proc list · proc start "<cmd>" [--name N] · proc logs <id> [-f] · proc stop <id>
  ports       port list · port expose <port> [name] · port close <port> · port scan
  agents      agent <list|spawn|get|kill> …

  desktop     os show · os open <app> · os close <id> · os widget <kind>
              os theme [key] · os motion <preset> · os layout <floating|tiling>
              os snap <id> <region> [WxH] · os assoc [.ext] [app]
              os apps · os history · os revert <rev>
              os publish <name> · os fork <distro> · os export · os notify "<title>"

  state       secret <list|set|rm|use> · app <list|install> · distro <list|create|delete|snapshot>
  observe     metrics · audit [n] · watch
  admin       access <list|share|revoke> · quota [get|set …] · backup [file.db]

Config lives in ~/.sbx/config.json (override with SBX_CONFIG).`;

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
  case "os": await cmdOs(args); break;
  case "secret": await cmdSecret(args); break;
  case "stream": await cmdStream(args); break;
  case "distro": await cmdDistro(args); break;
  case "quota": await cmdQuota(args); break;
  case "backup": await cmdBackup(args); break;
  case "fs": await cmdFs(args); break;
  case "proc": await cmdProc(args); break;
  case "port": await cmdPort(args); break;
  case "ask": await cmdAsk(args); break;
  case "access": await cmdAccess(args); break;
  case "metrics": await cmdMetrics(); break;
  case undefined: case "help": case "-h": case "--help":
    console.log(HELP); break;
  default: await cmdRun([cmd, ...args].join(" ")); // `sbx ls` == `sbx run "ls"`
}
