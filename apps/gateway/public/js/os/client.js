// client.js — the browser's half of the OS document.
//
// One rule keeps the whole feature coherent: the client never owns the desktop.
// Every change is `desktop.<tool>` through the Kernel, and the truth comes back
// on the event stream. Which is why an agent moving your window and you dragging
// it look identical from here — same document, same revision counter, same
// render path. The only thing kept locally is the *in-flight* gesture: a drag
// paints optimistically and commits on release, so dragging costs one write
// rather than sixty.

import { api, slug, toast } from "../core.js";

const listeners = new Set();
const emit = (kind) => { for (const fn of listeners) { try { fn(kind); } catch (e) { console.error(e); } } };

export const os = {
  snap: null,          // last full snapshot from desktop.get
  doc: null,           // snap.doc, the document itself
  connected: false,
  /** Studio-only editing affordances: selection outlines, the alignment grid. */
  design: false,
  sel: { id: null, kind: null, ids: [] },
};

/** Subscribe to "the OS changed". Returns an unsubscribe. */
export function onOs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── reading ─────────────────────────────────────────────────────────────────

function adopt(snapshot) {
  os.snap = snapshot;
  os.doc = snapshot.doc;
  applyThemeLink(snapshot.themeKey);
  emit("doc");
}

export async function loadOs() {
  const r = await api.get(`/${slug}/os/doc`);
  adopt(r);
  return r;
}

/** Re-read the document without re-reading the catalogs (cheap and frequent). */
export async function refreshDoc() {
  const r = await api.mcp("desktop", "state", {});
  if (os.snap) { os.snap.doc = r.doc; os.doc = r.doc; applyThemeLink(r.themeKey); emit("doc"); }
  return r.doc;
}

// ── writing ─────────────────────────────────────────────────────────────────

let wantRev = 0;
let catchup = null;

/** Tools whose arguments describe a *place* — where a gesture or an inspector
 *  field put something. Those commit conditionally on the revision they were
 *  painted against, so a concurrent agent edit is surfaced, not overwritten. */
const CONDITIONAL = new Set(["move", "resize", "snap", "tile", "widgetSet", "windowSet", "layoutSet", "arrange"]);

let staleToastAt = 0;

/**
 * Call a desktop tool. The result carries the new revision; if the event stream
 * has not caught us up shortly after, we pull. Belt and braces, because a desktop
 * that silently stops reflecting reality is worse than one that flickers.
 *
 * A stale write — the document moved under us — is refreshed and announced,
 * never retried blindly: last-write-wins is honest only when the loser knows.
 */
export async function call(tool, args = {}, { conditional = CONDITIONAL.has(tool) } = {}) {
  const sent = conditional && os.doc && args.expectRev === undefined ? { ...args, expectRev: os.doc.rev } : args;
  try {
    const r = await api.mcp("desktop", tool, sent);
    if (typeof r?.rev === "number") {
      wantRev = Math.max(wantRev, r.rev);
      clearTimeout(catchup);
      catchup = setTimeout(() => { if ((os.doc?.rev ?? 0) < wantRev) refreshDoc().catch(() => {}); }, 600);
    }
    return r;
  } catch (e) {
    if (e?.code === "stale_rev") {
      await refreshDoc().catch(() => {});
      if (Date.now() - staleToastAt > 1500) {
        staleToastAt = Date.now();
        toast("Desktop moved — refreshed", { body: "Someone else (or an agent) changed it first. Your last change was not applied.", kind: "", timeout: 3500 });
      }
      emit("stale");
      const err = new Error("stale");
      err.code = "stale_rev";
      err.silent = true;
      throw err;
    }
    throw e;
  }
}

/** Paint a change locally without writing it. For the duration of a gesture only. */
export function localPatch(fn) {
  if (!os.doc) return;
  fn(os.doc);
  emit("local");
}

/** Select one element, or with `add`, toggle it into a multi-selection. */
export function select(id, kind, { add = false } = {}) {
  if (add && id) {
    const ids = new Set(os.sel.ids ?? (os.sel.id ? [os.sel.id] : []));
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    const list = [...ids];
    os.sel = { id: list.at(-1) ?? null, kind: list.length === 1 ? kindOf(list[0]) : (list.length ? "multi" : null), ids: list };
  } else {
    os.sel = { id: id ?? null, kind: kind ?? null, ids: id ? [id] : [] };
  }
  emit("select");
}

export const kindOf = (id) => (os.doc?.windows.some((w) => w.id === id) ? "win" : os.doc?.widgets.some((g) => g.id === id) ? "widget" : null);

/** The selected elements as document objects (windows and widgets alike). */
export function selected() {
  const ids = os.sel.ids ?? (os.sel.id ? [os.sel.id] : []);
  return ids.map((id) => os.doc?.windows.find((w) => w.id === id) ?? os.doc?.widgets.find((g) => g.id === id)).filter(Boolean);
}

// ── live stream ─────────────────────────────────────────────────────────────

let source = null;

export function connect() {
  if (source) return;
  source = new EventSource(`/${slug}/os/events`);
  // A stream that comes back after a gap has missed every write in it. `hello`
  // says where the document is now; if that is not where we are, we pull. Without
  // this a tab that slept through three agent writes painted a desktop that no
  // longer existed, and said nothing (goal.md T0.6).
  source.addEventListener("hello", (e) => {
    os.connected = true;
    emit("conn");
    let at = null;
    try { at = JSON.parse(e.data)?.rev ?? null; } catch { /* an unreadable hello is still a hello */ }
    if (at != null && at !== (os.doc?.rev ?? null)) loadOs().catch(() => {});
  });
  source.onerror = () => { os.connected = false; emit("conn"); };
  source.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.doc) {
      // Ignore an event that describes a state we have already moved past —
      // out-of-order delivery must never rewind the desktop.
      if ((ev.doc.rev ?? 0) < (os.doc?.rev ?? 0)) return;
      if (os.snap) { os.snap.doc = ev.doc; os.doc = ev.doc; }
      applyThemeLink(ev.themeKey);
      emit("doc");
      // A newly defined app or theme changes the catalogs, not just the document.
      if (["appDefine", "widgetDefine", "appRemove", "widgetKindRemove", "set", "revert", "reset"].includes(ev.op)) {
        loadOs().catch(() => {});
      }
    } else if (ev.op === "appServers") {
      // An app's tools came or went: the catalog (not the document) changed.
      loadOs().catch(() => {});
    } else if (ev.op === "appFiles" || ev.op === "widgetFiles") {
      os.lastBundleChange = { id: ev.app ?? ev.kind ?? "", path: ev.path ?? null, at: Date.now() };
      emit("bundle:" + (ev.app ?? ev.kind ?? ""));
    }
  };
}

export function disconnect() { source?.close(); source = null; }

// ── theme delivery ──────────────────────────────────────────────────────────
//
// The theme is compiled server-side and linked, not built in the browser: the OS
// shell, the Studio preview and every custom app frame then read one stylesheet
// and can never drift from each other.

// Keyed by what the stylesheet *is*, not by the revision it arrived with: moving
// a window changes the revision and not the appearance, and re-fetching a
// stylesheet sixty times during a drag is a cost nobody asked for (goal.md T0.5).
let themeAt = null;
function applyThemeLink(key) {
  if (key == null || key === themeAt) return;
  themeAt = key;
  let link = document.getElementById("os-theme");
  if (!link) {
    link = document.createElement("link");
    link.id = "os-theme";
    link.rel = "stylesheet";
    document.head.append(link);
  }
  link.href = `/${slug}/os/theme.css?k=${encodeURIComponent(key)}`;
}

// ── small shared helpers ────────────────────────────────────────────────────

export const appMeta = (id) => (os.snap?.apps ?? []).find((a) => a.id === id) ?? null;
export const widgetMeta = (kind) => (os.snap?.widgetKinds ?? []).find((w) => w.kind === kind) ?? null;

export const tint = (color, a = 0.16) => {
  if (typeof color !== "string" || color[0] !== "#" || color.length < 7) return "var(--os-accent-dim)";
  const n = parseInt(color.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
