# 15 · The OS Experience

> Docs 00–13 describe a machine you *reach*. This one describes a machine you are
> *in*: windows, widgets, workspaces, a dock, a theme, motion — and a builder that
> makes every one of those something you can change, fork and hand to someone else.
>
> Implemented in `packages/os`, exposed as the `desktop` MCP server, served at
> `/:slug/os` (the OS), `/:slug/studio` (the builder) and, since Phase 30, in a
> terminal as `sbx os tui`. Phase 27 built the place; Phases 28–30 (the heroplan)
> made it deep. This document describes what shipped, not what was planned.

---

## The one idea

**The desktop is a document.**

Not state in a browser tab, not a layout file the front end owns — one JSON object,
stored beside the Cell, versioned, and mutated only through `desktop.*` Kernel calls.
Everything follows from that:

- Your machine looks the same from a second tab, a phone, a terminal, or tomorrow,
  because the arrangement was never in the tab.
- An agent can rearrange, restyle and rebuild your desktop through the same door you
  do, with the same authorization and the same audit trail. It does not need to see
  pixels: `desktop.summarize` hands it the desktop as a map.
- Every change is revertible, because a document has revisions — and the history can
  say what each one changed.
- A whole machine can be packaged — the desktop, the source *and tools* of the apps
  you invented, and which servers the Cell runs — and forked by someone else, in
  your tenant or in the public gallery.

The corollary is the constraint that shapes the whole implementation: **nothing draws
the UI behind the Kernel's back.** If the OS shell can do it, `desktop.*` can do it,
and therefore an agent can do it too. Gestures may paint locally; they commit once,
through a tool, conditionally on the revision they were painted against.

---

## 1 · The document

`packages/os/src/schema.js` holds the shape, the defaults, the limits, and one
function — `normalizeDoc` — that every write in the system passes through.

```jsonc
{
  "version": 1, "id": "os_…", "name": "my-os", "rev": 41,
  "distro": { "id": "dtr_…", "name": "Research Box+", "forkedAt": 0, "tenant": "…", "visibility": "public" },

  "theme":     { "base": "midnight", "tokens": { "accent": "#35d6c4", "grain": 0.08 }, "custom": {} },
  "animation": { "preset": "spring", "custom": {}, "reducedMotion": "auto" },
  "wm":        { "mode": "tiling", "gap": 12, "snap": true, "gridSize": 8 },
  "shell":     { "menubar": {…}, "dock": {…}, "spotlight": {…}, "notifications": {…}, "associations": {…} },

  "workspaces": [ { "id": "ws_…", "n": 1, "name": "Main", "wallpaper": null,
                    "layout": { "type": "split", "dir": "row", "ratio": 0.6,
                                "a": { "type": "leaf", "id": "w_1" },
                                "b": { "type": "split", "dir": "col", "ratio": 0.5,
                                       "a": { "type": "leaf", "id": "w_2" }, "b": { "type": "leaf", "id": "w_3" } } } } ],
  "activeWorkspace": 1,

  "windows": [ { "id": "w_1", "app": "terminal", "title": "Terminal",
                 "x": 40, "y": 36, "w": 520, "h": 300, "z": 12, "ws": 1,
                 "min": false, "max": false, "props": { "tabs": [ … ] } } ],
  "widgets": [ { "id": "g_…", "kind": "clock", "x": 36, "y": 20, "w": 220, "h": 120, "ws": 1, "pin": "none", "props": {} } ],

  "apps": { "port-monitor": { "kind": "bundle", "permissions": ["ports.list"],
                              "mcp": { "name": "port-monitor", "enabled": true, "entrypoint": "server.js" } } },
  "widgetKinds": { "build-status": { "refreshMs": 30000, … } },
  "notifications": [ { "title": "build finished", "action": { "app": "metrics" }, … } ]
}
```

`normalizeDoc` **never throws**. Unknown fields are dropped, numbers are clamped,
lists are truncated at documented ceilings, a window pointing at a workspace that
does not exist is re-homed rather than lost, an alias that points at itself (or round
a ring) is removed, an app whose server would be called `fs` loses that block. A
malformed or hostile document cannot reach the renderer, which matters because the
document is writable by an agent.

Ceilings (`LIMITS`): 16 workspaces, 96 windows, 96 widgets, 128 apps, 64 widget kinds,
48 themes, 48 motion presets, 60 notifications, 40 revisions, 512 KB total; tiling
trees are at most 12 deep; props at most 8 KB.

### The tiling tree

`workspaces[].layout` is a binary tree: a split divides its box along `row` or `col`
at a `ratio` (0.1–0.9); a leaf is a window. The tree is **semantic** — "Terminal
takes the left 60%, the other two stack on the right" — and holds no pixels. It
always names exactly the windows on its workspace: `normalizeDoc` prunes what left
and splits in what arrived, so a document written before trees existed tiles
correctly, and `open` and `close` never touch the tree themselves.

Pixels are the renderer's: `packages/os/src/layout.js` has no Node imports and is
served to the browser at `/static/js/os/lib/layout.js` from the same file the Kernel
imports. The shell, the `desktop` server (for `arrange` in floating mode) and the TUI
compute the same boxes from the same tree; two viewports get different pixels from
one document, which is the point. Hidden and zoomed windows are pruned by the
renderer, not the document.

### Where it lives, and why it is not in the volume

`<home>/sandboxes/<id>/os/os.json`, a **sibling** of the Cell volume — with
`history.json` and the app bundles beside it. Deliberately outside the volume: the
volume is the Cell's own filesystem, and anything a process inside the sandbox can
rewrite at will is the wrong place to keep the code that renders the *trusted*
desktop. (An app can opt into the other posture — `origin: "volume"` — and the
Workshop seed shows what that feels like.)

---

## 2 · The `desktop` server

The syscall surface for the OS. Grouped, and complete:

| group | tools |
|---|---|
| document | `get` · `state` · `summarize` · `silhouette` · `set` · `patch` · `rename` · `history` · `revert` · `reset` |
| appearance | `themeList` · `themeSet` · `themeDefine` · `themeRemove` · `wallpaperSet` · `animationList` · `animationSet` · `animationDefine` · `animationRemove` |
| chrome | `dockSet` · `dockPin` · `shellSet` · `layoutSet` · `tile` · `associate` |
| workspaces | `workspaceList` · `workspaceAdd` · `workspaceRemove` · `workspaceRename` · `workspaceSwitch` |
| windows | `windowList` · `open` · `close` · `move` · `resize` · `focus` · `windowSet` · `arrange` · `snap` · `cycleFocus` · `minimizeAll` |
| widgets | `widgetList` · `widgetAdd` · `widgetRemove` · `widgetSet` |
| apps | `appList` · `appDefine` · `appRemove` · `appFiles` · `appRead` · `appWrite` · `appDelete` |
| widget kinds | `widgetDefine` · `widgetKindRemove` · `widgetFiles` · `widgetRead` · `widgetWrite` · `widgetDelete` |
| notifications | `notify` · `notificationsRead` · `notificationsClear` |
| distros | `distroList` · `distroPublish` · `distroSet` · `distroFork` · `distroExport` · `distroImport` |

Verbs were deepened rather than multiplied: `layoutSet` takes a tiling `preset`
(`master-stack`, `columns`, `rows`, `grid`) or an explicit `tree`; `tile` moves a
sash (`{ id, with, ratio }`), flips a split or swaps two leaves; `arrange` grew the
same presets plus `fullscreen-focus`; `move` and `resize` take `items` so an
alignment of six elements is one revision and one audit row; `windowSet { back }`
sends a window to the floor; `history { rev }` returns a structural diff;
`notificationsClear { id }` dismisses one; `notify` takes an `action` to deep-link to.

Two properties hold across all of them:

1. Every mutation goes through `store.mutateOs`, which normalizes, bumps `rev`, pushes
   the previous version onto the undo history, and announces the change on a bus.
2. No tool knows the size of the screen. `arrange` and `snap` take a `viewport` from
   the caller; `tile` and `layoutSet` write ratios. A tool that needed to know pixels
   would be a tool in the wrong layer.

The two document tools with no side effects deserve naming. **`summarize`** returns
the desktop as a short textual map — workspaces, windows with app/title/geometry, the
tiling tree described (`⇔60%[Terminal | ⇕50%[Files | Notes]]`), widgets, theme, custom
apps and their tools, revision — sized for a model's context. The assistant reads it
into its system prompt whenever the machine has a desktop, so "tidy this workspace"
starts from what is there. **`silhouette`** is a semantic screenshot: an SVG of window
and widget shapes in the theme's colours, drawn from the document and never from
what is inside a window. The gallery draws its thumbnails from the same record.

---

## 3 · Live, and honest about races

`GET /:slug/os/events` is an SSE stream of every `desktop.*` write, carrying the new
document. A second tab, the Studio, a TUI in an SSH session and an agent three steps
into a plan all converge on the same revision without anyone polling.

The client (`client.js`) treats the stream as the source of truth and the tool result
as a hint: after a call returns `rev`, it waits briefly, and pulls only if the stream
did not catch up. An event describing a revision older than the one in hand is
dropped, so out-of-order delivery can never rewind the desktop.

### The conflict policy

Every write is last-write-wins **unless it says otherwise**. Writes that describe a
*place* — where a gesture or an inspector field put something: `move`, `resize`,
`snap`, `tile`, `windowSet`, `widgetSet`, `layoutSet`, `arrange` — are sent by the
shell with `expectRev` set to the revision they were painted against. If the document
moved in the meantime (an agent got there first), the Kernel refuses with the code
`stale_rev`; the shell re-reads the document and says "Desktop moved — refreshed"
rather than silently overwriting the other editor. Nothing is retried blindly: the
person can see what changed and decide.

Known LWW cases, on purpose: a `themeSet` after another `themeSet` (the later one
wins, both are audited, revert restores either); `notify` and `notificationsRead`
(append-only in spirit); a `patch` without `expectRev`. A CRDT is not warranted for a
document one person and their agents edit; a refused write that explains itself is.

Gestures are the one bounded exception to "everything is a tool call": a drag paints
locally at pointer speed and commits **once**, on release. Sixty writes per drag would
be sixty audit rows describing a single intention. The same holds for a sash drag
(one `tile`), an arrow-key nudge (coalesced into one `move`), and an alignment (one
`move { items }`).

### Window management

`wm.mode` is `floating` or `tiling`. Tiling paints the workspace's tree with draggable
sashes between siblings and a focus ring on the leaf in front; `⌘`-shortcuts, the
context menu, Spotlight and Settings all offer the presets. Floating keeps the edge
snap: drag a window against an edge and the drop writes one `desktop.snap { region }`,
so the audit log records *what you asked for* rather than a pair of coordinates.

Keyboard, all of it the same tool calls the menus make: `⌘K` spotlight, `?` the cheat
sheet, `⌘1…9` workspaces, `⌘W` close, `⌘M` minimise, `⌘↑`/`⌘↓` zoom, `⌘←`/`⌘→` snap,
`` ⌘` `` cycle, `⌘⇧D` show desktop, `⌘⇧B` the Studio, `⌘⇧C` Command Central.

### Below 720px, the OS folds — and stays intentional

The same document, rendered for a phone: only the front window, full-bleed; the dock
becomes the switcher with labels and 44px targets; a row of dots switches workspaces
(tap, or swipe across them); swiping a title bar cycles windows; a long press on it
is the window menu; and the widgets slide into a **shelf** that pulls up from the
bottom instead of vanishing. Nothing about the document changes — no separate
"mobile layout" to keep in sync, no revision written when you rotate your phone.

### Notifications as a place

`desktop.notify` is the explicit call. Two things also notify on their own: a
supervised process ending and an agent coming back. Both go through
`packages/os/src/notify.js`, which holds one rule worth stating: **notifying never
creates a desktop.** `hasOs()` is the guard, and the same guard means a machine with
no desktop has no app servers either.

The notification centre groups by who is talking (Processes, Agents, System, each
app), every item is a deep link — its own `action`, or the app that sent it — and
each can be dismissed alone. A notification is in the document, so it is still there
tomorrow; a toast that nobody saw is not.

---

## 4 · Themes and motion — numbers in, stylesheet out

A theme is a flat map of colour tokens, a wallpaper, and a grain amount; the whole OS
reads those tokens and nothing else, which is what makes "restyle the machine" one
write. `GET /:slug/os/theme.css` compiles the active theme and motion preset into CSS
custom properties and `@keyframes`. The OS shell, the Studio's stage, and every custom
app frame link that same stylesheet, so they cannot drift — and the compilers
(`themes.js`, `animations.js`) are served to the browser too, so the Studio's live
previews use the very functions the Gateway does.

Both compilers are closed by construction, because the input is agent-writable:

- **Colours** must match a hex or `rgb()/rgba()` literal. Anything else is dropped.
- **Wallpapers** allow gradients and colours only — no `url()`, no `;`, no `<`, no
  backslash, capped at 1200 characters. The Studio's wallpaper builder can only emit
  strings this grammar accepts.
- **Grain** is a number (0–0.4) compiled to `--os-grain`; the atmosphere it paints is
  layered CSS gradients, never an image.
- **Motion presets are not CSS.** A preset is a record of numbers — opacity, scale, x,
  y, rotate, blur — clamped to sane ranges, with an easing chosen from a closed set.
  `animationCss` turns those numbers into keyframes. The Studio's motion designer is a
  set of sliders over exactly that grammar.

Every built-in theme passes a contrast check in the test suite (body text AA on
panels, muted text AA-large). `animation.reducedMotion` decides whether a viewer's
`prefers-reduced-motion` wins (`auto`, the default) or the preset does (`ignore`);
the decision is per viewer and written nowhere. Chrome transitions read the motion
tokens rather than hard-coded times, so "Instant" really is.

---

## 5 · Apps

An app id resolves to one descriptor shape whatever kind it is:

| kind | what it is |
|---|---|
| `builtin` | drawn by code we shipped — Files, Terminal, Console, Notes, Assistant, Observability, Media, Browser, Settings, Studio |
| `bundle` | HTML/CSS/JS the user or their agent wrote, served by this machine |
| `url` | a service somewhere else (typically an exposed port) |
| `alias` | another app under a different name — `open` resolves it, the window wears the alias's title |

A built-in and a bundle are the same thing to the window manager. "Built-in" only means
we shipped the code; delete one from the dock, write your own, and the OS does not
notice the difference.

The built-ins earned their pins in Phase 30. **Terminal** is a real PTY over the
Gateway's `/:slug/pty` socket — really a pty now: the shell runs under `script(1)`
inside the Cell (`packages/cell/src/pty.js`), so job control is on, `docker exec`
needs no TTY on our side, and resize is `stty` on the recorded tty. The renderer is
our own `ansi.js`, a proper grid — cursor addressing, scroll regions, an alternate
buffer — so `vim`, `htop` and a TUI you wrote paint; tabs are window props. An open
terminal counts as activity, so the idle reaper does not hibernate the Cell under it. **Files** has an optional second pane,
Tide status badges when the machine has a workspace, "Open with…" and drag-and-drop
upload. **Notes** is a folder of notes with a Markdown preview, still nothing but
`fs.*`. **Media** is a grid with a lightbox, plays audio and video the browser can
play (and says when it cannot), and notices when the folder changes. **Browser**
has **quick access**: it scans what is listening inside the machine and opens any
of it with one click (that click is `ports.expose` — nobody has to know the word),
remembers ports and paths in its props, and says clearly what to do when nothing is
listening. **Console** keeps a transcript. **Observability** has load and
memory sparklines, recent calls, and a link into the audit explorer. **Settings** has
a whole Desktop section — theme, motion, reduced motion, layout and tiling presets,
gap and grid, dock, menu bar, notifications, associations — so a machine can be
reshaped without the Studio. Widgets: the calendar navigates months (locally), the
weather is honest about egress and lets you change the place, the jobs widget can
tail and stop a process, a widget kind's `refreshMs` is a clock the *host* keeps and
pauses when the widget is off-screen, and framed widgets are told when they are
hidden.

**Which app opens a file** is `shell.associations` — extension → app id, in the
document. Files honours it on double-click, "Open with…" can change it, Spotlight
uses it, the Studio's app settings can claim extensions, and `desktop.associate` is
the tool.

### Writing an app

`desktop.appDefine` creates one and seeds a **runnable** starter; `desktop.appWrite`
writes a file. That is the whole loop, and it is the same loop the Studio's **Code**
tab (a real editor: file tree, tabs, syntax colour, ⌘S) and the agent both use — an
agent's `appWrite` lands in the open editor, and a CSS save hot-swaps into the running
frame without a reload.

```
desktop.appDefine { id: "port-monitor", name: "Port Monitor", permissions: ["ports.list"], starter: "tools" }
desktop.appWrite  { id: "port-monitor", path: "index.html", content: "…" }
desktop.open      { app: "port-monitor" }
```

Bundle storage is bounded and closed: 80 files, 512 KB per file, 4 MB per bundle, and
a fixed extension set. Paths are validated twice — by grammar (`safeRelPath`) and then
by a realpath containment check. With `origin: "volume"`, an app's source is ordinary
files inside the Cell instead — editable in Files and in the Studio (through `fs.*`),
versioned by Tide, served through the same containment check the raw file endpoint
uses. Choose the store for a trusted OS sibling that travels with distros; choose the
volume for an agent-and-Tide workflow where the app's source is part of the project.

### The other face: an app is an MCP server

docs/08 promised an app is a GUI for humans **and** an MCP server for agents.
[ADR-0004](adr/0004-app-mcp-duality.md) decides how, and both shapes are honest about
what they are:

- A **façade**: `mcp.tools[].proxy` names an existing Kernel tool. `port-monitor.list`
  *is* `ports.list`, run with the caller's grants intersected with the app's declared
  permissions, audited on both hops with `onBehalfOf: app:port-monitor`. No code runs
  anywhere new.
- A **companion**: `mcp.entrypoint` names a module in the bundle (`server.js` in the
  "UI + tools" starter). It runs in the same out-of-process host marketplace servers
  use, with an empty deps object — no Cell, no Kernel, no secrets — and the Kernel
  registers a proxy. It appears in `kernel.tools`, in Spotlight, in the Library card,
  and an agent can call `port-monitor.list` without a window ever opening.

The document is the source of truth: the Kernel reconciles its app servers with the
OS document on boot and on every desktop write, so define, remove, fork, revert and
reset all register and deregister through one path. Server names are closed
(`RESERVED_SERVER_NAMES`, plus anything installed), and a stranger's companion arrives
switched off.

### Running an app you do not trust

1. The frame is an iframe with `allow-scripts` and **not** `allow-same-origin`: opaque
   origin, no access to our cookies, our storage, or the parent DOM.
2. Its CSP is `default-src 'none'` with `connect-src 'none'` — it cannot reach the
   Gateway at all.
3. The Gateway injects `bridge.js` into every entry document, so `sbx` exists whether
   or not the author asked for it. Its only channel out is `postMessage`.
4. The shell's broker holds a machine token minted server-side for the **intersection**
   of what the app declared and what the person who opened it actually holds. The
   frame never sees that token. An app granted nothing gets no token at all.
5. What was requested and not granted comes back as `withheld` and is shown in the
   window, so an app can degrade honestly.

---

## 6 · Distros

A distro is the document **plus the source and tools of every custom app and widget
it needs, plus the Cell's composition**. That is the whole point of "totally
customizable": if you can build it, you can hand it over and the recipient gets your
machine, not a screenshot of it.

- `desktop.distroPublish` packages and stores it (control DB, `distros.os`), with
  `visibility` (`private`, `tenant`, `public`), `tags`, and a preview record the
  gallery draws silhouettes from. The row's manifest is a real Sandboxfile shape, so
  `POST /api/sandboxes { distro }` instantiates the Cell *and* the desktop.
- `desktop.distroList` is the gallery: seeds, your tenant's rows, and everyone's
  public ones, searchable by name, description and tag. `distroSet` changes who can
  see one you published.
- `desktop.distroFork` replaces this machine's OS with a distro — a seed, one of your
  tenant's, or a public one — importing bundles and applying the server composition
  (core servers only; installed marketplace servers are named, never installed).
  Lineage is recorded in `doc.distro`.
- `desktop.distroExport` / `distroImport` move the same payload as JSON. The payload
  carries a **SHA-256 integrity block** per bundle; import refuses a bundle that was
  modified after publish, and a version-1 payload without a block still imports.

A fork gets fresh element ids so two forks never collide. Notifications are stripped
unless you ask. A stranger's companion servers arrive **disabled** — a distro is a
document, not a grant; you switch each one on after reading what it does. Façades
carry no code and stay on.

Six built-in seeds ship: Developer Box, Research Box, Creator Studio, Social Ops,
Minimal, and **Workshop**, whose Notebook app's source lives in the Cell volume. A
brand-new Sandbox wakes up wearing Developer Box — or any seed or distro you name
when you create it.

---

## 7 · The Studio

`/:slug/studio` — build on the left, run on the right. The stage is **not** a mockup.
It is the desktop: same window manager, same widgets, same custom app frames, same
live document. There is no "publish to preview" step and no drift.

| surface | |
|---|---|
| Library | apps (with their tool count), widgets, themes, motion presets, and the distro gallery: search, tags, silhouettes, visibility, publish, fork with a diff of what changes, drag a `.sandboxos.json` in to install |
| Layers | what is on this workspace with z-order controls, plus all 40 revisions with labels, times, a structural diff, and a confirmed revert |
| Theme | a token editor for every `--os-*` key, a wallpaper builder, grain, save-as-theme, export as a tool call |
| Motion | a designer over the number grammar with a sample window; duplicate a preset and edit |
| Code | a multi-file editor with a tree, tabs, dirty state, ⌘S; volume-origin apps edit through `fs.*` |
| Inspector | one element's property sheet (geometry, workspace, pin, props JSON with its ceiling, z-order) — or, for several, align, distribute and match size as one revision |
| Agent | the streaming tool-use loop; every card that touched the desktop links back into the builder |

Design mode adds selection (shift-click for several), alignment guides, arrow-key
nudges and the grid; Preview mode takes them away. `⌘⇧P` is the Studio's own palette.
The builder's width, tab and code target persist in the browser — chrome, not desktop
truth.

---

## 8 · HTTP surface

| method | route | |
|---|---|---|
| `GET` | `/:slug/os` | the OS, full screen |
| `GET` | `/:slug/studio` | the builder |
| `GET` | `/:slug/os/doc` | document + resolved theme/motion + catalogs (apps annotated with their live tools) |
| `GET` | `/:slug/os/events` | SSE: every desktop change, plus catalog changes (`appServers`) and bundle writes (`appFiles`) |
| `GET` | `/:slug/os/theme.css` | the compiled theme and motion |
| `POST` | `/:slug/os/apps/:id/session` | open a capability session for an app frame |
| `GET` | `/:slug/os/apps/:id/*` · `/:slug/os/widgets/:kind/*` | a custom app's or widget's files (sandboxed, CSP-locked) |
| `GET` | `/static/js/os/lib/{layout,themes,animations,summary}.js` | the pure OS modules, served from `packages/os` |
| `POST` | `/api/sandboxes { distro | seed }` | a new machine wearing a distro or a seed |

Everything that *changes* the desktop goes through `POST /:slug/mcp` like any other
tool call.

---

## 9 · The second surface

`sbx os tui` renders the same document in a terminal: workspaces, the window list, a
miniature drawn from the same tiling arithmetic, and the desktop map (`M`). `j`/`k`,
`↵` focus, `x` close, `1–9` workspaces, `t` toggles tiling, `p` cycles presets, `o`
opens an app — every key is the same tool the browser calls, and the stream keeps it
current while an agent works. `sbx os map` prints the map; `sbx os silhouette`
writes the SVG.

The test suite pins the multi-client story: two event-stream clients and an agent
converge on the same revisions in order; a gesture and an agent racing on one
`expectRev` end with exactly one winner and one `stale_rev`.

---

## 10 · What is deliberately not here

- **No server-side rendering of the desktop.** The document is the contract; every
  renderer is a client. There are now three.
- **No per-app process isolation for UI.** A bundle is browser code in a sandboxed
  frame. An app's *tools* run out of process; an app that needs a process starts one
  with `proc.start`.
- **No CRDT.** Last-write-wins with `expectRev` on everything that describes a place,
  and a refusal that explains itself, is the policy. Multi-human editing of one
  desktop would be a product decision first.
- **No `runtime: "cell"` companions yet.** Giving app code a process on the machine is
  a capability decision, reserved in ADR-0004.
