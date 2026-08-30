// builtins.js — the applications the OS ships with.
//
// Each is a small, real client of the Kernel: Files calls `fs.*`, Console runs a
// Command Central line, Observability calls `metrics.*`, Browser proxies an
// exposed port. None of them has a private channel — everything they do, an agent
// could do, and every call lands in the same audit log.
//
// A built-in and a custom app are the same thing to the window manager. These are
// only "built in" in the sense that we shipped the code; delete one from the dock
// and write your own, and the OS will not notice the difference.

import {
  h, fill, icon, api, slug, fmtBytes, toastError, toast, dialog, confirmDialog, menu,
  dirname, basename, extname,
} from "../core.js";
import { call, os } from "./client.js";
import { mountTerminal } from "./terminal.js";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"]);
const fileUrl = (p, download) => `/${slug}/file?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
const join = (dir, name) => (dir === "." ? name : `${dir}/${name}`);

/** Which app opens this file — the document's associations, else Files itself. */
export function appFor(path) {
  return os.doc?.shell?.associations?.[extname(path)] ?? null;
}

// ── Files ───────────────────────────────────────────────────────────────────

const files = {
  mount(host, win, ctx) {
    let cwd = win.props?.path ?? ".";
    let openPath = null;
    let entries = [];

    const crumbs = h("div.path");
    const listEl = h("div.file-list");
    const paneEl = h("div.file-pane");
    const saveBtn = h("button.app-btn", { onclick: () => save(), disabled: true }, "Save");
    const drop = h("div.app-body", { style: { display: "flex" } }, listEl, paneEl);

    fill(host, h("div.app", null,
      h("div.app-bar", null,
        h("button.app-btn", { title: "Up a level", onclick: () => go(dirname(cwd)) }, icon("back", 12)),
        crumbs,
        saveBtn,
        h("button.app-btn", { title: "New…", onclick: (e) => newMenu(e.currentTarget) }, icon("plus", 12)),
        h("button.app-btn", { title: "Refresh", onclick: () => go(cwd) }, icon("refresh", 12)),
      ),
      drop,
    ));

    // ── listing ─────────────────────────────────────────────────────────────

    async function go(path) {
      cwd = path || ".";
      openPath = null;
      call("windowSet", { id: win.id, props: { path: cwd } }).catch(() => {});
      crumbs.textContent = cwd === "." ? "/" : `/${cwd}`;
      try {
        const r = await api.mcp("fs", "list", { path: cwd });
        entries = [...r.entries].sort((a, b) =>
          (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        paint();
      } catch (e) {
        fill(listEl, h("div.dim", { style: { padding: "10px", fontSize: "11px" } }, e.message));
      }
    }

    function paint() {
      if (!entries.length) {
        fill(listEl, h("div.dim", { style: { padding: "10px", fontSize: "11px" } }, "empty"));
        return;
      }
      fill(listEl, ...entries.map((e) => {
        const p = join(cwd, e.name);
        return h("button.row-line", {
          class: p === openPath ? "on" : "",
          onclick: () => (e.type === "dir" ? go(p) : open(p)),
          ondblclick: () => { if (e.type !== "dir") launchWith(p); },
          oncontextmenu: (ev) => { ev.preventDefault(); rowMenu(ev, e, p); },
        }, h("span", e.type === "dir" ? `${e.name}/` : e.name),
          h("span.sz", e.type === "dir" ? "" : fmtBytes(e.size)));
      }));
    }

    function rowMenu(ev, entry, p) {
      const owner = entry.type === "file" ? appFor(p) : null;
      menu({ x: ev.clientX, y: ev.clientY }, [
        entry.type === "file" && owner
          ? { label: `Open in ${appName(owner)}`, icon: "window", run: () => launchWith(p) }
          : null,
        entry.type === "file" ? { label: "Open with…", icon: "apps", run: () => openWith(p) } : null,
        { label: "Download", icon: "save", disabled: entry.type === "dir", run: () => window.open(fileUrl(p, true), "_blank") },
        "-",
        { label: "Rename…", run: () => rename(p, entry.name) },
        { label: "Delete", icon: "trash", danger: true, run: () => remove(p, entry) },
      ].filter(Boolean));
    }

    const appName = (id) => (os.snap?.apps ?? []).find((a) => a.id === id)?.name ?? id;

    /** Open a file in whatever app claims its extension. */
    async function launchWith(p) {
      const appId = appFor(p);
      if (!appId) { open(p); return; }
      try { await call("open", { app: appId, props: { path: p } }); }
      catch (e) { toastError(`Could not open ${basename(p)}`, e); }
    }

    async function openWith(p) {
      const apps = (os.snap?.apps ?? []).filter((a) => a.id !== "settings");
      const got = await dialog({
        title: `Open ${basename(p)} with…`,
        fields: [
          { name: "app", label: "Application", type: "select", value: appFor(p) ?? "notes",
            options: apps.map((a) => ({ value: a.id, label: a.name })) },
          { name: "always", label: "Also make it the default for " + (extname(p) || "this kind"), type: "select",
            value: "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
        ],
        confirmLabel: "Open",
      });
      if (!got?.app) return;
      if (got.always === "yes" && extname(p)) {
        call("associate", { ext: extname(p), app: got.app }).catch(() => {});
      }
      call("open", { app: got.app, props: { path: p } }).catch((e) => toastError("Could not open", e));
    }

    // ── viewing and editing ─────────────────────────────────────────────────

    async function open(path) {
      openPath = path;
      saveBtn.disabled = true;
      paint();
      if (IMAGE.has(extname(path))) {
        fill(paneEl, h("img", { src: fileUrl(path), style: { maxWidth: "100%", display: "block", margin: "10px auto" } }));
        return;
      }
      try {
        const r = await api.mcp("fs", "read", { path });
        const ta = h("textarea.note-editor", { spellcheck: "false", style: { fontFamily: "var(--mono)", fontSize: "11px" } });
        ta.value = r.content;
        ta.addEventListener("input", () => { saveBtn.disabled = false; });
        ta.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(ta); }
        });
        paneEl._ta = ta;
        fill(paneEl, ta);
      } catch (e) {
        fill(paneEl, h("div.dim", { style: { padding: "12px", fontSize: "11px" } },
          `${e.message}. Binary files can still be downloaded from the right-click menu.`));
      }
    }

    async function save(ta = paneEl._ta) {
      if (!openPath || !ta) return;
      try {
        await api.mcp("fs", "write", { path: openPath, content: ta.value });
        saveBtn.disabled = true;
        ctx.notify?.(`Saved ${basename(openPath)}`);
      } catch (e) { toastError("Could not save", e); }
    }

    // ── mutating ────────────────────────────────────────────────────────────

    function newMenu(anchor) {
      menu(anchor, [
        { label: "New file…", icon: "plus", run: () => create("file") },
        { label: "New folder…", icon: "files", run: () => create("dir") },
        "-",
        { label: "Upload…", icon: "up", run: pickUpload },
      ]);
    }

    async function create(kind) {
      const got = await dialog({
        title: kind === "dir" ? "New folder" : "New file",
        fields: [{ name: "name", label: "Name", placeholder: kind === "dir" ? "notes" : "notes.md" }],
        confirmLabel: "Create",
      });
      if (!got?.name) return;
      const p = join(cwd, got.name.trim());
      try {
        if (kind === "dir") await api.mcp("fs", "mkdir", { path: p });
        else await api.mcp("fs", "write", { path: p, content: "" });
        await go(cwd);
        if (kind === "file") open(p);
      } catch (e) { toastError("Could not create it", e); }
    }

    async function rename(p, name) {
      const got = await dialog({ title: "Rename", fields: [{ name: "name", label: "New name", value: name }], confirmLabel: "Rename" });
      if (!got?.name || got.name === name) return;
      try {
        await api.mcp("fs", "move", { from: p, to: join(cwd, got.name.trim()) });
        go(cwd);
      } catch (e) { toastError("Could not rename", e); }
    }

    async function remove(p, entry) {
      if (!await confirmDialog(`Delete ${entry.name}?`, entry.type === "dir" ? "The folder and everything in it." : "This cannot be undone.")) return;
      try {
        await api.mcp("fs", "remove", { path: p, recursive: entry.type === "dir" });
        if (openPath === p) { openPath = null; fill(paneEl); }
        go(cwd);
      } catch (e) { toastError("Could not delete", e); }
    }

    // ── upload ──────────────────────────────────────────────────────────────

    function pickUpload() {
      const input = h("input", { type: "file", multiple: true, style: { display: "none" } });
      input.addEventListener("change", () => upload([...input.files]));
      host.append(input);
      input.click();
      setTimeout(() => input.remove(), 60_000);
    }

    async function upload(fileList) {
      if (!fileList.length) return;
      // Bytes go over the raw file endpoint, not through JSON: a 40 MB video has
      // no business being base64 inside an MCP envelope.
      for (const f of fileList) {
        try { await api.uploadFile(join(cwd, f.name), f); }
        catch (e) { toastError(`Could not upload ${f.name}`, e); }
      }
      toast(`Uploaded ${fileList.length} file${fileList.length > 1 ? "s" : ""}`, { kind: "ok" });
      go(cwd);
    }

    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dropping"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dropping"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dropping");
      upload([...(e.dataTransfer?.files ?? [])]);
    });

    go(cwd);
    if (win.props?.path && extname(win.props.path)) open(win.props.path);
    return () => {};
  },
};

// ── Terminal (a real PTY, in terminal.js) ───────────────────────────────────

const terminal = { mount: mountTerminal };

// ── Console — one Command Central line at a time ────────────────────────────

const consoleApp = {
  mount(host, win) {
    const out = h("div.term");
    const input = h("input", { spellcheck: "false", placeholder: "" });
    const history = [];
    let hi = 0;

    const line = (cls, text) => {
      out.append(h("div", { class: cls }, text));
      host.querySelector(".app-body").scrollTop = 1e6;
    };

    async function run(cmd) {
      out.append(h("div.in", null, "▸ ", h("b", cmd)));
      history.push(cmd);
      hi = history.length;
      try {
        const r = await api.post(`/${slug}/exec`, { line: cmd });
        for (const l of r.lines ?? []) line("out", l);
      } catch (e) { line("err", e.message); }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const cmd = input.value.trim();
        input.value = "";
        if (cmd) run(cmd);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (hi > 0) { hi -= 1; input.value = history[hi] ?? ""; }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        hi = Math.min(history.length, hi + 1);
        input.value = history[hi] ?? "";
      }
    });

    fill(host, h("div.app", null,
      h("div.app-body", out),
      h("div.term-input", null, h("span", "▸"), input),
    ));
    host.addEventListener("pointerdown", () => setTimeout(() => input.focus(), 0));
    line("out", "Command Central. Shell verbs, `:call server.tool {}`, or `? plain English`. Try `help`.");
    void win;
    return () => {};
  },
};

// ── Notes ───────────────────────────────────────────────────────────────────

const notes = {
  mount(host, win, ctx) {
    let path = win.props?.path ?? "notes/scratch.md";
    const ta = h("textarea.note-editor", { spellcheck: "false", placeholder: "Write something…" });
    const nameEl = h("input", { value: path, style: { flex: "1", fontFamily: "var(--mono)" } });
    const state = h("span.dim", { style: { fontSize: "10.5px" } }, "");
    let timer = null;

    async function load() {
      try { const r = await api.mcp("fs", "read", { path }); ta.value = r.content; state.textContent = "loaded"; }
      catch { ta.value = ""; state.textContent = "new file"; }
      ctx.setTitle?.(basename(path));
    }
    async function save() {
      try {
        await api.mcp("fs", "write", { path, content: ta.value });
        state.textContent = `saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      } catch (e) { toastError("Could not save the note", e); }
    }

    ta.addEventListener("input", () => { state.textContent = "…"; clearTimeout(timer); timer = setTimeout(save, 900); });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); clearTimeout(timer); save(); }
    });
    nameEl.addEventListener("change", () => {
      path = nameEl.value.trim() || "notes/scratch.md";
      call("windowSet", { id: win.id, props: { path } }).catch(() => {});
      load();
    });

    fill(host, h("div.app", null,
      h("div.app-bar", null, nameEl, state, h("button.app-btn", { onclick: save }, "Save")),
      h("div.app-body", ta),
    ));
    load();
    return () => clearTimeout(timer);
  },
};

// ── Observability ───────────────────────────────────────────────────────────

const metrics = {
  mount(host) {
    const grid = h("div.stat-grid");
    const spark = h("div.spark");
    const foot = h("div", { style: { padding: "0 12px 12px", fontSize: "11px", color: "var(--os-text-3)" } });
    fill(host, h("div.app", null, h("div.app-body", null, grid, spark, foot)));

    const stat = (k, v) => h("div.stat", null, h("div.k", k), h("div.v", v));
    let alive = true;

    async function tick() {
      if (!alive) return;
      try {
        const [m, hist] = await Promise.all([
          api.mcp("metrics", "snapshot", {}),
          api.tryMcp("metrics", "history", { limit: 24 }),
        ]);
        fill(grid,
          stat("Load", m.load?.[0]?.toFixed(2) ?? "—"),
          stat("Memory", m.memory?.used ? fmtBytes(m.memory.used) : "—"),
          stat("Processes", m.processes ?? "—"),
          stat("Tools", m.tools ?? "—"));
        const samples = hist?.samples ?? [];
        const max = Math.max(0.01, ...samples.map((s) => s.load ?? 0));
        fill(spark, ...samples.map((s) => h("i", { style: { height: `${Math.max(4, ((s.load ?? 0) / max) * 100)}%` } })));
        foot.textContent = `${m.servers?.length ?? 0} servers · ports ${m.ports?.join(", ") || "none"} · ${m.disk?.files ?? "—"} files`;
      } catch (e) {
        fill(grid, h("div.dim", { style: { padding: "10px", fontSize: "11px" } }, e.message));
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  },
};

// ── Media ───────────────────────────────────────────────────────────────────

const media = {
  mount(host, win) {
    let dir = win.props?.path ?? ".";
    if (extname(dir)) dir = dirname(dir); // opened via a file association
    const grid = h("div.tile-grid");
    const pathEl = h("input", { value: dir, style: { flex: "1", fontFamily: "var(--mono)" } });

    async function load() {
      try {
        const r = await api.mcp("fs", "list", { path: dir });
        const imgs = r.entries.filter((e) => e.type === "file" && IMAGE.has(extname(e.name)));
        if (!imgs.length) {
          fill(grid, h("div.dim", { style: { gridColumn: "1 / -1", padding: "12px", fontSize: "11px" } },
            `No images in /${dir === "." ? "" : dir}. Point this window anywhere in the machine.`));
          return;
        }
        fill(grid, ...imgs.map((e) => {
          const p = join(dir, e.name);
          return h("a.tile", { href: fileUrl(p), target: "_blank", title: e.name },
            h("img", { src: fileUrl(p), alt: e.name, loading: "lazy" }));
        }));
      } catch (e) {
        fill(grid, h("div.dim", { style: { gridColumn: "1 / -1", padding: "12px", fontSize: "11px" } }, e.message));
      }
    }
    pathEl.addEventListener("change", () => {
      dir = pathEl.value.trim() || ".";
      call("windowSet", { id: win.id, props: { path: dir } }).catch(() => {});
      load();
    });

    fill(host, h("div.app", null,
      h("div.app-bar", null, pathEl, h("button.app-btn", { onclick: load }, icon("refresh", 12))),
      h("div.app-body", grid)));
    load();
    return () => {};
  },
};

// ── Browser ─────────────────────────────────────────────────────────────────

const browser = {
  mount(host, win) {
    const bar = h("div.app-bar");
    const body = h("div.app-body", { style: { padding: 0 } });
    fill(host, h("div.app", null, bar, body));

    async function load() {
      const r = await api.tryMcp("ports", "list", {});
      const ports = r?.ports ?? [];
      const select = h("select", null,
        h("option", { value: "" }, ports.length ? "choose a port…" : "no ports exposed"),
        ...ports.map((p) => h("option", { value: p.port }, `${p.port}${p.name ? ` · ${p.name}` : ""}`)));
      select.value = win.props?.port ?? "";
      select.addEventListener("change", () => show(select.value));
      fill(bar, select,
        h("button.app-btn", { onclick: () => show(select.value) }, icon("refresh", 12)),
        h("button.app-btn", { onclick: load, title: "Rescan ports" }, "Ports"));
      if (select.value) show(select.value);
      else {
        fill(body, h("div.dim", { style: { padding: "14px", fontSize: "11.5px", lineHeight: "1.6" } },
          "Expose a port with ", h("code", "ports.expose"), " and it appears here, proxied through the Gateway — including WebSocket upgrades, so a dev server with hot reload works."));
      }
    }

    function show(port) {
      if (!port) return;
      call("windowSet", { id: win.id, props: { port } }).catch(() => {});
      fill(body, h("iframe", { src: `/${slug}/p/${port}/`, style: { width: "100%", height: "100%", border: "0" } }));
    }

    load();
    return () => {};
  },
};

// ── Settings ────────────────────────────────────────────────────────────────

const settings = {
  mount(host, win, ctx) {
    const body = h("div.app-body", { style: { padding: "8px" } });
    fill(host, h("div.app", body));

    function render() {
      const d = os.doc;
      if (!d) return;
      const sel = (options, value, onchange) => {
        const el = h("select", null, ...options.map((o) =>
          h("option", { value: o.value, selected: o.value === value }, o.label)));
        el.addEventListener("change", () => onchange(el.value));
        return el;
      };

      const nameEl = h("input", { value: d.name });
      nameEl.addEventListener("change", () => call("rename", { name: nameEl.value }));

      const assoc = Object.entries(d.shell.associations ?? {});

      fill(body,
        h("div.kv", null, h("span.k", "OS name"), nameEl),
        h("div.kv", null, h("span.k", "Theme"),
          sel((os.snap.themes ?? []).map((t) => ({ value: t.key, label: t.name })), d.theme.base,
            (v) => call("themeSet", { theme: v }))),
        h("div.kv", null, h("span.k", "Motion"),
          sel((os.snap.animations ?? []).map((a) => ({ value: a.key, label: a.name })), d.animation.preset,
            (v) => call("animationSet", { preset: v }))),
        h("div.kv", null, h("span.k", "Windows"),
          sel([{ value: "floating", label: "floating" }, { value: "tiling", label: "tiling" }], d.wm.mode,
            (v) => call("layoutSet", { mode: v }))),
        h("div.kv", null, h("span.k", "Snap to grid"),
          sel([{ value: "on", label: "on" }, { value: "off", label: "off" }], d.wm.snap ? "on" : "off",
            (v) => call("layoutSet", { snap: v === "on" }))),
        h("div.kv", null, h("span.k", "Dock"),
          sel(["bottom", "top", "left", "right", "hidden"].map((p) => ({ value: p, label: p })), d.shell.dock.position,
            (v) => call("dockSet", { position: v, visible: v !== "hidden" }))),
        h("div.kv", null, h("span.k", "Notifications"),
          sel([{ value: "on", label: "on" }, { value: "off", label: "off" }], d.shell.notifications.enabled ? "on" : "off",
            (v) => call("shellSet", { notifications: { enabled: v === "on" } }))),

        h("div.section-label", { style: { padding: "14px 11px 6px" } }, "Opens with"),
        ...(assoc.length ? assoc.map(([ext, appId]) => h("div.kv", null,
          h("span.k.mono", ext),
          sel([...(os.snap.apps ?? []).map((a) => ({ value: a.id, label: a.name })), { value: "", label: "— clear —" }],
            appId, (v) => call("associate", { ext, app: v || null })),
        )) : [h("div.dim", { style: { padding: "0 11px", fontSize: "11px" } }, "No associations. Right-click a file in Files → Open with…")]),

        h("div.section-label", { style: { padding: "14px 11px 6px" } }, "This machine"),
        h("div.kv", null, h("span.k", "Revision"), h("span.v", `r${d.rev}`)),
        h("div.kv", null, h("span.k", "Custom apps"), h("span.v", String(Object.keys(d.apps).length))),
        h("div.kv", null, h("span.k", "Distro"), h("span.v", d.distro?.name ?? "none")),
        h("div", { style: { padding: "10px", display: "flex", gap: "8px", flexWrap: "wrap" } },
          h("button.app-btn", { onclick: () => ctx.openStudio?.() }, "Open Studio"),
          h("button.app-btn", { onclick: () => (location.href = `/${slug}`) }, "Command Central"),
          h("button.app-btn", {
            onclick: async () => {
              if (await confirmDialog("Reset the desktop?", "Your windows, widgets and theme go back to the first-run seed. It is one revision — undo it from the Studio's history.")) {
                call("reset", {});
              }
            },
          }, "Reset desktop"),
        ),
        h("div.dim", { style: { padding: "0 10px 10px", fontSize: "11px", lineHeight: "1.6" } },
          "Every setting on this page is a ", h("code", "desktop.*"), " call — the same ones an agent makes."),
      );
      void win;
    }

    render();
    return ctx.onDoc?.(render) ?? (() => {});
  },
};

export const APPS = { files, terminal, console: consoleApp, notes, metrics, media, browser, settings };

/** Mount a built-in app into a window body. Returns a stopper, or null when the
 *  id is not built in (a bundle or URL app — the window manager handles those). */
export function mountApp(appId, host, win, ctx) {
  const app = APPS[appId];
  if (!app) return null;
  return app.mount(host, win, ctx) ?? (() => {});
}

export const knownBuiltin = (id) => Object.hasOwn(APPS, id);
