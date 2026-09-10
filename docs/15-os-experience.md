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

What the panel shows above the calls is **which parts of the document the change
would touch** — "would change: windows, theme" — and not a predicted diff. The ops
have not run: their effect can only be simulated by running them, or by a second,
pure implementation of every desktop tool, which would be a second implementation to
keep honest and the first one people stopped trusting. `PROPOSAL_TOUCHES` in
`packages/os/src/proposals.js` maps every writable tool to the sections it changes,
the suite checks it against the live tool catalogue so a new tool cannot be added
without saying what it touches, an unrecognised call is named rather than treated as
harmless, and a call that replaces the document says "everything" instead of listing
parts. The browser reads the same module the tool does, so the panel and the Kernel
cannot disagree.

After applying, **what changed** is measured rather than guessed: each op was its own
revision, so the history's structural diff from the revision before the first one is
the real answer, and the panel offers it.

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

### Stopping something you reach indirectly

A supervised process in a Docker or Firecracker Cell is not our child. The local
`docker exec` / `ssh` client is; the process that matters lives inside, and the
in-Cell shell records its pid so `remoteHandle` can signal *that*.

That kill used to be a fire-and-forget promise. On the one path where it matters
most — the Gateway's shutdown, which calls `stopAllProcs` and then `process.exit` —
it never left the starting line. A dev server inside a container survived every
restart, holding its port, with nothing left running that knew it existed: exactly
the orphan the shutdown path exists to prevent, and the same mistake `killTree` made
on Windows before it was made synchronous.

Every backend that reaches a Cell indirectly now hands `remoteHandle` a synchronous
killer as well as the async one, and `kill()` prefers it. "Stopped" means stopped by
the time the call returns. A backend that cannot offer one still works the old way.

The container leg checks both halves of this on a real container: that `ports.scan`
*finds* a listening port on an image with neither `ss` nor `netstat` — the
`/proc/net/tcp` fallback, which the new default image is the first to need — and that
stopping a job actually frees the port inside the container.

### …and stopping it when nobody is left to ask

That fix was verified against the live deployment, and the job survived anyway. The
reason is worth writing down, because it is not a bug in the handler: the PaaS this
project is deployed on stops a service by sending SIGTERM to the process group and
then, in the next statement, SIGKILL to the same group. The handler is entered and
killed roughly a microsecond later. A direct SIGTERM reaps correctly; a restart
through the supervisor reaps nothing, every time.

That is not a thing to work around. It is a thing to stop depending on. A shutdown
handler is a courtesy the machine is not obliged to extend — SIGKILL runs none, and
neither does a host reboot, an OOM kill, or a power cut — so any design whose only
cleanup happens on the way out has a hole that no amount of care on the way out can
close.

So the rule moved to the other end. A Cell outlives its Gateway on purpose: the
container is stopped only on hibernate, which is what keeps the volume warm and the
boot cheap. That makes *adoption* the moment when a total statement is available for
free — **anything running in a Cell that was already up was started by a Gateway that
is gone.** Not a heuristic about ports or process names. A fact about who is alive.

`packages/cell/src/orphans.js` holds both halves. Every command a backend runs in a
Cell carries `SANDBOXOS_BOOT`, this Gateway's identity for the length of one process;
adopting a running Cell kills everything carrying anybody else's. The environment is
the right place for the stamp: children inherit it, it survives the `exec` that makes
a recorded pid *be* the command, and unlike a pid file it cannot be claimed by an
unrelated process handed the same number. A process with no stamp — the container's
own init, something you started by hand in a shell we do not own — is not ours to
kill. The marker files under `/tmp/.sbx-*` get a second sweep, through the same
environment check, so a Cell that has been up since before the stamp existed still
empties instead of staying immortal.

Two smaller holes closed with it. `cleanupScript` had always signalled the pid on
line 2 of the pty marker file, and nothing had ever written line 2 — so every closed
Terminal left a live shell in the Cell. And a Cell's pid 1 was `tail -f /dev/null`,
which never calls `wait()`: the live deployment had six zombies sitting in its process
table. Containers now run under `--init`.

### …and starting it again

Reaping on its own is half a fix, and the wrong half to ship alone. The job table had
always been a `Map` in one process's memory, so a restart lost it — which for a long
time was survivable in the worst possible way: the process kept running inside the
Cell, so at least the dev server was still up. Invisible, unstoppable, holding its
port, but up. Remove the invisible half and nothing is left: an empty Jobs list and a
dead server, every deploy.

So the list is written down, at `jobs.json` beside the Cell volume — next to `os/`,
for the same reason the desktop document lives there rather than in Files: it is the
machine's own bookkeeping, not your files, and it should not travel in a distro. It
holds what a job *is* (id, name, command, timeout, state) and not what it printed:
the logs belonged to a process that no longer exists, and a restored job starts a new
log rather than pretending to continue an old one.

Adopting a Sandbox brings back what was running, under the ids it had, so anything
that referred to a job still does. Jobs that had finished come back as history, so
the list is not blank. Decisions are preserved in both directions — a job you stopped
stays stopped, or the next boot would helpfully start the very thing you just turned
off. There is no retry: a command that fails immediately becomes a failed job you can
read, where a restart loop would be noise.

The ordering is load-bearing and free. `startJob` awaits `cell.ensureRunning()`, and
that is where a Cell inherited from a dead Gateway is emptied — so reaping always
finishes before the first restored job starts, and a restored dev server never races
its predecessor's corpse for the port.

The container leg proves the whole cycle on a real container: a job left running, a
reaper wearing the next boot's identity, the port freed, the container still
answering, and then a job that goes away with its Gateway and is serving again
through the slug, on the port it had, under the id it had.

### Where a served folder binds

`cell.endpoint(port)` says how the Gateway reaches something inside a Cell: the local
backend answers `127.0.0.1`, because it shares the host's loopback, and a container
answers its **own IP**. A server has to bind an address on the other end of that, and
the narrowest one that works — which on a local Cell is loopback, never the host's LAN
interfaces, and inside a container is `0.0.0.0`, meaning that container's interfaces.

The welcome server bound `127.0.0.1` unconditionally. On Docker that produced the
hardest kind of failure to read: the page was written, the job was running, the port
was exposed, every step reported success — and the page did not load, because nothing
outside the container can reach the container's loopback. `firstRunBindHost(backend)`
decides it now, and every branch takes the address as an argument (the Python and
busybox ones were binding *every* interface all along, which was the opposite mistake).

A job that dies also reports the first line that reads like a failure rather than the
last line printed: a crashed Node process signs off with its own version number, so
"could not serve the project — Node.js v22.23.2" was the message that reached a person
whose real problem was `EADDRINUSE`.

### What a cell image has to have

Three things, and the default image did not have two of them:

- **`script`**, so the Terminal gets a real pseudo-terminal — job control, vim,
  full-screen programs. On Debian it comes from `bsdutils` (Essential, so it is in
  every Debian image). On Alpine it is in `util-linux`, which is not installed by
  default, and Alpine's busybox is built without the applet.
- **Something that can serve a folder** — Node, Python, or a busybox with `httpd`
  — or first run has nothing to put up and the Browser is right to say nothing is
  listening.
- **A package manager**, if anybody is going to add to it later.

The default was `alpine:latest`, which has the shell and none of the rest: eight
megabytes that bought a machine unable to do the two things people open a machine
to do. It is `node:22-slim` now — Debian, so `script` is there, and Node, so a dev
server and the welcome page both work. `SANDBOXOS_CELL_IMAGE` still chooses, and
`docker/cell.Dockerfile` is an Alpine build with `util-linux` and `nodejs` in it for
people who would rather have the megabytes.

Changing that setting now does something: a Cell whose container was built from a
different image is **recreated** on its next boot rather than started as it was.
The volume is a bind mount, so the files are untouched; what is thrown away is a
container, which is a cache of an image. Before this, the setting could be changed
and nothing whatever happened, which reads as the setting being broken.

`pkg` asks the image which package manager it has — `apk`, `apt` or `dnf` — rather
than assuming `apk`, and an image with none of them gets a sentence naming what was
looked for. It used to be a hardcoded table with one entry, so on any non-Alpine
image the first install failed with "cannot read properties of undefined".

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

`desktop.setup { keepDesktop: true }` runs the project half again without touching a
desktop somebody has since made theirs — Settings → Machine has the button. It exists
because first run can complete with its serve step failed, which left a machine marked
set up, with nothing listening, and no way to ask again short of resetting the desktop.

First run is the machine's, not one door's: `/studio` shows the same screen `/os` does.
Landing on the Studio first used to mean the machine was never set up at all.

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

### The day, with no pointer

`DAY_KEYBOARD=1 npm run day` runs the whole acceptance day with the keyboard: every
activation becomes focus-then-Enter, and an element that cannot take focus fails the
run with its selector. That is the last clause of Track 4's "done when", and it is a
check rather than a mode — a div with an `onclick` passes the pointer run and fails
this one. `npm run release-check` runs both.

### Recorded, or announced

Attention is the user's, and the mechanism is one flag rather than a queue with
timers. `notifyOs` marks a notification `quiet` when do-not-disturb is on and its
source is not on the allow list — *or* when the caller asks for quiet on its own
account. A supervised job that exited cleanly asks: it is worth recording and not
worth interrupting for. A failure or a stop does not.

That is what T3.3's "batched" means here. The notification centre already groups by
who is talking — the machine's processes, agents, then each app — so a routine
success lands where you look for it rather than in front of you, and reads as
recorded rather than as news. Nothing in this OS toasts a notification away: the
record is identical either way, because `quiet` is about interruption and never
about the record.

The keyboard is deliberately *not* per-workspace, which T3.2 left as a judgement
("per-workspace where that makes sense"). Muscle memory that changes when you switch
workspace is worse than no remapping at all. What the keymap does have is conflict
detection: `keySet` refuses a chord that already belongs to another action and names
the one it would have broken.

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

### The audit log, taken with you and pointed at one caller

The Audit app filters by server, tool and result, and verifies the hash chain. Two
things T1.7 asked for that it did not have:

**Export.** The rows on screen become a file — with the filter that produced them and
the chain's verdict beside them, because the whole point of a hash-chained log is that
it can leave the machine and still be checked, and a bag of events with no context is
evidence of nothing.

**Scoping to one caller.** A window's capability ledger (see below) now has a way out
into the log: "everything it has called", which opens the Audit app filtered to the
machine principal that app was minted. It is a query — `auditQuery { principalId }`,
filtered in SQL — rather than a second feature, and the window shows what it is scoped
to with a visible way out of it. A built-in app's calls are made as *you*, so there is
nothing to scope: that is a property of how built-ins work, not a gap in the explorer.

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

And one thing that was planned and is deliberately not built. T4.2 of `goal.md`
holds a delta protocol in reserve — `{op, rev, patch}` for geometry-only writes,
full documents for structural ones — *if* the wire budget could not be met by
compression alone. It can. `npm run bench` measures the whole document on the wire
at the ceiling shape (40 windows, 20 widgets) and reports about **13 KB against a
96 KB budget**, one event per write. A delta protocol would add a second
representation of the desktop, a second thing for every client to reconcile, and a
new class of bug where the patch and the document disagree — to save bytes that are
not scarce. The measurement is in the bench rather than in this paragraph, so the
day it stops being true, CI says so and the decision can be revisited on numbers.

### A row is a row

Six of the seven ops apps and the Files listing render through one class,
`.row-line`, and it was a flex row with no `align-items`. Every child therefore
stretched to the row's height: a status pill with `border-radius: 999px` came out
as a green oval the size of a button, and a label long enough to wrap pushed it
further out of line. The rules now are the ones a table wants — children centred,
the label taking all the slack so the columns after it share a left edge, numbers
right-aligned and tabular — with `.row-line.wrap` for the other kind of row, the
one whose second half is a sentence about the first (a table of contents, a search
hit) and wants the sentence rather than an ellipsis after four words.

The split panes went proportional at the same time: a list fixed at 260px beside a
paragraph in 640px of empty pane was the shape of every ops app in a wide window.
Under 720px there is no room for two panes at all, and the list becomes the app.

Settings is a two-column grid inside a 620px measure. `space-between` had been
putting each control against the right edge of a window-wide row, so their left
edges landed wherever their own widths left them — a different indent on every
line, and a label a hand's width from the thing it labelled.

### The conflict policy

Every write is last-write-wins **unless it says otherwise**. Writes that describe a
*place* — where a gesture or an inspector field put something: `move`, `resize`,
`snap`, `tile`, `windowSet`, `widgetSet`, `layoutSet`, `arrange` — are sent by the
shell with `expectRev` set to the revision they were painted against. If the document
moved in the meantime (an agent got there first), the Kernel refuses with the code
`stale_rev`; the shell re-reads the document and says "Desktop moved — refreshed"
rather than silently overwriting the other editor. Nothing is retried blindly: the
person can see what changed and decide.

The word *place* is load-bearing, and for a while it was not. `windowSet` and
`widgetSet` do two jobs: the inspector and a drag use them to say where something
goes, and an app uses them to record *itself* — the Terminal storing which session
its tab is attached to, Files its folder, Jobs the log it is following. Sending
every one of those conditionally meant an app's own two writes in a single tick
collided **with each other**, and the owner of a machine nobody else had ever
opened was told "someone else (or an agent) changed it first" — the most expensive
kind of wrong a machine can be. The client now asks whether a call actually
mentions a place (`x`, `y`, `w`, `h`, `ws`, `min`, `max`, `pin`, `z`) before it
guards it, and the smoke asserts that a settled desktop accuses nobody on open.

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

### The editor's four things

goal.md asked the editor for four: search and replace across a bundle, the frame's
errors coming back, a symbol jump within a file, and a diff against the last saved
version.

**Symbols** (⌘⇧O, or the tag in the rail) list the definitions in the open file with
a filter and a jump. It is not a parser: it is the shapes a definition takes in the
four languages a bundle is made of — `function`, `class`, a named arrow, a `const`,
a method, a CSS selector, an HTML id — matched line by line, with the CSS and HTML
rules applying only in those languages. That is enough to answer "where is that
defined" in a file of a few hundred lines and honest about being a list of lines. A
wrong jump costs a scroll; a JavaScript parser in the Studio would cost more than the
question is worth.

**The diff** compares what is in front of you against `tab.saved` — the version this
editor last wrote or read — so it answers "what am I about to write" before you press
save, including after an agent wrote the file underneath you. Longest common
subsequence over lines, two lines of context around each change, added and removed in
the theme's ok and error colours.

Both panels sit above the editor and are mutually exclusive, because two of them
stacked there would leave no editor.

### Getting from one app to the next

Each of the seven does its own job; several clauses of Track 1 were about the seams
between them, and a machine where every answer lives in a window you have to know
about is a machine that makes you do the work twice.

- **A job's notification goes back to the job.** `notifyJobEnded` carries
  `action: { app: "jobs", props: { job, follow: true } }`, so "build failed" opens Jobs
  on that job, following its log. An agent's does the same for its transcript.
- **A job's pane shows the ports that are answering**, each one a button that opens the
  Browser. Deliberately not attributed to the job: a supervised process does not tell
  the machine which ports it bound, and guessing would be a confident lie. What it says
  is "answering now", which is true and is what you wanted after starting a dev server.
- **Sharing a port is sharing the machine, narrowly.** The proxy URL sits behind this
  machine's own sign-in, so the honest one-click share is `access.share` with the
  narrowest grant that lets somebody load the page — and then it puts you in Access,
  where you can revoke it.
- **An agent can be re-run with edits.** The spawn dialog takes a previous agent and
  fills in its command, its kind and its capabilities. The original stays in the list
  with its own transcript.
- **A Tide badge opens Sync** on the workspace the badge came from — it is a button, so
  a keyboard reaches it, and it does not also open the file underneath.
- **A spike leads to its rows.** Observability's per-tool and slowest-call rows open the
  audit log filtered to that tool.

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
