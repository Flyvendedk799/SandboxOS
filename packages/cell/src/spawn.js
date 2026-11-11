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

import fs from "node:fs";
import { spawn, spawnSync, execFile } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Spawn with an `'error'` listener attached at birth. The error is also stashed
 * on the child as `spawnError`, so a late caller can ask what went wrong.
 */
export function safeSpawn(bin, args = [], opts = {}, onError) {
  let child;
  try {
    child = spawn(bin, args, opts);
  } catch (err) {
    const emitter = new EventEmitter();
    emitter.spawnError = err;
    emitter.pid = null;
    emitter.kill = () => false;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    emitter.stdin = { write() {}, end() {}, on() {} };
    emitter.on("error", (e) => {
      try { onError?.(e); } catch {}
    });
    // One report, through the listener above — and a 'close', so a caller
    // waiting for the child to end is not left waiting for one that never began.
    queueMicrotask(() => {
      emitter.emit("error", err);
      emitter.emit("close", null, null);
    });
    return emitter;
  }
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
 * On Linux, discover descendant PIDs synchronously by reading /proc/[pid]/stat.
 */
function findDescendantsProc(rootPid) {
  try {
    const entries = fs.readdirSync("/proc");
    const ppidMap = new Map();
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const childPid = parseInt(name, 10);
      try {
        const content = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const lastParen = content.lastIndexOf(")");
        if (lastParen === -1) continue;
        const rest = content.slice(lastParen + 1).trim().split(/\s+/);
        const ppid = parseInt(rest[1], 10);
        if (!Number.isNaN(ppid)) {
          let list = ppidMap.get(ppid);
          if (!list) {
            list = [];
            ppidMap.set(ppid, list);
          }
          list.push(childPid);
        }
      } catch {
        // Process might have terminated between readdir and stat read
      }
    }

    const descendants = [];
    const queue = [rootPid];
    const visited = new Set([rootPid]);
    while (queue.length > 0) {
      const parent = queue.shift();
      const children = ppidMap.get(parent) || [];
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          descendants.push(child);
          queue.push(child);
        }
      }
    }
    return descendants;
  } catch {
    return null;
  }
}

/**
 * Fallback to discover descendant PIDs using pgrep -P on macOS or when /proc is unavailable.
 */
function findDescendantsPgrep(rootPid) {
  const descendants = [];
  const queue = [rootPid];
  const visited = new Set([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift();
    try {
      const res = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8", timeout: 2000 });
      if (!res.error && res.stdout) {
        const pids = res.stdout.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
        for (const child of pids) {
          if (!visited.has(child)) {
            visited.add(child);
            descendants.push(child);
            queue.push(child);
          }
        }
      }
    } catch {
      // pgrep failed
    }
  }
  return descendants;
}

function getDescendants(rootPid) {
  if (process.platform === "linux") {
    const procDescendants = findDescendantsProc(rootPid);
    if (procDescendants !== null) return procDescendants;
  }
  return findDescendantsPgrep(rootPid);
}

/** pid → { ppid, sid } for every process this host will tell us about. */
function processTable() {
  const table = new Map();
  if (process.platform === "linux") {
    try {
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          // "pid (comm) state ppid pgrp session …" — comm may hold spaces and
          // parentheses, so the fields are counted from the last ")".
          const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
          const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          table.set(Number(name), { ppid: Number(rest[1]), sid: Number(rest[3]) });
        } catch { /* it exited while we were reading */ }
      }
      return table;
    } catch { /* no /proc after all */ }
  }
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,sess="], { encoding: "utf8", timeout: 2000 });
    for (const line of String(r.stdout ?? "").split("\n")) {
      const [pid, ppid, sid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && pid > 0) table.set(pid, { ppid, sid });
    }
  } catch { /* no ps: nothing to say */ }
  return table;
}

const ownSession = (table) => table.get(process.pid)?.sid ?? -1;
const foreignSession = (sid, own) => Number.isInteger(sid) && sid > 1 && sid !== own && sid !== process.pid;

/**
 * The sessions (setsid) a process and its descendants live in, never our own.
 *
 * A pty is a session of its own, and a job the shell disowned stays in that
 * session after the shell is gone — reparented to init, in a process group of
 * its own, so neither the tree nor the group still leads to it. The session id
 * is the one thing about it that does not change, which is why it is recorded
 * while the shell is alive and used once it is not.
 */
export function sessionIdsOf(rootPid) {
  const out = new Set();
  if (process.platform === "win32" || !Number.isInteger(rootPid) || rootPid <= 1) return out;
  const table = processTable();
  const own = ownSession(table);
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    const sid = table.get(p)?.sid;
    if (foreignSession(sid, own)) out.add(sid);
    for (const [pid, info] of table) {
      if (info.ppid === p && !seen.has(pid)) { seen.add(pid); queue.push(pid); }
    }
  }
  return out;
}

/** End every process still living in one of `sids`. Never our own session. */
export function killSessions(sids, signal = "SIGKILL") {
  if (process.platform === "win32" || !sids?.size) return 0;
  const table = processTable();
  const own = ownSession(table);
  let n = 0;
  for (const [pid, info] of table) {
    if (pid <= 1 || pid === process.pid) continue;
    if (!foreignSession(info.sid, own) || !sids.has(info.sid)) continue;
    try { process.kill(pid, signal); n++; } catch { /* already gone */ }
  }
  return n;
}

/**
 * Kill a process and everything it started.
 *
 * POSIX: traverses all descendant processes (via /proc scan or pgrep fallback),
 * signaling each descendant process group and process bottom-up, followed by the
 * root process and its group.
 * Windows: `taskkill /T` walks the child tree synchronously.
 */
export function killTree(pid, signal = "SIGTERM", child = null) {
  if (!pid) return false;
  const numPid = typeof pid === "number" ? pid : parseInt(String(pid), 10);
  if (!Number.isInteger(numPid) || numPid <= 1) return false;

  if (process.platform === "win32") {
    const force = signal === "SIGKILL" || signal === "SIGTERM";
    // `/T` walks the tree from this pid *down*, so the wrapper shell must still
    // be alive when taskkill reads it: killing our own child first orphans the
    // grandchild and leaves the dev server holding its port.
    //
    // And it runs *synchronously*. An asynchronous taskkill is a promise that
    // something will be killed shortly, which is not what a caller shutting the
    // host down is asking for: the Gateway's exit path, a test's teardown and a
    // `proc.stop` all mean "it is stopped when this returns". Handing the kill
    // to a detached process and then exiting left dev servers holding their
    // ports until the machine rebooted. It costs tens of milliseconds on a path
    // that is already ending something.
    const r = spawnSync("taskkill", ["/PID", String(numPid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore", timeout: 5000, windowsHide: true,
    });
    // taskkill could not run at all, or refused: fall back to what we can reach
    // ourselves, which at least ends our own child.
    if (r.error || r.status !== 0) { try { child?.kill(signal); } catch { /* already gone */ } return !r.error; }
    return true;
  }

  // POSIX: collect all descendant PIDs before signaling
  const descendants = getDescendants(numPid);

  // In reverse/bottom-up order, send the kill signal to both each descendant's
  // process group and the descendant process itself.
  for (let i = descendants.length - 1; i >= 0; i--) {
    const d = descendants[i];
    try { process.kill(-d, signal); } catch {}
    try { process.kill(d, signal); } catch {}
  }

  // Then kill -pid and pid, and handle child?.kill(signal)
  try { process.kill(-numPid, signal); } catch {}
  try { process.kill(numPid, signal); } catch {}
  try { child?.kill(signal); } catch {}

  return true;
}
