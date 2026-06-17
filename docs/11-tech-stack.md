# 11 · Tech Stack

> Concrete choices, biased hard toward *what already runs on your Mac Mini* and *what you
> already have proven muscle for*. Every choice here has an escape hatch (the
> interchangeability principle) — these are strong defaults, not a cage.

## Host & runtime

- **Host:** Mac Mini (Apple Silicon), macOS. Single host for Phases 0–5.
- **Runtime:** Node.js (Homebrew Node 25.x is on the box). **Watch the C++20 native-
  module constraint** you've already hit — pin `better-sqlite3` to the **v11** line for
  Node 25. Language: **TypeScript** across the control plane and core servers.
- **Public exposure:** **Cloudflare Tunnel** (`cloudflared`) for NAT traversal +
  **Cloudflare for SaaS** for wildcard/custom domains. Already proven in ServerHoster &
  publisher-palace; re-establishes on boot.

## Execution substrate (Cells)

- **L1 / default:** **OrbStack** (preferred on Apple Silicon — fast, low-overhead Linux
  containers) or Docker. Each Sandbox = a container with a bind-mounted volume.
- **L2 / escalation:** **Firecracker** (or Cloud Hypervisor) microVMs, run inside a
  **Linux host-VM** via Apple **Virtualization.framework** (`vz`) — because Firecracker
  needs KVM and doesn't run natively on macOS.
- **L3 / special:** full VMs via Virtualization.framework.
- Abstracted behind a **Cell interface** (`create/wake/hibernate/snapshot/destroy/exec`)
  so the backend is a policy choice, not a rewrite.

## Control plane

- **Services:** TypeScript, **Fastify** (or Express — the FM-ECOM/ServerHoster idiom),
  for Gateway, Scheduler, Registry, observability sink.
- **DB:** **`better-sqlite3` v11**, single embedded control DB. No external DB to run.
- **Auth:** sessions (httpOnly secure cookies) + **Bearer machine tokens** — the
  existing pattern. Passkeys/OAuth for human login.
- **Proxy:** Gateway proxies HTTP/WebSocket/Tide channels into Cells; slug resolution in
  the request pipeline.

## The MCP layer

- **MCP SDK:** the official **TypeScript MCP SDK** for the Kernel (router/host) and core
  servers; **Python MCP SDK** allowed for servers where Python is the right tool (ML,
  scraping). MCP is language-agnostic by design — that's the point.
- **Kernel:** an in-process MCP **router/host** that registers servers (in-process,
  child-process via stdio, or remote), wraps every call with authZ/meter/audit, and
  exposes one unified MCP endpoint upward.
- **Transport:** local stdio/socket for in-Cell callers; WebSocket/QUIC (multiplexed)
  for remote callers through the Gateway.

## Agents & models

- **Models:** **Claude-first** — default to the latest Claude models (Opus 4.8 / Sonnet
  4.6 / Haiku 4.5; Fable 5 where it fits), via the Anthropic SDK. **Provider-abstracted**
  (the Brandify "OpenAI **or** Claude" services pattern, generalized) so other providers
  plug in. *(When building any AI feature here, consult the `claude-api` reference rather
  than guessing model IDs/pricing.)*
- **Agent runtime:** agents run as in-Cell processes that are MCP clients to the Kernel;
  spawned/supervised via the `agents` server.

## Tide

- **Object store:** content-addressed on disk (custom, git-inspired) with content-defined
  chunking for large/binary dedup; optional encryption at rest; optional R2/S3 tiering.
- **Live mirror:** file-watcher + persistent multiplexed channel; **CRDT** for text
  (library choice is a tracked decision — e.g. Yjs/Automerge-class); policy-based binary
  conflict handling.
- **Local daemon:** TypeScript, holds a machine token, exposes a local MCP server.

## Frontend (desktop & Command Central)

- **Desktop GUI:** a web **window manager** hosting app frontends + the terminal. Lean
  toward your proven **vanilla SPA + design-tokens (`tokens.css`)** discipline; a
  framework is allowed where it earns it. The `frontend-design` skill sets the quality
  bar — distinctive, polished, not generic-AI aesthetic.
- **Terminal:** **`xterm.js`** for the web Command Central.
- **Data viz:** a **shared, token-bound chart layer** (your standing first-class-dataviz
  bar): right-chart-for-the-question, dark-mode/a11y/k-anon safe.
- **`sbx` / `tide` CLIs:** TypeScript (Node single-file executable) or Go/Rust if a
  static, dependency-free binary matters for the local daemon.

## Repository shape (monorepo)

```
SandboxOS/
  docs/                     # the grand plan (this)
  apps/
    gateway/                # control plane: slug routing, authN, proxy
    scheduler/              # Cell lifecycle, warm pool, resource budgeting
    registry/               # tenants, sandboxes, tokens, grants  (+ control DB)
    desktop/                # web GUI (window manager + Command Central terminal)
  packages/
    kernel/                 # the MCP router/host
    mcp-servers/
      fs/  proc/  net/  secrets/  pkg/  scheduler/  tide/  agents/  mcp-registry/  kernel/
    tide/                   # protocol lib (object store, sync) + local daemon
    cell/                   # Cell interface + container/microVM backends
    capabilities/           # capability model + token minting/verification
    sbx-cli/                # the human CLI
    sdk/                    # public SDK for writing servers/apps/distros (Phase 6)
  distros/                  # reusable Sandbox definitions
```

This mirrors the architecture's control-plane/data-plane/MCP-server decomposition so the
folder you're in tells you which plane you're touching.

## Testing & ops

- **Tests:** `node:test` suites (the idiom across FM-ECOM/Brandify/aileadz). A
  **sandboxed test env prefix** so tests never touch the real control DB or `~`-level
  state — the lesson banked from survhub and the aileadz local-verify recipe.
- **CI/release:** the existing `release` / `release-changelog` discipline once there's a
  shippable artifact.
- **Boot smoke + per-plane integration tests** before any push.

## Decisions deferred (don't over-commit early)

Format of the manifest (TOML vs. other), the specific CRDT library, QUIC vs. WebSocket
for the live channel, and whether the desktop uses a framework — all are **swappable**
and intentionally left to the build phase that first needs them. See [`13`](13-open-questions.md).
