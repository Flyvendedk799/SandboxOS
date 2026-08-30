// builder.js — the Studio's left half: the library you build from, the layers
// you already built, the theme you wear, and the code behind anything custom.
//
// Nothing here keeps its own model of the desktop. Every control is a thin
// wrapper over a `desktop.*` call, and every panel re-reads the document after
// the change lands. That is why the Studio and the running OS can be open in two
// tabs, or the agent can be building while you are, without either going stale.

import { h, fill, icon, dialog, confirmDialog, menu, toast, toastError, fmtBytes } from "../core.js";
import { os, call, select, loadOs, tint, onOs } from "./client.js";
import { iconName, ICON_NAMES } from "./sprite.js";
import { dropSession } from "./frames.js";

const CATEGORIES = [
  { id: "apps", name: "Apps" },
  { id: "widgets", name: "Widgets" },
  { id: "themes", name: "Themes" },
  { id: "anim", name: "Animations" },
  { id: "distros", name: "Distros" },
];

const ICON_CHOICES = ICON_NAMES;

const ACCENTS = ["#35d6c4", "#3ec8ff", "#b98cff", "#ff8f5e", "#43d17f", "#e8c98a", "#ff6b6b", "#e6edf3"];

export function createBuilder({ onOpenCode } = {}) {
  let tab = "library";
  let cat = "apps";

  const tabs = h("div.stx-tabs");
  const pane = h("div.stx-pane");
  const el = h("aside.stx-builder", null, tabs, pane);

  const setTab = (t) => { tab = t; render(); };
  const setCat = (c) => { cat = c; render(); };

  // ── Library ───────────────────────────────────────────────────────────────

  function libraryApps() {
    const apps = os.snap.apps ?? [];
    return h("div", null,
      h("div.card-grid", ...apps.map((a) => h("button.lib-card", {
        title: a.builtin ? "Open" : `${a.kind} app · ${a.permissions.join(", ") || "no capabilities"}`,
        onclick: () => call("open", { app: a.id }).catch((e) => toastError(`Could not open ${a.name}`, e)),
        oncontextmenu: (e) => { e.preventDefault(); if (!a.builtin) appMenu(a, e); },
      },
        h("span.glyph", { style: { background: tint(a.hue, 0.14), color: a.hue } }, icon(iconName(a.icon), 18)),
        h("span.nm", a.name),
        a.builtin ? null : h("span.sub", a.kind === "url" ? "url" : "custom"),
      ))),
      h("button.ghost.wide", { style: { marginTop: "10px" }, onclick: newApp }, "New app…"),
      h("div.note", null,
        "A custom app is HTML, CSS and JS this machine serves into a sandboxed frame. It gets exactly the capabilities you declare, and no credential — the shell brokers its calls."),
    );
  }

  function libraryWidgets() {
    const kinds = os.snap.widgetKinds ?? [];
    return h("div", null,
      h("div.card-grid", ...kinds.map((w) => h("button.lib-card", {
        onclick: () => call("widgetAdd", { kind: w.kind }).catch((e) => toastError("Could not add the widget", e)),
        oncontextmenu: (e) => { e.preventDefault(); if (!w.builtin) widgetMenu(w); },
      },
        h("span.glyph", { style: { background: "var(--stx-accent-dim)", color: "var(--stx-accent)" } }, icon(iconName(w.icon), 17)),
        h("span.nm", w.name),
        w.builtin ? null : h("span.sub", "custom"),
      ))),
      h("button.ghost.wide", { style: { marginTop: "10px" }, onclick: newWidget }, "New widget…"),
    );
  }

  function libraryThemes() {
    const themes = os.snap.themes ?? [];
    return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      ...themes.map((t) => h("button.lib-row", {
        class: t.key === os.doc.theme.base ? "on" : "",
        onclick: () => call("themeSet", { theme: t.key }),
        oncontextmenu: (e) => { e.preventDefault(); if (!t.builtin) themeMenu(t); },
      },
        h("span.swatch", { style: { background: t.wall ?? t.accent } }),
        h("span", { style: { flex: "1", minWidth: "0" } }, h("span.nm", t.name), h("span.sub", t.accent)),
        h("span", { style: { width: "14px", height: "14px", borderRadius: "50%", background: t.accent } }),
      )),
      h("button.ghost.wide", { style: { marginTop: "4px" }, onclick: newTheme }, "New theme…"),
    );
  }

  function libraryAnimations() {
    const list = os.snap.animations ?? [];
    return h("div.card-grid", ...list.map((a) => h("button.lib-row", {
      class: a.key === os.doc.animation.preset ? "on" : "",
      style: { justifyContent: "space-between" },
      onclick: () => call("animationSet", { preset: a.key }),
    },
      h("span.nm", a.name),
      h("span", { style: { color: "var(--stx-accent)", display: "flex" } }, icon("play", 15)),
    )));
  }

  function libraryDistros() {
    const list = os.snap.distros ?? [];
    return h("div", { style: { display: "flex", flexDirection: "column", gap: "9px" } },
      ...list.map((d) => h("div.distro-card", null,
        h("div.hd", null,
          h("span.tag", { style: { background: d.hue ?? "var(--stx-accent)" } }),
          h("h4", d.name),
          d.builtin ? null : h("span.sub", { style: { fontSize: "10px", color: "var(--stx-text-3)" } }, "yours")),
        h("p", d.description || "No description."),
        h("button.ghost", { onclick: () => fork(d) }, "Fork this distro"),
      )),
      h("button.ghost.wide", { style: { marginTop: "4px" }, onclick: publish }, "Publish this OS as a distro…"),
      h("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
        h("button.ghost", { style: { flex: "1" }, onclick: exportFile }, "Export file"),
        h("button.ghost", { style: { flex: "1" }, onclick: importFile }, "Import file")),
      h("div.note", "Publishing packages the document and the source of every custom app, so a fork gets your machine, not a screenshot of it. Export writes the same package to a file, which is how a distro leaves your tenant."),
    );
  }

  /** A distro as a file: the only way one travels between tenants today. */
  async function exportFile() {
    try {
      const { payload } = await call("distroExport", { name: os.doc.name });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `${slugify(os.doc.name) || "os"}.sandboxos.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast("Exported", { body: "The document and every custom app's source are in the file.", kind: "ok" });
    } catch (e) { toastError("Could not export", e); }
  }

  async function importFile() {
    const input = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (!await confirmDialog(`Install ${file.name}?`, "It replaces your current desktop. The change is one revision — undo it from Layers → History.")) return;
      try {
        const payload = JSON.parse(await file.text());
        const r = await call("distroImport", { payload });
        await loadOs();
        toast("Installed", { body: `${r.apps} custom apps came with it.`, kind: "ok" });
      } catch (e) { toastError("Could not install that file", e); }
    });
    document.body.append(input);
    input.click();
  }

  async function fork(d) {
    if (!await confirmDialog("Fork this distro?", `Your current desktop is replaced by ${d.name}. The change is one revision — undo it from the History tab.`, { confirmLabel: "Fork", danger: false })) return;
    try {
      await call("distroFork", { id: d.id });
      await loadOs();
      toast(`Forked ${d.name}`, { kind: "ok" });
    } catch (e) { toastError("Could not fork that distro", e); }
  }

  async function publish() {
    const got = await dialog({
      title: "Publish this OS as a distro",
      message: "Anyone in your tenant can fork it. The document and every custom app's source travel with it.",
      fields: [
        { name: "name", label: "Name", value: os.doc.name },
        { name: "description", label: "Description", placeholder: "What is this machine for?" },
      ],
      confirmLabel: "Publish",
    });
    if (!got?.name) return;
    try {
      const r = await call("distroPublish", { name: got.name, description: got.description, replace: true });
      await loadOs();
      toast(`Published ${r.name}`, { body: `${r.apps} custom apps packaged.`, kind: "ok" });
    } catch (e) { toastError("Could not publish", e); }
  }

  // ── creating things ───────────────────────────────────────────────────────

  const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  async function newApp() {
    const got = await dialog({
      title: "New app",
      message: "You get a runnable starter — an index.html, a stylesheet and a script that already calls the machine. Edit it in Code.",
      fields: [
        { name: "name", label: "Name", placeholder: "Port Monitor" },
        { name: "id", label: "Id", placeholder: "port-monitor", hint: "lowercase, used in the URL" },
        { name: "permissions", label: "Capabilities", placeholder: "fs.read, ports.list", hint: "MCP patterns this app may call" },
      ],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    const id = slugify(got.id || got.name);
    try {
      await call("appDefine", {
        id, name: got.name,
        permissions: String(got.permissions ?? "").split(/[,\s]+/).filter(Boolean),
      });
      await loadOs();
      dropSession(id);
      await call("dockPin", { app: id, pinned: true });
      onOpenCode?.("app", id);
      toast(`${got.name} created`, { body: "Open it from the dock; edit its source in Code.", kind: "ok" });
    } catch (e) { toastError("Could not create the app", e); }
  }

  async function newWidget() {
    const got = await dialog({
      title: "New widget",
      message: "A widget is a small frame with no chrome. It gets the same brokered access an app does.",
      fields: [
        { name: "name", label: "Name", placeholder: "Build status" },
        { name: "kind", label: "Id", placeholder: "build-status" },
        { name: "permissions", label: "Capabilities", placeholder: "metrics.snapshot" },
      ],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    const kind = slugify(got.kind || got.name);
    try {
      await call("widgetDefine", {
        kind, name: got.name,
        permissions: String(got.permissions ?? "").split(/[,\s]+/).filter(Boolean),
      });
      await loadOs();
      await call("widgetAdd", { kind });
      onOpenCode?.("widget", kind);
    } catch (e) { toastError("Could not create the widget", e); }
  }

  async function newTheme() {
    const base = os.doc.theme.base;
    const got = await dialog({
      title: "New theme",
      message: "Start from the theme you are wearing and change what you like. Tokens are colours; the wallpaper is a CSS gradient.",
      fields: [
        { name: "name", label: "Name", placeholder: "Deep Water" },
        { name: "key", label: "Id", placeholder: "deep-water" },
        { name: "accent", label: "Accent", value: os.snap.theme.accent },
        { name: "bg0", label: "Background", value: os.snap.theme.bg0 },
      ],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    const key = slugify(got.key || got.name);
    try {
      await call("themeDefine", {
        key, name: got.name, base: os.snap.themes.find((t) => t.key === base)?.builtin ? base : "midnight",
        tokens: { accent: got.accent, bg0: got.bg0 },
      });
      await call("themeSet", { theme: key });
      await loadOs();
    } catch (e) { toastError("Could not create the theme", e); }
  }

  /** Edit an app's definition after the fact — name, icon, capabilities, size.
   *  `appDefine` is an upsert, so this is the same call that created it. */
  async function appSettings(a) {
    const got = await dialog({
      title: `${a.name} settings`,
      message: a.kind === "bundle"
        ? "Capabilities are MCP patterns. An app can never hold more than the person who opens it."
        : "A URL app is a page from somewhere else; it gets no capabilities from this machine.",
      fields: [
        { name: "name", label: "Name", value: a.name },
        { name: "icon", label: "Icon", type: "select", value: a.icon,
          options: ICON_CHOICES.map((i) => ({ value: i, label: i })) },
        { name: "hue", label: "Accent", value: a.hue },
        { name: "permissions", label: "Capabilities", value: (a.permissions ?? []).join(", "),
          hint: "e.g. fs.read, ports.list" },
        { name: "size", label: "Default size", value: `${a.window.w}x${a.window.h}` },
      ],
      confirmLabel: "Save",
    });
    if (!got?.name) return;
    const [w, hh] = String(got.size).split(/[x×,\s]+/).map((n) => Number(n) || 0);
    try {
      await call("appDefine", {
        id: a.id,
        name: got.name,
        icon: got.icon,
        hue: got.hue,
        permissions: String(got.permissions ?? "").split(/[,\s]+/).filter(Boolean),
        window: { w: w || a.window.w, h: hh || a.window.h },
      });
      dropSession(a.id); // its capability set may have changed
      await loadOs();
      toast(`${got.name} updated`, { kind: "ok" });
    } catch (e) { toastError("Could not update the app", e); }
  }

  function appMenu(a, ev) {
    menu({ x: ev?.clientX ?? 200, y: ev?.clientY ?? 200 }, [
      { label: "Open", icon: "window", run: () => call("open", { app: a.id }) },
      { label: "Settings…", icon: "settings", run: () => appSettings(a) },
      { label: "Edit source", icon: "code", disabled: a.kind !== "bundle", run: () => onOpenCode?.("app", a.id) },
      { label: os.doc.shell.dock.pinned.includes(a.id) ? "Remove from dock" : "Keep in dock", icon: "apps",
        run: () => call("dockPin", { app: a.id, pinned: !os.doc.shell.dock.pinned.includes(a.id) }) },
      "-",
      { label: "Delete app", icon: "trash", danger: true, run: async () => {
        if (!await confirmDialog(`Delete ${a.name}?`, "Its source and every open window go with it.")) return;
        await call("appRemove", { id: a.id });
        await loadOs();
      } },
    ]);
  }

  function widgetMenu(w) {
    confirmDialog(`Delete ${w.name}?`, "Its source and every placed instance go with it.").then(async (ok) => {
      if (!ok) return;
      await call("widgetKindRemove", { kind: w.kind });
      await loadOs();
    });
  }

  function themeMenu(t) {
    confirmDialog(`Delete the ${t.name} theme?`, "Anything wearing it falls back to Midnight.").then(async (ok) => {
      if (!ok) return;
      await call("themeRemove", { key: t.key });
      await loadOs();
    });
  }

  // ── Layers ────────────────────────────────────────────────────────────────

  function layers() {
    const d = os.doc;
    const here = (list) => list.filter((x) => x.ws === d.activeWorkspace);
    const row = (id, kind, name, sub, ic) => h("button.layer-row", {
      class: os.sel.id === id ? "on" : "",
      onclick: () => { select(id, kind); if (kind === "win") call("focus", { id }).catch(() => {}); },
    }, icon(iconName(ic), 15), h("span.nm", name), h("span.sub", sub));

    const wins = here(d.windows).sort((a, b) => b.z - a.z);
    const gs = here(d.widgets);
    return h("div", null,
      h("div.section-label", `Windows · workspace ${d.activeWorkspace}`),
      ...(wins.length ? wins.map((w) => row(w.id, "win", w.title, w.app, (os.snap.apps.find((a) => a.id === w.app) ?? {}).icon ?? "window"))
        : [h("div.dim", { style: { padding: "4px 8px", fontSize: "11px" } }, "No windows here yet.")]),
      h("div.section-label.tight", "Widgets"),
      ...(gs.length ? gs.map((g) => row(g.id, "widget", (os.snap.widgetKinds.find((k) => k.kind === g.kind) ?? {}).name ?? g.kind, "widget",
        (os.snap.widgetKinds.find((k) => k.kind === g.kind) ?? {}).icon ?? "apps"))
        : [h("div.dim", { style: { padding: "4px 8px", fontSize: "11px" } }, "No widgets here yet.")]),
      h("div.section-label.tight", "History"),
      h("div", { id: "os-history" }),
    );
  }

  async function paintHistory(host) {
    if (!host) return;
    try {
      const r = await call("history", {});
      fill(host, ...(r.revisions.slice(0, 8).map((rev) => h("button.layer-row", {
        onclick: async () => { await call("revert", { rev: rev.rev }); await loadOs(); },
      }, icon("refresh", 14), h("span.nm", rev.label || `rev ${rev.rev}`), h("span.sub", `r${rev.rev}`)))
        || [h("div.dim", "No history yet.")]));
    } catch { /* history is a nicety */ }
  }

  // ── Theme tab ─────────────────────────────────────────────────────────────

  function themeTab() {
    const t = os.snap.theme;
    const swatch = (c) => h("button.swatch-btn", {
      class: c.toLowerCase() === String(t.accent).toLowerCase() ? "on" : "",
      title: c, style: { background: c },
      onclick: () => call("themeSet", { tokens: { accent: c } }),
    });

    const wallInput = h("input", { value: t.wall ?? "", placeholder: "linear-gradient(160deg,#06131d,#0a2233)" });
    wallInput.addEventListener("change", () => call("wallpaperSet", { wallpaper: wallInput.value })
      .catch((e) => toastError("That wallpaper was rejected", e)));

    return h("div", null,
      h("div.section-label", "Base theme"),
      h("div.card-grid", { style: { marginBottom: "18px" } }, ...(os.snap.themes ?? []).map((th) =>
        h("button.lib-row", {
          class: th.key === os.doc.theme.base ? "on" : "",
          style: { flexDirection: "column", alignItems: "stretch", gap: "7px", padding: "8px" },
          onclick: () => call("themeSet", { theme: th.key }),
        },
          h("span", { style: { height: "34px", borderRadius: "7px", background: th.wall ?? th.accent, border: "1px solid var(--stx-line)" } }),
          h("span.nm", { style: { fontSize: "11px" } }, th.name)))),
      h("div.section-label", "Accent token"),
      h("div.swatch-row", ...ACCENTS.map(swatch)),
      h("div.field", { style: { marginTop: "18px" } }, h("label", "Wallpaper"), wallInput),
      h("div.section-label", "Motion"),
      h("div.card-grid", ...(os.snap.animations ?? []).map((a) => h("button.lib-row", {
        class: a.key === os.doc.animation.preset ? "on" : "",
        style: { justifyContent: "space-between" },
        onclick: () => call("animationSet", { preset: a.key }),
      }, h("span.nm", { style: { fontSize: "11px" } }, a.name)))),
      h("div.note", null,
        "Theme edits write ", h("code", "theme"), " tokens into the document and rebind every window, dock and widget live — including custom apps, which link the same compiled stylesheet."),
    );
  }

  // ── Code tab ──────────────────────────────────────────────────────────────

  let codeTarget = null; // {kind:'app'|'widget', id}
  let codeFile = null;

  function openCode(kind, id) { codeTarget = { kind, id }; codeFile = null; setTab("code"); }

  function codeTab() {
    const custom = [
      ...Object.values(os.doc.apps).map((a) => ({ kind: "app", id: a.id, name: a.name, icon: a.icon })),
      ...Object.values(os.doc.widgetKinds).map((w) => ({ kind: "widget", id: w.kind, name: w.name, icon: w.icon })),
    ];
    if (!custom.length) {
      return h("div.empty", null, icon("code", 26), h("h3", "Nothing custom yet"),
        h("p", "Create an app or a widget in the Library and its source appears here — or ask the agent to write one."));
    }
    if (!codeTarget || !custom.some((c) => c.kind === codeTarget.kind && c.id === codeTarget.id)) {
      codeTarget = { kind: custom[0].kind, id: custom[0].id };
      codeFile = null;
    }

    const picker = h("select", null, ...custom.map((c) =>
      h("option", { value: `${c.kind}:${c.id}`, selected: c.kind === codeTarget.kind && c.id === codeTarget.id }, c.name)));
    picker.addEventListener("change", () => {
      const [kind, id] = picker.value.split(":");
      codeTarget = { kind, id };
      codeFile = null;
      render();
    });

    const fileList = h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", margin: "10px 0" } });
    const editor = h("textarea", { spellcheck: "false", style: { minHeight: "220px", fontFamily: "var(--mono)", fontSize: "11px" } });
    const saveBtn = h("button.ghost.wide", { onclick: saveFile }, "Save file");
    const status = h("div.dim", { style: { fontSize: "10.5px", marginTop: "6px" } }, "");

    const readTool = codeTarget.kind === "widget" ? "widgetRead" : "appRead";
    const listTool = codeTarget.kind === "widget" ? "widgetFiles" : "appFiles";
    const writeTool = codeTarget.kind === "widget" ? "widgetWrite" : "appWrite";
    const key = codeTarget.kind === "widget" ? { kind: codeTarget.id } : { id: codeTarget.id };

    async function loadFiles() {
      try {
        const r = await call(listTool, key);
        codeFile ??= r.files[0]?.path ?? null;
        fill(fileList, ...r.files.map((f) => h("button.layer-row", {
          class: f.path === codeFile ? "on" : "",
          onclick: () => { codeFile = f.path; loadFile(); paintFileList(r.files); },
        }, icon("code", 14), h("span.nm", f.path), h("span.sub", fmtBytes(f.size)))));
        if (codeFile) loadFile();
      } catch (e) { status.textContent = e.message; }
    }
    function paintFileList(files) {
      for (const btn of fileList.children) {
        btn.classList.toggle("on", btn.querySelector(".nm")?.textContent === codeFile);
      }
      void files;
    }
    async function loadFile() {
      if (!codeFile) return;
      try {
        const r = await call(readTool, { ...key, path: codeFile });
        editor.value = r.content;
        status.textContent = `${codeFile} · ${r.bytes} bytes`;
      } catch (e) { status.textContent = e.message; }
    }
    async function saveFile() {
      if (!codeFile) return;
      try {
        await call(writeTool, { ...key, path: codeFile, content: editor.value });
        status.textContent = `saved ${codeFile}`;
        toast("Saved", { body: `${codeFile} — reopen the app to see it.`, kind: "ok" });
      } catch (e) { toastError("Could not save", e); }
    }

    async function addFile() {
      const got = await dialog({ title: "New file", fields: [{ name: "path", label: "Path", placeholder: "panel.js" }], confirmLabel: "Create" });
      if (!got?.path) return;
      try {
        await call(writeTool, { ...key, path: got.path, content: "" });
        codeFile = got.path;
        loadFiles();
      } catch (e) { toastError("Could not create the file", e); }
    }

    loadFiles();

    return h("div", null,
      h("div.field", null, h("label", "Editing"), picker),
      fileList,
      h("button.ghost", { onclick: addFile }, "Add file"),
      h("div.field", { style: { marginTop: "10px" } }, h("label", "Source"), editor),
      saveBtn,
      status,
      h("div.note", "Ask the agent to write here too — ", h("code", "desktop.appWrite"), " is the same call this button makes."),
    );
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    if (!os.doc) return;
    fill(tabs, ...[["library", "Library"], ["layers", "Layers"], ["theme", "Theme"], ["code", "Code"]].map(([id, label]) =>
      h("button.seg", { class: tab === id ? "on" : "", onclick: () => setTab(id) }, label)));

    if (tab === "library") {
      const body = cat === "apps" ? libraryApps()
        : cat === "widgets" ? libraryWidgets()
          : cat === "themes" ? libraryThemes()
            : cat === "anim" ? libraryAnimations()
              : libraryDistros();
      fill(pane,
        h("div.chip-row", ...CATEGORIES.map((c) =>
          h("button.chip", { class: cat === c.id ? "on" : "", onclick: () => setCat(c.id) }, c.name))),
        h("div.stx-scroll", body));
    } else if (tab === "layers") {
      const body = layers();
      fill(pane, h("div.stx-scroll", { style: { paddingTop: "12px" } }, body));
      paintHistory(pane.querySelector("#os-history"));
    } else if (tab === "theme") {
      fill(pane, h("div.stx-scroll", { style: { paddingTop: "14px" } }, themeTab()));
    } else {
      fill(pane, h("div.stx-scroll", { style: { paddingTop: "14px" } }, codeTab()));
    }
  }

  return { el, render, setTab, openCode, get tab() { return tab; } };
}

// ── Inspector ───────────────────────────────────────────────────────────────

export function createInspector() {
  const body = h("div.panel-body");
  const el = h("aside.stx-inspector", null,
    h("div.panel-head", h("h2", "Inspector")),
    body);

  function render() {
    const d = os.doc;
    if (!d) return;
    const { id, kind } = os.sel;
    const item = kind === "win" ? d.windows.find((w) => w.id === id) : d.widgets.find((g) => g.id === id);
    if (!item) {
      fill(body, h("div.empty", null,
        icon("window", 26),
        h("h3", "Nothing selected"),
        h("p", "Click a window or widget in the live OS, or a layer on the left, to edit its properties here.")));
      return;
    }

    const meta = kind === "win"
      ? (os.snap.apps ?? []).find((a) => a.id === item.app)
      : (os.snap.widgetKinds ?? []).find((w) => w.kind === item.kind);

    const numField = (label, key, tool) => {
      const input = h("input", { type: "number", value: item[key] });
      input.addEventListener("change", () => {
        const v = Number(input.value) || 0;
        const args = kind === "widget"
          ? { id, [key]: v }
          : ["x", "y"].includes(key) ? { id, x: key === "x" ? v : item.x, y: key === "y" ? v : item.y }
            : { id, w: key === "w" ? v : item.w, h: key === "h" ? v : item.h };
        call(kind === "widget" ? "widgetSet" : tool, args).catch((e) => toastError("Could not apply", e));
      });
      return h("div.field", null, h("label", label), input);
    };

    const title = h("input", { value: kind === "win" ? item.title : (meta?.name ?? item.kind) });
    if (kind === "win") title.addEventListener("change", () => call("windowSet", { id, title: title.value }));
    else title.disabled = true;

    const wsSel = h("select", null, ...d.workspaces.map((w) =>
      h("option", { value: w.n, selected: w.n === item.ws }, w.name)));
    wsSel.addEventListener("change", () => call(kind === "widget" ? "widgetSet" : "windowSet", { id, ws: Number(wsSel.value) }));

    fill(body,
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" } },
        h("span.kind-tag", kind === "win" ? "Window" : "Widget"),
        h("span", { style: { fontSize: "13px", fontWeight: "600" } }, kind === "win" ? item.app : item.kind)),
      h("div.field", null, h("label", "Title"), title),
      h("div.grid-2", null, numField("X", "x", "move"), numField("Y", "y", "move"), numField("W", "w", "resize"), numField("H", "h", "resize")),
      h("div.field", null, h("label", "Workspace"), wsSel),
      meta && !meta.builtin
        ? h("div.note", { style: { marginTop: "0", marginBottom: "12px" } },
          `Capabilities: ${meta.permissions?.join(", ") || "none"}`)
        : null,
      h("button.ghost.wide.danger", {
        onclick: () => call(kind === "widget" ? "widgetRemove" : "close", { id }).catch((e) => toastError("Could not delete", e)),
      }, "Delete element"),
    );
  }

  onOs(() => render());
  return { el, render };
}
