# 04 · Execution Substrate

> What actually runs when someone opens their slug — and how many of them fit on one
> Mac Mini.

The kickoff decision: **real isolated machines**, but realized on a **single Mac Mini**
host. So "real isolation" today means **containers** (real Linux userland, real
process/network/filesystem isolation) rather than a fleet of cloud VMs — with a
designed escalation path to **microVMs** and, later, **multiple hosts**.

## The Cell: levels of isolation

A **Cell** is the isolation boundary that executes one Sandbox. SandboxOS defines an
abstract Cell interface (`create`, `wake`, `hibernate`, `snapshot`, `destroy`,
`exec`) and provides multiple backends. The Scheduler picks a backend per Sandbox by
policy; the data plane (Kernel + servers) is identical regardless of backend.

| Level | Backend | Isolation | When |
|-------|---------|-----------|------|
| **L1** | Container (Docker/OrbStack on the Mac Mini's Linux VM) | Namespaces + cgroups: own FS, PIDs, network, resource caps | **Default, Phase 0–4.** Real Linux userland, fast, cheap. |
| **L2** | microVM (Firecracker/Cloud Hypervisor) inside a Linux host-VM | Own kernel — hardware-grade isolation | Untrusted multi-tenant workloads; on-demand escalation. |
| **L3** | Full VM (Apple Virtualization.framework `vz`) | Strongest, heaviest | Special cases; also the host for L2 on macOS. |

### The macOS reality (important)
Firecracker needs KVM and a Linux host — it does **not** run natively on macOS. On the
Mac Mini we therefore:

1. **Phase 0–4:** run containers via **OrbStack** (preferred on Apple Silicon — fast,
   low overhead) or Docker. Each Sandbox is a container. This is real isolation and
   real Linux, and it's enough to ship the personal OS and early multi-tenant product.
2. **When stronger isolation is needed:** run a **Linux host-VM** on the Mac Mini via
   Virtualization.framework, and run **Firecracker microVMs inside it**. The Scheduler
   gains an L2 backend; nothing in the data plane changes.

We do **not** block Phase 0 on microVMs. We ship on containers and escalate when
multi-tenant untrusted code demands kernel-level isolation. The Cell abstraction is
the insurance that this escalation is a backend swap, not a rewrite.

## Lifecycle: hibernate, wake, warm pool

One host has finite RAM/CPU, so the substrate is built around the assumption that
**most Cells are cold most of the time.** Lifecycle states:

```
   (none) ──create──► STOPPED ──wake──► RUNNING ──idle timeout──► HIBERNATING
                         ▲                  │                          │
                         └──────────────────┴────── persist volume ────┘
                                  destroy
```

- **RUNNING** — container up, Kernel live, serving requests.
- **HIBERNATING / STOPPED** — container stopped, **volume persisted to disk**. Near-zero
  RAM/CPU cost. The Sandbox still *exists*; it's just not hot.
- **Wake** — on a slug hit for a cold Sandbox, the Scheduler starts (or claims a
  warm-pool) Cell and attaches the persisted volume. Target: **single-digit seconds**.

### Warm pool
To make waking feel instant, the Scheduler keeps a few **pre-booted, unassigned Cells**
ready. A slug hit claims one and hydrates the Sandbox's volume into it, instead of
cold-booting a container. Pool size is a Scheduler policy tuned to host headroom.

### Snapshot/restore (later optimization)
For sub-second resume of a *running* process state (not just files), the L2 microVM
backend can use VM snapshots; the L1 container backend can explore CRIU
checkpoint/restore inside the Linux host-VM. This is a Phase 5 luxury — Phase 0–4 ship
fine with stop/start + persisted volumes + warm pool.

## Resource budgeting on one host

The Scheduler is the resource governor for the whole Mac Mini:

- Each Cell declares limits (CPU shares, memory cap, disk quota) from its manifest.
- The Scheduler tracks the **sum of running Cells** against host capacity and a
  reserved headroom for the control plane.
- Under pressure it: refuses to wake beyond budget (queues, with a "warming…" state),
  hibernates the **coldest** running Cells (LRU by last activity), and shrinks the
  warm pool.
- Per-tenant **quotas** (max concurrent running Cells, total disk) are enforced here —
  dormant for the single tenant, live and ready for multi-tenant.

This is the mechanism that lets a single Mac Mini honestly host "many machines": they
are real and isolated, but they take turns being hot.

## Storage & persistence per Cell

Each Sandbox has a **persistent volume** (a directory on the host's fast SSD,
bind-mounted into the Cell) holding: the filesystem tree, the Tide object store, the
Sandbox's local SQLite DB, secrets material (encrypted), and the manifest. Hibernation
persists this; wake re-attaches it. Backups snapshot it. Portability (Phase 6) moves
it — because **a Sandbox is its volume plus its manifest**, and Tide can move both.

## Networking & egress

- Each Cell gets an isolated network namespace; **inbound** reaches it only via the
  Gateway proxy (no Cell exposes ports to the host network directly).
- **Outbound (egress)** is policy-controlled by the `net` server and Cell config:
  default-deny or default-allow per Sandbox, with allowlists/denylists. Egress control
  is essential once Cells run untrusted agent code (see
  [`09-security-model.md`](09-security-model.md)).
- Inter-Cell traffic is **denied by default** — Cells are islands. Cross-Sandbox
  collaboration happens through explicit, audited Kernel-mediated channels, never
  ambient network reachability.

## The portability seam (why this scales past one box)

Because the Cell interface is abstract and a Sandbox is fully described by *manifest +
volume*, the path from one Mac Mini to a fleet is:

1. Scheduler/Registry learn about **multiple hosts**.
2. A Sandbox can be **scheduled onto any host** with capacity.
3. Tide moves the **volume** (versioned objects + live diff) to the target host.
4. The Kernel boots there identically.

Nothing in the data plane — Kernel, servers, agents, the user's mental model — changes.
The single-host constraint becomes a *scheduling policy*, not an architectural ceiling.
