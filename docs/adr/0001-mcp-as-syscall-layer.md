# ADR-0001 · MCP is the system-call interface

- **Status:** Accepted
- **Date:** 2026-06 (kickoff)
- **Deciders:** Tobias

## Context

SandboxOS must be agent-native, fully controllable, interchangeable, and auditable. The
classic OS contract — POSIX syscalls plus a sprawl of APIs/CLIs/GUIs — forces agents to
screen-scrape and shell out, scatters authorization across many mechanisms, and makes
uniform audit nearly impossible. Agents, meanwhile, already speak one clean protocol:
**MCP** (tool calls with typed schemas).

## Decision

**MCP is the system-call interface of SandboxOS.** Every capability — filesystem,
processes, network, secrets, packages, scheduling, sync, agents, the GUI, *and the OS's
own administration* — is exposed as an MCP server. The **Kernel** is an MCP router inside
every Cell that mediates every call (authenticate → authorize → route → meter → audit)
and presents one unified MCP endpoint. There is **no** privileged path that bypasses it.

## Consequences

**Positive**
- Agents use the OS with zero adapters — the catalog *is* the OS.
- Exactly one place to enforce authorization (capabilities = grantable tools) and one
  place to audit (one call kind → one event).
- Interchangeability is free: swap a server's implementation, callers unaffected.
- The OS is self-describing and self-administering (`mcp-registry`, `kernel` servers).

**Negative / costs**
- Tool calls are heavier than raw syscalls → requires an in-process fast path, batching,
  streaming, authz caching, async audit (see [`../03-mcp-kernel.md`](../03-mcp-kernel.md)
  and open question Q4). Must be benchmarked from Phase 0.
- All capability semantics must be expressible as MCP tool grants.

**Invariant established:** there is no effect on a Sandbox that is not a Kernel-mediated
MCP call producing exactly one audit event. Optimizations must stay *within* this model;
adding a non-MCP bypass for speed is forbidden.

## Alternatives considered

- **POSIX + adapters:** agents screen-scrape; fragmented authz/audit. Rejected — defeats
  the agent-native and auditability goals.
- **A bespoke RPC layer (not MCP):** loses the free interoperability with the existing
  agent/tool ecosystem. Rejected — MCP is the lingua franca we want to bet on.
