# 13 · Open Questions & Risks

> The honest list. A 10-year project earns trust by naming what it hasn't solved yet.
> Each item says what's undecided, why it's hard, and the *current lean* so we don't
> re-litigate from zero. Decisions that change the architecture get an ADR in
> [`adr/`](adr).

## Architecture-shaping (decide before the phase that needs them)

### Q1 · Container vs. microVM as the *default* Cell
**Tension:** containers are cheap/fast and real-Linux (great for one operator + early
tenants); microVMs give kernel-grade isolation needed for untrusted multi-tenant code,
but don't run natively on macOS (need a Linux host-VM).
**Lean:** containers (L1) through Phase 4; microVMs (L2) escalation when untrusted
tenants arrive. The Cell abstraction makes this a backend swap. *Revisit at Phase 4.*

### Q2 · CRDT choice & binary-conflict policy for Tide live mode
**Tension:** text CRDTs (Yjs/Automerge-class) are solved-ish but differ in memory/history
cost; arbitrary **binary** files have no clean CRDT. Long-lived live workspaces also need
history compaction.
**Lean:** CRDT for text; last-writer-wins + preserved conflict copy for binary
(configurable); auto-mark interval + periodic compaction. *Decide at Phase 2; ADR it.*

### Q3 · How much non-file state lives in Tide `State` objects
**Tension:** putting env, enabled servers, agent defs, and the manifest into versioned
`State` objects is what makes a Sandbox portable — but `State` may need different
diff/merge semantics than file trees, and some state (live process memory) can't be
captured this way.
**Lean:** manifest + declarative config in `State`; *not* live process memory (that's the
microVM snapshot's job, Phase 5). *Refine across Phases 2 and 5.*

### Q4 · MCP-as-syscall performance envelope
**Tension:** tool calls are heavier than syscalls; the model only works if it's fast
enough. Mitigations (in-process fast path, batching, streaming, authz caching, async
audit) are designed but unproven at load.
**Lean:** ship Phase 0–1 measuring real call latency; if a hot path is too slow, optimize
*within* the model (never add a non-MCP bypass — that breaks invariant #1). *Benchmark
continuously from Phase 0.*

### Q5 · Origin model: path slugs vs. subdomain slugs
**Tension:** path form (`/tobias`) is simplest; subdomain form (`tobias.host`) gives true
browser-origin isolation needed before serving untrusted tenant web apps.
**Lean:** path form Phase 0–3; wildcard subdomains for the product (Phase 4) via
Cloudflare for SaaS. Both already modeled as "resolve a slug."

## Product & scope

### Q6 · How "Linux" is inside a Cell?
Do tenants get a full Linux userland (apt, arbitrary binaries) or a curated runtime?
Full Linux is more powerful and more dangerous; curated is safer and more "appliance."
**Lean:** full Linux userland inside the Cell (real power), contained by Cell isolation +
egress control rather than by limiting what's installable. *Revisit if abuse appears.*

### Q7 · Where the natural-language console agent runs
In-Cell (per-Sandbox, sees only that machine) vs. control-plane (shared, cross-Sandbox)?
In-Cell is safer and properly scoped; control-plane is cheaper to operate.
**Lean:** in-Cell, scoped to the Sandbox's capabilities — consistent with the security
model. *Decide at Phase 3.*

### Q8 · Manifest format
TOML (readable, your idiom) vs. something with richer typing/programmability.
**Lean:** TOML to start; keep the *schema* stable and the *serialization* swappable.

## Operational & risk

### Q9 · Single Mac Mini as a single point of failure
For the personal OS, acceptable. For paying tenants, not. Backups (volume + control DB)
and Tide off-host copies mitigate data loss, but uptime needs the fleet.
**Lean:** rigorous backup/restore from Phase 4; don't take meaningful paid load until
multi-host (Phase 5). *Be honest in product positioning about this.*

### Q10 · Disk as the real ceiling on one host
Many hibernated volumes fill an SSD faster than RAM fills. Dedup/compaction/tiering help;
structural pressure is the signal to go multi-host.
**Lean:** instrument disk from Phase 1; tier cold Tide objects to R2/S3 at Phase 5.

### Q11 · Node 25 native-module constraint
The C++20/`better-sqlite3` issue you've already hit. Pin to v11; watch any native dep.
**Lean:** banked lesson — keep native deps minimal and version-pinned.

### Q12 · Marketplace trust & abuse
Open ecosystem invites malicious servers and resource abuse.
**Lean:** sandboxed installs, minimal capability grants, egress allowlists, signing, and
ratings (Phase 6) — security model already contains an installed server like any principal.

### Q13 · Cost & rate-limit exposure of pervasive AI
An AI-native OS can run up real model/compute cost, especially with autonomous agents.
**Lean:** per-tenant quotas and budgets (the billing entities exist from v0); provider
abstraction to optimize cost/quality per task; default confirmation gates on expensive
autonomous loops.

## Naming (cosmetic, low-stakes, decide whenever)

- **Tide** (protocol), **Cell** (isolation unit), **Sandboxfile** (manifest), the `⇌`
  glyph — all provisional. Concepts are settled; better words are welcome. Don't let
  naming bikeshedding block the spine.

---

### How to use this file
When you start a phase, scan it for items tagged to that phase, resolve them (an ADR if
they shape the architecture), and move them out of "open." Add new questions as the build
teaches you things. This file should *shrink at the top and grow at the bottom* over the
years — that's the shape of a project learning what it actually is.
