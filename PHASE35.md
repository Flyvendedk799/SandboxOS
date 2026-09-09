# Phase 35 — It holds, and it says what it costs

T1.9, T3.4, T3.5, T4.3 and T4.4 of [`goal.md`](goal.md). The parts of "finished"
that are about trust rather than about features: a machine you can back up, an
allowance you can see, latency you can measure, an app that cannot freeze the shell
in silence, and readings that say when nothing could take them.

## A backup of the machine, not of its face

A distro is what you hand to someone else. `desktop.machineExport` is what you keep:
the same desktop, apps and Cell composition, plus your named checkpoints (documents
and all) and a **manifest of the volume** — relative path, size and SHA-256, bounded
to 5000 files with `node_modules`, `.git` and friends skipped.

The manifest is names and hashes, deliberately not contents. Bytes belong to Tide, or
to whatever the operator backs the volume up with; what this adds is the ability to
answer "is this the machine I saved?" — `compareVolume` returns *missing*, *changed*
and *added*, three answers, because "restored" is not one of them.

`desktop.machineRestore { payload, plan: true }` changes nothing and reports what it
would do: a structural diff of the desktop, how many apps and checkpoints travel,
whether the composition would be applied, and which volume files the manifest expects
and this machine no longer has. Its note says the thing a backup must never let anyone
misunderstand: *file contents are not in it; a missing file is missing*. Without
`plan`, it writes the bundles, restores the checkpoint files and index, optionally
applies the composition, and saves the document as one revision.

## An allowance you can see

`kernel.limits` answers what this machine may use and what it is using: the tenant's
quota (sandboxes, agents, running Cells, memory, CPU), live counts (agents running,
shells open, sandboxes), disk measured rather than estimated, and **model tokens by
provider and model** over a window.

Tokens, not money — and it says so, in the payload, in as many words: a price depends
on the plan a call bills to, which a self-hosted instance often cannot see. Inventing a
currency figure would be the kind of plausible number this project does not ship. A new
`model_usage` table records a turn's tokens as the assistant finishes it (the accounting
is wrapped so it can never fail a conversation), and Settings → Machine shows the whole
picture with the ceiling and the current number side by side.

## Latency, in the log where everything else already is

The audit row grew an `ms` column, and the Kernel times every call: how long a tool took
is part of what happened, and an operator asking "what is slow" should not have to infer
it from two timestamps. The hash covers it, so tamper-evidence is unchanged — and the
payload the hash covers is now **one exported function** (`auditHash`), because it had
drifted into three copies (the writer, the verifier, and a test's repair helper) and
adding a column broke the copy nobody remembered.

`metrics.activity` answers the three questions an operator actually asks, per tool, in
one pass: how often (`n`), how badly (`denied`, `errors`), how slowly (`avgMs`, `maxMs`)
— plus `slowest`, the slowest individual calls of the window, which is a different list
from the busiest tools and usually the more interesting one. Observability shows both,
and every row is a click into the Audit app filtered to that tool.

## An app cannot freeze the shell in silence

The broker pings every live, ready, visible frame every four seconds; `bridge.js` answers
from inside. A frame in a loop cannot answer, because it cannot run the handler — so
after nine seconds of silence the window manager paints a card over it: *"X stopped
responding"*, with Reload it, Open its source (a deep link into the Studio's Code tab)
and Close the window. The window itself still drags, zooms and closes, because the shell
is not the app. A background tab is not a stuck app, and neither is a frame that has not
painted yet.

## Readings that admit what they are

`metrics.snapshot` now reports `unavailable` with the reason when the Cell could not be
measured at all — a host with no shell, or an image with no `/proc`, no `uptime` and no
`du` — instead of a zero that reads as an idle machine. `ports.scan` stops at the first
strategy that reports it cannot run commands and says so with what it tried. The
Observability window shows those sentences where the numbers would have been.

## Tests

`test/phase35.test.js`: a backup carries desktop, apps, composition, checkpoints and a
volume manifest; a restore plans without acting and is honest about contents; the volume
comparison distinguishes missing from changed from added; an oversized payload is
refused; `kernel.limits` reports quota, live usage, measured disk and tokens by provider
with the note that they are not money; usage is windowed; every call carries a duration
and the chain still verifies with `auditHash` as its single definition; the rollup
answers count, refusals, failures and latency per tool; metrics and the port scan report
`unavailable` rather than zero; and the watchdog exists on all three sides.

`npm test`: 659 passing. `npm run smoke` and `npm run bench` green.
