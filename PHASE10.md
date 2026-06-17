# Phase 10 — Streaming Command Central

Phase 10 delivers a streaming execution path for the Command Central terminal: `POST /:slug/exec-stream` streams shell command output in real-time via SSE, and the frontend switches from the blocking `POST /:slug/exec` to this streaming endpoint for all command types.

## What was built

### 1. `POST /:slug/exec-stream` — streaming SSE exec (gateway)

A streaming counterpart to `POST /:slug/exec` that handles the full Command Central verb language:

**Shell commands** (anything not matching a known verb or `:` prefix):
- Checks `proc.exec` capability explicitly (emits `{ type: "error" }` + `{ type: "done", code: 1 }` on denial)
- Calls `kernel.cell.execStream()` to stream stdout/stderr in real-time
- Emits `{ type: "stdout", chunk }`, `{ type: "stderr", chunk }`, `{ type: "done", code }`
- Kills the child process on client disconnect

**Verb shortcuts** (`ls`, `cat`, `help`, `:call`, `?`, etc.):
- Calls `runCommand()` for full verb routing (same as `POST /:slug/exec`)
- Emits:
  - `{ type: "clear" }` for the `clear` command
  - `{ type: "proposed", hint, proposed }` for NL (`?`) commands
  - `{ type: "line", text }` × N for all other verbs
- Finishes with `{ type: "done", code: 0 }`

**Event stream format:**
```
data: {"type":"stdout","chunk":"hello\n"}

data: {"type":"done","code":0}

```

**Verb detection** — the first token of the input line is matched against a known set of shorthand verbs. Non-matching tokens with no `:` prefix are treated as raw shell commands:
```js
const VERBS = new Set(["ls","cat","stat","write","ps","whoami","servers","enable","disable",
  "fetch","secrets","secret","pkg","agent","agents","llm","help","clear"]);
```

### 2. Frontend — `run()` switched to SSE

**`apps/gateway/public/app.js`** — `run()` updated to consume `POST /:slug/exec-stream`:
- Uses `fetch()` + `resp.body.getReader()` for streaming (works for POST, unlike `EventSource` which is GET-only)
- Accumulates the SSE frame buffer and splits on `\n\n`
- Routes events to the terminal:
  - `stdout` / `line` → `print(text)` (inline as they arrive)
  - `stderr` → `print(chunk, "err")`
  - `clear` → `$out.innerHTML = ""`
  - `proposed` → `showPropose(hint, proposed)` for NL propose/confirm
  - `error` → `print("✗ " + text, "err")`
- Falls through to a JSON error on non-2xx status

The terminal now shows long-running command output character-by-character as it arrives, rather than waiting for the command to finish.

## Test coverage — `test/phase10.test.js` (14 tests)

| Section | Tests |
|---------|-------|
| Auth / validation | 3 (401, 400 missing line, Content-Type header) |
| Shell commands | 4 (stdout chunk, stderr chunk, exit code, multi-line) |
| Verb shortcuts | 3 (`ls`, `help`, `clear`) |
| :call raw MCP | 2 (`fs.list`, `kernel.whoami`) |
| Capability enforcement | 1 (shell command denied without `proc.exec`) |
| NL `?` commands | 1 (`proposed` event emitted when llm enabled) |

Helper: `collectStream(resp)` — reads an SSE fetch response body, accumulates frames, stops at the `done` event, with a 5-second safety timeout.

Full suite after Phase 10: **215 tests, 0 failures**.

## Design notes

**Why not extend `runCommand()`?** Adding streaming to `runCommand` would require changing its interface (callback or generator instead of `Promise<{lines}>`) and updating all 10+ call sites. Instead, the gateway-level `exec-stream` handler only bypasses the kernel for shell commands (where streaming matters), explicitly replicating the auth check. All other verbs still go through `kernel.call()` for authorization + audit.

**Why `fetch()` instead of `EventSource` for SSE?** `EventSource` is GET-only; Command Central sends the command line in the POST body. `fetch()` with `resp.body.getReader()` gives identical framing with full POST support.

## What's deferred to Phase 11+

- **Real PTY via `node-pty`** — `ioctl TIOCSWINSZ` for resize, vim/top/htop support
- **npm / Git URL install** in `mcp-registry.install` (currently file-path-only)
- **Multi-host Scheduler** — cross-node Cell registry and routing
- **microVM backend** (Firecracker-in-Linux-VM on Mac Mini) for L2 isolation
- **Federation** and self-host distribution
