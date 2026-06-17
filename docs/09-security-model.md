# 09 · Security Model

> An AI-first OS runs untrusted-ish code (agents, installed servers, tenant workloads)
> with real capability. If you can't *contain* it and *prove* what it did, you don't
> have a product — you have a liability. Security is therefore a pillar, not a feature.

Three lines of defense, matching the three things that can go wrong:

1. **Capabilities** — a caller can do only what it was granted (limits *intent*).
2. **Isolation** — a Cell can't reach what it shouldn't (limits *blast radius*).
3. **Audit** — every effect is on the record (limits *deniability*, enables *response*).

## 1. Capability-based authorization

SandboxOS has **no ambient authority.** There is no "root" that implicitly can do
everything; there are only principals holding explicit capabilities.

- A **capability** grants: *these tools* on *these servers*, under *these limits*
  (quota, rate, time window, resource budget), optionally *on behalf of* another
  principal (delegation), optionally over *these resources* (e.g. only `/projects/foo`).
- A **principal** (human session, agent, machine token, installed server) holds a set
  of capabilities. Its power is exactly that set — nothing inherited by accident.
- The **Kernel enforces** on every call: **default deny.** Unlisted = forbidden.
- Capabilities are **delegable but attenuating**: an agent can hand a sub-agent a
  *subset* of its own capabilities, never a superset. Authority only narrows downstream.
- Capabilities are **revocable** and **expiring**; revocation invalidates the cached
  authz decision immediately.

This is the model that makes agents safe to run: you spawn an agent with precisely the
capabilities its task needs (`fs.read` on one tree, `net.fetch` to one host) and it is
*structurally* unable to exceed them — not "asked nicely not to."

## 2. Isolation (the blast radius)

Defense in depth, from the Cell outward:

- **Per-Cell isolation.** Each Sandbox runs in its own Cell (container today, microVM
  for untrusted multi-tenant — see [`04`](04-execution-substrate.md)). Own filesystem,
  PID namespace, network namespace, resource caps. No shared writable state between
  Cells.
- **Cells are islands.** Inter-Cell network traffic is **denied by default**. Cross-
  Sandbox interaction happens only through explicit, audited, Kernel-mediated channels —
  never ambient reachability. One compromised Sandbox cannot pivot to another.
- **Egress control.** Outbound network is policy-gated by the `net` server: default-deny
  or allowlist per Sandbox. This is the single most important control once Cells run
  agent-authored or marketplace code — it stops data exfiltration and call-home.
- **Installed servers are sandboxed.** A marketplace MCP server runs as its own
  principal in its own process with its own (minimal) capabilities and egress policy —
  installing a tool does not grant it your authority.
- **Control plane / data plane split.** The Gateway/Scheduler/Registry never execute
  tenant code and reach tenant data only through the Kernel (with audit, including the
  operator). A bug in an app can't escalate to "owns the host."

## 3. Audit & observability (the record)

Vision principle #3: everything is observable. Concretely:

- **Every MCP call → one audit event:** principal, on-behalf-of chain, tool, args
  (with secret values redacted), result/error, timestamp, Cell, capability used.
- Events stream to the control-plane **observability sink**, queryable per Sandbox and
  across all Sandboxes (operator), and via the `kernel.audit.query` tool (tenant, scoped
  to their own Sandbox).
- **Agent supervision** is built on this: `agent watch` is a live tail of an agent's
  audit stream. You can always see, and stop, what an agent is doing.
- **Tamper-evidence:** the audit log is append-only and hash-chained, so after-the-fact
  edits are detectable. Provenance you can actually rely on.

## Secrets

- The `secrets`/`vault` servers store secrets encrypted in the Cell's volume. Callers
  get **references/handles**, not raw values: `secrets.useInEnv` injects a secret into a
  spawned process's environment without the requesting agent ever seeing the value.
- Secret **values are redacted in audit logs** and never cross the Kernel boundary to a
  caller that only needs to *use* (not *read*) them.
- This generalizes the "keys never persisted / referenced not embedded" discipline from
  Brandify into an OS-level guarantee.

## The human↔agent supervision contract

Because the human (Command Central) and agents share one MCP fabric and one audit
stream:

- The human can **watch** any agent live, **pause/retire** it, and **narrow** its
  capabilities mid-flight.
- An agent operating **on the human's behalf** carries that delegation explicitly in the
  on-behalf-of chain — actions are attributable, and the agent's authority is a subset
  of the human's grant for that task.
- **Confirmation policies** (the propose→confirm pattern) gate high-impact actions:
  natural-language and agent-initiated effects above a configurable risk threshold are
  previewed for human approval before execution.

## Threats we explicitly design against

| Threat | Primary control |
|--------|-----------------|
| Agent does more than its task | Capabilities (default deny, attenuating delegation) |
| Compromised Sandbox pivots to another | Cells are islands; inter-Cell deny-by-default |
| Marketplace server is malicious | Sandboxed install, minimal grants, egress allowlist |
| Data exfiltration / call-home | `net` egress control, audited transfers via `tide` |
| Operator overreach into tenant data | Control/data split; operator access is audited too |
| Secret leakage | Reference-not-value, redaction, vault |
| Repudiation ("I didn't do that") | Hash-chained, append-only audit |
| Resource exhaustion / noisy neighbor | Scheduler quotas & per-Cell resource caps |
| Stolen machine token | Scoped, expiring, revocable; capability not identity |

## Non-negotiable invariants

1. **Default deny.** No capability listed → forbidden. No ambient root.
2. **Delegation only attenuates.** Downstream authority ⊆ upstream authority.
3. **No bypass.** Every effect is a Kernel-mediated MCP call → exactly one audit event.
4. **Isolation is per-Cell**, and Cells are islands by default.
5. **The operator is audited too.** There is no unlogged way to read tenant data.
6. **Secrets are referenced, not revealed**, to callers that only need to use them.
