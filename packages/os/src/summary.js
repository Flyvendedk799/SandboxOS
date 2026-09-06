// summary.js — the desktop as something other than pixels.
//
// Two renderers that are not a browser tab: a compact textual map an agent can
// hold in context ("workspace 1: Terminal left 60%, Files and Notes stacked
// right; theme aurora; rev 41"), and a silhouette — an SVG of window and widget
// shapes drawn from the document, never from what is inside them. The map is
// what the assistant reads before it touches `desktop.*`; the silhouette is what
// the distro gallery shows. Neither knows a pixel of the user's content.
//
// No Node imports: this file is served to the browser as well.

import { describeTree } from "./layout.js";

const short = (s, n = 24) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * A compact, LLM-sized map of a document. `snap` (the desktop.get shape) adds
 * app names and the resolved theme when available; the document alone is fine.
 */
export function summarizeDoc(doc, snap = null) {
  if (!doc) return "no desktop";
  const appName = (id) => snap?.apps?.find((a) => a.id === id)?.name ?? id;
  const theme = snap?.theme?.name ?? doc.theme?.base;
  const lines = [];
  lines.push(`${doc.name} · rev ${doc.rev} · theme ${theme}${Object.keys(doc.theme?.tokens ?? {}).length ? " (overrides)" : ""} · motion ${doc.animation?.preset} · ${doc.wm?.mode} wm, gap ${doc.wm?.gap}`);
  lines.push(`dock ${doc.shell?.dock?.position}${doc.shell?.dock?.visible ? "" : " hidden"}: ${(doc.shell?.dock?.pinned ?? []).join(", ") || "empty"}`);
  for (const ws of doc.workspaces ?? []) {
    const wins = (doc.windows ?? []).filter((w) => w.ws === ws.n).sort((a, b) => b.z - a.z);
    const widgets = (doc.widgets ?? []).filter((g) => g.ws === ws.n);
    const active = ws.n === doc.activeWorkspace ? " (active)" : "";
    lines.push(`workspace ${ws.n} "${ws.name}"${active}: ${wins.length} windows, ${widgets.length} widgets`);
    for (const w of wins) {
      const flags = [w.min ? "min" : null, w.max ? "max" : null].filter(Boolean).join(",");
      lines.push(`  ${w.id} ${appName(w.app)} "${short(w.title)}" @${w.x},${w.y} ${w.w}×${w.h}${flags ? ` [${flags}]` : ""}`);
    }
    if (doc.wm?.mode === "tiling" && ws.layout) {
      const names = Object.fromEntries(wins.map((w) => [w.id, short(w.title, 14)]));
      lines.push(`  tiles: ${describeTree(ws.layout, names)}`);
    }
    for (const g of widgets) lines.push(`  ${g.id} widget ${g.kind} @${g.x},${g.y} ${g.w}×${g.h}${g.pin !== "none" ? ` pinned ${g.pin}` : ""}`);
  }
  const custom = Object.values(doc.apps ?? {});
  if (custom.length) {
    lines.push(`custom apps: ${custom.map((a) => `${a.id} (${a.kind}${a.mcp ? `, tools as ${a.mcp.name}${a.mcp.enabled ? "" : " [disabled]"}` : ""})`).join("; ")}`);
  }
  const kinds = Object.keys(doc.widgetKinds ?? {});
  if (kinds.length) lines.push(`custom widgets: ${kinds.join(", ")}`);
  const unread = (doc.notifications ?? []).filter((n) => !n.read).length;
  if (unread) lines.push(`${unread} unread notifications`);
  if (doc.distro?.name) lines.push(`forked from ${doc.distro.name}`);
  return lines.join("\n");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeColor = (v, dflt) => (typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i.test(v.trim()) ? v.trim() : dflt);

/**
 * A silhouette of a desktop: rounded rectangles for windows and widgets on the
 * active workspace, the dock as a bar, the theme as fill and accent. The input
 * is a preview record (what `distroPublish` stores) or a whole document.
 * @returns {string} an SVG document, self-contained, safe to inline
 */
export function silhouetteSvg(input, { width = 320, height = 200, viewport = { w: 1280, h: 800 } } = {}) {
  const p = input?.windows && input?.theme ? input : previewFromDoc(input);
  const bg = safeColor(p.theme?.bg0, "#0b0f14");
  const panel = safeColor(p.theme?.bg1, "#141a22");
  const accent = safeColor(p.theme?.accent, "#35d6c4");
  const sx = width / viewport.w, sy = height / viewport.h;
  const rect = (x, y, w, h, fill, r = 3, extra = "") =>
    `<rect x="${(x * sx).toFixed(1)}" y="${(y * sy).toFixed(1)}" width="${Math.max(2, w * sx).toFixed(1)}" height="${Math.max(2, h * sy).toFixed(1)}" rx="${r}" fill="${fill}" ${extra}/>`;
  const wins = (p.windows ?? []).map((w) =>
    rect(w.x, w.y, w.w, w.h, panel, 3, `stroke="${accent}" stroke-opacity=".5"`) + rect(w.x, w.y, w.w, 28, accent, 3, 'opacity=".28"'));
  const widgets = (p.widgets ?? []).map((g) => rect(g.pin === "right" ? viewport.w - g.w - 20 : g.x, g.y, g.w, g.h, panel, 5, `stroke="${accent}" stroke-opacity=".25" stroke-dasharray="3 2"`));
  const dockBar = p.dock === "hidden" ? "" : p.dock === "left" || p.dock === "right"
    ? rect(p.dock === "left" ? 14 : viewport.w - 60, viewport.h * 0.3, 46, viewport.h * 0.4, panel, 6, `stroke="${accent}" stroke-opacity=".4"`)
    : rect(viewport.w * 0.3, p.dock === "top" ? 36 : viewport.h - 60, viewport.w * 0.4, 46, panel, 6, `stroke="${accent}" stroke-opacity=".4"`);
  const menubar = rect(0, 0, viewport.w, 30, panel, 0, 'opacity=".8"');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(p.label ?? "desktop silhouette")}">`,
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    menubar, ...widgets, ...wins, dockBar,
    "</svg>",
  ].join("");
}

/** The preview record a document implies (the same shape distroPublish stores). */
export function previewFromDoc(doc) {
  if (!doc) return { theme: {}, windows: [], widgets: [], dock: "bottom" };
  const ws = doc.activeWorkspace;
  return {
    theme: { bg0: doc.theme?.tokens?.bg0, bg1: doc.theme?.tokens?.bg1, accent: doc.theme?.tokens?.accent },
    windows: (doc.windows ?? []).filter((w) => w.ws === ws && !w.min).slice(0, 12).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })),
    widgets: (doc.widgets ?? []).filter((g) => g.ws === ws).slice(0, 12).map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, pin: g.pin })),
    dock: doc.shell?.dock?.position ?? "bottom",
    label: doc.name,
  };
}
