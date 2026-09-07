# Phase 29 — Apps as dual beings, distros as an ecosystem

docs/08 has said since the beginning that an app is a GUI for humans **and** an MCP
server for agents, and that a distro is a whole machine you can hand to someone.
Phase 27 shipped the first half of each. This phase — Waves C and D — ships the
second halves, and is careful not to pretend a simplification is the real thing.

## Two faces, named

[ADR-0004](docs/adr/0004-app-mcp-duality.md) chooses both shapes and names them. A
custom app may carry an `mcp` block:

- A **façade**: `tools[].proxy` names an existing Kernel tool. `port-monitor.list` *is*
  `ports.list`, run with the caller's grants ∩ the app's declared permissions, and
  audited on both hops. No code runs anywhere new. An app cannot lend a capability its
  opener lacks, and cannot use one it never asked for — the tests try both.
- A **companion**: `entrypoint` names a module in the bundle. It runs in the same
  out-of-process host marketplace servers use, with an empty deps object — no Cell,
  no Kernel, no secrets — and the Kernel registers a proxy. The "UI + tools" starter
  ships a real one (`ping`, `add`, `list`) and a UI that calls it through the broker,
  the same way an agent does.

The document is the source of truth. `packages/kernel/src/app-servers.js` reconciles
the Kernel's app servers with the OS document on boot and on every desktop write, so
`appDefine`, `appRemove`, `distroFork`, `revert` and `reset` all register and
deregister through one path, and a machine with no desktop has no app servers — the
same `hasOs()` guard that keeps notifications from conjuring one. Server names are
closed (`fs` is refused in the normalizer, before the Kernel ever sees it; an installed
server's name is refused at define time). A broken companion is reported on the
`appDefine` result, never fatal to the machine.

## One snapshot, two layers

A distro payload now carries the OS document, the source **and tools** of every custom
app, and the Cell's composition — which servers are enabled and how they are
configured; secrets never, marketplace servers by name only. The control DB row's
manifest is a real Sandboxfile shape, so `POST /api/sandboxes { distro }` instantiates
the Cell and the desktop together, and `distroFork` applies the composition (core
servers only, and never removing the ones that keep the machine reachable).

Every payload carries a **SHA-256 integrity block** per bundle. Import verifies it: a
bundle modified after publish is refused, a smuggled extra bundle is refused, a
version-1 payload without a block still imports. It is a stub of the Phase-6 signing
story — hashes now, signatures later — and it is already the difference between "the
file I was sent" and "the file they published".

A stranger's companion servers arrive **disabled**. A distro is a document, not a
grant: the person forking it turns each server on once they have read what it does.
Façades carry no code and stay on. Your own distros are trusted.

## The gallery

Rows have a visibility (`private`, `tenant`, `public`), tags, a fork count, and a
preview record: the palette and the silhouettes of windows and widgets — a shape, not
a screenshot of anyone's contents. `distroList` is the gallery across tenants,
searchable by name, description and tag; `distroSet` changes who can see yours. The
Studio's Library draws the silhouettes, shows the visibility, and asks "this replaces
your OS: now N windows, after M" before a fork. Drop a `.sandboxos.json` on it to
install one. A new Sandbox can wake up wearing any seed or any distro you can see.

The **Workshop** seed shows the Tide-native posture: a Notebook app whose source is
three ordinary files in `apps/notebook/`, written into the Cell through `fs.write` as
the person forking (audited, refused if they cannot write), editable in Files, served
through the same containment check as everything else.

## The desktop without pixels

`desktop.summarize` returns the desktop as a short map — workspaces, windows with
app, title and geometry, the tiling tree described in one line, widgets, theme, custom
apps and their tools, revision — sized for a model's context. The assistant reads it
into its system prompt whenever the machine has a desktop and the caller may see it,
so "tidy this workspace" starts from what is there. `desktop.silhouette` is the
gallery's thumbnail as a tool: an SVG of shapes in the theme's colours, drawn from the
document, escaping anything that came from a string. Both are pure functions in
`packages/os/src/summary.js`, served to the browser too.

## Tests

`test/phase29.test.js`: façade attenuation both ways, reserved and duplicate names,
a hosted companion that keeps state across calls and restarts when its source is
rewritten, deregistration, a broken companion reported not fatal, revert
re-registering, integrity accepted/refused/legacy, publish carrying composition and
tags, a second tenant finding, forking and switching on, visibility enforced,
headless machines with no app servers, the Workshop seed, summarize, silhouette, and
a new Sandbox wearing a distro or a seed.
