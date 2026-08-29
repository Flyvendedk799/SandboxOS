# Phase 26 — Killing What You Actually Started

A defect found by looking at the product rather than the tests.

During a final browser sweep, the port-preview step passed while the browser logged a
502. The step's assertion was too weak — it checked that an iframe pointed at
`/p/7654/`, which is true even when the proxy answers "nothing is listening". Chasing
the 502 found something worse than a weak assertion.

## What was wrong

Every Cell backend runs a command through a shell: `/bin/sh -c "npm run dev"` locally,
`docker exec … /bin/sh -c …` in a container, `ssh … sh -c …` in a microVM. The handle
returned to the Kernel was the process **Node spawned** — the wrapper. Killing it killed
the wrapper and orphaned the real work.

The symptom, reproduced by hand: start `python3 -m http.server 7788` with `proc.start`,
call `proc.stop`, watch the job flip to "stopped" in the UI — and find the server still
running, reparented to init, holding port 7788 until the host reboots. The next
`proc.start` on that port then fails with `EADDRINUSE`, and nothing in the job table
records what is holding it.

Two failure paths, both real:

- **`proc.stop`** — stopping a supervised process from the UI or the CLI did not stop it.
- **Gateway shutdown** — nothing reaped supervised processes at all, so every restart
  leaked another set of orphans.

## The fix

`packages/cell/src/handles.js` — backends now return a *handle* that knows how to reach
the real process, rather than a raw `ChildProcess`:

- **local** — the child is spawned `detached`, which makes it a process-group leader, so
  `process.kill(-pid, signal)` takes down the shell and everything it started.
- **docker / hardened-docker / firecracker** — killing `docker exec` or `ssh` locally
  never touches the process inside the Cell, so the in-Cell shell records its own pid
  and then `exec`s the command. `exec` preserves the pid, so the recorded number *is* the
  command; the handle signals it from outside with a second `docker exec` / `ssh`, group
  first, then the pid, then drops the local client so the streams close.

The command travels to the in-Cell shell as `$0`, so it needs no quoting at any layer.

`stopAllProcsEverywhere()` reaps every supervised process on the host, and the Gateway
calls it from a shutdown hook on `SIGINT`, `SIGTERM`, `SIGHUP` and `exit`, alongside the
marketplace children. It is idempotent, because a signal and `exit` can both fire.

## Tests

Two added to `test/phase20.test.js`:

- **"stopping a process kills what it started, not just the wrapping shell"** starts a
  real HTTP server through `proc.start`, waits for it to bind, calls `proc.stop`, and
  asserts the port stops answering. Reverting the `detached` change breaks it.
- **"stopAllProcsEverywhere reaps supervised processes across Sandboxes"** covers the
  shutdown path and that reaping twice is a no-op.

Verified by hand as well: start a supervised server, `kill -TERM` the Gateway, and the
process is gone and the port is free — the residual bind error is TIME_WAIT, not a
listener. Full suite: **472 passing**.

## The lesson worth keeping

The browser sweep found this, and the test suite did not, because every existing test
asserted on *bookkeeping* — the job's state field said "stopped" — and none asserted on
the world. A test that checks whether the port still answers is a different kind of test
from one that checks whether a record was updated, and this is the class of bug only the
second kind catches.
