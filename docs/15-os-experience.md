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
  "notifications": [ { "title": "build finished", "source": "procs", "quiet": true, "action": { "app": "metrics" }, … } ],
  "proposals":   [ { "id": "prop_…", "label": "tidy the workspace", "by": "prn_…",
                     "ops": [ { "tool": "arrange", "args": { "preset": "grid" } } ] } ],
  "checkpoints": [ { "id": "cp_…", "name": "before the redesign", "rev": 41, "ts": 0 } ]
}
```

`normalizeDoc` **never throws**. Unknown fields are dropped, numbers are clamped,
lists are truncated at documented ceilings, a window pointing at a workspace that
does not exist is re-homed rather than lost, an alias that points at itself (or round
a ring) is removed, an app whose server would be called `fs` loses that block. A
malformed or hostile document cannot reach the renderer, which matters because the
document is writable by an agent.

Ceilings (`LIMITS`): 16 workspaces, 96 windows, 96 widgets, 128 apps, 64 widget kinds,
48 themes, 48 motion presets, 60 notifications, 8 proposals (24 ops each),
12 checkpoints, 40 revisions, 512 KB total; tiling trees are at most 12 deep; props at
most 8 KB.

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
`history/` (one file per revision plus a small index) and the app bundles beside it. Deliberately outside the volume: the
volume is the Cell's own filesystem, and anything a process inside the sandbox can
rewrite at will is the wrong place to keep the code that renders the *trusted*
desktop. (An app can opt into the other posture — `origin: "volume"` — and the
Workshop seed shows what that feels like.)

---

## 2 · The `desktop` server

The syscall surface for the OS. Grouped, and complete:

| group | tools |
|---|---|
| document | `get` · `state` · `summarize` · `silhouette` · `set` · `patch` · `rename` · `history` · `revert` (whole or `only:[…]`) · `revertScopes` · `reset` |
| appearance | `themeList` · `themeSet` · `themeDefine` · `themeRemove` · `wallpaperSet` · `animationList` · `animationSet` · `animationDefine` · `animationRemove` |
| chrome | `dockSet` · `dockPin` · `shellSet` · `layoutSet` · `tile` · `associate` |
| workspaces | `workspaceList` · `workspaceAdd` · `workspaceRemove` · `workspaceRename` · `workspaceSwitch` |
| windows | `windowList` · `open` · `close` · `move` · `resize` · `focus` · `windowSet` · `arrange` · `snap` · `cycleFocus` · `minimizeAll` |
| widgets | `widgetList` · `widgetAdd` · `widgetRemove` · `widgetSet` |
| apps | `appList` · `appDefine` · `appRemove` · `appFiles` · `appRead` · `appWrite` · `appDelete` |
| widget kinds | `widgetDefine` · `widgetKindRemove` · `widgetFiles` · `widgetRead` · `widgetWrite` · `widgetDelete` |
| notifications | `notify` · `notificationsRead` · `notificationsClear` |
| distros | `distroList` · `distroPublish` · `distroSet` · `distroFork` · `distroExport` · `distroImport` |
| review | `propose` · `proposals` · `applyProposal` · `discardProposal` |
| checkpoints | `checkpoint` · `checkpoints` · `checkpointRestore` · `checkpointDiff` · `checkpointRemove` |
| keyboard | `keyList` · `keySet` |
| apps as principals | `appLedger` · `appSuspend` |

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

A stream that comes back after a gap has missed every write inside it, so the `hello`
frame carries the revision the document is *actually* at; a client whose own revision
disagrees re-reads before painting anything. Without that, a tab that slept through
three agent writes kept showing a desktop that no longer existed and said nothing.

### Reviewable, not just revertible

An agent's change to the desktop is always undoable, and since Phase 33 it can also
be read *before* it happens. `desktop.propose` stores a change as a document object:
a label, who asked, and `ops` that are ordinary `desktop.*` calls with their
arguments. Nothing runs. `applyProposal` executes them in order **as whoever applied
it** — through the same tools, so a proposal can never do something its applier could
not do by hand — and reports which ops landed and where it stopped if one failed.
`discardProposal` throws it away.

Because a proposal is in the document, it survives a reload, appears in a second tab,
and is itself revertible. The Studio's agent panel has a **Review changes** switch: with
it on, the assistant's `desktop.*` *writes* are captured into one proposal per turn
(reads pass through — an agent that cannot look at the desktop cannot propose anything
sensible about it), the system prompt says so, and the panel shows each proposal as a
list of calls with Apply and Discard.

### Why the document is still v1

`OS_DOC_VERSION` is 1, and T5.4 of `goal.md` asked for v2 "when, and only when, it
is earned". It has not been.

Everything the document has gained — the keymap, do-not-disturb, proposals,
checkpoints, first-run state, an app's suspended flag, the tiling tree, "open
with", reduced motion, distro lineage — is *additive*. `normalizeDoc` fills each one
from the defaults when it is absent, and no field has changed meaning or shape, so
there is no migration to write. A v2 would tell a reader nothing that the presence
of the fields does not already tell it, and a bump whose only content is a larger
number teaches everyone downstream to ignore the number.

What was actually missing was not the bump but the machinery a bump will need, and
that now exists. `docCompatibility(doc)` reads the version and says whether a
document came from a build newer than this one. Where that matters — importing a
distro, restoring a backup — a newer document is **refused** with
`code: "newer_document"`, because `normalizeDoc` keeps only the fields this build
knows, which is exactly what makes it safe against a hostile document and exactly
what would make forking a newer person's desktop a silent, partial, unexplained
loss. A newer payload envelope is refused the same way.

`test/phase40.test.js` is the evidence rather than the claim: documents shaped the
way each earlier wave of this project wrote them — the earliest windows-and-a-dock
desktops, then custom apps and widgets, then tiling and companion servers and
lineage — are loaded and checked twice over. What they meant still survives (name,
revision, theme and its overrides, dock, every window with its props, every custom
app with its capabilities); what they never had arrives at its default. Today's
ceilings still apply to a document from before them, and a machine from the future
is named as such instead of being cut down to fit.

### First run: one screen, and a machine already working

A machine nobody has set up carries `setup: { done: false }` in its document — a
fact about the machine, not a flag in a browser, so a second tab and a phone agree
about it. The OS shows one screen before the desktop paints: the single idea in
four cards, the seeds to start from, and a way to skip.

`desktop.setupSeeds` offers the seeds. `desktop.setup { seed }` then does the work,
in order: adopt the seed as this machine's desktop; write a `welcome/` folder and a
first note into the volume; ask the Cell what it has that can serve a folder (node,
python3, python, busybox — in that order, by running each one); start it as a
supervised job called `welcome`; wait, and look again, because a static server's
usual failure is EADDRINUSE a few milliseconds after it spawns; expose the port;
open the Browser on it beside the Manual; and mark the machine set up. One revision
for the document part.

It returns a `steps` list — what, whether, and why not — and the welcome screen
prints exactly that. An image with no Node and no Python cannot serve a folder, and
the honest version of that is a named failure with the folder still sitting there,
not a spinner. A partial setup offers "take me to the desktop anyway" rather than
standing in the way. If every ordinary port is already in use, it says so instead
of handing back a port the server would die on.

`desktop.reset` keeps `setup`. Someone clearing their windows and their theme is not
a new user, and greeting them with onboarding again answers a question they did not
ask.

Two things fell out of building it, both of the same family as the rest of Track 0.
The desktop no longer paints behind the welcome screen: mounting the seed's apps
under the panel had the Terminal writing its session into a document first run was
about to replace, which surfaced as "someone else changed it first" on a machine
nobody else had ever touched. And `loadOs()` can no longer rewind the client: a full
read that raced an event on the stream used to adopt the older document it answered
with, and the next conditional write was then refused as stale.

### The Manual is an app, and it reads this build

`help` is a built-in app with two halves and one search box. The **manual** is
the repository's own documentation — `docs/15`, the surface map, the architecture,
the Kernel, the security model, distros, the glossary and `goal.md` — fetched
from `/:slug/os/manual` and rendered in the window. Nothing is copied: if a
sentence in that window is wrong, the file in `docs/` is wrong, and one edit
fixes both. The page id is looked up in a fixed table, so the route cannot be
talked into reading anything else, and it needs `desktop.get` — the right that
lets you see the desktop is the right that lets you read about it.

The **catalogue** is `kernel.tools`: every tool of every enabled server on this
machine, with its description and its arguments. A custom app's companion server
appears in it the moment it is switched on and vanishes when it is switched off,
because the list is the machine's answer rather than one somebody maintains.

Every tool has a **Try it**, and it fills Spotlight with the tool's name rather
than running it. That is deliberate: the manual hands you to the thing that runs
it, in the place you would have reached for anyway, instead of firing a call you
have not read. A tool that takes no arguments also has a **Run**, which does.
Spotlight itself now carries the whole catalogue, so the handoff lands on a row
that works.

### Snapshots on a schedule

A scheduled snapshot is not a new mechanism: it is a `cron` job that calls
`desktop.checkpoint { name, auto: true }` on your behalf, with your capabilities,
audited like any other call — which is why it appears in Jobs → Schedule and in the
audit log, and why a principal who cannot take a checkpoint by hand cannot schedule
one either. Settings → Checkpoints has the button; you say minutes, the tool takes
milliseconds, and the translation happens in the panel because "every 1800000" is
not a thing anybody means to type.

The one addition is a budget. `auto` snapshots hold their own `LIMITS.autoCheckpoints`
slots, and when the whole shelf is full the scheduler's oldest goes before yours
does. Without that, a day of hourly snapshots would quietly push out the desktop you
named on purpose, which is the opposite of what a checkpoint is for.

Two things were fixed alongside it. A `revert` no longer forgets a checkpoint: the
index travels with the current document, exactly as it does for a restore, because a
checkpoint is explicitly outside the revision window. And replacing the machine
wholesale — a reset, a fork, a restored backup — now sweeps the checkpoint *files* of
the desktop that no longer exists; they were unreachable (the index is the only way
in) and they are whole documents, so they used to sit on the volume for its lifetime.

### An undo you can aim

An agent's change is usually several revisions — it aligned the windows, then
added a widget — and rewinding past the alignment used to take the widget with it.
Writing the day script (§10 A of `goal.md`) made that concrete: "apply, then undo the
alignment only" was in the specification and was not possible.

`desktop.revert { rev }` still restores the whole document. `revert { rev, only:
["windows"] }` restores just those parts and leaves everything else as it is now;
`desktop.revertScopes` lists what can be aimed at (windows, widgets, workspaces, theme,
animation, wm, shell, apps, widgetKinds, notifications). Restoring windows also carries
the stacking counter forward rather than backwards, so the next window opened does not
land underneath one already on screen. Either way the undo is itself a revision, so it
can be undone.

The Studio's History panel offers the same aim: the revert dialog lists the parts
that actually differ in that revision, with "everything in this revision" first.

### Checkpoints: a desktop you meant to come back to

History answers "undo that" and keeps forty revisions. A **checkpoint** answers "take
me back to the desktop I liked": `desktop.checkpoint { name }` writes a copy of the
whole document to `os/checkpoints/<id>.json` and adds an index entry to the document,
so it cannot be pruned away by ordinary churn. `checkpointDiff` says what has changed
since (structurally: windows, widgets, theme keys, apps), `checkpointRestore` goes back
— as a *new* revision, so the way forward is not lost either — and `checkpointRemove`
deletes the copy along with the entry. Twelve at a time, oldest pruned with its file.

### The keyboard is a document field

`shell.keys` maps an action to a chord: `{ spotlight: "mod+k", closeWindow: "mod+w", … }`.
`packages/os/src/keys.js` holds the closed grammar — the action vocabulary, the chord
parser, the matcher and the pretty-printer — and has no Node imports, so the shell that
*matches* a key and `desktop.keySet` which *validates* one read the same file. A chord
is modifiers (`mod`, `shift`, `alt`) plus one key; an unreadable chord is refused rather
than stored (a binding nobody can press also steals the key), a collision with another
action is refused by name, and `null` means deliberately unbound — a value, because an
absence would come back as the default on the next normalization.

The cheat sheet (`?`) is *generated* from the map, so a rebinding shows up there instead
of quietly making the page a lie, and Settings → Desktop → Keyboard captures a chord by
listening for the next keypress. An agent can rebind through the same tool, and the map
travels with a distro.

### Attention is yours

`shell.notifications` grew `dnd` and `allow`. Do-not-disturb throws nothing away: the
notification is recorded exactly as it would have been and marked `quiet`, so no surface
interrupts anyone with it — and the decision is made once, in `notifyOs`, so a phone, a
second tab and the terminal renderer agree. `allow` is a closed list of who still gets
through (`agents`, `procs`, `apps`, `system`), defaulting to `["agents"]`, because an
agent coming back is the interruption most people do want. The bell shows the state, the
notification centre has the switch, and `mod+shift+u` toggles it.

### An app is a principal you can see

A custom app has always been a real principal with attenuated grants; Phase 33 made that
visible. `desktop.appLedger { id }` answers what the app **declared**, what it was
**granted**, what was **withheld**, which machine principals have been minted for it, and
every call it has actually made — read from the audit log, not from anything the app said
about itself. `desktop.appSuspend { id }` revokes its live tokens and mints no new
session: the window and the source stay, and the next call it makes is refused. The
capability badge in a custom app's title bar opens the ledger and offers the switch.

### What a write costs

A desktop write is one document written to disk and one event on the wire, and it is
worth keeping it that way. Two things used to make it more than that, and no longer do:

- **The stylesheet.** `theme.css` is linked by an *appearance* key — a hash of the
  document's `theme` and `animation` branches — rather than by `rev`, and served with
  an ETag. Moving a window changes the revision, not the appearance, so it costs no
  request at all; changing the theme costs one; a frame that links the stylesheet
  without a key still revalidates into a 304.
- **The history.** Revisions are append-only files (`os/history/<rev>.json` plus a
  small `index.json` of revisions, times and labels), pruned to `LIMITS.history`. A
  drag writes one document; it used to rewrite the previous forty. An older
  single-file `history.json` is migrated the first time it is read.

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
panels, muted text AA-large) — and so does a theme *you* invent: `themeDefine` runs
`checkContrast` and returns the warnings with its result, refusing only the case
nobody could work with (body text under 2:1 on its own panels), which it rolls back
rather than leaving behind. The rules and the ratio arithmetic live in
`packages/os/src/themes.js`, shared with the browser like every other pure module. `animation.reducedMotion` decides whether a viewer's
`prefers-reduced-motion` wins (`auto`, the default) or the preset does (`ignore`);
the decision is per viewer and written nowhere. Chrome transitions read the motion
tokens rather than hard-coded times, so "Instant" really is.

---

## 5 · Apps

An app id resolves to one descriptor shape whatever kind it is:

| kind | what it is |
|---|---|
| `builtin` | drawn by code we shipped — Files, Terminal, Console, Notes, Assistant, Observability, Media, Browser, Settings, Studio, and the machine's own work: Jobs, Ports, Agents, Secrets, Sync, Access, Audit, plus the Manual |
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

### The machine's own work (Phase 32)

Until Phase 32 the desktop could not do half of what Command Central could: starting a
dev server, exposing it, watching its logs, sharing the machine and reading the audit
trail all meant leaving the OS for a console. Seven built-ins close that, and they are
ordinary apps — same descriptor, same `needs`, same Kernel, no private channel
(`apps/gateway/public/js/os/ops.js`):

| app | what it is a client of |
|---|---|
| **Jobs** | `proc.*` and `cron.*`: supervised processes, a live log tail you can filter, restart, stop, forget; the shells on the machine; and the schedule of tool calls the scheduler will make on your behalf |
| **Ports** | `ports.*`: what is listening inside the machine, what the Gateway serves, expose/unexpose, preview, copy the URL, check |
| **Agents** | `agents.*`: spawn with an explicit capability set, watch the transcript, inspect the result, kill |
| **Secrets** | `secrets.*`: reference-only handling, and "use in a command" that returns the output but never the value |
| **Sync** | `tide.*`: workspaces, working-tree changes, marks, per-mark diffs, restore |
| **Access** | `access.*`: who can reach this machine, sharing attenuated against your own grants, machine tokens shown exactly once |
| **Audit** | `kernel.auditQuery` / `auditVerify`: every call in order, filtered by server, tool and result, with the hash chain checkable from the window |

They all wear one shape — a list of things on the left, the thing you picked on the
right — because they answer the same kind of question, and each one says when a reading
is *unavailable* rather than showing a plausible zero: a port scan that could not look
says so, a job whose shell never started says "never started" instead of "failed".

### A terminal is a session, not a socket

A pty used to belong to a WebSocket: closing the window killed the shell, so "close this"
and "kill my build" were the same gesture. Sessions live in
`packages/kernel/src/pty-sessions.js` now — the Cell holds the process, the host holds a
bounded scrollback (256 KB) and the list of watchers, and a socket is one of them
arriving and leaving:

- `/:slug/pty?session=<id>` attaches to an existing session and replays its scrollback;
  without one it creates a session and tells the client its id on the control channel.
- A Terminal tab remembers its session id in the window's props, so a reopened window
  reattaches: same shell, same output, the build still running.
- Closing a tab or a window **detaches**. Ending a shell is a named gesture (the tab's
  menu, or `proc.sessionKill`), and it asks first.
- `proc.sessions` lists them for anyone — you, another window, an agent — and Jobs shows
  them beside the supervised processes, because a shell is a process too.
- Sessions end when the Cell hibernates, when the host shuts down, or after six hours
  with nobody watching. A session pointing at a stopped Cell would be a lie.

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

**The stage renders a machine, not a pane.** The phone fold is a property of the
viewport a document is arranged *for*, and the split view's stage is a few hundred
pixels wide on a laptop — so until Phase 32 the builder showed a phone: one window, a
widget shelf, no sashes, which is the wrong answer to "design my desktop". The stage
now picks a device (Desktop 1440×900, Tablet, Phone, or Fit-the-pane), renders the
screen at that size and scales it to fit, with the scale shown in the badge. Nothing
about the document changes; the window manager reads its *layout* size (`offsetWidth`)
and divides pointer deltas by the paint scale, so sashes, snapping, multi-select and
design mode all work at 35% as well as at 100% — and switching to Phone renders the
fold on purpose, which is how you check it.

---

## 8 · HTTP surface

| method | route | |
|---|---|---|
| `GET` | `/:slug/os` | the OS, full screen |
| `GET` | `/:slug/studio` | the builder |
| `GET` | `/:slug/os/doc` | document + resolved theme/motion + catalogs (apps annotated with their live tools) |
| `GET` | `/:slug/os/events` | SSE: every desktop change, plus catalog changes (`appServers`) and bundle writes (`appFiles`) |
| `GET` | `/:slug/os/theme.css` | the compiled theme and motion (ETag = the appearance key; `?k=` is the shell's cache buster) |
| `POST` | `/:slug/os/apps/:id/session` | open a capability session for an app frame |
| `GET` | `/:slug/os/apps/:id/*` · `/:slug/os/widgets/:kind/*` | a custom app's or widget's files (sandboxed, CSP-locked) |
| `GET` | `/static/js/os/lib/{layout,themes,animations,summary,keys}.js` | the pure OS modules, served from `packages/os` |
| `GET` | `/:slug/os/{apps,widgets}/:id/k/:key/*` | a sandboxed frame reading its own bundle — authenticated by the key in the path, because an opaque-origin frame cannot send a cookie |
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
