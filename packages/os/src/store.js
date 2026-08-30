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

  osEvents(sandbox.id).emit("change", { op, rev: next.rev, at: next.updatedAt, doc: next });
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

/** Throw the desktop away and start again from the first-run seed. */
export function resetOs(sandbox, { name } = {}) {
  return writeDoc(sandbox, firstRunDoc(name ?? sandbox.name ?? "my-os"), { op: "reset", label: "reset" });
}

// ---- history ---------------------------------------------------------------

function pushHistory(sandbox, doc, label) {
  const file = historyPath(sandbox);
  const list = readJson(file) ?? [];
  list.push({ rev: Number(doc.rev ?? 0), ts: Date.now(), label: String(label ?? "").slice(0, 80), doc });
  while (list.length > LIMITS.history) list.shift();
  try { writeJsonAtomic(file, list); } catch { /* history is a convenience, never a blocker */ }
}

/** The revisions available to revert to, newest first (documents omitted). */
export function osHistory(sandbox) {
  const list = readJson(historyPath(sandbox)) ?? [];
  return list.map((e) => ({ rev: e.rev, ts: e.ts, label: e.label })).reverse();
}

/** Restore a previous revision. The restore is itself a new revision — history
 *  moves forward, so an undo can always be undone. */
export function revertOs(sandbox, rev) {
  const list = readJson(historyPath(sandbox)) ?? [];
  const entry = list.find((e) => Number(e.rev) === Number(rev));
  if (!entry) throw new Error(`no such revision: ${rev}`);
  return writeDoc(sandbox, entry.doc, { op: "revert", label: `revert to rev ${rev}` });
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
