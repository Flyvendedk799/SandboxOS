# Phase 6 — Live Streams

Phase 6 adds real-time data flow to every layer of the stack: streaming exec (SSE), per-agent event streams, health/stats API, and `sbx` CLI completions for agents, sandboxes, apps, and streaming.

## What was built

### 1. Streaming exec (`POST /:slug/stream`)

Runs a shell command in the Cell and streams stdout/stderr chunks back as Server-Sent Events. The client receives `{ type: "stdout"|"stderr", chunk }` events followed by a terminal `{ type: "done", code }` event carrying the exit code.

```
POST /:slug/stream { cmd: "find . -name '*.js'" }
→ Content-Type: text/event-stream
data: {"type":"stdout","chunk":"./app.js\n"}
data: {"type":"stdout","chunk":"./lib.js\n"}
data: {"type":"done","code":0}
```

Authorization: requires `proc.exec` capability (checked via `authorize(held, "proc", "exec")` before streaming begins). Client disconnect kills the child process.

Implementation: `LocalBackend.execStream(cmd, callback, opts)` (new) uses Node.js `spawn` with stdio callbacks. `DockerBackend.execStream` mirrors this with `docker exec` via `spawn`. The gateway route calls `kernel.cell.execStream` directly (streaming bypasses the MCP request/response model).

### 2. Agent event SSE (`GET /:slug/agents/:id/events`)

Streams audit events from `kernel.events` filtered to those belonging to the given agent (by `principal_id` or `on_behalf_of`). Opens with an `event: hello` frame carrying the agent's current state.

```
GET /:slug/agents/agt_abc/events
→ event: hello
  data: {"agentId":"agt_abc","state":"running"}
  data: {"server":"fs","tool":"list","resultKind":"ok", ...}
```

Useful for watching an AI agent's tool calls in real-time from the browser or `sbx`.

### 3. Health endpoint (`GET /health`)

Unauthenticated endpoint for load balancer probes, monitoring, and debugging.

```
GET /health
→ { "ok": true, "uptime": 3142.1, "sandboxes": 4 }
```

`uptime` is `process.uptime()` in seconds. `sandboxes` is the total count across all tenants. `health` was added to `RESERVED` so it cannot be used as a sandbox slug.

### 4. Stats endpoint (`GET /api/stats`)

Authenticated: returns aggregate stats for the calling principal's tenant.

```json
{
  "ok": true,
  "tenant": { "id": "ten_xxx", "name": "alice" },
  "sandboxes": 2,
  "agents": { "total": 8, "running": 1, "queued": 0, "done": 6, "failed": 1, "killed": 0 },
  "quota": { "maxSandboxes": 10, "maxAgents": 10 }
}
```

### 5. Registry additions (`packages/control-db/src/registry.js`)

- `totalSandboxCount()` — total sandboxes across all tenants (for health endpoint)
- `tenantAgentStats(tenantId)` — agent counts by state aggregated from all the tenant's sandboxes

### 6. Cell backend streaming (`packages/cell/src/local-backend.js`, `docker-backend.js`)

Both backends gained `execStream(command, callback, opts)`:
- `LocalBackend`: uses `spawn("/bin/sh", ["-c", cmd], { cwd: root })` with stdout/stderr data listeners
- `DockerBackend`: uses `spawn("docker", ["exec", "-w", WORKDIR, containerName, "/bin/sh", "-c", cmd])`
- `callback` receives `{ type: "stdout"|"stderr", chunk }` and `{ type: "done", code }`
- A `timeoutMs` timer sends `SIGKILL` and the child process is returned for caller-side kill

### 7. `sbx` CLI completions (`packages/sbx-cli/src/sbx.js`)

Four new subcommand groups:

```
sbx agent spawn <name> <cmd>    — spawn a shell agent
sbx agent list                  — list agents for the current Sandbox
sbx agent get <id>              — show agent detail and output
sbx agent kill <id>             — kill a running agent

sbx sandbox list                — show sandbox count and quota
sbx sandbox create <slug>       — create a new Sandbox

sbx app list                    — list installed apps
sbx app install <name> <url> [patterns…]  — install an app

sbx stream "<cmd>"              — stream a command's output live (SSE → stdout/stderr)
```

## Test coverage — `test/phase6.test.js` (15 tests)

| Section | Tests |
|---------|-------|
| Health endpoint | 3 (ok without auth, uptime number, sandbox count) |
| Stats endpoint | 2 (requires auth, returns tenant stats) |
| Streaming exec | 5 (requires auth, requires cmd, stdout chunks, exit code, stderr chunks) |
| Agent event SSE | 3 (requires auth, hello event with state, 404 for bad id) |
| Registry helpers | 2 (totalSandboxCount, tenantAgentStats) |

Full suite after Phase 6: **157 tests, 0 failures**.

## What's deferred to Phase 7+

- WebSocket / PTY terminal (interactive programs like `vim`, `top`)
- MCP marketplace: install third-party servers from npm or Git
- Frontend terminal: use `POST /:slug/stream` for live output (currently POST-per-command)
- Frontend: agent event panel wired to `/:slug/agents/:id/events`
- Multi-host Scheduler (Phase 5 roadmap)
- microVM backend (Firecracker)
- Federation and self-host distribution (Phase 6 roadmap)
