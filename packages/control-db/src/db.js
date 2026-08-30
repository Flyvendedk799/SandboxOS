// Control-plane database (the "one brain" for the host).
//
// Phase-0 note: we use Node's built-in `node:sqlite` (zero native dependency,
// runs out of the box on Node 22.13+ and every release since). The documented
// production target is better-sqlite3 v11 — the API is near-identical
// (prepare/run/get/all), so the swap is mechanical. See docs/11-tech-stack.md.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import config from "../../config/src/config.js";
import { MIN_NODE } from "../../config/src/node-compat.js";

const require = createRequire(import.meta.url);

// node:sqlite is loaded through require rather than a static import, and that is
// deliberate. On Node 22.5–22.12 the module exists only behind
// --experimental-sqlite, and a static import of it fails at *module load* — so
// the first thing anyone on an older 22 would see is ERR_UNKNOWN_BUILTIN_MODULE
// naming a module they never typed, from a stack frame in a file they have no
// reason to open. Requiring it lazily turns that into the sentence below, which
// names all three ways out.
let _DatabaseSync = null;
function nodeSqlite() {
  if (_DatabaseSync) return _DatabaseSync;
  try {
    _DatabaseSync = require("node:sqlite").DatabaseSync;
  } catch (e) {
    throw new Error(
      `Node ${process.versions.node} cannot load the built-in node:sqlite module (${e.message}).\n` +
      `  · Upgrade to Node ${MIN_NODE} or newer, where it needs no flag.\n` +
      `  · Or start Node with --experimental-sqlite (22.5–22.12).\n` +
      `  · Or run on the other driver: SANDBOXOS_DB_DRIVER=better-sqlite3.`
    );
  }
  return _DatabaseSync;
}

// Driver selection (backlog #14). The control plane defaults to Node's built-in
// node:sqlite (DatabaseSync) — zero runtime dependency, the Phase-0 choice. The
// documented production target is better-sqlite3 v11 (docs/11); its API is a strict
// superset of the subset we use (exec / prepare → run·get·all / close), so the swap
// is a config flip behind this single seam, not a code change. Select with
// SANDBOXOS_DB_DRIVER = "node" (default) | "better-sqlite3" | "auto" (use it if present).
function openConnection(dbPath) {
  const pref = (process.env.SANDBOXOS_DB_DRIVER ?? "node").toLowerCase();
  if (pref === "better-sqlite3" || pref === "better" || pref === "auto") {
    try {
      const Database = require("better-sqlite3");
      return new Database(dbPath);
    } catch (e) {
      if (pref === "auto") return new (nodeSqlite())(dbPath); // graceful fallback
      throw new Error(`SANDBOXOS_DB_DRIVER=${pref} but better-sqlite3 could not be loaded: ${e.message}`);
    }
  }
  return new (nodeSqlite())(dbPath);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  kind        TEXT NOT NULL,            -- 'human' | 'machine' | 'agent'
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  cell_backend  TEXT NOT NULL,          -- 'docker' | 'local'
  volume_path   TEXT NOT NULL,
  state         TEXT NOT NULL,          -- 'stopped' | 'running'
  last_active_at INTEGER,
  created_at    INTEGER NOT NULL
);

-- Capability grants: a principal may invoke tools matching <pattern> on a Sandbox.
-- Pattern grammar: "server.tool", "server.*", "*". Default-deny: no row => no access.
CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  sandbox_id   TEXT NOT NULL REFERENCES sandboxes(id),
  pattern      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind         TEXT NOT NULL,           -- 'session' (cookie) | 'machine' (bearer)
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Append-only audit log. Every Kernel-mediated MCP call writes exactly one row.
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  sandbox_id    TEXT,
  principal_id  TEXT,
  on_behalf_of  TEXT,
  server        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_json     TEXT,                   -- secrets redacted before storage
  result_kind   TEXT NOT NULL,          -- 'ok' | 'error' | 'denied'
  error         TEXT,
  capability    TEXT,                   -- the grant pattern that authorized it
  prev_hash     TEXT,                   -- hash chain for tamper-evidence
  hash          TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_sandbox ON audit(sandbox_id, id);
CREATE INDEX IF NOT EXISTS idx_grants_principal ON grants(principal_id, sandbox_id);

-- Scheduled jobs (the cron server). Each job fires a Kernel tool call on behalf
-- of the principal that scheduled it, with that principal's capabilities.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  sandbox_id   TEXT NOT NULL REFERENCES sandboxes(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  server       TEXT NOT NULL,
  tool         TEXT NOT NULL,
  args_json    TEXT,
  due_at       INTEGER NOT NULL,
  interval_ms  INTEGER,                 -- NULL => one-shot
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(enabled, due_at);

-- Phase-3 agents. Each agent is a supervised task with its own scoped principal.
-- The spawned_by column records who delegated authority so audit can show the chain.
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  sandbox_id   TEXT NOT NULL REFERENCES sandboxes(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  spawned_by   TEXT NOT NULL,
  name         TEXT NOT NULL,
  patterns     TEXT NOT NULL,
  cmd          TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'shell',
  state        TEXT NOT NULL DEFAULT 'queued',
  result       TEXT,
  error        TEXT,
  exit_code    INTEGER,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agents_sandbox ON agents(sandbox_id, state);

-- Phase-4 distros: named manifest templates for reproducible Sandbox creation.
CREATE TABLE IF NOT EXISTS distros (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT,
  manifest    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

-- Phase-4 accounts: per-user credentials for self-service signup.
-- Separate from principals so the auth mechanic is swappable (OAuth later).
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  username     TEXT NOT NULL UNIQUE,
  salt         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Phase-14 per-tenant quotas. Rows are optional: absence means "use global defaults".
-- Phase-15 adds resource columns mem_mb / cpu_shares (additive migration in runMigrations).
CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id),
  max_sandboxes INTEGER NOT NULL DEFAULT 3,
  max_agents    INTEGER NOT NULL DEFAULT 10,
  max_running   INTEGER NOT NULL DEFAULT 2,
  mem_mb        INTEGER NOT NULL DEFAULT 512,
  cpu_shares    REAL    NOT NULL DEFAULT 1.0
);

-- Tenant profile/onboarding state. Credentials live in encrypted tenant_secrets;
-- this row only stores preferences and setup completion state.
CREATE TABLE IF NOT EXISTS tenant_profiles (
  tenant_id              TEXT PRIMARY KEY REFERENCES tenants(id),
  llm_provider           TEXT NOT NULL DEFAULT 'claude',
  onboarding_completed   INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

-- Secrets (the secrets server). Values are encrypted at rest; callers receive
-- references, never raw values (docs/09).
CREATE TABLE IF NOT EXISTS secrets (
  id          TEXT PRIMARY KEY,
  sandbox_id  TEXT NOT NULL REFERENCES sandboxes(id),
  name        TEXT NOT NULL,
  ct          TEXT NOT NULL,           -- base64 ciphertext
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(sandbox_id, name)
);

-- Assistant conversations. The Assistant runs as the calling principal (not as a
-- delegated agent), so a conversation belongs to a principal within a Sandbox.
-- Messages are stored in provider shape so a turn can be replayed verbatim.
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  sandbox_id   TEXT NOT NULL REFERENCES sandboxes(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  title        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_sandbox ON conversations(sandbox_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,   -- JSON, provider-shaped
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages ON conversation_messages(conversation_id, id);

-- Tenant-scoped encrypted secrets for account/profile configuration such as
-- provider API keys. Same crypto custody as Sandbox secrets, but not tied to a
-- deletable Sandbox.
CREATE TABLE IF NOT EXISTS tenant_secrets (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  ct          TEXT NOT NULL,
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);
`;

let _db = null;

/** Open (and migrate) the control DB. Singleton per process. */
export function openDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = openConnection(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  runMigrations(db);
  _db = db;
  return db;
}

// Additive migrations: ALTER TABLE ADD COLUMN is safe in SQLite; ignore if column exists.
const MIGRATIONS = [
  // Phase 4
  "ALTER TABLE agents ADD COLUMN prompt TEXT",
  "ALTER TABLE agents ADD COLUMN system_prompt TEXT",
  // Phase 15: resource quota columns on tenant_quotas
  "ALTER TABLE tenant_quotas ADD COLUMN mem_mb     INTEGER NOT NULL DEFAULT 512",
  "ALTER TABLE tenant_quotas ADD COLUMN cpu_shares REAL    NOT NULL DEFAULT 1.0",
  // Phase 16: TAP pool for Firecracker
  `CREATE TABLE IF NOT EXISTS vm_taps (
    tap_name   TEXT PRIMARY KEY,
    sandbox_id TEXT REFERENCES sandboxes(id)
  )`,
  // Backlog #1: operator authority tier. Additive flag on principals; default 0 so
  // self-service signups are never operators unless explicitly elevated.
  "ALTER TABLE principals ADD COLUMN is_operator INTEGER NOT NULL DEFAULT 0",
  // Backlog #11: per-tenant secret key derivation + rotation. key_version records the
  // key scheme a secret's ciphertext was sealed under: 0 = legacy single master key,
  // 1 = per-tenant HKDF-derived key. Default 0 so pre-existing rows decrypt correctly.
  "ALTER TABLE secrets ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0",
  // Phase 27: a distro may now carry a whole OS — the desktop document plus the
  // source of every custom app it needs. Nullable, so the Phase-4 manifest-only
  // distros keep working exactly as they did.
  "ALTER TABLE distros ADD COLUMN os TEXT",
];

// Backlog #14 (migration hardening): only swallow the benign "column/table already
// exists" class of errors that makes additive migrations idempotent. Any other
// failure is a genuine schema bug and must surface (rethrown with context) rather
// than being silently lost by a blanket catch.
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;

function runMigrations(db) {
  let applied = 0;
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
      applied++;
    } catch (err) {
      if (BENIGN_MIGRATION_ERROR.test(err?.message ?? "")) {
        applied++; // already applied on a prior boot — idempotent, count it as present
        continue;
      }
      // Genuine migration failure: rethrow with which statement broke.
      throw new Error(`migration failed: ${m.split("\n")[0].trim()} — ${err?.message ?? err}`);
    }
  }
  recordSchemaVersion(db, applied);
}

// Backlog #14: record the applied migration count/version on boot so the schema
// state is observable (and future tooling can detect drift). Single-row table.
function recordSchemaVersion(db, version) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    version     INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`);
  db.prepare(`INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at`)
    .run(version, Date.now());
}

/** Current applied schema version (migration count), or 0 if not yet recorded. */
export function schemaVersion(db = openDb()) {
  const row = db.prepare("SELECT version FROM schema_version WHERE id=1").get();
  return row?.version ?? 0;
}

/**
 * Backlog #9/#14: run `fn` inside a single SQLite transaction. Commits on success,
 * rolls back if `fn` throws (then rethrows). Uses db.exec for the transaction
 * control statements so it works with the node:sqlite driver. Not reentrant —
 * callers must not nest withTransaction calls on the same connection.
 */
export function withTransaction(fn, db = openDb()) {
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back / no active txn */ }
    throw err;
  }
}

/** Close + reset the singleton (used by tests between runs). */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
