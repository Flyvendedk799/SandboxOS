// The Gateway — the public front door (control plane).
//
// Resolves slug → Sandbox → wakes the Cell → authenticates → proxies the caller to
// the Sandbox's Kernel. Phase-0 realization of docs/02 + docs/07. Built on Node's
// built-in http (zero deps); the documented target is Fastify/Express.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import config from "../../../packages/config/src/config.js";
import {
  getSandboxBySlug, getPrincipal, grantsFor, resolveSession,
  createSession, revokeSession, ensureSeed, recentAudit, queryAudit,
  mintMachineToken, createSandboxForTenant,
  createAccount, verifyAccount, getPrimarySandboxForTenant,
  createDistro, getDistroByName, listDistros, deleteDistro, sandboxCountForTenant,
  createTenant, totalSandboxCount, tenantAgentStats, getAgent,
  listSandboxesForTenant, deleteSandbox,
  getQuota, setQuota, runningAgentCount, isOperator,
} from "../../../packages/control-db/src/registry.js";
import { authorize } from "../../../packages/kernel/src/capabilities.js";
import { loadManifest } from "../../../packages/manifest/src/manifest.js";

const maxSandboxes = () => Number(process.env.SANDBOXOS_MAX_SANDBOXES ?? 10);
import { getKernel, _dropKernel } from "../../../packages/kernel/src/kernel.js";
import { getCell } from "../../../packages/cell/src/cell.js";
import { runCommand } from "../../../packages/command-central/src/console.js";
import { Scheduler } from "../../../packages/scheduler/src/scheduler.js";
import { upgradeWebSocket } from "../../../packages/pty/src/index.js";

/** The host's single Cell Scheduler (wake/hibernate/budget). Exported for the
 *  Gateway's background loops (idle reaper + cron tick) in index.js. */
export const scheduler = new Scheduler({
  maxRunning: Number(process.env.SANDBOXOS_MAX_RUNNING ?? 4),
  idleMs: Number(process.env.SANDBOXOS_IDLE_MS ?? 10 * 60 * 1000),
});

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const cellBackend = () => (config.cellBackend === "local" ? "local" : "docker");

// Backlog #7: the 'local' Cell backend runs commands directly on the host with no
// isolation. When SANDBOXOS_REQUIRE_ISOLATION=1 (production multi-tenant posture)
// the gateway must refuse to create/serve a Cell on the local backend. Default off
// so the zero-dependency dev/test experience (which runs on local) is unchanged.
const requireIsolation = () => process.env.SANDBOXOS_REQUIRE_ISOLATION === "1";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const RESERVED = new Set(["", "login", "logout", "signup", "health", "api", "static", "favicon.ico"]);

// ---- small http helpers ---------------------------------------------------

const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
function sendFile(res, file) {
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve the calling principal from the session cookie, a Bearer token, or ?token= query param. */
function authenticate(req) {
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const query  = new URL(req.url, "http://localhost").searchParams.get("token") ?? "";
  const token  = bearer || query || cookies(req).sbx_session;
  const session = resolveSession(token);
  return session ? getPrincipal(session.principal_id) : null;
}

/** Backlog #1: a host-operator authority check. Privileged, host-wide endpoints
 *  (full-DB backup, cross-tenant administration) require an operator principal —
 *  a plain logged-in tenant (every self-service signup) is NOT one. */
function requireOperator(principal) {
  return !!principal && isOperator(principal.id);
}

// ---- auth rate limiting (backlog #10) -------------------------------------
// Per-IP sliding window on /login + /signup to blunt online credential stuffing
// and signup abuse on the single shared host. In-process map, same shape as the
// net.fetch limiter. Default 10 attempts / 60s; tune via SANDBOXOS_AUTH_RATE.
const AUTH_RATE = Number(process.env.SANDBOXOS_AUTH_RATE ?? 10);
const AUTH_WINDOW_MS = 60_000;
const _authHits = new Map(); // ip -> number[]
function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) || req.socket?.remoteAddress || "unknown";
}
function authRateLimited(req) {
  if (!AUTH_RATE || AUTH_RATE <= 0) return false;
  const ip = clientIp(req);
  const tnow = Date.now();
  const hits = (_authHits.get(ip) ?? []).filter((t) => tnow - t < AUTH_WINDOW_MS);
  if (hits.length >= AUTH_RATE) { _authHits.set(ip, hits); return true; }
  hits.push(tnow);
  _authHits.set(ip, hits);
  return false;
}

// ---- the request router ---------------------------------------------------

// Subdomain routing: if SANDBOXOS_DOMAIN is set and the Host header looks like
// "{slug}.{domain}", rewrite top to that slug so the rest of the handler works
// identically to path-based routing.
const SANDBOXOS_DOMAIN = process.env.SANDBOXOS_DOMAIN ?? "";
function extractSubdomainSlug(req) {
  if (!SANDBOXOS_DOMAIN) return null;
  const host = (req.headers.host ?? "").split(":")[0];
  const suffix = `.${SANDBOXOS_DOMAIN}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    if (sub && SLUG_RE.test(sub)) return sub;
  }
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const segments = url.pathname.split("/").map(decodeURIComponent);

  // Subdomain slug rewrites path: "alice.example.com/exec" → top="alice", action="exec"
  const subSlug = extractSubdomainSlug(req);
  if (subSlug) {
    segments.splice(1, 0, subSlug); // insert slug at position 1
  }

  const top = segments[1] ?? "";

  // Static assets.
  if (top === "static") return sendFile(res, path.join(PUBLIC, ...segments.slice(2)));
  if (top === "favicon.ico") return sendFile(res, path.join(PUBLIC, "favicon.svg"));

  // Auth endpoints. Rate-limited per-IP (backlog #10) before any credential work.
  if ((top === "login" || top === "signup") && req.method === "POST" && authRateLimited(req)) {
    return sendJson(res, 429, { ok: false, error: "too many attempts, slow down" });
  }
  if (top === "login" && req.method === "POST") {
    const { password, username } = await readBody(req);
    // Username+password login (Phase 4 accounts).
    if (username) {
      const principal = verifyAccount(username, password ?? "");
      if (!principal) return sendJson(res, 401, { ok: false, error: "invalid username or password" });
      const sb = getPrimarySandboxForTenant(principal.tenant_id);
      if (!sb) return sendJson(res, 500, { ok: false, error: "no sandbox for account" });
      const token = createSession(principal.id, "session");
      res.setHeader("Set-Cookie", `sbx_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return sendJson(res, 200, { ok: true, slug: sb.slug, username });
    }
    // Legacy single-password login.
    if (password !== config.password) return sendJson(res, 401, { ok: false, error: "wrong password" });
    const { owner, sandbox } = ensureSeed(config.cellBackend === "local" ? "local" : config.cellBackend);
    const token = createSession(owner.id, "session");
    res.setHeader("Set-Cookie", `sbx_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    return sendJson(res, 200, { ok: true, slug: sandbox.slug });
  }
  if (top === "logout" && req.method === "POST") {
    revokeSession(cookies(req).sbx_session);
    res.setHeader("Set-Cookie", "sbx_session=; HttpOnly; Path=/; Max-Age=0");
    return sendJson(res, 200, { ok: true });
  }

  // Self-service signup: create a new tenant + sandbox for a new user.
  if (top === "signup" && req.method === "POST") {
    const { username, password } = await readBody(req);
    if (!username || !password || username.length < 2 || password.length < 8)
      return sendJson(res, 400, { ok: false, error: "username (min 2 chars) and password (min 8 chars) required" });
    const slug = username.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 32);
    if (RESERVED.has(slug) || !SLUG_RE.test(slug))
      return sendJson(res, 400, { ok: false, error: "username produces an invalid slug" });
    try {
      const tenant = createTenant(username);
      const acc = createAccount(tenant.id, { username, password });
      const sandbox = createSandboxForTenant(tenant.id, acc.principalId, { slug, name: `${username}'s Sandbox`, cellBackend: cellBackend() });
      const token = createSession(acc.principalId, "session");
      res.setHeader("Set-Cookie", `sbx_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return sendJson(res, 200, { ok: true, slug: sandbox.slug, username });
    } catch (e) {
      return sendJson(res, 409, { ok: false, error: e.message });
    }
  }

  // Health check (no auth required). Surfaces the Cell backend (backlog #7) so an
  // operator can SEE whether Cells run with real isolation or on the unisolated
  // 'local' backend, and whether isolation is being enforced.
  if (top === "health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      sandboxes: totalSandboxCount(),
      tunnel: !!process.env.SANDBOXOS_TUNNEL_TOKEN,
      cellBackend: cellBackend(),
      isolationEnforced: requireIsolation(),
    });
  }

  // API: tenant stats (auth required).
  if (top === "api" && segments[2] === "stats") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    return sendJson(res, 200, {
      ok: true,
      tenant: { id: principal.tenant_id, name: principal.name },
      sandboxes: sandboxCountForTenant(principal.tenant_id),
      agents: tenantAgentStats(principal.tenant_id),
      quota: { maxSandboxes: maxSandboxes(), maxAgents: Number(process.env.SANDBOXOS_MAX_AGENTS ?? 10) },
    });
  }

  // API: per-tenant quota — read current limits or update them.
  if (top === "api" && segments[2] === "quota") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, quota: getQuota(principal.tenant_id) });
    }
    if (req.method === "POST") {
      const { tenantId, maxSandboxes, maxAgents, maxRunning, memMb, cpuShares } = await readBody(req);
      // Backlog #1 (IDOR fix): a caller may only write its OWN tenant's quota.
      // Administering ANY OTHER tenant's quota (the attacker-supplied tenantId
      // path — e.g. setting a victim's max_running to 0) requires operator authority.
      const targetTenant = tenantId ?? principal.tenant_id;
      if (targetTenant !== principal.tenant_id && !requireOperator(principal)) {
        return sendJson(res, 403, { ok: false, error: "operator authority required to modify another tenant's quota" });
      }
      const updated = setQuota(targetTenant, { maxSandboxes, maxAgents, maxRunning, memMb, cpuShares });
      return sendJson(res, 200, { ok: true, quota: updated });
    }
  }

  // API: control-DB backup — streams the raw SQLite file. Backlog #1: this is a
  // host-wide operator action (it exfiltrates EVERY tenant's data), so it is
  // gated behind operator authority — never reachable by a self-service signup.
  // GET /api/admin/backup → application/octet-stream
  if (top === "api" && segments[2] === "admin" && segments[3] === "backup" && req.method === "GET") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    if (!requireOperator(principal)) return sendJson(res, 403, { ok: false, error: "operator authority required" });
    const dbPath = config.dbPath;
    if (!fs.existsSync(dbPath)) return sendJson(res, 404, { ok: false, error: "database file not found" });
    const stat = fs.statSync(dbPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="sandboxos-${Date.now()}.db"`,
      "Content-Length": String(stat.size),
    });
    fs.createReadStream(dbPath).pipe(res);
    return;
  }

  // API: who am I?
  if (top === "api" && segments[2] === "me") {
    const principal = authenticate(req);
    const { sandbox } = ensureSeed(cellBackend());
    return sendJson(res, 200, { authenticated: !!principal, slug: principal ? sandbox.slug : null });
  }

  // API: list all Sandboxes for the authenticated tenant.
  if (top === "api" && segments[2] === "sandboxes" && req.method === "GET" && !segments[3]) {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    const sandboxes = listSandboxesForTenant(principal.tenant_id).map((sb) => ({
      id: sb.id, slug: sb.slug, name: sb.name,
      cell_backend: sb.cell_backend,
      state: scheduler.isRunning(sb.id) ? "running" : sb.state,
      last_active_at: sb.last_active_at, created_at: sb.created_at,
    }));
    return sendJson(res, 200, { ok: true, sandboxes });
  }

  // API: delete a Sandbox — hibernate + destroy cell + remove from DB.
  if (top === "api" && segments[2] === "sandboxes" && segments[3] && req.method === "DELETE") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    const sb = getSandboxBySlug(segments[3]);
    if (!sb || sb.tenant_id !== principal.tenant_id)
      return sendJson(res, 404, { ok: false, error: "sandbox not found" });
    if (sandboxCountForTenant(principal.tenant_id) <= 1)
      return sendJson(res, 409, { ok: false, error: "cannot delete the last sandbox" });
    if (scheduler.isRunning(sb.id)) await scheduler.hibernate(sb);
    try { await getCell(sb).destroy(); } catch {}
    _dropKernel(sb.id);
    deleteSandbox(sb.id);
    return sendJson(res, 200, { ok: true, deleted: sb.slug });
  }

  // API: create a new Sandbox (optionally from a distro template).
  if (top === "api" && segments[2] === "sandboxes" && req.method === "POST" && !segments[3]) {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    const { slug: newSlug, name, distro: distroName } = await readBody(req);
    if (!SLUG_RE.test(newSlug ?? "") || RESERVED.has(newSlug)) return sendJson(res, 400, { ok: false, error: "invalid slug" });
    // Backlog #7: fail safe — never create a Cell on the unisolated local backend
    // when isolation is required (production multi-tenant posture).
    if (requireIsolation() && cellBackend() === "local")
      return sendJson(res, 503, { ok: false, error: "isolation required: local Cell backend is disabled (install Docker)" });
    const sbQuota = getQuota(principal.tenant_id);
    // Effective limit: lower of per-tenant quota and the system-wide env cap.
    const effectiveMaxSb = Math.min(sbQuota.max_sandboxes, maxSandboxes());
    if (sandboxCountForTenant(principal.tenant_id) >= effectiveMaxSb)
      return sendJson(res, 429, { ok: false, error: `sandbox quota exceeded (max ${effectiveMaxSb})` });
    try {
      const sb = createSandboxForTenant(principal.tenant_id, principal.id, { slug: newSlug, name, cellBackend: cellBackend() });
      if (distroName) {
        const distro = getDistroByName(principal.tenant_id, distroName);
        if (distro) {
          const { saveManifest } = await import("../../../packages/manifest/src/manifest.js");
          saveManifest(sb, distro.manifest);
        }
      }
      return sendJson(res, 200, { ok: true, slug: sb.slug });
    } catch (e) {
      return sendJson(res, 409, { ok: false, error: e.message });
    }
  }

  // API: distros — list, create, and delete named manifest templates.
  if (top === "api" && segments[2] === "distros") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    if (req.method === "GET" && !segments[3]) {
      return sendJson(res, 200, { ok: true, distros: listDistros(principal.tenant_id) });
    }
    if (req.method === "POST" && !segments[3]) {
      const { name, description, slug: fromSlug } = await readBody(req);
      if (!name) return sendJson(res, 400, { ok: false, error: "name required" });
      const sourceSb = fromSlug ? getSandboxBySlug(fromSlug) : ensureSeed(cellBackend()).sandbox;
      if (!sourceSb || sourceSb.tenant_id !== principal.tenant_id) return sendJson(res, 404, { ok: false, error: "sandbox not found" });
      const manifest = loadManifest(sourceSb);
      try {
        const distro = createDistro(principal.tenant_id, { name, description, manifest });
        return sendJson(res, 200, { ok: true, id: distro.id, name: distro.name });
      } catch (e) {
        return sendJson(res, 409, { ok: false, error: e.message });
      }
    }
    if (req.method === "DELETE" && segments[3]) {
      const result = deleteDistro(principal.tenant_id, segments[3]);
      return sendJson(res, 200, { ok: true, ...result });
    }
  }

  // API: snapshot — create a distro from an existing sandbox's current manifest.
  if (top === "api" && segments[2] === "sandboxes" && segments[3] && segments[4] === "snapshot" && req.method === "POST") {
    const principal = authenticate(req);
    if (!principal) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    const snapshotSb = getSandboxBySlug(segments[3]);
    if (!snapshotSb || snapshotSb.tenant_id !== principal.tenant_id)
      return sendJson(res, 404, { ok: false, error: "sandbox not found" });
    const { name, description } = await readBody(req);
    if (!name) return sendJson(res, 400, { ok: false, error: "name required" });
    const manifest = loadManifest(snapshotSb);
    try {
      const distro = createDistro(principal.tenant_id, { name, description, manifest });
      return sendJson(res, 200, { ok: true, id: distro.id, name: distro.name });
    } catch (e) {
      return sendJson(res, 409, { ok: false, error: e.message });
    }
  }

  // Root: send to the primary slug if logged in, else the login page.
  if (top === "") {
    const principal = authenticate(req);
    if (principal) {
      const { sandbox } = ensureSeed(config.cellBackend === "local" ? "local" : config.cellBackend);
      res.writeHead(302, { Location: `/${sandbox.slug}` });
      return res.end();
    }
    return sendFile(res, path.join(PUBLIC, "login.html"));
  }

  // Everything else: a slug.
  if (RESERVED.has(top)) return sendJson(res, 404, { ok: false, error: "not found" });
  const slug = top;
  const action = segments[2] ?? "";

  const sandbox = getSandboxBySlug(slug);
  if (!sandbox) return sendJson(res, 404, { ok: false, error: `no sandbox: ${slug}` });

  // AuthN + AuthZ: must be logged in AND hold at least one grant on this Sandbox.
  const principal = authenticate(req);
  if (!principal) {
    if (action) return sendJson(res, 401, { ok: false, error: "not authenticated" });
    res.writeHead(302, { Location: "/" });
    return res.end();
  }
  const held = grantsFor(principal.id, sandbox.id);
  if (held.length === 0) return sendJson(res, 403, { ok: false, error: "not authorized for this sandbox" });

  // GET /:slug — wake the Cell (through the Scheduler) and serve the desktop.
  if (!action && req.method === "GET") {
    scheduler.wake(sandbox, getQuota(principal.tenant_id)).catch(() => {});
    return sendFile(res, path.join(PUBLIC, "sandbox.html"));
  }

  // POST /:slug/tokens — mint an attenuated machine token (for sbx / agents / CI).
  if (action === "tokens" && req.method === "POST") {
    const { patterns, label } = await readBody(req);
    try {
      const minted = mintMachineToken(principal.id, sandbox.id, patterns, { label: label ?? "device" });
      return sendJson(res, 200, { ok: true, token: minted.token, patterns: minted.patterns });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // POST /:slug/wake — explicitly wake (boot) the Cell.
  if (action === "wake" && req.method === "POST") {
    const result = await scheduler.wake(sandbox, getQuota(principal.tenant_id));
    return sendJson(res, 200, { ok: true, ...result });
  }

  // POST /:slug/hibernate — explicitly hibernate (stop) the Cell.
  if (action === "hibernate" && req.method === "POST") {
    if (!scheduler.isRunning(sandbox.id))
      return sendJson(res, 200, { ok: true, state: "stopped", evicted: null });
    const result = await scheduler.hibernate(sandbox);
    return sendJson(res, 200, { ok: true, ...result });
  }

  const kernel = await getKernel(sandbox);

  // POST /:slug/exec — run one Command Central line.
  if (action === "exec" && req.method === "POST") {
    scheduler.touch(sandbox.id);
    const { line } = await readBody(req);
    const result = await runCommand({ kernel, principalId: principal.id, heldPatterns: held, line: line ?? "" });
    return sendJson(res, 200, { ok: true, ...result });
  }

  // POST /:slug/exec-stream — streaming SSE version of exec.
  // Shell commands stream stdout/stderr in real-time; all other verbs (MCP, NL,
  // shortcuts) emit result lines as 'line' events and then a 'done' event.
  if (action === "exec-stream" && req.method === "POST") {
    scheduler.touch(sandbox.id);
    const { line } = await readBody(req);
    if (!line) return sendJson(res, 400, { ok: false, error: "line required" });

    // Detect raw shell commands: anything that isn't a known verb or special prefix.
    const VERBS = new Set([
      "ls", "cat", "stat", "write", "ps", "whoami", "servers", "enable", "disable",
      "fetch", "secrets", "secret", "pkg", "agent", "agents", "llm", "help", "clear",
    ]);
    const firstToken = line.trim().split(/\s+/)[0];
    const isShell = !VERBS.has(firstToken) && !firstToken.startsWith(":");

    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (isShell && !line.trim().startsWith("?")) {
      // Raw shell command: check proc.exec cap and stream.
      if (!authorize(held, "proc", "exec")) {
        send({ type: "error", text: "denied: proc.exec" });
        send({ type: "done", code: 1 });
        res.end();
        return;
      }
      const proc = kernel.cell.execStream(line.trim(), (ev) => {
        if (ev.type === "stdout") send({ type: "stdout", chunk: ev.chunk });
        else if (ev.type === "stderr") send({ type: "stderr", chunk: ev.chunk });
        else if (ev.type === "done") { send({ type: "done", code: ev.code }); res.end(); }
      });
      req.on("close", () => proc?.kill?.());
      return;
    }

    // Verb, :call, NL, etc.: run synchronously, then emit as line events.
    const result = await runCommand({ kernel, principalId: principal.id, heldPatterns: held, line });
    if (result.clear) {
      send({ type: "clear" });
    } else if (result.proposed) {
      send({ type: "proposed", hint: result.lines?.[0] ?? "", proposed: result.proposed });
    } else {
      for (const text of result.lines ?? []) send({ type: "line", text });
    }
    send({ type: "done", code: 0 });
    res.end();
    return;
  }

  // POST /:slug/mcp — one raw MCP call (authorized + audited). The programmatic
  // surface the Tide daemon and external agents drive.
  if (action === "mcp" && req.method === "POST") {
    scheduler.touch(sandbox.id);
    const { server: mcpSrv, tool: mcpTool, args } = await readBody(req);
    // Agent spawn quota: check before delegating to the kernel.
    if (mcpSrv === "agents" && mcpTool === "spawn") {
      const agentQuota = getQuota(principal.tenant_id);
      if (runningAgentCount(sandbox.id) >= agentQuota.max_agents)
        return sendJson(res, 429, { ok: false, error: `agent quota exceeded (max ${agentQuota.max_agents})` });
    }
    const result = await kernel.call({ principalId: principal.id, heldPatterns: held, server: mcpSrv, tool: mcpTool, args: args ?? {} });
    return sendJson(res, 200, result);
  }

  // GET /:slug/events — SSE stream of live audit events.
  if (action === "events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ slug, state: sandbox.state })}\n\n`);
    const onAudit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    kernel.events.on("audit", onAudit);
    const keepalive = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { kernel.events.off("audit", onAudit); clearInterval(keepalive); });
    return;
  }

  // GET /:slug/audit — query the audit log with optional filters.
  // Query params: ?server=fs  ?tool=write  ?kind=ok|error|denied
  //               ?principal=prn_xxx  ?after=<epoch-ms>  ?limit=N (max 500)
  //               ?cursor=<last-event-id>  (forward pagination; returns nextCursor)
  if (action === "audit" && req.method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(p.has("limit") ? Number(p.get("limit")) : 50, 500);
    const events = queryAudit(sandbox.id, {
      server:      p.get("server")    || undefined,
      tool:        p.get("tool")      || undefined,
      principalId: p.get("principal") || undefined,
      resultKind:  p.get("kind")      || undefined,
      after:       p.has("after")  ? Number(p.get("after"))  : undefined,
      cursor:      p.has("cursor") ? Number(p.get("cursor")) : undefined,
      limit,
    });
    const nextCursor = events.length > 0 && events.length === limit
      ? events[events.length - 1].id
      : null;
    return sendJson(res, 200, { ok: true, events, nextCursor });
  }

  // POST /:slug/stream — SSE streaming exec.
  if (action === "stream" && req.method === "POST") {
    scheduler.touch(sandbox.id);
    const { cmd } = await readBody(req);
    if (!cmd) return sendJson(res, 400, { ok: false, error: "cmd required" });
    if (!authorize(held, "proc", "exec")) return sendJson(res, 403, { ok: false, error: "denied: proc.exec" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const proc = kernel.cell.execStream(cmd, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === "done") res.end();
    });
    req.on("close", () => proc?.kill?.());
    return;
  }

  // GET /:slug/agents/:id/events — SSE stream of one agent's audit events.
  if (action === "agents" && segments[3] && segments[4] === "events" && req.method === "GET") {
    const agent = getAgent(segments[3]);
    if (!agent || agent.sandbox_id !== sandbox.id) return sendJson(res, 404, { ok: false, error: "no such agent" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ agentId: agent.id, state: agent.state })}\n\n`);
    const onAudit = (ev) => {
      if (ev.principal_id === agent.principal_id || ev.on_behalf_of === agent.spawned_by) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };
    kernel.events.on("audit", onAudit);
    req.on("close", () => kernel.events.off("audit", onAudit));
    return;
  }

  // GET /:slug/agents — list agents.
  if (action === "agents" && req.method === "GET" && !segments[3]) {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "agents", tool: "list", args: {} });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, agents: r.result.agents } : { ok: false, error: r.error });
  }

  // GET /:slug/agents/:id — agent detail.
  if (action === "agents" && req.method === "GET" && segments[3]) {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "agents", tool: "get", args: { id: segments[3] } });
    return sendJson(res, r.ok ? 200 : 404, r.ok ? { ok: true, agent: r.result } : { ok: false, error: r.error });
  }

  // DELETE /:slug/agents/:id — kill an agent.
  if (action === "agents" && req.method === "DELETE" && segments[3]) {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "agents", tool: "kill", args: { id: segments[3] } });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error });
  }

  // GET /:slug/secrets — list secret names + refs (never values).
  if (action === "secrets" && req.method === "GET" && !segments[3]) {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "secrets", tool: "list", args: {} });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, secrets: r.result.secrets } : { ok: false, error: r.error });
  }

  // POST /:slug/secrets — store a secret; value is never returned.
  if (action === "secrets" && req.method === "POST" && !segments[3]) {
    const { name, value } = await readBody(req);
    if (!name || value == null) return sendJson(res, 400, { ok: false, error: "name and value required" });
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "secrets", tool: "put", args: { name, value } });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, ref: r.result.ref } : { ok: false, error: r.error });
  }

  // DELETE /:slug/secrets/:name — remove a secret.
  if (action === "secrets" && segments[3] && req.method === "DELETE") {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "secrets", tool: "remove", args: { name: segments[3] } });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error });
  }

  // POST /:slug/secrets/:name/use — run a command with a named secret injected as env.
  // The secret value never appears in the response; only stdout/stderr/code are returned.
  if (action === "secrets" && segments[3] && segments[4] === "use" && req.method === "POST") {
    const { cmd, timeoutMs } = await readBody(req);
    if (!cmd) return sendJson(res, 400, { ok: false, error: "cmd required" });
    const r = await kernel.call({
      principalId: principal.id, heldPatterns: held,
      server: "secrets", tool: "useInEnv",
      args: { refs: [`secret://${segments[3]}`], cmd, ...(timeoutMs != null ? { timeoutMs } : {}) },
    });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error });
  }

  // GET /:slug/apps — list installed apps.
  if (action === "apps" && req.method === "GET") {
    const r = await kernel.call({ principalId: principal.id, heldPatterns: held, server: "apps", tool: "list", args: {} });
    return sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, apps: r.result.apps } : { ok: false, error: r.error });
  }

  // POST /:slug/propose — NL translate, return proposed command without executing.
  if (action === "propose" && req.method === "POST") {
    const { line } = await readBody(req);
    if (!line) return sendJson(res, 400, { ok: false, error: "line required" });
    const nlLine = line.startsWith("?") ? line : `? ${line}`;
    const result = await runCommand({ kernel, principalId: principal.id, heldPatterns: held, line: nlLine });
    if (!result.proposed) return sendJson(res, 503, { ok: false, error: "NL unavailable — enable llm server and set ANTHROPIC_API_KEY" });
    return sendJson(res, 200, { ok: true, proposed: result.proposed });
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
}

// ── WebSocket PTY handler ────────────────────────────────────────────────────

async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname.split("/").map(decodeURIComponent);
  const slug   = segments[1] ?? "";
  const action = segments[2] ?? "";

  if (action !== "pty") { socket.destroy(); return; }

  const sandbox = getSandboxBySlug(slug);
  if (!sandbox) { socket.destroy(); return; }

  const principal = authenticate(req);
  if (!principal) { socket.destroy(); return; }

  const held = grantsFor(principal.id, sandbox.id);
  if (!held.length || !authorize(held, "proc", "exec")) { socket.destroy(); return; }

  const ws = upgradeWebSocket(req, socket, head);
  if (!ws) return;

  const kernel = await getKernel(sandbox);
  scheduler.wake(sandbox, getQuota(principal.tenant_id)).catch(() => {});

  const shell = await kernel.cell.execInteractive(
    (data) => ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    () => ws.close(),
    { cols: 80, rows: 24 },
  );

  ws.on("message", (buf) => {
    // Control frames: SOH (0x01) prefix + JSON body.
    if (buf[0] === 0x01) {
      try {
        const ctrl = JSON.parse(buf.slice(1).toString("utf8"));
        if (ctrl.type === "resize") shell.resize(ctrl.cols || 80, ctrl.rows || 24);
      } catch {}
      return;
    }
    shell.write(buf);
  });

  ws.on("close", () => shell.kill());
}

export function createServer() {
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message ?? "internal error" });
      else res.end();
    });
  });
  srv.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  return srv;
}
