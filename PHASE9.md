# Phase 9 — Sandbox Fleet

Phase 9 adds full multi-Sandbox lifecycle management: enumerate, wake, hibernate, and delete Sandboxes via API, CLI, and a browser sandbox-switcher in the desktop UI.

## What was built

### 1. Gateway: fleet management routes

**`GET /api/sandboxes`** — list all Sandboxes for the authenticated tenant:
- Returns `{ ok, sandboxes: [{ id, slug, name, cell_backend, state, last_active_at, created_at }] }`
- `state` is overlaid from `scheduler.isRunning()` so the live runtime state beats the DB column
- Requires auth; 401 otherwise

**`DELETE /api/sandboxes/:slug`** — delete a Sandbox:
- Hibernate the Cell if running → destroy the Cell volume (`cell.destroy()`) → drop the kernel cache → cascade-delete all DB rows
- Returns 404 if slug unknown or belongs to another tenant
- Returns 409 if this would remove the tenant's last Sandbox
- Returns `{ ok: true, deleted: slug }` on success

**`POST /:slug/wake`** — explicitly boot the Cell through the Scheduler:
- Calls `scheduler.wake(sandbox)`, which handles LRU eviction if the budget is full
- Returns `{ ok: true, state: "running", evicted: <sandboxId|null> }`
- Idempotent: waking a running Cell just refreshes its LRU timestamp

**`POST /:slug/hibernate`** — explicitly stop the Cell:
- Returns `{ ok: true, state: "stopped" }` immediately if already stopped (idempotent)
- Otherwise calls `scheduler.hibernate(sandbox)` to stop the Cell and update the DB

All four routes require authentication and enforce tenant isolation.

### 2. `packages/control-db/src/registry.js` — fleet registry helpers

**`listSandboxesForTenant(tenantId)`** — `SELECT * FROM sandboxes WHERE tenant_id=? ORDER BY created_at`

**`deleteSandbox(sandboxId)`** — cascade deletes child rows before deleting the sandbox row:
```js
DELETE FROM jobs    WHERE sandbox_id=?
DELETE FROM agents  WHERE sandbox_id=?
DELETE FROM secrets WHERE sandbox_id=?
DELETE FROM grants  WHERE sandbox_id=?
DELETE FROM audit   WHERE sandbox_id=?
DELETE FROM sandboxes WHERE id=?
```
Order matters: SQLite foreign-key constraints (`PRAGMA foreign_keys = ON`) require children to go first.

### 3. `packages/kernel/src/kernel.js` — `_dropKernel(sandboxId)`

Evicts a Sandbox's cached Kernel (and its in-flight Promise) from `_kernels`. Called by the DELETE route so the next access gets a fresh Kernel rather than a dead one pointing to a deleted sandbox.

### 4. `packages/sbx-cli/src/sbx.js` — fleet subcommands

`sbx sandbox` now supports five subcommands:

| Subcommand | Description |
|------------|-------------|
| `list` | List all sandboxes with state and name (active sandbox marked with `*`) |
| `create <slug>` | Create a new sandbox |
| `wake [slug]` | Wake (boot) a sandbox (default: current) |
| `hibernate [slug]` | Hibernate (stop) a sandbox (default: current) |
| `delete <slug>` | Delete a sandbox permanently |

`list` now calls `GET /api/sandboxes` directly instead of `GET /api/stats`, so it shows per-sandbox detail:
```
*  tobias                   running  tobias's Sandbox
   staging                  stopped  Staging
```

### 5. Frontend: topbar sandbox switcher

**`apps/gateway/public/sandbox.html`** — `<select id="sandbox-select" class="sandbox-switcher">` added to the topbar between the brand and the tab bar.

**`apps/gateway/public/app.js`** — loads `GET /api/sandboxes` on page init:
- Populates the `<select>` with all tenant sandboxes
- Running sandboxes are suffixed with `●`
- Selecting a different sandbox navigates to `/<slug>`

**`apps/gateway/public/styles.css`** — `.sandbox-switcher` token-bound styling.

## Test coverage — `test/phase9.test.js` (15 tests)

| Section | Tests |
|---------|-------|
| Registry helpers | 2 (`listSandboxesForTenant`, `deleteSandbox`) |
| `GET /api/sandboxes` | 3 (401, list shape, created_at/last_active_at fields) |
| `DELETE /api/sandboxes/:slug` | 4 (401, 404, 409 last-sandbox guard, success) |
| `POST /:slug/wake` | 3 (401, running state, idempotent) |
| `POST /:slug/hibernate` | 3 (401, stopped state, idempotent) |

Full suite after Phase 9: **201 tests, 0 failures**.

## What's deferred to Phase 10+

- **Real PTY via `node-pty`** — `ioctl TIOCSWINSZ` for resize, full ncurses support
- **npm / Git URL install** in `mcp-registry.install`
- **Frontend streaming terminal** — switch Command Central from POST-per-command to SSE stream
- **Multi-host Scheduler** — cross-node Cell registry and routing
- **microVM backend** (Firecracker-in-Linux-VM on Mac Mini) for true L2 isolation
- **Federation** and self-host distribution packages
