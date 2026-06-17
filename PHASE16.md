# Phase 16 — Production Completeness

Phase 16 closes every gap that was buildable without external infrastructure:
Firecracker TAP pool management, snapshot restore, PTY resize, per-tenant `max_running`
enforcement, `net.fetch` rate limiting, subdomain routing, and control-DB backup.

## What was built

### 1. Firecracker TAP pool (DB-backed)

**`packages/control-db/src/db.js`** — new `vm_taps` table (Phase-16 migration):

```sql
CREATE TABLE IF NOT EXISTS vm_taps (
  tap_name   TEXT PRIMARY KEY,
  sandbox_id TEXT REFERENCES sandboxes(id)   -- NULL = free
)
```

**`packages/control-db/src/registry.js`** — three new exports:

```js
allocateTap(sandboxId)   // claim a free TAP; throws if pool exhausted
releaseTap(sandboxId)    // free the TAP back to the pool
getTapForSandbox(id)     // → tap_name | null
```

Pool size: `SANDBOXOS_TAP_POOL` env (default 8). Rows seeded lazily on first call.
`allocateTap` / `releaseTap` replace the previous naive `tap-${id.slice(-6)}` derivation.

### 2. Firecracker snapshot restore

**`packages/cell/src/firecracker-backend.js`** — `_doEnsure()` now checks for snapshot files
(`mem.snap` + `vm.snap`) in the sandbox volume before choosing boot strategy:

| Condition | Action |
|---|---|
| Snapshot files exist | `_resumeVm()` — `PUT /snapshot/load` (fast, ~200ms) |
| No snapshot | `_startVm()` — cold boot via Firecracker API |
| Already running (pidfile) | Return immediately |

`_resumeVm()` re-attaches the TAP network interface after restore (Firecracker drops it on snapshot load).

### 3. PTY resize via ANSI escape

**`execInteractive()` in `firecracker-backend.js`** — `resize(cols, rows)` now sends
the xterm "set window size in chars" escape to the SSH process stdin:

```
\x1b[8;{rows};{cols}t
```

This tells the terminal emulator inside the guest to resize immediately, without
needing `node-pty` or `TIOCSWINSZ`. Works for any SSH-connected terminal.

### 4. Per-tenant `max_running` enforcement

**`packages/scheduler/src/scheduler.js`** — `wake(sandbox, quota, now)`:

```
if quota.max_running is set:
  tenantRunning = runningCountForTenant(sandbox.tenant_id)  ← DB count, persists across restarts
  if tenantRunning >= quota.max_running → throw "tenant running-cell limit reached"
```

Unlike the global `maxRunning` cap (in-process LRU), this check queries the DB
so the limit is enforced even after a gateway restart. Returns 429 from the gateway
when thrown.

**`packages/control-db/src/registry.js`** — new `runningCountForTenant(tenantId)`:

```sql
SELECT COUNT(*) FROM sandboxes WHERE tenant_id=? AND state='running'
```

### 5. `net.fetch` rate limiting

**`packages/kernel/src/servers/net.js`** — sliding-window rate limiter:

- Default: **60 requests / 60 seconds** per sandbox (configurable via `SANDBOXOS_NET_RATE_LIMIT` env)
- Per-sandbox manifest override: `{ egress: "allow", rateLimit: { requests: N, windowMs: M } }`
- Implementation: in-process timestamp array per sandbox ID, old entries flushed on each call
- `checkRateLimit(sandboxId, { requests, windowMs })` — throws `"net.fetch rate limit exceeded"` when over budget

Egress policy (`egressAllowed`) is unchanged.

### 6. Subdomain routing

**`apps/gateway/src/server.js`** — `extractSubdomainSlug(req)`:

When `SANDBOXOS_DOMAIN=yourdomain.com` is set, a request with `Host: alice.yourdomain.com`
is treated identically to a path request for `/alice`. The slug is spliced into the
path segments array at position 1, so all downstream routing logic is unaffected.

```
SANDBOXOS_DOMAIN=yourdomain.com npm start
# alice.yourdomain.com → routes to the "alice" sandbox
# api.yourdomain.com/api/quota → still hits the /api/quota handler
```

Subdomains that don't match `SLUG_RE` (not valid slug chars) are ignored and fall
through to path-based routing.

### 7. Control-DB backup endpoint + CLI

**`GET /api/admin/backup`** (auth required) — streams the raw SQLite file:

```
GET /api/admin/backup
→ 200 Content-Type: application/octet-stream
   Content-Disposition: attachment; filename="sandboxos-{ts}.db"
   [binary SQLite file]
```

**`sbx backup [output-file.db]`** — downloads and saves the DB locally:

```
sbx backup                       # saves sandboxos-backup-{ts}.db
sbx backup /path/to/backup.db    # saves to specified path
```

## Test coverage — `test/phase16.test.js` (17 tests)

| Section | Tests |
|---|---|
| TAP pool: allocate / release / reuse / null | 4 |
| Firecracker `_networkConfig` uses pool TAP | 1 |
| Firecracker `ensureRunning` rejects on macOS | 1 |
| `egressAllowed` regression | 1 |
| `checkRateLimit` pass / fail / zero-limit | 3 |
| Scheduler `max_running` pass / fail | 2 |
| `runningCountForTenant` basic | 1 |
| `/api/admin/backup` auth + binary magic | 2 |
| Subdomain routing match / miss | 2 |

Full suite after Phase 16: **317 tests, 0 failures**.

## What's left (genuinely requires external infrastructure)

- **Multi-host scheduler** — distributed registry, host-to-host networking
- **Federation** — cross-host slug resolution
- **Billing / metering** — compute-hours per tenant (payment provider)
- **Cell image CI pipeline** — build + publish Docker image + Firecracker rootfs
- **Log aggregation / metrics** — Prometheus, Grafana, alerting
- **Security review / pen test** — external engagement
- **`node-pty`** — native module for proper TIOCSWINSZ; Phase 17 candidate if native-dep policy relaxes
