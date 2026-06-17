# Phase 4 — The Product

Phase 4 builds the user-visible product layer on top of the Phase 3 agent runtime: AI-native agents that drive the Kernel's MCP tools via an Anthropic tool loop, distros (reproducible Sandbox templates), self-service signup, and quota enforcement.

## What was built

### 1. AI agent kind (`packages/agents/src/ai-runner.js`)

An `agents.spawn` call with `kind: "ai"` starts an LLM-driven tool loop instead of running a shell command.

```
agents.spawn {
  name: "researcher",
  kind: "ai",
  patterns: ["fs.*", "tide.*"],
  prompt: "Find all TODO comments in the source tree.",
  system: "You are a helpful assistant with sandboxOS tool access."
}
```

The loop:
1. Builds Anthropic tool definitions from the Kernel catalog, filtered to the agent's capability patterns (`buildToolDefs`).
2. Calls the Anthropic Messages API (`claude-haiku-4-5-20251001` by default).
3. Executes every `tool_use` block via `kernel.call()` with the agent's attenuated principal and `onBehalfOf` set to the spawning human.
4. Feeds results back until `stop_reason = "end_turn"` or 20 iterations are exhausted.

When `ANTHROPIC_API_KEY` is absent the runner short-circuits immediately with a mock `done` result so the spawn/get lifecycle can be tested without credentials.

**Tool name encoding**: Anthropic requires `[a-zA-Z0-9_-]` for tool names. `server.tool` is encoded as `server__tool` (double underscore). `encodeName` / `decodeName` convert in both directions.

### 2. Distros (`packages/control-db/src/registry.js`)

A distro is a named, tenant-scoped snapshot of a Sandbox's manifest (the MCP server configuration). It lets operators define reproducible baseline environments and apply them to new Sandboxes at creation time.

```
POST /api/distros   { name, description, slug }   — snapshot the named Sandbox's manifest
GET  /api/distros                                  — list distros for the authenticated tenant
POST /api/sandboxes { slug, name, distro }         — create a Sandbox pre-loaded with a distro
```

Registry functions: `createDistro`, `getDistro`, `getDistroByName`, `listDistros`.

Duplicates within the same tenant throw on INSERT (unique constraint on `(tenant_id, name)`).

### 3. Self-service signup (`apps/gateway/src/server.js`, `packages/control-db/src/registry.js`)

```
POST /signup { username, password }
```

Creates a tenant, a human principal, an account (PBKDF2-hashed credential), and a primary Sandbox — all in one step. A session cookie is issued immediately.

Password requirements: minimum 8 characters (enforced at the gateway, returns 400 if violated).

Username requirements: produces a valid slug (2–32 chars, lowercase alphanumeric + hyphens). Duplicate usernames throw `username taken` and the gateway returns 409.

`POST /login` was extended to accept `{ username, password }` for account-based login alongside the legacy `{ password }` single-password path.

Registry functions: `createAccount` (PBKDF2, 10 000 iterations, SHA-256, 16-byte random salt), `verifyAccount`, `getAccountByUsername`, `getPrimarySandboxForTenant`.

### 4. Quotas

**Sandbox quota** — `SANDBOXOS_MAX_SANDBOXES` (default: 10). Checked in `POST /api/sandboxes`; returns HTTP 429 `{ error: "sandbox quota exceeded (max N)" }` when the tenant's sandbox count meets or exceeds the limit.

**Agent quota** — `SANDBOXOS_MAX_AGENTS` (default: 10). Checked in `agents.spawn`; returns `{ ok: false, error: "agent quota exceeded (max N concurrent)" }` when the Sandbox's queued+running agent count meets or exceeds the limit.

Both limits are read dynamically on each request (not cached at startup) so tests can override them via `process.env` without restarting the server.

### 5. DB additions (`packages/control-db/src/db.js`)

Two new tables:

```sql
CREATE TABLE IF NOT EXISTS distros (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Two additive migrations on the existing `agents` table:

```sql
ALTER TABLE agents ADD COLUMN prompt TEXT;
ALTER TABLE agents ADD COLUMN system_prompt TEXT;
```

Migrations use try/catch around each `ALTER TABLE` so they are idempotent on upgraded installs (SQLite throws if the column already exists).

## Test coverage — `test/phase4.test.js` (20 tests)

| Section | Tests |
|---------|-------|
| AI agent kind | 4 (buildToolDefs filtering, wildcard, encodeName/decodeName, spawn kind=ai, mock without key, shell still works) |
| Distros | 5 (createDistro, getDistroByName, duplicate throws, GET /api/distros, POST /api/distros) |
| Self-service signup | 6 (createAccount, verifyAccount, duplicate username, POST /signup, weak password → 400, POST /login with username) |
| Quotas | 3 (sandboxCountForTenant, POST /api/sandboxes → 429, agents.spawn → quota error) |

Full suite after Phase 4: **123 tests, 0 failures**.

## What's deferred to Phase 5

- WebSocket / PTY terminal (real interactive shell in the browser)
- `SIGKILL` for AI agents mid-tool-loop
- NL propose→confirm UX in the browser frontend
- App model and desktop GUI layer
- MCP server marketplace / registry
