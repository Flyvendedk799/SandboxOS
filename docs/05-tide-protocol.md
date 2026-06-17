# 05 · Tide — the data-sync protocol

> "Something that easily sends data like Git, but not exactly Git, so you can move data
> from your virtual machine to your local machine and vice versa."

**Tide** is that thing. It is the protocol and the tool for moving data between a
Sandbox and your local machine (and, later, between hosts). Per the kickoff decision,
it is **a versioned, content-addressed core** (git-like: push/pull/diff/checkout) with
a **live mirror** layer on top (real-time bidirectional sync) — and each workspace
picks snapshot mode, live mode, or both.

It is **not a new language.** It is a protocol with a small command vocabulary, exactly
like git is. CLI verb: `tide`. Conceptual glyph: `⇌` (bidirectional equilibrium).
Name is provisional (it fits the sand/shore metaphor); the design below is not.

## Why not just use git?

Git is the right *inspiration* and the wrong *tool* for this job:

| Need | Git | Tide |
|------|-----|------|
| Versioned history of files | ✅ | ✅ (same content-addressed model) |
| **Live, continuous** bidirectional sync | ❌ manual snapshots only | ✅ live mirror layer |
| **Conflict-free** concurrent edits | ❌ painful merges | ✅ CRDT for text, policy for binary |
| Sync **non-file state** (env, enabled MCP servers, agent defs) | ❌ | ✅ first-class object kinds |
| **Capability-scoped, audited** transfer | ❌ | ✅ every transfer is MCP-mediated |
| **Move a whole machine** between hosts | ❌ | ✅ a Sandbox *is* a Tide tree |
| Streaming large/binary efficiently | ⚠️ awkward | ✅ chunked, content-addressed dedup |

Tide keeps git's best idea — **content-addressed, versioned objects** — and adds the
three things git lacks for an agent OS: liveness, conflict-freedom, and the ability to
carry *all* of a Sandbox's state, not just files.

## The object model (the versioned core)

Like git, Tide is a content-addressed object store. Four object kinds:

- **Blob** — opaque bytes (a file's contents, chunked for large/binary dedup).
- **Tree** — a named map of entries (dirs → blobs/trees), the shape of a workspace.
- **Commit** ("**tide mark**") — a snapshot: root tree + parents + author + time +
  message. The history.
- **State** — a typed, structured object for *non-file* Sandbox state: environment,
  enabled MCP servers + their config, agent definitions, manifest. This is what lets
  Tide move a *machine*, not just a folder.

Every object is addressed by the hash of its content. Identical content stored once.
History is a DAG of tide marks. This is reproducibility and dedup for free.

## The two modes (pick per workspace)

A **Tide workspace** is a directory (or a whole Sandbox) under Tide management. Each
workspace independently chooses:

### Snapshot mode — explicit, git-like
For code, releases, anything you want deliberate and reproducible.

```
tide init                 # make this dir a Tide workspace
tide status               # what changed since the last tide mark
tide mark -m "message"    # commit a snapshot (like git commit)
tide push                 # send marks to the remote (Sandbox or host)
tide pull                 # fetch + apply remote marks
tide diff <a> <b>         # compare two marks / working tree
tide checkout <ref>       # move working tree to a mark
tide log                  # history of tide marks
```

### Live mode — continuous, conflict-free
For "my laptop and my Sandbox are one machine." Start it and forget it.

```
tide link [path]          # begin live bidirectional mirror for this workspace
tide unlink               # stop the live mirror (history is preserved)
tide flow                 # show live status: pending, conflicts, lag
```

Under live mode:
- A **file watcher** on each side streams changes over a persistent channel.
- **Text** merges via CRDT (conflict-free) — concurrent edits converge without manual
  resolution. **Binary** files use a policy (default: last-writer-wins with a
  conflict copy preserved; configurable per workspace).
- Changes are **auto-committed as tide marks** on an interval / quiet point, so live
  mode *still has full history* — the versioned core underpins the live layer. You can
  always `tide log` / `tide checkout` a live workspace.

### Both
A workspace can be **linked (live) and also pushed (snapshot)**: live for everyday flow,
explicit `tide mark`/`tide push` for meaningful checkpoints and sharing. Live is the
fast loop; marks are the durable record. This is the intended default for active work.

## Selective sync (not everything, everywhere)

You rarely want the *whole* Sandbox mirrored to a laptop. Tide supports **scoped
workspaces** and **sparse trees**: link just `~/projects/foo`, or mirror file contents
but not the multi-gigabyte model cache. Scope is part of the workspace definition and
is itself capability-checked.

## Transport & the channel

- Tide runs over a single **multiplexed secure channel** (WebSocket/QUIC) through the
  Gateway into the Cell's `tide` MCP server. No extra open ports; it rides the same
  Cloudflare-tunneled front door as everything else.
- The channel multiplexes: control (push/pull negotiation), bulk object transfer
  (chunked, resumable, dedup by hash), and the live change stream.
- **Resumable & offline-tolerant.** Drop the connection mid-transfer and it resumes
  from the last confirmed chunk. Work offline against the local mirror; Tide reconciles
  on reconnect. Latency never loses work (vision principle #7).

## Tide is an MCP server (so agents sync too)

Crucially, `tide` is a **core MCP server** (`push`, `pull`, `link`, `diff`, `checkout`,
`log`, `mark`, `status`). That means:
- **Agents** can sync, branch, and checkout as part of their work — moving results back
  to your laptop, pulling a workspace a teammate-agent produced — all within the same
  capability + audit fabric as every other action.
- The **`sbx` CLI** and the **GUI** call the same `tide` tools; the `tide` CLI verb is
  a thin local front-end over them plus the local daemon.
- Transfers are **authorized and audited** like any MCP call — you can prove what data
  moved, when, on whose behalf.

## The local Tide daemon

A small agent on your laptop (or any local machine) that:
- Holds a **machine token**, maintains live mirrors, runs the file watcher.
- Exposes a **local MCP server** — so local tools and the remote Sandbox share one
  capability fabric. Your laptop becomes a (lightweight) participant in the same MCP
  world, not a foreign country you copy files to.
- Reconciles offline edits on reconnect.

## Moving a whole machine

Because a Sandbox's filesystem *and* its `State` objects (env, servers, agents,
manifest) are Tide objects, a Sandbox is a Tide tree. Therefore Tide is also the
mechanism for: **forking a Sandbox** (clone its tree → new slug), **sharing a distro**
(publish a tree others instantiate), and **fleet portability** (push a Sandbox's tree
to another host and boot it there). One protocol, from "sync a file" to "teleport a
machine." See [`08-customization-distros.md`](08-customization-distros.md) and
[`04-execution-substrate.md`](04-execution-substrate.md).

## Open design questions (tracked in 13)

- CRDT choice for text; binary-conflict policy defaults.
- Garbage collection / history compaction of tide marks in long-lived live workspaces.
- Whether `State` objects need their own diff/merge semantics distinct from trees.
- End-to-end encryption of objects at rest in the store vs. at the Cell boundary.
