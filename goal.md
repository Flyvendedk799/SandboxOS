# Goal — the desktop and the Studio as software you would trust

> **The goal.** Turn `/slug/os` and `/slug/studio` from a convincing demonstration
> into the place their owner actually works: a machine that cannot be brought down
> by its own Terminal, that never reports success for something that failed, that
> can run, watch, expose, share and rebuild real work without ever leaving the
> desktop — and that gives the person at the keyboard more control over the machine,
> and over the agent holding the other end, than any dashboard they have today.
>
> Phases 27–30 made the desktop a *place* and proved the contract (document →
> Kernel → audit → SSE → renderer). This plan is not about new metaphors. It is
> about the distance between a place you can show someone and a place you can live
> in when things go wrong.
>
> Ground truth was **measured on 2026-09-08 against `382fcba`**, on the machine this
> repository is developed on: Windows 11, Node 24.18.1, no Docker, `local` cell
> backend. Every number in §1 was taken, not remembered. Reproduce them before you
> argue with them — and if they have moved, fix §1 first.

---

## 0 · Ten promises

"Finished" is not a feeling, it is a list you can fail. These are the promises;
everything after this section is how they get kept, and §10 is how they get checked.

1. **Nothing done inside the OS can take the OS down.** Not a Terminal on a host
   without a shell, not a runaway custom app, not a distro someone sent you.
2. **Nothing fails silently.** A command that could not start says so, in the window,
   with the reason and the fix. `ok: true` never wraps a failure.
3. **The desktop can run the machine.** Everything Command Central can do —
   processes, ports, agents, secrets, sync, audit, access — is an app on the desktop,
   drivable by hand and by agent through the same tools.
4. **Work survives the tab.** Close the browser, lose the network, restart the
   Gateway: jobs keep running, the terminal reattaches to its session, and the
   desktop you come back to is the desktop that is actually there.
5. **Every change is reviewable and reversible — the agent's most of all.** You can
   see what it is about to do, diff what it did, and undo it by intention rather than
   by revision number.
6. **The Studio shows you the thing you are designing.** At any pane width, for any
   target viewport, with the real document under it.
7. **You can see and revoke every capability, per app, at any time** — and see the
   call that used it, in the window that made it.
8. **It holds under load.** Forty windows, twenty widgets, three terminals and an
   agent editing, without the shell dropping frames or the disk doing megabytes of
   work per drag.
9. **It runs where its owner runs it** — Windows, macOS, Linux, with Docker or
   without — or it refuses at boot, in one honest line, naming what is missing.
10. **Ten minutes to useful, and no ceiling.** A stranger gets somewhere real in ten
    minutes; an expert never hits a wall they cannot open with a tool call.

---

## 1 · Ground truth, measured

### It breaks

| What | Evidence | Where |
|---|---|---|
| **Opening the Terminal kills the Gateway for every tenant on the host.** The pty cleanup spawns `/bin/sh`; on a host without one, `spawn` emits `'error'` asynchronously, nothing is listening, and Node terminates the process. The surrounding `try/catch` cannot help — spawn does not throw. | Boot the Gateway on Windows, open the Terminal: the process exits with `Error: spawn /bin/sh ENOENT`. `npm run smoke` dies at the same line. | `packages/cell/src/local-backend.js:101,104`; same shape in `docker-backend.js:139,143`, `hardened-docker-backend.js:162,166` |
| **No process-level guard exists.** There is no `uncaughtException` or `unhandledRejection` handler anywhere in the tree, so a stray async error anywhere ends every session on the host. | `grep -rn "uncaughtException\|unhandledRejection" apps packages` → no hits | `apps/gateway/src/index.js` |
| **51 tests fail on this machine** (537 pass), every one a POSIX assumption: `proc.exec`, `proc.start`, the pty, `secrets.useInEnv`, marketplace install, agent kill, the SDK, `POST /:slug/stream`. Stable across runs — not flake, just a shell that is not there. | `npm test` → 537 ✔ / 51 ✖ | `packages/cell/src/local-backend.js`, `handles.js:57`, `pty.js` |

### It hides

| What | Evidence | Where |
|---|---|---|
| **A command that cannot start reports success.** `proc.exec` on a host with no `/bin/sh` returns `{ ok: true, result: { stdout: "", stderr: "", code: 1 } }`. The Console prints nothing, the Terminal shows nothing, and the machine looks empty rather than broken: `execFile`'s ENOENT is folded into `code: 1` with an empty `stderr`. | `POST /tobias/mcp {proc.exec "echo hi"}` → `{"ok":true,"result":{"cmd":"echo hi","stdout":"","stderr":"","code":1}}` | `packages/cell/src/local-backend.js:48-57` |
| **A malformed call at the front door surfaces as a database error.** `POST /:slug/mcp` with a body missing `server` reaches the audit insert and returns HTTP 500 `Provided value cannot be bound to SQLite parameter 5.` Nothing validates between the request and the schema. | `curl -d '{}' /tobias/mcp` → 500, that string | `apps/gateway/src/server.js:1074`, `packages/control-db/src/registry.js:369` |
| **A reconnected event stream never resyncs.** `hello` carries the current `rev`; the client's handler ignores it and only flips `connected`. A tab that slept through three agent writes keeps painting a stale desktop until it happens to write something itself. | `apps/gateway/src/server.js:1235` sends `{slug, rev}`; `client.js` `connect()` reads neither | `apps/gateway/public/js/os/client.js` |
| **The boot banner says "Phase 19"** on a Phase 30 build. Small, but it is the first line the operator reads, and it is false. | `npm start` output | `apps/gateway/src/index.js` |

### It is shallow, and it is expensive

| What | Evidence | Where |
|---|---|---|
| **Every desktop write re-downloads the whole theme.** The stylesheet link is keyed on `doc.rev` and the route sends `Cache-Control: no-store`. Ten window moves by an agent means ten full stylesheet fetches, parses and style recalculations, in every open tab. | Measured in headless Chrome: 10 moves → **10** `theme.css` requests, 12,760 bytes | `client.js` `applyThemeLink()`, `apps/gateway/src/server.js:1253` |
| **Every desktop write rewrites the entire history file.** `pushHistory` reads the whole array, appends a full copy of the document and writes it back — on every drag. After ~25 revisions of a near-empty desktop the file is already 141 KB; the ceilings permit 40 × 512 KB. | `os/history.json` = 141,331 bytes after a short session | `packages/os/src/store.js` `pushHistory()` |
| **The Studio's stage folds to a phone.** Compact mode is decided by the *root element's* width (`< 720px`), and the split-view stage is ~500 px on a 1440 px screen. The builder therefore shows one window, a widget shelf and no sashes — you cannot see, arrange or design a desktop layout in the view built for designing desktop layouts. | Screenshot of `/tobias/studio` at 1440×900: the stage renders phone chrome | `apps/gateway/public/js/os/wm.js:25,148` |
| **The desktop is a weaker client than the console it was meant to surpass.** Ten built-ins: Files, Terminal, Console, Notes, Assistant, Observability, Media, Browser, Settings, Studio. Command Central additionally has Agents, Ports, Processes + cron, Sync, Secrets, Apps and the audit explorer. Start a dev server, expose it, watch its logs, share it with someone — none of that has a home on the desktop. | `packages/os/src/catalog.js:10-21` vs `README.md` §Command Central | — |
| **A terminal is a tab, not a session.** Closing a window kills the pty; reopening gives a fresh shell — documented, deliberate, and wrong for real work. | `PHASE30.md` §built-ins | `apps/gateway/public/js/os/terminal.js` |

### What is already good, and must survive the repairs

The document model, the 67-tool `desktop.*` surface, `normalizeDoc`'s clamping, the
closed appearance grammars, `expectRev` refusal, opaque-origin app frames with brokered
tokens, façade/companion app duality, distro integrity hashes, the semantic
`summarize`/`silhouette` pair, three renderers over one document, the contrast tests,
and the honest empty states the built-ins already show. **Screenshots taken today show
zero console errors across the OS, the Studio and the phone fold.** The foundation is
not the problem. The problem is everything between "the demo works" and "I would run my
day on this."

---

## 2 · The three tests of "finished"

Everything in this plan exists to pass one of these. They are written as scripts in §10
and they run in CI.

**The blackout test.** Start a job. Close the tab. Pull the network. Restart the
Gateway. Come back on a phone. The job is still running, its logs are intact, the
terminal reattaches to its session, and the desktop shown is the desktop that exists.
Nothing lost, nothing invented.

**The hostile-app test.** Install a custom app that spins forever, one that grabs for
capabilities it never declared, one whose companion server throws on boot, and a distro
whose bundle was edited after publication. The shell stays responsive, the grabs are
refused and visible in the app's own ledger, the broken companion is reported and the
desktop is not, the tampered distro does not install. Nothing an attacker sends becomes
a privilege, and nothing they send takes the machine down.

**The day test.** A scripted, headless day in the life — clone, install, run, expose,
share, watch, break, diagnose, fix, publish, fork — driven half by hand and half by an
agent, producing screenshots. If a step needs Command Central or a shell outside the OS,
the day fails.

---

## 3 · Invariants

The ten in [`heroplan.md`](heroplan.md) §1 hold in full — no privileged UI path,
`normalizeDoc` never throws, closed grammars, viewport-agnostic server, OS storage
beside the Cell, notifying never creates a desktop, the frame sandbox, a dependency-free
front end, tests pin the contract, write like the codebase. Four more join them, and
they are what this plan is really about:

11. **No unhandled child.** Every `spawn` / `execFile` gets an `'error'` listener before
    it can fire, and the process carries `uncaughtException` / `unhandledRejection`
    handlers that log, audit and keep serving. A failure inside one Sandbox may end that
    Sandbox's operation; it may never end the host process.
12. **No silent success.** If the thing did not happen, the result says so, names the
    cause, and — where there is one — the fix. A tool that swallows an error to preserve
    a shape is a bug, and the suite asserts the error text, not just the shape.
13. **Host assumptions are declared, checked at boot, and honest at the tool.** A
    backend states what it needs (`sh`, `docker`, `script(1)`); the Gateway checks at
    startup and prints one line naming what is missing and what it disables; tools that
    need it fail with `unsupported_host`, never with an empty string.
14. **Every surface has a budget, and the budget is a test.** Bytes on the wire per
    desktop write, disk written per write, frames dropped during a drag with forty
    windows, time to first paint. A change that blows a budget fails CI the way a broken
    contract does.

---

## 4 · Track 0 — It cannot break

*The rest of this plan is worthless without this track, and this track is worth shipping
on its own. Do it first.*

**T0.1 · Kill the crash class.** Give every child an `'error'` listener at creation —
`local-backend.js` (exec, execStream, execInteractive, resize, cleanup), both docker
backends, `firecracker-backend.js`, `marketplace-pool.js`, the cloudflared spawn in
`index.js`. Add `process.on("uncaughtException" | "unhandledRejection")` to the Gateway
entry: log it, audit it, keep the listener alive, and exit only on a second failure
inside the handler itself. Test: spawn a nonexistent shell through every backend path
and assert the process survives with a typed error.

**T0.2 · Make the local backend run where its owner runs it.** Resolve the shell once,
at construction: `SANDBOXOS_SHELL` → `/bin/sh` → `bash` → `pwsh`/`powershell` → `cmd`,
and record which. Windows gets a real implementation, not a stub: `exec` and
`execStream` through the resolved shell, `execInteractive` through ConPTY where
available with a documented line-mode fallback where not, process-group kill via
`taskkill /T` where `kill(-pid)` does not exist. The pty wrapper's `script(1)` becomes
one strategy among several, chosen by capability probe rather than by hope. Target:
**`npm test` green on Windows, macOS and Linux**, or a test skipped with a printed
reason naming the missing binary — never a red suite everyone learns to ignore.

**T0.3 · No silent success.** `exec` distinguishes *did not start* (`ENOENT`, `EACCES`,
timeout) from *ran and failed*: the first returns `ok: false` with `code:
"spawn_failed"`, the binary it looked for and the fix; the second keeps today's shape.
Audit both. Sweep the tree for `catch {}` that hides a cause — most are legitimate
best-effort, and each one either keeps a comment saying why the loss is safe or starts
reporting.

**T0.4 · Validate at the door.** `POST /:slug/mcp` rejects a body without `server` and
`tool` with 400 and the missing field named. No handler passes user input to a prepared
statement without a shape check. A fuzz test posts malformed bodies to every route and
asserts: no 500 without a Gateway-authored message, and no database string ever reaching
a client.

**T0.5 · Cheap writes.** Link `theme.css` by a *theme* hash rather than `doc.rev`, and
serve it with an ETag and a long cache — a window move must cost zero stylesheet bytes.
Move history from one rewritten array to append-only revision files
(`history/<rev>.json` plus a small index), pruned to `LIMITS.history`; a drag then writes
one document and one index line, not the last forty documents.

**T0.6 · Resync, always.** On `hello`, compare the stream's `rev` with the local one and
pull when they differ. Put a `rev` on the keepalive so a silent divergence is caught
within a ping. On repeated stream failure the shell says it is disconnected instead of
pretending the desktop is live. Test: drop the stream, write three times as an agent,
restore it, assert convergence with no user action.

**T0.7 · Tell the truth at boot.** The banner prints the build stamp, the resolved cell
backend and shell, and one line per missing capability and what it disables. Delete the
hardcoded phase.

**Done when:** the smoke suite runs to completion on Windows and Linux; a Terminal on a
shell-less host shows a card explaining exactly what is missing while the rest of the
desktop keeps working; `npm test` is green on all three platforms; ten agent window
moves cost zero theme bytes and one document write each.

---

## 5 · Track 1 — The desktop can run the machine

*Command Central is remote-first and it stays. But a desktop that sends you to a console
to restart a dev server is a demo of a desktop.*

Each of these is an ordinary built-in — same `catalog.js` entry, same `needs` list, same
"an agent could do this too" rule. None gets a private channel.

**T1.1 · Jobs.** `proc.start/list/logs/stop/signal/forget` and `cron.*` as one app:
running processes, live log tail with search and follow, exit codes, restart, "start this
again", the schedule, and a job's notifications deep-linking back to it. Ports it opened
are shown inline.

**T1.2 · Ports.** `ports.scan/expose/unexpose/check`, a preview pane (the Browser
built-in becomes its viewer rather than its owner), the public URL when a tunnel is up,
and one-click share into T1.6.

**T1.3 · Agents.** Spawn with an explicit capability set, watch the transcript stream,
inspect the tool calls, kill, re-run with edits. The agent that rebuilds your desktop and
the agent that rebuilds your code are the same object with different grants, and both are
visible here.

**T1.4 · Sync.** Tide as an app: workspaces, working-tree status, marks, per-mark diff,
restore, push/pull. Files' Tide badges link into it.

**T1.5 · Secrets.** Reference-only handling with Command Central's discipline: put, list,
remove, use-in-env — and a clear statement, in the UI, that the value never comes back.

**T1.6 · Access.** Who can reach this machine, with which patterns, machine tokens,
revocation, and the audit rows showing what each principal actually called.

**T1.7 · Audit.** The explorer in a window: filters, hash-chain verification, export,
and — the part Command Central does not have — scoping to a window: "show me everything
this app has called."

**T1.8 · Terminal as a session.** The pty outlives its window: sessions live in the Cell
with a name and scrollback, `desktop.open terminal { session }` reattaches, and closing a
tab detaches rather than kills (killing is a menu item that says so). This is the single
largest "is this real?" signal in the product.

**T1.9 · Observability worth opening.** Beyond sparklines: per-tool call rates and
latencies, error rates by server, the slowest calls of the last hour, disk and volume
usage, and a link from any spike into the audit rows that caused it.

**Done when:** the day test in §10 runs start to finish without leaving `/slug/os`, and
every app in it is also drivable by an agent through published tools.

---

## 6 · Track 2 — The Studio you would choose over an editor

**T2.1 · Fix the stage.** Compact must be a property of the *rendered viewport*, not of
whichever div the shell happens to sit in. Give `createDesktop` an explicit viewport
mode; give the Studio stage device presets (Desktop / Tablet / Phone / Custom) with
zoom-to-fit and a scale readout, so a 500 px pane renders a 1440 px desktop scaled down,
with sashes, snapping, design mode and multi-select intact. This is the bug that makes
the Studio read as a toy; fix it before anything else here.

**T2.2 · The editor grows up.** Search and replace across a bundle, symbol jump within a
file, a diff against the last saved version, and — the missing half — **the frame's
errors come back**: console output and uncaught errors from a custom app's iframe surface
in a Studio console panel with file and line, instead of dying inside an opaque origin
where nobody can see them.

**T2.3 · Review mode for the agent.** The build agent proposes a patch; you see a
structural diff (windows, widgets, theme keys, files changed) and Apply or Discard. Under
it, a real `desktop.propose` / `desktop.applyProposal` pair, so proposals are document
objects with the same audit story rather than client-side theatre. Auto-apply stays
available per session, and says so.

**T2.4 · Checkpoints, not revision numbers.** Name a desktop state ("before the
redesign"), list checkpoints beside the forty revisions, diff any two, restore either.
Undo becomes "undo *that*", grouped by intention — the drag, the alignment, the theme
change — because history already stores labels and nobody wants to count revisions.

**T2.5 · Inspector completeness.** Every document field an agent can write, a human can
edit here, with the same validation and the same refusals: associations, singleton hints,
permissions, `refreshMs`, alias targets, app origin, workspace layout. Where a field is
clamped, the inspector states the ceiling before you hit it.

**T2.6 · Publishing that reassures.** Before publish: what will travel (documents,
bundles, composition), what will not (secrets, notifications, tokens), and the integrity
hash. Before fork: the diff against what you have.

**Done when:** a person designs a two-workspace desktop with a custom app, at three
viewport sizes, reviewing an agent's proposals as diffs, without opening a second tool.

---

## 7 · Track 3 — Control you can feel

**T3.1 · The capability ledger.** Per app: what it declared, what it was granted, what it
has actually called, and a revoke that takes effect on the next call without a reload. A
window's title bar carries a badge while its app holds a capability, and the badge opens
the ledger scoped to that window. This is what makes "an app is a real principal" visible
rather than merely architectural.

**T3.2 · The keyboard is a document field.** Shortcuts live in the document, remappable,
per-workspace where that makes sense, with conflict detection; `⌘?` generates the cheat
sheet from the map rather than from a hardcoded list. An agent can rebind, and you can
revert a binding like anything else.

**T3.3 · Attention is yours.** Focus modes and do-not-disturb in the document; rules
("agent finished" always through, "process exited 0" batched); a notification history
that survives a reload; and the existing rule kept — nothing that belongs in the document
gets toasted away.

**T3.4 · Backup and restore, boring and complete.** Export a machine: desktop document,
history, bundles, composition, and — new — a manifest of the volume with an optional Tide
mark, so a restore rebuilds the *machine* and not just its face. Scheduled snapshots
through `cron`. Import shows the diff first. Prove it by destroying a Sandbox and
rebuilding it from the export alone.

**T3.5 · Quotas and cost, visible.** Cell power, disk, agent count, model spend by
provider — in Settings, in the same place you change them, ceiling and current number
side by side. Power that silently hits an invisible limit is not power.

**Done when:** a user can answer, without leaving the desktop: what can this app do, what
has it done, what is it costing me, what do I lose if this machine dies, and how do I take
all of it somewhere else.

---

## 8 · Track 4 — It holds

**T4.1 · Budgets as tests.** Write them down and enforce them: ≤ 1 document write and 0
stylesheet bytes per gesture; ≤ 64 KB on the wire per desktop write at the ceiling
document; ≤ 1 file written per revision; a stated first-paint budget for a 40-window
desktop on the CI runner; no dropped frame during a drag with 40 windows, 20 widgets and
an agent writing every 200 ms. The bench lives beside the smoke.

**T4.2 · Deltas where the document is large.** If T4.1's wire budget cannot be met by
compression alone, send `{op, rev, patch}` for geometry-only writes and keep the full
document for structural ones — the client already reconciles by id. Deltas are an
optimization, not a new contract: a client that ignores them and pulls must still be
correct.

**T4.3 · Frames cannot freeze the shell.** A watchdog pings each app frame; one that
stops answering gets a card ("this app stopped responding — reload / close / open its
source") and its window stays draggable. A widget that throws renders as a card, not a
hole.

**T4.4 · Degrade honestly.** Every panel that reads the machine states its condition:
live, stale (with age), or unavailable (with reason). No spinner that spins forever, no
zero that means "unknown".

**T4.5 · Accessibility as a contract.** A keyboard-only path to every action including
the dock, the shelf, sashes and design-mode selection; roles and names on all chrome;
focus never trapped in a frame; the contrast test extended to custom themes at define
time (refuse or warn — never ship an unreadable theme silently).

**Done when:** the bench passes on CI, the hostile-app test passes, and a keyboard-only
run of the day test completes.

---

## 9 · Track 5 — Finished means shippable

**T5.1 · Ten minutes to useful.** First run picks a seed, explains the document model in
one screen, and hands over a machine with something already running in it — a served
folder, a note, a job — so the first thing you see is your machine doing work.

**T5.2 · The manual is an app.** `docs/15` and the surface map, rendered as a built-in
Help app with a searchable tool catalogue: every `desktop.*` tool, what it does, and a
"try it" that fills Spotlight. Documentation that ships with the distro cannot drift from
the build.

**T5.3 · Cross-platform CI.** The suite and the smoke on Linux, macOS and Windows, with
and without Docker. The matrix is promise §0.9, and it is the only thing that keeps it
true.

**T5.4 · Schema v2 when, and only when, it is earned.** Sessions, keymaps, checkpoints
and proposals may deserve a bump. `normalizeDoc` migrates v1 → v2, with tests that load
documents from every earlier phase's fixtures.

**T5.5 · The release check.** One command that runs the suite, the bench, the smoke and
the day test on all three platforms and prints one page. Shipping is that page being
green.

---

## 10 · The acceptance suite — the definition of done

Four scripts. They live in `test/` and `scripts/`, run headless, and produce screenshots.
**This section is the specification; the tracks are how it gets passed.**

**A · The day** (`scripts/day.mjs`) — one browser session at `/slug/os`, no Command
Central, no host shell:

1. Files: create a project folder, drop in a file, edit it, save.
2. Terminal: install and start a dev server. Close the window. Reopen it — same session,
   same scrollback, still running.
3. Jobs: see it supervised, tail its log, search the log, restart it.
4. Ports: it is listening; expose it; preview it; copy the URL.
5. Access: share it with a second principal under a narrow pattern; from that principal,
   verify the narrow pattern is all that works.
6. Break it: edit the file to throw. See the failure in the job's log, not in silence.
   Fix it from Files. Watch it recover.
7. Assistant: "tidy this workspace and add a widget showing my exposed ports." Review the
   proposal as a diff. Apply. Undo the alignment only.
8. Studio: build a small app with a companion tool; edit three files; see a frame error
   surface in the Studio console; fix it; publish the desktop as a distro.
9. Second tenant: find it in the gallery, fork it, call its tool without opening a
   window, and land in an arranged desktop.
10. Phone: reopen the same document at 390 px — workspaces, shelf, the running job, the
    terminal reattaching.

**B · The blackout** (`test/blackout.test.js`) — job running, tab closed, stream dropped,
Gateway restarted, three agent writes in between. Assert: job alive, logs intact, terminal
reattaches, document converges without user action, no lost write and no invented one.

**C · The hostile day** (`test/hostile.test.js`) — spinning app, capability grab, throwing
companion, tampered distro, 600 KB document, 200 windows requested, a widget that writes
every 10 ms. Assert: refusals typed and visible, shell responsive, host process alive,
audit complete.

**D · The bench** (`scripts/bench.mjs`) — the T4.1 budgets, printed as a table, failing CI
on regression.

A build is finished when A, B, C and D pass on Linux, macOS and Windows, and each of the
ten promises in §0 maps to a named assertion in one of them.

---

## 11 · Order of work

Dependency order, not calendar. Commit at each numbered step; keep `docs/15` and the
surface map true as you go; write the PHASE note at the end of each track.

1. **Track 0, entirely.** Nothing else matters while the Terminal can kill the host.
   T0.1 → T0.3 → T0.4 → T0.2 → T0.5 → T0.6 → T0.7. Ship it as its own phase.
2. **T2.1** (the stage fold) — one bug, disproportionate effect on whether the Studio
   reads as software.
3. **T1.8** (terminal sessions) and **T1.1–T1.2** (Jobs, Ports) — the spine of the day
   test; the rest of Track 1 follows the same shape and can be parallelized.
4. **T4.1** budgets and **D** the bench, before Track 1 grows the document further.
5. **T2.2–T2.3** (editor errors, review mode), then **T3.1** (the ledger) — authorship
   and control, the two halves of "power".
6. **T1.3–T1.9**, **T3.2–T3.5**, **T4.3–T4.5** in parallel; each is self-contained.
7. **A**, the day script, as soon as steps 1–5 make it possible; let it fail loudly and
   drive what remains.
8. **Track 5**, then **T5.4** if the schema has genuinely earned v2.

Parallel-safe: Track 1's apps against each other; Track 3 against Track 2. Not
parallel-safe: anything that changes `normalizeDoc` while another agent is adding document
fields — one schema change at a time, behind a tolerant normalizer.

---

## 12 · Out of scope

Unchanged from `heroplan.md` §15 — MCP stays the ABI, no pixel capture of Cell contents,
no CRDT, no framework rewrite, no multi-host scheduling — plus:

- **A native shell.** Tauri/WKWebView is a renderer question; this plan is about the
  machine being real, not about it being installable.
- **A public app marketplace.** The distro gallery is the sharing story until Phase 6
  brings signing.
- **Collaborative multi-cursor editing.** `expectRev` with an honest refusal, plus
  proposals in T2.3, is the answer until two humans in one desktop is a real request.
- **Rewriting Command Central.** It stays remote-first and complete. Track 1 is not about
  taking anything away from it; it is about the desktop no longer needing it.

---

## 13 · File map

| Area | Paths |
|---|---|
| Crash class, host portability | `packages/cell/src/{local-backend,docker-backend,hardened-docker-backend,firecracker-backend,pty,handles}.js`, `packages/kernel/src/marketplace-pool.js`, `apps/gateway/src/index.js` |
| Door validation, routes, SSE | `apps/gateway/src/server.js`, `packages/control-db/src/registry.js` |
| Document, history, budgets | `packages/os/src/{schema,store,layout,summary}.js` |
| Desktop tools | `packages/kernel/src/servers/desktop.js`, `packages/kernel/src/catalog.js`, `packages/os/src/catalog.js` |
| Shell, WM, stage viewport | `apps/gateway/public/js/os/{shell,wm,client,os}.js`, `apps/gateway/public/os.css` |
| Studio, editor, review mode | `apps/gateway/public/js/os/{studio,builder,code,agent,theme-studio,motion-studio,palette}.js` |
| Built-ins (Track 1's new apps) | `apps/gateway/public/js/os/{builtins,widgets,terminal,ansi,frames,bridge}.js` |
| Sessions, jobs, ports | `packages/kernel/src/servers/{proc,ports,cron}.js`, `packages/cell/src/*` |
| SDK / CLI parity | `packages/sdk/src/client.js`, `packages/sbx-cli/src/sbx.js` |
| Tests, bench, day | `test/`, `scripts/browser-smoke.mjs`, new `scripts/{day,bench}.mjs` |
| Docs | `docs/15-os-experience.md`, `docs/14-surface-map.md`, `docs/09-security-model.md`, `PHASE31.md`… |

---

*A demo answers "can it?". This plan answers "will it, at 2 a.m., on the machine I
actually own, with an agent I did not watch?" Every promise in §0 is a thing that can be
tested, and §10 is where it gets tested. None of it requires abandoning the document —
the document is why any of it is possible.*
