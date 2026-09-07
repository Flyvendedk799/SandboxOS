// palette.js — the Studio's own command palette (⌘⇧P).
//
// Spotlight (⌘K) is the OS's: apps, files, themes, windows. This one is the
// builder's: new app, define theme, publish distro, revert, go to a tab. Two
// palettes because they answer two questions — "where is that thing on my
// machine" versus "what can the Studio do" — and one list for both would bury
// each in the other's verbs.

import { h, fill, icon } from "../core.js";
import { iconName } from "./sprite.js";

/** Fuzzy subsequence score, or -1 when `q` is not a subsequence of `text`. */
export function score(text, q) {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, s = 0, streak = 0;
  for (const ch of q.toLowerCase()) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return -1;
    streak = at === ti ? streak + 1 : 0;
    const boundary = at === 0 || /[\s/._-]/.test(t[at - 1]);
    s += 10 + streak * 6 + (boundary ? 8 : 0) - Math.min(at - ti, 12);
    ti = at + 1;
  }
  return s + Math.max(0, 30 - text.length) / 3;
}

export function createStudioPalette({ actions }) {
  let backdrop = null;

  function open() {
    if (backdrop) { close(); return; }
    const input = h("input", { placeholder: "Studio action…", autofocus: true });
    const list = h("div.results");
    const all = actions();
    let rows = [];
    let cursor = 0;

    const paint = () => {
      const q = input.value.trim();
      rows = (q ? all.map((a) => ({ a, s: score(`${a.name} ${a.sub ?? ""}`, q) })).filter((x) => x.s >= 0).sort((x, y) => y.s - x.s).map((x) => x.a) : all).slice(0, 12);
      cursor = Math.min(cursor, Math.max(0, rows.length - 1));
      fill(list, ...(rows.length ? rows.map((r, i) => h("button.spot-row", {
        class: i === cursor ? "on" : "",
        onclick: () => { close(); r.run(); },
      }, h("span", { style: { color: "var(--stx-accent)", display: "flex" } }, icon(iconName(r.icon ?? "apps"), 15)),
        h("span.nm", r.name), h("span.sub", r.sub ?? "")))
        : [h("div.dim", { style: { padding: "12px", fontSize: "11.5px" } }, "Nothing matches.")]));
    };
    input.addEventListener("input", () => { cursor = 0; paint(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(rows.length - 1, cursor + 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); const r = rows[cursor]; close(); r?.run(); }
      else if (e.key === "Escape") close();
    });
    backdrop = h("div.backdrop.center.stx-palette", { onmousedown: (e) => { if (e.target === backdrop) close(); } },
      h("div.os-panel.os-spotlight.studio", { onmousedown: (e) => e.stopPropagation() },
        h("div.search", null, h("span", { style: { color: "var(--stx-text-3)", display: "flex" } }, icon("apps", 16)), input),
        list));
    document.getElementById("overlays").append(backdrop);
    document.addEventListener("keydown", onDocKey, true);
    paint();
    input.focus();
    setTimeout(() => input.focus(), 0);
  }

  function onDocKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }

  function close() {
    document.removeEventListener("keydown", onDocKey, true);
    backdrop?.remove();
    backdrop = null;
  }

  return { open, close };
}
