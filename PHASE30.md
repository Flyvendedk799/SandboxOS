# Phase 30 — Presence, and the second surface

The last two waves of the heroplan. The first is craft: the OS feels inhabited on
every viewport, the built-ins earn their dock pins, motion and accessibility are
designed rather than incidental. The second is proof: the document renders somewhere
that is not a browser tab.

## A phone is a renderer, not a document

Below 720px the same document folds — it always did. Now the fold is intentional:
the dock is an app switcher with labels and 44px targets; a row of dots switches
workspaces, by tap or by swipe; swiping a title bar cycles windows and a long press on
it is the window menu; and the widgets slide into a **shelf** that pulls up from above
the dock instead of vanishing. They are the same widget instances, moved into a
column — nothing is deleted from the document when the screen is small, and nothing
is written when you rotate.

## The built-ins earn their pins

The shell is a real pty now: it runs under `script(1)` inside the Cell, so job
control is on and `docker exec` needs no TTY on our side; resize is `stty` on the
recorded tty. (Before, every closed terminal tab also left its shell alive behind a
half-open socket — fixed in the WebSocket codec.) The Browser has quick access: it
scans what is listening inside the machine and opens it in one click, exposing the
port on your behalf. `ansi.js` is a real screen now: a grid with cursor addressing, scroll regions, insert
and delete, an alternate buffer, 256-colour folded to sixteen, reverse video. `vim`,
`htop`, `less` and a TUI you wrote paint, with no dependency and no CDN. The Terminal
grew tabs, kept in the window's props so a re-opened window has the tabs you had
(fresh sessions — a PTY is a process). Files has a second pane and Tide status badges
when the machine has a workspace. Notes is a folder of notes with a Markdown preview.
Media has a lightbox, plays what the browser can play, says when it cannot, and
notices when the folder changes. Browser remembers ports and paths in its props and
tells you what to do when nothing is exposed. Console keeps a transcript. Observability
has load and memory sparklines, recent calls and a link into the audit explorer.
Settings has a whole Desktop section, so a machine can be reshaped — theme, motion,
tiling presets, dock, menu bar, associations — without the Studio. The calendar
navigates months, the weather lets you change the place, the jobs widget tails and
stops.

## Craft you can measure

Every built-in theme passes a contrast check in the test suite. `animation.
reducedMotion` decides whether a viewer's `prefers-reduced-motion` wins (the default)
or the preset does — decided per viewer, written nowhere. Chrome transitions read the
motion tokens, so "Instant" is. A theme's `grain` is a number compiled to
`--os-grain` and painted from gradients, never an image. Every piece of chrome has a
focus ring. Notifications group by who is talking, deep-link to where they lead, and
dismiss one at a time. Spotlight offers the tree presets, "edit app source", "publish
distro", recent files, the Studio's tabs and every app's live tools; `?` is the cheat
sheet.

## The document is the OS, not the tab

`sbx os tui` renders the desktop in a terminal: workspaces, the window list, a
miniature drawn from the same `treeBoxes` the browser uses, the desktop map on `M`.
Every key is the same tool the shell calls — `focus`, `close`, `workspaceSwitch`,
`layoutSet`, `open` — and it follows `/os/events`, so an agent's change appears
without a keypress. A machine whose browser tab is closed still has a desktop, and on
SSH you can switch its workspaces.

`test/phase30.test.js` pins the multi-client story: two event-stream clients and an
agent converge on the same revisions, in order, ending at the current document; a
gesture and an agent racing on one `expectRev` end with exactly one winner and one
`stale_rev`; unconditional writes are last-write-wins by name. The browser smoke feeds
escape sequences through the real screen (overwrite in place, alternate buffer, scroll
region), opens the notification centre and dismisses one, shows the cheat sheet,
folds to a phone with the shelf and the dots, and finds the Desktop section in
Settings.

## What is still deliberately not here

Server-side rendering (three renderers, all clients). A CRDT (a refusal that explains
itself is the policy). `runtime: "cell"` companions (a capability decision, reserved).
Signed distros (hashes now, signatures in Phase 6). Tide-based distro *update*.
