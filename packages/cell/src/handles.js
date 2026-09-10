// Killing what you actually started.
//
// Every backend runs a command through a shell — `/bin/sh -c "npm run dev"`
// locally, `docker exec … /bin/sh -c …` in a container, `ssh … sh -c …` in a
// microVM. Killing the process Node spawned kills *that wrapper*, not the thing
// it started. The symptom is a supervised dev server that "stops" in the UI,
// keeps running, and holds its port until the host reboots.
//
// So a backend returns a handle rather than a raw ChildProcess. The handle knows
// how to reach the real process:
//
//   • local  — the child is spawned `detached`, making it a process-group leader,
//              so `kill(-pid)` takes down the shell and everything it started.
//   • remote — the in-Cell shell records its own pid before `exec`ing the command
//              (exec preserves the pid, so the recorded number *is* the command),
//              and the handle signals it from outside the Cell.
//
// Consumers only ever use `pid` and `kill(signal)`, which is all this exposes.

import crypto from "node:crypto";

import { killTree } from "./spawn.js";

/** A handle over a locally-spawned, detached child: signal the whole group.
 *  The process group on POSIX, the child tree on Windows — same intention,
 *  expressed by whichever platform is underneath (see spawn.js `killTree`). */
export function groupHandle(child) {
  return {
    pid: child.pid ?? null,
    child,
    kill(signal = "SIGTERM") {
      if (!child.pid) return false;
      return killTree(child.pid, signal, child);
    },
  };
}

/** A unique marker for one remote command's pid file. */
export const newMarker = () => `sbx-${crypto.randomUUID().slice(0, 8)}`;

/** The in-Cell path a remote command records its pid to. */
export const pidFile = (marker) => `/tmp/.${marker}.pid`;

/**
 * Wrap a command so the in-Cell shell records its pid and then becomes the
 * command. Returns the argv tail to pass after `/bin/sh -c`:
 *
 *   ["/bin/sh", "-c", <recorder script>, <the user's command>]
 *
 * The user's command arrives as `$0`, so it needs no quoting at any layer.
 */
export function recordingScript(marker) {
  return `echo $$ > ${pidFile(marker)} 2>/dev/null; exec /bin/sh -c "$0"`;
}

/** The shell one-liner that signals a recorded command, group first. */
export function killScript(marker, signal) {
  const sig = String(signal || "TERM").replace(/^SIG/, "");
  return `p=$(cat ${pidFile(marker)} 2>/dev/null); ` +
    `[ -n "$p" ] && { kill -${sig} -"$p" 2>/dev/null; kill -${sig} "$p" 2>/dev/null; }; ` +
    `rm -f ${pidFile(marker)} 2>/dev/null; true`;
}

/**
 * A handle over a command running inside a Cell we reach indirectly.
 *
 * @param {import("node:child_process").ChildProcess} client the local `docker exec` / `ssh` process
 * @param {string} marker the pid-file marker the remote shell recorded to
 * @param {(script: string) => Promise<any>} runInCell run a shell one-liner inside the Cell
 */
export function remoteHandle(client, marker, runInCell, { runInCellSync = null } = {}) {
  return {
    // The locally visible pid is the client; the in-Cell pid is what we signal.
    pid: client.pid ?? null,
    marker,
    child: client,
    kill(signal = "SIGTERM") {
      // Signal inside the Cell first so the real process dies, then drop the
      // client so its streams close and `done` fires.
      //
      // Synchronously wherever the backend can offer it. This used to be a
      // fire-and-forget promise, and on the path that matters most — the
      // Gateway's shutdown, which calls stopAllProcs and then `process.exit` —
      // the exec never left the starting line. A dev server inside a container
      // outlived every restart, holding its port, with nothing left running that
      // knew it existed: the exact orphan the shutdown path was written to
      // prevent, and the same mistake killTree made on Windows.
      //
      // This is the tidy exit, not the guarantee. A Gateway that is SIGKILLed
      // runs no handler at all, so the guarantee lives in orphans.js: a Cell
      // adopted while already running is emptied of whatever the last Gateway
      // left in it.
      const script = killScript(marker, signal);
      if (runInCellSync) {
        try { runInCellSync(script); } catch { /* the Cell may already be gone */ }
      } else {
        Promise.resolve(runInCell(script)).catch(() => {});
      }
      try { client.kill("SIGKILL"); } catch { /* already gone */ }
      return true;
    },
  };
}
