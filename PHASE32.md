# Phase 32 — The desktop can run the machine

Track 1 of [`goal.md`](goal.md), plus the one Studio bug that made the builder read as a
toy. Phase 31 made the machine unbreakable; this one makes it *sufficient*: everything
you actually do with a machine now has a home on the desktop, and a shell you started
survives the window you started it in.

## A terminal is a session, not a socket

A pty belonged to a WebSocket, so closing the Terminal killed the shell: "close this
window" and "kill my build" were the same gesture, and reopening the app gave you a
stranger. Sessions live in `packages/kernel/src/pty-sessions.js` now. The Cell holds the
process; the host holds a bounded scrollback (256 KB) and the list of watchers; a socket
is one of them arriving and leaving.

`/:slug/pty?session=<id>` attaches and replays the backlog; without one it creates a
session and tells the client its id on the control channel, which the Terminal stores in
the window's props. So a reopened window is a *reattachment* — same shell, same output,
the build still running. Closing a tab or a window detaches. Ending a shell is a named
gesture that asks first, and `proc.sessions` / `sessionRename` / `sessionKill` make the
whole set visible to you, to another window and to an agent. Sessions end when the Cell
hibernates, when the host shuts down, or after six hours with nobody watching.

Two bugs found while building it, both the kind that only appear in a real machine: a
session killed *during its own startup* used to survive, holding a Cell process nobody
had a handle to (and keeping the whole process from ever exiting); and on a host whose
bash ships without `script(1)`, the pty wrapper `exec`'d a grandchild that outlived every
attempt to kill it — so `script` is now probed for rather than assumed, and a shell
without one is our direct child in line mode, which says so on its first line.

## Seven apps, and the console is no longer required

Command Central could start a dev server, expose it, watch its logs, share the machine
and read the audit trail. The desktop could not. `apps/gateway/public/js/os/ops.js` adds
the seven built-ins that close it — Jobs, Ports, Agents, Secrets, Sync, Access, Audit —
each an ordinary app with a declared `needs` list and no private channel:

- **Jobs** is `proc.*` and `cron.*`: what is running, a live log tail you can filter,
  restart, stop, forget; the shells on the machine beside the supervised processes,
  because a shell is a process too; and the schedule of tool calls the scheduler will
  make on your behalf.
- **Ports** is `ports.*`: what is listening *inside* the machine, what the Gateway
  serves outside it, expose in one click, preview, copy the URL, check.
- **Agents** is `agents.*`: spawn with an explicit capability set (the dialog shows what
  you hold), watch it, read the result, kill it.
- **Secrets** is reference-only handling, with "use in a command" that returns output and
  never the value.
- **Sync** is Tide: workspaces, working-tree changes, marks, per-mark diffs, restore.
- **Access** is the new `access` MCP server — `list`, `share`, `revoke`, `tokens`,
  `mint`. Sharing was a Gateway route, which meant Command Central could do something
  the desktop and an agent could not; goal.md invariant 1 says that is a bug. Sharing and
  minting attenuate against your own grants, revoking yourself is refused, and a minted
  token is shown exactly once because after that it exists only as a hash.
- **Audit** is `kernel.auditQuery`, which grew real filters (server, tool, principal,
  result, time, cursor — in SQL, not by paging in a log to throw it away), plus
  `kernel.auditVerify` so the hash chain can be checked from the window.

They share one shape — a list of things on the left, the thing you picked on the right —
and they say *unavailable* rather than showing a plausible zero: a port scan that could
not look says so, a job whose shell never started reads "never started" rather than
"failed". Status colours became theme tokens (`ok`, `warn`, `err`), contrast-checked on
every built-in theme like every other colour, so "running" is legible in Dry Sand as
well as in Midnight. Developer Box and Social Ops pin the new tools, and a seed can now
pin more than it opens.

## The Studio was showing you a phone

The fold to a phone was decided by the width of the div the shell happened to be in, and
the split view's stage is ~500px on a laptop — so the builder rendered one window, a
widget shelf and no sashes. The window manager now distinguishes the *layout* viewport
(`offsetWidth`: what the document is arranged for) from the *painted* size (the bounding
rect), and divides pointer deltas by the ratio; the stage picks a device — Desktop
1440×900, Tablet, Phone, or Fit — renders at that size and scales to fit, with the scale
in the badge. Design mode, sashes, snapping and multi-select all work at 35%, and Phone
renders the fold on purpose, which is how you check it.

Two smaller repairs on the way: the stage bar scrolls inside itself instead of spilling
its controls under the inspector where they were visible but unclickable, and `[hidden]`
now means hidden — a component that set `display` on a class was painting a shelf the
document said was closed.

## A gesture owns what it painted

The drag commit read its geometry back off the document, so a document arriving
mid-gesture replaced the drag — and the shell then wrote the *other* writer's position
back and reported success. A gesture now holds its own painted geometry and the revision
it started from, commits that, and is refused (`stale_rev` → "Desktop moved — refreshed")
when the document moved underneath. An incoming document no longer erases what the
pointer is doing, either: the gesture owns its element until it commits, and adopts
everything else.

## Budgets, measured

`npm run bench` (`scripts/bench.mjs`, acceptance suite D) builds a 40-window,
20-widget desktop and prints a table with a budget per row: one event and one document
write per gesture, bytes on the wire, disk growth per revision, `/os/doc` round trip,
`theme.css` and its 304, the size of the desktop map a model reads, `auditQuery` of 200
rows, and a detached session's scrollback ceiling. It exits non-zero when a number
crosses its budget, so "a window move costs a window move" is a property the suite keeps
rather than a sentence in a phase note. The browser smoke now asserts the same thing
from the outside: ten agent moves cost zero stylesheet requests, and a theme change
costs exactly one.

## Tests

`test/phase32.test.js`: a session outlives its window and replays the work done while
nobody watched, detaching is not killing, sessions are listed/renamed/ended as tools, a
dying shell tells its watchers, stopping a Sandbox's processes stops its shells, a
session killed during startup leaves no child behind, the desktop ships an app for every
kind of work, every built-in's declared capabilities are real tools, and the ops apps are
actually mounted. `npm test`: 621 passing on Windows. `npm run smoke` drives the new
stage presets and the stylesheet budget; `npm run bench` meets every budget.
