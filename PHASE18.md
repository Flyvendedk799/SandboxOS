# Phase 18 — Out-of-Process Marketplace Isolation

Phase 18 completes backlog item **#12** (the highest-risk deferral from Phase 17):
untrusted marketplace MCP servers no longer execute inside the control-plane process.

## The problem
`mcp-registry.install` previously did a dynamic `import()` of the third-party server
module **into the Kernel/Gateway process**, handing its factory the full `deps`
(`cell`, `sandbox`, `kernel`). Holding `mcp-registry.install` was therefore equivalent
to arbitrary host code execution: a malicious package could call back into the Kernel,
read host filesystem custody (`master.key`, `control.sqlite`), or touch anything the
control plane could. The Phase-17 allowlist + provenance only narrowed the surface.

## The fix — a real process boundary
Each installed marketplace server now runs in its **own forked child process**:

- **`packages/kernel/src/marketplace-host.js`** — the child entry. It `import()`s the
  third-party factory and instantiates it with a **minimal `{}` deps object** (no
  cell/sandbox/kernel). Tool handlers receive an **empty ctx**. It serves two ops over
  the fork IPC channel: `describe` (returns tool name/description/inputSchema) and
  `call` (runs a tool handler on `args` and returns the result). It `process.exit(0)`s
  on parent disconnect so an orphan never lingers.
- **`packages/kernel/src/marketplace-pool.js`** — the parent-side manager. Owns child
  lifecycle + request/response correlation, exposing `describe()` / `call()` per server.
  Children are `unref()`'d (a forgotten one can't block process exit) and killed on
  uninstall / kernel disposal.
- **`Kernel`** now caches only tool **descriptors** (`_marketplaceServers`), so the
  synchronous `rebuild()` can register an in-process **proxy** server whose handlers
  forward `args` to the child. The Kernel's `authorize → route → execute → audit` path
  is unchanged, so out-of-process servers are governed **identically** to built-ins:
  default-deny still applies, every call is still hash-chained into the audit log.
- `getKernel` boot, `install`, `enable`, `uninstall`, and `_dropKernel`/`_resetKernels`
  all route through the pool; `Kernel.dispose()` kills a sandbox's children.

## Isolation properties now guaranteed (and tested)
- Marketplace code runs in a **different PID** than the control plane.
- Its factory `deps` and tool `ctx` are **empty** — no handle to cell/sandbox/kernel.
- The Kernel still **authorizes** (default-deny) the call before the child is consulted,
  and still **audits** it.
- Install still records **provenance** (`source` + sha256 of the entry file).
- Children are reaped on uninstall and on process exit (no orphans).

## Tests — `test/phase18.test.js` (7) + `test/fixtures/isolation-probe.js`
A probe server reports its PID and visible host-context keys. Tests assert: reachable
through the Kernel; runs in a separate PID; empty deps/ctx; default-deny still enforced;
the call is audited; provenance recorded; uninstall removes the tool + kills the child.

Full suite after Phase 18: **337 tests, 0 failures** (and the runner exits cleanly with
no orphaned `marketplace-host` processes).

## Follow-up: npm install-step sandboxing (done)
The npm-sourced install path ran `npm install`, which executes a package's lifecycle
scripts (`preinstall`/`install`/`postinstall`) **host-side** — arbitrary code execution
before the server is ever isolated. `mcp-registry.install` now invokes npm with
**`--ignore-scripts`** by default (plus `--no-audit --no-fund`); an operator can opt back
in with `SANDBOXOS_MCP_ALLOW_SCRIPTS=1` for a package with a genuine native build step.

Tests — `test/marketplace-install-scripts.test.js` (2) + `test/fixtures/evil-install/`
(a package whose postinstall writes a marker file): the default install blocks the
postinstall (marker absent) while the package still installs and its server is callable;
with the opt-out the postinstall runs (confirming the flag is what blocks it).

Full suite after the follow-up: **339 tests, 0 failures.**

## Still deferred
Running `npm install` *itself* inside the Cell (full network/process isolation of the
build, not just script suppression) remains a larger, infrastructure-dependent change.
With `--ignore-scripts` the highest-risk vector (lifecycle-script RCE) is closed; a
package could still ship a malicious *module* that only runs once the server is invoked —
but that now executes out-of-process with no host handle (the Phase 18 boundary above).
