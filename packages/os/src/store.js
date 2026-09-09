// The OS store — where a machine's desktop actually lives, and how it announces
// that it changed.
//
// Three properties matter here and nothing else does:
//
//   1. Every write is normalized, so the renderer never meets a malformed doc.
//   2. Every write bumps `rev` and is announced on a bus, so a second browser
//      tab, a phone, and an agent all converge without polling.
//   3. Every write leaves the previous version behind, so "the agent restyled my
//      desktop and I hate it" costs one call, not an afternoon.
//
// The document sits beside the Cell volume (not inside it) for the same reason
// bundles do: what renders the trusted desktop must not be rewritable by a stray
// process inside the sandbox. Changing it is an audited `desktop.*` MCP call.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { normalizeDoc, LIMITS } from "./schema.js";
import { themeKey } from "./themes.js";
import { firstRunDoc } from "./distro.js";
import { osDir } from "./bundles.js";

export const osPath = (sandbox) => path.join(osDir(sandbox), "os.json");
export const historyPath = (sandbox) => path.join(osDir(sandbox), "history.json");

// ---- live bus --------------------------------------------------------------

const _buses = new Map(); // sandboxId -> EventEmitter

/** The per-Sandbox event bus. Emits 'change' with {op, rev, doc} on every write. */
export function osEvents(sandboxId) {
  let bus = _buses.get(sandboxId);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(0);
    _buses.set(sandboxId, bus);
  }
  return bus;
}

/** For tests and sandbox deletion: forget a Sandbox's bus and cached document. */
export function forgetOs(sandboxId) {
  _buses.delete(sandboxId);
  _cache.delete(sandboxId);
}

// ---- read / write ----------------------------------------------------------

const _cache = new Map(); // sandboxId -> {mtimeMs, doc}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Load a Sandbox's OS document, seeding a first-run desktop if it has none.
 * Cached against the file's mtime so the hot path (every SSE reconnect, every
 * window drag) is not a JSON parse.
 */
export function loadOs(sandbox) {
  const file = osPath(sandbox);
  let st = null;
  try { st = fs.statSync(file); } catch { /* first run */ }

  if (st) {
    const hit = _cache.get(sandbox.id);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.doc;
    const raw = readJson(file);
    if (raw) {
      const doc = normalizeDoc(raw, { name: sandbox.name });
      _cache.set(sandbox.id, { mtimeMs: st.mtimeMs, doc });
      return doc;
    }
  }

  const seeded = firstRunDoc(sandbox.name ?? "my-os");
  return writeDoc(sandbox, seeded, { op: "seed", label: "first run" });
}

/** Write a document, bumping the revision and announcing the change. */
function writeDoc(sandbox, doc, { op = "set", label = null, keepRev = false } = {}) {
  const prior = _cache.get(sandbox.id)?.doc ?? readJson(osPath(sandbox));
  const next = normalizeDoc(doc, { name: sandbox.name });
  next.rev = keepRev ? next.rev : (Number(prior?.rev ?? 0) + 1);
  next.updatedAt = Date.now();

  const json = JSON.stringify(next);
  if (json.length > LIMITS.docBytes) {
    throw new Error(`OS document too large: ${json.length} bytes (max ${LIMITS.docBytes})`);
  }

  if (prior && op !== "seed") pushHistory(sandbox, prior, label ?? op);
  writeJsonAtomic(osPath(sandbox), next);
  try { _cache.set(sandbox.id, { mtimeMs: fs.statSync(osPath(sandbox)).mtimeMs, doc: next }); }
  catch { _cache.delete(sandbox.id); }

  osEvents(sandbox.id).emit("change", { op, rev: next.rev, at: next.updatedAt, themeKey: themeKey(next), doc: next });
  return next;
}

/**
 * The single write path. `fn` receives a deep copy of the current document and
 * either mutates it or returns a replacement; the result is normalized, revved,
 * persisted and announced. `expectRev` makes the write conditional, which is how
 * two editors (you and your agent) avoid silently clobbering each other.
 */
export function mutateOs(sandbox, fn, { op = "patch", label = null, expectRev = null } = {}) {
  const current = loadOs(sandbox);
  if (expectRev != null && Number(expectRev) !== current.rev) {
    const err = new Error(`stale write: document is at rev ${current.rev}, not ${expectRev}`);
    err.code = "stale_rev";
    err.rev = current.rev;
    throw err;
  }
  const draft = structuredClone(current);
  const returned = fn(draft);
  return writeDoc(sandbox, returned ?? draft, { op, label });
}

/** Replace the whole document (validated). Used by set/import/fork. */
export function saveOs(sandbox, doc, opts = {}) {
  return mutateOs(sandbox, () => doc, { op: "set", ...opts });
}

/**
 * Throw the desktop away and start again from the first-run seed.
 *
 * `setup` survives it. Whether this machine has been through first run is a fact
 * about the machine, not part of the desktop: someone clearing their windows and
 * their theme is not a new user, and greeting them with the welcome screen again
 * would be answering a question they did not ask.
 */
export function resetOs(sandbox, { name } = {}) {
  const prior = loadOs(sandbox);
  const fresh = firstRunDoc(name ?? sandbox.name ?? "my-os");
  if (prior?.setup?.done) fresh.setup = { ...prior.setup };
  return writeDoc(sandbox, fresh, { op: "reset", label: "reset" });
}

// ---- history ---------------------------------------------------------------

// History used to be one array holding forty whole documents, rewritten on every
// write — so dragging a window wrote the last forty desktops back to disk, and
// the file was already 141 KB after a short session (goal.md T0.5). It is now an
// append-only set of revision files with a small index: one document written per
// revision, and a line appended to a list of names, times and labels.

const historyDir = (sandbox) => path.join(osDir(sandbox), "history");
const historyIndexPath = (sandbox) => path.join(historyDir(sandbox), "index.json");
const revPath = (sandbox, rev) => path.join(historyDir(sandbox), `${Number(rev)}.json`);

/** Fold a pre-existing single-file history into the new shape, once. */
function migrateHistory(sandbox) {
  const legacy = readJson(historyPath(sandbox));
  if (!Array.isArray(legacy)) return null;
  const index = [];
  for (const e of legacy) {
    const rev = Number(e?.rev ?? 0);
    if (!e?.doc) continue;
    try { writeJsonAtomic(revPath(sandbox, rev), e.doc); index.push({ rev, ts: e.ts ?? Date.now(), label: e.label ?? "" }); }
    catch { /* one unreadable revision must not cost the rest */ }
  }
  writeJsonAtomic(historyIndexPath(sandbox), index);
  try { fs.rmSync(historyPath(sandbox), { force: true }); } catch { /* it can stay */ }
  return index;
}

/** The index, migrating an old history file the first time we meet one. */
function historyIndex(sandbox) {
  const index = readJson(historyIndexPath(sandbox));
  if (Array.isArray(index)) return index;
  return migrateHistory(sandbox) ?? [];
}

function pushHistory(sandbox, doc, label) {
  try {
    const index = historyIndex(sandbox);
    const rev = Number(doc.rev ?? 0);
    writeJsonAtomic(revPath(sandbox, rev), doc);
    index.push({ rev, ts: Date.now(), label: String(label ?? "").slice(0, 80) });
    while (index.length > LIMITS.history) {
      const gone = index.shift();
      try { fs.rmSync(revPath(sandbox, gone.rev), { force: true }); } catch { /* already gone */ }
    }
    writeJsonAtomic(historyIndexPath(sandbox), index);
  } catch { /* history is a convenience, never a blocker */ }
}

/** The revisions available to revert to, newest first (documents omitted). */
export function osHistory(sandbox) {
  return historyIndex(sandbox).map((e) => ({ rev: e.rev, ts: e.ts, label: e.label })).reverse();
}

/** One stored revision, document included, or null. */
export function osHistoryEntry(sandbox, rev) {
  const entry = historyIndex(sandbox).find((e) => Number(e.rev) === Number(rev));
  if (!entry) return null;
  const doc = readJson(revPath(sandbox, entry.rev));
  return doc ? { ...entry, doc } : null;
}

/**
 * The parts of the document an undo can be aimed at. Everything here is a
 * top-level section that means something on its own: taking back an alignment
 * should not take back the widget somebody added afterwards.
 */
export const REVERT_SCOPES = Object.freeze([
  "windows", "widgets", "workspaces", "theme", "animation", "wm", "shell",
  "apps", "widgetKinds", "notifications",
]);

/**
 * Restore a previous revision. The restore is itself a new revision — history
 * moves forward, so an undo can always be undone.
 *
 * With `only`, it restores just those sections and leaves the rest of the
 * document as it is now. That is what makes "undo the alignment, keep the
 * widget" a thing you can actually do: an agent's change is several revisions,
 * and being able to take back one of them without losing the others is the
 * difference between history you can use and history you can only rewind.
 */
export function revertOs(sandbox, rev, { only = null } = {}) {
  const entry = osHistoryEntry(sandbox, rev);
  if (!entry) throw new Error(`no such revision: ${rev}`);
  if (!only?.length) return writeDoc(sandbox, entry.doc, { op: "revert", label: `revert to rev ${rev}` });

  const scopes = [...new Set(only.map(String))];
  const unknown = scopes.filter((k) => !REVERT_SCOPES.includes(k));
  if (unknown.length) throw new Error(`cannot revert '${unknown.join("', '")}' — try ${REVERT_SCOPES.join(", ")}`);
  const current = loadOs(sandbox);
  const merged = { ...current };
  for (const k of scopes) merged[k] = entry.doc[k];
  // zTop follows the windows: restoring old geometry with a stale stacking
  // counter would let the next opened window land underneath one of them.
  if (scopes.includes("windows")) merged.zTop = Math.max(current.zTop ?? 0, entry.doc.zTop ?? 0);
  return writeDoc(sandbox, merged, { op: "revert", label: `revert ${scopes.join(", ")} to rev ${rev}` });
}

// ---- checkpoints -----------------------------------------------------------
//
// History answers "what did I just do"; a checkpoint answers "take me back to
// the desktop I liked". It is a named copy of the whole document, kept outside
// the forty-revision window so it cannot be pruned away, and the document holds
// only the index (goal.md T2.4).

const checkpointDir = (sandbox) => path.join(osDir(sandbox), "checkpoints");
const checkpointPath = (sandbox, id) => path.join(checkpointDir(sandbox), `${id}.json`);

/** Store the document under a checkpoint id. Returns false if it cannot. */
export function writeCheckpoint(sandbox, id, doc) {
  try { writeJsonAtomic(checkpointPath(sandbox, id), doc); return true; }
  catch { return false; }
}

export function readCheckpoint(sandbox, id) {
  return readJson(checkpointPath(sandbox, id));
}

export function removeCheckpoint(sandbox, id) {
  try { fs.rmSync(checkpointPath(sandbox, id), { force: true }); return true; }
  catch { return false; }
}

/** Restore a checkpoint as a new revision: going back is itself undoable. */
export function restoreCheckpoint(sandbox, id, { label = null } = {}) {
  const doc = readCheckpoint(sandbox, id);
  if (!doc) throw new Error(`no such checkpoint: ${id}`);
  const current = loadOs(sandbox);
  // The index travels with the current document, not with the snapshot:
  // restoring a state from last week must not delete the checkpoints made
  // since, or the way back would disappear behind you.
  return writeDoc(sandbox, { ...doc, checkpoints: current.checkpoints }, { op: "checkpointRestore", label: label ?? `restore ${id}` });
}

/** Delete everything the OS owns for a Sandbox: document, history and every
 *  custom app's source. Called when the Sandbox itself is deleted — bundles can
 *  run to megabytes, and a deleted machine should not leave its desktop behind. */
export function destroyOs(sandbox) {
  forgetOs(sandbox.id);
  try { fs.rmSync(osDir(sandbox), { recursive: true, force: true }); return true; }
  catch { return false; }
}

/** Announce something that is not a document change (a notification arriving,
 *  an app bundle being edited) on the same channel the desktop already listens to. */
export function announce(sandboxId, op, detail = {}) {
  osEvents(sandboxId).emit("change", { op, at: Date.now(), ...detail });
}
