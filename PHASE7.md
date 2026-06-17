# Phase 7 — The Marketplace

Phase 7 adds a marketplace layer so third-party MCP servers can be installed into any Sandbox at runtime, without restarting the Gateway. It also ships an SDK (`packages/sdk`) and an example server (`packages/example-server`) for builders.

## What was built

### 1. `packages/sdk/src/index.js` — the Server SDK

The only public contract a marketplace server must fulfill:

```js
import { createMcpServer } from "@sandboxos/sdk"; // or relative path

export default createMcpServer({
  name: "my-server",
  tools: {
    doThing: {
      description: "Do a thing.",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
      async handler(_ctx, { input }) {
        return { result: input.toUpperCase() };
      },
    },
  },
});
```

`createMcpServer(def)` returns a factory `(deps) => serverDef`. The factory receives `{ cell, sandbox, kernel, manifest }` so advanced servers can reach the host Cell, but most only need their own tools map. The default export of a marketplace module **must** be that factory.

### 2. `packages/example-server/src/index.js`

Minimal demo server used in tests. Registers one tool: `hello.greet { name? }` → `{ message: "Hello, <name>!" }`.

### 3. `packages/kernel/src/kernel.js` — async `getKernel` + marketplace factories

**`getKernel` is now async.** The change is backward-compatible for callers that `await` it; the returned Promise resolves to the same `Kernel` instance on every call (cached by sandbox ID).

New fields on `Kernel`:
- `_marketplaceFactories: Map<string, factory>` — loaded at runtime via `mcp-registry.install`; survives `rebuild()` calls.

`rebuild()` now falls back to `_marketplaceFactories` when a server name isn't in `CATALOG`:

```
for name in enabledServers(manifest):
  factory = CATALOG[name] ?? kernel._marketplaceFactories.get(name)
  if factory: kernel.servers.set(name, factory(deps))
```

The manifest key is always used as the routing name (so a server installed as `"hello2"` is reachable as `hello2.greet`, regardless of the server's own `name` property).

On boot, `getKernel` pre-loads factories from `manifest.installed` via `import(pathToFileURL(source).href)` before calling `rebuild()`, so marketplace servers are available immediately after a restart.

### 4. `packages/kernel/src/servers/registry.js` — install / uninstall tools

Two new `mcp-registry` tools:

**`mcp-registry.install { name, source }`**
- `source` is an absolute file path (e.g. `/home/user/my-server.js`)
- Dynamic-imports the module, extracts `mod.default` (the factory)
- Caches the factory in `kernel._marketplaceFactories`
- Writes `manifest.installed[name] = source` and auto-enables (`manifest.servers[name] = {}`)
- Calls `kernel.rebuild()`

**`mcp-registry.uninstall { name }`**
- Removes from `manifest.installed` and `manifest.servers`
- Deletes from `kernel._marketplaceFactories`
- Calls `kernel.rebuild()`

**`mcp-registry.list` updated** — now returns `{ available, installed, enabled }`:
- `available` — built-in CATALOG keys (unchanged)
- `installed` — marketplace server names from `manifest.installed`
- `enabled` — currently active servers from `manifest.servers`

**`mcp-registry.enable` updated** — also accepts marketplace server names (checks `manifest.installed` as a second source, in addition to `available`).

### 5. `packages/manifest/src/manifest.js`

Added `installed: {}` to `defaultManifest()`. Marketplace server sources are stored here and reloaded on Kernel boot.

### 6. Callers updated for async `getKernel`

- `apps/gateway/src/server.js`: `const kernel = await getKernel(sandbox)`
- `packages/scheduler/src/cron-runner.js`: `const kernel = await getKernel(sandbox)`
- All 8 test `test.before` callbacks: `async () => { kernel = await getKernel(sandbox) }`

## Test coverage — `test/phase7.test.js` (18 tests)

| Section | Tests |
|---------|-------|
| SDK shape | 2 (factory shape, ignores deps) |
| mcp-registry.list | 1 (installed array present and initially empty) |
| Install | 5 (loads file, tool in catalog, greet call, default name, list shows it) |
| Disable / re-enable | 2 (tools disappear after disable, return after enable via installed entry) |
| Uninstall | 3 (removed from installed+enabled, tool absent, error on double-uninstall) |
| Unknown server guard | 1 (enable throws for server not in CATALOG or installed) |
| Kernel cache | 1 (same Kernel instance returned on second call) |
| Factory survives rebuild | 1 (tools present after explicit `kernel.rebuild()`) |
| HTTP integration | 1 (POST /:slug/mcp routes to installed server tool) |

Full suite after Phase 7: **175 tests, 0 failures**.

## What's deferred to Phase 8+

- Install from npm (`npm:package-name`) or Git URL — Phase 7 only supports absolute file paths
- Marketplace registry / catalogue UI — browseable index of publishable servers
- WebSocket / PTY terminal (interactive programs like `vim`, `top`)
- Frontend: streaming terminal using `POST /:slug/stream`
- Frontend: agent event panel wired to `/:slug/agents/:id/events`
- Multi-host Scheduler
- microVM backend (Firecracker)
- Federation and self-host distribution
