# ADR-0002 · Tide = versioned core + live mirror

- **Status:** Accepted
- **Date:** 2026-06 (kickoff)
- **Deciders:** Tobias

## Context

SandboxOS needs to move data between a Sandbox and a local machine (and later between
hosts) "like Git, but not exactly Git." Two shapes were on the table: a snapshot/
content-addressed model (git-like: explicit, versioned, reproducible) and a live
continuous-sync model (CRDT/stream: real-time, conflict-free, feels like one machine).
The kickoff decision chose **both: live sync over a versioned core.**

## Decision

**Tide** is a content-addressed, versioned object store (blobs/trees/commits, plus typed
`State` objects for non-file machine state) — the **versioned core** — with a **live
mirror** layer on top. Each workspace independently selects **snapshot mode**
(`push/pull/diff/checkout`), **live mode** (`link` → real-time bidirectional sync, CRDT
for text, policy for binary, auto-committed as tide marks), or **both**. Tide is exposed
as a core **MCP server** so agents sync within the capability/audit fabric, and is the
mechanism for fork, distro sharing, and fleet portability — because a Sandbox *is* a Tide
tree.

## Consequences

**Positive**
- One protocol spans "sync a file" → "teleport a machine."
- Live ergonomics *with* full history (live mode still writes tide marks).
- Versioned core gives dedup, reproducibility, and offline tolerance for free.
- Carrying `State` objects (env, servers, agents, manifest) is what makes Sandboxes
  portable — the seam to the multi-host fleet.

**Negative / costs**
- Binary files have no clean CRDT → needs a conflict policy (open question Q2).
- Long-lived live workspaces need history compaction/GC.
- More complex than either pure model alone — justified by the 10-year portability goal.

## Alternatives considered

- **Snapshot-only (git-like):** simplest, but no liveness — local and cloud never feel
  like one machine. Rejected as the *whole* answer (kept as a mode).
- **Live-only (CRDT/stream):** great ergonomics, weak history/reproducibility, can't
  cleanly carry machine state. Rejected as the *whole* answer (kept as a mode).
- **Just use git:** no liveness, painful conflicts, file-only, no capability/audit
  integration. Rejected — it's the inspiration, not the tool.

## Notes

Name **Tide**, CLI verb `tide`, glyph `⇌` are provisional (fit the sand/shore metaphor).
Detail in [`../05-tide-protocol.md`](../05-tide-protocol.md).
