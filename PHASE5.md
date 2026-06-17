# Phase 5 — The Desktop

Phase 5 completes the browser-visible product layer: an `apps` MCP server that models installable frontend applications, REST endpoints for agent lifecycle management, a propose endpoint for NL propose→confirm UX, and a full frontend rebuild with a three-tab desktop UI.

## What was built

### 1. App model (`packages/kernel/src/servers/apps.js`)

An `apps` MCP server stores named application definitions in the manifest's `apps` section. Each app is a frontend URL paired with a capability pattern set.

```
apps.list                                 → list installed apps
apps.install { name, url, patterns, description } → register an app in the manifest
apps.remove { name }                      → unregister an app
apps.launch { name }                      → mint an attenuated machine token + return url
```

Apps live in `manifest.apps`:
```json
{
  "apps": {
    "files": {
      "url": "/static/apps/files.html",
      "patterns": ["fs.*"],
      "description": "File browser"
    }
  }
}
```

`apps.launch` calls `mintMachineToken` scoped to the app's capability patterns, returning `{ token, url, name, patterns }`. The frontend opens the app URL with the token as a query parameter; the app authenticates using it as a Bearer token.

The `apps` server is now part of the default manifest (alongside `fs`, `proc`, `agents`, etc.).

### 2. Agent REST API (`apps/gateway/src/server.js`)

Three new slug-scoped HTTP routes for agent lifecycle management:

```
GET    /:slug/agents        → list all agents for the Sandbox
GET    /:slug/agents/:id    → get full detail for one agent
DELETE /:slug/agents/:id    → kill an agent
```

All routes require auth (session cookie or Bearer token) + grants on the Sandbox. They proxy into `kernel.call()` like every other gateway action — fully audited.

### 3. Propose endpoint (`POST /:slug/propose`)

Separates NL translation from execution. The frontend can call `/propose` to get back a `{ proposed: "ls" }` command string, show it with confirm/dismiss UI, and only call `/exec` if the user confirms.

```
POST /:slug/propose { line: "list my files" }
→ { ok: true, proposed: "ls" }          (when llm is enabled)
→ HTTP 503                               (when llm server is not enabled)
→ HTTP 400                               (when line is missing)
```

The existing `POST /:slug/exec` response already carries `proposed` when the line starts with `?` — the new endpoint just makes NL translate-only a first-class operation.

### 4. Frontend rebuild

**`apps/gateway/public/sandbox.html`** — three-tab layout:
- **Terminal** — same Command Central + audit panel, NL propose→confirm inline
- **Agents** — live agent list, spawn form (shell + AI), kill button per running agent
- **Apps** — app card grid, install form, launch button per card

**`apps/gateway/public/app.js`** — complete rewrite:
- Tab switching with per-tab refresh on activate
- NL propose/confirm: when `/exec` response carries `proposed`, renders a card with **Run** and **Dismiss** buttons instead of printing the hint line directly
- Agents panel polls `GET /:slug/agents`; kill calls `DELETE /:slug/agents/:id`; spawn calls `/:slug/mcp agents.spawn`
- Apps panel polls `GET /:slug/apps`; launch calls `/:slug/mcp apps.launch` → opens the app URL with `?token=...`
- XSS-safe `esc()` helper used for all dynamic HTML

**`apps/gateway/public/login.html`** — two-tab login/signup:
- **Sign in** — username+password (Phase 4 accounts) OR just password (legacy admin)
- **Sign up** — creates a new tenant + sandbox via `POST /signup`

**`apps/gateway/public/styles.css`** — new component styles:
- `.tabs` / `.tab` topbar navigation
- `.propose-card` — NL confirm/dismiss inline card
- `.agent-row` — 6-column agent table row with state colour-coding
- `.apps-grid` / `.app-card` — responsive app launcher grid
- `.install-form` — inline app install form

### 5. Catalog + manifest updates

- `packages/kernel/src/catalog.js` — added `apps` entry
- `packages/manifest/src/manifest.js` — added `apps: {}` to `defaultManifest().servers`

## Test coverage — `test/phase5.test.js` (19 tests)

| Section | Tests |
|---------|-------|
| Agent REST API | 5 (list requires auth, list, get by id, DELETE kills, DELETE requires auth) |
| Apps MCP server | 7 (list empty, install, list after install, launch, launch unknown, remove, remove non-existent) |
| Apps gateway endpoint | 2 (requires auth, returns list) |
| Propose endpoint | 4 (requires auth, missing line → 400, 503 without llm, 200 with llm + mock) |
| exec NL proposed field | 1 (exec with `?` returns `proposed` string) |

Full suite after Phase 5: **142 tests, 0 failures**.

## What's deferred to Phase 6+

- WebSocket / PTY terminal (real-time shell; currently POST-per-command)
- Actual app HTML files in `/static/apps/` (the model is there; the apps themselves aren't)
- Agent SIGKILL (kill marks the DB; the OS process runs to timeout)
- Warm pool for Cells (fast cold-start)
- Multi-host Scheduler / Sandbox portability (Phase 5 in the roadmap)
- MCP marketplace (verified third-party server install)
