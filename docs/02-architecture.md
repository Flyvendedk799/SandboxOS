# 02 · Architecture

## The shape, in one diagram

```
                         the internet
                              │
                  ┌───────────┴───────────┐
                  │   Cloudflare Tunnel     │  (public TLS, wildcard for-SaaS domains,
                  │   + for-SaaS wildcard   │   home-NAT traversal — no open ports)
                  └───────────┬───────────┘
                              │
══════════════════ MAC MINI (the host) ══════════════════════════════════════
                              │
        ┌─────────────────────┴─────────────────────┐
        │              CONTROL PLANE                  │   (operator-only, never a
        │  ┌────────────┐  ┌──────────┐  ┌─────────┐ │    tenant's to touch directly)
        │  │  Gateway    │  │ Scheduler │  │ Registry │ │
        │  │ slug→Cell   │  │ wake/hib. │  │ of Cells │ │
        │  │ authN/proxy │  │ warm pool │  │ + tenants│ │
        │  └─────┬──────┘  └────┬─────┘  └────┬────┘ │
        │        │  control-plane DB (sqlite) │      │
        └────────┼───────────────┼────────────┼──────┘
                 │ proxy          │ lifecycle  │
   ┌─────────────┼────────────────┼────────────┼───────────────┐
   │             ▼                ▼            ▼      DATA PLANE  │
   │   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  │
   │   │   CELL: tobias │  │  CELL: acme   │  │  CELL: …       │  │
   │   │ ┌───────────┐ │  │ ┌───────────┐ │  │               │  │
   │   │ │  KERNEL    │ │  │ │  KERNEL    │ │  │   (hibernated │  │
   │   │ │ MCP router │ │  │ │ MCP router │ │  │    on disk)   │  │
   │   │ └─────┬─────┘ │  │ └───────────┘ │  │               │  │
   │   │  fs proc net  │  │  fs proc net  │  └───────────────┘  │
   │   │  secrets pkg  │  │  secrets pkg  │                      │
   │   │  tide agents  │  │  tide agents  │   each Cell = one    │
   │   │  desktop apps │  │  …            │   isolated machine    │
   │   └───────────────┘  └───────────────┘                      │
   └────────────────────────────────────────────────────────────┘
                 ▲                                  ▲
                 │ MCP over secure channel          │ Tide channel
        ┌────────┴────────┐               ┌─────────┴─────────┐
        │ Command Central │               │   Tide daemon      │
        │ (web term / sbx)│               │ (local mirror +    │
        │  from anywhere  │               │  local MCP server) │
        └─────────────────┘               └───────────────────┘
                 ▲                                  ▲
                 └──────────── your laptop ─────────┘
```

## The two planes

SandboxOS is cleanly split into a **control plane** (host-level, operator-only) and a
**data plane** (inside each Cell, tenant-facing). This split is the single most
important structural decision: it is what lets one operator on one Mac Mini run both a
personal OS and a multi-tenant product without the two leaking into each other.

### Control plane (the host)
Runs on the Mac Mini host (macOS), not inside any Cell. TypeScript services backed by
a single control-plane SQLite database. Responsibilities:

- **Gateway** — terminates the public request, resolves `slug → Sandbox → Cell`,
  authenticates the caller, asks the Scheduler to wake the Cell if needed, and proxies
  the connection (HTTP, WebSocket, and the Tide channel) into the Cell's Kernel.
- **Scheduler** — owns Cell lifecycle: wake, hibernate, the warm pool, resource
  budgeting across all Cells (critical on a single host — see
  [`04-execution-substrate.md`](04-execution-substrate.md)).
- **Registry** — the source of truth for tenants, Sandboxes, slugs, Cell state,
  machine tokens, and capability grants at the tenant level.
- **Observability sink** — collects audit/event streams emitted by every Kernel so
  the operator can see across all Sandboxes.
- **Billing/quotas** — meters usage per tenant (designed in from v0, dormant while
  there is one tenant).

The control plane never executes tenant workloads and never has ambient access into a
Cell's data. It can *manage* a Cell (start/stop/snapshot) but reads tenant data only
through the Kernel, with audit — including the operator.

### Data plane (inside a Cell)
Everything a tenant's Sandbox actually *is* lives here, behind the **Kernel**:

- The **Kernel** (MCP router) is the only entry point. Command Central, agents, the
  GUI, and the Tide daemon all connect to it and speak MCP.
- **Core MCP servers** provide the OS primitives (`fs`, `proc`, `net`, `secrets`,
  `pkg`, `scheduler`, `tide`, `agents`, `mcp-registry`).
- **Platform + installed servers** provide the desktop, apps, databases, and any
  third-party capability.
- Persistent **storage volume** holds the filesystem, the Tide object store, the
  Sandbox's local DB, and its manifest.

## Request lifecycles (how it actually flows)

**Opening a Sandbox (web):**
1. Browser hits `sandboxos.dev/tobias`.
2. Gateway authenticates the session, looks up the slug in the Registry.
3. If the Cell is hibernated, Gateway asks the Scheduler to wake it (or claim a
   warm-pool Cell and hydrate the volume). Target: seconds.
4. Gateway proxies the browser to the Cell's Kernel; the desktop/terminal loads.
5. Every action the user takes becomes an MCP call to the Kernel, authorized against
   the session's capabilities and audited.

**An agent doing work:**
1. The `agents` server spawns an agent process inside the Cell with a capability set.
2. The agent connects to the Kernel as an MCP client and discovers available tools.
3. It calls tools (`fs.read`, `proc.spawn`, an installed server) — each checked and
   logged. It cannot reach anything it wasn't granted.

**Syncing with your laptop:**
1. The Tide daemon on the laptop holds a machine token; it connects through the
   Gateway to the Cell's `tide` server over the Tide channel.
2. Snapshot mode: explicit `tide push/pull/diff`. Live mode: a persistent channel
   mirrors changes both ways, auto-committing tide marks into the versioned core.

## Why this fits one Mac Mini (and grows past it)

A single host has finite RAM/CPU, so **not every Sandbox can be hot at once**. The
architecture absorbs this in the Scheduler:

- Cells **hibernate** to disk when idle (persist volume, stop the container).
- A **warm pool** of pre-booted Cells makes waking feel instant.
- The Scheduler **budgets** concurrent live Cells against host resources and queues or
  hibernates the coldest when pressure is high.

Because a Sandbox is **manifest + data + Tide objects**, the *same* Sandbox can later
be scheduled onto a *different* host. That is the seam through which the single Mac
Mini becomes a multi-host fleet (roadmap Phase 6) with no change to the data plane —
only the Scheduler and Registry learn about multiple hosts.

## What's deliberately centralized vs. distributed

- **Centralized (control plane):** routing, auth, scheduling, billing, cross-Sandbox
  audit. One brain. Simple, on one host, today.
- **Distributed (data plane):** each Cell is self-contained and speaks only MCP +
  Tide. A Cell knows nothing about other Cells. This isolation is the security model
  *and* the portability model at once.

## Mapping to what you already run

This shape is deliberately close to your existing **ServerHoster** and
**publisher-palace** patterns — a control-plane Node service on a home host, Cloudflare
Tunnel + Cloudflare-for-SaaS for public wildcard domains, `better-sqlite3` for the
control DB, Bearer/machine-token auth, per-project clones in a data directory. We are
reusing proven muscle, not inventing infrastructure from scratch. See
[`11-tech-stack.md`](11-tech-stack.md).
