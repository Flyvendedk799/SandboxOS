# Phase 37 — The day, and what it found

Acceptance A of [`goal.md`](goal.md) §10: `scripts/day.mjs`, one browser session at
`/slug/os`, no Command Central and no host shell, doing the ten things §10 lists — and
the two defects that writing it turned up.

## The day

`npm run day` boots a throwaway Gateway on a temp home, drives a headless Chromium
through the real pages, and works through the day in order, writing a screenshot per
act into a directory it prints at the end:

1. **Files** — a project, a file in it, opened in the window, edited in the textarea,
   saved with the Save button. The check is `fs.read` afterwards: the bytes changed.
2. **Terminal** — `node app/server.js` typed at a prompt. The port answers. The window
   is closed; the port still answers, the session is still alive and detached. Opening
   a Terminal on that session id replays the scrollback of what happened while nobody
   was watching.
3. **Jobs** — the session is ended (and takes its server with it), the same command is
   started supervised, the log is tailed in the window, searched, searched for something
   that is not there ("nothing in the log matches", rather than an empty box), and
   stopped and started again from the two buttons in the pane head. The run that ended
   stays in the list, so its log is still readable.
4. **Ports** — exposed, listed, served under the slug, and previewed in the Browser
   window.
5. **Access** — shared with a second principal under `fs.read` + `desktop.get`. From
   that principal: the read works, `proc.exec` is `denied` with a code, and reading a
   file does not imply writing one.
6. **Break and fix** — the file is edited to throw. The job reads as **failed**, not
   finished, and its log says why in the window where it was started. The file is fixed;
   the same URL is live again with nothing to reconfigure.
7. **Review** — a proposal with two ops, readable before anything happens; applied; then
   the alignment undone and the widget kept (see below).
8. **Studio** — an app with a companion tool. Its module runs, calls a machine tool and
   its own, throws on purpose, and the error reaches the shell where the Studio shows
   it. Fixed, then the machine is published as a public distro.
9. **A second tenant** — finds it in the gallery, forks it, lands in an arranged
   desktop with the app's source. Its companion server arrives **switched off** and
   serves nothing until they turn it on; then an agent calls its tool with no window
   open.
10. **The phone** — 390 px: one front window, a labelled dock, widgets in a shelf, and
    the job still running while you look at it.

Then: no page or console errors in the whole day except the one act 8 threw on purpose,
an audit chain that verifies over every row of it, a rollup that can say what was used
and how long it took, and a machine that can still say what it is using.

The one thing it cannot do is call a model — an assistant turn needs a provider
credential this host may not have — so act 7 drives the review flow through the same
tools an assistant turn writes, and says so in its own output rather than implying a
model was in the room.

`scripts/lib/chrome.mjs` finds a Chromium to drive on any of the three platforms
(Playwright's cache newest-first, then the browsers people already have) and says one
true sentence when there is none. `npm run smoke` uses it too.

## An undo you can aim

"Apply the agent's change, then undo the alignment only" was in §10 and was not
possible. An agent's change is several revisions — it aligned the windows, then added a
widget — and rewinding past the alignment took the widget with it.

`desktop.revert { rev, only: ["windows"] }` restores just those parts and leaves the
rest of the document as it is now. `desktop.revertScopes` lists what can be aimed at.
Restoring windows carries the stacking counter *forward*, because old geometry with a
stale `zTop` would put the next window opened underneath one already on screen. The
undo is still itself a revision, so it can be undone.

The Studio's History panel offers the same aim: the revert dialog lists the parts that
actually differ in that revision, with "everything in this revision" first, so the
person has exactly the control the tool has.

## Ending a shell ends what the shell started

Act 3 failed on Windows for a real reason. `execInteractive`'s handle did this:

```js
kill() { cleanup(); try { proc.kill("SIGKILL"); } catch {} }
```

`cleanup()` asks `killTree` to walk the tree down from the wrapper — and on Windows
`taskkill /T` reads the tree at the moment it runs. Killing our own child in the same
breath raced that walk: the shell died first, the dev server it had started was
orphaned, and it kept its port. Ending a session left the thing the session started
running, which is the exact opposite of what "end this shell" means.

`kill()` is now `cleanup()` alone. The comment says why, so it does not come back.

## Tests

`test/phase37.test.js`: a scoped undo takes back one part and leaves what came after it;
it refuses a scope that is not a part of the desktop and names the ones that are; it does
not walk the stacking counter backwards; ending a session frees the port its child was
holding (skipped with the shell's own output if the host has no usable shell); and the
History panel's dialog sends the same `only:[…]` the tool takes.

`npm test`: 688 passing. `npm run smoke`, `npm run bench` and `npm run day` green.
