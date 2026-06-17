# Phase 0 · The Spine

> Goal (from [`docs/12-roadmap.md`](docs/12-roadmap.md)): a slug resolves to a real
> isolated machine you can type into, controlled entirely through MCP. **Done when:**
> you open your slug, `ls` your Cell's filesystem, run a command, and see both actions
> in the audit log.
>
> **Status: built and green.** ✅ 21/21 tests pass; Docker smoke test boots a real
> Alpine container and round-trips write/ls/cat through the Kernel with full audit.

## Run it

Requires only **Node ≥ 24** (uses built-in `node:sqlite`). Docker is optional but gives
you real container isolation.

```bash
cd ~/Desktop/SandboxOS
npm start                      # boots the Gateway on http://127.0.0.1:3939
```

Open <http://127.0.0.1:3939>, log in (password `dev`, or set `SANDBOXOS_PASSWORD`), and
you land in **Command Central** at `/tobias`. Try:

```
help                 # the verb map
ls                   # fs.list  — your Cell's filesystem
write hello.txt hi   # fs.write
cat hello.txt        # fs.read
uname -a             # proc.exec — runs INSIDE the container
:tools               # the raw MCP tool catalog
:audit               # recent audited calls
:call fs.stat {"path":"hello.txt"}   # raw MCP
```

Every command appears in the live **Audit** panel — because every command is an
authorized, audited MCP call through the Kernel.

### Make it reachable from everywhere

```bash
cloudflared tunnel --url http://127.0.0.1:3939
```

That's the Phase-0 form of the Cloudflare-tunnel front door from
[`docs/07-slug-routing-auth.md`](docs/07-slug-routing-auth.md).

### Test

```bash
npm test               # 21 node:test assertions, isolated temp home, no Docker needed
```

## What got built (and where it maps)

| Piece | Path | Doc |
|-------|------|-----|
| Gateway: slug routing, session login, exec, SSE audit | `apps/gateway/` | [02](docs/02-architecture.md), [07](docs/07-slug-routing-auth.md) |
| Control DB + Registry (tenants, sandboxes, grants, sessions, audit) | `packages/control-db/` | [10](docs/10-data-and-storage.md) |
| Kernel: MCP router (authZ → route → audit) | `packages/kernel/` | [03](docs/03-mcp-kernel.md) |
| Core servers `fs` + `proc` | `packages/kernel/src/servers/` | [03](docs/03-mcp-kernel.md) |
| Capability model (default-deny, attenuating patterns) | `packages/kernel/src/capabilities.js` | [09](docs/09-security-model.md) |
| Cell: container backend + local fallback | `packages/cell/` | [04](docs/04-execution-substrate.md) |
| Command Central verb map (shell / raw MCP / NL-stub) | `packages/command-central/` | [06](docs/06-command-central.md) |
| Web desktop + terminal + live audit | `apps/gateway/public/` | [06](docs/06-command-central.md), [08](docs/08-customization-distros.md) |

## Deliberate spine simplifications (and the upgrade path)

These keep Phase 0 zero-build and runnable today; each has a clean, already-designed
path to the documented target. They are scoped, not shortcuts that have to be undone.

| Now (Phase 0) | Documented target | Why now / how we upgrade |
|---------------|-------------------|--------------------------|
| **JavaScript (ESM)** | TypeScript ([11](docs/11-tech-stack.md)) | Zero build step; matches your `node:test` idiom. Adopt TS incrementally per package. |
| **`node:sqlite`** (built-in) | `better-sqlite3` v11 | No native dep → runs on Node 25 out of the box. Near-identical API; mechanical swap. |
| **SSE + POST** console channel | WebSocket + PTY (xterm.js) | True interactive PTY is Phase 1; the verb→MCP console is the right Phase-0 shape (and keeps every command audited rather than a raw PTY bypass). |
| **Kernel hosted host-side** in the Gateway | Kernel runs *inside* the Cell | Phase 1 moves it in; the Cell interface already isolates this. |
| **Implicit wake** on slug access | Scheduler with warm pool + hibernation budget | `cell.ensureRunning()` is the seam the Scheduler will own in Phase 1. |
| **Single seed tenant** | Full multi-tenant signup | The schema is already multi-tenant (tenant rows, per-Sandbox grants); Phase 4 flips on signup/billing. |

## Notes

- Runtime state lives under `~/.sandboxos/` (control DB + Cell volumes), gitignored.
- Cell backend auto-detects Docker; force it with `SANDBOXOS_CELL_BACKEND=local|docker`.
- The `local` backend has **no isolation** — it's for tests and Docker-less dev only.
- Not yet committed to git — review first, then commit when you're ready.
