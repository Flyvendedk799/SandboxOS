# 12 · Roadmap

> The arc lives in [`00-vision.md`](00-vision.md); this is the schedule. Time ranges are
> *order-of-magnitude*, not commitments — this is a 10-year project for one builder plus
> a fleet of agents. Every phase ships a **load-bearing spine** the next phase extends.
> We never build a demo we throw away.

## Phase 0 · The Spine — *prove it runs* (months 0–3)

**Goal:** a slug resolves to a real isolated machine you can type into, controlled
entirely through MCP. The thinnest possible end-to-end vertical.

- Monorepo + control DB (`better-sqlite3` v11) + test harness with a safe sandboxed env.
- **Gateway**: resolve `sandboxos.dev/<slug>` → proxy into a container, behind a
  **Cloudflare Tunnel**. One hardcoded Sandbox.
- **Cell**: one container (OrbStack/Docker) with a persistent volume.
- **Kernel** MVP: MCP router with `fs` + `proc` servers, authZ + audit wrapper.
- **Command Central** MVP: web terminal (`xterm.js`) → shell verbs → `fs`/`proc` calls.
- Basic session login.

**Done when:** you open your slug from your phone, `ls` your Cell's filesystem, run a
command, and see both actions in the audit log. *The spine is alive.*

## Phase 1 · Kernel & Command Central — *make it a real OS* (months 3–9)

**Goal:** the full kernel ABI and a console worth living in; the capability and
hibernate/wake machinery that everything else depends on.

- Remaining **core servers**: `net`, `secrets`, `pkg`, `scheduler`, `mcp-registry`,
  `kernel` (self-admin).
- **Capability model**: default-deny, scoped/expiring/attenuating grants, `sbx login`
  machine tokens, the grants table.
- **Command Central** full: three input modes (shell / raw MCP / first NL), `agent
  watch`-style audit tailing, `sbx` CLI.
- **Scheduler**: hibernate/wake, warm pool, per-Cell resource budgeting on the one host.
- **Manifest** (`Sandboxfile`) drives Sandbox composition; multi-Sandbox per tenant.

**Done when:** you run several Sandboxes that sleep and wake on demand, each composed
from a manifest, each controllable from anywhere, with default-deny capabilities enforced.

## Phase 2 · Tide — *local and cloud become one* (months 9–15)

**Goal:** the data-movement story, end to end.

- **Versioned core**: object store, `tide init/mark/push/pull/diff/checkout/log`.
- **Local Tide daemon**: machine token, local MCP server, file watcher.
- **Live mirror**: `tide link`, CRDT text merge, binary conflict policy, auto-marks.
- `tide` exposed as a **core MCP server** so agents sync too.
- `State` objects (env, servers, agents, manifest) → a Sandbox is a Tide tree.

**Done when:** you edit a file on your laptop and it appears in your Sandbox live, with
full history, and an agent can `tide push` its results back to you.

## Phase 3 · Agent-Native — *the OS for AI* (months 15–24)

**Goal:** agents as first-class citizens and the app/marketplace ecosystem's first form.

- **`agents` server**: spawn/supervise/orchestrate, capability-scoped, on-behalf-of
  delegation, multi-agent coordination.
- **Natural-language Command Central** matured (propose→confirm, risk-gated).
- **MCP marketplace** via `mcp-registry`: install/verify/sandbox third-party servers.
- **App model + desktop GUI**: window manager, app = frontend + MCP server, token-bound
  theming and the shared dataviz layer.

**Done when:** you delegate real multi-step work to a fleet of scoped agents, watch and
steer them live, and install marketplace tools they can immediately use.

## Phase 4 · The Product — *multi-tenant for real* (year 2–3)

**Goal:** flip on the multi-tenant product the architecture has been ready for since v0.

- **Signup/onboarding**, tenant self-service, vanity domains (Cloudflare for SaaS).
- **Billing & quotas** activated (entities existed from day one — now metered/enforced).
- **Hardened isolation**: microVM (L2) backend for untrusted tenants; egress controls
  tightened; security review pass.
- **Distros**: fork/share/instantiate whole Sandboxes; a starter distro gallery.

**Done when:** a stranger signs up, gets an isolated machine at their slug in <60s,
from a distro, billed and quota'd — on the same Mac Mini, safely.

## Phase 5 · Fleet & Scale — *past one box* (year 3–5)

**Goal:** remove the single-host ceiling without touching the data plane.

- **Multi-host** Scheduler/Registry; Sandbox **portability via Tide** (move volume +
  manifest, boot identically elsewhere).
- **microVM-first** for untrusted workloads; snapshot/restore for sub-second resume.
- **Storage tiering** (cold Tide objects → R2/S3); regions/residency as scheduling
  constraints.
- Reliability: HA control plane, backup/restore drills, observability at fleet scale.

**Done when:** Sandboxes schedule across several hosts and migrate live, and the
single-Mac-Mini origin is just one node.

## Phase 6 · The Ecosystem — *the substrate others build on* (year 5–10)

**Goal:** SandboxOS as an open platform — "the Linux of agent OSes."

- **Public SDK**: write MCP servers, apps, distros, Cell backends against stable
  contracts.
- **Open marketplace** with trust/signing, revenue share, ratings.
- **Self-host distribution**: run your own SandboxOS instance; federation between them.
- Standards work: contribute the capability/audit and Tide patterns back to the MCP
  community.

**Done when:** people you've never met ship servers, apps, and distros others depend on,
and organizations self-host SandboxOS as infrastructure.

---

## The through-line

Each phase's spine is the next phase's foundation:

```
slug→Cell→Kernel(fs,proc)         [P0]
   └─► full kernel + caps + console + hibernate/wake   [P1]
          └─► Tide moves data & state                  [P2]
                 └─► agents + apps + marketplace        [P3]
                        └─► multi-tenant product         [P4]
                               └─► multi-host fleet       [P5]
                                      └─► open ecosystem    [P6]
```

Nothing above is throwaway. The Cell interface, the manifest, capabilities, and Tide are
introduced early *specifically* because Phases 4–6 depend on them — so the cheap thing
in Phase 0 is already the right thing in year 10.
