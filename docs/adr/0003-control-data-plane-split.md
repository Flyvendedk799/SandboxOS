# ADR-0003 · Control plane / data plane split

- **Status:** Accepted
- **Date:** 2026-06 (kickoff)
- **Deciders:** Tobias

## Context

SandboxOS is, by explicit decision, **both** a personal OS for one operator and a
multi-tenant product — from day one, on a single Mac Mini. We need a structure that lets
one tenant (you) and many tenants share infrastructure without the two leaking into each
other, and that scales from one host to a fleet without rewriting the part tenants touch.

## Decision

Split the system into:

- **Control plane** (host-level, operator-only): Gateway (slug routing, authN, proxy),
  Scheduler (Cell lifecycle, warm pool, resource budget), Registry (tenants, sandboxes,
  tokens, grants), observability sink, billing. One brain per host. Backed by a single
  embedded control DB.
- **Data plane** (inside each Cell, tenant-facing): the Kernel and its MCP servers —
  everything a Sandbox *is*. Reached only through the Kernel.

The control plane **routes, schedules, secures, and bills**; it never executes tenant
workloads and reaches tenant data only through the Kernel, **with audit — including the
operator.** A Sandbox is self-contained (manifest + volume + Tide tree) so it can be
scheduled onto any host.

## Consequences

**Positive**
- Multi-tenant correctness from v0 with one tenant: the single-tenant phase is just the
  multi-tenant system with one row in the tenant table.
- Clean security boundary: a bug in an app/server can't escalate to "owns the host"; the
  operator can't silently read tenant data.
- **Portability seam:** because the data plane is self-contained, going multi-host (Phase
  5) changes only the Scheduler/Registry — the data plane and the user's mental model are
  untouched.
- Folder structure mirrors the split, so location signals which plane you're editing.

**Negative / costs**
- Slightly more upfront structure than a single monolithic process would need for one
  user — accepted deliberately to avoid a multi-tenancy retrofit later.

## Alternatives considered

- **Single-tenant monolith now, refactor to multi-tenant later:** rejected — the kickoff
  explicitly wants multi-tenant from the start, and isolation/quotas/billing are
  expensive and dangerous to retrofit into a system that assumed one user.
- **Per-tenant full stack (no shared control plane):** wasteful on one host and makes
  cross-Sandbox scheduling/audit impossible. Rejected.
