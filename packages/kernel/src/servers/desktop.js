// The `desktop` MCP server — the OS experience, as a syscall surface.
//
// This is the feature the rest of SandboxOS was built to make possible: the
// machine at your slug is not just reachable, it is a place — windows, widgets,
// workspaces, a dock, a theme, motion — and every one of those is a tool call.
//
// Which means the agent has exactly the same powers over your desktop that you
// do, through exactly the same door: authorize → route → execute → audit. There
// is no privileged path that draws the UI behind the Kernel's back. "Ask the
// agent to build me a media gallery and put it bottom-right" is `desktop.open`
// plus `desktop.move`, both audited, both revertible with `desktop.revert`.
//
// Two rules hold everything together:
//
//   · Every mutation goes through store.mutateOs, so it is normalized, revved,
//     announced on the live bus and pushed onto the undo history.
//   · Nothing here renders anything. Tools write the document; the shell reads
//     it. A tool that needed to know the pixel size of the screen would be a
//     tool in the wrong layer.

import {
  loadOs, mutateOs, saveOs, resetOs, osHistory, revertOs, announce,
  normalizeDoc, normApp, normWidgetKind, cleanTokens, cleanAnimation, cleanPatterns,
  isId, rid, LIMITS, DOCK_POSITIONS, WM_MODES,
  BUILTIN_THEMES, listThemes, resolveTheme,
  BUILTIN_ANIMATIONS, listAnimations, resolveAnimation,
  builtinApp, builtinWidget, appDescriptor, widgetDescriptor, listApps, listWidgetKinds,
  writeBundleFile, readBundleFile, listBundleFiles, removeBundleFile, removeBundle,
  exportBundle, importBundle, starterApp, starterAppCss, starterAppJs, starterWidget,
  exportPayload, importPayload, builtinDistroList, docFromDistroSpec,
} from "../../../os/src/index.js";
import { BUILTIN_DISTROS } from "../../../os/src/catalog.js";
import {
  createDistro, listDistros, getDistro, getDistroByName, deleteDistro,
} from "../../../control-db/src/registry.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

/** Windows arrive somewhere sensible rather than all on top of each other. */
function cascadeFor(doc, ws) {
  const n = doc.windows.filter((w) => w.ws === ws).length;
  return { x: 56 + (n % 5) * 28, y: 52 + (n % 5) * 24 };
}

/** An imported distro is untrusted input; bound it before it becomes disk. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const findWindow = (doc, id) => doc.windows.find((w) => w.id === id);
const findWidget = (doc, id) => doc.widgets.find((g) => g.id === id);

function mustWindow(doc, id) {
  const w = findWindow(doc, id);
  if (!w) throw new Error(`no such window: ${id}`);
  return w;
}
function mustWidget(doc, id) {
  const g = findWidget(doc, id);
  if (!g) throw new Error(`no such widget: ${id}`);
  return g;
}

/** The document plus everything a shell needs to paint it in one round trip. */
function snapshot(doc) {
  return {
    doc,
    rev: doc.rev,
    theme: resolveTheme(doc),
    animation: resolveAnimation(doc),
    apps: listApps(doc),
    widgetKinds: listWidgetKinds(doc),
    themes: listThemes(doc).map(({ key, name, scheme, builtin, tokens }) => ({
      key, name, scheme, builtin, accent: tokens.accent, wall: tokens.wall,
    })),
    animations: listAnimations(doc),
    limits: LIMITS,
  };
}

export function desktopServer(deps) {
  const { sandbox } = deps;
  const doc = () => loadOs(sandbox);
  const mutate = (fn, op, label) => mutateOs(sandbox, fn, { op, label });

  /** Custom app/widget bundles this Sandbox holds, as a portable map. */
  const collectBundles = (d) => ({
    apps: Object.fromEntries(Object.keys(d.apps).map((id) => [id, exportBundle(sandbox, "app", id)])),
    widgets: Object.fromEntries(Object.keys(d.widgetKinds).map((k) => [k, exportBundle(sandbox, "widget", k)])),
  });

  return {
    name: "desktop",
    tools: {

      // ── the document ────────────────────────────────────────────────────

      get: {
        description: "The whole OS: document, resolved theme and motion, and the app/widget/distro catalogs.",
        inputSchema: obj({}),
        async handler() {
          const published = listDistros(sandbox.tenant_id)
            .filter((d) => d.has_os)
            .map((d) => ({ id: d.id, name: d.name, description: d.description ?? "", builtin: false, createdAt: d.created_at }));
          return { ...snapshot(doc()), distros: [...builtinDistroList(), ...published] };
        },
      },

      state: {
        description: "Just the OS document (no catalogs) — the cheap poll.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { doc: d, rev: d.rev }; },
      },

      set: {
        description: "Replace the entire OS document. Optionally conditional on a revision.",
        inputSchema: obj({ doc: { type: "object" }, expectRev: N, label: S }, ["doc"]),
        async handler(_ctx, a) {
          const next = saveOs(sandbox, a.doc, { expectRev: a.expectRev ?? null, label: a.label ?? "set" });
          return { ok: true, rev: next.rev };
        },
      },

      patch: {
        description: "Deep-merge a partial document into the OS (nulls delete keys).",
        inputSchema: obj({ patch: { type: "object" }, expectRev: N, label: S }, ["patch"]),
        async handler(_ctx, a) {
          const next = mutateOs(sandbox, (d) => deepMerge(d, a.patch), {
            op: "patch", label: a.label ?? "patch", expectRev: a.expectRev ?? null,
          });
          return { ok: true, rev: next.rev };
        },
      },

      rename: {
        description: "Rename this OS.",
        inputSchema: obj({ name: S }, ["name"]),
        async handler(_ctx, a) {
          const next = mutate((d) => { d.name = String(a.name).slice(0, LIMITS.nameLen); }, "rename", `name → ${a.name}`);
          return { ok: true, name: next.name, rev: next.rev };
        },
      },

      history: {
        description: "Revisions available to revert to, newest first.",
        inputSchema: obj({}),
        async handler() { return { revisions: osHistory(sandbox), current: doc().rev }; },
      },

      revert: {
        description: "Restore a previous revision (itself recorded as a new revision).",
        inputSchema: obj({ rev: N }, ["rev"]),
        async handler(_ctx, a) {
          const next = revertOs(sandbox, a.rev);
          return { ok: true, rev: next.rev, restored: Number(a.rev) };
        },
      },

      reset: {
        description: "Throw the desktop away and start from the first-run seed.",
        inputSchema: obj({ name: S }),
        async handler(_ctx, a) {
          const next = resetOs(sandbox, { name: a.name });
          return { ok: true, rev: next.rev };
        },
      },

      // ── appearance ──────────────────────────────────────────────────────

      themeList: {
        description: "Every theme this OS can wear, built-in and custom.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { themes: listThemes(d), active: d.theme.base, tokens: d.theme.tokens }; },
      },

      themeSet: {
        description: "Wear a theme, optionally overriding individual tokens (e.g. accent).",
        inputSchema: obj({ theme: S, tokens: { type: "object" }, clearTokens: B }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.theme != null) {
              if (!BUILTIN_THEMES[a.theme] && !d.theme.custom[a.theme]) throw new Error(`no such theme: ${a.theme}`);
              d.theme.base = a.theme;
            }
            if (a.clearTokens) d.theme.tokens = {};
            if (a.tokens) d.theme.tokens = { ...d.theme.tokens, ...cleanTokens(a.tokens) };
          }, "theme", `theme → ${a.theme ?? "tokens"}`);
          return { ok: true, theme: resolveTheme(next), rev: next.rev };
        },
      },

      themeDefine: {
        description: "Create or update a custom theme from a base plus token overrides.",
        inputSchema: obj({
          key: S, name: S, base: S, scheme: { type: "string", enum: ["dark", "light"] }, tokens: { type: "object" },
        }, ["key"]),
        async handler(_ctx, a) {
          if (!isId(a.key)) throw new Error("key must be lowercase letters, digits, - or _");
          if (BUILTIN_THEMES[a.key]) throw new Error(`${a.key} is a built-in theme`);
          const next = mutate((d) => {
            if (!d.theme.custom[a.key] && Object.keys(d.theme.custom).length >= LIMITS.themes) {
              throw new Error(`theme limit reached (${LIMITS.themes})`);
            }
            d.theme.custom[a.key] = {
              name: a.name ?? d.theme.custom[a.key]?.name ?? a.key,
              base: BUILTIN_THEMES[a.base] ? a.base : (d.theme.custom[a.key]?.base ?? "midnight"),
              scheme: a.scheme ?? d.theme.custom[a.key]?.scheme,
              tokens: { ...(d.theme.custom[a.key]?.tokens ?? {}), ...cleanTokens(a.tokens ?? {}) },
            };
          }, "themeDefine", `theme ${a.key}`);
          return { ok: true, key: a.key, themes: listThemes(next).length, rev: next.rev };
        },
      },

      themeRemove: {
        description: "Delete a custom theme (falls back to Midnight if it was in use).",
        inputSchema: obj({ key: S }, ["key"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            delete d.theme.custom[a.key];
            if (d.theme.base === a.key) d.theme.base = "midnight";
          }, "themeRemove", `theme ${a.key} removed`);
          return { ok: true, rev: next.rev };
        },
      },

      wallpaperSet: {
        description: "Set the desktop wallpaper (a CSS gradient/colour), globally or per workspace.",
        inputSchema: obj({ wallpaper: S, workspace: N }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.workspace != null) {
              const ws = d.workspaces.find((w) => w.n === Number(a.workspace));
              if (!ws) throw new Error(`no such workspace: ${a.workspace}`);
              ws.wallpaper = a.wallpaper ?? null;
            } else {
              d.theme.tokens = { ...d.theme.tokens, wall: a.wallpaper };
            }
          }, "wallpaper", "wallpaper");
          const applied = a.workspace != null
            ? next.workspaces.find((w) => w.n === Number(a.workspace))?.wallpaper
            : resolveTheme(next).wall;
          return { ok: true, wallpaper: applied ?? null, rev: next.rev };
        },
      },

      animationList: {
        description: "Motion presets available to this OS.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { animations: listAnimations(d), active: d.animation.preset }; },
      },

      animationSet: {
        description: "Choose the motion preset windows open and close with.",
        inputSchema: obj({ preset: S }, ["preset"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!BUILTIN_ANIMATIONS[a.preset] && !d.animation.custom[a.preset]) throw new Error(`no such animation: ${a.preset}`);
            d.animation.preset = a.preset;
          }, "animation", `motion → ${a.preset}`);
          return { ok: true, animation: resolveAnimation(next), rev: next.rev };
        },
      },

      animationDefine: {
        description: "Define a custom motion preset from numbers (opacity/scale/x/y/rotate/blur), not CSS.",
        inputSchema: obj({
          key: S, name: S, duration: N,
          easing: { type: "string", enum: ["spring", "smooth", "snap", "linear", "ease", "ease-out", "ease-in"] },
          open: { type: "object" }, close: { type: "object" },
        }, ["key"]),
        async handler(_ctx, a) {
          if (!isId(a.key)) throw new Error("key must be lowercase letters, digits, - or _");
          if (BUILTIN_ANIMATIONS[a.key]) throw new Error(`${a.key} is a built-in preset`);
          const cleaned = cleanAnimation(a);
          const next = mutate((d) => {
            if (!d.animation.custom[a.key] && Object.keys(d.animation.custom).length >= LIMITS.animations) {
              throw new Error(`animation limit reached (${LIMITS.animations})`);
            }
            d.animation.custom[a.key] = cleaned;
          }, "animationDefine", `motion ${a.key}`);
          return { ok: true, key: a.key, animation: cleaned, rev: next.rev };
        },
      },

      animationRemove: {
        description: "Delete a custom motion preset.",
        inputSchema: obj({ key: S }, ["key"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            delete d.animation.custom[a.key];
            if (d.animation.preset === a.key) d.animation.preset = "spring";
          }, "animationRemove", `motion ${a.key} removed`);
          return { ok: true, rev: next.rev };
        },
      },

      // ── shell chrome ────────────────────────────────────────────────────

      dockSet: {
        description: "Configure the dock: position, size, visibility, autohide, pinned apps.",
        inputSchema: obj({
          position: { type: "string", enum: DOCK_POSITIONS }, size: N,
          visible: B, autohide: B, pinned: { type: "array", items: S },
        }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const dock = d.shell.dock;
            if (a.position != null) dock.position = a.position;
            if (a.size != null) dock.size = a.size;
            if (a.visible != null) dock.visible = a.visible;
            if (a.autohide != null) dock.autohide = a.autohide;
            if (Array.isArray(a.pinned)) {
              for (const id of a.pinned) if (!builtinApp(id) && !d.apps[id]) throw new Error(`cannot pin unknown app: ${id}`);
              dock.pinned = a.pinned;
            }
          }, "dock", "dock");
          return { ok: true, dock: next.shell.dock, rev: next.rev };
        },
      },

      dockPin: {
        description: "Pin or unpin one app on the dock.",
        inputSchema: obj({ app: S, pinned: B }, ["app"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!builtinApp(a.app) && !d.apps[a.app]) throw new Error(`no such app: ${a.app}`);
            const list = new Set(d.shell.dock.pinned);
            if (a.pinned === false) list.delete(a.app); else list.add(a.app);
            d.shell.dock.pinned = [...list];
          }, "dockPin", `dock ${a.app}`);
          return { ok: true, pinned: next.shell.dock.pinned, rev: next.rev };
        },
      },

      shellSet: {
        description: "Configure the menu bar, spotlight and notification centre.",
        inputSchema: obj({
          menubar: { type: "object" }, spotlight: { type: "object" },
          notifications: { type: "object" }, wallpaperFit: S,
        }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.menubar) Object.assign(d.shell.menubar, a.menubar);
            if (a.spotlight) Object.assign(d.shell.spotlight, a.spotlight);
            if (a.notifications) Object.assign(d.shell.notifications, a.notifications);
            if (a.wallpaperFit) d.shell.wallpaperFit = a.wallpaperFit;
          }, "shell", "shell");
          return { ok: true, shell: next.shell, rev: next.rev };
        },
      },

      layoutSet: {
        description: "Window management: floating or tiling, gap, snapping, grid size.",
        inputSchema: obj({ mode: { type: "string", enum: WM_MODES }, gap: N, snap: B, gridSize: N }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.mode != null) d.wm.mode = a.mode;
            if (a.gap != null) d.wm.gap = a.gap;
            if (a.snap != null) d.wm.snap = a.snap;
            if (a.gridSize != null) d.wm.gridSize = a.gridSize;
          }, "layout", `layout → ${a.mode ?? "tuned"}`);
          return { ok: true, wm: next.wm, rev: next.rev };
        },
      },

      // ── workspaces ──────────────────────────────────────────────────────

      workspaceList: {
        description: "List workspaces and what lives on each.",
        inputSchema: obj({}),
        async handler() {
          const d = doc();
          return {
            active: d.activeWorkspace,
            workspaces: d.workspaces.map((w) => ({
              ...w,
              windows: d.windows.filter((x) => x.ws === w.n).length,
              widgets: d.widgets.filter((x) => x.ws === w.n).length,
            })),
          };
        },
      },

      workspaceAdd: {
        description: "Add a workspace.",
        inputSchema: obj({ name: S, switchTo: B }),
        async handler(_ctx, a) {
          let created;
          const next = mutate((d) => {
            if (d.workspaces.length >= LIMITS.workspaces) throw new Error(`workspace limit reached (${LIMITS.workspaces})`);
            const n = d.workspaces.length + 1;
            created = { id: rid("ws"), n, name: a.name ?? `Workspace ${n}`, wallpaper: null };
            d.workspaces.push(created);
            if (a.switchTo !== false) d.activeWorkspace = n;
          }, "workspaceAdd", "workspace added");
          return { ok: true, workspace: created, active: next.activeWorkspace, rev: next.rev };
        },
      },

      workspaceRemove: {
        description: "Remove a workspace; its windows and widgets move to the first one.",
        inputSchema: obj({ n: N }, ["n"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (d.workspaces.length <= 1) throw new Error("a machine needs at least one workspace");
            const idx = d.workspaces.findIndex((w) => w.n === Number(a.n));
            if (idx === -1) throw new Error(`no such workspace: ${a.n}`);
            d.workspaces.splice(idx, 1);
            // Renumber densely, then re-home anything that pointed at the gap.
            const remap = new Map();
            d.workspaces.forEach((w, i) => { remap.set(w.n, i + 1); w.n = i + 1; });
            for (const list of [d.windows, d.widgets]) {
              for (const it of list) it.ws = remap.get(it.ws) ?? 1;
            }
            d.activeWorkspace = remap.get(d.activeWorkspace) ?? 1;
          }, "workspaceRemove", "workspace removed");
          return { ok: true, workspaces: next.workspaces, rev: next.rev };
        },
      },

      workspaceRename: {
        description: "Rename a workspace.",
        inputSchema: obj({ n: N, name: S }, ["n", "name"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const ws = d.workspaces.find((w) => w.n === Number(a.n));
            if (!ws) throw new Error(`no such workspace: ${a.n}`);
            ws.name = String(a.name).slice(0, LIMITS.nameLen);
          }, "workspaceRename", "workspace renamed");
          return { ok: true, workspaces: next.workspaces, rev: next.rev };
        },
      },

      workspaceSwitch: {
        description: "Switch the active workspace.",
        inputSchema: obj({ n: N }, ["n"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.workspaces.some((w) => w.n === Number(a.n))) throw new Error(`no such workspace: ${a.n}`);
            d.activeWorkspace = Number(a.n);
          }, "workspaceSwitch", `workspace ${a.n}`);
          return { ok: true, active: next.activeWorkspace, rev: next.rev };
        },
      },

      // ── windows ─────────────────────────────────────────────────────────

      windowList: {
        description: "List open windows, optionally for one workspace.",
        inputSchema: obj({ ws: N }),
        async handler(_ctx, a) {
          const d = doc();
          const windows = a.ws != null ? d.windows.filter((w) => w.ws === Number(a.ws)) : d.windows;
          return { windows, active: d.activeWorkspace };
        },
      },

      open: {
        description: "Open an app in a window (focuses the existing one if it is a singleton).",
        inputSchema: obj({
          app: S, title: S, ws: N, x: N, y: N, w: N, h: N,
          props: { type: "object" }, focus: B,
        }, ["app"]),
        async handler(_ctx, a) {
          let win;
          const next = mutate((d) => {
            const desc = appDescriptor(d, a.app);
            if (!desc) throw new Error(`no such app: ${a.app}`);
            if (desc.kind === "alias") throw new Error(`${a.app} is an alias; open ${desc.source?.target ?? "its target"}`);
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            if (!d.workspaces.some((x) => x.n === ws)) throw new Error(`no such workspace: ${ws}`);

            const existing = desc.window?.singleton
              ? d.windows.find((x) => x.app === a.app && x.ws === ws) : null;
            if (existing) {
              existing.min = false;
              existing.z = ++d.zTop;
              win = existing;
              return;
            }
            if (d.windows.length >= LIMITS.windows) throw new Error(`window limit reached (${LIMITS.windows})`);
            const at = cascadeFor(d, ws);
            win = {
              id: rid("w"), app: a.app,
              title: a.title ?? desc.name,
              x: a.x ?? at.x, y: a.y ?? at.y,
              w: a.w ?? desc.window.w, h: a.h ?? desc.window.h,
              z: ++d.zTop, ws, min: false, max: false, props: a.props ?? {},
            };
            d.windows.push(win);
          }, "open", `open ${a.app}`);
          return { ok: true, window: findWindow(next, win.id) ?? win, rev: next.rev };
        },
      },

      close: {
        description: "Close a window.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const before = d.windows.length;
            d.windows = d.windows.filter((w) => w.id !== a.id);
            if (d.windows.length === before) throw new Error(`no such window: ${a.id}`);
          }, "close", "close window");
          return { ok: true, rev: next.rev };
        },
      },

      move: {
        description: "Move a window.",
        inputSchema: obj({ id: S, x: N, y: N }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            if (a.x != null) w.x = Number(a.x);
            if (a.y != null) w.y = Number(a.y);
          }, "move", "move window");
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      resize: {
        description: "Resize a window.",
        inputSchema: obj({ id: S, w: N, h: N }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const win = mustWindow(d, a.id);
            if (a.w != null) win.w = Number(a.w);
            if (a.h != null) win.h = Number(a.h);
          }, "resize", "resize window");
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      focus: {
        description: "Raise a window to the top and unminimize it.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            w.min = false;
            w.z = ++d.zTop;
            d.activeWorkspace = w.ws;
          }, "focus", "focus window");
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      windowSet: {
        description: "Change a window: title, minimized, maximized, workspace, props.",
        inputSchema: obj({ id: S, title: S, min: B, max: B, ws: N, props: { type: "object" } }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            if (a.title != null) w.title = String(a.title).slice(0, LIMITS.titleLen);
            if (a.min != null) w.min = !!a.min;
            if (a.max != null) w.max = !!a.max;
            if (a.ws != null) {
              if (!d.workspaces.some((x) => x.n === Number(a.ws))) throw new Error(`no such workspace: ${a.ws}`);
              w.ws = Number(a.ws);
            }
            if (a.props) w.props = { ...w.props, ...a.props };
          }, "windowSet", "window");
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      arrange: {
        description: "Lay out a workspace's windows: grid, cascade, stack or centre.",
        inputSchema: obj({
          preset: { type: "string", enum: ["grid", "cascade", "stack", "center"] },
          ws: N, viewport: { type: "object" },
        }, ["preset"]),
        async handler(_ctx, a) {
          const vw = Math.max(320, Number(a.viewport?.w) || 1280);
          const vh = Math.max(240, Number(a.viewport?.h) || 760);
          const next = mutate((d) => {
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            const wins = d.windows.filter((w) => w.ws === ws && !w.min);
            if (!wins.length) return;
            const gap = d.wm.gap;
            if (a.preset === "grid") {
              const cols = Math.ceil(Math.sqrt(wins.length));
              const rows = Math.ceil(wins.length / cols);
              const cw = Math.floor((vw - gap * (cols + 1)) / cols);
              const ch = Math.floor((vh - gap * (rows + 1)) / rows);
              wins.forEach((w, i) => {
                w.max = false;
                w.x = gap + (i % cols) * (cw + gap);
                w.y = gap + Math.floor(i / cols) * (ch + gap);
                w.w = cw; w.h = ch;
              });
            } else if (a.preset === "cascade") {
              wins.forEach((w, i) => {
                w.max = false;
                w.x = 40 + i * 30; w.y = 40 + i * 26;
                w.w = Math.min(w.w, vw - w.x - 40);
                w.h = Math.min(w.h, vh - w.y - 40);
              });
            } else if (a.preset === "stack") {
              wins.forEach((w) => { w.max = false; w.x = gap; w.y = gap; w.w = vw - gap * 2; w.h = vh - gap * 2; });
            } else {
              wins.forEach((w) => {
                w.max = false;
                w.x = Math.max(gap, Math.round((vw - w.w) / 2));
                w.y = Math.max(gap, Math.round((vh - w.h) / 2));
              });
            }
          }, "arrange", `arrange ${a.preset}`);
          return { ok: true, windows: next.windows.filter((w) => w.ws === (a.ws ?? next.activeWorkspace)), rev: next.rev };
        },
      },

      snap: {
        description:
          "Snap a window to a region of the screen: left/right/top/bottom halves, a quarter, full, or centre. " +
          "Pass the viewport you are snapping within (the shell does; an agent can guess).",
        inputSchema: obj({
          id: S,
          region: {
            type: "string",
            enum: ["left", "right", "top", "bottom", "topleft", "topright", "bottomleft", "bottomright", "full", "center"],
          },
          viewport: { type: "object" },
        }, ["id", "region"]),
        async handler(_ctx, a) {
          const vw = Math.max(320, Number(a.viewport?.w) || 1280);
          const vh = Math.max(240, Number(a.viewport?.h) || 760);
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            const g = d.wm.gap;
            const halfW = Math.floor((vw - g * 3) / 2);
            const halfH = Math.floor((vh - g * 3) / 2);
            const box = {
              left: { x: g, y: g, w: halfW, h: vh - g * 2 },
              right: { x: g * 2 + halfW, y: g, w: halfW, h: vh - g * 2 },
              top: { x: g, y: g, w: vw - g * 2, h: halfH },
              bottom: { x: g, y: g * 2 + halfH, w: vw - g * 2, h: halfH },
              topleft: { x: g, y: g, w: halfW, h: halfH },
              topright: { x: g * 2 + halfW, y: g, w: halfW, h: halfH },
              bottomleft: { x: g, y: g * 2 + halfH, w: halfW, h: halfH },
              bottomright: { x: g * 2 + halfW, y: g * 2 + halfH, w: halfW, h: halfH },
              full: { x: g, y: g, w: vw - g * 2, h: vh - g * 2 },
              center: { x: Math.round((vw - w.w) / 2), y: Math.round((vh - w.h) / 2), w: w.w, h: w.h },
            }[a.region];
            Object.assign(w, box, { min: false, max: false, z: ++d.zTop });
          }, "snap", `snap ${a.region}`);
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      cycleFocus: {
        description: "Focus the next (or previous) window on this workspace.",
        inputSchema: obj({ direction: { type: "string", enum: ["next", "prev"] } }),
        async handler(_ctx, a) {
          let focused = null;
          const next = mutate((d) => {
            const here = d.windows.filter((w) => w.ws === d.activeWorkspace && !w.min)
              .sort((x, y) => x.z - y.z);
            if (here.length < 2) { focused = here[0] ?? null; return; }
            // The top window is the one in front; "next" means send it behind and
            // raise whatever was underneath, which is what alt-tab does.
            focused = a.direction === "prev" ? here[here.length - 2] : here[0];
            focused.z = ++d.zTop;
          }, "cycleFocus", "cycle windows");
          return { ok: true, window: focused ? findWindow(next, focused.id) : null, rev: next.rev };
        },
      },

      minimizeAll: {
        description: "Minimize every window on a workspace (or restore them all).",
        inputSchema: obj({ ws: N, restore: B }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            for (const w of d.windows) if (w.ws === ws) w.min = !a.restore;
          }, "minimizeAll", a.restore ? "restore all" : "show desktop");
          return { ok: true, rev: next.rev };
        },
      },

      associate: {
        description: "Set (or clear) which app opens a file extension. Pass app:null to clear.",
        inputSchema: obj({ ext: S, app: S }, ["ext"]),
        async handler(_ctx, a) {
          const ext = String(a.ext).toLowerCase().replace(/^\*?\.?/, ".");
          const next = mutate((d) => {
            if (a.app == null || a.app === "") { delete d.shell.associations[ext]; return; }
            if (!builtinApp(a.app) && !d.apps[a.app]) throw new Error(`no such app: ${a.app}`);
            d.shell.associations[ext] = a.app;
          }, "associate", `${ext} → ${a.app ?? "default"}`);
          return { ok: true, associations: next.shell.associations, rev: next.rev };
        },
      },

      // ── widgets ─────────────────────────────────────────────────────────

      widgetList: {
        description: "Widgets placed on the desktop, and the kinds available to place.",
        inputSchema: obj({ ws: N }),
        async handler(_ctx, a) {
          const d = doc();
          return {
            widgets: a.ws != null ? d.widgets.filter((g) => g.ws === Number(a.ws)) : d.widgets,
            kinds: listWidgetKinds(d),
          };
        },
      },

      widgetAdd: {
        description: "Place a widget on the desktop.",
        inputSchema: obj({ kind: S, ws: N, x: N, y: N, w: N, h: N, pin: S, props: { type: "object" } }, ["kind"]),
        async handler(_ctx, a) {
          let widget;
          const next = mutate((d) => {
            const desc = widgetDescriptor(d, a.kind);
            if (!desc) throw new Error(`no such widget kind: ${a.kind}`);
            if (d.widgets.length >= LIMITS.widgets) throw new Error(`widget limit reached (${LIMITS.widgets})`);
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            if (!d.workspaces.some((x) => x.n === ws)) throw new Error(`no such workspace: ${ws}`);
            const n = d.widgets.filter((g) => g.ws === ws).length;
            widget = {
              id: rid("g"), kind: a.kind,
              x: a.x ?? 24 + (n % 3) * 26, y: a.y ?? 20 + (n % 4) * 30,
              w: a.w ?? desc.size.w, h: a.h ?? desc.size.h,
              ws, pin: a.pin ?? "none", props: a.props ?? {},
            };
            d.widgets.push(widget);
          }, "widgetAdd", `widget ${a.kind}`);
          return { ok: true, widget: findWidget(next, widget.id) ?? widget, rev: next.rev };
        },
      },

      widgetRemove: {
        description: "Remove a widget from the desktop.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const before = d.widgets.length;
            d.widgets = d.widgets.filter((g) => g.id !== a.id);
            if (d.widgets.length === before) throw new Error(`no such widget: ${a.id}`);
          }, "widgetRemove", "widget removed");
          return { ok: true, rev: next.rev };
        },
      },

      widgetSet: {
        description: "Move, resize, re-home or reconfigure a placed widget.",
        inputSchema: obj({ id: S, x: N, y: N, w: N, h: N, ws: N, pin: S, props: { type: "object" } }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const g = mustWidget(d, a.id);
            for (const k of ["x", "y", "w", "h"]) if (a[k] != null) g[k] = Number(a[k]);
            if (a.pin != null) g.pin = a.pin;
            if (a.ws != null) {
              if (!d.workspaces.some((x) => x.n === Number(a.ws))) throw new Error(`no such workspace: ${a.ws}`);
              g.ws = Number(a.ws);
            }
            if (a.props) g.props = { ...g.props, ...a.props };
          }, "widgetSet", "widget");
          return { ok: true, widget: findWidget(next, a.id), rev: next.rev };
        },
      },

      // ── apps: definitions and their source ──────────────────────────────

      appList: {
        description: "Every app this machine can launch — built-in, custom bundle, or URL.",
        inputSchema: obj({}),
        async handler() { return { apps: listApps(doc()) }; },
      },

      appDefine: {
        description:
          "Create or update a custom app. kind='bundle' ships HTML/CSS/JS served into a sandboxed frame; " +
          "kind='url' points at a service (e.g. an exposed port). A new bundle is seeded with a runnable starter.",
        inputSchema: obj({
          id: S, name: S, icon: S, hue: S, description: S,
          kind: { type: "string", enum: ["bundle", "url", "alias"] },
          url: S, target: S, entry: S,
          origin: { type: "string", enum: ["store", "volume"] }, volumePath: S,
          permissions: { type: "array", items: S },
          window: { type: "object" },
          files: { type: "object" },
          starter: B,
        }, ["id"]),
        async handler(_ctx, a) {
          if (!isId(a.id)) throw new Error("id must be lowercase letters, digits, - or _");
          if (builtinApp(a.id)) throw new Error(`${a.id} is a built-in app`);
          let seeded = false;
          const next = mutate((d) => {
            const prior = d.apps[a.id];
            if (!prior && Object.keys(d.apps).length >= LIMITS.apps) throw new Error(`app limit reached (${LIMITS.apps})`);
            const app = normApp({ ...(prior ?? {}), ...a, id: a.id, createdAt: prior?.createdAt, updatedAt: Date.now() });
            if (!app) throw new Error("invalid app definition");
            if (app.kind === "url" && !app.url) throw new Error("kind='url' needs a http(s) url");
            d.apps[a.id] = app;
            seeded = !prior && app.kind === "bundle" && app.origin === "store";
          }, "appDefine", `app ${a.id}`);

          const app = next.apps[a.id];
          const written = [];
          if (app.kind === "bundle" && app.origin === "store") {
            if (a.files && typeof a.files === "object") {
              for (const [rel, content] of Object.entries(a.files)) {
                const entry = typeof content === "string" ? { content } : content;
                written.push(writeBundleFile(sandbox, "app", a.id, rel, entry?.content ?? "", { base64: !!entry?.base64 }));
              }
            } else if (seeded && a.starter !== false) {
              written.push(writeBundleFile(sandbox, "app", a.id, app.entry, starterApp({ name: app.name })));
              written.push(writeBundleFile(sandbox, "app", a.id, "app.css", starterAppCss()));
              written.push(writeBundleFile(sandbox, "app", a.id, "app.js", starterAppJs()));
            }
            if (written.length) announce(sandbox.id, "appFiles", { app: a.id });
          }
          return { ok: true, app: appDescriptor(next, a.id), files: written, rev: next.rev };
        },
      },

      appRemove: {
        description: "Remove a custom app (and its source, unless keepFiles).",
        inputSchema: obj({ id: S, keepFiles: B }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
            delete d.apps[a.id];
            d.windows = d.windows.filter((w) => w.app !== a.id);
            d.shell.dock.pinned = d.shell.dock.pinned.filter((x) => x !== a.id);
          }, "appRemove", `app ${a.id} removed`);
          const filesRemoved = a.keepFiles ? false : removeBundle(sandbox, "app", a.id);
          return { ok: true, filesRemoved, rev: next.rev };
        },
      },

      appFiles: {
        description: "List the files behind a custom app.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          return { id: a.id, files: listBundleFiles(sandbox, "app", a.id) };
        },
      },

      appRead: {
        description: "Read one file of a custom app's source.",
        inputSchema: obj({ id: S, path: S, base64: B }, ["id", "path"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          return readBundleFile(sandbox, "app", a.id, a.path, { encoding: a.base64 ? "base64" : "utf8" });
        },
      },

      appWrite: {
        description: "Write one file of a custom app's source. This is how an agent builds UI.",
        inputSchema: obj({ id: S, path: S, content: S, base64: B }, ["id", "path", "content"]),
        async handler(_ctx, a) {
          const d = doc();
          if (!d.apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          if (d.apps[a.id].origin !== "store") throw new Error(`${a.id} is served from the Cell volume — write it with fs.write`);
          const w = writeBundleFile(sandbox, "app", a.id, a.path, a.content, { base64: !!a.base64 });
          mutate((x) => { x.apps[a.id].updatedAt = Date.now(); }, "appWrite", `app ${a.id} · ${w.path}`);
          announce(sandbox.id, "appFiles", { app: a.id, path: w.path });
          return { ok: true, ...w };
        },
      },

      appDelete: {
        description: "Delete one file from a custom app's source.",
        inputSchema: obj({ id: S, path: S }, ["id", "path"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          const r = removeBundleFile(sandbox, "app", a.id, a.path);
          announce(sandbox.id, "appFiles", { app: a.id, path: r.path });
          return { ok: true, ...r };
        },
      },

      // ── widget kinds: the same machinery, smaller chrome ────────────────

      widgetDefine: {
        description: "Create or update a custom widget kind (a bundle rendered without window chrome).",
        inputSchema: obj({
          kind: S, name: S, icon: S, description: S, entry: S,
          origin: { type: "string", enum: ["store", "volume"] }, volumePath: S,
          permissions: { type: "array", items: S }, size: { type: "object" }, refreshMs: N,
          files: { type: "object" }, starter: B,
        }, ["kind"]),
        async handler(_ctx, a) {
          if (!isId(a.kind)) throw new Error("kind must be lowercase letters, digits, - or _");
          if (builtinWidget(a.kind)) throw new Error(`${a.kind} is a built-in widget`);
          let seeded = false;
          const next = mutate((d) => {
            const prior = d.widgetKinds[a.kind];
            if (!prior && Object.keys(d.widgetKinds).length >= LIMITS.widgetKinds) {
              throw new Error(`widget-kind limit reached (${LIMITS.widgetKinds})`);
            }
            const wk = normWidgetKind({ ...(prior ?? {}), ...a, kind: a.kind, createdAt: prior?.createdAt, updatedAt: Date.now() });
            if (!wk) throw new Error("invalid widget definition");
            d.widgetKinds[a.kind] = wk;
            seeded = !prior && wk.origin === "store";
          }, "widgetDefine", `widget kind ${a.kind}`);

          const wk = next.widgetKinds[a.kind];
          const written = [];
          if (wk.origin === "store") {
            if (a.files && typeof a.files === "object") {
              for (const [rel, content] of Object.entries(a.files)) {
                const entry = typeof content === "string" ? { content } : content;
                written.push(writeBundleFile(sandbox, "widget", a.kind, rel, entry?.content ?? "", { base64: !!entry?.base64 }));
              }
            } else if (seeded && a.starter !== false) {
              written.push(writeBundleFile(sandbox, "widget", a.kind, wk.entry, starterWidget({ name: wk.name })));
            }
            if (written.length) announce(sandbox.id, "widgetFiles", { kind: a.kind });
          }
          return { ok: true, widget: widgetDescriptor(next, a.kind), files: written, rev: next.rev };
        },
      },

      widgetKindRemove: {
        description: "Remove a custom widget kind, its source, and every placed instance.",
        inputSchema: obj({ kind: S, keepFiles: B }, ["kind"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
            delete d.widgetKinds[a.kind];
            d.widgets = d.widgets.filter((g) => g.kind !== a.kind);
          }, "widgetKindRemove", `widget kind ${a.kind} removed`);
          const filesRemoved = a.keepFiles ? false : removeBundle(sandbox, "widget", a.kind);
          return { ok: true, filesRemoved, rev: next.rev };
        },
      },

      widgetFiles: {
        description: "List the files behind a custom widget kind.",
        inputSchema: obj({ kind: S }, ["kind"]),
        async handler(_ctx, a) {
          if (!doc().widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          return { kind: a.kind, files: listBundleFiles(sandbox, "widget", a.kind) };
        },
      },

      widgetRead: {
        description: "Read one file of a custom widget's source.",
        inputSchema: obj({ kind: S, path: S, base64: B }, ["kind", "path"]),
        async handler(_ctx, a) {
          if (!doc().widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          return readBundleFile(sandbox, "widget", a.kind, a.path, { encoding: a.base64 ? "base64" : "utf8" });
        },
      },

      widgetWrite: {
        description: "Write one file of a custom widget's source.",
        inputSchema: obj({ kind: S, path: S, content: S, base64: B }, ["kind", "path", "content"]),
        async handler(_ctx, a) {
          const d = doc();
          if (!d.widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          if (d.widgetKinds[a.kind].origin !== "store") throw new Error(`${a.kind} is served from the Cell volume — write it with fs.write`);
          const w = writeBundleFile(sandbox, "widget", a.kind, a.path, a.content, { base64: !!a.base64 });
          mutate((x) => { x.widgetKinds[a.kind].updatedAt = Date.now(); }, "widgetWrite", `widget ${a.kind} · ${w.path}`);
          announce(sandbox.id, "widgetFiles", { kind: a.kind, path: w.path });
          return { ok: true, ...w };
        },
      },

      // ── notifications ───────────────────────────────────────────────────

      notify: {
        description: "Post a notification to the OS notification centre.",
        inputSchema: obj({
          title: S, body: S, app: S,
          kind: { type: "string", enum: ["ok", "warn", "err", "info", "accent"] },
        }, ["title"]),
        async handler(_ctx, a) {
          let note;
          const next = mutate((d) => {
            note = {
              id: rid("n"), app: a.app ?? "system", title: a.title,
              body: a.body ?? "", kind: a.kind ?? "info", ts: Date.now(), read: false,
            };
            d.notifications.push(note);
            while (d.notifications.length > LIMITS.notifications) d.notifications.shift();
          }, "notify", "notification");
          return { ok: true, notification: note, unread: next.notifications.filter((n) => !n.read).length };
        },
      },

      notificationsRead: {
        description: "Mark notifications read (all, or one by id).",
        inputSchema: obj({ id: S }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            for (const n of d.notifications) if (!a.id || n.id === a.id) n.read = true;
          }, "notificationsRead", "notifications read");
          return { ok: true, unread: next.notifications.filter((n) => !n.read).length };
        },
      },

      notificationsClear: {
        description: "Empty the notification centre.",
        inputSchema: obj({}),
        async handler() {
          const next = mutate((d) => { d.notifications = []; }, "notificationsClear", "notifications cleared");
          return { ok: true, rev: next.rev };
        },
      },

      // ── distros: a whole machine, packaged ──────────────────────────────

      distroList: {
        description: "Distros available to fork: the built-in seeds plus any this tenant published.",
        inputSchema: obj({}),
        async handler() {
          const published = listDistros(sandbox.tenant_id).map((d) => ({
            id: d.id, name: d.name, description: d.description ?? "", builtin: false, createdAt: d.created_at,
          }));
          return { distros: [...builtinDistroList(), ...published] };
        },
      },

      distroPublish: {
        description: "Publish this whole OS — document plus every custom app's source — as a forkable distro.",
        inputSchema: obj({ name: S, description: S, replace: B }, ["name"]),
        async handler(_ctx, a) {
          const d = doc();
          const payload = exportPayload(d, { ...collectBundles(d), name: a.name, description: a.description });
          if (a.replace) deleteDistro(sandbox.tenant_id, a.name);
          const created = createDistro(sandbox.tenant_id, {
            name: a.name,
            description: a.description ?? `${d.name} · ${d.windows.length} windows, ${Object.keys(d.apps).length} custom apps`,
            manifest: { from: "desktop", os: true },
            os: payload,
          });
          return {
            ok: true, id: created.id, name: created.name,
            apps: Object.keys(payload.bundles.apps).length,
            widgets: Object.keys(payload.bundles.widgets).length,
          };
        },
      },

      distroFork: {
        description: "Replace this machine's OS with a distro — built-in by id, or one published by this tenant.",
        inputSchema: obj({ id: S, name: S, keepName: B }),
        async handler(_ctx, a) {
          const key = a.id ?? a.name;
          if (!key) throw new Error("id or name required");
          const builtin = BUILTIN_DISTROS.find((x) => x.id === key || x.name === key);
          const current = doc();

          if (builtin) {
            const next = saveOs(sandbox, docFromDistroSpec(builtin, {
              name: a.keepName ? current.name : builtin.name,
            }), { label: `fork ${builtin.name}` });
            return { ok: true, distro: { id: builtin.id, name: builtin.name, builtin: true }, rev: next.rev };
          }

          const row = getDistroByName(sandbox.tenant_id, key) ?? getDistro(key);
          if (!row || row.tenant_id !== sandbox.tenant_id) throw new Error(`no such distro: ${key}`);
          if (!row.os) throw new Error(`${row.name} is a manifest-only distro and has no OS to fork`);

          const { doc: forked, bundles } = importPayload(row.os, {
            name: a.keepName ? current.name : row.name,
            distro: { id: row.id, name: row.name },
          });
          for (const [id, files] of Object.entries(bundles.apps ?? {})) importBundle(sandbox, "app", id, files);
          for (const [kind, files] of Object.entries(bundles.widgets ?? {})) importBundle(sandbox, "widget", kind, files);
          const next = saveOs(sandbox, forked, { label: `fork ${row.name}` });
          return {
            ok: true,
            distro: { id: row.id, name: row.name, builtin: false },
            apps: Object.keys(bundles.apps ?? {}).length,
            rev: next.rev,
          };
        },
      },

      distroExport: {
        description: "Export this OS as a portable payload (document + every custom app's source).",
        inputSchema: obj({ name: S, description: S }),
        async handler(_ctx, a) {
          const d = doc();
          return { payload: exportPayload(d, { ...collectBundles(d), name: a.name, description: a.description }) };
        },
      },

      distroImport: {
        description: "Install a portable payload over this machine's OS.",
        inputSchema: obj({ payload: { type: "object" }, name: S }, ["payload"]),
        async handler(_ctx, a) {
          // A payload arrives from outside — a file someone was sent, a registry we
          // do not control. Bound it before it becomes disk.
          const size = JSON.stringify(a.payload ?? {}).length;
          if (size > MAX_PAYLOAD_BYTES) {
            throw new Error(`distro payload too large: ${size} bytes (max ${MAX_PAYLOAD_BYTES})`);
          }
          const { doc: imported, bundles } = importPayload(a.payload, { name: a.name });
          for (const [id, files] of Object.entries(bundles.apps ?? {})) importBundle(sandbox, "app", id, files);
          for (const [kind, files] of Object.entries(bundles.widgets ?? {})) importBundle(sandbox, "widget", kind, files);
          const next = saveOs(sandbox, imported, { label: "import" });
          return { ok: true, rev: next.rev, apps: Object.keys(bundles.apps ?? {}).length };
        },
      },
    },
  };
}

/** Recursive merge for `desktop.patch`. A null value deletes the key. */
function deepMerge(target, patch) {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
