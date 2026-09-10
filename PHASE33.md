# Phase 33–34 — Authorship, and control you can feel

Tracks 2 and 3 of [`goal.md`](goal.md). Phase 31 made the machine unbreakable, Phase 32
made it sufficient; these two make it *yours*: a change you can read before it happens,
an app whose errors reach the person who can fix them, a keyboard that is a document
field, attention that belongs to the person, and a desktop you can name and come back to.

## Custom apps' JavaScript never ran

The headline is a bug, because it had been true for a whole phase of "custom apps work".
A frame runs at an **opaque origin** — that is the sandbox — so its fetch for its own
`./app.js` is cross-origin *and* Chrome treats an opaque initiator as cross-site, so no
cookie is sent. The Gateway saw an unauthenticated request and refused it. The failure
was a CORS message inside a console belonging to nobody, and the tests only asserted
that files were written and served, never that an app *ran*.

Frames now read their own bundle through an unguessable key in the path
(`/:slug/os/apps/:id/k/<key>/…`), minted per (Sandbox, app) for whoever opened the
window and expiring after six hours. Relative imports resolve under the same prefix, so
`import "./lib.js"` works with no cookie at all, and the key grants exactly one thing:
reading that app's source. The entry document's module scripts get `crossorigin` added
at serve time, because "why doesn't my import work" is not a question an OS should make
people answer. `npm run smoke` now asserts that an app's module executes and calls
through the broker — the assertion whose absence hid this.

## The frame's console belongs to someone

`bridge.js` reports uncaught errors, rejected promises and console output back to the
shell as one-way notes (no id, so the broker never replies and an app cannot use the
channel to ask for anything). The broker keeps a bounded ring per app; the Studio's
**Code** tab shows them beside the source and opens itself on the first error. Code also
gained find-and-replace across the whole bundle — one revision per file written, hits you
can jump to, because the editor learned `reveal(line)`.

## Reviewable, not just revertible

`desktop.propose` stores a change as a document object: a label, who asked, and `ops`
that are ordinary `desktop.*` calls. Nothing runs. `applyProposal` executes them in
order **as whoever applied it**, through the same tools — so a proposal can never do
something its applier could not do by hand — and says which ops landed and where it
stopped. Because a proposal lives in the document it survives a reload, shows up in a
second tab, and is itself revertible.

The Studio's agent panel has a **Review changes** switch. With it on, the assistant's
`desktop.*` writes are captured into one proposal per turn (reads pass through — an agent
that cannot look at the desktop cannot propose anything sensible about it), the system
prompt says so in as many words, and each proposal appears as a list of calls with Apply
and Discard.

## An app is a principal you can see

`desktop.appLedger` answers what an app declared, what it was granted, what was withheld,
which machine principals were minted for it, and every call it has actually made — from
the audit log, not from anything the app says about itself. `desktop.appSuspend` revokes
its live tokens and mints no new session: the window and the source stay, and the next
call it makes is refused. The badge in a custom app's title bar opens the ledger and
offers the switch, and a suspended app still loads its own source, because suspension is
about capabilities rather than about hiding code.

## Checkpoints, the keyboard, and attention

**Checkpoints** (T2.4): `desktop.checkpoint { name }` writes a copy of the whole document
outside the forty-revision window, so a named state cannot be pruned away by churn.
`checkpointDiff` says what changed since, `checkpointRestore` goes back as a *new*
revision — the way forward is not lost either — and `checkpointRemove` deletes the copy
with the entry. Twelve at a time; the oldest goes with its file.

**The keyboard** (T3.2) is `shell.keys`: an action to a chord, in the document.
`packages/os/src/keys.js` holds the closed grammar and has no Node imports, so the shell
that matches a key and the tool that validates one read the same file. An unreadable
chord is refused rather than stored (a binding nobody can press also steals the key), a
collision is refused by name, and `null` means deliberately unbound — a value, because an
absence would come back as the default. The cheat sheet is *generated* from the map, so a
rebinding cannot make it lie, and Settings captures a chord by listening for the next
keypress.

**Attention** (T3.3): do-not-disturb records everything and interrupts with nothing. The
notification is stored exactly as it would have been and marked `quiet`; the decision is
made once, server-side, so a phone and a terminal renderer agree. `allow` is a closed
list of who still gets through, defaulting to agents, because an agent coming back is the
interruption most people want. The bell shows the state; `mod+shift+u` toggles it.

## Tests

`test/phase33.test.js` pins proposals (a document object, applied as the caller, partial
application reported, read-only and unknown ops refused, bounded by the normalizer),
review mode's prompt and capture rule, the bridge's one-way reporting, the broker's
bounded ring, the keyed asset path (right key, wrong key, wrong app, traversal), and the
ledger and suspension. `test/phase34.test.js` pins checkpoints (named, diffed, restored,
surviving a pruned history, bounded with their files deleted), the keymap (rebinding,
collisions, unreadable chords, unbinding, defaults restored, and the matcher against real
events), and do-not-disturb (recorded, quiet, allow-listed, closed vocabulary).

`npm test`: 648 passing. `npm run smoke` and `npm run bench` green.
