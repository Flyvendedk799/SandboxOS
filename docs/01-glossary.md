# 01 · Glossary

The shared vocabulary. Read this second. Terms marked *(provisional)* have a settled
*concept* but an open *name* — propose better words freely; don't change the concept
without an ADR.

### SandboxOS
The whole system: the platform, the kernel, the protocol, the console, and the product.

### Tenant
An owner identity. A tenant has an account, billing, and one or more Sandboxes. You
are tenant #1. The multi-tenant product is many tenants on shared infrastructure.

### Sandbox
A tenant-owned environment addressed by a **slug**. The unit a user thinks in: "my
machine." A Sandbox has a manifest, persistent storage, enabled MCP servers, agents,
and a desktop/console. It *runs* inside a **Cell**.

### Slug
The URL path (or subdomain) that identifies a Sandbox: `sandboxos.dev/<slug>` or
`<slug>.sandboxos.dev`. Resolving a slug wakes its Cell and proxies you in.

### Cell
The isolation boundary that actually executes a Sandbox — a container today, a
microVM later, a full VM if needed. One Sandbox runs in one Cell at a time. Cells
hibernate when idle and wake on demand. Isolation is per-Cell: no shared filesystem,
scoped network. *(provisional name — alternatives: Pod, Box, Vessel.)*

### Kernel
The MCP broker/router that lives inside every Sandbox. It registers MCP servers,
mediates **every** call (authorization, capability check, rate limit, audit), and
presents one unified MCP endpoint to agents, Command Central, and the GUI. The Kernel
is the syscall layer. See [`03-mcp-kernel.md`](03-mcp-kernel.md).

### MCP server
A component that exposes capabilities as MCP tools/resources. In SandboxOS, *every*
capability is one. **Core servers** (`fs`, `proc`, `net`, `secrets`, `pkg`,
`scheduler`, `tide`, `agents`, `mcp-registry`) ship with the OS; **platform servers**
(`desktop`, `apps`, `db`, `vault`, `billing`, `observability`) provide the product;
**installed servers** are anything else (Gmail, Calendar, custom tools, marketplace).

### mcp-registry
The core MCP server that installs, enables, disables, and configures *other* MCP
servers. This is "MCP managing MCP" — the OS administers itself through the same
interface as everything else. Full MCP control means this exists.

### Capability
A scoped grant: "this caller may invoke these tools on these servers, under these
limits (quota, time, resource), on whose behalf." A capability **token** carries the
grant. Permissions in SandboxOS are sets of capabilities — never ambient authority.
See [`09-security-model.md`](09-security-model.md).

### Command Central
The remote-first console: one authenticated MCP client with three input modes —
**shell verbs** (`ls`, `ps`, `tide push`), **raw MCP** (call any tool directly), and
**natural language** (an agent translates intent to MCP calls). Available as a web
terminal and the `sbx` CLI. Reachable from everywhere. See
[`06-command-central.md`](06-command-central.md).

### sbx
The native command-line client for Command Central (`sbx <verb>`). The single
human-facing CLI binary. (Distinct from `tide`, which is the data-sync tool.)

### Tide
The data-sync protocol and tool: a **versioned, content-addressed core** (commits,
trees, blobs — push/pull/diff/checkout, git-like) with a **live mirror** layer on top
(real-time bidirectional sync). Each workspace picks snapshot mode, live mode, or
both. Tide moves files *and* sandbox state (env, enabled servers, agent definitions),
which is what makes Sandboxes portable. CLI verb: `tide`. Conceptual glyph: `⇌`.
*(provisional name — it fits the sand/shore/tide metaphor; alternatives: Conduit,
Warp, Slipstream.)* See [`05-tide-protocol.md`](05-tide-protocol.md).

### Tide repo / workspace
A directory under Tide management. Has a versioned history ("tide marks") and an
optional live link. A Sandbox can hold many workspaces.

### Tide daemon
The small local agent on your laptop (or any local machine) that maintains mirrors,
runs the file watcher, and exposes a **local MCP server** — so local tools and the
remote Sandbox share one capability fabric.

### Distro
A reusable Sandbox definition: a manifest of enabled servers, agents, apps, theme,
and defaults. Fork it, share it, instantiate it. Distros make Sandboxes interchangeable
and reproducible. See [`08-customization-distros.md`](08-customization-distros.md).

### Manifest (`Sandboxfile`)
The declarative description of a Sandbox: which MCP servers are enabled and how
configured, which agents exist, which apps are installed, theme, resource limits.
"Reproducible by description" means: manifest + data → rebuild the machine.
*(provisional filename.)*

### Agent
A first-class process with a model, a prompt/role, and a capability set. Agents are
MCP clients to their Sandbox's Kernel. They are spawned, supervised, and retired
through the `agents` core server. Humans supervise agents through Command Central.

### Gateway
The public-facing control-plane service that terminates the slug → resolves tenant →
wakes the Cell → authenticates → proxies. The "front door." Runs on the host, exposed
via Cloudflare Tunnel. See [`07-slug-routing-auth.md`](07-slug-routing-auth.md).

### Control plane vs. data plane
**Control plane** = the host-level services that route, schedule, wake, bill, and
audit across all Sandboxes (Gateway, scheduler, registry of Cells). **Data plane** =
what runs inside a Cell (the Kernel and its servers). Tenants only ever touch the
data plane through the Kernel; the control plane is operator-only.

### Machine token
A long-lived, capability-scoped credential identifying a non-human caller (the `sbx`
CLI on your laptop, the Tide daemon, a CI runner, an external agent). The mechanism
SandboxOS uses to let trusted machines act without an interactive login.

### Warm pool
A small set of pre-booted, unassigned Cells kept ready so slug resolution feels
instant even though Cells hibernate. The hibernate/wake/warm-pool triad is what makes
many Sandboxes fit on one Mac Mini. See [`04-execution-substrate.md`](04-execution-substrate.md).
