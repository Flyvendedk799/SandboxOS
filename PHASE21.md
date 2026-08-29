# Phase 21 — The Desktop

Phase 20 gave the machine hands. Phase 21 gives it a face.

The old console was a single 641-line script, one stylesheet, and five tabs. It proved
the spine worked. It was not a place you would spend a day. This phase replaces it with
a real desktop: a design system, a shell, eleven workspaces, a file manager with a code
editor, a command palette, and the data-plane endpoints they need.

## The data plane

**Raw file transfer.** The MCP surface moves file *content* as JSON, which is right for
agents and wrong for a browser — a 40 MB video should not become a base64 string in a
JSON envelope. Two endpoints stream bytes instead, authorized against exactly the same
capabilities as their MCP twins:

- `GET /:slug/file?path=…[&download=1]` — streams a file out, with a real content type
  and an optional `Content-Disposition`. A missing file is a 404; a path that tries to
  leave the volume is a 400, because a typo should not look like an attack.
- `PUT /:slug/file?path=…` — streams an upload in, and writes the same audit event an
  equivalent `fs.write` would, so a streamed upload is not invisible next to the MCP path.

Absolute paths mean *the Sandbox's* root, not the host's: inside your machine,
`/etc/hosts` is your machine's `/etc/hosts`.

**The `metrics` server.** Observability is a capability like any other, so it is a
server rather than a side channel — an agent can watch its own Sandbox's load with the
same call the dashboard makes, and every read is authorized and audited.

| tool | what it answers |
|------|-----------------|
| `metrics.snapshot` | load, memory, disk, process count, enabled servers, exposed ports |
| `metrics.history` | rolling samples, so the dashboard can draw a line rather than a number |
| `metrics.activity` | audit rollups by kind, server and tool, plus an evenly-bucketed histogram |
| `metrics.recent` | the latest audit events |

Readings come from inside the Cell where they are meaningful and from the control plane
where they are not. Anything a backend cannot answer comes back `null` rather than zero:
a missing reading and an idle machine are different facts.

**`kernel.tools`.** The unified catalogue, exposed reflexively. It is what the command
palette searches and what tab-completion completes against, and it tracks the manifest —
disable a server and its tools leave the catalogue immediately.

## The desktop

`apps/gateway/public/` is now a design system plus twelve ES modules, still with no
build step and no framework.

**`styles.css`** is organised as tokens → reset → primitives → shell → workspaces →
overlays. Every colour, space, radius and duration is a token defined once. The metaphor
is the one the project already committed to: surfaces are wet-sand dark, the accent is
tide-water, highlights are dry sand. A light theme inverts the ground without changing
the hues, and the toggle persists.

**The shell** is a rail of workspaces (⌘1–⌘0), a topbar with the machine switcher and
the omnibox, a collapsible activity dock, and a status bar that always answers "what is
this machine doing": Cell state, backend, running processes, exposed ports.

**Workspaces**

- **Console** — Command Central, streamed over SSE so a long `npm install` prints as it
  runs. History, tab-completion over verbs and the live tool catalogue, and a
  propose→confirm card for natural language.
- **Files** — a lazy tree with rename/duplicate/delete/upload/download and
  drag-and-drop, beside a tabbed editor with dirty markers.
- **Shell** — the WebSocket PTY.
- **Agents** — spawn, watch, inspect the granted capabilities, kill, re-run.
- **Ports** — expose, probe, and *preview*: the app you started with `run` in an iframe,
  proxied through the Gateway.
- **Processes** — supervised processes with a live log tail, and the cron schedule.
- **Apps**, **Secrets** — the app model and reference-not-value secret handling.
- **Metrics** — the dashboard, drawn as hand-written SVG.
- **Settings** — account, provider key, Cell power and quota, the manifest edited live,
  sandboxes, distros, and machine tokens.

**The editor** (`js/editor.js`) is ~350 dependency-free lines. Two layers share one box:
a `<pre>` paints highlighted tokens and a transparent `<textarea>` above it owns the
caret, selection, undo and scrolling, with the scroll offsets mirrored onto the paint
layer and the gutter. It highlights nine language families, and it indents, dedents,
auto-closes pairs, wraps a selection, toggles comments, and saves on ⌘S. It is not
CodeMirror and does not need to be — a dependency-free page loads instantly on a phone
over a tunnel.

**The palette** (⌘K) searches four sources at once — workspaces, actions panels register
themselves, files in the tree, and the live tool catalogue — ranked by a fuzzy
subsequence score, so `fsw` finds `fs.write`. Anything you type is also offered as a
console command or as a natural-language ask.

**Graceful degradation.** xterm.js loads from a CDN, which is exactly the thing that is
missing on an air-gapped host or behind a strict egress policy. Rather than leaving the
Shell tab dead, it falls back to a built-in renderer: it cannot draw vim, but it runs a
shell, which is what most sessions need. The desktop itself has no external dependency
at all.

## Notes from building it

`h()`, the DOM helper, treated its second argument as props whenever it was truthy and
not a string, node or array — which silently swallowed *numeric* children. `metrics`
showed a blank process count because of it. It now treats only a plain object as props.

The status bar's `.item` class collided with the `.item` card class and rendered five
cards along the bottom of the window. Renamed to `.sb`.

## Tests

`test/phase21.test.js` — 16 tests over the file-transfer endpoints (round trips
including byte-exact binary, containment, the audit trail, auth, and 404-vs-400), the
metrics server (snapshot shape, history accumulation, rollups, evenly-spaced histogram
buckets), and `kernel.tools` tracking the manifest.

The desktop itself was driven end to end in a real browser: log in, onboard, start a
server inside the Cell with `run`, watch it in Processes, expose its port, preview it in
the iframe, type in the editor and save, spawn an agent, store a secret, and check the
phone layout. Zero console errors. Full suite: 393 passing.
