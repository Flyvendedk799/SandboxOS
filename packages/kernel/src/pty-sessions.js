// Terminal sessions — a shell that outlives the window it was opened in.
//
// A pty used to belong to a WebSocket: close the tab and the shell died, so
// "close this window" and "kill my build" were the same gesture, and reopening
// the Terminal gave you a stranger (goal.md T1.8). A session lives here instead:
// the Cell holds the process, this module holds the scrollback and the list of
// people watching, and a socket is just one of them arriving and leaving.
//
// Sessions are host-process state, deliberately. They are children of the
// Gateway (like supervised processes in `proc`), they are keyed by Sandbox, and
// they end when the Sandbox hibernates or the host shuts down — which is exactly
// what a shell's lifetime should be.

import { rid } from "../../os/src/schema.js";

/** How much output a detached session keeps, so reattaching shows the work. */
const SCROLLBACK_BYTES = 256 * 1024;

/** How long a session with nobody watching stays alive. */
const IDLE_MS = 6 * 60 * 60 * 1000;

const _sessions = new Map(); // sandboxId -> Map(id -> session)

function tableFor(sandboxId) {
  let t = _sessions.get(sandboxId);
  if (!t) { t = new Map(); _sessions.set(sandboxId, t); }
  return t;
}

/** What a caller may know about a session: never the handle, never the bytes. */
export function sessionView(s) {
  return {
    id: s.id,
    name: s.name,
    cols: s.cols,
    rows: s.rows,
    alive: s.alive,
    attached: s.subscribers.size,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    bytes: s.bytes,
    exitedAt: s.exitedAt ?? null,
  };
}

export function listSessions(sandboxId) {
  return [...tableFor(sandboxId).values()].map(sessionView);
}

export function getSession(sandboxId, idOrName) {
  const table = tableFor(sandboxId);
  return table.get(idOrName) ?? [...table.values()].find((s) => s.name === idOrName) ?? null;
}

/**
 * Attach to a session, creating it if it does not exist yet.
 *
 * `onData` receives the scrollback first — that is the whole point of a session:
 * you come back to the work, not to a fresh prompt. The returned handle detaches
 * (leaving the shell running) rather than killing anything.
 */
export function attachSession(cell, sandboxId, { id = null, name = null, cols = 80, rows = 24 } = {}, onData, onClose) {
  let s = id || name ? getSession(sandboxId, id ?? name) : null;

  if (s && !s.alive) { tableFor(sandboxId).delete(s.id); s = null; }
  if (!s) s = createSession(cell, sandboxId, { name, cols, rows });

  const sub = { onData, onClose };
  s.subscribers.add(sub);
  s.lastAt = Date.now();
  // The backlog, then live output. A new session has no backlog and simply starts.
  if (s.scrollback.length) queueMicrotask(() => { try { onData(Buffer.concat(s.scrollback)); } catch { /* the viewer left */ } });

  return {
    session: s,
    id: s.id,
    name: s.name,
    // A shell takes a moment to exist on some backends; keystrokes typed into the
    // gap are held rather than dropped, because "I typed it and nothing happened"
    // is indistinguishable from a broken terminal.
    write(data) {
      s.lastAt = Date.now();
      if (s.handle) s.handle.write?.(data); else s.pending.push(data);
    },
    resize(c, r) {
      s.cols = c; s.rows = r; s.lastAt = Date.now();
      s.handle?.resize?.(c, r);
    },
    /** Leave, and let the shell keep working. */
    detach() { s.subscribers.delete(sub); s.lastAt = Date.now(); },
    /** End the shell, for everyone. Closing a window is not this. */
    kill() { killSession(sandboxId, s.id); },
  };
}

function createSession(cell, sandboxId, { name, cols, rows }) {
  const table = tableFor(sandboxId);
  const id = rid("pty");
  const s = {
    id,
    name: String(name || `shell ${table.size + 1}`).slice(0, 48),
    cols, rows,
    alive: true,
    startedAt: Date.now(),
    lastAt: Date.now(),
    bytes: 0,
    scrollback: [],
    subscribers: new Set(),
    handle: null,
    pending: [],   // keystrokes typed before the shell existed
  };
  table.set(id, s);

  const fan = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    s.bytes += buf.length;
    s.scrollback.push(buf);
    // Bounded: a session that has printed a gigabyte keeps the last screenfuls.
    let held = s.scrollback.reduce((n, b) => n + b.length, 0);
    while (held > SCROLLBACK_BYTES && s.scrollback.length > 1) held -= s.scrollback.shift().length;
    for (const sub of s.subscribers) { try { sub.onData(buf); } catch { s.subscribers.delete(sub); } }
  };

  const done = () => {
    if (!s.alive) return;
    s.alive = false;
    s.exitedAt = Date.now();
    for (const sub of [...s.subscribers]) { try { sub.onClose(); } catch { /* gone */ } }
    s.subscribers.clear();
  };

  // execInteractive is sync on the local backend and async on the others.
  const started = cell.execInteractive(fan, done, { cols, rows });
  Promise.resolve(started).then((handle) => {
    s.handle = handle;
    // Killed before it finished starting: a shell asked to die during its own
    // birth used to survive it, holding a Cell process nobody could see.
    if (!s.alive) { try { handle.kill(); } catch { /* already gone */ } return; }
    for (const data of s.pending.splice(0)) { try { handle.write(data); } catch { /* the shell died first */ } }
  }).catch((err) => {
    fan(`\r\n\x1b[31msandboxos:\x1b[0m ${err?.message ?? "the shell could not start"}\r\n`);
    done();
  });
  return s;
}

export function killSession(sandboxId, id) {
  const s = getSession(sandboxId, id);
  if (!s) return false;
  try { s.handle?.kill?.(); } catch { /* already gone */ }
  s.alive = false;
  s.exitedAt = s.exitedAt ?? Date.now();
  for (const sub of [...s.subscribers]) { try { sub.onClose(); } catch { /* gone */ } }
  s.subscribers.clear();
  tableFor(sandboxId).delete(s.id);
  return true;
}

/** Rename a session, so "build" and "logs" are findable a day later. */
export function renameSession(sandboxId, id, name) {
  const s = getSession(sandboxId, id);
  if (!s) return null;
  s.name = String(name ?? "").slice(0, 48) || s.name;
  return sessionView(s);
}

/** End every session for a Sandbox (hibernate, delete). Returns how many. */
export function killAllSessions(sandboxId) {
  const table = _sessions.get(sandboxId);
  if (!table) return 0;
  let n = 0;
  for (const id of [...table.keys()]) { if (killSession(sandboxId, id)) n += 1; }
  _sessions.delete(sandboxId);
  return n;
}

/** End every session on this host — the Gateway's shutdown path. */
export function killAllSessionsEverywhere() {
  let n = 0;
  for (const sandboxId of [..._sessions.keys()]) n += killAllSessions(sandboxId);
  return n;
}

/** Reap sessions nobody has watched for a long time. Called from the scheduler. */
export function reapIdleSessions(now = Date.now()) {
  let n = 0;
  for (const [sandboxId, table] of _sessions) {
    for (const s of [...table.values()]) {
      if (s.subscribers.size === 0 && now - s.lastAt > IDLE_MS) { killSession(sandboxId, s.id); n += 1; }
    }
  }
  return n;
}
