# 10 · Data & Storage

> Where state lives, who owns it, and how it survives hibernation, backup, and moving
> between hosts.

SandboxOS has two storage worlds, matching the two planes: **control-plane state** (one
brain for the host) and **per-Sandbox state** (inside each Cell's volume). Keeping them
separate is what makes a Sandbox a portable, self-contained thing.

## Control-plane storage (the host)

A single embedded database (**`better-sqlite3`**, the v11 line for Node 25 — a known
constraint from your other projects) on the host holds everything the control plane
needs to route, schedule, secure, and bill:

- **tenants** — identities, billing status, quotas.
- **sandboxes** — slug, owner tenant, manifest pointer, Cell backend, resource limits.
- **cells** — current state (running/hibernated), host assignment (one host today),
  last-activity (for LRU hibernation), volume location.
- **principals & tokens** — sessions, machine tokens, their capability sets, expiry.
- **grants** — who may attach to / act on which Sandbox (the authorization table).
- **audit index** — a queryable index over the append-only audit stream (the bulk event
  data streams to the observability sink; the index makes it searchable).
- **billing/usage** — metered counters per tenant (dormant for one tenant, live for the
  product).

This is deliberately the same shape and tech as ServerHoster's control DB — proven,
fast, no external DB to operate on a home host.

## Per-Sandbox storage (the Cell volume)

Each Sandbox owns a **persistent volume** (a directory on the Mac Mini's fast SSD,
bind-mounted into its Cell). It is the entirety of the machine and contains:

- **The filesystem tree** — `/home`, `/projects`, whatever the Sandbox's `fs` server
  exposes (backed by disk or by Tide objects per the manifest).
- **The Tide object store** — content-addressed blobs/trees/commits/`State` objects: the
  Sandbox's versioned history and the substrate for sync and portability.
- **The Sandbox's local DB** — a per-Sandbox `better-sqlite3` for app/agent structured
  data. Each Sandbox has its *own* DB; nothing shared across Cells.
- **Secrets material** — encrypted; only the `secrets`/`vault` servers decrypt, only at
  point of use.
- **The manifest** — the `Sandboxfile`, itself a versioned Tide `State` object.

Hibernation persists this volume; wake re-attaches it; backup snapshots it; portability
moves it. **A Sandbox ≡ its volume + its manifest.** That identity is the linchpin of
hibernate/wake, fork, distro, and fleet migration.

## The Tide object store (per Sandbox)

The versioned core from [`05`](05-tide-protocol.md) lives here as a content-addressed
store on disk:

- **Dedup by hash** — identical content (across versions, across files) stored once.
- **Large/binary files chunked** — content-defined chunking so big assets dedup and
  transfer/resume efficiently.
- **History as a DAG** of tide marks; `State` objects carry non-file machine state.
- **Garbage collection / compaction** reclaims unreachable objects and compacts the
  history of long-lived live workspaces (a tracked open question in [`13`](13-open-questions.md)).
- Optionally **encrypted at rest**; optionally **tiered** to an object store (R2/S3) for
  cold history when a single SSD gets tight (Phase 5+).

## Backups & durability

- **Per-Sandbox backups** snapshot the volume (filesystem + Tide store + local DB) on a
  schedule via the `scheduler` server; because storage is content-addressed, incremental
  backups are cheap.
- **Control-plane backups** snapshot the host DB (it's small and critical).
- **Off-host copies** ride Tide: pushing a Sandbox's tree to a second location *is* an
  off-site backup, and the same operation that powers fleet migration.
- **Recovery** is reproducible-by-description: manifest + last good volume snapshot →
  rebuild the machine.

## Data ownership, residency & deletion

- **Ownership is per-tenant, per-Sandbox.** A tenant's data lives in their Cells' volumes
  and is reached only through their Kernel — the operator included (and audited).
- **Deletion is real.** Destroying a Sandbox destroys its volume (and, on request, its
  off-host Tide copies). GDPR/right-to-be-forgotten is a first-class operation, matching
  the compliance discipline from your aileadz/LEADer work.
- **Residency** (which host/region a Sandbox lives on) becomes a scheduling constraint in
  the fleet phase — designed for now by keeping the Sandbox self-contained and movable.

## Capacity reality on one Mac Mini

- **Hot set is small.** Most Sandboxes are hibernated (volume on disk, ~0 RAM/CPU); only
  the warm pool + actively-used Cells consume live resources. The Scheduler budgets this
  ([`04`](04-execution-substrate.md)).
- **Disk is the real ceiling** on a single box, not RAM — many hibernated volumes add up.
  Content-addressed dedup, compaction, and (Phase 5+) tiering cold objects to R2/S3 are
  the levers. When disk pressure is structural rather than tunable, that is the concrete
  signal to move from one Mac Mini to a fleet.
