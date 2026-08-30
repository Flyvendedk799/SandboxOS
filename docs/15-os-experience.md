# 15 · The OS Experience

> Docs 00–13 describe a machine you *reach*. This one describes a machine you are
> *in*: windows, widgets, workspaces, a dock, a theme, motion — and a builder that
> makes every one of those something you can change, fork and hand to someone else.
>
> Implemented in `packages/os`, exposed as the `desktop` MCP server, served at
> `/:slug/os` (the OS) and `/:slug/studio` (the builder).

---

## The one idea

**The desktop is a document.**

Not state in a browser tab, not a layout file the front end owns — one JSON object,
stored beside the Cell, versioned, and mutated only through `desktop.*` Kernel calls.
Everything follows from that:

- Your machine looks the same from a second tab, a phone, or tomorrow, because the
  arrangement was never in the tab.
- An agent can rearrange, restyle and rebuild your desktop through the same door you
  do, with the same authorization and the same audit trail. "Add a weather widget
  bottom-right and warm the palette up" is three tool calls, not a screen-scrape.
- Every change is revertible, because a document has revisions.
- A whole machine can be packaged — including the source of apps you invented — and
  forked by someone else.

The corollary is the constraint that shapes the whole implementation: **nothing draws
the UI behind the Kernel's back.** There is no privileged path from the browser to the
desktop. If the OS shell can do it, `desktop.*` can do it, and therefore an agent can
do it too.

---

## 1 · The document

`packages/os/src/schema.js` holds the shape, the defaults, the limits, and one
function — `normalizeDoc` — that every write in the system passes through.

```jsonc
{
  "version": 1, "id": "os_…", "name": "my-os", "rev": 41,
  "distro": { "id": "dtr_…", "name": "Developer Box", "forkedAt": 0 },

  "theme":     { "base": "midnight", "tokens": { "accent": "#35d6c4" }, "custom": {} },
  "animation": { "preset": "spring", "custom": {} },
  "wm":        { "mode": "floating", "gap": 12, "snap": true, "gridSize": 8 },
  "shell":     { "menubar": {…}, "dock": {…}, "spotlight": {…}, "notifications": {…} },

  "workspaces": [ { "id": "ws_…", "n": 1, "name": "Main", "wallpaper": null } ],
  "activeWorkspace": 1,

  "windows": [ { "id": "w_…", "app": "files", "title": "Files",
                 "x": 40, "y": 36, "w": 360, "h": 250, "z": 12, "ws": 1,
                 "min": false, "max": false, "props": {} } ],
  "widgets": [ { "id": "g_…", "kind": "clock", "x": 36, "y": 20,
                 "w": 220, "h": 120, "ws": 1, "pin": "none", "props": {} } ],

  "apps":        { "port-monitor": { /* custom app definitions */ } },
  "widgetKinds": { "build-status": { /* custom widget definitions */ } },
  "notifications": [ … ]
}
```

`normalizeDoc` **never throws**. Unknown fields are dropped, numbers are clamped,
lists are truncated at documented ceilings, a window pointing at a workspace that
does not exist is re-homed rather than lost. A malformed or hostile document cannot
reach the renderer, which matters because the document is writable by an agent.

Ceilings (`LIMITS`): 16 workspaces, 96 windows, 96 widgets, 128 apps, 64 widget kinds,
48 themes, 48 motion presets, 60 notifications, 40 revisions, 512 KB total.

### Where it lives, and why it is not in the volume

`<home>/sandboxes/<id>/os/os.json`, a **sibling** of the Cell volume — with
`history.json` and the app bundles beside it.

Deliberately outside the volume: the volume is the Cell's own filesystem, and anything
a process inside the sandbox can rewrite at will is the wrong place to keep the code
that renders the *trusted* desktop. Changing the desktop is an audited `desktop.*`
call, not a stray `fs.write`. (An app can opt into the other posture — see `origin:
"volume"` below — but that is a choice the app's definition records.)

---

## 2 · The `desktop` server

The syscall surface for the OS. Grouped, and complete:

| group | tools |
|---|---|
| document | `get` · `state` · `set` · `patch` · `rename` · `history` · `revert` · `reset` |
| appearance | `themeList` · `themeSet` · `themeDefine` · `themeRemove` · `wallpaperSet` · `animationList` · `animationSet` · `animationDefine` · `animationRemove` |
| chrome | `dockSet` · `dockPin` · `shellSet` · `layoutSet` · `associate` |
| workspaces | `workspaceList` · `workspaceAdd` · `workspaceRemove` · `workspaceRename` · `workspaceSwitch` |
| windows | `windowList` · `open` · `close` · `move` · `resize` · `focus` · `windowSet` · `arrange` · `snap` · `cycleFocus` · `minimizeAll` |
| widgets | `widgetList` · `widgetAdd` · `widgetRemove` · `widgetSet` |
| apps | `appList` · `appDefine` · `appRemove` · `appFiles` · `appRead` · `appWrite` · `appDelete` |
| widget kinds | `widgetDefine` · `widgetKindRemove` · `widgetFiles` · `widgetRead` · `widgetWrite` |
| notifications | `notify` · `notificationsRead` · `notificationsClear` |
| distros | `distroList` · `distroPublish` · `distroFork` · `distroExport` · `distroImport` |

Two properties hold across all of them:

1. Every mutation goes through `store.mutateOs`, which normalizes, bumps `rev`, pushes
   the previous version onto the undo history, and announces the change on a bus.
2. No tool knows the size of the screen. `arrange` takes a `viewport` from the caller;
   tiling geometry is computed in the client from `wm.mode`. A tool that needed to know
   pixels would be a tool in the wrong layer.

---

## 3 · Live, without polling

`GET /:slug/os/events` is an SSE stream of every `desktop.*` write, carrying the new
document. A second tab, the Studio, and an agent three steps into a plan all converge
on the same revision without anyone polling.

The client (`client.js`) treats the stream as the source of truth and the tool result
as a hint: after a call returns `rev`, it waits briefly, and pulls only if the stream
did not catch up. An event describing a revision older than the one in hand is dropped,
so out-of-order delivery can never rewind the desktop.

Gestures are the one exception, and the exception is bounded: a drag paints locally at
pointer speed and commits **once**, on release. Sixty writes per drag would be sixty
audit rows describing a single intention.

---

### Window management

`wm.mode` is `floating` or `tiling`; tiling geometry is computed in the client from
the live viewport, so the same document tiles correctly on two differently sized
screens at once.

Dragging a window against an edge offers a **snap**: halves, quarters, or full. The
preview is drawn locally and the drop writes one `desktop.snap { region }` — which
means the audit log records *what you asked for* rather than a pair of coordinates
nobody can read back later.

Keyboard, all of it the same tool calls the menus make: `⌘K` spotlight, `⌘1…9`
workspaces, `⌘W` close, `⌘M` minimise, `⌘↑`/`⌘↓` zoom, `⌘←`/`⌘→` snap, `` ⌘` `` cycle,
`⌘⇧D` show desktop.

### Below 720px, the OS folds

The same document, rendered as a stack: only the front window, full-bleed, and the dock
becomes the switcher along the bottom. Nothing about the document changes — no separate
"mobile layout" to keep in sync, no revision written when you rotate your phone. A
desktop metaphor on a 390px screen is a worse answer than no windows at all, and the
place to decide that is the renderer, not the model.

### Notifications the machine sends you

`desktop.notify` is the explicit call. Two things also notify on their own, because
they are the two you delegate and then stop watching:

- a **supervised process** ending (`proc.start` → exited / failed / stopped),
- an **agent** coming back (done / failed / killed).

Both go through `packages/os/src/notify.js`, which holds one rule worth stating:
**notifying never creates a desktop.** A Sandbox nobody has opened as an OS gets
nothing — a `proc.start` on a headless machine should not quietly materialize desktop
state on disk. `hasOs()` is the guard.

## 4 · Themes and motion — numbers in, stylesheet out

A theme is a flat map of colour tokens plus a wallpaper; the whole OS reads those
tokens and nothing else, which is what makes "restyle the machine" one write.

`GET /:slug/os/theme.css` compiles the active theme and motion preset into CSS custom
properties and `@keyframes`. The OS shell, the Studio's stage, and every custom app
frame link that same stylesheet, so they cannot drift.

Both compilers are closed by construction, because the input is agent-writable:

- **Colours** must match a hex or `rgb()/rgba()` literal. Anything else is dropped.
- **Wallpapers** allow gradients and colours only — no `url()`, no `;`, no `<`, no
  backslash, capped at 1200 characters.
- **Motion presets are not CSS.** A preset is a record of numbers — opacity, scale, x,
  y, rotate, blur — clamped to sane ranges, with an easing chosen from a closed set.
  `animationCss` turns those numbers into keyframes. The expressive range stays wide
  and the injection surface stays closed.

---

## 5 · Apps

An app id resolves to one descriptor shape whatever kind it is:

| kind | what it is |
|---|---|
| `builtin` | drawn by code we shipped — Files, Terminal, Console, Notes, Assistant, Observability, Media, Browser, Settings, Studio |
| `bundle` | HTML/CSS/JS the user or their agent wrote, served by this machine |
| `url` | a service somewhere else (typically an exposed port) |
| `alias` | another app under a different name |

A built-in and a bundle are the same thing to the window manager. "Built-in" only means
we shipped the code; delete one from the dock, write your own, and the OS does not
notice the difference.

Two of the built-ins are worth naming. **Terminal** is a real PTY over the Gateway's
existing `/:slug/pty` WebSocket, rendered by `ansi.js` — ours, not xterm from a CDN,
because an OS that needs the public internet to draw its own terminal is not one. The
cost is stated in the window: no alternate screen buffer, so full-screen TUIs do not
paint. **Console** is the other half — one Command Central line at a time (`ls`,
`:call server.tool {}`, `? plain English`), which works everywhere a PTY does not.

**Which app opens a file** is `shell.associations` — extension → app id, in the
document. Files honours it on double-click, "Open with…" can change it, and
`desktop.associate` is the tool. Opening a `.png` in a text editor is technically
correct and practically wrong, and which app wins should be the user's call.

### Writing an app

`desktop.appDefine` creates one and seeds a **runnable** starter — an `index.html`, a
stylesheet and a script that already calls the machine. `desktop.appWrite` writes a
file. That is the whole loop, and it is the same loop the Studio's **Code** tab and the
agent both use:

```
desktop.appDefine { id: "port-monitor", name: "Port Monitor", permissions: ["ports.list"] }
desktop.appWrite  { id: "port-monitor", path: "index.html", content: "…" }
desktop.open      { app: "port-monitor" }
```

Bundle storage is bounded and closed: 80 files, 512 KB per file, 4 MB per bundle, and
a fixed extension set. Paths are validated twice — by grammar (`safeRelPath`: no
absolute roots, no `..`, no backslashes, no traversal) and then by a realpath
containment check.

With `origin: "volume"`, an app's source is ordinary files inside the Cell instead —
editable in Files, versioned by Tide, served through the same containment check the raw
file endpoint uses.

### Running an app you do not trust

This is the part that has to be right, because the promise is that an *agent* can write
these.

1. The frame is an iframe with `allow-scripts` and **not** `allow-same-origin`, so it
   has an opaque origin: no access to our cookies, our storage, or the parent DOM.
2. Its CSP is `default-src 'none'` with `connect-src 'none'` — it cannot reach the
   Gateway at all. (Sources name the origin explicitly rather than using `'self'`,
   which in an opaque origin matches nothing.)
3. The Gateway injects `bridge.js` into every entry document, so `sbx` exists whether
   or not the author asked for it. Its only channel out is `postMessage`.
4. The shell's broker holds a machine token minted server-side for the **intersection**
   of what the app declared and what the person who opened it actually holds. The frame
   never sees that token. An app that would be granted nothing gets no token at all —
   there is no credential to steal.
5. What was requested and not granted comes back as `withheld` and is shown in the
   window, so an app can degrade honestly instead of failing at its first call.

The client-side pattern check in the broker is a courtesy — it turns a denial into a
clean error rather than an audit row. The real boundary is the Kernel, which refuses
anything outside the token's grants regardless of what the browser does.

---

## 6 · Distros

A distro is the document **plus the source of every custom app and widget it needs**.
That is the whole point of "totally customizable": if you can build it, you can hand it
over and the recipient gets your machine, not a screenshot of it.

- `desktop.distroPublish` packages and stores it (control DB, `distros.os`).
- `desktop.distroFork` replaces this machine's OS with a distro — built-in seed or one
  your tenant published — importing bundles as it goes.
- `desktop.distroExport` / `distroImport` move the same payload as JSON. The Studio
  writes it to a `.sandboxos.json` file and reads one back, which is how a distro
  leaves your tenant today. An imported payload is bounded (8 MB) and normalized
  before any of it becomes disk — it arrives from outside, so it is untrusted input.

A fork gets fresh element ids so two forks of one distro never collide, and records its
lineage in `doc.distro`. Notifications are stripped: a distro should not carry someone
else's inbox.

Five built-in seeds ship: Developer Box, Research Box, Creator Studio, Social Ops,
Minimal. A brand-new Sandbox wakes up wearing Developer Box — an arranged desktop, not
an empty one.

---

## 7 · The Studio

`/:slug/studio` — build on the left, run on the right.

The stage is **not** a mockup. It is the desktop: same window manager, same widgets,
same custom app frames, same live document. There is no "publish to preview" step and
no drift between them.

| surface | |
|---|---|
| Library | apps, widgets, themes, motion presets, distros — click to place; right-click a custom app for its settings, source, or deletion |
| Layers | what is on this workspace, plus the revision history to revert to |
| Theme | base theme, accent token, wallpaper, motion |
| Code | the files behind any custom app or widget, editable and saved through `desktop.appWrite` |
| Inspector | the selected element's title, geometry and workspace |
| Agent | the streaming tool-use loop, with `desktop.*` in its tool surface |

Saving in **Code** — or an agent calling `desktop.appWrite` — reloads every open frame
of that app. That is the loop closing: you ask, it writes, the window in front of you
changes, and you never touched a refresh button.

Design mode adds selection and an alignment grid; Preview mode takes them away. Both
are the same desktop.

---

## 8 · HTTP surface

| method | route | |
|---|---|---|
| `GET` | `/:slug/os` | the OS, full screen |
| `GET` | `/:slug/studio` | the builder |
| `GET` | `/:slug/os/doc` | document + resolved theme/motion + catalogs |
| `GET` | `/:slug/os/events` | SSE: every desktop change |
| `GET` | `/:slug/os/theme.css` | the compiled theme and motion |
| `POST` | `/:slug/os/apps/:id/session` | open a capability session for an app frame |
| `GET` | `/:slug/os/apps/:id/*` | a custom app's files (sandboxed, CSP-locked) |
| `GET` | `/:slug/os/widgets/:kind/*` | a custom widget's files |

Everything that *changes* the desktop goes through `POST /:slug/mcp` like any other
tool call. These routes are the parts a browser cannot get that way: the shell itself,
a change feed, compiled CSS, and untrusted files.

---

## 9 · What is deliberately not here

- **No server-side rendering of the desktop.** The document is the contract; the
  renderer is a client. A second renderer (native, TUI) is a supported future, not a
  missing piece.
- **No per-app process isolation.** A bundle is browser code in a sandboxed frame, not
  a process in the Cell. An app that needs a process starts one with `proc.start` like
  everything else.
- **No cross-tenant distro registry yet.** Publishing is tenant-scoped. The payload
  format is portable, so a registry is additive.
- **No conflict resolution beyond last-write-wins + `expectRev`.** Two people dragging
  the same window is a race with a defined winner; a CRDT is not warranted for a
  document one person and their agents edit.
