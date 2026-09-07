# Phase 28 — Foundation depth, and the Studio as a builder

Phase 27 made the machine a place. This phase makes the place deep enough to reason
about, and gives it an authoring environment worthy of the word: Waves A and B of the
heroplan.

## The tiling tree is a document field

Tiling used to be an equal grid the client computed and nobody persisted. Now every
workspace carries a **split tree** — `{ split, dir, ratio, a, b }` over `{ leaf, id }`
— and the tree is semantic: "Terminal takes the left 60%, the other two stack on the
right" and not a pixel more. The arithmetic that turns a tree into boxes lives in
`packages/os/src/layout.js`, which has no Node imports on purpose: the Gateway serves it
to the browser from the same file the Kernel imports, so the shell, the `desktop`
server and (in Phase 30) a terminal renderer can never disagree about what a tree
means. Two viewports get two answers from one document. That is the whole point of
keeping pixels out of the model.

`normalizeDoc` keeps the tree honest without any tool having to: it prunes windows
that left and splits in windows that arrived, so a document written before trees
existed tiles the same as one written today. `layoutSet` builds a tree from a preset
(master-stack, columns, rows, grid) or takes one explicitly; `tile` moves a sash,
flips a split, or swaps two leaves; `arrange` grew the same presets and writes pixels
in floating mode from the viewport you pass. In the shell, the sashes are real: drag
one, it paints locally, and releases one `desktop.tile { id, with, ratio }`.

## Races fail honestly

Every write that describes a *place* — a drag, a resize, a snap, a sash, an inspector
field — now commits with `expectRev` set to the revision it was painted against. If an
agent got there first, the Kernel refuses with its own code (`stale_rev`, propagated
through the envelope), the shell re-reads and says "Desktop moved — refreshed", and
nobody's edit is silently overwritten. Last-write-wins is only honest when the loser
knows; the policy is written down in docs/15 §3.

## Small holes, closed

Aliases open (the window runs the target and wears the alias's name), and a ring of
aliases is refused at the door and removed by the normalizer if it arrives another
way. `widgetKinds.refreshMs` is a clock the *host* keeps: it ticks the frame, pauses
when the workspace is hidden or the tab is in the background, and tells a framed
widget when it is off-screen. The menu bar's status icons show real readings — the
live stream, the browser's battery, the Cell's load — or nothing. `history { rev }`
returns a structural diff, and the Layers panel shows all forty revisions with labels,
times, a diff and a confirmed revert.

## The Studio becomes a builder

**Code** is the editor Command Central already had, extracted rather than reinvented:
a file tree with add/rename/delete, tabs with dirty state, syntax colour, pair closing,
`⌘/`, `⌘S`. Saving is `desktop.appWrite`; an agent's `appWrite` lands in the open tab
(a clean one reloads, an edited one is told, never clobbered); a CSS save hot-swaps
into the running frame without a reload. Volume-origin apps edit through `fs.*`, and
the tab says so, because the posture is different.

**Theme** is a token editor for every `--os-*` key with a colour input that can only
ever produce a hex literal, a wallpaper builder that can only ever produce gradients,
a live preview compiled by the very function the Gateway uses, save-as-theme, and
"export as a tool call" — a `desktop.themeDefine` an agent can re-apply. **Motion** is
a designer over the number grammar: sliders for opacity, scale, offset, rotation and
blur at either end, a duration, an easing from the closed set, a sample window to play
it on, and "duplicate & edit" for any preset. Neither panel has a free-CSS box, and
that is the feature.

Design mode grew the craft a builder needs: shift-click multi-select; align,
distribute and match-size as **one** `move { items }` (one revision, one audit row —
an alignment is one intention); alignment guides that magnetise to other elements'
edges; arrow-key nudges by the grid; z-order in Layers; a props editor that states its
8 KB ceiling. Every agent tool card that touched the desktop links back into the
builder: the file it wrote opens in Code, the window it opened is selected. The
builder's width, tab and code target persist in the browser; `⌘⇧P` is the Studio's
own palette.

## Tests

`test/phase28.test.js` pins the tree (normalize round-trip, tool mutations, revert
restores it, two viewports differ), aliases and their refusals, `stale_rev` through
the Kernel and the HTTP envelope, history diffs, batched geometry, z-order, and the
shared module being served from `packages/os`. A browser smoke script
(`npm run smoke`, headless Chromium via `playwright-core`) drives the sashes, the
lost race, Spotlight, the phone fold, the editor's `⌘S`, an agent write landing, the
theme and motion panels, the palette and a multi-select alignment — and caught a
pre-existing `⌘K` bug on its first run.
