# Phase 3 · Agent-Native

> Goal (from [`docs/12-roadmap.md`](docs/12-roadmap.md)): agents as first-class
> citizens and the app/marketplace ecosystem's first form.
>
> **Status: built and green.** ✅ 104/104 tests pass (27 new); all Phases 0–3
> run together.

## What's new since Phase 2

### The `agents` MCP server (`packages/agents/src/server.js`)

Agents are supervised tasks with their own scoped principal, spawned via
attenuating delegation. Every agent is capability-constrained from day one.

```
agents.spawn { name, patterns, cmd }  →  { id, state, patterns }
agents.list  { limit? }               →  { agents: [...] }
agents.get   { id }                   →  full detail: state, result, error, exit_code
agents.kill  { id }                   →  { killed: bool }
```

**Lifecycle:** `queued → running → done | failed | killed`

**Delegation chain:** each `spawn` mints a dedicated machine principal via
`mintMachineToken(spawner, sandbox, patterns)` — the same attenuating-delegation
mechanic as human machine tokens. The `spawned_by` column in the `agents` table
and `onBehalfOf` in audit entries tie every action back to the operator.
An agent cannot exceed the authority of the principal that spawned it.

**Gotcha banked:** `agents.kill` marks the DB state as `killed` and cancels the
local tracker — the underlying shell process may complete naturally (grace period).
Hard process termination requires adding SIGKILL support to the Cell backends (Phase 4).

### The `llm` MCP server (`packages/llm/src/server.js`)

Brings AI into the OS as a standard capability — gated, audited, default-deny.

```
llm.complete { prompt, model?, system? }  →  { content, model, usage, mock }
llm.models   {}                           →  { models: [...], configured: bool }
```

- When `ANTHROPIC_API_KEY` is absent, `complete` returns `mock: true` with a
  placeholder message (tests run without credentials; smoke tests hit the real API).
- The server is in the catalog but **opt-in in the manifest** (`llm: {}`) — callers
  must also hold `llm.*` or `llm.complete` capability (default-deny).
- Default model: `claude-haiku-4-5-20251001` (fast + cheap for inline AI tasks).

### Tide State objects (`tide.putState / getState / listStates`)

Non-file machine state — env, manifest, agent definitions, feature flags — stored
as content-addressed `state` objects (already in the object layer since Phase 2,
now surfaced as MCP tools).

```
tide.putState   { workspace, type, data }  →  { hash, type }
tide.getState   { workspace, type }        →  { data }   (null if absent)
tide.listStates { workspace }              →  { types: [...] }
```

State objects are stored beside the `head` ref in the workspace registry, not
inside the commit tree, so they don't affect the diff/merge/checkout flow. A
Sandbox's manifest, environment, and agent roster can all be versioned alongside
its files — "a Sandbox is a Tide tree" (docs/05 vision) becomes true.

### Natural-language Command Central (`?` prefix)

The NL mode is now live (was a stub since Phase 0):

```
? list all my text files
  ↳ ls                       ← the llm server's proposed command
```

The system prompt instructs the LLM to translate natural language into a single
Command Central verb. The proposed command is returned with `proposed: true` so
the frontend can display a confirmation step before execution. Requires `llm`
enabled in the manifest + `ANTHROPIC_API_KEY` set.

### New verb helpers in Command Central

```
agent spawn <name> "<cmd>"   agents.spawn  (default patterns: fs.*, proc.exec)
agents                       agents.list
agent get <id>               agents.get
agent kill <id>              agents.kill
llm "<prompt>"               llm.complete
```

## Try it

```bash
npm start
sbx login --url http://127.0.0.1:3939

# spawn a shell agent
sbx call agents.spawn '{"name":"hello","patterns":["proc.exec"],"cmd":"echo hello from agent"}'
# → { id: "agt_...", state: "queued", patterns: [...] }

# check its result
sbx call agents.get '{"id":"agt_..."}'

# LLM (requires ANTHROPIC_API_KEY in env)
export ANTHROPIC_API_KEY=sk-...
sbx call mcp-registry.enable '{"server":"llm"}'
sbx call llm.complete '{"prompt":"name three colours","system":"reply briefly"}'

# Tide State
sbx call tide.init '{"workspace":"main","path":"."}'
sbx call tide.putState '{"workspace":"main","type":"env","data":{"RAILS_ENV":"production"}}'
sbx call tide.getState '{"workspace":"main","type":"env"}'
```

`npm test` → **104 node:test assertions**, isolated temp home, no Docker required.

## Phase-3 scope notes

| Item | Phase 3 | Documented target |
|------|---------|-------------------|
| **Agent kind** | `shell` (cell.exec) | `ai` (LLM + tool loop), Phase 4 |
| **Agent kill** | DB state + cancel flag | Hard SIGKILL via Cell backend, Phase 4 |
| **NL confirmation** | `proposed: true` flag | Frontend propose→confirm UX, Phase 4 |
| **WebSocket/PTY** | SSE + POST still | xterm.js + ws upgrade, Phase 4 |
| **App model** | not started | Window manager + app = frontend + MCP server, Phase 4 |
| **MCP marketplace** | not started | Third-party server install/verify/sandbox, Phase 4 |

## Where it maps

| Piece | Path |
|-------|------|
| agents MCP server | `packages/agents/src/server.js` |
| llm MCP server | `packages/llm/src/server.js` |
| agents DB table | `packages/control-db/src/db.js` |
| agent CRUD | `packages/control-db/src/registry.js` |
| Tide State (Repo) | `packages/tide/src/repo.js` |
| Tide State (MCP tools) | `packages/kernel/src/servers/tide.js` |
| Catalog update | `packages/kernel/src/catalog.js` |
| Manifest update | `packages/manifest/src/manifest.js` |
| Command Central NL + agents | `packages/command-central/src/console.js` |
| Phase 3 tests | `test/agents.test.js` (14 tests), `test/state.test.js` (13 tests) |

## Next (toward Phase 4 · The Product)

Multi-tenant for real: signup/onboarding, billing/quotas, hardened isolation
(microVM L2 backend), distros (fork/share/instantiate Sandboxes), WebSocket/PTY
terminal, AI agent kind (LLM drives a tool loop), MCP marketplace install/verify,
and the App model + desktop GUI.
