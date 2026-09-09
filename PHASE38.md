# Phase 38 — Track 5: finished means shippable

The last track of [`goal.md`](goal.md), plus the two loose ends the earlier tracks
left behind. Track 5 is not about features: it is about a build that a stranger can
start, read, trust and ship.

## T5.1 · Ten minutes to useful

A new machine used to open on a tidy but idle desktop, which reads as a screenshot of
software rather than software. The document now carries `setup: { done, seed, at }` —
a fact about the machine, not a flag in a browser, so a second tab and a phone agree
about it — and a machine that has not been through first run shows one screen before
the desktop paints: the single idea in four cards, the seeds, and a way to skip.

`desktop.setup { seed }` then does the work: adopt the seed, write a `welcome/`
folder and a first note into the volume, ask the Cell what it actually has that can
serve a folder (node, python3, python, busybox — by *running* each one), start it as
a supervised job called `welcome`, expose its port, open the Browser on it beside the
Manual, and mark the machine set up. The first thing you see is your own machine
serving a file you can edit, through a job you can stop, at an address under your own
slug — three ordinary things, each of them openable.

It reports `steps`: what, whether, and why not. An image with no Node and no Python
cannot serve a folder; the honest version of that is a named failure with the folder
still sitting there. And because a static server's usual failure is `EADDRINUSE` a few
milliseconds after it spawns, setup waits and looks again before it says "serving" —
reporting a start and handing over a dead job is the exact shape of a silent success.

`desktop.reset` keeps `setup`. Someone clearing their windows is not a new user.

## T5.2 · The manual is an app

`help` is a built-in with two halves and one search box.

The manual half is the repository's own documentation — this file's neighbours, the
surface map, the architecture, the Kernel, the security model, distros, the glossary,
`goal.md` — served from `/:slug/os/manual` and rendered in the window. Nothing is
copied: if a sentence in that window is wrong, the file in `docs/` is wrong. The page
id is looked up in a fixed table rather than joined into a path, and reading it needs
`desktop.get` — the right that lets you see the desktop is the right that lets you
read about it.

The catalogue half is `kernel.tools`: every tool of every enabled server, with its
description and arguments. A custom app's companion server appears the moment it is
switched on and is gone when it is switched off, because the list is the machine's
answer rather than one somebody maintains. Every tool has a **Try it** that fills
Spotlight with its name rather than running it — the manual hands you to the thing
that runs it, in the place you would have reached for anyway.

## T5.3 · Cross-platform CI

`.github/workflows/release-check.yml` runs one command on Linux, macOS and Windows,
plus a `linux-no-docker` leg that hides the binary so a single host is tested both
ways. "With Docker or without" is covered by the matrix rather than by a flag.

`scripts/docker-check.mjs` is the container half of promise §0.9: a real container per
Sandbox, driven through the same Kernel calls the desktop makes — a file written from
the host read from inside and back, a non-zero exit that comes back as a code, a
missing binary that is not a silent success, a supervised process streaming output,
busybox httpd on a port reached through the slug, a Terminal session with a shell in
the container. On a host without Docker it prints one line and exits 0: "no Docker
here" is a supported configuration, not a red mark for failing to install something
optional. **It has not yet run anywhere** — there is no Docker on the machine this was
built on, and CI is what will first execute it.

## T5.4 · The schema is still v1

Asked for v2 "when, and only when, it is earned". It has not been. Everything the
document has gained is additive and `normalizeDoc` fills each field from the defaults
when it is absent; no field changed meaning or shape, so there is no migration to
write, and a bump whose only content is a larger number teaches everyone downstream to
ignore the number.

What was missing was the machinery a bump will need. `docCompatibility(doc)` reads the
version; a document from a newer build is **refused** where it would otherwise be
silently truncated — importing a distro, restoring a backup — because `normalizeDoc`
keeps only the fields this build knows, which is what makes it safe against a hostile
document and what would make forking a newer person's desktop a silent, partial loss.

`test/phase40.test.js` is the evidence rather than the claim: documents shaped the way
each earlier wave of this project wrote them are loaded and checked twice over — what
they meant survives, what they never had arrives at its default.

## T5.5 · The release check

`npm run release-check` runs the suite, the bench, the smoke, the day and the container
and prints one page: what this host actually is, then a line per stage with a headline
rather than scrollback. Every stage runs even when an earlier one failed. Shipping is
that page being green on all three platforms.

```
  ✓  the suite      62.4s   711 passing, 0 failing, 1 skipped
  ✓  the bench       2.1s   12 budgets met
  ✓  the smoke      23.0s   76 checks passed
  ✓  the day        18.9s   11 acts, 64 checks passed
  ○  the container   skipped — no Docker here — which is a supported way to run
```

`scripts/lib/chrome.mjs` finds a Chromium on any of the three platforms — Playwright's
cache newest-first, then the browsers people already have — and says one true sentence
when there is none, so neither the smoke nor the day needs `CHROME` set by hand.

## The loose ends

**T3.4 · Snapshots on a schedule.** Not a new mechanism: a `cron` job that calls
`desktop.checkpoint { auto: true }` on your behalf, with your capabilities, audited
like any other call — a principal who cannot checkpoint by hand cannot schedule one
either. The addition is a budget: automatic snapshots hold their own
`LIMITS.autoCheckpoints` slots, and when the shelf is full the scheduler's oldest goes
before yours. Fixed alongside: a `revert` no longer forgets a checkpoint, and replacing
the machine wholesale now sweeps checkpoint files nothing can reach any more.

**T4.2 · Deltas, deliberately not built.** The plan holds a delta protocol in reserve
*if* the wire budget could not be met by compression alone. It can: the bench measures
the whole document on the wire at the ceiling shape at about 13 KB against a 96 KB
budget, and now prints how close it is. A second representation of the desktop would be
a second thing for every client to reconcile and a new class of bug where the patch and
the document disagree — to save bytes that are not scarce. The number is in CI, so the
day it stops being true the decision can be revisited on a measurement.

**T4.5 · The keyboard, finished.** The smoke drives the surfaces T4.5 names with
nothing but Tab and Enter: the dock, a row in Files, the shelf handle, a window's title
bar, a sash, an overlay. They are real buttons, which is the point — an affordance that
needs a synthetic click is not keyboard-reachable.

## Tests

`test/phase38.test.js` (the manual), `test/phase39.test.js` (first run),
`test/phase40.test.js` (the schema across every era), `test/phase41.test.js`
(scheduled snapshots). The day script gained act 0 — first run, in a browser,
asserting that something is running and reachable when the screen clears.

Defects these found, all of the same family as Track 0: the desktop painted behind the
welcome screen and had the Terminal writing into a document about to be replaced;
`loadOs()` could rewind the client when a full read raced the event stream; `killTree`
spawned `taskkill` detached on Windows, so "stop this" was a promise rather than a
fact, and a teardown that then exited left dev servers holding their ports; the Jobs
app scheduled in `minutes` against a tool that takes `intervalMs`, and read fields the
jobs table never had; and the Settings panel's own state was declared inside `render`,
which broke the whole window rather than one row.

`npm test`: 729 passing. `npm run release-check` green on Windows, with the container
leg reporting itself skipped.
