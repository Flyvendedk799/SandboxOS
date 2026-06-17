# Phase 13 — Deferred Completions

Phase 13 closes the three items explicitly deferred from Phases 11 and 12: the `secrets.useInEnv` REST surface, audit cursor pagination, and npm-package marketplace installs.

## What was built

### 1. `POST /:slug/secrets/:name/use` — run a command with a secret injected as env

Wraps the existing `secrets.useInEnv` kernel tool through the REST gateway. The secret value never appears in the response; only `{ stdout, stderr, code }` are returned.

```
POST /:slug/secrets/MY_API_KEY/use
{ "cmd": "curl $MY_API_KEY/endpoint", "timeoutMs": 10000 }
→ { ok: true, stdout: "...", stderr: "...", code: 0 }
```

- Requires `secrets.*` capability (default-deny, audited).
- `timeoutMs` is optional; defaults to the `useInEnv` tool's 30 s limit.
- A denied or missing secret returns `{ ok: false, error: "..." }`.
- CLI: `sbx secret use <name> <cmd>` — stdout/stderr routed to the terminal; non-zero exit sets `process.exitCode`.

### 2. Audit cursor pagination

**`packages/control-db/src/registry.js`** — `queryAudit` gains a `cursor` parameter (exclusive lower bound on `id`):

```js
queryAudit(sandboxId, { ..., cursor: 42, limit: 50 })
```

- Without `cursor`: returns most-recent N events ascending (unchanged from Phase 12).
- With `cursor`: returns the next N events after `id=cursor` in ascending order, enabling forward pagination without re-scanning older rows.
- `ORDER BY id ASC` when cursor is set; `ORDER BY id DESC LIMIT N` + `.reverse()` otherwise.

**`GET /:slug/audit`** — new response field `nextCursor`:

```
?cursor=42&limit=50
→ { ok: true, events: [...], nextCursor: 91 | null }
```

`nextCursor` is the `id` of the last event in the page (non-null when `events.length === limit`), or `null` when the result is smaller than the requested limit (end of log reached).

| New param | Maps to | Description |
|-----------|---------|-------------|
| `?cursor=` | `cursor` filter | Forward-paginate from this event id |

### 3. `npm:` prefix in `mcp-registry.install`

**`packages/kernel/src/servers/registry.js`** — `install` now accepts `npm:<pkg-spec>` as a `source`:

```
:call mcp-registry.install { "name": "my-server", "source": "npm:my-mcp-server" }
```

How it works:
1. `npm install --prefix <sandbox-volume>/.mcp-packages <pkg-spec>` runs in a subprocess.
2. The installed directory name is resolved:
   - For `npm:file:/path` (local install): reads `name` from the package's `package.json`.
   - For `npm:pkg[@version]`: strips the `@version` suffix and the `@scope/` prefix is preserved.
3. The main entry point is resolved via `package.json` `exports["."]`, `module`, or `main` (in that order).
4. The module is dynamically `import()`-ed and the factory function registered.
5. The manifest stores the **resolved `file://` URL** so the server survives kernel restarts without re-running npm.

`file:` local paths work identically to registry packages, making this easy to test in CI:
```
npm:file:/abs/path/to/server
```

npm install failures (non-existent package, network error) propagate as a kernel `error` result.

**Note on PTY resize**: `Real PTY via node-pty` (deferred from Phase 10) requires a C++ native module and is incompatible with the zero-native-dep constraint. It is deferred to Phase 15, which will evaluate native deps holistically (node-pty, better-sqlite3 migration, etc.).

## Test coverage — `test/phase13.test.js` (20 tests)

| Section | Tests |
|---------|-------|
| `secrets.useInEnv` kernel | 3 |
| `POST /:slug/secrets/:name/use` REST | 5 |
| `queryAudit` cursor unit | 4 |
| `GET /:slug/audit?cursor=` REST | 4 |
| `mcp-registry` npm install | 4 |

**Test fixture**: `test/fixtures/mcp-test-server/` — a minimal local npm package with a `ping` tool, installed via `npm:file:` during tests to avoid registry/network dependency.

Full suite after Phase 13: **268 tests, 0 failures**.

## What's deferred to Phase 14+

- **Per-tenant quota enforcement** — quota columns exist logically; Phase 14 makes them a first-class table with per-tenant limits.
- **Distro snapshot REST** — `POST /api/sandboxes/:slug/snapshot` convenience route.
- **Cloudflare Tunnel wiring** — auto-start `cloudflared` when `SANDBOXOS_TUNNEL_TOKEN` is set.
- **Real PTY (node-pty)** — deferred to Phase 15.
- **git+https:// marketplace source** — clone and install from a git URL; deferred to Phase 15.
