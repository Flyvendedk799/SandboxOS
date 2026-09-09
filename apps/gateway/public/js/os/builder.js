// builder.js — the Studio's left half: the library you build from, the layers
// you already built, the theme you wear, and the code behind anything custom.
//
// Nothing here keeps its own model of the desktop. Every control is a thin
// wrapper over a `desktop.*` call, and every panel re-reads the document after
// the change lands. That is why the Studio and the running OS can be open in two
// tabs, or the agent can be building while you are, without either going stale.

import { h, fill, icon, api, dialog, confirmDialog, menu, toast, toastError, fmtBytes } from "../core.js";
import { os, call, select, selected, loadOs, tint, onOs } from "./client.js";
import { iconName, ICON_NAMES } from "./sprite.js";
import { dropSession } from "./frames.js";
import { createCodePane } from "./code.js";
import { createThemeStudio } from "./theme-studio.js";
import { createMotionStudio } from "./motion-studio.js";
import { silhouetteSvg } from "./lib/summary.js";

const TABS = [["library", "Library"], ["layers", "Layers"], ["theme", "Theme"], ["motion", "Motion"], ["code", "Code"]];
const remember = (k, v) => { try { localStorage.setItem(`sbx.studio.${k}`, v); } catch { /* private mode */ } };
const recall = (k, dflt) => { try { return localStorage.getItem(`sbx.studio.${k}`) ?? dflt; } catch { return dflt; } };

const CATEGORIES = [
  { id: "apps", name: "Apps" },
  { id: "widgets", name: "Widgets" },
  { id: "themes", name: "Themes" },
  { id: "anim", name: "Animations" },
  { id: "distros", name: "Distros" },
];

const ICON_CHOICES = ICON_NAMES;

export function createBuilder({ onOpenCode } = {}) {
  let tab = TABS.some(([id]) => id === recall("tab", "library")) ? recall("tab", "library") : "library";
  let cat = "apps";

  const tabs = h("div.stx-tabs");
  const pane = h("div.stx-pane");
  const el = h("aside.stx-builder", null, tabs, pane);

  const codePane = createCodePane({ onTargetChange: (t) => { if (t) remember("code", `${t.kind}:${t.id}`); } });
  const themeStudio = createThemeStudio();
  const motionStudio = createMotionStudio();

  const setTab = (t) => { tab = t; remember("tab", t); render(); };
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
        a.builtin ? null : h("span.sub", [a.kind === "url" ? "url" : a.kind === "alias" ? "alias" : "custom",
          a.mcp ? ` · ${a.mcp.live ? `${a.mcp.tools.length} tool${a.mcp.tools.length === 1 ? "" : "s"}` : a.mcp.enabled ? "tools (not live)" : "tools off"}` : ""].join("")),
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

  // ── the gallery ───────────────────────────────────────────────────────────

  let galleryQ = "";
  let galleryScope = "all";   // all | mine | public
  let galleryRows = null;

  async function loadGallery() {
    try {
      const r = await call("distroList", { q: galleryQ, scope: galleryScope });
      galleryRows = r.distros;
    } catch { galleryRows = os.snap.distros ?? []; }
    render();
  }

  function distroCard(d) {
    const preview = d.preview ?? (d.builtin ? { theme: { accent: d.hue }, windows: d.apps.map((_, i) => ({ x: 60 + i * 120, y: 60 + i * 60, w: 420, h: 280 })), widgets: [], dock: "bottom" } : null);
    const thumb = h("div.distro-thumb");
    if (preview) thumb.innerHTML = silhouetteSvg({ ...preview, label: d.name }, { width: 280, height: 150 });
    const vis = d.builtin ? "seed" : d.visibility ?? "tenant";
    return h("div.distro-card", null,
      thumb,
      h("div.hd", null,
        h("span.tag", { style: { background: d.hue ?? preview?.theme?.accent ?? "var(--stx-accent)" } }),
        h("h4", d.name),
        h("span.vis", { class: vis, title: d.builtin ? "Ships with SandboxOS" : d.mine ? `Published by your tenant · ${vis}` : "Published publicly by another tenant" }, vis),
        d.forks ? h("span.sub", { style: { fontSize: "10px", color: "var(--stx-text-3)" } }, `${d.forks} fork${d.forks === 1 ? "" : "s"}`) : null),
      h("p", d.description || "No description."),
      d.tags?.length ? h("div.tag-row", ...d.tags.map((t) => h("button.tagchip", { onclick: () => { galleryQ = t; loadGallery(); } }, t))) : null,
      preview && !d.builtin ? h("div.dim", { style: { fontSize: "10.5px", margin: "2px 0 8px" } },
        `${preview.windows?.length ?? 0} windows · ${preview.widgets?.length ?? 0} widgets · ${preview.apps ?? 0} custom apps${preview.tools ? ` · ${preview.tools} with tools` : ""}`) : null,
      h("div", { style: { display: "flex", gap: "6px" } },
        h("button.ghost", { style: { flex: "1" }, onclick: () => fork(d) }, "Fork this distro"),
        d.mine && !d.builtin ? h("button.ghost", { title: "Who can see it", onclick: () => visibilityMenu(d) }, icon("eye", 13)) : null),
    );
  }

  async function visibilityMenu(d) {
    const got = await dialog({
      title: `${d.name} · visibility`,
      fields: [{ name: "visibility", label: "Who can see and fork it", type: "select", value: d.visibility ?? "tenant",
        options: [{ value: "private", label: "Only me" }, { value: "tenant", label: "Everyone in my tenant" }, { value: "public", label: "Every tenant on this host (public gallery)" }] }],
      confirmLabel: "Save",
    });
    if (!got?.visibility) return;
    try { await call("distroSet", { name: d.name, visibility: got.visibility }); toast(`${d.name} is now ${got.visibility}`, { kind: "ok" }); loadGallery(); }
    catch (e) { toastError("Could not change visibility", e); }
  }

  function libraryDistros() {
    if (galleryRows === null) { galleryRows = os.snap.distros ?? []; setTimeout(loadGallery, 0); }
    const search = h("input", { value: galleryQ, placeholder: "Search the gallery — name, description, tag" });
    let t = null;
    search.addEventListener("input", () => { galleryQ = search.value; clearTimeout(t); t = setTimeout(loadGallery, 250); });
    const chip = (id, label) => h("button.chip", { class: galleryScope === id ? "on" : "", onclick: () => { galleryScope = id; loadGallery(); } }, label);
    const dropZone = h("div", { style: { display: "flex", flexDirection: "column", gap: "9px" } },
      h("div.field", { style: { marginBottom: "4px" } }, search),
      h("div.chip-row", { style: { padding: "0 0 6px" } }, chip("all", "All"), chip("mine", "Mine"), chip("public", "Public")),
      ...(galleryRows.length ? galleryRows.map(distroCard) : [h("div.empty", null, icon("layers", 22), h("h3", "Nothing here"), h("p", galleryQ ? "No distro matches that." : "Publish this machine, and it appears here for your tenant — or publicly, if you choose."))]),
      h("button.ghost.wide", { style: { marginTop: "4px" }, onclick: publish }, "Publish this OS as a distro…"),
      h("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
        h("button.ghost", { style: { flex: "1" }, onclick: exportFile }, "Export file"),
        h("button.ghost", { style: { flex: "1" }, onclick: importFile }, "Import file")),
      h("div.note", "A distro is your whole machine: the desktop, the source and tools of every custom app, and which servers the Cell runs. Fork one and you get the machine, not a screenshot. Drop a .sandboxos.json file here to install it."),
    );
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dropping"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dropping"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dropping");
      const file = e.dataTransfer?.files?.[0];
      if (file) installFile(file);
    });
    return dropZone;
  }

  /** The words a fork replaces: what you have now versus what you get. */
  function forkSummary(d) {
    const doc = os.doc;
    const here = `${doc.windows.length} windows, ${doc.widgets.length} widgets, ${Object.keys(doc.apps).length} custom apps, theme ${doc.theme.base}`;
    const p = d.preview;
    const there = d.builtin
      ? `${d.apps.length + (d.customApps?.length ?? 0)} windows, ${d.widgets.length} widgets, theme ${d.theme}`
      : p ? `${p.windows?.length ?? 0} windows, ${p.widgets?.length ?? 0} widgets, ${p.apps ?? 0} custom apps${p.tools ? ` (${p.tools} with tools${d.mine ? "" : ", arriving switched off"})` : ""}, ${p.workspaces ?? 1} workspaces` : "another machine";
    return `This replaces your OS. Now: ${here}. After: ${there}. It is one revision — undo it from Layers → History.`;
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
    input.addEventListener("change", () => { const file = input.files?.[0]; input.remove(); if (file) installFile(file); });
    document.body.append(input);
    input.click();
  }

  async function installFile(file) {
    let payload;
    try { payload = JSON.parse(await file.text()); } catch (e) { toastError("Not a distro file", e); return; }
    const p = payload?.os;
    const there = p ? `${p.windows?.length ?? 0} windows, ${p.widgets?.length ?? 0} widgets, ${Object.keys(p.apps ?? {}).length} custom apps, theme ${p.theme?.base}` : "unknown contents";
    const got = await dialog({
      title: `Install ${file.name}?`,
      message: `${forkSummary({ preview: null, builtin: false, name: file.name }).split(" After:")[0]} After: ${there}. ${payload.integrity ? "Its bundles are hashed and will be verified." : "It carries no integrity block (an older export)."} Any companion servers arrive switched off.`,
      fields: [{ name: "manifest", label: "Cell composition", type: "select", value: "keep",
        options: [{ value: "keep", label: "Keep my servers as they are" }, { value: "apply", label: "Apply the file's server composition too" }] }],
      confirmLabel: "Install",
    });
    if (!got) return;
    try {
      const r = await call("distroImport", { payload, applyManifest: got.manifest === "apply" });
      await loadOs();
      toast("Installed", { body: `${r.apps} custom apps came with it${r.verified ? ", verified" : ""}.${r.disabledServers?.length ? ` ${r.disabledServers.length} server(s) are off until you enable them.` : ""}`, kind: "ok" });
    } catch (e) { toastError("Could not install that file", e); }
  }

  async function fork(d) {
    if (!await confirmDialog(`Fork ${d.name}?`, forkSummary(d), { confirmLabel: "Fork", danger: false })) return;
    try {
      const r = await call("distroFork", { id: d.id });
      await loadOs();
      const off = (r.tools ?? []).filter((t) => !t.enabled);
      toast(`Forked ${d.name}`, {
        body: off.length ? `${off.length} app server${off.length > 1 ? "s" : ""} arrived switched off — right-click the app in the Library to turn it on.` : r.seeded?.length ? `${r.seeded.length} files seeded into the Cell.` : undefined,
        kind: "ok",
      });
      loadGallery();
    } catch (e) { toastError("Could not fork that distro", e); }
  }

  async function publish() {
    // What travels, what does not, and the hash that will identify it — before
    // you press the button, not in the docs (goal.md T2.6). The numbers come
    // from a real export of this machine rather than from a description of one.
    let manifest = null;
    try { manifest = (await api.mcp("desktop", "distroExport", {})).payload; } catch { /* the preview is a courtesy */ }
    const appCount = Object.keys(manifest?.bundles?.apps ?? {}).length;
    const toolful = Object.values(os.doc.apps ?? {}).filter((a) => a.mcp).length;
    const serverCount = Object.keys(manifest?.manifest?.servers ?? {}).length;
    const bundleHashes = Object.keys(manifest?.integrity?.bundles ?? manifest?.integrity ?? {}).length;

    const travels = [
      ["The desktop", `${os.doc.windows.length} windows, ${os.doc.widgets.length} widgets, the theme and the motion`],
      ["Custom apps", appCount ? `${appCount} with their source${toolful ? `, ${toolful} with tools` : ""}` : "none"],
      ["Composition", serverCount ? `${serverCount} servers, by name and configuration` : "not included"],
      ["Integrity", bundleHashes ? `SHA-256 per bundle (${bundleHashes})` : "no bundles to hash"],
    ];
    const staysBehind = [
      ["Secrets", "never travel — not the values, not the names"],
      ["Machine tokens", "never travel; a forker mints their own"],
      ["Your files", "the Cell's volume is not in a distro (Tide moves files)"],
      ["Checkpoints", "yours alone — use Settings → Machine to back those up"],
      ["Companion servers", "arrive switched off for whoever forks it"],
    ];

    const got = await dialog({
      title: "Publish this OS as a distro",
      wide: true,
      message: "The desktop, the source and tools of every custom app, and the Cell's server composition travel together.",
      render: () => h("div.publish-what", null,
        h("div.col", null,
          h("div.os-label", "What travels"),
          ...travels.map(([k, v]) => h("div.kv", null, h("span.k", k), h("span.v", v)))),
        h("div.col", null,
          h("div.os-label", "What stays behind"),
          ...staysBehind.map(([k, v]) => h("div.kv", null, h("span.k", k), h("span.v.dim", v))))),
      fields: [
        { name: "name", label: "Name", value: os.doc.name },
        { name: "description", label: "Description", placeholder: "What is this machine for?" },
        { name: "tags", label: "Tags", placeholder: "dev, research", hint: "comma-separated, searchable in the gallery" },
        { name: "visibility", label: "Who can see it", type: "select", value: "tenant",
          options: [{ value: "private", label: "Only me" }, { value: "tenant", label: "Everyone in my tenant" }, { value: "public", label: "Every tenant on this host" }] },
        { name: "notifications", label: "Notifications", type: "select", value: "strip",
          options: [{ value: "strip", label: "Leave them out (default)" }, { value: "keep", label: "Include them" }] },
        { name: "replace", label: "If the name exists", type: "select", value: "replace",
          options: [{ value: "replace", label: "Replace it" }, { value: "fail", label: "Stop and tell me" }] },
      ],
      confirmLabel: "Publish",
    });
    if (!got?.name) return;
    try {
      const r = await call("distroPublish", {
        name: got.name, description: got.description, visibility: got.visibility,
        tags: String(got.tags ?? "").split(/[,\s]+/).filter(Boolean),
        keepNotifications: got.notifications === "keep", replace: got.replace === "replace",
      });
      await loadOs();
      toast(`Published ${r.name} (${r.visibility})`, { body: `${r.apps} custom apps, ${r.tools} with tools, ${r.servers} servers packaged.`, kind: "ok" });
      loadGallery();
    } catch (e) { toastError("Could not publish", e); }
  }

  // ── creating things ───────────────────────────────────────────────────────

  const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  async function newApp() {
    const got = await dialog({
      title: "New app",
      message: "An app is a window for you and, if you want, tools for the agent. Either way you get a runnable starter to edit in Code.",
      fields: [
        { name: "name", label: "Name", placeholder: "Port Monitor" },
        { name: "id", label: "Id", placeholder: "port-monitor", hint: "lowercase, used in the URL and as the server name" },
        { name: "shape", label: "Shape", type: "select", value: "ui",
          options: [
            { value: "ui", label: "UI only — a window" },
            { value: "tools", label: "UI + tools — a window and a companion server the agent can call" },
          ] },
        { name: "permissions", label: "Capabilities", placeholder: "fs.read, ports.list", hint: "MCP patterns this app may call from its window" },
      ],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    const id = slugify(got.id || got.name);
    try {
      const r = await call("appDefine", {
        id, name: got.name,
        permissions: String(got.permissions ?? "").split(/[,\s]+/).filter(Boolean),
        ...(got.shape === "tools" ? { starter: "tools" } : {}),
      });
      await loadOs();
      dropSession(id);
      await call("dockPin", { app: id, pinned: true });
      onOpenCode?.("app", id, got.shape === "tools" ? "server.js" : null);
      toast(`${got.name} created`, {
        body: got.shape === "tools"
          ? (r.server?.live ? `Its tools are live: ${id}.ping, ${id}.add, ${id}.list. Ask the agent to call one.` : r.server?.problem ?? "Its server did not start.")
          : "Open it from the dock; edit its source in Code.",
        kind: r.server?.problem ? "err" : "ok",
      });
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
        { name: "singleton", label: "One window at a time", type: "select", value: a.window.singleton ? "yes" : "no",
          options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
        { name: "opens", label: "Opens file types", value: extsFor(a.id).join(", "), hint: "e.g. .csv, .log — Files and Spotlight will use it" },
        ...(a.kind === "bundle" ? [
          { name: "origin", label: "Source lives in", type: "select", value: a.source?.origin ?? "store",
            options: [{ value: "store", label: "the OS store (edited in Code, travels with distros)" }, { value: "volume", label: "the Cell volume (edited in Files, versioned by Tide)" }] },
          { name: "volumePath", label: "Volume path", value: a.source?.volumePath ?? `apps/${a.id}`, hint: "only for volume origin" },
        ] : []),
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
        window: { w: w || a.window.w, h: hh || a.window.h, singleton: got.singleton === "yes" },
        ...(got.origin ? { origin: got.origin, volumePath: got.volumePath || undefined } : {}),
      });
      await syncAssociations(a.id, got.opens);
      dropSession(a.id); // its capability set may have changed
      await loadOs();
      toast(`${got.name} updated`, { kind: "ok" });
    } catch (e) { toastError("Could not update the app", e); }
  }

  /** Extensions currently routed to an app. */
  const extsFor = (id) => Object.entries(os.doc.shell.associations ?? {}).filter(([, app]) => app === id).map(([ext]) => ext);

  /** Make `associations` say exactly `list` for this app: add the new, clear the old. */
  async function syncAssociations(id, list) {
    const want = new Set(String(list ?? "").split(/[,\s]+/).filter(Boolean).map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()));
    const have = new Set(extsFor(id));
    for (const ext of want) if (!have.has(ext)) await call("associate", { ext, app: id }).catch((e) => toastError(`Could not claim ${ext}`, e));
    for (const ext of have) if (!want.has(ext)) await call("associate", { ext, app: null }).catch(() => {});
  }

  function appMenu(a, ev) {
    menu({ x: ev?.clientX ?? 200, y: ev?.clientY ?? 200 }, [
      { label: "Open", icon: "window", run: () => call("open", { app: a.id }) },
      { label: "Settings…", icon: "settings", run: () => appSettings(a) },
      { label: "Edit source", icon: "code", disabled: a.kind !== "bundle", run: () => onOpenCode?.("app", a.id) },
      a.mcp ? { label: a.mcp.enabled ? `Switch its tools off (${a.mcp.name}.*)` : `Switch its tools on (${a.mcp.name}.*)`, icon: "play",
        run: async () => {
          try { const r = await call("appDefine", { id: a.id, mcp: { enabled: !a.mcp.enabled } }); await loadOs();
            toast(r.server?.live ? `${a.mcp.name}.* is live` : r.server?.problem ?? `${a.mcp.name}.* is off`, { kind: r.server?.problem ? "err" : "ok" }); }
          catch (e) { toastError("Could not change the server", e); }
        } } : null,
      a.mcp?.live ? { label: `Tools: ${a.mcp.tools.join(", ")}`, icon: "apps", run: () => {} } : null,
      { label: os.doc.shell.dock.pinned.includes(a.id) ? "Remove from dock" : "Keep in dock", icon: "apps",
        run: () => call("dockPin", { app: a.id, pinned: !os.doc.shell.dock.pinned.includes(a.id) }) },
      "-",
      { label: "Delete app", icon: "trash", danger: true, run: async () => {
        if (!await confirmDialog(`Delete ${a.name}?`, "Its source and every open window go with it.")) return;
        await call("appRemove", { id: a.id });
        await loadOs();
      } },
    ].filter(Boolean));
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
    const row = (id, kind, name, sub, ic) => h("div.layer-line", null, h("button.layer-row", {
      class: os.sel.ids?.includes(id) ? "on" : "",
      onclick: (e) => { select(id, kind, { add: e.shiftKey }); if (kind === "win" && !e.shiftKey) call("focus", { id }).catch(() => {}); },
    }, icon(iconName(ic), 15), h("span.nm", name), h("span.sub", sub)),
    kind === "win" ? h("span.z-btns", null,
      h("button", { title: "Bring to front", onclick: () => call("focus", { id }) }, "▲"),
      h("button", { title: "Send to back", onclick: () => call("windowSet", { id, back: true }) }, "▼")) : null);

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

  const when = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86_400) return `${Math.round(s / 3600)}h`;
    return new Date(ts).toLocaleDateString();
  };

  /** "3 windows · theme · dock" — what a revision changed, in words. */
  function diffSummary(diff) {
    const parts = [];
    const list = (name, d) => {
      const n = (d?.added ?? 0) + (d?.removed ?? 0) + (d?.changed ?? 0);
      if (n) parts.push(`${n} ${name}${n > 1 ? "s" : ""}`);
    };
    list("window", diff.windows);
    list("widget", diff.widgets);
    list("workspace", diff.workspaces);
    if (diff.theme?.length) parts.push(`theme (${diff.theme.join(", ")})`);
    if (diff.animation?.length) parts.push("motion");
    if (diff.wm?.length) parts.push(`layout (${diff.wm.join(", ")})`);
    if (diff.shell?.length) parts.push(`shell (${diff.shell.join(", ")})`);
    if (diff.apps?.length) parts.push(`apps (${diff.apps.join(", ")})`);
    if (diff.widgetKinds?.length) parts.push(`widget kinds (${diff.widgetKinds.join(", ")})`);
    if (diff.name) parts.push("name");
    return parts.length ? parts.join(" · ") : "identical to now";
  }

  async function revertTo(rev) {
    let summary = "";
    try { summary = diffSummary((await call("history", { rev: rev.rev })).diff); } catch { /* fine */ }
    const ok = await confirmDialog(`Go back to revision ${rev.rev}?`,
      `${rev.label || "unlabelled"} · ${when(rev.ts)}. Restoring changes: ${summary}. The restore is itself a new revision, so it can be undone.`,
      { confirmLabel: "Revert", danger: false });
    if (!ok) return;
    try { await call("revert", { rev: rev.rev }); await loadOs(); toast(`Back at r${rev.rev}`, { kind: "ok" }); }
    catch (e) { toastError("Could not revert", e); }
  }

  async function showDiff(rev, host) {
    try {
      const r = await call("history", { rev: rev.rev });
      const d = r.diff;
      const row = (k, v) => h("div.diff-row", null, h("span.k", k), h("span.v", v));
      const listV = (x) => `+${x.added} −${x.removed} ~${x.changed}`;
      fill(host,
        row("windows", listV(d.windows)), row("widgets", listV(d.widgets)), row("workspaces", listV(d.workspaces)),
        row("theme", d.theme.length ? d.theme.join(", ") : "—"),
        row("motion", d.animation.length ? d.animation.join(", ") : "—"),
        row("layout", d.wm.length ? d.wm.join(", ") : "—"),
        row("shell", d.shell.length ? d.shell.join(", ") : "—"),
        row("apps", d.apps.length ? d.apps.join(", ") : "—"),
        h("div.dim", { style: { fontSize: "10.5px", padding: "4px 0" } }, "Counts are this revision → now: added, removed, changed."));
    } catch (e) { fill(host, h("div.dim", e.message)); }
  }

  async function paintHistory(host) {
    if (!host) return;
    try {
      const r = await call("history", {});
      const openDiff = new Set();
      const paint = () => fill(host, ...(r.revisions.length ? r.revisions.map((rev) => {
        const diffHost = h("div.diff-box", { hidden: !openDiff.has(rev.rev) });
        if (openDiff.has(rev.rev)) showDiff(rev, diffHost);
        return h("div.hist-item", null,
          h("button.layer-row", {
            title: `Revert to r${rev.rev}`,
            onclick: () => revertTo(rev),
            oncontextmenu: (e) => { e.preventDefault(); openDiff.has(rev.rev) ? openDiff.delete(rev.rev) : openDiff.add(rev.rev); paint(); },
          }, icon("refresh", 14), h("span.nm", rev.label || `rev ${rev.rev}`), h("span.sub", `r${rev.rev} · ${when(rev.ts)}`)),
          h("button.diff-toggle", {
            title: "What changed since this revision",
            onclick: () => { openDiff.has(rev.rev) ? openDiff.delete(rev.rev) : openDiff.add(rev.rev); paint(); },
          }, openDiff.has(rev.rev) ? "hide" : "diff"),
          diffHost);
      }) : [h("div.dim", { style: { padding: "4px 8px", fontSize: "11px" } }, "No history yet. Every change to the desktop will appear here.")]),
      h("div.dim", { style: { padding: "6px 8px", fontSize: "10.5px" } }, `${r.revisions.length} of ${os.snap?.limits?.history ?? 40} revisions kept · current r${r.current}`));
      paint();
    } catch { /* history is a nicety */ }
  }

  // ── Code tab ──────────────────────────────────────────────────────────────

  /** Deep link from the Library, the agent panel or Spotlight: show this file. */
  function openCode(kind, id, path = null) {
    setTab("code");
    codePane.setTarget({ kind, id }, { path });
  }

  function codeTab() {
    const any = codePane.render();
    if (!any) {
      return h("div.empty", null, icon("code", 26), h("h3", "Nothing custom yet"),
        h("p", "An app is a folder of HTML, CSS and JS this machine serves into a sandboxed frame. Create one in the Library and its files appear here — or ask the agent to write one."));
    }
    if (!codePane.target) {
      const [kind, id] = recall("code", "").split(":");
      if (kind && id) codePane.setTarget({ kind, id });
    }
    return codePane.el;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    if (!os.doc) return;
    fill(tabs, ...TABS.map(([id, label]) =>
      h("button.seg", { class: tab === id ? "on" : "", onclick: () => setTab(id) }, label, id === "code" && codePane.hasDirty() ? h("span.dot") : null)));
    el.classList.toggle("wide", tab === "code");
    if (tab !== "theme") themeStudio.destroy();
    if (tab !== "motion") motionStudio.destroy();

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
      themeStudio.render();
      fill(pane, h("div.stx-scroll", { style: { paddingTop: "14px" } }, themeStudio.el));
    } else if (tab === "motion") {
      motionStudio.render();
      fill(pane, h("div.stx-scroll", { style: { paddingTop: "14px" } }, motionStudio.el));
    } else {
      const body = codeTab();
      if (body === codePane.el) fill(pane, body);
      else fill(pane, h("div.stx-scroll", { style: { paddingTop: "14px" } }, body));
    }
  }

  /** Verbs the Studio's own palette (⌘⇧P) offers; each is a builder action. */
  function paletteActions() {
    return [
      { name: "New app…", sub: "Library", icon: "plus", run: newApp },
      { name: "New widget…", sub: "Library", icon: "plus", run: newWidget },
      { name: "New theme…", sub: "Library", icon: "theme", run: newTheme },
      { name: "Publish this OS as a distro…", sub: "Distros", icon: "layers", run: publish },
      { name: "Export distro file", sub: "Distros", icon: "save", run: exportFile },
      { name: "Import distro file…", sub: "Distros", icon: "files", run: importFile },
      ...TABS.map(([id, label]) => ({ name: `Go to ${label}`, sub: "Studio", icon: "layers", run: () => setTab(id) })),
      ...Object.values(os.doc.apps).filter((a) => a.kind === "bundle").map((a) => ({ name: `Edit ${a.name} source`, sub: "Code", icon: "code", run: () => openCode("app", a.id) })),
      { name: "Save all open files", sub: "Code", icon: "save", run: () => codePane.saveAll() },
    ];
  }

  return { el, render, setTab, openCode, paletteActions, get tab() { return tab; }, get dirty() { return codePane.hasDirty(); } };
}

// ── Inspector ───────────────────────────────────────────────────────────────

export function createInspector() {
  const body = h("div.panel-body");
  const el = h("aside.stx-inspector", null,
    h("div.panel-head", h("h2", "Inspector")),
    body);

  // ── several things selected: align and distribute ────────────────────────

  function multi(items) {
    const bounds = () => ({
      l: Math.min(...items.map((i) => i.x)), r: Math.max(...items.map((i) => i.x + i.w)),
      t: Math.min(...items.map((i) => i.y)), b: Math.max(...items.map((i) => i.y + i.h)),
    });
    const commit = (fn) => {
      const b = bounds();
      const moves = items.map((it) => { const n = { id: it.id, x: it.x, y: it.y }; fn(n, it, b); if (it.kind) n.pin = "none"; return n; })
        .filter((n) => { const it = items.find((i) => i.id === n.id); return n.x !== it.x || n.y !== it.y; });
      if (moves.length) call("move", { items: moves }).catch((e) => toastError("Could not align", e));
    };
    const size = (fn) => {
      const sizes = items.map((it) => { const n = { id: it.id, w: it.w, h: it.h }; fn(n, it); return n; })
        .filter((n) => { const it = items.find((i) => i.id === n.id); return n.w !== it.w || n.h !== it.h; });
      if (sizes.length) call("resize", { items: sizes }).catch((e) => toastError("Could not resize", e));
    };
    const distribute = (axis) => {
      const sorted = [...items].sort((p, q) => (axis === "x" ? p.x - q.x : p.y - q.y));
      const b = bounds();
      const total = axis === "x" ? b.r - b.l : b.b - b.t;
      const used = sorted.reduce((n, it) => n + (axis === "x" ? it.w : it.h), 0);
      const gap = sorted.length > 1 ? (total - used) / (sorted.length - 1) : 0;
      let cursor = axis === "x" ? b.l : b.t;
      const moves = sorted.map((it) => {
        const n = { id: it.id, x: it.x, y: it.y, ...(it.kind ? { pin: "none" } : {}) };
        if (axis === "x") { n.x = Math.round(cursor); cursor += it.w + gap; } else { n.y = Math.round(cursor); cursor += it.h + gap; }
        return n;
      });
      call("move", { items: moves }).catch((e) => toastError("Could not distribute", e));
    };
    const btn = (label, title, run) => h("button.ghost", { title, onclick: run }, label);
    return h("div", null,
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" } },
        h("span.kind-tag", `${items.length} selected`),
        h("span.dim", { style: { fontSize: "11px" } }, "shift-click to add · arrows nudge")),
      h("div.section-label", "Align"),
      h("div.align-grid", null,
        btn("⇤", "Left edges", () => commit((n, it, b) => { n.x = b.l; })),
        btn("↔", "Horizontal centres", () => commit((n, it, b) => { n.x = Math.round((b.l + b.r) / 2 - it.w / 2); })),
        btn("⇥", "Right edges", () => commit((n, it, b) => { n.x = b.r - it.w; })),
        btn("⤒", "Top edges", () => commit((n, it, b) => { n.y = b.t; })),
        btn("↕", "Vertical centres", () => commit((n, it, b) => { n.y = Math.round((b.t + b.b) / 2 - it.h / 2); })),
        btn("⤓", "Bottom edges", () => commit((n, it, b) => { n.y = b.b - it.h; }))),
      h("div.section-label.tight", "Distribute"),
      h("div.align-grid.two", null,
        btn("↔ evenly", "Equal horizontal gaps", () => distribute("x")),
        btn("↕ evenly", "Equal vertical gaps", () => distribute("y"))),
      h("div.section-label.tight", "Match size"),
      h("div.align-grid.two", null,
        btn("widths", "Match the widest", () => { const w = Math.max(...items.map((i) => i.w)); size((n) => { n.w = w; }); }),
        btn("heights", "Match the tallest", () => { const hh = Math.max(...items.map((i) => i.h)); size((n) => { n.h = hh; }); })),
      h("div.note", "One alignment is one revision: the whole selection moves in a single desktop.move with items, so undo brings it all back at once."),
      h("button.ghost.wide.danger", { style: { marginTop: "12px" }, onclick: async () => {
        if (!await confirmDialog(`Delete ${items.length} elements?`, "Windows close, widgets are removed.")) return;
        for (const it of items) await call(it.kind ? "widgetRemove" : "close", { id: it.id }).catch(() => {});
        select(null, null);
      } }, "Delete selection"),
    );
  }

  // ── one thing selected: the property sheet ───────────────────────────────

  /**
   * The definition behind a custom app or widget — not just its geometry.
   *
   * Everything here is a field `appDefine` / `widgetDefine` accepts, so an agent
   * and a person are editing the same document through the same door, and the
   * ceilings are printed rather than discovered by hitting them (goal.md T2.5).
   */
  function appSection(kind, item, meta) {
    const isWidget = kind === "widget";
    const def = isWidget ? os.doc.widgetKinds[item.kind] : os.doc.apps[item.app];
    if (!def) return null;
    const tool = isWidget ? "widgetDefine" : "appDefine";
    const key = isWidget ? { kind: def.kind } : { id: def.id };
    const write = (args) => call(tool, { ...key, ...args }).catch((e) => toastError("Could not apply", e));

    const text = (label, value, apply, { hint = null, max = null } = {}) => {
      const input = h("input", { value: value ?? "", ...(max ? { maxlength: String(max) } : {}) });
      input.addEventListener("change", () => apply(input.value.trim()));
      return h("div.field", null, h("label", label), input, hint ? h("span.dim", { style: { fontSize: "10.5px" } }, hint) : null);
    };
    const numberField = (label, value, apply, hint) => {
      const input = h("input", { type: "number", value: value ?? 0 });
      input.addEventListener("change", () => apply(Number(input.value) || 0));
      return h("div.field", null, h("label", label), input, hint ? h("span.dim", { style: { fontSize: "10.5px" } }, hint) : null);
    };
    const toggle = (label, on, apply) =>
      h("div.field.row", null, h("label", label),
        h("button.ghost", { class: on ? "on" : "", onclick: () => apply(!on) }, on ? "yes" : "no"));

    const iconSel = h("select", null, ...ICON_NAMES.map((n) => h("option", { value: n, selected: n === def.icon }, n)));
    iconSel.addEventListener("change", () => write({ icon: iconSel.value }));

    const permsInput = h("input", { value: (def.permissions ?? []).join(", "), placeholder: "fs.read, ports.list" });
    permsInput.addEventListener("change", () => write({
      permissions: permsInput.value.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean),
    }));

    return h("div.app-section", null,
      h("div.section-label", isWidget ? "This widget kind" : "This app"),
      text("Name", def.name, (v) => write({ name: v }), { max: 64, hint: "64 characters" }),
      h("div.field", null, h("label", "Icon"), iconSel),
      text("Accent", def.hue, (v) => write({ hue: v }), { hint: "a hex colour; anything else is refused" }),
      text("Description", def.description, (v) => write({ description: v }), { max: 300, hint: "300 characters" }),
      h("div.field", null, h("label", "Capabilities"), permsInput,
        h("span.dim", { style: { fontSize: "10.5px" } },
          `server.tool or server.* · up to 32 · granted only as far as you hold them${(meta.withheld ?? []).length ? ` · withheld now: ${meta.withheld.join(", ")}` : ""}`)),
      isWidget
        ? numberField("Refresh every (ms)", def.refreshMs ?? 0, (v) => write({ refreshMs: v }), "0 never ticks · the host keeps the clock and pauses it off-screen")
        : toggle("One window at a time", !!def.window?.singleton, (v) => write({ window: { ...(def.window ?? {}), singleton: v } })),
      !isWidget && def.kind === "alias"
        ? text("Points at", def.target, (v) => write({ target: v }), { hint: "an app id · a ring of aliases is refused" })
        : null,
      !isWidget && def.kind === "url" ? text("URL", def.url, (v) => write({ url: v }), { hint: "http or https" }) : null,
      h("div.kv", null, h("span.k", "Source lives in"), h("span.v", def.origin === "volume"
        ? `the Cell (${def.volumePath}) — Tide versions it, and a process inside can rewrite it`
        : "the OS store, beside the document — not writable from inside the Cell")),
      def.mcp ? h("div.kv", null, h("span.k", "Tool face"), h("span.v", `${def.mcp.name}${def.mcp.entrypoint ? " · companion" : " · façade"}${def.mcp.enabled === false ? " · switched off" : ""}`)) : null,
      h("div.align-grid.two", { style: { marginTop: "10px" } },
        h("button.ghost", { onclick: () => onOpenCodeGlobal?.(isWidget ? "widget" : "app", isWidget ? def.kind : def.id) }, "Edit source"),
        h("button.ghost", {
          class: def.suspended ? "on" : "",
          title: def.suspended ? "Let it hold capabilities again" : "Revoke its tokens; keep the window and the source",
          onclick: () => call("appSuspend", { id: isWidget ? def.kind : def.id, suspended: !def.suspended })
            .catch((e) => toastError("Could not change that", e)),
        }, def.suspended ? "Suspended" : "Suspend")),
    );
  }

  function render() {
    const d = os.doc;
    if (!d) return;
    const items = selected();
    if (items.length > 1) { fill(body, multi(items)); return; }
    const { id, kind } = os.sel;
    const item = kind === "win" ? d.windows.find((w) => w.id === id) : d.widgets.find((g) => g.id === id);
    if (!item) {
      fill(body, h("div.empty", null,
        icon("window", 26),
        h("h3", "Nothing selected"),
        h("p", "Click a window or widget in the live OS, or a layer on the left. Shift-click to select several and align them.")));
      return;
    }

    const meta = kind === "win"
      ? (os.snap.apps ?? []).find((a) => a.id === item.app)
      : (os.snap.widgetKinds ?? []).find((w) => w.kind === item.kind);
    const setTool = kind === "widget" ? "widgetSet" : "windowSet";

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
    wsSel.addEventListener("change", () => call(setTool, { id, ws: Number(wsSel.value) }));

    const pinSel = kind === "widget" ? h("select", null, ...["none", "left", "right"].map((p) => h("option", { value: p, selected: item.pin === p }, p === "none" ? "free" : `pinned ${p}`))) : null;
    pinSel?.addEventListener("change", () => call("widgetSet", { id, pin: pinSel.value }));

    // Props: the free-form part of an element, edited as JSON with the ceiling stated.
    const propsTa = h("textarea", { rows: 5, spellcheck: "false" });
    propsTa.value = JSON.stringify(item.props ?? {}, null, 2);
    const propsNote = h("span.dim", { style: { fontSize: "10.5px" } }, `${JSON.stringify(item.props ?? {}).length} of 8192 bytes`);
    const propsBtn = h("button.ghost", { onclick: async () => {
      let parsed;
      try { parsed = JSON.parse(propsTa.value || "{}"); } catch (e) { toastError("Not valid JSON", e); return; }
      if (JSON.stringify(parsed).length > 8192) { toastError("Too big", new Error("props are capped at 8 KB; anything larger is dropped by the document")); return; }
      // props merge, so clear what was removed by sending nulls is not possible; replace wholesale via patch-free set of keys.
      const cleared = Object.fromEntries(Object.keys(item.props ?? {}).filter((k) => !(k in parsed)).map((k) => [k, null]));
      try { await call(setTool, { id, props: { ...cleared, ...parsed } }); toast("Props saved", { kind: "ok" }); }
      catch (e) { toastError("Could not save props", e); }
    } }, "Save props");

    const zRow = kind === "win" ? h("div.align-grid.two", { style: { marginBottom: "14px" } },
      h("button.ghost", { onclick: () => call("focus", { id }) }, "Bring to front"),
      h("button.ghost", { onclick: () => call("windowSet", { id, back: true }) }, "Send to back")) : null;

    const winFlags = kind === "win" ? h("div.align-grid.two", { style: { marginBottom: "14px" } },
      h("button.ghost", { class: item.min ? "on" : "", onclick: () => call("windowSet", { id, min: !item.min }) }, item.min ? "Restore" : "Minimise"),
      h("button.ghost", { onclick: () => call("windowSet", { id, max: !item.max }) }, item.max ? "Unzoom" : "Zoom")) : null;

    const appLine = meta && !meta.builtin ? appSection(kind, item, meta) : null;

    fill(body,
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" } },
        h("span.kind-tag", kind === "win" ? "Window" : "Widget"),
        h("span", { style: { fontSize: "13px", fontWeight: "600" } }, kind === "win" ? item.app : item.kind),
        h("span.dim.mono", { style: { fontSize: "10px", marginLeft: "auto" } }, id)),
      h("div.field", null, h("label", "Title"), title),
      h("div.grid-2", null, numField("X", "x", "move"), numField("Y", "y", "move"), numField("W", "w", "resize"), numField("H", "h", "resize")),
      h("div.field", null, h("label", "Workspace"), wsSel),
      pinSel ? h("div.field", null, h("label", "Pin"), pinSel) : null,
      zRow, winFlags, appLine,
      h("div.field", null, h("label", "Props (JSON)"), propsTa, h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" } }, propsNote, propsBtn)),
      h("button.ghost.wide.danger", {
        onclick: () => call(kind === "widget" ? "widgetRemove" : "close", { id }).catch((e) => toastError("Could not delete", e)),
      }, kind === "widget" ? "Remove widget" : "Close window"),
    );
  }

  onOs(() => render());
  return { el, render, set onOpenCode(fn) { onOpenCodeGlobal = fn; } };
}

let onOpenCodeGlobal = null;
