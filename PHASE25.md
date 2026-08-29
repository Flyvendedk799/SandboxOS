# Phase 25 — Tide Gets a Face, and a First Run Worth Having

Two gaps were left after the desktop was built. One is a pillar with no interface. The
other is what a brand-new machine says to the person who just opened it.

## Tide, visible at last

Tide is one of the four pillars, and it has been fully callable since Phase 2: a
workspace maps a path inside the Cell to an object store, `mark` snapshots it, `log` is
the history, `diff` compares any two points, `checkout` restores, and the wire primitives
let a laptop daemon push and pull the same objects. Every bit of that has been reachable
only by typing `:call tide.mark {…}`.

The **Sync** workspace is the missing half:

- **Workspaces** down the left, each showing its head.
- **Working tree** — what has changed since the last mark, rendered as `+ ~ −` rows, with
  a Mark button that is disabled when there is nothing to mark. Marking an unchanged
  workspace correctly writes nothing rather than an empty commit.
- **History** — marks newest first with hash, message and age. Expanding one diffs it
  **against its parent**, so you see what that mark introduced rather than what it
  differs from now.
- **Restore** any mark, with a confirmation that says plainly what is lost, and the file
  tree refreshes behind it.

Everything goes through the tide MCP server, so an agent doing the same work shows up in
the same audit dock — which is exactly what the screenshot of this panel shows:
`tide.init`, `tide.status`, `tide.mark`, `tide.log`, `tide.diff` scrolling past as you
click.

**One leak fixed along the way.** `tide.listWorkspaces` and `tide.init` returned the
*host* path of a workspace — `/tmp/.../sandboxes/sbx_ad1cac36/volume/notes` — which the
panel then displayed. Host filesystem layout is an implementation detail of the Cell
backend and has no business crossing the Kernel. Both now return Sandbox-relative paths.

## An empty machine that teaches you

A new Sandbox was an empty directory. That is a bad first impression and, worse, an
uninformative one: nothing in it tells you that `run` supervises a process, that a port
must be exposed before you can see it, or that the assistant holds your capabilities and
no more.

`seedVolume()` writes one `WELCOME.md` into a brand-new volume — on signup, on creating a
Sandbox, and on the seed Sandbox at boot. It walks you through the first five minutes:
list and search the filesystem, start a supervised process, expose its port and preview
it, ask the assistant instead of typing, and a table of what each panel is for.

The rules that matter are the ones about *not* doing it: seeding only ever touches a
volume that is completely empty, it is idempotent, an edited welcome file is never
overwritten on the next boot, and a Sandbox with no volume path is a no-op rather than a
crash. It is a normal file the owner can delete — not a hidden fixture.

## Tests

`test/phase25.test.js` — 14 tests. The Tide half walks the exact flow the panel drives:
init returns a relative path, status sees an added file, marking snapshots it and leaves
the tree clean, marking again writes nothing, the log carries parents and the marking
principal, a mark diffs against its parent distinguishing added from modified, a bare
diff agrees with status, restore rewrites the working tree *inside the Cell* and moves the
head, state objects round-trip, and every one of those calls appears in the audit log.
The first-run half covers seeding, not clobbering, idempotence, and the no-op.

Driven in a browser too: log in to a fresh machine, find and read the welcome file, create
a workspace, mark it, edit and mark again, expand the newest mark to see its diff, restore
the first one, and watch `second.md` disappear from the file tree. Full suite: **470
passing**.
