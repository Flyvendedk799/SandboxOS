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

/** A handle over a locally-spawned, detached child: signal the whole group. */
export function groupHandle(child) {
  return {
    pid: child.pid ?? null,
    child,
    kill(signal = "SIGTERM") {
      if (!child.pid) return false;
      try {
        // Negative pid = the process group. The child is a group leader because
        // it was spawned detached, so this reaches the shell and its children.
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // The group is already gone, or we are on a platform without groups.
        try { child.kill(signal); return true; } catch { return false; }
      }
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
export function remoteHandle(client, marker, runInCell) {
  return {
    // The locally visible pid is the client; the in-Cell pid is what we signal.
    pid: client.pid ?? null,
    marker,
    child: client,
    kill(signal = "SIGTERM") {
      // Signal inside the Cell first so the real process dies, then drop the
      // client so its streams close and `done` fires.
      Promise.resolve(runInCell(killScript(marker, signal))).catch(() => {});
      try { client.kill("SIGKILL"); } catch { /* already gone */ }
      return true;
    },
  };
}
