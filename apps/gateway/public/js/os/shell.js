// shell.js — the furniture around the desktop: menu bar, dock, launcher,
// notification centre, spotlight, and the keyboard.
//
// All of it is driven by the OS document. The dock is `shell.dock.pinned`, the
// menu bar's title is `shell.menubar.title`, the notification centre is
// `notifications` — so "hide the dock", "put it on the left", "rename the menu"
// are ordinary `desktop.*` calls, and an agent can do every one of them.

import { h, fill, icon, api, slug, menu, toast, toastError } from "../core.js";
import { KEY_ACTIONS, matchesChord, prettyChord } from "./lib/keys.js";
import { os, call, tint } from "./client.js";
import { createDesktop } from "./wm.js";
import { iconName } from "./sprite.js";
import { broadcast } from "./frames.js";
import { appFor } from "./builtins.js";

const pad2 = (n) => String(n).padStart(2, "0");
const clockText = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

export function createScreen({ ctx = {} } = {}) {
  // ── DOM skeleton ──────────────────────────────────────────────────────────
  const menubar = h("div.os-menubar");
  const desktopEl = h("div.os-desktop");
  const dock = h("div.os-dock");
  const overlays = h("div", { style: { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "20" } });
  const el = h("div.os-screen", null, menubar, desktopEl, dock, overlays);

  const launch = (appId, props) =>
    call("open", { app: appId, ...(props ? { props } : {}) })
      .catch((e) => toastError(`Could not open ${appId}`, e));

  const wm = createDesktop({
    root: desktopEl,
    ctx: { ...ctx, launch, mark: () => call("arrange", { preset: "grid", viewport: wm.viewport() }), windowMenu },
  });

  /** The window's menu — a right-click on a desktop, a long press on a phone. */
  function windowMenu(at, id) {
    const w = os.doc.windows.find((x) => x.id === id);
    if (!w) return;
    menu(at, [
      { label: w.min ? "Restore" : "Minimise", icon: "window", run: () => call("windowSet", { id, min: !w.min }) },
      { label: w.max ? "Unzoom" : "Zoom", run: () => call("windowSet", { id, max: !w.max }) },
      { label: "Next window", key: "⌘`", run: () => call("cycleFocus", {}) },
      "-",
      ...os.doc.workspaces.filter((x) => x.n !== w.ws).map((x) => ({ label: `Move to ${x.name}`, run: () => call("windowSet", { id, ws: x.n }) })),
      "-",
      { label: "Close", icon: "x", key: "⌘W", danger: true, run: () => call("close", { id }) },
    ]);
  }

  // ── overlay plumbing ──────────────────────────────────────────────────────
  let openOverlay = null;

  function showOverlay(name, node) {
    hideOverlay();
    openOverlay = name;
    overlays.style.pointerEvents = "auto";
    fill(overlays, typeof node === "function" ? node() : node);
  }
  function hideOverlay() {
    openOverlay = null;
    overlays.style.pointerEvents = "none";
    fill(overlays);
  }
  const toggleOverlay = (name, build) => (openOverlay === name ? hideOverlay() : showOverlay(name, build()));

  // ── menu bar ──────────────────────────────────────────────────────────────
  const clockEl = h("span.clock", clockText());
  setInterval(() => { clockEl.textContent = clockText(); }, 20_000);

  // Status icons show a reading or nothing. The "wifi" glyph is the live stream
  // to this machine (connected / reconnecting), the battery is the browser's own
  // Battery API where it exists, the load chip is `metrics.snapshot`. Decorative
  // icons that always look fine are how a dashboard learns to lie.
  const linkEl = h("span.status", { title: "Live connection to the machine" }, icon("wifi", 15));
  const battEl = h("span.status", { hidden: true, title: "Battery" }, icon("battery", 17), h("span.pct"));
  const loadEl = h("span.status", { hidden: true, title: "Cell load (1 min)" }, icon("metrics", 13), h("span.pct"));
  let battery = null;
  if (typeof navigator.getBattery === "function") {
    navigator.getBattery().then((b) => {
      battery = b;
      const paint = () => {
        battEl.hidden = false;
        battEl.querySelector(".pct").textContent = `${Math.round(b.level * 100)}%${b.charging ? "⚡" : ""}`;
        battEl.classList.toggle("warn", !b.charging && b.level < 0.15);
      };
      b.addEventListener("levelchange", paint);
      b.addEventListener("chargingchange", paint);
      paint();
    }).catch(() => {});
  }
  async function readLoad() {
    if (!os.doc?.shell?.menubar?.showStatus) return;
    const m = await api.tryMcp("metrics", "snapshot", {});
    const l = m?.load?.[0];
    loadEl.hidden = l == null;
    if (l != null) loadEl.querySelector(".pct").textContent = l.toFixed(2);
  }
  readLoad();
  setInterval(readLoad, 30_000);
  function paintLink() {
    linkEl.classList.toggle("on", !!os.connected);
    linkEl.classList.toggle("warn", !os.connected);
    linkEl.title = os.connected ? "Live: changes arrive as they happen" : "Reconnecting to the machine…";
  }

  function renderMenubar() {
    const d = os.doc;
    const unread = d.notifications.filter((n) => !n.read).length;
    // Do-not-disturb is visible, because a machine that has quietly stopped
    // telling you things should say so rather than look calm (goal.md T3.3).
    const dnd = !!d.shell.notifications.dnd;
    const bell = h("button.icon-btn", {
      class: dnd ? "dnd" : "",
      title: dnd ? "Do not disturb — everything is still recorded" : "Notifications",
      onclick: () => toggleOverlay("notifs", notifPanel),
    },
      icon("bell", 14),
      unread ? h("span.os-badge", { class: dnd ? "quiet" : "" }, String(unread)) : null);

    menubar.hidden = !d.shell.menubar.visible;
    fill(menubar,
      h("button.start", { title: "Applications", onclick: () => toggleOverlay("launcher", launcher) }, "⇌"),
      h("span.os-name", d.shell.menubar.title ?? d.name),
      ...d.workspaces.map((w) => h("button.menu-item", {
        class: w.n === d.activeWorkspace ? "on" : "",
        title: `Workspace ${w.n}`,
        onclick: () => call("workspaceSwitch", { n: w.n }),
        oncontextmenu: (e) => { e.preventDefault(); workspaceMenu(e, w); },
      }, w.name)),
      h("button.menu-item.add", { title: "New workspace", onclick: () => call("workspaceAdd", {}) }, "+"),
      h("span.spacer"),
      h("button.icon-btn", { title: "Search (⌘K)", onclick: () => showOverlay("spotlight", spotlight) }, icon("search", 14)),
      bell,
      d.shell.menubar.showStatus ? loadEl : null,
      d.shell.menubar.showStatus ? battEl : null,
      d.shell.menubar.showStatus ? linkEl : null,
      d.shell.menubar.showClock ? clockEl : null,
    );
    paintLink();
  }

  function workspaceMenu(e, w) {
    menu({ x: e.clientX, y: e.clientY }, [
      { label: "Rename…", run: async () => {
        const name = prompt("Workspace name", w.name);
        if (name) call("workspaceRename", { n: w.n, name });
      } },
      { label: "Show desktop", icon: "window", run: () => call("minimizeAll", { ws: w.n }) },
      { label: "Restore all", run: () => call("minimizeAll", { ws: w.n, restore: true }) },
      "-",
      { label: "Delete workspace", icon: "trash", danger: true, disabled: os.doc.workspaces.length < 2,
        run: () => call("workspaceRemove", { n: w.n }).catch((err) => toastError("Could not remove it", err)) },
    ]);
  }

  // ── dock ──────────────────────────────────────────────────────────────────
  function renderDock() {
    const d = os.doc;
    const cfg = d.shell.dock;
    dock.className = `os-dock ${cfg.position}${cfg.autohide ? " autohide" : ""}`;
    dock.hidden = !cfg.visible || cfg.position === "hidden";
    const size = cfg.size;
    fill(dock, ...cfg.pinned.map((id) => {
      const meta = (os.snap.apps ?? []).find((a) => a.id === id);
      if (!meta) return null;
      const mine = d.windows.filter((w) => w.app === id && w.ws === d.activeWorkspace);
      return h("button.dock-app", {
        title: meta.name,
        "aria-label": meta.name,
        style: { width: `${size}px`, height: `${size}px`, background: tint(meta.hue), color: meta.hue },
        // On a phone the dock is the app switcher: tap brings the app's window
        // to the front rather than opening another one.
        onclick: () => (mine.length && (mine.every((w) => w.min) || desktopEl.classList.contains("compact"))
          ? call("focus", { id: [...mine].sort((a, b) => b.z - a.z)[0].id })
          : launch(id)),
        oncontextmenu: (e) => { e.preventDefault(); dockMenu(e, meta, mine); },
      }, icon(iconName(meta.icon), Math.round(size / 2)),
        h("span.lbl", meta.name),
        h("span.dot", { style: { background: mine.length ? meta.hue : "transparent" } }));
    }));
  }

  function dockMenu(e, meta, mine) {
    menu({ x: e.clientX, y: e.clientY }, [
      { label: "New window", icon: "plus", run: () => launch(meta.id) },
      mine.length ? { label: `Close ${mine.length} window${mine.length > 1 ? "s" : ""}`, icon: "x",
        run: () => mine.forEach((w) => call("close", { id: w.id }).catch(() => {})) } : null,
      "-",
      { label: "Remove from dock", icon: "trash",
        run: () => call("dockPin", { app: meta.id, pinned: false }) },
    ].filter(Boolean));
  }

  // ── launcher ──────────────────────────────────────────────────────────────
  function launcher() {
    const apps = os.snap.apps ?? [];
    const distros = os.snap.distros ?? [];
    const panel = h("div.os-panel.os-launcher", { onclick: (e) => e.stopPropagation() },
      h("div.os-label", "Applications"),
      h("div.grid", ...apps.map((a) => h("button.launch-app", {
        onclick: () => { hideOverlay(); launch(a.id); },
        oncontextmenu: (e) => {
          e.preventDefault();
          menu({ x: e.clientX, y: e.clientY }, [
            { label: os.doc.shell.dock.pinned.includes(a.id) ? "Remove from dock" : "Keep in dock", icon: "apps",
              run: () => call("dockPin", { app: a.id, pinned: !os.doc.shell.dock.pinned.includes(a.id) }) },
          ]);
        },
      },
        h("span.glyph", { style: { background: tint(a.hue), color: a.hue } }, icon(iconName(a.icon), 22)),
        h("span.nm", a.name)))),
      distros.length ? h("div.os-label", "Distros") : null,
      ...distros.map((dd) => h("button.distro-line", {
        onclick: async () => {
          hideOverlay();
          try {
            await call("distroFork", { id: dd.id });
            await call("notify", { title: `Forked ${dd.name}`, body: "Your desktop was replaced. Undo it from the Studio's history.", kind: "accent", app: "Distros" });
          } catch (e) { toastError("Could not fork that distro", e); }
        },
      }, h("span.tag", { style: { background: dd.hue ?? "var(--os-accent)" } }), h("span.nm", dd.name), h("span.act", "fork"))),
    );
    return h("div.os-overlay.center", { onclick: hideOverlay }, panel);
  }

  // ── notifications ─────────────────────────────────────────────────────────
  /** Where a notification leads: its own action, or the app that sent it. */
  function followNotification(n) {
    const d = os.doc;
    const focusWindow = (id) => call("focus", { id }).catch(() => {});
    if (n.action?.window && d.windows.some((w) => w.id === n.action.window)) return focusWindow(n.action.window);
    if (n.action?.app) return launch(n.action.app, n.action.props);
    const byApp = { Processes: "metrics", Agents: "assistant", Distros: "settings", SandboxOS: "settings" };
    const appId = byApp[n.app] ?? ((os.snap.apps ?? []).find((a) => a.id === n.app || a.name === n.app)?.id ?? null);
    if (!appId) return null;
    const open = d.windows.find((w) => w.app === appId && w.ws === d.activeWorkspace);
    return open ? focusWindow(open.id) : launch(appId);
  }

  function notifPanel() {
    const list = [...os.doc.notifications].reverse();
    call("notificationsRead", {}).catch(() => {});
    // Group by who is talking: the machine's own processes, agents, then each
    // app. A flat list buries the one thing you delegated under twenty toasts.
    const groupOf = (n) => (n.app === "Processes" ? "Processes" : n.app === "Agents" ? "Agents" : n.app === "system" || n.app === "SandboxOS" ? "System" : n.app);
    const groups = new Map();
    for (const n of list) { const g = groupOf(n); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
    const panel = h("div.os-panel.os-notifs", { onclick: (e) => e.stopPropagation() },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "8px" } },
        h("span", { style: { fontSize: "12px", fontWeight: "650" } }, `Notifications${list.length ? ` · ${list.length}` : ""}`),
        h("span.spacer", { style: { flex: "1" } }),
        // Attention is the user's: the switch is where the interruptions are.
        h("button.app-btn", {
          class: os.doc.shell.notifications.dnd ? "on" : "",
          title: "Everything is still recorded — nothing interrupts you",
          onclick: () => call("shellSet", { notifications: { dnd: !os.doc.shell.notifications.dnd } })
            .then(() => { hideOverlay(); })
            .catch((e) => toastError("Could not change that", e)),
        }, os.doc.shell.notifications.dnd ? "Do not disturb: on" : "Do not disturb"),
        list.length ? h("button.app-btn", { onclick: () => { call("notificationsClear", {}); hideOverlay(); } }, "Clear all") : null),
      ...(list.length ? [...groups.entries()].flatMap(([g, items]) => [
        h("div.os-label", { style: { marginBottom: "6px" } }, g),
        ...items.map((n) => h("div.notif", { class: `${n.kind}${n.action || true ? " link" : ""}`, title: "Open", onclick: () => { hideOverlay(); followNotification(n); } },
          h("div.hd", null, h("b", n.title), h("span", ago(n.ts)),
            h("button.dismiss", { title: "Dismiss", "aria-label": "Dismiss", onclick: (e) => { e.stopPropagation(); call("notificationsClear", { id: n.id }).catch(() => {}); e.currentTarget.closest(".notif")?.remove(); } }, icon("x", 10))),
          n.body ? h("p", n.body) : null)),
      ]) : [h("div.dim", { style: { fontSize: "11.5px" } }, "Nothing to report. Supervised processes and agents announce themselves here when they finish — and it stays until you dismiss it.")]),
    );
    return h("div.os-overlay", { style: { background: "transparent", backdropFilter: "none" }, onclick: hideOverlay }, panel);
  }

  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86_400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86_400)}d`;
  };

  // ── spotlight ─────────────────────────────────────────────────────────────

  /** File paths, fetched once per spotlight open and filtered locally. */
  let fileIndex = null;
  async function indexFiles() {
    if (fileIndex) return fileIndex;
    try {
      const r = await api.mcp("fs", "tree", { path: ".", depth: 4, limit: 1200 });
      const out = [];
      const walk = (nodes) => {
        for (const n of nodes ?? []) {
          if (n.type === "dir") walk(n.children);
          else out.push(n.path);
        }
      };
      walk(r.tree ?? r.children ?? r.entries);
      fileIndex = out;
    } catch { fileIndex = []; }
    return fileIndex;
  }

  function spotlight() {
    const input = h("input", { placeholder: "Search apps, files, widgets, themes, actions…", autofocus: true });
    const results = h("div.results");
    let cursor = 0;
    let rows = [];

    const actions = () => {
      const d = os.doc;
      const out = [];
      for (const a of os.snap.apps ?? []) {
        out.push({ name: a.name, sub: a.builtin ? "Application" : a.kind === "alias" ? "Alias" : "Custom app", icon: a.icon, run: () => launch(a.id) });
        if (!a.builtin && a.kind === "bundle") out.push({ name: `Edit ${a.name} source`, sub: "Studio · Code", icon: "code", run: () => { location.href = `/${slug}/studio#code=app:${a.id}`; } });
        for (const t of a.mcp?.live ? a.mcp.tools : []) {
          out.push({ name: `${a.mcp.name}.${t}`, sub: `Tool · ${a.name}`, icon: "play", run: async () => {
            try { const r = await api.mcp(a.mcp.name, t, {}); toast(`${a.mcp.name}.${t}`, { body: JSON.stringify(r).slice(0, 200), kind: "ok", timeout: 6000 }); }
            catch (e) { toastError(`${a.mcp.name}.${t} failed`, e); }
          } });
        }
      }
      for (const p of recentFiles()) out.push({ name: p.split("/").pop(), sub: `Recent · ${p}`, icon: "files", run: () => launch(appFor(p) ?? "files", { path: p }) });
      for (const w of os.snap.widgetKinds ?? []) out.push({ name: `Add ${w.name}`, sub: "Widget", icon: w.icon, run: () => call("widgetAdd", { kind: w.kind }) });
      for (const t of os.snap.themes ?? []) out.push({ name: `${t.name} theme`, sub: "Theme", icon: "theme", run: () => call("themeSet", { theme: t.key }) });
      for (const a of os.snap.animations ?? []) out.push({ name: `${a.name} motion`, sub: "Animation", icon: "play", run: () => call("animationSet", { preset: a.key }) });
      for (const w of d.windows.filter((x) => x.ws === d.activeWorkspace)) {
        out.push({ name: w.title, sub: "Window", icon: "window", run: () => call("focus", { id: w.id }) });
      }
      out.push(
        { name: "Tile the windows", sub: "Layout", icon: "grid", run: () => call("layoutSet", { mode: "tiling" }) },
        { name: "Float the windows", sub: "Layout", icon: "window", run: () => call("layoutSet", { mode: "floating" }) },
        { name: "Arrange in a grid", sub: "Layout", icon: "grid", run: () => call("arrange", { preset: "grid", viewport: wm.viewport() }) },
        { name: "Master and stack", sub: "Layout", icon: "grid", run: () => call("arrange", { preset: "master-stack", viewport: wm.viewport() }) },
        { name: "Columns", sub: "Layout", icon: "grid", run: () => call("arrange", { preset: "columns", viewport: wm.viewport() }) },
        { name: "Rows", sub: "Layout", icon: "grid", run: () => call("arrange", { preset: "rows", viewport: wm.viewport() }) },
        { name: "Focus the front window", sub: "Layout", icon: "window", run: () => call("arrange", { preset: "fullscreen-focus" }) },
        { name: "Show desktop", sub: "Layout", icon: "window", run: () => call("minimizeAll", {}) },
        { name: "New workspace", sub: "Workspace", icon: "plus", run: () => call("workspaceAdd", {}) },
        { name: "Open the Studio", sub: "Build", icon: "layers", run: () => ctx.openStudio?.() },
        ...["library", "layers", "theme", "motion", "code"].map((t) => ({ name: `Studio · ${t[0].toUpperCase()}${t.slice(1)}`, sub: "Build", icon: "layers", run: () => { location.href = `/${slug}/studio#tab=${t}`; } })),
        { name: "Publish this OS as a distro", sub: "Distros", icon: "layers", run: async () => {
          const name = prompt("Distro name", d.name);
          if (!name) return;
          try { const r = await call("distroPublish", { name, replace: true }); toast(`Published ${r.name}`, { kind: "ok" }); } catch (e) { toastError("Could not publish", e); }
        } },
        { name: "Keyboard shortcuts", sub: "Help", icon: "apps", run: () => showOverlay("keys", cheatSheet) },
        { name: "Command Central", sub: "Machine", icon: "shell", run: () => { location.href = `/${slug}`; } },
      );
      return out;
    };

    const all = actions();

    function paint() {
      const q = input.value.trim().toLowerCase();
      const matched = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q)) : all;
      const fileRows = q.length >= 2
        ? (fileIndex ?? []).filter((p) => p.toLowerCase().includes(q)).slice(0, 5).map((p) => ({
            name: p.split("/").pop(), sub: p, icon: "files",
            run: () => { rememberFile(p); launch(appFor(p) ?? "files", { path: p }); },
          }))
        : [];
      rows = [...matched.slice(0, 8 - fileRows.length), ...fileRows];
      cursor = Math.min(cursor, Math.max(0, rows.length - 1));
      fill(results, ...(rows.length ? rows.map((r, i) => h("button.spot-row", {
        class: i === cursor ? "on" : "",
        onclick: () => { hideOverlay(); r.run(); },
      }, h("span", { style: { color: "var(--os-accent)", display: "flex" } }, icon(iconName(r.icon), 16)),
        h("span.nm", r.name), h("span.sub", r.sub)))
        : [h("div.dim", { style: { padding: "12px", fontSize: "11.5px" } }, "Nothing matches.")]));
    }

    input.addEventListener("input", paint);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(rows.length - 1, cursor + 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); const r = rows[cursor]; hideOverlay(); r?.run(); }
      else if (e.key === "Escape") hideOverlay();
    });
    paint();
    indexFiles().then(paint);
    setTimeout(() => input.focus(), 0);

    return h("div.os-overlay.top", { onclick: hideOverlay },
      h("div.os-panel.os-spotlight", { onclick: (e) => e.stopPropagation() },
        h("div.search", null, h("span", { style: { color: "var(--os-text-3)", display: "flex" } }, icon("search", 18)), input),
        results));
  }

  /** Files opened from Spotlight, most recent first. Chrome, not desktop truth. */
  const RECENT_KEY = `sbx.os.recent.${slug}`;
  function recentFiles() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 6); } catch { return []; } }
  function rememberFile(p) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([p, ...recentFiles().filter((x) => x !== p)].slice(0, 12))); } catch { /* private mode */ }
  }

  // ── the cheat sheet, generated from the keymap ────────────────────────────
  //
  // It reads `shell.keys` rather than a hardcoded list, so a rebinding shows up
  // here instead of quietly making this page a lie (goal.md T3.2).
  function cheatSheet() {
    const keys = os.doc?.shell?.keys ?? {};
    const bound = Object.entries(KEY_ACTIONS)
      .filter(([action]) => keys[action])
      .map(([action, what]) => [prettyChord(keys[action]), what]);
    const fixed = [
      ["⌘1…9", "Switch workspace"],
      ["Drag to an edge", "Snap to a half, a quarter, or full"],
      ["Drag a sash", "Resize a tiled split"],
      ["Studio: ⌘⇧P", "Studio actions"],
      ["Studio: ⇧-click", "Multi-select; arrows nudge, ⇧ ×5"],
      ["Studio: ⌘S", "Save the file in Code"],
    ];
    const unbound = Object.entries(KEY_ACTIONS).filter(([action]) => !keys[action]);
    return h("div.os-overlay.center", { onclick: hideOverlay },
      h("div.os-panel.os-keys", { onclick: (e) => e.stopPropagation() },
        h("div.os-label", "Keyboard"),
        h("div.keys-grid", ...[...bound, ...fixed].flatMap(([k, what]) => [h("kbd", k), h("span", what)])),
        unbound.length
          ? h("div.dim", { style: { fontSize: "10.5px", marginTop: "8px" } },
              `Unbound: ${unbound.map(([, what]) => what.toLowerCase()).join(", ")}. Settings → Desktop → Keyboard.`)
          : null,
        h("div.dim", { style: { fontSize: "10.5px", marginTop: "10px" } }, "Every shortcut is a desktop.* call the menus also make, and the map lives in the document — remap it, and this sheet follows.")));
  }

  // ── keyboard ──────────────────────────────────────────────────────────────
  //
  // An OS you can only drive with a mouse is a mock-up of one. Every shortcut
  // below is the same `desktop.*` call the menus make.

  /** What each keyboard action does. One place, so the map is the whole story. */
  const ACTIONS = {
    spotlight: () => showOverlay("spotlight", spotlight),
    cheatSheet: () => toggleOverlay("keys", cheatSheet),
    notifications: () => toggleOverlay("notifs", notifPanel),
    toggleDnd: () => {
      const on = !os.doc.shell.notifications.dnd;
      call("shellSet", { notifications: { dnd: on } })
        .then(() => toast(on ? "Do not disturb" : "Notifications on", {
          body: on ? "Everything is still recorded; nothing will interrupt you." : "Interruptions are back.",
          timeout: 2600,
        }))
        .catch((err) => toastError("Could not change that", err));
    },
    closeWindow: (win) => win && call("close", { id: win.id }),
    minimizeWindow: (win) => win && call("windowSet", { id: win.id, min: true }),
    minimizeAll: () => call("minimizeAll", {}),
    zoomWindow: (win) => win && call("windowSet", { id: win.id, max: !win.max }),
    unzoomWindow: (win) => win && call("windowSet", { id: win.id, max: false }),
    snapLeft: (win) => win && call("snap", { id: win.id, region: "left", viewport: wm.viewport() }),
    snapRight: (win) => win && call("snap", { id: win.id, region: "right", viewport: wm.viewport() }),
    cycleFocus: () => call("cycleFocus", { direction: "next" }),
    cycleFocusBack: () => call("cycleFocus", { direction: "prev" }),
  };

  /** Which action this event is, according to the document's keymap. */
  function actionFor(e) {
    const keys = os.doc?.shell?.keys ?? {};
    for (const [action, chord] of Object.entries(keys)) {
      if (chord && matchesChord(chord, e)) return action;
    }
    return null;
  }

  function onKey(e) {
    if (e.key === "Escape" && openOverlay) { hideOverlay(); return; }
    const typing = !!e.target.closest("input, textarea, select, [contenteditable], .term-screen");

    const action = actionFor(e);
    if (action && ACTIONS[action]) {
      // A bare key (like `?`) belongs to whatever you are typing into; a chord
      // with a modifier belongs to the OS.
      if (typing && !/(?:^|\+)(?:mod|alt)\+/.test(os.doc.shell.keys[action] ?? "")) return;
      const win = wm.focused();
      const needsWindow = ["closeWindow", "minimizeWindow", "zoomWindow", "unzoomWindow", "snapLeft", "snapRight"].includes(action);
      if (needsWindow && !win) return;
      e.preventDefault();
      ACTIONS[action](win);
      return;
    }

    // ⌘1…⌘9 — workspaces. Not in the map: they are positional, not named, and
    // there are as many of them as the document has workspaces.
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (os.doc.workspaces.some((w) => w.n === n)) {
        e.preventDefault();
        call("workspaceSwitch", { n });
      }
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  desktopEl.addEventListener("pointerdown", (e) => {
    if (e.target === desktopEl) {
      hideOverlay();
      if (os.design) ctx.onSelect?.(null, null);
    }
  });
  desktopEl.addEventListener("contextmenu", (e) => {
    if (e.target !== desktopEl) return;
    e.preventDefault();
    menu({ x: e.clientX, y: e.clientY }, [
      { label: "Applications…", icon: "apps", run: () => showOverlay("launcher", launcher) },
      { label: "Search…", icon: "search", key: "⌘K", run: () => showOverlay("spotlight", spotlight) },
      "-",
      { label: "Arrange in a grid", icon: "grid", run: () => call("arrange", { preset: "grid", viewport: wm.viewport() }) },
      { label: os.doc.wm.mode === "tiling" ? "Float the windows" : "Tile the windows", icon: "window",
        run: () => call("layoutSet", { mode: os.doc.wm.mode === "tiling" ? "floating" : "tiling" }) },
      { label: "Show desktop", run: () => call("minimizeAll", {}) },
      "-",
      { label: "Open the Studio", icon: "layers", run: () => ctx.openStudio?.() },
    ]);
  });

  document.addEventListener("keydown", onKey);

  // A viewer who asked their OS for less motion gets it, unless this document
  // explicitly says the preset wins. Decided per viewer, written nowhere.
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  function applyMotionPreference() {
    const calm = !!reduced?.matches && os.doc.animation?.reducedMotion !== "ignore";
    document.documentElement.classList.toggle("os-calm", calm);
  }
  reduced?.addEventListener?.("change", () => { if (os.doc) applyMotionPreference(); });

  let lastTheme = null;
  function render() {
    if (!os.doc) return;
    applyMotionPreference();
    renderMenubar();
    renderDock();
    wm.render();
    if (lastTheme !== os.doc.theme.base) { lastTheme = os.doc.theme.base; broadcast("theme", { theme: lastTheme }); }
    const hint = el.querySelector(".os-hint");
    if (os.design && !hint) {
      desktopEl.append(h("div.os-hint", "Drag windows and widgets · click to select · edit in the Inspector →"));
    } else if (!os.design && hint) hint.remove();
  }

  return {
    el, render, desktop: desktopEl, launch, hideOverlay,
    viewport: () => wm.viewport(),
    focused: () => wm.focused(),
    spotlight: () => showOverlay("spotlight", spotlight),
    destroy() { document.removeEventListener("keydown", onKey); wm.destroy(); },
  };
}
