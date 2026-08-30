// client.js — the browser's half of the OS document.
//
// One rule keeps the whole feature coherent: the client never owns the desktop.
// Every change is `desktop.<tool>` through the Kernel, and the truth comes back
// on the event stream. Which is why an agent moving your window and you dragging
// it look identical from here — same document, same revision counter, same
// render path. The only thing kept locally is the *in-flight* gesture: a drag
// paints optimistically and commits on release, so dragging costs one write
// rather than sixty.

import { api, slug } from "../core.js";

const listeners = new Set();
const emit = (kind) => { for (const fn of listeners) { try { fn(kind); } catch (e) { console.error(e); } } };

export const os = {
  snap: null,          // last full snapshot from desktop.get
  doc: null,           // snap.doc, the document itself
  connected: false,
  /** Studio-only editing affordances: selection outlines, the alignment grid. */
  design: false,
  sel: { id: null, kind: null },
};

/** Subscribe to "the OS changed". Returns an unsubscribe. */
export function onOs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── reading ─────────────────────────────────────────────────────────────────

function adopt(snapshot) {
  os.snap = snapshot;
  os.doc = snapshot.doc;
  applyThemeLink(snapshot.doc.rev);
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
  if (os.snap) { os.snap.doc = r.doc; os.doc = r.doc; applyThemeLink(r.doc.rev); emit("doc"); }
  return r.doc;
}

// ── writing ─────────────────────────────────────────────────────────────────

let wantRev = 0;
let catchup = null;

/**
 * Call a desktop tool. The result carries the new revision; if the event stream
 * has not caught us up shortly after, we pull. Belt and braces, because a desktop
 * that silently stops reflecting reality is worse than one that flickers.
 */
export async function call(tool, args = {}) {
  const r = await api.mcp("desktop", tool, args);
  if (typeof r?.rev === "number") {
    wantRev = Math.max(wantRev, r.rev);
    clearTimeout(catchup);
    catchup = setTimeout(() => { if ((os.doc?.rev ?? 0) < wantRev) refreshDoc().catch(() => {}); }, 600);
  }
  return r;
}

/** Paint a change locally without writing it. For the duration of a gesture only. */
export function localPatch(fn) {
  if (!os.doc) return;
  fn(os.doc);
  emit("local");
}

export function select(id, kind) {
  os.sel = { id: id ?? null, kind: kind ?? null };
  emit("select");
}

// ── live stream ─────────────────────────────────────────────────────────────

let source = null;

export function connect() {
  if (source) return;
  source = new EventSource(`/${slug}/os/events`);
  source.addEventListener("hello", () => { os.connected = true; emit("conn"); });
  source.onerror = () => { os.connected = false; emit("conn"); };
  source.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.doc) {
      // Ignore an event that describes a state we have already moved past —
      // out-of-order delivery must never rewind the desktop.
      if ((ev.doc.rev ?? 0) < (os.doc?.rev ?? 0)) return;
      if (os.snap) { os.snap.doc = ev.doc; os.doc = ev.doc; }
      applyThemeLink(ev.doc.rev);
      emit("doc");
      // A newly defined app or theme changes the catalogs, not just the document.
      if (["appDefine", "widgetDefine", "appRemove", "widgetKindRemove", "set", "revert", "reset"].includes(ev.op)) {
        loadOs().catch(() => {});
      }
    } else if (ev.op === "appFiles" || ev.op === "widgetFiles") {
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

let themeRev = -1;
function applyThemeLink(rev) {
  if (rev === themeRev) return;
  themeRev = rev;
  let link = document.getElementById("os-theme");
  if (!link) {
    link = document.createElement("link");
    link.id = "os-theme";
    link.rel = "stylesheet";
    document.head.append(link);
  }
  link.href = `/${slug}/os/theme.css?rev=${rev}`;
}

// ── small shared helpers ────────────────────────────────────────────────────

export const appMeta = (id) => (os.snap?.apps ?? []).find((a) => a.id === id) ?? null;
export const widgetMeta = (kind) => (os.snap?.widgetKinds ?? []).find((w) => w.kind === kind) ?? null;

export const tint = (color, a = 0.16) => {
  if (typeof color !== "string" || color[0] !== "#" || color.length < 7) return "var(--os-accent-dim)";
  const n = parseInt(color.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
