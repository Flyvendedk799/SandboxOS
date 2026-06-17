# 08 · Customization, Distros & the App Model

> "Highly customizable, very interchangeable." In SandboxOS that isn't a feature — it's
> a consequence of *everything being a swappable MCP server described by a manifest.*

## Three layers of customization

1. **Swap a server** — change *how* a capability works (back `fs` with disk vs. object
   store vs. Tide objects) without changing callers.
2. **Compose a Sandbox** — choose *which* servers, agents, apps, and theme make up your
   machine, via the manifest.
3. **Fork a distro** — start from someone's whole machine definition and diverge.

Each layer is enabled by the same two primitives: the **manifest** and the **`mcp-registry`**.

## The manifest (`Sandboxfile`)

A Sandbox is declaratively described by its manifest. Given the manifest plus data, you
can rebuild the machine (vision principle: reproducible by description). Illustrative
shape (format provisional — likely TOML):

```toml
[sandbox]
name = "tobias-primary"
slug = "tobias"
theme = "midnight"

[resources]
cpu = "2"
memory = "4GB"
disk = "50GB"

# Which MCP servers are enabled, and how configured.
[servers.fs]      backend = "tide-objects"     # swap the FS implementation
[servers.net]     egress  = "allowlist"
[servers.net.allow] hosts = ["api.github.com", "*.anthropic.com"]
[servers.db]      engine  = "sqlite"
[servers.gmail]   source  = "marketplace:google/gmail@1"   # installed server

# Agents that live in this Sandbox, each with a capability set.
[[agents]]
name = "scout"
model = "claude-opus-4-8"
capabilities = ["fs.read", "net.fetch", "tide.*"]

# Apps installed into the desktop.
[[apps]]
source = "marketplace:notes@2"

# Command Central customization.
[console]
aliases = { deploy = "proc.exec npm run deploy" }
nl_confirm = "preview"      # propose→confirm policy for natural-language actions
```

The manifest is **versioned in Tide** (a `State` object), so a machine's *definition*
has history and is portable exactly like its files.

## Interchangeability in practice

Because callers depend on a server's **interface**, not its implementation:

- **Filesystem:** `fs` over local disk today, over Tide content-addressed objects for
  full history, over an object store (R2/S3) for scale — same `read`/`write`/`list`.
- **Database:** `db` over SQLite, swap to Postgres for a heavier Sandbox — same tools.
- **Secrets:** `secrets`/`vault` over an encrypted file, swap to an HSM-backed vault —
  same `getRef`/`useInEnv`.
- **Model provider:** agents are provider-abstracted (Claude first, others pluggable),
  the Brandify "OpenAI **or** Claude" pattern generalized OS-wide. Default to the
  latest Claude models.

Swapping any of these is a manifest edit + `mcp-registry` reconfigure — **one server
changes, zero callers change.** That's the interchangeability promise made concrete.

## The MCP marketplace

`mcp-registry` installs servers from a **marketplace** (and from git URLs, local paths,
or private registries). A marketplace entry is an MCP server packaged with: its tool
schema, required capabilities, resource needs, and a trust/signature. Installing is:

```
install gmail              # resolve → fetch → verify signature → sandbox → enable
```

Installed servers are **sandboxed like any other code** (their own process, their own
capability grants, egress policy) — the marketplace is open but not a security hole,
because an installed server is still just a principal with a capability set under the
Kernel. This is how the ecosystem ("the Linux of agent OSes") grows without surrendering
the security model.

## The app model

An **app** in SandboxOS is the natural pairing of the two interfaces SandboxOS already
has — a GUI for humans, MCP for agents:

- A **web frontend** (a window in the `desktop`), and/or
- An **MCP server** exposing the app's capabilities as tools.

So an app is usable by a human (click in the desktop) **and** by an agent (call its
tools) with no separate integration work — the same app, two faces. A "notes" app is a
notes window *and* a `notes` MCP server (`note.create`, `note.search`). This duality is
why SandboxOS is genuinely agent-native at the application layer, not just the kernel.

Apps are installed into a Sandbox via the manifest/registry, themeable via design
tokens (the `tokens.css` discipline from Brandify/your design-system work), and appear
both on the desktop and in the tool catalog.

## Distros: forking and sharing whole machines

A **distro** is a reusable Sandbox definition — a manifest (plus optional seed data and
agents) you can instantiate, fork, and share. Because a Sandbox is a Tide tree
(filesystem + `State` objects), distros ride entirely on Tide:

- **Instantiate:** `new sandbox from distro:dev-rust` → a fresh Cell from that tree.
- **Fork:** clone an existing Sandbox's tree → new slug, diverge freely.
- **Share / publish:** push a distro tree others can instantiate (a "developer box," a
  "research box," a "social-media-ops box," each pre-wired with the right servers,
  agents, and apps).
- **Update:** pull upstream distro changes into a fork (with Tide's diff/merge), like
  rebasing onto a base image.

Distros are how "highly customizable, very interchangeable" becomes a *community*
property, not just a personal one — the on-ramp from "I configured my machine" to
"thousands of people start from machines others designed."

## Theming & the human surface

The `desktop` server renders the web GUI: a window manager hosting app frontends and the
Command Central terminal, themed by design tokens in the manifest. Per your standing
design bar (excellent, token-bound, dark-mode/a11y-safe data viz), the desktop ships a
**shared, token-bound visual layer** so every app and dashboard looks coherent and
first-class — not a grab-bag of mismatched windows. Customization here is choosing/
authoring a theme; interchangeability is that any app inherits it for free.
