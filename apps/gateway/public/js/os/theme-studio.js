// theme-studio.js — the Theme tab as a token editor rather than a swatch row.
//
// Every `--os-*` token the compiler emits is editable here, under the same
// closed grammar the document enforces: a colour input can only ever produce a
// hex literal, the wallpaper builder can only ever produce gradients and
// colours. What you see on the stage while you drag is a local preview of the
// compiled stylesheet (the same compiler, served from packages/os); what lands
// in the document is one `desktop.themeSet` when you let go.

import { h, fill, icon, dialog, confirmDialog, toast, toastError } from "../core.js";
import { os, call, loadOs } from "./client.js";
import { THEME_TOKENS, themeCss, isWallpaper, isColor } from "./lib/themes.js";

const COLOR_TOKENS = THEME_TOKENS.filter((k) => k !== "wall" && k !== "grain");
const TOKEN_LABELS = {
  bg0: "Deepest background", bg1: "Panels and windows", bg2: "Title bars, chips", bg3: "Raised surfaces",
  line: "Hairlines", lineLoud: "Strong lines", text: "Text", text2: "Secondary text", text3: "Muted text",
  accent: "Accent", accent2: "Accent, pressed", sand: "Warm highlight", wall: "Wallpaper",
};

/** Six-digit hex for <input type=color>, from any colour the grammar allows. */
function toHex(v) {
  if (typeof v !== "string") return "#000000";
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0")).join("")}`;
  return "#000000";
}

// ── preview ──────────────────────────────────────────────────────────────────

let previewEl = null;
/** Paint a candidate theme onto this page without writing it anywhere. */
export function previewTheme(tokens) {
  const resolved = { ...os.snap.theme, ...tokens };
  if (!previewEl) { previewEl = h("style", { id: "os-theme-preview" }); document.head.append(previewEl); }
  previewEl.textContent = themeCss(resolved);
}
export function clearPreview() { previewEl?.remove(); previewEl = null; }

// ── wallpaper builder ────────────────────────────────────────────────────────

/** Parse the wallpapers this builder writes; anything else is "custom". */
function parseWall(str) {
  const m = /^linear-gradient\((\d+)deg\s*,\s*(.+)\)$/.exec(String(str ?? "").trim());
  if (!m) return null;
  const stops = m[2].split(/,(?![^(]*\))/).map((s) => s.trim()).map((s) => {
    const [c, p] = s.split(/\s+/);
    return { color: c, at: Number(String(p ?? "").replace("%", "")) || 0 };
  });
  if (!stops.every((s) => isColor(s.color))) return null;
  return { angle: Number(m[1]), stops };
}
const buildWall = ({ angle, stops }) => `linear-gradient(${angle}deg, ${stops.map((s) => `${s.color} ${s.at}%`).join(", ")})`;

function wallpaperBuilder(current, onPreview, onCommit) {
  const parsed = parseWall(current) ?? { angle: 160, stops: [{ color: toHex(os.snap.theme.bg0), at: 0 }, { color: toHex(os.snap.theme.bg2), at: 100 }] };
  const state = structuredClone(parsed);
  const box = h("div.wall-builder");
  const emit = (commit) => {
    const str = buildWall(state);
    if (!isWallpaper(str)) return;
    (commit ? onCommit : onPreview)(str);
  };
  function paint() {
    const angle = h("input", { type: "range", min: 0, max: 360, value: state.angle, title: "Angle" });
    angle.addEventListener("input", () => { state.angle = Number(angle.value); emit(false); });
    angle.addEventListener("change", () => emit(true));
    fill(box,
      h("div.wall-preview", { style: { background: buildWall(state) } }),
      h("div.field.row", null, h("label", `Angle ${state.angle}°`), angle),
      ...state.stops.map((s, i) => {
        const color = h("input", { type: "color", value: toHex(s.color) });
        const at = h("input", { type: "number", min: 0, max: 100, value: s.at, style: { width: "58px" } });
        color.addEventListener("input", () => { s.color = color.value; emit(false); });
        color.addEventListener("change", () => emit(true));
        at.addEventListener("change", () => { s.at = Math.max(0, Math.min(100, Number(at.value) || 0)); emit(true); });
        return h("div.stop-row", null, color, at, h("span.dim", "%"),
          state.stops.length > 2 ? h("button.rail-btn.sm", { title: "Remove stop", onclick: () => { state.stops.splice(i, 1); paint(); emit(true); } }, icon("x", 11)) : null);
      }),
      h("div", { style: { display: "flex", gap: "6px" } },
        state.stops.length < 6 ? h("button.ghost", { onclick: () => { state.stops.push({ color: toHex(os.snap.theme.accent), at: 50 }); state.stops.sort((a, b) => a.at - b.at); paint(); emit(true); } }, "Add stop") : null,
        h("button.ghost", { onclick: () => { onCommit(null); } }, "Use theme's own")),
    );
  }
  paint();
  return box;
}

// ── the tab ──────────────────────────────────────────────────────────────────

export function createThemeStudio() {
  const el = h("div");

  function render() {
    const t = os.snap.theme;                       // resolved: base + custom + overrides
    const overrides = os.doc.theme.tokens ?? {};
    const custom = os.doc.theme.custom ?? {};
    const wearing = os.snap.themes.find((x) => x.key === os.doc.theme.base);

    const tokenRow = (key) => {
      const value = t[key];
      const color = h("input", { type: "color", value: toHex(value), title: TOKEN_LABELS[key] });
      const text = h("input.hex", { value, spellcheck: "false" });
      const overridden = overrides[key] != null;
      let live = value;
      color.addEventListener("input", () => { live = color.value; text.value = live; previewTheme({ [key]: live }); });
      color.addEventListener("change", () => commit(key, color.value));
      text.addEventListener("change", () => {
        if (!isColor(text.value)) { toastError("Not a colour", new Error("use #rgb, #rrggbb or rgb(a)(…)")); text.value = value; return; }
        commit(key, text.value.trim());
      });
      return h("div.token-row", { class: overridden ? "overridden" : "" },
        color,
        h("div.meta", null, h("span.k", key), h("span.l", TOKEN_LABELS[key])),
        text,
        overridden ? h("button.rail-btn.sm", { title: "Back to the theme's value", onclick: () => reset(key) }, icon("refresh", 11)) : null);
    };

    async function commit(key, value) {
      clearPreview();
      try { await call("themeSet", { tokens: { [key]: value } }); }
      catch (e) { toastError("That value was rejected", e); }
    }
    async function reset(key) {
      const next = { ...overrides };
      delete next[key];
      try { await call("themeSet", { clearTokens: true, tokens: next }); }
      catch (e) { toastError("Could not reset", e); }
    }

    async function saveAs() {
      const got = await dialog({
        title: "Save as a theme",
        message: "The base you are wearing plus every override becomes a named theme in this document, forkable with the distro.",
        fields: [
          { name: "name", label: "Name", placeholder: "Deep Water" },
          { name: "key", label: "Id", placeholder: "deep-water" },
        ],
        confirmLabel: "Save theme",
      });
      if (!got?.name) return;
      const key = String(got.key || got.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const baseKey = wearing?.builtin ? wearing.key : (custom[wearing?.key]?.base ?? "midnight");
      try {
        await call("themeDefine", { key, name: got.name, base: baseKey, scheme: t.scheme, tokens: { ...(custom[wearing?.key]?.tokens ?? {}), ...overrides } });
        await call("themeSet", { theme: key, clearTokens: true });
        await loadOs();
        toast(`Saved ${got.name}`, { kind: "ok" });
      } catch (e) { toastError("Could not save the theme", e); }
    }

    function exportJson() {
      const snippet = {
        tool: "desktop.themeDefine",
        args: { key: wearing?.key ?? "custom", name: t.name, base: wearing?.builtin ? wearing.key : "midnight", scheme: t.scheme,
          tokens: Object.fromEntries(THEME_TOKENS.filter((k) => t[k] != null).map((k) => [k, t[k]])) },
      };
      const ta = h("textarea", { readonly: true, rows: 12, style: { width: "100%", fontFamily: "var(--mono)", fontSize: "10.5px" } });
      ta.value = JSON.stringify(snippet, null, 2);
      dialog({ title: "Theme as a tool call", message: "Hand this to an agent, or to sbx call desktop.themeDefine. It is the whole theme.", render: () => ta, confirmLabel: "Close" });
      setTimeout(() => { ta.select(); try { navigator.clipboard?.writeText(ta.value); } catch { /* fine */ } }, 0);
    }

    async function removeTheme(key) {
      if (!await confirmDialog(`Delete the ${custom[key]?.name ?? key} theme?`, "Anything wearing it falls back to Midnight.")) return;
      await call("themeRemove", { key });
      await loadOs();
    }

    fill(el,
      h("div.section-label", "Wearing"),
      h("div.card-grid", { style: { marginBottom: "14px" } }, ...(os.snap.themes ?? []).map((th) =>
        h("button.lib-row", {
          class: th.key === os.doc.theme.base ? "on" : "",
          style: { flexDirection: "column", alignItems: "stretch", gap: "7px", padding: "8px" },
          onclick: () => call("themeSet", { theme: th.key }),
          oncontextmenu: (e) => { e.preventDefault(); if (!th.builtin) removeTheme(th.key); },
          title: th.builtin ? th.name : `${th.name} — right-click to delete`,
        },
          h("span", { style: { height: "30px", borderRadius: "7px", background: th.wall ?? th.accent, border: "1px solid var(--stx-line)" } }),
          h("span.nm", { style: { fontSize: "11px" } }, th.name, th.builtin ? null : h("span.sub", " · yours"))))),

      h("div.section-label", "Tokens"),
      h("div.token-list", ...COLOR_TOKENS.map(tokenRow)),
      (() => {
        const grain = h("input", { type: "range", min: 0, max: 0.4, step: 0.01, value: t.grain ?? 0, title: "Grain" });
        grain.addEventListener("input", () => previewTheme({ grain: Number(grain.value) }));
        grain.addEventListener("change", () => commit("grain", Number(grain.value)));
        return h("div.field.row", { style: { marginTop: "8px" } }, h("label", `Grain ${Math.round((t.grain ?? 0) * 100)}%`), grain);
      })(),
      h("div.dim", { style: { fontSize: "10.5px", padding: "6px 4px 12px" } },
        Object.keys(overrides).length ? `${Object.keys(overrides).length} overrides on ${t.name}. Drag a swatch to preview; release to write one themeSet.` : `No overrides — you are wearing ${t.name} as designed.`),

      h("div.section-label", "Wallpaper"),
      wallpaperBuilder(t.wall,
        (str) => previewTheme({ wall: str }),
        async (str) => {
          clearPreview();
          try {
            if (str == null) { const next = { ...overrides }; delete next.wall; await call("themeSet", { clearTokens: true, tokens: next }); }
            else await call("wallpaperSet", { wallpaper: str });
          } catch (e) { toastError("That wallpaper was rejected", e); }
        }),
      h("div.field", { style: { marginTop: "10px" } }, h("label", "Or write it (gradients and colours only)"),
        (() => {
          const inp = h("input", { value: t.wall ?? "", placeholder: "radial-gradient(…), #070a0e" });
          inp.addEventListener("change", () => {
            if (!isWallpaper(inp.value)) { toastError("Not a wallpaper", new Error("no url(), no semicolons, no escapes")); return; }
            call("wallpaperSet", { wallpaper: inp.value }).catch((e) => toastError("Rejected", e));
          });
          return inp;
        })()),

      h("div", { style: { display: "flex", gap: "8px", marginTop: "14px" } },
        h("button.ghost", { style: { flex: "1" }, onclick: saveAs }, "Save as theme…"),
        h("button.ghost", { style: { flex: "1" }, onclick: exportJson }, "Export as tool call")),
      h("div.note", null,
        "A theme is thirteen tokens. Every window, dock, widget and custom app reads them from one compiled stylesheet — ",
        h("code", "/os/theme.css"), " — so this panel restyles the whole machine, and an agent can do the same with ", h("code", "desktop.themeSet"), "."),
    );
  }

  return { el, render, destroy: clearPreview };
}
