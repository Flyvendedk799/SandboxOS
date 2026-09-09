// The OS document — one JSON object that IS the user's operating system.
//
// Windows, widgets, workspaces, the dock, the theme, the motion, and every app
// the machine has learnt: all of it is here. Nothing about the desktop lives in
// the browser's memory alone, which is why the same machine looks the same from
// a second tab, from a phone, and to an agent reasoning about it — and why an
// agent restyling your desktop is a document write, not a screen-scrape.
//
// This module is pure: it holds the shape, the defaults, the limits and the
// normalizer. Every write anywhere in the system goes through `normalizeDoc`,
// so a malformed or hostile document can never reach the renderer.

import crypto from "node:crypto";
import { BUILTIN_THEMES, DEFAULT_THEME, cleanTokens, isWallpaper } from "./themes.js";
import { BUILTIN_ANIMATIONS, DEFAULT_ANIMATION, cleanAnimation } from "./animations.js";
import { builtinApp, builtinWidget } from "./catalog.js";
import { reconcileTree } from "./layout.js";
// The keyboard grammar is shared with the browser (served from packages/os),
// so the shell that matches a key and the tool that validates one agree.
import { DEFAULT_KEYS, cleanKeys } from "./keys.js";

/**
 * The document's shape version.
 *
 * Still 1, deliberately (goal.md T5.4). Everything the document has gained since
 * — the keymap, do-not-disturb, proposals, checkpoints, first-run state, an app's
 * suspended flag — is *additive*, and `normalizeDoc` fills each one in from the
 * defaults when it is absent. No field changed meaning or shape, so there is no
 * migration to write and nothing a v2 would tell a reader that it does not
 * already know. A version bump whose only content is a larger number teaches
 * everyone downstream to ignore the number.
 *
 * What was missing was not a bump but the machinery a bump will need, so that is
 * what exists now: the version is *read* (see `docCompatibility`), and a document
 * from a build newer than this one is refused at the boundary where it would
 * otherwise be silently truncated — importing a distro or restoring a backup —
 * rather than quietly losing the fields this build has never heard of.
 */
export const OS_DOC_VERSION = 1;

/**
 * What this build can say about a document's shape version. `newer` means it was
 * written by a build that knows fields this one would drop.
 */
export function docCompatibility(input) {
  const raw = Number(input?.version);
  const version = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  return { version, current: OS_DOC_VERSION, newer: version > OS_DOC_VERSION, older: version < OS_DOC_VERSION };
}

/** Ceilings. Generous enough that nobody meets them by building; low enough that
 *  a runaway agent cannot turn the document into a denial-of-service payload. */
export const LIMITS = {
  workspaces: 16,
  windows: 96,
  widgets: 96,
  apps: 128,
  widgetKinds: 64,
  themes: 48,
  animations: 48,
  notifications: 60,
  // A proposal is a change waiting to be reviewed. A few at a time: they are a
  // conversation, not a queue, and they cost document bytes.
  proposals: 8,
  proposalOps: 24,
  history: 40,
  // Named states of the whole desktop. Few, on purpose: a checkpoint is a
  // place you meant to come back to, not an autosave.
  checkpoints: 12,
  nameLen: 64,
  titleLen: 120,
  docBytes: 512 * 1024,
};

export const rid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

const num = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const str = (v, max, dflt = "") => (typeof v === "string" ? v.slice(0, max) : dflt);
const bool = (v, dflt = false) => (typeof v === "boolean" ? v : dflt);
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/** Identifiers the URL router and the CSS both have to survive. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const isId = (v) => typeof v === "string" && ID_RE.test(v);

export const DOCK_POSITIONS = ["bottom", "left", "right", "top", "hidden"];

/** Who may interrupt you while do-not-disturb is on. A closed vocabulary. */
export const NOTIFY_KINDS = ["agents", "procs", "apps", "system"];

export const WM_MODES = ["floating", "tiling"];

export function defaultDoc(name = "untitled-os") {
  const ws = { id: rid("ws"), n: 1, name: "Main", wallpaper: null, layout: null };
  return {
    version: OS_DOC_VERSION,
    id: rid("os"),
    name: str(name, LIMITS.nameLen, "untitled-os"),
    rev: 0,
    updatedAt: Date.now(),
    distro: null,
    // First run: which seed was adopted, and whether the welcome screen is done
    // with. A field rather than a browser flag, because "have I set this machine
    // up" is a fact about the machine, not about the tab you happen to be in
    // (goal.md T5.1).
    setup: { done: false, seed: null, at: null },
    theme: { base: DEFAULT_THEME, tokens: {}, custom: {} },
    // reducedMotion: "auto" honours the viewer's prefers-reduced-motion setting;
    // "ignore" plays the preset regardless. A document choice, so it travels.
    animation: { preset: DEFAULT_ANIMATION, custom: {}, reducedMotion: "auto" },
    wm: { mode: "floating", gap: 12, snap: true, gridSize: 8 },
    shell: {
      menubar: { visible: true, showClock: true, showStatus: true, title: null },
      dock: {
        visible: true, position: "bottom", size: 42, autohide: false,
        pinned: ["files", "terminal", "assistant", "metrics", "settings"],
      },
      spotlight: { enabled: true },
      // Attention is the user's: `dnd` keeps notifications out of your face
      // without throwing them away, and `allow` says which kinds get through
      // even then (an agent coming back usually should).
      notifications: { enabled: true, dnd: false, allow: ["agents"] },
      // The keyboard is a document field, so it can be remapped, travel with a
      // distro, and be read back by the cheat sheet instead of hardcoded twice.
      keys: { ...DEFAULT_KEYS },
      wallpaperFit: "cover",
      // "Open with": extension → app id. An OS that opens a .png in a text editor
      // is technically correct and practically wrong, and which app wins should be
      // the user's choice rather than ours, so it lives in the document.
      associations: {
        ".md": "notes", ".txt": "notes", ".markdown": "notes",
        ".png": "media", ".jpg": "media", ".jpeg": "media",
        ".gif": "media", ".webp": "media", ".svg": "media",
      },
    },
    workspaces: [ws],
    activeWorkspace: ws.n,
    zTop: 10,
    windows: [],
    widgets: [],
    apps: {},         // custom app definitions, keyed by id
    widgetKinds: {},  // custom widget definitions, keyed by kind
    notifications: [],
    proposals: [],    // changes proposed for review (goal.md T2.3)
    checkpoints: [],  // named states of the whole desktop (goal.md T2.4)
  };
}

// ---- element normalizers ---------------------------------------------------

function normWindow(w, wsNums) {
  if (!w || typeof w !== "object") return null;
  const app = str(w.app, 64);
  if (!app) return null;
  const meta = builtinApp(app);
  const ws = num(w.ws, 1, 999, 1);
  return {
    id: isId(w.id) ? w.id : rid("w"),
    app,
    title: str(w.title, LIMITS.titleLen, meta?.name ?? app),
    x: num(w.x, -4000, 8000, 60),
    y: num(w.y, -4000, 8000, 60),
    w: num(w.w, 180, 6000, meta?.window?.w ?? 420),
    h: num(w.h, 120, 6000, meta?.window?.h ?? 280),
    z: num(w.z, 0, 1e6, 1),
    ws: wsNums.includes(ws) ? ws : wsNums[0],
    min: bool(w.min),
    max: bool(w.max),
    props: plainProps(w.props),
  };
}

function normWidget(g, wsNums) {
  if (!g || typeof g !== "object") return null;
  const kind = str(g.kind, 64);
  if (!kind) return null;
  const meta = builtinWidget(kind);
  const ws = num(g.ws, 1, 999, 1);
  return {
    id: isId(g.id) ? g.id : rid("g"),
    kind,
    x: num(g.x, -4000, 8000, 40),
    y: num(g.y, -4000, 8000, 40),
    w: num(g.w, 80, 3000, meta?.size?.w ?? 220),
    h: num(g.h, 60, 3000, meta?.size?.h ?? 140),
    ws: wsNums.includes(ws) ? ws : wsNums[0],
    pin: oneOf(g.pin, ["none", "right", "left"], "none"),
    props: plainProps(g.props),
  };
}

/** Widget/window props are free-form but must stay small, flat-ish JSON. */
export function plainProps(p) {
  if (p == null || typeof p !== "object" || Array.isArray(p)) return {};
  let json;
  try { json = JSON.stringify(p); } catch { return {}; }
  if (json.length > 8192) return {};
  return JSON.parse(json);
}

/** Capability patterns an app may request: "server.tool", "server.*" or "*". */
export const PATTERN_RE = /^(?:\*|[a-z0-9-]+\.(?:\*|[A-Za-z0-9_]+))$/;
export const cleanPatterns = (list) =>
  (Array.isArray(list) ? list : []).filter((p) => typeof p === "string" && PATTERN_RE.test(p)).slice(0, 32);

const HUE_RE = /^#[0-9a-f]{3,8}$/i;
const URL_RE = /^https?:\/\/[^\s"'<>]{1,2000}$/i;

export function normApp(a) {
  if (!a || typeof a !== "object" || !isId(a.id)) return null;
  const kind = oneOf(a.kind, ["bundle", "url", "alias"], "bundle");
  const app = {
    id: a.id,
    kind,
    name: str(a.name, LIMITS.nameLen, a.id),
    icon: str(a.icon, 40, "apps"),
    hue: typeof a.hue === "string" && HUE_RE.test(a.hue) ? a.hue : "#35d6c4",
    description: str(a.description, 300),
    permissions: cleanPatterns(a.permissions),
    // Suspended: no capability session is minted for it (goal.md T3.1). It is a
    // property of the app, so it survives a reload and travels with a distro —
    // a suspended app arriving from a stranger stays suspended.
    ...(a.suspended ? { suspended: true } : {}),
    window: {
      w: num(a.window?.w, 180, 6000, 420),
      h: num(a.window?.h, 120, 6000, 300),
      resizable: bool(a.window?.resizable, true),
      singleton: bool(a.window?.singleton, false),
    },
    createdAt: num(a.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedAt: num(a.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
  // The app's other face: tools an agent can call. Either a thin façade over
  // existing Kernel tools (`tools[].proxy`), or a companion server shipped in
  // the bundle (`entrypoint`) and hosted out of process. See ADR-0004.
  const mcp = normAppMcp(a.mcp, a.id);
  if (mcp) app.mcp = mcp;
  if (kind === "bundle") {
    app.entry = safeRelPath(a.entry) ?? "index.html";
    app.origin = oneOf(a.origin, ["store", "volume"], "store");
    if (app.origin === "volume") app.volumePath = safeRelPath(a.volumePath) ?? `apps/${a.id}`;
  } else if (kind === "url") {
    app.url = URL_RE.test(a.url ?? "") ? a.url : "";
  } else {
    app.target = str(a.target, 64);
  }
  return app;
}

/** Server names an app may not take: the core catalog, and anything an operator
 *  would confuse with it. Kept here (not in the Kernel) so a hostile document
 *  cannot even *declare* a server called `fs`. */
export const RESERVED_SERVER_NAMES = new Set([
  "fs", "proc", "cron", "net", "secrets", "pkg", "tide", "agents", "llm", "apps", "ports",
  "metrics", "desktop", "mcp-registry", "kernel", "registry", "system", "os", "sbx",
]);

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

function normAppMcp(m, appId) {
  if (!m || typeof m !== "object") return null;
  const name = isId(m.name) ? m.name : appId;
  if (RESERVED_SERVER_NAMES.has(name)) return null;
  const out = {
    name,
    enabled: bool(m.enabled, true),
    runtime: "host-sandboxed",
    tools: [],
  };
  const entry = safeRelPath(m.entrypoint);
  if (entry && /\.(m?js)$/.test(entry)) out.entrypoint = entry;
  for (const t of Array.isArray(m.tools) ? m.tools.slice(0, 32) : []) {
    if (!t || typeof t !== "object" || !TOOL_NAME_RE.test(t.name ?? "")) continue;
    const proxy = t.proxy && typeof t.proxy === "object" && PATTERN_RE.test(`${t.proxy.server}.${t.proxy.tool}`) && !String(t.proxy.tool).includes("*")
      ? { server: String(t.proxy.server), tool: String(t.proxy.tool), args: plainProps(t.proxy.args) }
      : null;
    out.tools.push({
      name: t.name,
      description: str(t.description, 300),
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? plainProps(t.inputSchema) : { type: "object", properties: {} },
      ...(proxy ? { proxy } : {}),
    });
  }
  if (!out.entrypoint && !out.tools.length) return null;
  return out;
}

export function normWidgetKind(w) {
  if (!w || typeof w !== "object" || !isId(w.kind)) return null;
  const origin = oneOf(w.origin, ["store", "volume"], "store");
  const wk = {
    kind: w.kind,
    name: str(w.name, LIMITS.nameLen, w.kind),
    icon: str(w.icon, 40, "apps"),
    description: str(w.description, 300),
    permissions: cleanPatterns(w.permissions),
    ...(w.suspended ? { suspended: true } : {}),
    entry: safeRelPath(w.entry) ?? "index.html",
    origin,
    size: { w: num(w.size?.w, 80, 3000, 220), h: num(w.size?.h, 60, 3000, 150) },
    refreshMs: num(w.refreshMs, 0, 3_600_000, 0),
    createdAt: num(w.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedAt: num(w.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
  if (origin === "volume") wk.volumePath = safeRelPath(w.volumePath) ?? `widgets/${w.kind}`;
  return wk;
}

const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

/** A bundle-relative path: no absolute roots, no traversal, no backslashes. */
export function safeRelPath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return null;
  const norm = p.replace(/^\.\//, "").trim();
  if (!norm || norm.startsWith("/") || norm.includes("..")) return null;
  if (norm.includes(String.fromCharCode(92)) || norm.includes(String.fromCharCode(0))) return null;
  if (!PATH_CHARS.test(norm)) return null;
  if (norm.split("/").some((seg) => !seg || seg === ".")) return null;
  return norm;
}

export const EXT_RE = /^\.[a-z0-9]{1,12}$/;

/** extension → app id, both validated. Anything else is dropped silently. */
export function cleanAssociations(map) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  for (const [ext, app] of Object.entries(map)) {
    const key = String(ext).toLowerCase();
    if (!EXT_RE.test(key) || !isId(app)) continue;
    if (Object.keys(out).length >= 64) break;
    out[key] = app;
  }
  return out;
}

/**
 * A proposal: a change someone (usually an agent) wants to make, held for review
 * instead of applied (goal.md T2.3).
 *
 * It is a document object rather than client-side theatre, so it survives a
 * reload, appears in a second tab, is revertible like everything else, and can be
 * applied by whoever is actually looking at it. The ops are `desktop.*` calls —
 * names only, arguments as plain data; applying one runs them through the very
 * same tools, so a proposal can never do something a caller could not.
 */
function normProposal(p) {
  if (!p || typeof p !== "object") return null;
  const ops = (Array.isArray(p.ops) ? p.ops : [])
    .slice(0, LIMITS.proposalOps)
    .map((op) => {
      const tool = str(op?.tool, 48);
      if (!/^[a-zA-Z][a-zA-Z0-9]{1,47}$/.test(tool)) return null;
      return { tool, args: plainProps(op?.args) };
    })
    .filter(Boolean);
  if (!ops.length) return null;
  return {
    id: isId(p.id) ? p.id : rid("prop"),
    label: str(p.label, LIMITS.titleLen, "proposed change"),
    by: str(p.by, 64, "agent"),
    createdAt: num(p.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    ops,
  };
}

function normNotification(n) {
  if (!n || typeof n !== "object") return null;
  // A notification may carry one place to go: an app to open (with props) and
  // optionally a window to focus. Clicking it is then a deep link, not a toast.
  const action = n.action && typeof n.action === "object"
    ? {
        app: str(n.action.app, 64) || null,
        window: isId(n.action.window) ? n.action.window : null,
        props: plainProps(n.action.props),
      }
    : null;
  return {
    id: isId(n.id) ? n.id : rid("n"),
    app: str(n.app, LIMITS.nameLen, "system"),
    // Who is talking (for do-not-disturb), and whether this one was recorded
    // without interrupting anyone.
    source: oneOf(n.source, NOTIFY_KINDS, "system"),
    ...(n.quiet ? { quiet: true } : {}),
    title: str(n.title, LIMITS.titleLen, ""),
    body: str(n.body, 600),
    kind: oneOf(n.kind, ["ok", "warn", "err", "info", "accent"], "info"),
    ts: num(n.ts, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    read: bool(n.read),
    ...(action && (action.app || action.window) ? { action } : {}),
  };
}

// ---- the whole document ----------------------------------------------------

/**
 * Take anything and return a valid OS document. Never throws: unknown fields are
 * dropped, out-of-range numbers are clamped, over-long lists are truncated. The
 * result is safe to render and safe to persist.
 */
export function normalizeDoc(input, { name } = {}) {
  const base = defaultDoc(name);
  if (!input || typeof input !== "object") return base;

  const doc = { ...base };
  doc.id = isId(input.id) ? input.id : base.id;
  doc.name = str(input.name, LIMITS.nameLen, base.name) || base.name;
  doc.rev = num(input.rev, 0, Number.MAX_SAFE_INTEGER, 0);
  doc.updatedAt = num(input.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now());
  doc.setup = input.setup && typeof input.setup === "object"
    ? {
        // bool(), like every other flag here: only a real boolean counts, so a
        // document that arrived from somewhere else cannot fake having been set up.
        done: bool(input.setup.done),
        seed: str(input.setup.seed, 64) || null,
        at: input.setup.at ? num(input.setup.at, 0, Number.MAX_SAFE_INTEGER, 0) : null,
      }
    : { done: false, seed: null, at: null };
  doc.distro = input.distro && typeof input.distro === "object"
    ? {
        id: str(input.distro.id, 64),
        name: str(input.distro.name, LIMITS.nameLen),
        forkedAt: num(input.distro.forkedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
        // Lineage: where it came from, so a machine can always say what it grew from.
        ...(input.distro.tenant ? { tenant: str(input.distro.tenant, 64) } : {}),
        ...(input.distro.visibility ? { visibility: oneOf(input.distro.visibility, ["private", "tenant", "public"], "tenant") } : {}),
      }
    : null;

  // Theme: a base key (built-in or custom), token overrides, custom definitions.
  const customThemes = {};
  for (const [key, th] of Object.entries(input.theme?.custom ?? {})) {
    if (!isId(key) || Object.keys(customThemes).length >= LIMITS.themes) continue;
    customThemes[key] = {
      name: str(th?.name, LIMITS.nameLen, key),
      base: BUILTIN_THEMES[th?.base] ? th.base : DEFAULT_THEME,
      scheme: oneOf(th?.scheme, ["dark", "light"], BUILTIN_THEMES[th?.base]?.scheme ?? "dark"),
      tokens: cleanTokens(th?.tokens ?? {}),
    };
  }
  const wantBase = input.theme?.base;
  doc.theme = {
    base: (BUILTIN_THEMES[wantBase] || customThemes[wantBase]) ? wantBase : DEFAULT_THEME,
    tokens: cleanTokens(input.theme?.tokens ?? {}),
    custom: customThemes,
  };

  // Motion.
  const customAnims = {};
  for (const [key, a] of Object.entries(input.animation?.custom ?? {})) {
    if (!isId(key) || Object.keys(customAnims).length >= LIMITS.animations) continue;
    const cleaned = cleanAnimation(a);
    if (cleaned) customAnims[key] = cleaned;
  }
  const wantAnim = input.animation?.preset;
  doc.animation = {
    preset: (BUILTIN_ANIMATIONS[wantAnim] || customAnims[wantAnim]) ? wantAnim : DEFAULT_ANIMATION,
    custom: customAnims,
    reducedMotion: oneOf(input.animation?.reducedMotion, ["auto", "ignore"], "auto"),
  };

  doc.wm = {
    mode: oneOf(input.wm?.mode, WM_MODES, "floating"),
    gap: num(input.wm?.gap, 0, 64, 12),
    snap: bool(input.wm?.snap, true),
    gridSize: num(input.wm?.gridSize, 1, 64, 8),
  };

  const pinned = (Array.isArray(input.shell?.dock?.pinned) ? input.shell.dock.pinned : base.shell.dock.pinned)
    .filter((x) => typeof x === "string" && x.length <= 64).slice(0, 24);
  doc.shell = {
    menubar: {
      visible: bool(input.shell?.menubar?.visible, true),
      showClock: bool(input.shell?.menubar?.showClock, true),
      showStatus: bool(input.shell?.menubar?.showStatus, true),
      title: input.shell?.menubar?.title == null ? null : str(input.shell.menubar.title, LIMITS.nameLen),
    },
    dock: {
      visible: bool(input.shell?.dock?.visible, true),
      position: oneOf(input.shell?.dock?.position, DOCK_POSITIONS, "bottom"),
      size: num(input.shell?.dock?.size, 28, 96, 42),
      autohide: bool(input.shell?.dock?.autohide, false),
      pinned,
    },
    spotlight: { enabled: bool(input.shell?.spotlight?.enabled, true) },
    notifications: {
      enabled: bool(input.shell?.notifications?.enabled, true),
      dnd: bool(input.shell?.notifications?.dnd, false),
      allow: (Array.isArray(input.shell?.notifications?.allow) ? input.shell.notifications.allow : ["agents"])
        .filter((k) => NOTIFY_KINDS.includes(k)).slice(0, NOTIFY_KINDS.length),
    },
    keys: cleanKeys(input.shell?.keys),
    wallpaperFit: oneOf(input.shell?.wallpaperFit, ["cover", "contain", "tile"], "cover"),
    associations: cleanAssociations(input.shell?.associations ?? base.shell.associations),
  };

  // Workspaces are numbered 1..n and renumbered densely: a hole in the numbering
  // is a source of ghost windows nobody can reach.
  const rawWs = Array.isArray(input.workspaces) ? input.workspaces.slice(0, LIMITS.workspaces) : [];
  const workspaces = rawWs.map((w, i) => ({
    id: isId(w?.id) ? w.id : rid("ws"),
    n: i + 1,
    name: str(w?.name, LIMITS.nameLen, `Workspace ${i + 1}`),
    wallpaper: isWallpaper(w?.wallpaper) ? w.wallpaper : null,
    layout: w?.layout ?? null,
  }));
  doc.workspaces = workspaces.length ? workspaces : base.workspaces;
  const wsNums = doc.workspaces.map((w) => w.n);
  const active = num(input.activeWorkspace, 1, 999, 1);
  doc.activeWorkspace = wsNums.includes(active) ? active : wsNums[0];

  doc.windows = (Array.isArray(input.windows) ? input.windows : [])
    .slice(0, LIMITS.windows).map((w) => normWindow(w, wsNums)).filter(Boolean);
  doc.widgets = (Array.isArray(input.widgets) ? input.widgets : [])
    .slice(0, LIMITS.widgets).map((g) => normWidget(g, wsNums)).filter(Boolean);
  dedupeIds(doc.windows);
  dedupeIds(doc.widgets);
  doc.zTop = Math.max(num(input.zTop, 0, 1e6, 10), ...doc.windows.map((w) => w.z), 10);

  // The tiling tree of every workspace holds exactly the windows on it: a window
  // that arrived (from `open`, a move, an old document with no tree at all) is
  // split in; one that left is pruned. So a document written before trees
  // existed tiles the same as one written today — the tree is synthesized.
  for (const ws of doc.workspaces) {
    const ids = doc.windows.filter((w) => w.ws === ws.n).map((w) => w.id);
    ws.layout = reconcileTree(ws.layout, ids);
  }

  doc.apps = {};
  for (const [id, a] of Object.entries(input.apps ?? {})) {
    if (Object.keys(doc.apps).length >= LIMITS.apps) break;
    const app = normApp({ ...a, id: a?.id ?? id });
    if (app && !builtinApp(app.id)) doc.apps[app.id] = app;
  }
  // An alias that points at itself, or round a ring of aliases, can never open.
  // Dropping it here means the dock and `open` never have to detect the loop.
  const looped = Object.values(doc.apps).filter((a) => a.kind === "alias" && !resolveAlias(doc, a.id)).map((a) => a.id);
  for (const id of looped) delete doc.apps[id];
  doc.widgetKinds = {};
  for (const [kind, w] of Object.entries(input.widgetKinds ?? {})) {
    if (Object.keys(doc.widgetKinds).length >= LIMITS.widgetKinds) break;
    const wk = normWidgetKind({ ...w, kind: w?.kind ?? kind });
    if (wk && !builtinWidget(wk.kind)) doc.widgetKinds[wk.kind] = wk;
  }

  doc.notifications = (Array.isArray(input.notifications) ? input.notifications : [])
    .slice(-LIMITS.notifications).map(normNotification).filter(Boolean);

  doc.proposals = (Array.isArray(input.proposals) ? input.proposals : [])
    .slice(-LIMITS.proposals).map(normProposal).filter(Boolean);

  // Checkpoints are an *index*: the documents themselves live beside the OS
  // document, so a named state survives history being pruned.
  doc.checkpoints = (Array.isArray(input.checkpoints) ? input.checkpoints : [])
    .slice(-LIMITS.checkpoints)
    .map((c) => (c && typeof c === "object" && isId(c.id)
      ? {
          id: c.id,
          name: str(c.name, LIMITS.nameLen, c.id),
          rev: num(c.rev, 0, Number.MAX_SAFE_INTEGER, 0),
          ts: num(c.ts, 0, Number.MAX_SAFE_INTEGER, Date.now()),
        }
      : null))
    .filter(Boolean);

  return doc;
}

function dedupeIds(list) {
  const seen = new Set();
  for (const item of list) {
    while (seen.has(item.id)) item.id = rid(item.id.split("_")[0] || "x");
    seen.add(item.id);
  }
}

/**
 * Follow an alias to the app it stands for. Returns the terminal app id, or null
 * for a self-reference, a cycle, or a chain longer than anyone should build.
 */
export function resolveAlias(doc, appId, maxHops = 4) {
  let id = appId;
  const seen = new Set();
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (seen.has(id)) return null;
    seen.add(id);
    const app = doc?.apps?.[id];
    if (!app || app.kind !== "alias") return id;
    if (!app.target) return null;
    id = app.target;
  }
  return null;
}

/** True when an app id resolves to something this document can actually launch. */
export function knowsApp(doc, appId) {
  return !!(builtinApp(appId) || doc?.apps?.[appId]);
}
export function knowsWidget(doc, kind) {
  return !!(builtinWidget(kind) || doc?.widgetKinds?.[kind]);
}
