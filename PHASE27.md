# Phase 27 — The Machine as a Place

Everything before this phase made the machine *reachable*: a slug, a Kernel, a console,
a CLI, an assistant. This one makes it somewhere you can be — an operating system in
the ordinary sense, with windows, widgets, workspaces, a dock and a theme — and then
gives that OS away, because none of it is fixed.

## The decision the rest follows from

**The desktop is a document, and the only way to change it is a Kernel call.**

One JSON object per Sandbox holds the windows, the widgets, the workspaces, the dock,
the theme, the motion and every app the machine has learnt. It is stored beside the
Cell, versioned, and mutated only by `desktop.*`.

That is not a storage choice, it is the feature. It buys, in order:

- The desktop survives the tab. Two browsers, a phone, and tomorrow all agree.
- An agent gets exactly the powers over your desktop that you have, through exactly the
  same door — authorize → route → execute → audit. There is no privileged path that
  draws the UI behind the Kernel's back, so "make it warmer and put the gallery
  bottom-right" is auditable, and revertible.
- Undo is free, because a document has revisions.
- A machine can be *packaged* — see distros below.

## What shipped

**`packages/os`** — the document (`schema.js`), the store and its live bus (`store.js`),
themes and their compiler (`themes.js`), motion presets (`animations.js`), the built-in
catalog (`catalog.js`), app resolution and capability attenuation (`apps.js`), bundle
storage (`bundles.js`) and the distro format (`distro.js`). No HTTP, no principals: it
turns documents into documents.

**`desktop` MCP server** — 45 tools across document, appearance, chrome, workspaces,
windows, widgets, apps, widget kinds, notifications and distros. Registered in the
catalog and enabled on existing machines by a one-shot manifest migration that records
itself, so a machine that deliberately removes the server does not get it back on the
next boot.

**Gateway routes** — `/:slug/os` (the OS), `/:slug/studio` (the builder), plus the four
things a browser cannot get through `/mcp`: `os/doc`, an SSE change feed at `os/events`,
compiled CSS at `os/theme.css`, and custom app files under `os/apps/:id/*`.

**The front end** — a dependency-free ES-module OS shell: window manager with floating
and tiling layouts, edge snapping with a live preview, drag and resize, minimise/zoom,
workspaces, dock, launcher, spotlight (apps, widgets, themes, actions and files),
notification centre, context menus, and a keyboard that drives all of it. Nine built-in
apps that are real clients of the Kernel — Files (with upload, rename, delete and
"open with"), **Terminal** (a real PTY over the existing `/:slug/pty` socket, rendered
by our own `ansi.js` rather than xterm from a CDN), Console (one Command Central line
at a time), Notes, Assistant, Observability, Media, Browser, Settings. Eight built-in
widgets that read the real machine and say so when a reading is unavailable rather than
inventing one. Below 720px the whole thing folds into a stack — same document, one
front window, dock along the bottom. Plus the Studio: Library, Layers, Theme, Code,
Inspector and the build agent, with the live OS as its stage — not a mockup of it.

## The part that had to be right

The promise is that an agent can write you an app. So the OS has to run code the Kernel
did not write, in a browser that holds your session cookie.

- The frame is `allow-scripts` **without** `allow-same-origin` → opaque origin: no
  cookies of ours, no parent DOM, no storage of ours.
- Its CSP is `default-src 'none'` with `connect-src 'none'` — it cannot reach the
  Gateway at all. (Sources name the origin explicitly; `'self'` matches nothing in an
  opaque origin, which would have blocked the very files being served.)
- `bridge.js` is injected into every entry document by the Gateway, so `sbx` exists
  whether the author asked or not, and `postMessage` is the only channel out.
- The shell's broker holds a token minted for the **intersection** of what the app
  declared and what its opener holds. The frame never sees it. An app that would be
  granted nothing gets no token — there is nothing to steal.
- What was asked for and not granted comes back as `withheld` and is shown in the
  window. An app should be able to degrade honestly.

`test/phase27.test.js` pins the attenuation, the containment (`../../../etc/passwd`
refused twice over), the closed CSS grammars, and the ceilings. A headless browser run
proved the rest end to end: a custom app, in its frame, wrote a file through the broker
and was refused a capability it had not declared — with both outcomes in the audit log.

## The machine tells you things

`desktop.notify` is the explicit call, but the two things you delegate and then stop
watching now announce themselves: a supervised process ending, and an agent coming
back. Both land in the document, so they are still there when you open the tab
tomorrow rather than being a toast nobody saw.

One rule makes that safe to wire into `proc` and `agents`: **notifying never creates a
desktop.** A Sandbox nobody has opened as an OS gets nothing — a `proc.start` on a
headless machine has no business materializing desktop state on disk. `hasOs()` is the
guard, and it is the reason `notify.js` is its own module rather than part of the store.

## Distros: a whole machine, packaged

A distro is now the document **plus the source of every custom app it needs**
(`distros.os`, an additive nullable column — Phase-4 manifest-only distros are
untouched). Publish yours, fork someone else's, and you get their machine rather than a
screenshot of it: same theme, same motion, same windows, same code behind the windows.
Forks get fresh ids and record their lineage.

Five seeds ship — Developer Box, Research Box, Creator Studio, Social Ops, Minimal —
and a brand-new Sandbox wakes up wearing Developer Box. An arranged desktop is a better
first impression than an empty one, and it is deletable like everything else.

## Tests

42 new in `test/phase27.test.js`: the normalizer's refusal to produce anything
unrenderable; the theme and motion compilers' closed grammars; bundle path containment;
first-run seeding and its idempotence; windows, widgets and workspaces (including
re-homing what a deleted workspace held); snapping, focus cycling and show-desktop;
file associations; system notifications and the rule that they never create a desktop;
revert; app definition, source and attenuation; publish/fork/export/import and the
payload ceiling; the live bus; and the whole HTTP surface.

Suite: 547 tests, 501 passing. The 46 failures are the pre-existing Windows shell
failures, unchanged from before this phase.

A headless browser run covers what unit tests cannot: both pages boot and paint, the
Terminal's PTY actually connects and reports `connected`, the phone layout folds to a
single front window with the dock still reachable, and a custom app in its sandboxed
frame writes a file through the broker while being refused a capability it never
declared — with both outcomes in the audit log.

## What is deliberately not here

Server-side rendering of the desktop (the document is the contract; a second renderer
is additive), per-app process isolation (a bundle is browser code — an app that needs a
process starts one with `proc.start`), a cross-tenant distro registry (the payload is
portable, so it is additive), and conflict resolution beyond last-write-wins with an
optional `expectRev`. A CRDT is not warranted for a document one person and their agents
edit.
