// The Registry: typed accessors over the control DB.
//
// This is the control plane's source of truth for tenants, Sandboxes, slugs,
// principals, capability grants, sessions, and the audit log. The Gateway and
// Kernel talk to the Registry, never to raw SQL.

import crypto from "node:crypto";
import { pbkdf2Sync, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { openDb, withTransaction } from "./db.js";
import config from "../../config/src/config.js";
import { canDelegate } from "../../kernel/src/capabilities.js";

const now = () => Date.now();
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

// ---- Tenants & principals -------------------------------------------------

export function createTenant(name) {
  const db = openDb();
  const t = { id: id("ten"), name, created_at: now() };
  db.prepare("INSERT INTO tenants (id,name,created_at) VALUES (?,?,?)").run(t.id, t.name, t.created_at);
  return t;
}

export function getTenantByName(name) {
  return openDb().prepare("SELECT * FROM tenants WHERE name=?").get(name) ?? null;
}

export function createPrincipal(tenantId, kind, name) {
  const db = openDb();
  const p = { id: id("prn"), tenant_id: tenantId, kind, name, created_at: now() };
  db.prepare("INSERT INTO principals (id,tenant_id,kind,name,created_at) VALUES (?,?,?,?,?)")
    .run(p.id, p.tenant_id, p.kind, p.name, p.created_at);
  return p;
}

export function getPrincipal(principalId) {
  return openDb().prepare("SELECT * FROM principals WHERE id=?").get(principalId) ?? null;
}

// ---- Operator authority tier (backlog #1) ---------------------------------
//
// `is_operator` marks host-level operators (host owner / admins). It is a
// separate axis from capability grants: operator-ness is NOT something a
// self-service signup can ever obtain (createAccount never sets it), and it is
// not delegable via machine tokens. Only ensureSeed (the host owner) and an
// explicit setOperator() call elevate a principal.

/** Mark (or clear) a principal as a host operator. */
export function setOperator(principalId, isOp = true) {
  openDb().prepare("UPDATE principals SET is_operator=? WHERE id=?")
    .run(isOp ? 1 : 0, principalId);
}

/** Is this principal a host operator? Returns a boolean (never the raw int). */
export function isOperator(principalId) {
  const row = openDb().prepare("SELECT is_operator FROM principals WHERE id=?").get(principalId);
  return !!(row && row.is_operator);
}

// ---- Sandboxes ------------------------------------------------------------

export function createSandbox(tenantId, { slug, name, cellBackend }) {
  const db = openDb();
  const sid = id("sbx");
  const volume = path.join(config.sandboxesDir, sid, "volume");
  const s = {
    id: sid, tenant_id: tenantId, slug, name,
    cell_backend: cellBackend, volume_path: volume,
    state: "stopped", last_active_at: null, created_at: now(),
  };
  db.prepare(`INSERT INTO sandboxes
      (id,tenant_id,slug,name,cell_backend,volume_path,state,last_active_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(s.id, s.tenant_id, s.slug, s.name, s.cell_backend, s.volume_path, s.state, s.last_active_at, s.created_at);
  return s;
}

export function getSandboxBySlug(slug) {
  return openDb().prepare("SELECT * FROM sandboxes WHERE slug=?").get(slug) ?? null;
}

export function getSandbox(sandboxId) {
  return openDb().prepare("SELECT * FROM sandboxes WHERE id=?").get(sandboxId) ?? null;
}

export function setSandboxState(sandboxId, state) {
  openDb().prepare("UPDATE sandboxes SET state=?, last_active_at=? WHERE id=?")
    .run(state, now(), sandboxId);
}

// ---- Capability grants ----------------------------------------------------

export function grant(principalId, sandboxId, pattern) {
  const db = openDb();
  const g = { id: id("grt"), principal_id: principalId, sandbox_id: sandboxId, pattern, created_at: now() };
  db.prepare("INSERT INTO grants (id,principal_id,sandbox_id,pattern,created_at) VALUES (?,?,?,?,?)")
    .run(g.id, g.principal_id, g.sandbox_id, g.pattern, g.created_at);
  return g;
}

/** All grant patterns a principal holds on a Sandbox. */
export function grantsFor(principalId, sandboxId) {
  return openDb()
    .prepare("SELECT pattern FROM grants WHERE principal_id=? AND sandbox_id=?")
    .all(principalId, sandboxId)
    .map((r) => r.pattern);
}

// ---- Sessions & machine tokens -------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

// Backlog #2: bearer tokens are secrets equivalent to passwords. We persist only
// the sha256 digest of the token (the `token` column is the PK, now holding the
// hex digest), so a leaked DB does not yield usable session/machine tokens. The
// raw token is returned to the caller exactly once at mint time and never stored.
function _tokenDigest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(principalId, kind = "session", ttlMs = 7 * DAY) {
  const db = openDb();
  const token = crypto.randomBytes(24).toString("base64url");
  // Persist the digest, hand back the raw token (caller API unchanged).
  db.prepare("INSERT INTO sessions (token,principal_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(_tokenDigest(token), principalId, kind, now() + ttlMs, now());
  return token;
}

export function resolveSession(token) {
  if (!token) return null;
  // Look up by digest of the presented token — the raw token is never stored.
  const row = openDb().prepare("SELECT * FROM sessions WHERE token=?").get(_tokenDigest(token));
  if (!row) return null;
  if (row.expires_at < now()) return null;
  return row;
}

export function revokeSession(token) {
  openDb().prepare("DELETE FROM sessions WHERE token=?").run(_tokenDigest(token));
}

/**
 * Backlog #2: purge sessions whose TTL has elapsed. The gateway boot loop calls
 * this so expired rows don't accumulate. Returns the number of rows deleted.
 */
export function purgeExpiredSessions() {
  const r = openDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  return r.changes ?? 0;
}

// ---- Audit (append-only, hash-chained) -----------------------------------

// Backlog #5: sensitive arg-key names. Expanded beyond the original
// pass/secret/token/key/authorization to cover the generic envelopes through
// which callers smuggle raw secrets: secrets.put sends the secret under `value`,
// and net.fetch sends bearer creds under headers.authorization. `cmd`, `env`,
// `body`, `data`, `payload`, `password` round out the common leak surfaces.
const SECRET_KEYS = /pass|password|secret|token|key|authorization|value|payload|body|data|env|cmd/i;

// Value-shape detectors: even under an innocuous key, these literal forms are
// credentials and must be scrubbed. Bearer headers, OpenAI-style sk- keys,
// JWTs (three base64url segments), and long base64/hex blobs.
const BEARER_RE = /^Bearer\s/i;
const SK_RE = /^sk-/;
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const BLOB_RE = /^[A-Za-z0-9+/=_-]{41,}$/; // >40 chars of base64url/base64/hex

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;     // recursion cap
const MAX_NODES = 2_000; // total node cap (defends against huge payloads)

/** True if a string literal looks like a credential by shape alone. */
function _looksSecret(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  return BEARER_RE.test(s) || SK_RE.test(s) || JWT_RE.test(s) || BLOB_RE.test(s);
}

/**
 * Backlog #5: deep, value-aware redaction. Recurses into nested objects and
 * arrays (depth/node-capped, cycle-guarded). A field is redacted when its KEY is
 * sensitive OR its scalar VALUE matches a credential shape. The canonical leaks
 * fixed here: secrets.put's raw `value`, and net.fetch's headers.authorization.
 */
function redact(args) {
  const seen = new WeakSet();
  let nodes = 0;

  const walk = (val, depth, keyIsSecret) => {
    // Scalar: redact if the key flagged it, or the value shape betrays a secret.
    if (val === null || typeof val !== "object") {
      if (keyIsSecret && val !== undefined && val !== null) return REDACTED;
      return _looksSecret(val) ? REDACTED : val;
    }
    // From here val is an object/array.
    if (keyIsSecret) return REDACTED; // sensitive key => drop the whole subtree
    if (depth >= MAX_DEPTH) return "[truncated]";
    if (seen.has(val)) return "[cycle]";   // cycle guard
    if (++nodes > MAX_NODES) return "[truncated]";
    seen.add(val);

    if (Array.isArray(val)) {
      return val.map((v) => walk(v, depth + 1, false));
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = walk(v, depth + 1, SECRET_KEYS.test(k));
    }
    return out;
  };

  return walk(args, 0, false);
}

export function appendAudit(ev) {
  const db = openDb();
  const prev = db.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get();
  const prevHash = prev?.hash ?? "";
  const ts = now();
  const argsJson = ev.args === undefined ? null : JSON.stringify(redact(ev.args));
  const payload = JSON.stringify({
    ts, sandbox_id: ev.sandboxId ?? null, principal_id: ev.principalId ?? null,
    on_behalf_of: ev.onBehalfOf ?? null, server: ev.server, tool: ev.tool,
    args: argsJson, result_kind: ev.resultKind, error: ev.error ?? null,
    capability: ev.capability ?? null, prevHash,
  });
  const hash = crypto.createHash("sha256").update(prevHash + payload).digest("hex");
  db.prepare(`INSERT INTO audit
      (ts,sandbox_id,principal_id,on_behalf_of,server,tool,args_json,result_kind,error,capability,prev_hash,hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ts, ev.sandboxId ?? null, ev.principalId ?? null, ev.onBehalfOf ?? null,
      ev.server, ev.tool, argsJson, ev.resultKind, ev.error ?? null, ev.capability ?? null, prevHash, hash);
  return { ts, hash };
}

export function recentAudit(sandboxId, limit = 50) {
  return openDb()
    .prepare("SELECT * FROM audit WHERE sandbox_id=? ORDER BY id DESC LIMIT ?")
    .all(sandboxId, limit)
    .reverse();
}

/**
 * Query the audit log with optional filters. All filter params are optional;
 * omitting them returns unfiltered results up to `limit` (max 500).
 *
 * `cursor` — id of the last seen event for forward pagination (exclusive lower
 * bound on `id`). When provided the query goes forward in ascending order;
 * without it the most-recent N events are returned (also ascending).
 */
export function queryAudit(sandboxId, { server, tool, principalId, resultKind, after, cursor, limit = 50 } = {}) {
  let sql = "SELECT * FROM audit WHERE sandbox_id=?";
  const params = [sandboxId];
  if (server)      { sql += " AND server=?";       params.push(server); }
  if (tool)        { sql += " AND tool=?";         params.push(tool); }
  if (principalId) { sql += " AND principal_id=?"; params.push(principalId); }
  if (resultKind)  { sql += " AND result_kind=?";  params.push(resultKind); }
  if (after != null)  { sql += " AND ts>?"; params.push(after); }
  if (cursor != null) { sql += " AND id>?"; params.push(cursor); }
  const capped = Math.min(Number(limit) || 50, 500);
  if (cursor != null) {
    // Forward pagination: ascend from the cursor.
    sql += " ORDER BY id ASC LIMIT ?";
    params.push(capped);
    return openDb().prepare(sql).all(...params);
  }
  // Default: most-recent N events in ascending order.
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(capped);
  return openDb().prepare(sql).all(...params).reverse();
}

/**
 * Backlog #4: verify the audit hash chain end-to-end. Walks every row in
 * ascending id order, recomputing the hash exactly as appendAudit does
 * (sha256 over the same JSON payload prefixed with prev_hash) and checking both
 * that row.hash matches the recomputed digest and that row.prev_hash equals the
 * prior row's stored hash. Returns the id of the first row that breaks the chain.
 *
 * @returns {{ ok: boolean, count: number, brokenAtId: number|null }}
 */
export function verifyAuditChain() {
  const rows = openDb().prepare("SELECT * FROM audit ORDER BY id ASC").all();
  let prevHash = "";
  for (const row of rows) {
    // The chain link: this row's prev_hash must equal the previous row's hash.
    if ((row.prev_hash ?? "") !== prevHash) {
      return { ok: false, count: rows.length, brokenAtId: row.id };
    }
    // Recompute exactly as appendAudit: payload built from the stored columns,
    // using args_json verbatim (already redacted at write time).
    const payload = JSON.stringify({
      ts: row.ts, sandbox_id: row.sandbox_id ?? null, principal_id: row.principal_id ?? null,
      on_behalf_of: row.on_behalf_of ?? null, server: row.server, tool: row.tool,
      args: row.args_json ?? null, result_kind: row.result_kind, error: row.error ?? null,
      capability: row.capability ?? null, prevHash,
    });
    const expected = crypto.createHash("sha256").update(prevHash + payload).digest("hex");
    if (row.hash !== expected) {
      return { ok: false, count: rows.length, brokenAtId: row.id };
    }
    prevHash = row.hash;
  }
  return { ok: true, count: rows.length, brokenAtId: null };
}

// ---- Machine tokens (attenuating delegation) ------------------------------

/**
 * Mint a machine token scoped to a SUBSET of the minter's capabilities on a
 * Sandbox. Creates a dedicated 'machine' principal carrying the attenuated grants
 * and a bearer session for it. Throws if any requested pattern exceeds the minter's
 * authority (delegation only attenuates — docs/09).
 */
export function mintMachineToken(minterPrincipalId, sandboxId, requestedPatterns, { label = "device", ttlMs = 30 * DAY } = {}) {
  const minter = getPrincipal(minterPrincipalId);
  if (!minter) throw new Error("unknown minter");
  const held = grantsFor(minterPrincipalId, sandboxId);
  const patterns = requestedPatterns?.length ? requestedPatterns : held; // default: mirror the minter
  for (const p of patterns) {
    if (!canDelegate(held, p)) throw new Error(`attenuation: cannot grant '${p}' — not held by minter`);
  }
  const machine = createPrincipal(minter.tenant_id, "machine", `${label}-${crypto.randomUUID().slice(0, 6)}`);
  for (const p of patterns) grant(machine.id, sandboxId, p);
  const token = createSession(machine.id, "machine", ttlMs);
  return { token, principalId: machine.id, patterns };
}

// ---- Sandbox creation (multi-Sandbox per tenant) --------------------------

/** Create a new Sandbox for a tenant and grant the creator full rights on it. */
export function createSandboxForTenant(tenantId, creatorPrincipalId, { slug, name, cellBackend }) {
  if (getSandboxBySlug(slug)) throw new Error(`slug taken: ${slug}`);
  const sandbox = createSandbox(tenantId, { slug, name: name ?? slug, cellBackend });
  grant(creatorPrincipalId, sandbox.id, "*");
  return sandbox;
}

// ---- Phase-3 agents -------------------------------------------------------

export function createAgent(sandboxId, { principalId, spawnedBy, name, patterns, cmd, kind = "shell", prompt = null, systemPrompt = null }) {
  const db = openDb();
  const a = {
    id: id("agt"), sandbox_id: sandboxId, principal_id: principalId,
    spawned_by: spawnedBy, name, patterns: JSON.stringify(patterns),
    cmd, kind, state: "queued", result: null, error: null, exit_code: null,
    prompt, system_prompt: systemPrompt,
    created_at: now(), started_at: null, finished_at: null,
  };
  db.prepare(`INSERT INTO agents
    (id,sandbox_id,principal_id,spawned_by,name,patterns,cmd,kind,state,result,error,exit_code,prompt,system_prompt,created_at,started_at,finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(a.id, a.sandbox_id, a.principal_id, a.spawned_by, a.name, a.patterns, a.cmd,
      a.kind, a.state, a.result, a.error, a.exit_code, a.prompt, a.system_prompt,
      a.created_at, a.started_at, a.finished_at);
  return a;
}

export function getAgent(agentId) {
  return openDb().prepare("SELECT * FROM agents WHERE id=?").get(agentId) ?? null;
}

export function listAgents(sandboxId, limit = 50) {
  return openDb().prepare("SELECT * FROM agents WHERE sandbox_id=? ORDER BY created_at DESC LIMIT ?")
    .all(sandboxId, limit);
}

export function updateAgentState(agentId, state, { result = null, error = null, exitCode = null, startedAt = null, finishedAt = null } = {}) {
  openDb().prepare(
    `UPDATE agents SET state=?,result=coalesce(?,result),error=coalesce(?,error),
     exit_code=coalesce(?,exit_code),started_at=coalesce(?,started_at),finished_at=coalesce(?,finished_at)
     WHERE id=?`
  ).run(state, result, error, exitCode, startedAt, finishedAt, agentId);
}

// ---- Phase-4 distros (named manifest templates) ---------------------------

export function createDistro(tenantId, { name, description, manifest }) {
  const db = openDb();
  const d = { id: id("dtr"), tenant_id: tenantId, name, description: description ?? null, manifest: JSON.stringify(manifest), created_at: now() };
  db.prepare("INSERT INTO distros (id,tenant_id,name,description,manifest,created_at) VALUES (?,?,?,?,?,?)")
    .run(d.id, d.tenant_id, d.name, d.description, d.manifest, d.created_at);
  return { ...d, manifest };
}

export function getDistro(distroId) {
  const row = openDb().prepare("SELECT * FROM distros WHERE id=?").get(distroId);
  return row ? { ...row, manifest: JSON.parse(row.manifest) } : null;
}

export function getDistroByName(tenantId, name) {
  const row = openDb().prepare("SELECT * FROM distros WHERE tenant_id=? AND name=?").get(tenantId, name);
  return row ? { ...row, manifest: JSON.parse(row.manifest) } : null;
}

export function listDistros(tenantId) {
  return openDb().prepare("SELECT id,tenant_id,name,description,created_at FROM distros WHERE tenant_id=? ORDER BY created_at DESC").all(tenantId);
}

export function deleteDistro(tenantId, name) {
  const r = openDb().prepare("DELETE FROM distros WHERE tenant_id=? AND name=?").run(tenantId, name);
  return { deleted: r.changes > 0 };
}

export function sandboxCountForTenant(tenantId) {
  return openDb().prepare("SELECT COUNT(*) as n FROM sandboxes WHERE tenant_id=?").get(tenantId)?.n ?? 0;
}

// ---- Phase-14/15 per-tenant quotas ----------------------------------------

const QUOTA_DEFAULTS = { max_sandboxes: 3, max_agents: 10, max_running: 2, mem_mb: 512, cpu_shares: 1.0 };

/** Return the quota row for a tenant, falling back to defaults if none is set. */
export function getQuota(tenantId) {
  const row = openDb().prepare("SELECT * FROM tenant_quotas WHERE tenant_id=?").get(tenantId);
  return row ?? { tenant_id: tenantId, ...QUOTA_DEFAULTS };
}

/** Upsert per-tenant quota limits. Only provided fields are written. */
export function setQuota(tenantId, { maxSandboxes, maxAgents, maxRunning, memMb, cpuShares } = {}) {
  const current = getQuota(tenantId);
  const vals = {
    max_sandboxes: maxSandboxes ?? current.max_sandboxes,
    max_agents:    maxAgents    ?? current.max_agents,
    max_running:   maxRunning   ?? current.max_running,
    mem_mb:        memMb        ?? current.mem_mb,
    cpu_shares:    cpuShares    ?? current.cpu_shares,
  };
  openDb().prepare(`INSERT OR REPLACE INTO tenant_quotas
    (tenant_id, max_sandboxes, max_agents, max_running, mem_mb, cpu_shares)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tenantId, vals.max_sandboxes, vals.max_agents, vals.max_running, vals.mem_mb, vals.cpu_shares);
  return { tenant_id: tenantId, ...vals };
}

export function getPrimarySandboxForTenant(tenantId) {
  return openDb().prepare("SELECT * FROM sandboxes WHERE tenant_id=? ORDER BY created_at LIMIT 1").get(tenantId) ?? null;
}

export function listSandboxesForTenant(tenantId) {
  return openDb().prepare("SELECT * FROM sandboxes WHERE tenant_id=? ORDER BY created_at").all(tenantId);
}

/**
 * Delete a sandbox and all its associated rows. Does NOT destroy the Cell volume —
 * callers must do that first.
 *
 * Backlog #4: audit rows are NEVER deleted here. The append-only log must outlive
 * the sandbox it describes (sandbox_id is a nullable FK), so a deleted sandbox
 * cannot erase its own history.
 *
 * Backlog #9: all deletes run inside a single transaction (all-or-nothing) and we
 * also clean up the machine principals minted for this sandbox plus their
 * sessions — otherwise those credentials would dangle after the sandbox is gone.
 */
export function deleteSandbox(sandboxId) {
  withTransaction((db) => {
    // Find machine principals that hold grants on THIS sandbox. A machine
    // principal is minted per-sandbox by mintMachineToken; we nonetheless guard
    // against a principal shared across sandboxes by only removing principals
    // whose grants are exclusively on this sandbox. Shared ones keep living (only
    // their grant on this sandbox is dropped below).
    const machinePrincipals = db.prepare(
      `SELECT DISTINCT g.principal_id AS id
         FROM grants g JOIN principals p ON p.id = g.principal_id
        WHERE g.sandbox_id = ? AND p.kind = 'machine'`
    ).all(sandboxId).map((r) => r.id);

    const orphanMachines = machinePrincipals.filter((pid) => {
      const other = db.prepare(
        "SELECT 1 FROM grants WHERE principal_id=? AND sandbox_id<>? LIMIT 1"
      ).get(pid, sandboxId);
      return !other; // no grants elsewhere => safe to remove the principal
    });

    db.prepare("DELETE FROM jobs WHERE sandbox_id=?").run(sandboxId);
    db.prepare("DELETE FROM agents WHERE sandbox_id=?").run(sandboxId);
    db.prepare("DELETE FROM secrets WHERE sandbox_id=?").run(sandboxId);
    db.prepare("DELETE FROM grants WHERE sandbox_id=?").run(sandboxId);
    // NOTE: audit rows are intentionally NOT deleted (backlog #4). sandbox_id FK is nullable.

    // Drop sessions then principals for the machine identities tied solely to this sandbox.
    for (const pid of orphanMachines) {
      db.prepare("DELETE FROM sessions WHERE principal_id=?").run(pid);
      db.prepare("DELETE FROM principals WHERE id=?").run(pid);
    }

    db.prepare("DELETE FROM sandboxes WHERE id=?").run(sandboxId);
  });
}

export function runningAgentCount(sandboxId) {
  return openDb().prepare("SELECT COUNT(*) as n FROM agents WHERE sandbox_id=? AND state IN ('queued','running')").get(sandboxId)?.n ?? 0;
}

export function totalSandboxCount() {
  return openDb().prepare("SELECT COUNT(*) as n FROM sandboxes").get()?.n ?? 0;
}

// ---- Phase-16 running-sandbox count per tenant (for max_running enforcement) --

export function runningCountForTenant(tenantId) {
  return openDb()
    .prepare("SELECT COUNT(*) as n FROM sandboxes WHERE tenant_id=? AND state='running'")
    .get(tenantId)?.n ?? 0;
}

// ---- Phase-16 TAP pool (Firecracker microVM TAP device allocation) ----------
//
// vm_taps rows: { tap_name TEXT PK, sandbox_id TEXT|NULL }
// NULL sandbox_id = free; non-null = allocated to that sandbox.
//
// Callers (FirecrackerBackend) call allocateTap() before starting the VM and
// releaseTap() on destroy(). The pool is seeded lazily from tap0..tapN.

const TAP_POOL_SIZE = Number(process.env.SANDBOXOS_TAP_POOL ?? 8);

function _seedTaps(db) {
  for (let i = 0; i < TAP_POOL_SIZE; i++) {
    db.prepare("INSERT OR IGNORE INTO vm_taps (tap_name, sandbox_id) VALUES (?, NULL)")
      .run(`tap${i}`);
  }
}

/** Allocate a free TAP for a sandbox. Returns the tap_name, or throws if none free. */
export function allocateTap(sandboxId) {
  const db = openDb();
  _seedTaps(db);
  const row = db.prepare("SELECT tap_name FROM vm_taps WHERE sandbox_id IS NULL LIMIT 1").get();
  if (!row) throw new Error(`no free TAP devices (pool size ${TAP_POOL_SIZE}); use SANDBOXOS_TAP_POOL to increase`);
  db.prepare("UPDATE vm_taps SET sandbox_id=? WHERE tap_name=?").run(sandboxId, row.tap_name);
  return row.tap_name;
}

/** Release the TAP previously allocated for sandboxId. */
export function releaseTap(sandboxId) {
  openDb().prepare("UPDATE vm_taps SET sandbox_id=NULL WHERE sandbox_id=?").run(sandboxId);
}

/** Return the TAP currently allocated to sandboxId, or null. */
export function getTapForSandbox(sandboxId) {
  return openDb().prepare("SELECT tap_name FROM vm_taps WHERE sandbox_id=?").get(sandboxId)?.tap_name ?? null;
}

export function tenantAgentStats(tenantId) {
  const db = openDb();
  const rows = db.prepare(
    "SELECT a.state, COUNT(*) as n FROM agents a JOIN sandboxes s ON a.sandbox_id=s.id WHERE s.tenant_id=? GROUP BY a.state"
  ).all(tenantId);
  const out = { total: 0, running: 0, queued: 0, done: 0, failed: 0, killed: 0 };
  for (const r of rows) { out[r.state] = r.n; out.total += r.n; }
  return out;
}

// ---- Phase-4 accounts (self-service signup / per-user auth) ---------------

// Backlog #10: passwords are hashed with scrypt (stdlib, memory-hard) rather than
// the old PBKDF2-10k (cheap to brute-force on GPUs). The stored hash is a
// self-describing string `scrypt$N$r$p$saltHex$hashHex`, so the cost parameters
// travel with the credential and can be raised later without a schema change.
// SCRYPT_N=65536 lands ~110ms per verify on the target host (within 100-250ms).
const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

// Legacy PBKDF2 path, kept only so accounts created before the scrypt migration
// can still log in (their stored hash is bare hex with no `scrypt$` prefix).
function _hashPasswordLegacy(password, salt) {
  return pbkdf2Sync(password, salt, 10_000, 32, "sha256").toString("hex");
}

function _scryptHash(password, saltHex, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
  // maxmem must exceed 128 * N * r bytes; give generous headroom.
  const maxmem = 256 * n * r;
  return scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN, { N: n, r, p, maxmem }).toString("hex");
}

/** Produce the self-describing scrypt hash string for a fresh credential. */
function _hashPassword(password, saltHex) {
  const hashHex = _scryptHash(password, saltHex);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${hashHex}`;
}

export function createAccount(tenantId, { username, password }) {
  const db = openDb();
  const existing = db.prepare("SELECT id FROM accounts WHERE username=?").get(username);
  if (existing) throw new Error(`username taken: ${username}`);
  // Self-service signups are NEVER operators (backlog #1): createPrincipal leaves
  // is_operator at its default 0 and we never elevate here.
  const principal = createPrincipal(tenantId, "human", username);
  const salt = randomBytes(16).toString("hex");
  const hash = _hashPassword(password, salt); // self-describing scrypt$... string
  const acc = { id: id("acc"), principal_id: principal.id, username, salt, hash, created_at: now() };
  db.prepare("INSERT INTO accounts (id,principal_id,username,salt,hash,created_at) VALUES (?,?,?,?,?,?)")
    .run(acc.id, acc.principal_id, acc.username, acc.salt, acc.hash, acc.created_at);
  return { ...acc, principalId: principal.id };
}

export function verifyAccount(username, password) {
  const row = openDb().prepare("SELECT * FROM accounts WHERE username=?").get(username);
  if (!row) return null;

  let candidate; // hex of the recomputed hash
  let stored;    // hex of the stored hash to compare against
  if (typeof row.hash === "string" && row.hash.startsWith("scrypt$")) {
    // Parse `scrypt$N$r$p$saltHex$hashHex` — params travel with the credential.
    const [, nStr, rStr, pStr, saltHex, storedHex] = row.hash.split("$");
    candidate = _scryptHash(password, saltHex, Number(nStr), Number(rStr), Number(pStr));
    stored = storedHex;
  } else {
    // Backward-compat: legacy bare-hex PBKDF2 hash, salted by the `salt` column.
    candidate = _hashPasswordLegacy(password, row.salt);
    stored = row.hash;
  }

  // Constant-time comparison to avoid leaking match position via timing.
  if (typeof stored !== "string" || candidate.length !== stored.length) return null;
  const ok = timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(stored, "hex"));
  return ok ? getPrincipal(row.principal_id) : null;
}

export function getAccountByUsername(username) {
  return openDb().prepare("SELECT * FROM accounts WHERE username=?").get(username) ?? null;
}

// ---- First-boot seed ------------------------------------------------------

/** Idempotently create the seed tenant, human principal, and primary Sandbox. */
export function ensureSeed(cellBackend) {
  let tenant = getTenantByName(config.seed.tenantName);
  if (!tenant) tenant = createTenant(config.seed.tenantName);

  let sandbox = getSandboxBySlug(config.seed.slug);
  let owner;
  if (!sandbox) {
    owner = createPrincipal(tenant.id, "human", `${config.seed.tenantName}-owner`);
    sandbox = createSandbox(tenant.id, {
      slug: config.seed.slug, name: config.seed.sandboxName, cellBackend,
    });
    // The owner can do everything in their own Sandbox (still default-deny for
    // anyone else, and still fully audited — including this grant's use).
    grant(owner.id, sandbox.id, "*");
  } else {
    owner = openDb()
      .prepare("SELECT * FROM principals WHERE tenant_id=? AND kind='human' ORDER BY created_at LIMIT 1")
      .get(tenant.id);
  }
  // Backlog #1: the seed owner is the host operator. Idempotent — re-seeding a
  // running host keeps the flag set. Self-service signups never get this.
  if (owner) {
    setOperator(owner.id, true);
    owner = getPrincipal(owner.id); // reflect is_operator in the returned object
  }
  return { tenant, owner, sandbox };
}
