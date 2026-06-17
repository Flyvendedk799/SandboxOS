# Phase 8 — WebSocket PTY Terminal

Phase 8 delivers the interactive shell session that's been deferred since Phase 0: a WebSocket-based PTY bridge connecting a browser xterm.js terminal directly to a live shell process running in the Cell.

## What was built

### 1. `packages/pty/src/index.js` — RFC 6455 WebSocket codec (zero external deps)

Implements the full WebSocket handshake and frame codec needed for a bidirectional shell bridge:

- **`upgradeWebSocket(req, socket, head)`** — performs the HTTP → WebSocket upgrade:
  - Computes `Sec-WebSocket-Accept` via SHA-1(key + MAGIC)
  - Writes the 101 response, re-injects leftover bytes via `socket.unshift`
  - Returns a `WsConn` instance
- **`WsConn extends EventEmitter`** — live connection:
  - Emits `'message'` (Buffer) for text (0x1) and binary (0x2) frames
  - Emits `'close'` on close frame (0x8) or socket error
  - Handles ping → pong (0x9 → 0xA) automatically
  - `send(data)` — wraps in a binary frame (server-side: unmasked)
  - `close()` — sends a close frame and destroys the socket

Frame length encoding handles all three sizes: ≤125 (1 byte), ≤65535 (2 bytes via 126), and larger (8 bytes via 127). Incoming client frames are always de-masked.

### 2. `packages/cell/src/local-backend.js` + `docker-backend.js` — `execInteractive`

Both backends gain `execInteractive(onData, onClose, opts)`:

- Spawns `$SHELL -i` (or `/bin/sh -i`) with `stdio: ['pipe', 'pipe', 'pipe']`
- Sets `TERM=xterm-256color`, `COLUMNS`, `LINES` in the env
- Forwards stdout + stderr to `onData(data)`; `close` event → `onClose()`
- Returns `{ write(data), kill(), resize() }`:
  - `kill()` sends **SIGKILL** for reliable termination of interactive shells
  - `resize()` is a no-op (without a real PTY, `ioctl TIOCSWINSZ` is unavailable)
- `DockerBackend.execInteractive` is async (awaits `ensureRunning()` first)

> **Limitation:** without a real PTY, ncurses programs (vim, top, htop) won't render correctly — cursor sequences won't be processed by the kernel terminal layer. A future phase can add `node-pty` for full PTY emulation.

### 3. `apps/gateway/src/server.js` — upgrade handler + query-string auth

**`authenticate(req)` updated** — now also reads `?token=` from the query string:

```
bearer || url.searchParams.get("token") || cookie
```

This is required for WebSocket connections since browsers cannot set custom headers in an `Upgrade` request.

**`handleUpgrade(req, socket, head)` (async)** — new function:
1. Parses slug + action from `req.url`; only routes `action === "pty"`
2. Looks up the sandbox, authenticates, checks grants + `proc.exec` capability — destroys socket on any failure
3. Calls `upgradeWebSocket(req, socket, head)` to complete the handshake
4. Gets the kernel (`await getKernel(sandbox)`), wakes the Cell via the scheduler
5. Calls `kernel.cell.execInteractive(...)` with WebSocket send as `onData`
6. Forwards WebSocket messages → shell stdin; SOH-prefixed messages are parsed as control frames (resize)
7. Cleans up on `ws.close`: kills the shell process

**`createServer()` updated** — wires `srv.on('upgrade', ...)`:

```js
srv.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch(() => socket.destroy());
});
```

### 4. Frontend — "Shell" tab with xterm.js

**`apps/gateway/public/sandbox.html`** — new 4th tab `data-tab="shell"`, shell panel with Connect/Disconnect buttons and a `#pty-container` div. Loads `xterm@5.3.0` from jsDelivr CDN.

**`apps/gateway/public/app.js`** — `initShell()`:
- Creates an `xterm.Terminal` with dark theme matching the SandboxOS design tokens
- `ptyConnect()` opens `ws://<host>/<slug>/pty` (same-origin → cookie auth), streams all output to the terminal, forwards key input as binary WebSocket frames
- `ptyDisconnect()` closes the WebSocket

**`apps/gateway/public/styles.css`** — `.shell-pane`, `.shell-toolbar`, `.pty-container` styles.

## Test coverage — `test/phase8.test.js` (11 tests)

| Section | Tests |
|---------|-------|
| WsConn unit | 2 (null on missing key, correct 101 + Sec-WebSocket-Accept) |
| Auth / routing | 3 (no auth, bad slug, bad action → socket closed) |
| Connection | 1 (valid machine token → 101 upgrade) |
| Shell I/O | 3 (output echoed, multiple commands, exit → WS close) |
| Cell backend | 2 (execInteractive shape + output, kill terminates shell) |

Authentication: tests use `mintMachineToken` to get a machine token and pass it via `?token=`.
WebSocket simulation: raw `net.Socket` with manual RFC 6455 handshake + frame codec (no external deps in tests).

Full suite after Phase 8: **186 tests, 0 failures**.

## What's deferred to Phase 9+

- **Real PTY via `node-pty`** — `ioctl TIOCSWINSZ` for resize, full ncurses support (vim, top, htop)
- **Resize messages** — control frame `\x01{"type":"resize","cols":N,"rows":N}` wired to `shell.resize()`
- **npm / Git URL install** in `mcp-registry.install` — Phase 7 only supports absolute file paths
- **Frontend streaming terminal** — switch the Command Central terminal from POST-per-command to `POST /:slug/stream` SSE
- **Multi-host Scheduler** and microVM backend
- **Federation** and self-host distribution
