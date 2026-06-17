# Phase 1 · Kernel & Command Central

> Goal (from [`docs/12-roadmap.md`](docs/12-roadmap.md)): the full kernel ABI and a
> console worth living in; the capability and hibernate/wake machinery everything else
> depends on. **Done when:** you run several Sandboxes that sleep and wake on demand,
> each composed from a manifest, each controllable from anywhere, with default-deny
> capabilities enforced.
>
> **Status: built and green.** ✅ 36/36 tests pass; Docker smoke drives a real
> container through the `sbx` CLI — secrets-in-env, MCP-manages-MCP, cron firing, and a
> scoped token denied — all audited.

## What's new since Phase 0

### The full core ABI (manifest-driven)
The Kernel now builds its server set from each Sandbox's **manifest** (`Sandboxfile.json`),
and rebuilds live when composition changes. Core servers shipped:

| Server | Tools | Notes |
|--------|-------|-------|
| `fs` | list, read, write, stat | (Phase 0) |
| `proc` | exec, list | (Phase 0) |
| `cron` | at, every, list, cancel | fires Kernel calls on the scheduler's behalf |
| `net` | fetch | egress-policy gated (allow/deny + `*.host` wildcards) |
| `secrets` | put, list, remove, useInEnv | reference-not-value; AES-256-GCM at rest |
| `pkg` | install, remove, list | wraps the Cell image's package manager (apk) |
| `mcp-registry` | list, enable, disable, configure | **MCP manages MCP** — rebuilds the Kernel |
| `kernel` | whoami, capabilities, auditQuery, manifestGet, manifestSet | self-administration |

### Capabilities, machine tokens, attenuating delegation
- `patternCovers` / `canDelegate`: delegation **only attenuates** — you can mint a token
  scoped to a *subset* of what you hold, never a superset.
- `POST /:slug/tokens` mints an attenuated **machine token** (Bearer). `sbx login` uses it.
- Verified: a `fs.list`-scoped token is denied `fs.write`, end-to-end.

### The control-plane Scheduler (single-host budget)
`packages/scheduler` — **wake / hibernate / resource budget**. Only `maxRunning` Cells are
hot at once; waking past budget evicts the **LRU** Cell to disk; an **idle reaper**
hibernates quiet Cells. Wired into the Gateway (wake on slug open, touch on exec, reap on
a 30s loop). This is what lets many Sandboxes share one Mac Mini.

### The `sbx` CLI
The native Command Central client (zero deps):
```
sbx login [--url URL] [--slug SLUG] [--patterns a,b]   # mint + save a machine token
sbx run "<line>"      sbx <line>          # run a Command Central line
sbx call <server.tool> <json>             # raw MCP
sbx audit [n]         sbx watch           # recent / live audit
sbx token [--patterns …]                  # mint a narrower token
```
Config at `~/.sbx/config.json` (override with `SBX_CONFIG`).

### Multi-Sandbox per tenant
`POST /api/sandboxes {slug,name}` creates another isolated machine for your tenant; the
creator gets full rights on it. Default-deny still applies to everyone else.

## Try it

```bash
npm start
sbx login --url http://127.0.0.1:3939     # password: dev  (or SANDBOXOS_PASSWORD)
sbx whoami
sbx run "secret put TOKEN abc123"
sbx call secrets.useInEnv '{"refs":["secret://TOKEN"],"cmd":"echo $TOKEN"}'
sbx run "disable pkg"   # then: sbx run "servers"   — MCP reconfiguring the OS
sbx call cron.every '{"intervalMs":60000,"server":"proc","tool":"exec","args":{"cmd":"date >> heartbeat.log"}}'
sbx watch                # live audit stream
```

`npm test` → **36 node:test assertions**, isolated temp home, no Docker required.

## Carried-over deviations (still intentional, see [`PHASE0.md`](PHASE0.md))

JS-not-TS · `node:sqlite`-not-better-sqlite3 · SSE+POST-not-WebSocket/PTY · Kernel hosted
host-side. All still hold; their upgrade paths are unchanged.

## New Phase-1 scope notes

| Item | Phase 1 | Documented target |
|------|---------|-------------------|
| **Doc-03 `scheduler` MCP server** renamed to **`cron`** | avoids clash with the control-plane Scheduler | — |
| **Warm pool** (generic pre-booted Cells) | **deferred** — conflicts with per-Cell bind-mount volumes | Phase 5, with a docker-volume + checkpoint strategy |
| **Manifest format** | JSON (`Sandboxfile.json`) | TOML, versioned as a Tide `State` object (Phase 2) |
| **Natural-language console** | recognized, returns a "Phase 3" notice | Phase 3 |
| **PTY / interactive shell** (vim, top) | request/response `proc.exec` only | WebSocket + xterm.js (next) |
| **`pkg`** | Alpine `apk` only | multi-distro managers |

## Where it maps

| Piece | Path |
|-------|------|
| Manifest | `packages/manifest/` |
| New core servers | `packages/kernel/src/servers/{cron,net,secrets,pkg,registry,kernel}.js` |
| Server catalog + live rebuild | `packages/kernel/src/catalog.js`, `kernel.js` |
| Capability attenuation | `packages/kernel/src/capabilities.js` |
| Secret store (AES-256-GCM) | `packages/secrets/` |
| Control-plane Scheduler | `packages/scheduler/src/scheduler.js` |
| Cron runner | `packages/scheduler/src/cron-runner.js` |
| Machine tokens / multi-Sandbox | `packages/control-db/src/registry.js`, `apps/gateway/src/server.js` |
| `sbx` CLI | `packages/sbx-cli/` |

## Next (toward Phase 2 · Tide)

Versioned object store + `tide init/mark/push/pull`, then the live mirror — the point
where local and cloud become one. Also queued: the WebSocket/PTY terminal upgrade, and
moving the Kernel inside the Cell.
