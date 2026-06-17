# Phase 14 — Product Gate

Phase 14 turns the infrastructure from Phase 13 into a multi-tenant product: per-tenant quota enforcement, distro snapshots for reproducible Sandbox creation, Cloudflare Tunnel auto-wiring, and new `sbx distro` / `sbx quota` CLI commands.

## What was built

### 1. Per-tenant quota table + enforcement

**`packages/control-db/src/db.js`** — new `tenant_quotas` table (additive, `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id),
  max_sandboxes INTEGER NOT NULL DEFAULT 3,
  max_agents    INTEGER NOT NULL DEFAULT 10,
  max_running   INTEGER NOT NULL DEFAULT 2
);
```

**`packages/control-db/src/registry.js`** — two new exports:

```js
getQuota(tenantId)
// → { tenant_id, max_sandboxes, max_agents, max_running }
// Falls back to defaults (3 / 10 / 2) when no row exists.

setQuota(tenantId, { maxSandboxes?, maxAgents?, maxRunning? })
// Partial upsert — omitted keys keep their current value.
// → updated quota object
```

**Quota enforcement in `apps/gateway/src/server.js`**:

- **Sandbox creation** (`POST /api/sandboxes`): uses `min(quota.max_sandboxes, SANDBOXOS_MAX_SANDBOXES)` — per-tenant quota AND the system-level env cap, whichever is lower. Returns `429` when exceeded.
- **Agent spawn** (`POST /:slug/mcp` with `agents.spawn`): checks `runningAgentCount(sandbox.id) < quota.max_agents` before delegating to the kernel. Returns `429` when exceeded.

### 2. `GET/POST /api/quota` — quota REST API

```
GET /api/quota
→ { ok: true, quota: { tenant_id, max_sandboxes, max_agents, max_running } }

POST /api/quota { maxSandboxes: 5, maxAgents: 20, maxRunning: 3 }
→ { ok: true, quota: { ... } }
```

All fields in the POST body are optional — omit any to preserve the current value. Any authenticated principal may read/update their own tenant's quota. (A more fine-grained admin restriction can be added in a future phase.)

### 3. `POST /api/sandboxes/:slug/snapshot` — distro from sandbox manifest

Takes the current manifest of any sandbox and saves it as a named distro. The distro can then be applied when creating a new sandbox (`POST /api/sandboxes { distro: "name" }`), ensuring new sandboxes start with the same server composition and config.

```
POST /api/sandboxes/tobias/snapshot
{ "name": "my-baseline", "description": "with tide + agents enabled" }
→ { ok: true, id: "dtr_xxx", name: "my-baseline" }
```

Requires auth; returns 404 if the sandbox is not owned by the calling tenant.

### 4. `DELETE /api/distros/:name` — distro delete

```
DELETE /api/distros/my-baseline
→ { ok: true, deleted: true | false }
```

**`packages/control-db/src/registry.js`** — `deleteDistro(tenantId, name)` returns `{ deleted: bool }`.

### 5. Cloudflare Tunnel auto-start

**`apps/gateway/src/index.js`**: if `SANDBOXOS_TUNNEL_TOKEN` is set, automatically starts `cloudflared tunnel run --token $TOKEN` as a child process and logs a status line. Errors from the process (e.g. `cloudflared` not installed) are caught and logged — they don't crash the gateway.

**`GET /health`** now includes `tunnel: true|false` — whether a tunnel token is configured.

```
GET /health
→ { ok: true, uptime: 3.2, sandboxes: 1, tunnel: false }
```

To expose the gateway publicly without running the CLI manually:
```
SANDBOXOS_TUNNEL_TOKEN=<your-token> npm start
```

### 6. CLI additions

**`sbx distro <list|create|delete|snapshot>`**:
```
sbx distro list
sbx distro create <name> [--from <slug>] [--desc <description>]
sbx distro delete <name>
sbx distro snapshot [slug] <name>    # creates a distro from slug's current manifest
```

**`sbx quota [get|set ...]`**:
```
sbx quota                                       # prints current limits
sbx quota set --max-sandboxes 5 --max-agents 20
```

## Test coverage — `test/phase14.test.js` (17 tests)

| Section | Tests |
|---------|-------|
| `getQuota` / `setQuota` unit | 4 |
| `GET/POST /api/quota` REST | 3 |
| Sandbox creation quota | 1 |
| Agent spawn quota | 1 |
| `deleteDistro` unit | 2 |
| `DELETE /api/distros/:name` REST | 1 |
| Snapshot → list → create from distro | 4 |
| Health tunnel field | 1 |

Full suite after Phase 14: **285 tests, 0 failures**.

## What's deferred to Phase 15+

- **Real PTY via `node-pty`** — native module, requires a build step; Phase 15 evaluates native deps holistically.
- **git+https:// marketplace source** — `mcp-registry.install` with a git URL; requires `git clone` subprocess and a reliable way to install npm deps in the cloned repo.
- **Multi-host Scheduler** — Phase 5 grand plan item; needs a distributed registry.
- **`max_running` quota enforcement** — `tenant_quotas.max_running` is stored but not yet checked in the Scheduler's `wake()` path (the global `SANDBOXOS_MAX_RUNNING` env cap still applies).
- **Federation** — Phase 6.
