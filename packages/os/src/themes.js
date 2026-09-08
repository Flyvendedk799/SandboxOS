// Themes — the token sets the whole OS is painted from.
//
// A theme is nothing but a flat map of colour tokens plus a wallpaper. Every
// window, dock, widget and menu in the OS reads those tokens and nothing else,
// which is what makes "restyle the entire machine" a single write rather than a
// hunt through stylesheets. Custom themes (yours, or the agent's) live in the OS
// document under `theme.custom` and are interchangeable with these built-ins.

/** Every token a theme must define. A custom theme is completed from its base. */
export const THEME_TOKENS = [
  "bg0", "bg1", "bg2", "bg3", "line", "lineLoud",
  "text", "text2", "text3", "accent", "accent2", "sand", "wall",
  // Status: a running job, a warning and a refusal have to read on every theme,
  // so they are tokens that get contrast-checked like any other colour rather
  // than constants in a stylesheet nobody re-tunes when the palette changes.
  "ok", "warn", "err",
  // `grain` is a number 0–0.4: how much film grain the wallpaper wears. It is
  // compiled into `--os-grain` and painted from CSS gradients, never an image.
  "grain",
];

export const BUILTIN_THEMES = {
  midnight: {
    name: "Midnight", scheme: "dark",
    bg0: "#080b0f", bg1: "#0d1218", bg2: "#131a22", bg3: "#1b242e",
    line: "#1e2833", lineLoud: "#31404f",
    text: "#e6edf3", text2: "#9fb0c0", text3: "#6b7f92",
    accent: "#35d6c4", accent2: "#1fb5a6", sand: "#e8c98a",
    ok: "#43d17f", warn: "#f0b849", err: "#ff6b6b",
    wall: "radial-gradient(1100px 620px at 72% -12%, rgba(53,214,196,.16), transparent 60%), radial-gradient(800px 500px at 8% 108%, rgba(232,201,138,.10), transparent 60%), #070a0e",
    grain: 0.08,
  },
  tide: {
    name: "Tide", scheme: "dark",
    bg0: "#06121b", bg1: "#0b1d29", bg2: "#102636", bg3: "#173347",
    line: "#183246", lineLoud: "#2b5069",
    text: "#e8f4fb", text2: "#9fc0d4", text3: "#6690a8",
    accent: "#3ec8ff", accent2: "#1f9fe0", sand: "#7be3d0",
    ok: "#52d99b", warn: "#f2c14e", err: "#ff7a7a",
    wall: "radial-gradient(1000px 600px at 30% -10%, rgba(62,200,255,.20), transparent 60%), linear-gradient(160deg,#06131d,#0a2233)",
  },
  aurora: {
    name: "Aurora", scheme: "dark",
    bg0: "#0b0714", bg1: "#140d22", bg2: "#1c1330", bg3: "#271b40",
    line: "#2a1f45", lineLoud: "#463067",
    text: "#f1ecfb", text2: "#c0b0d8", text3: "#8a78a6",
    accent: "#b98cff", accent2: "#8a5cf0", sand: "#5ce0b0",
    ok: "#5ce0b0", warn: "#f5c869", err: "#ff7d9b",
    wall: "radial-gradient(900px 560px at 78% -8%, rgba(185,140,255,.24), transparent 58%), radial-gradient(760px 520px at 10% 110%, rgba(92,224,176,.16), transparent 60%), #0a0713",
    grain: 0.12,
  },
  sunset: {
    name: "Sunset", scheme: "dark",
    bg0: "#160b0d", bg1: "#22110f", bg2: "#2d1714", bg3: "#3b201b",
    line: "#3a201a", lineLoud: "#5e3327",
    text: "#fbeee8", text2: "#dcb6a6", text3: "#a97e6c",
    accent: "#ff8f5e", accent2: "#f06a3a", sand: "#ffcf7b",
    ok: "#7dd68f", warn: "#ffcf7b", err: "#ff6f6f",
    wall: "radial-gradient(1000px 600px at 74% -10%, rgba(255,143,94,.22), transparent 58%), radial-gradient(800px 520px at 6% 108%, rgba(255,207,123,.16), transparent 60%), #140a0c",
    grain: 0.1,
  },
  sand: {
    name: "Dry Sand", scheme: "light",
    bg0: "#f2efe7", bg1: "#fbfaf6", bg2: "#f1eee6", bg3: "#e7e2d6",
    line: "#ded7c8", lineLoud: "#c3b8a2",
    text: "#20262c", text2: "#5a5346", text3: "#8a806c",
    accent: "#0f9e8e", accent2: "#0b7f73", sand: "#a9761c",
    ok: "#0f7a49", warn: "#7a4f06", err: "#a81f18",
    wall: "radial-gradient(1000px 600px at 74% -10%, rgba(15,158,142,.14), transparent 58%), linear-gradient(160deg,#f7f4ec,#ece7db)",
  },
  mono: {
    name: "Graphite", scheme: "dark",
    bg0: "#101215", bg1: "#171a1e", bg2: "#1e2226", bg3: "#282d33",
    line: "#282d33", lineLoud: "#414852",
    text: "#eef1f4", text2: "#aeb6bf", text3: "#727a83",
    accent: "#e6edf3", accent2: "#aeb6bf", sand: "#c9b48c",
    ok: "#9fd8ae", warn: "#e0c07a", err: "#f08a8a",
    wall: "radial-gradient(1000px 600px at 72% -10%, rgba(230,237,243,.08), transparent 58%), linear-gradient(160deg,#0f1114,#191c20)",
  },
};

export const DEFAULT_THEME = "midnight";

// A colour token is a hex literal; `wall` is a CSS background shorthand and gets a
// wider (but still closed) grammar. Both are validated before they reach a
// stylesheet — the OS document is agent-writable, and "the agent can style it"
// must never become "the agent can inject arbitrary CSS into the parent frame".
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i;
const WALL_ALLOWED = /^[#\w\s.,()%-]+$/;
const WALL_FORBIDDEN = /url\(|expression|@import|javascript:|;|<|>|\\/i;

export const isColor = (v) => typeof v === "string" && (HEX.test(v.trim()) || RGBA.test(v.trim()));

/** A wallpaper is gradients and colours only: no url(), no semicolons, no escapes. */
export function isWallpaper(v) {
  if (typeof v !== "string" || v.length > 1200) return false;
  const s = v.trim();
  return s.length > 0 && WALL_ALLOWED.test(s) && !WALL_FORBIDDEN.test(s);
}

/** Sanitize an arbitrary token map down to the tokens we know, correctly typed. */
export function cleanTokens(input) {
  const out = {};
  for (const k of THEME_TOKENS) {
    const v = input?.[k];
    if (v == null) continue;
    if (k === "wall") { if (isWallpaper(v)) out.wall = String(v).trim(); }
    else if (k === "grain") { const n = Number(v); if (Number.isFinite(n)) out.grain = Math.min(0.4, Math.max(0, Math.round(n * 100) / 100)); }
    else if (isColor(v)) out[k] = String(v).trim();
  }
  return out;
}

/** Resolve the theme a document is currently wearing: base + custom + overrides. */
export function resolveTheme(doc) {
  const t = doc?.theme ?? {};
  const custom = t.custom?.[t.base];
  const base = BUILTIN_THEMES[t.base] ?? (custom ? { ...BUILTIN_THEMES[custom.base ?? DEFAULT_THEME], ...custom.tokens, name: custom.name, scheme: custom.scheme } : null);
  const resolved = { ...(base ?? BUILTIN_THEMES[DEFAULT_THEME]) };
  Object.assign(resolved, cleanTokens(t.tokens ?? {}));
  resolved.key = t.base ?? DEFAULT_THEME;
  return resolved;
}

/**
 * A stable identity for what `theme.css` will compile to.
 *
 * The stylesheet used to be linked by `doc.rev`, which made every window move a
 * fresh download of the same bytes in every open tab (goal.md T0.5). It depends
 * on exactly two branches of the document, so it is keyed by those: same
 * appearance, same key, same cached stylesheet — whatever the revision.
 */
export function themeKey(doc) {
  const payload = JSON.stringify([doc?.theme ?? null, doc?.animation ?? null]);
  let h = 0x811c9dc5; // FNV-1a: short, stable, and no crypto import in a hot path
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}${payload.length.toString(36)}`;
}

/** Every theme the document can switch to right now — built-in plus custom. */
export function listThemes(doc) {
  const out = Object.entries(BUILTIN_THEMES).map(([key, th]) => ({ key, name: th.name, scheme: th.scheme, builtin: true, tokens: th }));
  for (const [key, th] of Object.entries(doc?.theme?.custom ?? {})) {
    const base = BUILTIN_THEMES[th.base ?? DEFAULT_THEME] ?? BUILTIN_THEMES[DEFAULT_THEME];
    out.push({ key, name: th.name ?? key, scheme: th.scheme ?? base.scheme, builtin: false, tokens: { ...base, ...th.tokens } });
  }
  return out;
}

const rgba = (hex, a) => {
  if (!HEX.test(hex ?? "") || hex.length < 7) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * Compile a resolved theme into the CSS custom properties the OS shell reads.
 * The derived (glass, dim, track) values are computed HERE rather than in the
 * browser so the same numbers back the live desktop, a distro preview and any
 * future server-side render.
 */
export function themeCss(theme, selector = ":root") {
  const v = {
    "--os-bg-0": theme.bg0, "--os-bg-1": theme.bg1, "--os-bg-2": theme.bg2, "--os-bg-3": theme.bg3,
    "--os-line": theme.line, "--os-line-loud": theme.lineLoud,
    "--os-text": theme.text, "--os-text-2": theme.text2, "--os-text-3": theme.text3,
    "--os-accent": theme.accent, "--os-accent-2": theme.accent2, "--os-sand": theme.sand,
    "--os-ok": theme.ok, "--os-warn": theme.warn, "--os-err": theme.err,
    "--os-wall": theme.wall,
    "--os-accent-dim": rgba(theme.accent, 0.14),
    "--os-accent-line": rgba(theme.accent, 0.34),
    "--os-menubar": rgba(theme.bg1, 0.72),
    "--os-window": rgba(theme.bg1, 0.88),
    "--os-titlebar": rgba(theme.bg2, 0.7),
    "--os-widget": rgba(theme.bg1, 0.6),
    "--os-dock": rgba(theme.bg2, 0.62),
    "--os-panel": rgba(theme.bg1, 0.97),
    "--os-chip": rgba(theme.bg3, 0.7),
    "--os-track": theme.bg3,
    "--os-grain": String(Math.min(0.4, Math.max(0, Number(theme.grain) || 0))),
    "--os-scheme": theme.scheme === "light" ? "light" : "dark",
  };
  const body = Object.entries(v).map(([k, val]) => `  ${k}: ${val};`).join("\n");
  return `${selector} {\n${body}\n  color-scheme: ${theme.scheme === "light" ? "light" : "dark"};\n}\n`;
}
