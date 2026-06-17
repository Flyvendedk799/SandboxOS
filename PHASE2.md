# Phase 2 · Tide

> Goal (from [`docs/12-roadmap.md`](docs/12-roadmap.md)): the data-movement story, end to
> end. Versioned core, local live-mirror, `State` objects — "a Sandbox is a Tide tree."
>
> **Status: built and green.** ✅ 77/77 tests pass; all Phases 0–2 run together.

## What's new since Phase 1

### The Tide versioned object store (`packages/tide/`)

Four content-addressed object kinds, sha256-addressed, git-like sharding:

| Kind | Purpose |
|------|---------|
| `blob` | file bytes |
| `tree` | sorted map of named blobs/subtrees |
| `commit` | a "tide mark": `{ tree, parents[], message, author, ts }` |
| `state` | typed JSON non-file machine state (env, manifest, agents) |

Identical content is stored once (dedup). Objects live at
`<sandbox>/tide/objects/<hh>/<rest>`.

### The `Repo` class

A working-directory manager over the object store:
```
repo.init(name, workdir)       register a workspace at a local directory
repo.mark(name, opts)          snapshot → tide mark (returns hash or null if clean)
repo.status(name)              working-tree diff vs head [{path, status}]
repo.log(name, limit)          history, newest-first
repo.diff(name, from, to)      diff between refs / working tree
repo.checkout(name, hash)      restore working tree + move head
repo.canFastForward(name, h)   is h a descendant of current head?
repo.bundle(name, have)        pack objects for transport
repo.ingest(objects)           receive remote objects
```

### 3-way text merge (`merge3`)

- One side changed → take it.
- Both changed identically → take it.
- Disjoint line edits → auto-merge (line-level hunk analysis).
- True concurrent divergence → conflict markers. CRDT (Yjs-class) is the
  documented upgrade; conflict markers are the honest interim.

### The `tide` MCP server (inside the Sandbox Kernel)

```
tide.init          create a workspace mapped to a Sandbox path
tide.listWorkspaces
tide.status        working-tree changes since the last mark
tide.mark          snapshot the workspace (audited like any Kernel call)
tide.log           mark history
tide.diff          diff between refs / working tree
tide.checkout      restore a mark
tide.refs          current head of a workspace
tide.fetchObjects  pull-side wire primitive: pack + return head
tide.receiveObjects push-side wire primitive: FF-only receive (client merges divergence)
```

> **Gotcha banked:** `tide.init` without `path` defaults to a subdirectory named
> after the workspace, not the cell root. Pass `path: "."` to map to the cell root.

### `TideClient` and the live-mirror daemon

`TideClient` pushes/pulls over the Gateway's `/:slug/mcp` endpoint using a
capability-scoped machine token. `receiveObjects` is fast-forward-only; the client
owns divergence resolution (3-way merge + merge mark → FF push).

`runDaemon()` keeps a local dir and a Sandbox workspace in lockstep: `fs.watch` +
400ms debounce marks + pushes local edits; periodic pull adopts remote marks.

### The `tide` CLI

```
tide clone <workspace> [dir]   pull a Sandbox workspace into a local dir
tide status                    working-tree changes
tide mark -m "msg"             snapshot
tide log                       history
tide push | tide pull          explicit sync
tide link                      live bidirectional mirror (watch + sync)
```

> **Gotcha banked:** `TideClient.push()` is a single send — the pull-then-retry
> loop lives in `cmdPush` and must be replicated in tests / calling code.

## Try it

```bash
npm start
# open http://localhost:3939 in a browser, or:
sbx login --url http://127.0.0.1:3939
sbx call tide.init '{"workspace":"code","path":"."}'
sbx call tide.mark '{"workspace":"code","message":"first mark"}'
sbx call tide.log  '{"workspace":"code"}'
sbx call tide.refs '{"workspace":"code"}'
```

Or drive the full laptop⇌Sandbox live-mirror:
```bash
tide clone code ./my-sandbox
echo "hello" > my-sandbox/hello.txt
tide push           # or: tide link (stays running)
```

`npm test` → **77 node:test assertions**, isolated temp home, no Docker required.

## Phase-2 scope notes

| Item | Phase 2 | Documented target |
|------|---------|-------------------|
| **Text merge** | line-level disjoint-hunk detection | CRDT (Yjs/Automerge), Phase 4 |
| **Binary conflict** | last-write-wins (open issue in docs/13) | policy TBD |
| **State objects** | `writeState`/`readState` in objects.js | MCP tools + versioned-in-mark, Phase 3 |
| **Manifest-as-Tide-State** | deferred | Phase 3 |

## Where it maps

| Piece | Path |
|-------|------|
| Object store | `packages/tide/src/objects.js` |
| 3-way merge | `packages/tide/src/merge.js` |
| Repo | `packages/tide/src/repo.js` |
| TideClient + daemon | `packages/tide/src/client.js`, `daemon.js` |
| tide MCP server | `packages/kernel/src/servers/tide.js` |
| tide CLI | `packages/tide/src/cli.js` |
| Phase 2 tests | `test/tide.test.js` (41 tests) |

## Next (toward Phase 3 · Agent-Native)

Agents as first-class citizens: `agents` MCP server (spawn/supervise/orchestrate),
`llm` MCP server (AI calls through the Kernel, capability-gated), Tide State objects
(env/manifest/agents as versioned state), natural-language Command Central
(propose→confirm), and the MCP marketplace first form.
