# Phase 20 — The OS Primitives

Phase 19 closed the hardening backlog. Phase 20 starts the run from *working spine* to
*machine you would actually live in*. Three gaps stood out when you tried to do real work
in a Sandbox: you could not reshape the filesystem, you could not run anything that
outlived a request, and you could not **see** what you ran.

## `fs` — a filesystem you can actually reshape

`fs` had four tools (list/read/write/stat). It now has thirteen. Everything new goes
through the same containment guards as the originals (`canonicalContained` for paths that
must exist, `canonicalLeafContained` for leaves that may not), so symlink escapes are
rejected on every new surface too.

| tool | what it adds |
|------|--------------|
| `fs.mkdir` | create a directory tree |
| `fs.remove` | delete a file or (with `recursive`) a directory; refuses the Sandbox root |
| `fs.move` / `fs.copy` | rename and duplicate, both endpoints contained |
| `fs.append` | extend a file without a read-modify-write round trip |
| `fs.tree` | one call for a whole nested view, bounded by `depth` and node count |
| `fs.search` | content grep with glob filtering, regex mode, and binary-file skipping |
| `fs.readBytes` / `fs.writeBytes` | base64 in and out, so images and archives stop being second-class |

`fs.list` also grew `size` and `mtime` and now sorts directories first — a file browser
needs all three, and every caller wanted them anyway.

## `proc` — processes that outlive the request

`proc.exec` runs a command to completion and returns its output. That is the wrong shape
for a dev server, a build watcher, or a queue worker. **Supervised processes** are the
right one:

- **`proc.start`** launches a command and returns immediately with a job id.
- **`proc.logs`** tails its captured output; lines are buffered properly, so a chunk that
  ends mid-line is not torn into two entries, and a partial trailing line is flushed on exit.
- **`proc.jobs` / `proc.stop` / `proc.forget`** list, terminate and reap.
- **`proc.signal`** sends a signal to any pid inside the Cell.

The job table is module-level and keyed by Sandbox, not per server instance: the Kernel
rebuilds its server set whenever the manifest changes, and a running dev server must
survive that. `Kernel.dispose()` reaps a Sandbox's supervised processes.

## `ports` — and the thing that makes it matter

A Sandbox is only half useful if you can start a web app in it but never look at it.

- **`ports.expose` / `ports.unexpose`** declare a port. Exposure lives in the manifest, so
  it survives hibernate/wake and travels with a distro like every other part of the
  machine's description.
- **`ports.list`** reports each exposed port with live reachability; **`ports.check`**
  probes one; **`ports.scan`** lists what is actually listening inside the Cell.

Reaching the service is the Cell backend's job. Every backend now answers `endpoint(port)`
with the address the Gateway should dial:

| backend | endpoint |
|---------|----------|
| `local` | `127.0.0.1` — the Cell shares the host loopback |
| `docker` | the container's network IP, resolved with `docker inspect` |
| `hardened-docker` | *unavailable* — these Cells run `--network=none`, deliberately |
| `firecracker` | the guest's TAP address |

**The Gateway then proxies `/(slug)/p/(port)/…` straight into the Cell.** You start a dev
server with `proc.start`, expose its port, and it is reachable from the same authenticated
browser tab you launched it from — no tunnels, no published host ports. The proxy:

- requires a `ports.access` capability and an *exposed* port (default-deny, as ever);
- redirects a bare `/p/3000` to `/p/3000/` so relative links resolve;
- injects `<base href="…">` into HTML responses so root-relative asset URLs stay under the
  prefix, and rewrites `Location` headers the same way;
- tunnels WebSocket upgrades, so dev-server HMR and live reload work.

## Command Central

The new tools are verbs, not just MCP addresses: `mkdir`, `rm [-r]`, `mv`, `cp`, `tree`,
`grep`, `run`, `jobs`, `logs`, `stop`, `ports`, `port expose|close|scan|check`. Each one
formats its result for a terminal — `tree` draws a real tree, `grep` prints
`path:line  text`, `ports` shows an up/down dot per route.

## Tests

`test/phase20.test.js` — 24 tests covering every new fs tool (including containment on
each new surface and the root-deletion guard), the supervised-process lifecycle end to
end, and the port proxy through a real Gateway against a real listener: JSON passthrough,
`<base>` injection, the unexposed-port 404, the unauthenticated 401, and the
nothing-listening 502.
