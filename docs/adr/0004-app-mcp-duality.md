# ADR-0004 · An app is a GUI and an MCP server

- **Status:** Accepted
- **Date:** 2026-09
- **Deciders:** Tobias

## Context

docs/08 describes the app model as a natural pairing of SandboxOS's two interfaces:
a window for humans and MCP tools for agents, with no separate integration work.
Phase 27 shipped the first half — custom apps as HTML/CSS/JS bundles in an
opaque-origin frame, brokered by the shell under attenuated capabilities — and left
the second half as a vision.

Two ways to fulfil it were on the table:

- **Lean A — façade.** An app declares tools that are attenuated aliases of existing
  Kernel tools. `port-monitor.list` *is* `ports.list`, narrowed to what the app
  declared and audited under the app's name. No new code runs anywhere. Enough for
  dashboards and for "give the agent a vocabulary for this app".
- **Lean B — companion.** An app ships a server module that actually computes
  something, registered into the Kernel for that Sandbox with its own capability
  story. This is what "an app is an MCP server" literally means.

The obvious mistake was to build A and call it B.

## Decision

Both, explicitly named, with **B as the spine and A as a documented simplification**.

A custom app definition may carry an `mcp` block:

```jsonc
{
  "id": "port-monitor",
  "permissions": ["ports.list"],
  "mcp": {
    "name": "port-monitor",            // the server name; defaults to the app id
    "enabled": true,
    "runtime": "host-sandboxed",       // the only runtime today
    "entrypoint": "server.js",         // B: a module in the bundle
    "tools": [                         // A: façades over Kernel tools
      { "name": "list", "description": "Exposed ports", "inputSchema": {…},
        "proxy": { "server": "ports", "tool": "list" } }
    ]
  }
}
```

- **Companion servers run out of process** in the same host marketplace servers use
  (`marketplace-host.js`), with an empty deps object: no Cell, no Kernel, no secrets.
  The Kernel registers a proxy, so authorize → route → audit is unchanged. A
  companion is a pure function of its arguments; an app that needs the machine
  asks the GUI half to call `sbx.mcp`, or declares a façade.
- **Façade tools attenuate at the door.** The inner call holds the caller's grants
  intersected with the app's declared `permissions`, and is audited with
  `onBehalfOf: app:<id>` beside the outer row. An app can never lend a capability
  its opener lacks or use one it did not declare.
- **The document is the source of truth.** The Kernel reconciles its app servers
  against the OS document on boot and on every desktop write (`app-servers.js`), so
  `appDefine`, `appRemove`, `distroFork`, `revert` and `reset` all register and
  deregister without a second path. A machine with no desktop has no app servers.
- **Names are closed.** An app may not name its server after a core server or an
  installed one; `normalizeDoc` refuses reserved names before the Kernel sees them.
- **Distros carry both faces**, and a payload now carries a per-bundle SHA-256
  integrity block that import verifies. A forked distro's companion servers arrive
  **disabled**; the person forking turns each one on. Façades carry no code and stay
  on.

`runtime: "cell"` (a companion inside the Cell with `proc.start`) is reserved and not
implemented: it would give app code a process on the machine, which is a capability
decision, not a packaging one.

## Consequences

**Positive**
- The vision in docs/08 is real: a "UI + tools" app is one `appDefine`, and the
  agent can call `port-monitor.list` without opening a window. Same tool catalog,
  same audit log, same attenuation.
- The simplification is honest about being one. A façade says `proxy`; nobody
  mistakes it for a server.
- Out-of-process hosting means a bug in an app's server cannot reach the control
  plane, and a distro from a stranger cannot run code until you say so.

**Negative / accepted**
- A companion cannot reach the Cell. Apps that need it split their logic: pure
  computation in the server, machine access in the UI or in façades.
- One child process per enabled companion. Bounded by the app ceiling (128) and by
  the host's `unref` posture; a future runtime may pool them.
