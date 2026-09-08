# Phase 31 — It cannot break

Track 0 of [`goal.md`](goal.md). The desktop was a place you could show someone; this
is the phase that makes it a place you can be in when something goes wrong. Nothing
here is a feature. All of it is the difference between a demo and software.

## A Terminal could kill everyone's machine

`spawn` reports a missing binary by emitting `'error'` — asynchronously, after the
call has already returned. A `try/catch` around it catches nothing, and an unhandled
`'error'` is a fatal exception in Node. So on a host without `/bin/sh`, opening the
Terminal ended the Gateway process: every tenant's session, every supervised job, one
window at a time.

Nothing in the repository calls `spawn` directly any more. `packages/cell/src/spawn.js`
has three doors — `safeSpawn` (listener attached at birth), `detachedSpawn` (for the
cleanups and resizes nobody waits on), `execFileSafe` (which keeps *never ran* separate
from *ran and failed*) — and a `killTree` that means the same thing on both platforms.
The four Cell backends, the marketplace pool's `fork`, the npm install and the
cloudflared tunnel all go through them, and a test greps the backends for a bare
`spawn(` so the next one is caught before it ships. Under all of that, the Gateway now
installs `uncaughtException` and `unhandledRejection` handlers that log and keep
serving: a failure inside one Sandbox may end that Sandbox's operation, never the host
process.

## It runs where its owner runs it

The Cell backends assumed `/bin/sh` because every Linux has one. The machine this
project is written on does not, and 51 of the suite's tests were red there — processes,
the pty, secrets in env, marketplace installs, agent kills, the SDK, the streaming
endpoints.

`packages/cell/src/shell.js` resolves the host's shell once, without spawning anything:
`SANDBOXOS_SHELL`, then a POSIX shell (including the one Git for Windows ships, which
keeps every recorded script in `pty.js` and `handles.js` working unchanged), then
PowerShell, then `cmd`. It knows how to spell a path for the shell it found
(`C:\Users\x` is `/c/Users/x` to a bash), builds a Windows shell's minimum environment
explicitly rather than inheriting the host's secrets, and reports at boot what it found
and what is unavailable because of what it did not. Process groups become
`taskkill /T` where there are no process groups — and, because `/T` walks the tree
downward, the wrapper shell is left alive until taskkill has read it, which is the
difference between stopping a dev server and orphaning it. npm is run through its own
`npm-cli.js` rather than through a `.cmd` shim Node refuses to execute.

**`npm test` is green on Windows: 612 passing, 0 failing.** `npm run smoke` — the OS,
the Studio, the pty, the phone fold, the gallery — runs to completion there too. The
three tests that had encoded a POSIX host now say what they need: the symlink-escape
guard plants a junction and skips with a printed reason where even that is refused, the
process-group test uses the one interpreter every host running the suite is guaranteed
to have, and the absolute-path test only asserts about the host's `/etc/hosts` where
the host has one.

## Nothing fails silently

`proc.exec` on a shell-less host used to return `{ ok: true, stdout: "", code: 1 }`.
The machine looked empty rather than broken, which is the worst thing a machine can
look. `cell.exec` now distinguishes three outcomes — it ran, it ran and failed, it
never started — and the third carries a `failure` with a code and a fix.
`proc.exec`/`list`/`signal`, `secrets.useInEnv` and `pkg.*` raise it; the Kernel
propagates any typed error code, so a caller reads `unsupported_host` and a sentence
naming the cause instead of "error". A supervised job whose shell never started says so
in its own record rather than reading as "running". `ports.scan` gained a Windows
strategy and, when no strategy can look at all, returns `unavailable` with what it
tried — a scan that found nothing and a scan that could not look are different answers.

## The door validates

`POST /:slug/mcp` with a body missing `server` reached the audit insert and answered
HTTP 500 `Provided value cannot be bound to SQLite parameter 5`. Now the route answers
400 naming the field, the Kernel refuses a shapeless call before routing it, and
`appendAudit` binds every column defensively — the audit log is written on failure
paths too, and a binding error there replaces a caller's real problem with a sentence
about our database.

## A window move costs a window move

Two things made every desktop write more expensive than the write:

- The stylesheet was linked by `doc.rev` and served `no-store`, so ten agent window
  moves were ten full downloads of identical CSS in every open tab — measured. It is
  linked by an **appearance key** now (a hash of the document's `theme` and `animation`
  branches, carried on the snapshot, on `desktop.state` and on every live event) and
  served with an ETag: a move costs nothing, a theme change costs one request.
- History was one array holding forty whole documents, rewritten on every write — 141 KB
  after a short session, and up to 40 × 512 KB by the ceilings. It is append-only files
  now (`os/history/<rev>.json` and a small index), pruned in place, with an old
  single-file history migrated the first time it is read.

And a stream that reconnects after a gap catches up: `hello` carries the current
revision, and a client holding a different one re-reads before painting.

## The banner tells the truth

It said "Phase 19" on a Phase 30 build. It now prints the build stamp, the resolved
backend, the resolved shell, and one line per missing capability naming what that
disables.

## Tests

`test/phase31.test.js` pins all of it: a child that cannot start reaches its callback
instead of the process, no backend calls `spawn` bare, the entry point installs the
floor, the shell resolves and refuses an unusable override honestly, a shell-less host
fails `exec`/`execStream`/`execInteractive` with a code and a sentence, `proc.exec`
raises rather than reporting empty output, four malformed bodies get four 400s naming
their field and none of them mentions SQLite, the appearance key survives geometry and
moves with the theme, `theme.css` answers 304, a revision costs one file, an old
history is migrated rather than lost, `hello` carries a revision the client acts on,
and `killTree` takes down what the shell started.
