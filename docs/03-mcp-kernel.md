# 03 · The MCP Kernel

> The central, load-bearing idea of SandboxOS: **MCP is the system call interface.**

In a traditional OS, programs request the kernel's services through *syscalls* — a
fixed, numbered ABI (`open`, `read`, `fork`, `socket`…). In SandboxOS, programs —
including agents and the human at Command Central — request the OS's services through
**MCP tool calls**. The Kernel is the thing that receives those calls, decides whether
they're allowed, routes them to the right server, and records that they happened.

This is not MCP *bolted onto* an OS. It is an OS whose ABI *is* MCP. That single
choice is what delivers every headline property: agent-native (agents already speak
MCP), fully controllable (everything is a tool), interchangeable (swap a server),
auditable (one chokepoint), and secure (capabilities = grantable tools).

## What the Kernel is

A small, fast MCP router that runs inside every Cell. It is the **only** way into a
Sandbox. It does five things, on every single call:

1. **Authenticate** the caller (session, agent identity, or machine token).
2. **Authorize** against the caller's capabilities — may it invoke *this tool* on
   *this server* under *these limits*?
3. **Route** the call to the target MCP server (in-process, child-process, or remote).
4. **Meter & guard** — rate limits, quotas, resource budgets, timeouts.
5. **Audit** — emit a structured event (who/what/when/on-behalf-of/result) to the
   observability stream.

It exposes **one unified MCP endpoint** upward. Callers see a single, coherent tool
catalog — the union of every enabled server, namespaced — and never connect to
individual servers directly. The Kernel is the membrane.

```
   agents ─┐
   Command │        ┌──────────────────────────────────────────┐
   Central ┼──MCP──►│                 KERNEL                     │
   the GUI │        │  authN → authZ → route → meter → audit     │
   Tide    ┘        └───┬───────┬───────┬───────┬───────┬───────┘
                        ▼       ▼       ▼       ▼       ▼
                       fs     proc    net    secrets  agents   …  (MCP servers)
```

## The server taxonomy ("MCP from top to end")

Every capability of the OS is an MCP server. Three tiers:

### 1. Core servers (the kernel ABI — always present)
These are to SandboxOS what syscalls are to Linux. Stable, minimal, present in every
Sandbox:

| Server | Provides | Example tools |
|--------|----------|---------------|
| `fs` | Filesystem | `read`, `write`, `append`, `list`, `stat`, `mkdir`, `remove`, `move`, `copy`, `tree`, `search`, `readBytes`, `writeBytes` |
| `proc` | Processes | `exec`, `list`, `signal`, and supervised jobs: `start`, `logs`, `jobs`, `stop`, `forget` |
| `net` | Networking | `fetch`, `listen`, `forward`, `resolve` (policy-gated) |
| `secrets` | Secret references | `put`, `getRef`, `useInEnv` (values never returned raw) |
| `pkg` | Software install | `install`, `remove`, `list` (language/runtime packages) |
| `cron` | Time/cron | `at`, `every`, `cancel`, `list` (named `cron` in the build, to keep it distinct from the control-plane Scheduler) |
| `ports` | Reachability | `expose`, `unexpose`, `list`, `check`, `scan` — the Gateway proxies exposed ports |
| `metrics` | Observability | `snapshot`, `history`, `activity`, `recent` |
| `tide` | Sync protocol | `push`, `pull`, `link`, `diff`, `checkout`, `log` |
| `agents` | Agent lifecycle | `spawn`, `list`, `message`, `pause`, `retire` |
| `mcp-registry` | MCP management | `install`, `enable`, `disable`, `configure`, `list` |
| `kernel` | Self-administration | `whoami`, `capabilities`, `audit.query`, `manifest.get/set` |

The presence of `mcp-registry` and `kernel` is what "full MCP control" means: you
administer the operating system — including which servers exist and what you're
allowed to do — *through MCP itself*. There is no privileged side channel.

### 2. Platform servers (the product layer)
Ship with the product, can be disabled per Sandbox: `desktop` (the web GUI window
manager), `apps` (installed applications), `db` (managed databases), `vault`
(higher-assurance secret storage), `billing` (tenant metering), `observability`
(metrics/logs/traces query).

### 3. Installed servers (the open universe)
Anything else, from the marketplace or hand-written: Gmail, Google Calendar, Google
Drive, GitHub, a company's internal API, a bespoke tool. Installed via `mcp-registry`,
scoped by capabilities, sandboxed like any other server.

## Why "everything is an MCP server" earns its keep

- **Agents need no adapters.** An agent's entire world is the MCP catalog. No GUI
  scraping, no shelling out to guess at a CLI's flags. It introspects tools, reads
  their typed schemas, and calls them. The OS is *legible* to the agent.
- **Uniform authorization.** There's exactly one place to enforce "may this caller do
  this?" — the Kernel — because there's exactly one kind of call. Compare to a
  conventional OS with files, sockets, signals, ioctls each needing their own model.
- **Interchangeability is free.** The `fs` server's *interface* (`read`/`write`/…) is
  the contract. Back it with local disk, an object store, or Tide content-addressed
  objects — callers never change. Same for `db`, `secrets`, anything.
- **Audit is total.** One chokepoint means *every* effect on the system is on the
  record, including the operator's and including OS self-administration.
- **Composability.** Servers can call the Kernel too. A high-level app server
  implements its tools by calling `fs` + `db` + `net` — the same way a user would.

## Performance: a tool-call ABI that isn't slow

Making MCP the syscall layer raises an obvious worry: MCP calls are heavier than
syscalls. We address it structurally, not by abandoning the model:

- **In-process fast path.** Core servers run in the Kernel's process; their "calls"
  are function calls with the authz/audit wrapper, not network round-trips.
- **Local-first for agents in-Cell.** An agent in the same Cell talks to the Kernel
  over a local socket/stdio, not the network.
- **Batching & streaming.** The Kernel supports batched tool calls and streaming
  results (tail a log, stream a build) so chatty workloads aren't N round-trips.
- **Capability caching.** Authorization decisions for a session are cached with
  invalidation on grant change — authz is a hot path, so it's a lookup, not a
  re-derivation.
- **Async audit.** Audit events are emitted to a buffered async sink off the critical
  path; the call doesn't wait on durable write except where policy demands it.

The goal is not "as fast as a raw syscall." It's "fast enough that the uniformity,
security, and legibility are an obvious win." For the workloads SandboxOS targets —
agents orchestrating files, processes, and network — it is.

## The Kernel administers itself

Two reflexive servers close the loop and make the system fully self-describing:

- **`mcp-registry`** — installs/enables/disables/configures servers. Reconfiguring the
  OS is an MCP transaction, captured in the manifest and the audit log.
- **`kernel`** — `whoami`, `capabilities` (what can *I* do right now?), `audit.query`
  (what has happened?), `manifest.get/set` (the Sandbox's declarative definition).

Because the OS is administered through MCP and described by a manifest, an agent can
*reason about and reshape its own machine* within its granted capabilities — install a
tool it needs, schedule a job, fork a workspace — all observable, all reversible, all
inside the same fabric the human supervises.

## Invariants (must always hold)

1. There is **no** path into a Sandbox that bypasses the Kernel.
2. **Every** effect is one MCP call and produces **one** audit event.
3. A caller can invoke **only** tools its capabilities grant — default deny.
4. Core server *interfaces* are stable; *implementations* are swappable.
5. The Kernel is itself reachable only as MCP (`kernel`, `mcp-registry`) — even
   self-administration obeys capabilities and audit.
