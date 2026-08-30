// shell.js — the furniture around the desktop: menu bar, dock, launcher,
// notification centre, spotlight, and the keyboard.
//
// All of it is driven by the OS document. The dock is `shell.dock.pinned`, the
// menu bar's title is `shell.menubar.title`, the notification centre is
// `notifications` — so "hide the dock", "put it on the left", "rename the menu"
// are ordinary `desktop.*` calls, and an agent can do every one of them.

import { h, fill, icon, api, slug, menu, toastError } from "../core.js";
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
    ctx: { ...ctx, launch, mark: () => call("arrange", { preset: "grid", viewport: wm.viewport() }) },
  });

  // ── overlay plumbing ──────────────────────────────────────────────────────
  let openOverlay = null;

  function showOverlay(name, node) {
    hideOverlay();
    openOverlay = name;
    overlays.style.pointerEvents = "auto";
    fill(overlays, node);
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

  function renderMenubar() {
    const d = os.doc;
    const unread = d.notifications.filter((n) => !n.read).length;
    const bell = h("button.icon-btn", { title: "Notifications", onclick: () => toggleOverlay("notifs", notifPanel) },
      icon("bell", 14),
      unread ? h("span.os-badge", String(unread)) : null);

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
      d.shell.menubar.showStatus ? icon("wifi", 15) : null,
      d.shell.menubar.showStatus ? icon("battery", 17) : null,
      d.shell.menubar.showClock ? clockEl : null,
    );
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
        style: { width: `${size}px`, height: `${size}px`, background: tint(meta.hue), color: meta.hue },
        onclick: () => (mine.length && mine.every((w) => w.min)
          ? call("focus", { id: mine[0].id })
          : launch(id)),
        oncontextmenu: (e) => { e.preventDefault(); dockMenu(e, meta, mine); },
      }, icon(iconName(meta.icon), Math.round(size / 2)),
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
  function notifPanel() {
    const list = [...os.doc.notifications].reverse();
    call("notificationsRead", {}).catch(() => {});
    const panel = h("div.os-panel.os-notifs", { onclick: (e) => e.stopPropagation() },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" } },
        h("span", { style: { fontSize: "12px", fontWeight: "650" } }, "Notifications"),
        h("button.app-btn", { onclick: () => { call("notificationsClear", {}); hideOverlay(); } }, "Clear")),
      ...(list.length ? list.map((n) => h("div.notif", { class: n.kind },
        h("div.hd", null, h("b", n.title), h("span", ago(n.ts))),
        n.body ? h("p", n.body) : null,
        n.app && n.app !== "system" ? h("span.src", n.app) : null))
        : [h("div.dim", { style: { fontSize: "11.5px" } }, "Nothing to report.")]),
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
      for (const a of os.snap.apps ?? []) out.push({ name: a.name, sub: a.builtin ? "Application" : "Custom app", icon: a.icon, run: () => launch(a.id) });
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
        { name: "Show desktop", sub: "Layout", icon: "window", run: () => call("minimizeAll", {}) },
        { name: "New workspace", sub: "Workspace", icon: "plus", run: () => call("workspaceAdd", {}) },
        { name: "Open the Studio", sub: "Build", icon: "layers", run: () => ctx.openStudio?.() },
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
            run: () => launch(appFor(p) ?? "files", { path: p }),
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

  // ── keyboard ──────────────────────────────────────────────────────────────
  //
  // An OS you can only drive with a mouse is a mock-up of one. Every shortcut
  // below is the same `desktop.*` call the menus make.

  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" && openOverlay) { hideOverlay(); return; }
    if (!mod) return;

    const k = e.key.toLowerCase();
    const win = wm.focused();

    if (k === "k") { e.preventDefault(); showOverlay("spotlight", spotlight); return; }

    // ⌘1…⌘9 — workspaces. Left alone when the OS has fewer.
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (os.doc.workspaces.some((w) => w.n === n)) {
        e.preventDefault();
        call("workspaceSwitch", { n });
      }
      return;
    }

    if (!win) return;
    if (k === "w") { e.preventDefault(); call("close", { id: win.id }); return; }
    if (k === "m") { e.preventDefault(); call("windowSet", { id: win.id, min: true }); return; }
    if (k === "d" && e.shiftKey) { e.preventDefault(); call("minimizeAll", {}); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); call("windowSet", { id: win.id, max: !win.max }); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); call("windowSet", { id: win.id, max: false }); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      call("snap", { id: win.id, region: e.key === "ArrowLeft" ? "left" : "right", viewport: wm.viewport() });
      return;
    }
    if (e.key === "`") { e.preventDefault(); call("cycleFocus", { direction: e.shiftKey ? "prev" : "next" }); }
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

  let lastTheme = null;
  function render() {
    if (!os.doc) return;
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
