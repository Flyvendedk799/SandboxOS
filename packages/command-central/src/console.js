// Command Central — the verb map.
//
// Turns a console line into Kernel (MCP) calls. Three modes from docs/06:
//   • shell verbs   — fs/secrets/net/pkg/registry/kernel verbs map to MCP tools;
//                     anything else falls through to proc.exec inside the Cell
//   • raw MCP       — ":call <server.tool> {json}", ":tools/:capabilities/:audit"
//   • natural lang  — recognized but not enabled until Phase 3
//
// Every path bottoms out in kernel.call(), so every command is authorized + audited.

import { recentAudit } from "../../control-db/src/registry.js";

const HELP = `SandboxOS · Command Central
  files          ls [path] · cat <path> · stat <path> · write <path> <text>
                 mkdir <path> · rm <path> [-r] · mv <a> <b> · cp <a> <b>
                 tree [path] [depth] · grep <query> [path]
  processes      ps · <anything else> runs in the Sandbox shell (proc.exec)
  background     run "<cmd>" [name] · jobs · logs <id> [n] · stop <id>
  ports          ports · port expose <n> [name] · port close <n> · port scan
  secrets        secret put <name> <value> · secrets · secret rm <name>
  network        fetch <url>                          (egress-policy gated)
  packages       pkg install <name> · pkg list · pkg remove <name>
  servers        servers · enable <name> · disable <name>   (MCP-manages-MCP)
  agents         agent spawn <name> "<cmd>" [--patterns=a.b,c.*] · agents · agent get <id> · agent kill <id>
  ai             llm "<prompt>" [model]
  self           whoami · :capabilities · :audit [n]
  raw MCP        :tools · :call <server.tool> {json}
  natural lang   ? <what you want to do>              (needs llm server + provider key)
  meta           help · clear`;

function fmtAudit(a) {
  return `${new Date(a.ts).toISOString().slice(11, 19)} ${a.result_kind.padEnd(7)} ${a.server}.${a.tool}${a.error ? " — " + a.error : ""}`;
}

/** Format a Kernel result into terminal text lines. */
function formatResult(server, tool, res) {
  if (!res.ok) return [`✗ ${res.error}`];
  const r = res.result;
  const key = `${server}.${tool}`;
  switch (key) {
    case "fs.list":
      return r.entries.length ? r.entries.map((e) => `${e.type === "dir" ? "📁" : "  "} ${e.name}${e.type === "dir" ? "/" : ""}`) : [`(empty) ${r.path}`];
    case "fs.read": return (r.content ?? "").split("\n");
    case "fs.write": return [`wrote ${r.bytes} bytes → ${r.path}`];
    case "fs.stat": return [`${r.type} ${r.size}B ${r.path}`];
    case "fs.mkdir": return [`created ${r.path}/`];
    case "fs.remove": return [r.removed ? `removed ${r.path}` : `(not found) ${r.path}`];
    case "fs.move": return [`${r.from} → ${r.to}`];
    case "fs.copy": return [`${r.from} ⇒ ${r.to}`];
    case "fs.append": return [`appended ${r.bytes} bytes → ${r.path}`];
    case "fs.tree": {
      const out = [];
      const walk = (nodes, prefix) => {
        nodes.forEach((n, i) => {
          const last = i === nodes.length - 1;
          out.push(`${prefix}${last ? "└─ " : "├─ "}${n.name}${n.type === "dir" ? "/" : ""}`);
          if (n.children?.length) walk(n.children, prefix + (last ? "   " : "│  "));
        });
      };
      walk(r.tree, "");
      if (r.truncated) out.push(`… truncated at ${r.nodes} nodes`);
      return out.length ? out : [`(empty) ${r.path}`];
    }
    case "fs.search":
      return r.matches.length
        ? [...r.matches.map((m) => `${m.path}:${m.line}  ${m.text.trim()}`),
           `— ${r.matches.length} match${r.matches.length === 1 ? "" : "es"} in ${r.scanned} file${r.scanned === 1 ? "" : "s"}${r.truncated ? " (truncated)" : ""}`]
        : [`(no matches for "${r.query}")`];
    case "fs.readBytes": return [`${r.bytes} bytes (base64, ${r.base64.length} chars)`];
    case "fs.writeBytes": return [`wrote ${r.bytes} bytes → ${r.path}`];
    case "proc.start": return [`${r.id}  ${r.state}  ${r.name}  (pid ${r.pid ?? "?"})`, `  tail it with: logs ${r.id}`];
    case "proc.jobs": return r.jobs.length
      ? r.jobs.map((j) => `${j.id}  ${j.state.padEnd(8)}  ${j.name.padEnd(14)}  ${j.lines} lines  ${j.cmd}`)
      : ["(no background processes)"];
    case "proc.logs": return r.logs.length
      ? r.logs.map((l) => (l.stream === "stderr" ? `stderr: ${l.text}` : l.text))
      : [`(no output yet — ${r.state})`];
    case "proc.stop": return [r.stopped ? `stopped ${r.id}` : `not stopped: ${r.reason}`];
    case "proc.forget": return [r.forgotten ? `forgot ${r.id}` : "(not found)"];
    case "proc.signal": return [`sent SIG${r.signal} to ${r.pid}${r.code === 0 ? "" : ` (exit ${r.code})`}`];
    case "ports.expose": return [`exposed :${r.port} → ${r.path}`];
    case "ports.unexpose": return [r.removed ? `closed :${r.port}` : `(:${r.port} was not exposed)`];
    case "ports.list": return r.ports.length
      ? r.ports.map((p) => `${String(p.port).padEnd(6)} ${p.up === null ? "?" : p.up ? "●" : "○"}  ${p.name.padEnd(12)} ${p.path}`)
      : ["(no exposed ports — try: port expose 3000 web)"];
    case "ports.check": return [`:${r.port} is ${r.up ? "up" : "down"}${r.error ? ` (${r.error})` : ""}`];
    case "ports.scan": return r.listening.length
      ? r.listening.map((p) => `${String(p.port).padEnd(6)} ${p.exposed ? "exposed" : "not exposed"}`)
      : ["(nothing is listening inside the Cell)"];
    case "proc.list": return (r.processes ?? "").split("\n");
    case "proc.exec": {
      const out = [];
      if (r.stdout) out.push(...r.stdout.replace(/\n$/, "").split("\n"));
      if (r.stderr) out.push(...r.stderr.replace(/\n$/, "").split("\n").map((l) => `stderr: ${l}`));
      if (r.code !== 0) out.push(`(exit ${r.code})`);
      return out.length ? out : ["(no output)"];
    }
    case "secrets.put": return [`stored → ${r.ref}`];
    case "secrets.list": return r.secrets.length ? r.secrets.map((s) => `• ${s.name}  ${s.ref}`) : ["(no secrets)"];
    case "secrets.remove": return [r.removed ? "removed" : "(not found)"];
    case "net.fetch": return [`HTTP ${r.status}${r.ok ? "" : " (error)"}`, ...String(r.body).split("\n").slice(0, 40)];
    case "pkg.install": case "pkg.remove": return [`${r.name}: exit ${r.code}`, ...(r.stderr || "").split("\n").filter(Boolean).slice(0, 8)];
    case "pkg.list": return r.packages.slice(0, 200);
    case "mcp-registry.list": return [`enabled:   ${r.enabled.join(", ")}`, `available: ${r.available.join(", ")}`];
    case "mcp-registry.enable": case "mcp-registry.disable": return [`enabled: ${r.enabled.join(", ")}`];
    case "kernel.whoami": return [`${r.name} (${r.kind}) — tenant ${r.tenant}, sandbox ${r.sandbox}`];
    case "kernel.capabilities": return r.capabilities.length ? r.capabilities.map((p) => `• ${p}`) : ["(no capabilities)"];
    case "agents.spawn": return [`agent ${r.id}  state:queued  patterns: ${r.patterns.join(", ")}`];
    case "agents.list": return r.agents.length
      ? r.agents.map((a) => `${a.id.slice(0, 8)}  ${a.state.padEnd(8)}  ${a.name}  ${a.cmd}`)
      : ["(no agents)"];
    case "agents.get": {
      const a = r;
      const lines = [`${a.id}  ${a.state}  ${a.name}`, `  cmd: ${a.cmd}`];
      if (a.result) lines.push(...a.result.split("\n").map((l) => `  ${l}`));
      if (a.error) lines.push(`  err: ${a.error}`);
      return lines;
    }
    case "agents.kill": return [r.killed ? "killed" : `not killed: ${r.reason}`];
    case "llm.complete": return r.content.split("\n");
    case "llm.models": return [`models: ${r.models.join(", ")}`, `key: ${r.configured ? "set" : "not set"}`];
    default: return JSON.stringify(r, null, 2).split("\n");
  }
}

/** Split a command line into tokens honoring simple double-quotes. */
function tokenize(line) {
  const m = line.match(/"[^"]*"|\S+/g) ?? [];
  return m.map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
}

/**
 * Parse the positional + flag tokens of an `agent spawn` line.
 *
 * SECURITY (backlog #8 — least-privilege agent spawn): a shell agent only
 * needs `proc.exec` to run its command, so that is the default grant. Wider
 * capabilities are opt-in via an explicit `--patterns=a.b,c.*` (or bare
 * `patterns=…`) token placed anywhere among the spawn args; the token is
 * consumed and the comma-separated list becomes the requested grant. We do NOT
 * widen the default here — mintMachineToken attenuates the request against the
 * spawner, so an explicit list can only narrow what the operator already holds.
 *
 * @returns {{ patterns: string[], rest: string[] }} requested patterns + the
 *          remaining positional tokens (name, then cmd words).
 */
function parseSpawnPatterns(args) {
  const positional = [];
  let patterns = null;
  for (const tok of args) {
    const m = tok.match(/^--?patterns=(.*)$/);
    if (m) {
      // Split on commas, trim, drop empties — an explicit (possibly empty) list.
      patterns = m[1].split(",").map((p) => p.trim()).filter(Boolean);
      continue;
    }
    positional.push(tok);
  }
  // Narrow default: the minimum a shell command needs is proc.exec.
  return { patterns: patterns ?? ["proc.exec"], rest: positional };
}

/** Map a tokenized shell line to (server, tool, args). */
function mapVerb(text, head, rest) {
  switch (head) {
    case "ls": return ["fs", "list", { path: rest[0] ?? "." }];
    case "cat": return ["fs", "read", { path: rest[0] }];
    case "stat": return ["fs", "stat", { path: rest[0] }];
    case "write": return ["fs", "write", { path: rest[0], content: rest.slice(1).join(" ") }];
    case "ps": return ["proc", "list", {}];
    case "mkdir": return ["fs", "mkdir", { path: rest[0] }];
    case "rm": {
      const recursive = rest.some((t) => t === "-r" || t === "-rf" || t === "-fr" || t === "--recursive");
      const target = rest.find((t) => !t.startsWith("-"));
      return ["fs", "remove", { path: target, recursive }];
    }
    case "mv": return ["fs", "move", { from: rest[0], to: rest[1] }];
    case "cp": return ["fs", "copy", { from: rest[0], to: rest[1] }];
    case "tree": return ["fs", "tree", { path: rest[0] ?? ".", depth: Number(rest[1]) || 3 }];
    case "grep": return ["fs", "search", { query: rest[0], path: rest[1] ?? "." }];
    case "run": return ["proc", "start", { cmd: rest[0], name: rest[1] }];
    case "jobs": return ["proc", "jobs", {}];
    case "logs": return ["proc", "logs", { id: rest[0], tail: Number(rest[1]) || 200 }];
    case "stop": return ["proc", "stop", { id: rest[0] }];
    case "ports": return ["ports", "list", {}];
    case "port":
      if (rest[0] === "expose" || rest[0] === "open") return ["ports", "expose", { port: Number(rest[1]), name: rest[2] }];
      if (rest[0] === "close" || rest[0] === "unexpose") return ["ports", "unexpose", { port: Number(rest[1]) }];
      if (rest[0] === "scan") return ["ports", "scan", {}];
      if (rest[0] === "check") return ["ports", "check", { port: Number(rest[1]) }];
      return ["ports", "list", {}];
    case "whoami": return ["kernel", "whoami", {}];
    case "servers": return ["mcp-registry", "list", {}];
    case "enable": return ["mcp-registry", "enable", { server: rest[0] }];
    case "disable": return ["mcp-registry", "disable", { server: rest[0] }];
    case "fetch": return ["net", "fetch", { url: rest[0] }];
    case "secrets": return ["secrets", "list", {}];
    case "secret":
      if (rest[0] === "put") return ["secrets", "put", { name: rest[1], value: rest.slice(2).join(" ") }];
      if (rest[0] === "rm" || rest[0] === "remove") return ["secrets", "remove", { name: rest[1] }];
      return ["secrets", "list", {}];
    case "pkg":
      if (rest[0] === "install") return ["pkg", "install", { name: rest[1] }];
      if (rest[0] === "remove" || rest[0] === "rm") return ["pkg", "remove", { name: rest[1] }];
      return ["pkg", "list", {}];
    case "agent":
    case "agents":
      if (rest[0] === "spawn" || head === "agent" && rest[0] !== "get" && rest[0] !== "kill" && rest[0] !== "list" && rest.length >= 2) {
        // SECURITY (backlog #8 — least-privilege agent spawn): drop the old
        // hardcoded ['fs.*','proc.exec'] grant. A shell agent only needs
        // 'proc.exec' to run its command, so default to exactly that and make
        // any wider grant an explicit opt-in. Operators widen via an optional
        // `--patterns=a.b,c.*` token (consumed wherever it appears in the line);
        // mintMachineToken still attenuates against the spawner, so this can
        // only narrow — never escalate. The granted patterns are echoed in the
        // spawn output so an over-grant is visible at the console.
        // Strip a leading literal "spawn" keyword (present in `agent spawn …`
        // and `agents spawn …`, absent in the `agent <name> <cmd>` shorthand)
        // so the remaining tokens are name + cmd + optional flags.
        const spawnArgs = rest[0] === "spawn" ? rest.slice(1) : rest;
        const { patterns, rest: posArgs } = parseSpawnPatterns(spawnArgs);
        const name = posArgs[0];
        const cmd = posArgs.slice(1).join(" ");
        return ["agents", "spawn", { name, patterns, cmd }];
      }
      if (rest[0] === "get") return ["agents", "get", { id: rest[1] }];
      if (rest[0] === "kill") return ["agents", "kill", { id: rest[1] }];
      return ["agents", "list", {}];
    case "llm": return ["llm", "complete", { prompt: rest.join(" "), model: rest.at(-1)?.startsWith("claude-") ? rest.at(-1) : undefined }];
    default: return ["proc", "exec", { cmd: text }]; // fall through to the shell
  }
}

/**
 * Execute one console line.
 * @returns {Promise<{lines:string[], clear?:boolean}>}
 */
export async function runCommand({ kernel, principalId, heldPatterns, line }) {
  const text = line.trim();
  if (!text) return { lines: [] };

  // ---- meta ----
  if (text === "help" || text === ":help") return { lines: HELP.split("\n") };
  if (text === "clear") return { lines: [], clear: true };
  if (text === ":tools") return { lines: kernel.listTools().map((t) => `${t.name.padEnd(22)} ${t.description}`) };
  if (text === ":capabilities") return { lines: heldPatterns.length ? heldPatterns.map((p) => `• ${p}`) : ["(no capabilities)"] };
  if (text.startsWith(":audit")) {
    const n = Number(text.split(/\s+/)[1]) || 20;
    const rows = recentAudit(kernel.sandbox.id, n);
    return { lines: rows.length ? rows.map(fmtAudit) : ["(no audit events yet)"] };
  }
  if (text.startsWith(":call")) {
    const rest = text.slice(5).trim();
    const sp = rest.indexOf(" ");
    const targetTok = sp === -1 ? rest : rest.slice(0, sp);
    const jsonTok = sp === -1 ? "{}" : rest.slice(sp + 1);
    const [server, tool] = targetTok.split(".");
    if (!server || !tool) return { lines: ["usage: :call <server.tool> {json}"] };
    let args;
    try { args = JSON.parse(jsonTok || "{}"); } catch { return { lines: ["✗ invalid JSON args"] }; }
    const res = await kernel.call({ principalId, heldPatterns, server, tool, args });
    return { lines: formatResult(server, tool, res) };
  }

  // ---- natural language (Phase 3: routes through llm.complete) ----
  if (text.startsWith("?") || text.startsWith("nl ")) {
    const utterance = text.startsWith("?") ? text.slice(1).trim() : text.slice(3).trim();
    const system = `You are Command Central, the shell for SandboxOS. Translate the user's intent into a single Command Central line. Available verbs: ls [path], cat <path>, write <path> <content>, stat <path>, ps, whoami, servers, enable <name>, disable <name>, fetch <url>, secret put <name> <value>, secrets, pkg install/remove/list <name>, agent spawn <name> "<cmd>", agents, agent get <id>, agent kill <id>, llm "<prompt>". Reply with ONLY the command line, nothing else.`;
    const res = await kernel.call({ principalId, heldPatterns, server: "llm", tool: "complete", args: { prompt: utterance, system } });
    if (!res.ok) return { lines: [`✗ NL mode needs the llm server enabled and a provider API key set in Profile. (${res.error})`] };
    const proposed = res.result.content.trim();
    return { lines: [`  ↳ ${proposed}`], proposed };
  }

  // ---- shell verbs ----
  const [head, ...rest] = tokenize(text);
  const [server, tool, args] = mapVerb(text, head, rest);
  const res = await kernel.call({ principalId, heldPatterns, server, tool, args });
  return { lines: formatResult(server, tool, res) };
}

export { HELP };
