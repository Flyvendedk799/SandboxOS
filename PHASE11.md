# Phase 11 — Secrets REST API

Phase 11 completes the secrets management story. The `secrets` MCP server has been part of the kernel since Phase 1 but was only accessible via `:call secrets.*` raw MCP. Phase 11 adds a REST API, `sbx secret` CLI commands, and a Secrets tab in the desktop UI.

## What was built

### 1. Gateway: secrets REST endpoints

Three new routes added after `const kernel = await getKernel(sandbox)` in the slug-routing section:

**`GET /:slug/secrets`** — list all secret names + refs for the Sandbox:
- Calls `kernel.call({ server: "secrets", tool: "list" })` — fully authorized + audited
- Returns `{ ok, secrets: [{ name, ref, created_at }] }`
- Values are never included (reference-not-value, enforced at the secrets server layer)
- Requires auth; 401 otherwise

**`POST /:slug/secrets`** `{ name, value }` — store (or overwrite) a secret:
- 400 if `name` or `value` is missing
- Calls `secrets.put` via the kernel — AES-256-GCM encrypted at rest
- Returns `{ ok, ref: "secret://<name>" }`
- The plaintext value never appears in the response or audit log

**`DELETE /:slug/secrets/:name`** — remove a secret:
- Returns `{ ok, removed: true|false }` (false when the name didn't exist)
- Calls `secrets.remove` via the kernel

All three routes go through `kernel.call()` so every operation is authorized against the caller's capability patterns and recorded in the audit log.

### 2. `packages/sbx-cli/src/sbx.js` — `sbx secret` subcommand

```
sbx secret list           list all secret names and refs
sbx secret set <n> <v>   store (or overwrite) a secret
sbx secret rm <name>      remove a secret
```

`list` prints `<name>  secret://<name>`. `set` echoes `stored → secret://<name>`. `rm` prints `removed` or `not found`.

### 3. Frontend: Secrets tab

**`apps/gateway/public/sandbox.html`** — 5th tab "Secrets" (`data-tab="secrets"`) + `#panel-secrets` section with:
- `+ Add` toggle button → shows the `#secret-add-form` inline form
- `#secret-name` (text input) + `#secret-value` (password input, `type="password"` — browser never autofills)
- `#secrets-list` — populated by `refreshSecrets()`

**`apps/gateway/public/app.js`** — `refreshSecrets()` fetches `GET /:slug/secrets` and renders each secret as a row with its ref and a "Remove" button. `deleteSecret(name)` calls `DELETE /:slug/secrets/:name`. The store form POSTs to `POST /:slug/secrets` and refreshes the list.

**`apps/gateway/public/styles.css`** — `.secret-add-form`, `.secrets-list`, `.secret-row`, `.secret-name`, `.secret-ref` token-bound styles.

## Test coverage — `test/phase11.test.js` (14 tests)

| Section | Tests |
|---------|-------|
| Auth | 3 (GET/POST/DELETE all require auth — 401) |
| CRUD | 5 (empty list, store + ref, reflect in list, created_at, upsert) |
| Validation | 2 (400 missing name, 400 missing value) |
| Delete | 2 (remove → gone, non-existent → removed:false) |
| Multi-secret | 1 (multiple stored, values never leak) |
| Kernel integration | 1 (secrets.list accessible via raw MCP) |

Full suite after Phase 11: **229 tests, 0 failures**.

## Reference-not-value guarantee

The secrets server enforces that plaintext values never leave the kernel:
- `secrets.put` returns `{ name, ref: "secret://<name>" }` — no value
- `secrets.list` returns `{ name, ref, created_at }` — no value
- The audit log redacts fields matching `/pass|secret|token|key|authorization/i`
- `secrets.useInEnv` decrypts values server-side and injects into a Cell command's env, then returns only stdout/stderr

The REST layer is a thin proxy through `kernel.call()` and inherits all of these guarantees.

## What's deferred to Phase 12+

- **`POST /:slug/secrets/:name/use`** — REST wrapper for `secrets.useInEnv` (run a command with selected secrets injected as env vars)
- **Real PTY via `node-pty`** — vim/top/htop support, TIOCSWINSZ resize
- **npm / Git URL marketplace install** — mcp-registry only supports file paths currently
- **Multi-host Scheduler** and microVM backend
- **Federation**
