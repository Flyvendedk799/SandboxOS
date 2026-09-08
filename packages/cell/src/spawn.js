// Spawning, with the one guarantee the rest of the system depends on: a child
// that cannot start must not end the host process.
//
// `child_process.spawn` reports a missing binary by emitting `'error'`
// asynchronously — after the call has already returned. A `try/catch` around it
// catches nothing, and an unhandled `'error'` event is a fatal exception in
// Node. That is exactly how opening a Terminal on a host without `/bin/sh` used
// to take down every session on the Gateway (goal.md §1). So nothing in this
// repository calls `spawn` directly any more: it calls one of these, and the
// listener is attached before the event loop can turn.

import { spawn, execFile } from "node:child_process";

/**
 * Spawn with an `'error'` listener attached at birth. The error is also stashed
 * on the child as `spawnError`, so a late caller can ask what went wrong.
 */
export function safeSpawn(bin, args = [], opts = {}, onError) {
  const child = spawn(bin, args, opts);
  child.on("error", (err) => {
    child.spawnError = err;
    try { onError?.(err); } catch { /* a failing error handler must not be fatal either */ }
  });
  return child;
}

/** Spawn something whose output and outcome nobody is waiting for (cleanup,
 *  resize, a kill that may lose a race). It must never speak up on failure. */
export function detachedSpawn(bin, args = [], opts = {}) {
  try {
    const child = safeSpawn(bin, args, { stdio: "ignore", ...opts }, () => {});
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

/** `execFile` as a promise that resolves rather than rejects, with the spawn
 *  failure kept separate from a non-zero exit — they mean different things. */
export function execFileSafe(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    const done = (err, stdout, stderr) => resolve({
      stdout: stdout ?? "", stderr: stderr ?? "",
      code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      // A string `code` (ENOENT, EACCES) means the program never ran.
      spawnError: err && typeof err.code === "string" ? err : null,
      timedOut: !!(err && err.killed && err.signal),
    });
    try {
      child = execFile(bin, args, opts, done);
      child.on("error", () => { /* the callback already receives it */ });
    } catch (err) {
      resolve({ stdout: "", stderr: "", code: 1, spawnError: err, timedOut: false });
    }
  });
}

/**
 * Kill a process and everything it started.
 *
 * POSIX: the child is spawned detached, so it leads a process group and the
 * negative pid reaches the group. Windows has no process groups in that sense —
 * `taskkill /T` walks the child tree instead, which is the same intention
 * expressed by the platform that has it.
 */
export function killTree(pid, signal = "SIGTERM", child = null) {
  if (!pid) return false;
  if (process.platform === "win32") {
    const force = signal === "SIGKILL" || signal === "SIGTERM";
    // `/T` walks the tree from this pid *down*, so the wrapper shell must still
    // be alive when taskkill reads it: killing our own child first orphans the
    // grandchild and leaves the dev server holding its port. Only if taskkill
    // itself cannot start do we fall back to killing what we can reach.
    const killer = detachedSpawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])]);
    if (!killer) { try { child?.kill(signal); } catch { /* already gone */ } return false; }
    killer.on("error", () => { try { child?.kill(signal); } catch { /* already gone */ } });
    killer.on("exit", (code) => { if (code !== 0) { try { child?.kill(signal); } catch { /* already gone */ } } });
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try { child?.kill(signal); return true; } catch { return false; }
  }
}
