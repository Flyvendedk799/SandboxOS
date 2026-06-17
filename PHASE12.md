# Phase 12 — Audit Query API

Phase 12 makes the audit log a first-class queryable data source. The log has been append-only and hash-chained since Phase 0, but was only accessible as a fixed 50-event tail. Phase 12 adds filterable queries, a REST API with query params, and filter controls in the frontend audit panel.

## What was built

### 1. `queryAudit` — filtered audit query (registry)

**`packages/control-db/src/registry.js`** — `queryAudit(sandboxId, opts)`:

```js
queryAudit(sandboxId, { server, tool, principalId, resultKind, after, limit = 50 })
```

Builds a dynamic `WHERE` clause with any combination of filters:
- `server` — exact match on `server` column (e.g. `"fs"`, `"proc"`)
- `tool` — exact match on `tool` column (e.g. `"write"`, `"exec"`)
- `principalId` — match by `principal_id` (e.g. trace a specific agent)
- `resultKind` — `"ok"`, `"error"`, or `"denied"`
- `after` — epoch-ms lower bound on `ts` (exclusive) — pagination and "since" queries
- `limit` — max rows returned; capped at 500 regardless of what the caller passes

Returns events in ascending timestamp order (oldest → newest), matching `recentAudit` behaviour.

### 2. `GET /:slug/audit` — filterable REST endpoint (gateway)

Updated to accept query parameters forwarded into `queryAudit`:

| Param | Maps to | Example |
|-------|---------|---------|
| `?server=` | `server` filter | `?server=fs` |
| `?tool=` | `tool` filter | `?tool=write` |
| `?kind=` | `resultKind` filter | `?kind=denied` |
| `?principal=` | `principalId` filter | `?principal=prn_abc123` |
| `?after=` | `after` epoch-ms | `?after=1718534000000` |
| `?limit=` | `limit` (max 500) | `?limit=20` |

Parameters are independently optional — any combination works. No params → equivalent to the previous `recentAudit(sandboxId, 50)` call. All require auth.

### 3. Frontend: audit panel filter controls

**`apps/gateway/public/sandbox.html`** — the audit aside in the Terminal tab now has an `.audit-header` with:
- `#audit-filter-server` `<select>` — filter by known server names
- `#audit-filter-kind` `<select>` — filter by `all / ok / error / denied`
- `#audit-query-btn` `↺` button — trigger a query (or reset to live if both filters are cleared)

**`apps/gateway/public/app.js`** — `queryAuditPanel()`:
- Fetches `GET /:slug/audit?server=…&kind=…&limit=100` and re-renders the audit list
- Sets `_auditLive = false` while a filter is active (suppresses incoming SSE events from overwriting the filtered view)
- Badge changes to "filtered" to signal the panel is in query mode
- Clicking `↺` with both selects cleared resets to live SSE mode

**`apps/gateway/public/styles.css`** — `.audit-header`, `.audit-filters`, `.audit-filters select` token-bound styles.

## Test coverage — `test/phase12.test.js` (18 tests)

| Section | Tests |
|---------|-------|
| `queryAudit` unit | 10 (no filter, server, tool, resultKind=denied, resultKind=ok, limit, limit cap, after, combined, empty result) |
| `GET /:slug/audit` REST | 8 (401, events array, ?server, ?tool, ?kind=denied, ?limit, combined filter, ?after) |

The `test.before` seeds four specific audit events (two `fs.list`, one `proc.exec`, one denied `fs.read`) so filter assertions have predictable data to work against.

Full suite after Phase 12: **247 tests, 0 failures**.

## What's deferred to Phase 13+

- **Cursor-based pagination** — `?cursor=<last-event-id>` for efficient deep paging through large logs
- **`POST /:slug/secrets/:name/use`** — REST wrapper for `secrets.useInEnv`
- **Real PTY via `node-pty`** — vim/top/htop support
- **npm / Git URL marketplace install**
- **Multi-host Scheduler** and microVM backend
- **Federation**
