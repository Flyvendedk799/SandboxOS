// code.js — the Studio's Code tab: the files behind a custom app or widget, as
// an editor rather than a textarea.
//
// It is the same editor Command Central's Files panel uses (../editor.js), so
// there is one set of keystrokes to learn: syntax colour, indentation, pair
// closing, ⌘/ to comment, ⌘S to save. Saving is `desktop.appWrite` — exactly
// the call an agent makes — and the frame running the app reloads (or, for a
// stylesheet, swaps it in place) because the write announces itself, not
// because this tab told it to.
//
// An app whose source lives in the Cell volume is edited here through `fs.*`
// instead; the tab says so, because the posture is different (Tide versions it,
// a process in the Cell can rewrite it).

import { h, fill, icon, dialog, confirmDialog, menu, toast, toastError, fmtBytes, api } from "../core.js";
import { os, call, onOs } from "./client.js";
import { createEditor, languageFor } from "../editor.js";

const STARTERS = {
  ".html": "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n<link rel=\"stylesheet\" href=\"./app.css\" />\n</head>\n<body>\n\n<script type=\"module\" src=\"./app.js\"></script>\n</body>\n</html>\n",
  ".css": "/* tokens: var(--os-accent), var(--os-text), var(--os-bg-1) … */\n",
  ".js": "// `sbx` is injected by the OS: sbx.mcp(server, tool, args), sbx.read, sbx.write, sbx.notify …\n",
  ".json": "{\n}\n",
  ".md": "# Notes\n",
};

export function createCodePane({ onTargetChange } = {}) {
  let target = null;      // {kind:'app'|'widget', id}
  let files = [];         // [{path,size}]
  let open = [];          // [{path, editor, dirty, value}]
  let active = null;      // path
  let bundleOff = null;

  const treeEl = h("div.code-tree");
  const tabsEl = h("div.code-tabs");
  const editorHost = h("div.code-editor");
  const statusEl = h("div.code-status");
  const picker = h("select.code-picker");
  const el = h("div.code-pane", null,
    h("div.code-head", null, picker,
      h("button.rail-btn.sm", { title: "New file", onclick: () => addFile() }, icon("plus", 13)),
      h("button.rail-btn.sm", { title: "Reload files", onclick: () => loadFiles() }, icon("refresh", 13))),
    h("div.code-body", null, treeEl, h("div.code-main", null, tabsEl, editorHost, statusEl)));

  const isVolume = () => {
    if (!target) return false;
    const def = target.kind === "widget" ? os.doc.widgetKinds[target.id] : os.doc.apps[target.id];
    return def?.origin === "volume";
  };
  const volumeRoot = () => {
    const def = target.kind === "widget" ? os.doc.widgetKinds[target.id] : os.doc.apps[target.id];
    return def?.volumePath ?? `${target.kind}s/${target.id}`;
  };
  const tools = () => (target.kind === "widget"
    ? { list: "widgetFiles", read: "widgetRead", write: "widgetWrite", del: "widgetDelete", key: { kind: target.id } }
    : { list: "appFiles", read: "appRead", write: "appWrite", del: "appDelete", key: { id: target.id } });

  // ── I/O: store bundles through desktop.*, volume apps through fs.* ───────

  async function listFiles() {
    if (isVolume()) {
      const r = await api.mcp("fs", "tree", { path: volumeRoot(), depth: 6, limit: 400 });
      const out = [];
      const walk = (nodes, prefix) => {
        for (const n of nodes ?? []) {
          const rel = prefix ? `${prefix}/${n.name}` : n.name;
          if (n.type === "dir") walk(n.children, rel);
          else out.push({ path: rel, size: n.size ?? 0 });
        }
      };
      walk(r.tree ?? r.children ?? r.entries, "");
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    const t = tools();
    return (await call(t.list, t.key)).files;
  }
  async function readFile(path) {
    if (isVolume()) return (await api.mcp("fs", "read", { path: `${volumeRoot()}/${path}` })).content;
    const t = tools();
    return (await call(t.read, { ...t.key, path })).content;
  }
  async function writeFile(path, content) {
    if (isVolume()) { await api.mcp("fs", "write", { path: `${volumeRoot()}/${path}`, content }); return; }
    const t = tools();
    await call(t.write, { ...t.key, path, content });
  }
  async function deleteFile(path) {
    if (isVolume()) { await api.mcp("fs", "remove", { path: `${volumeRoot()}/${path}` }); return; }
    const t = tools();
    await call(t.del, { ...t.key, path });
  }

  // ── files ─────────────────────────────────────────────────────────────────

  async function loadFiles() {
    if (!target) return;
    try {
      files = await listFiles();
      paintTree();
      if (!active && files[0]) openFile(files[0].path);
      else if (active && !files.some((f) => f.path === active)) { closeTab(active, { force: true }); }
      status(isVolume() ? `${files.length} files in the Cell at ${volumeRoot()} — edited through fs.write, versioned by Tide`
        : `${files.length} files · ${fmtBytes(files.reduce((n, f) => n + f.size, 0))} · saved through desktop.${tools().write}`);
    } catch (e) { status(e.message); }
  }

  function paintTree() {
    // Group by directory so ui/panel.js sits under ui/.
    const dirs = new Map();
    for (const f of files) {
      const i = f.path.lastIndexOf("/");
      const dir = i === -1 ? "" : f.path.slice(0, i);
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(f);
    }
    fill(treeEl, ...[...dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([dir, list]) => [
      dir ? h("div.code-dir", `${dir}/`) : null,
      ...list.map((f) => {
        const tab = open.find((t) => t.path === f.path);
        return h("button.code-file", {
          class: f.path === active ? "on" : "",
          title: f.path,
          onclick: () => openFile(f.path),
          oncontextmenu: (e) => { e.preventDefault(); fileMenu(e, f); },
        }, icon(iconFor(f.path), 13), h("span.nm", f.path.slice(dir ? dir.length + 1 : 0)), tab?.dirty ? h("span.dot") : null);
      }),
    ]));
  }

  const iconFor = (p) => (/\.css$/.test(p) ? "theme" : /\.html?$/.test(p) ? "window" : /\.(png|jpe?g|gif|webp|svg|ico)$/.test(p) ? "media" : "code");

  function fileMenu(e, f) {
    menu({ x: e.clientX, y: e.clientY }, [
      { label: "Open", icon: "code", run: () => openFile(f.path) },
      { label: "Rename…", run: () => renameFile(f.path) },
      "-",
      { label: "Delete", icon: "trash", danger: true, run: async () => {
        if (!await confirmDialog(`Delete ${f.path}?`, "The app's frame reloads without it.")) return;
        try { await deleteFile(f.path); closeTab(f.path, { force: true }); loadFiles(); }
        catch (err) { toastError("Could not delete", err); }
      } },
    ]);
  }

  async function addFile() {
    if (!target) return;
    const got = await dialog({ title: "New file", fields: [{ name: "path", label: "Path", placeholder: "ui/panel.js", hint: "html, css, js, json, md, svg, txt, images" }], confirmLabel: "Create" });
    if (!got?.path) return;
    const p = got.path.trim().replace(/^\.\//, "");
    const ext = p.slice(p.lastIndexOf("."));
    try {
      await writeFile(p, STARTERS[ext] ?? "");
      await loadFiles();
      openFile(p);
    } catch (e) { toastError("Could not create the file", e); }
  }

  async function renameFile(from) {
    const got = await dialog({ title: "Rename", fields: [{ name: "path", label: "New path", value: from }], confirmLabel: "Rename" });
    const to = got?.path?.trim();
    if (!to || to === from) return;
    try {
      const content = open.find((t) => t.path === from)?.editor.getValue() ?? await readFile(from);
      await writeFile(to, content);
      await deleteFile(from);
      closeTab(from, { force: true });
      await loadFiles();
      openFile(to);
    } catch (e) { toastError("Could not rename", e); }
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  async function openFile(path) {
    if (!target) return;
    let tab = open.find((t) => t.path === path);
    if (!tab) {
      let content;
      try { content = await readFile(path); }
      catch (e) { status(`${path}: ${e.message}`); return; }
      if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(path)) { status(`${path} is binary — replace it by writing base64 through desktop.appWrite`); return; }
      const host = h("div.code-editor-slot");
      const editor = createEditor(host, {
        value: content, language: languageFor(path),
        onChange: () => { if (!tab.dirty) { tab.dirty = true; paintTabs(); paintTree(); } },
        onSave: () => saveFile(path),
      });
      tab = { path, editor, host, dirty: false, saved: content };
      open.push(tab);
    }
    active = path;
    paintTabs();
    paintTree();
    fill(editorHost, tab.host);
    tab.editor.focus();
    status(`${path} · ${languageFor(path)}${tab.dirty ? " · unsaved" : ""}`);
  }

  function closeTab(path, { force = false } = {}) {
    const tab = open.find((t) => t.path === path);
    if (!tab) return;
    const go = () => {
      tab.editor.destroy();
      open = open.filter((t) => t !== tab);
      if (active === path) {
        active = open.at(-1)?.path ?? null;
        if (active) openFile(active); else fill(editorHost, empty());
      }
      paintTabs();
      paintTree();
    };
    if (tab.dirty && !force) {
      confirmDialog(`Close ${path} without saving?`, "Your edits since the last save are lost.", { confirmLabel: "Close" }).then((yes) => yes && go());
      return;
    }
    go();
  }

  function paintTabs() {
    fill(tabsEl, ...open.map((t) => h("div.code-tab", { class: t.path === active ? "on" : "" },
      h("button.name", { onclick: () => openFile(t.path) }, t.path.split("/").pop(), t.dirty ? h("span.dot") : null),
      h("button.x", { title: "Close", onclick: () => closeTab(t.path) }, icon("x", 11)))));
  }

  async function saveFile(path = active) {
    const tab = open.find((t) => t.path === path);
    if (!tab) return;
    const value = tab.editor.getValue();
    try {
      await writeFile(path, value);
      tab.dirty = false;
      tab.saved = value;
      paintTabs();
      paintTree();
      status(`saved ${path} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${/\.css$/.test(path) ? " · stylesheet swapped in place" : " · frame reloaded"}`);
      loadFiles();
    } catch (e) { toastError("Could not save", e); }
  }

  async function saveAll() { for (const t of open) if (t.dirty) await saveFile(t.path); }

  // ── the agent wrote a file: show it ──────────────────────────────────────

  /** A file changed under us (an agent's appWrite, another tab). Reload a clean
   *  tab silently; an edited one is left alone and told, never clobbered. */
  async function onBundleChange(id, path) {
    if (!target || id !== target.id) return;
    await loadFiles();
    if (!path) return;
    const tab = open.find((t) => t.path === path);
    if (tab && !tab.dirty) {
      try {
        const content = await readFile(path);
        if (content !== tab.editor.getValue()) { tab.editor.setValue(content, languageFor(path)); tab.saved = content; }
      } catch { /* deleted — loadFiles closed it */ }
      if (active !== path) openFile(path);
      status(`${path} was written by another editor (an agent, or another tab)`);
    } else if (tab?.dirty) {
      status(`${path} changed on the machine while you were editing — save to keep yours, or close the tab to take theirs`);
    } else {
      openFile(path);
    }
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  function status(text) { statusEl.textContent = text; }
  const empty = () => h("div.empty", null, icon("code", 22), h("h3", "No file open"), h("p", "Pick one on the left, or add a file."));

  function paintPicker() {
    const custom = [
      ...Object.values(os.doc.apps).filter((a) => a.kind === "bundle").map((a) => ({ kind: "app", id: a.id, name: a.name })),
      ...Object.values(os.doc.widgetKinds).map((w) => ({ kind: "widget", id: w.kind, name: `${w.name} (widget)` })),
    ];
    fill(picker, ...custom.map((c) => h("option", { value: `${c.kind}:${c.id}`, selected: target && c.kind === target.kind && c.id === target.id }, c.name)));
    return custom;
  }
  picker.addEventListener("change", () => {
    const [kind, id] = picker.value.split(":");
    setTarget({ kind, id });
  });

  function setTarget(next, { path = null } = {}) {
    const same = target && next && target.kind === next.kind && target.id === next.id;
    if (!same) {
      for (const t of open) t.editor.destroy();
      open = [];
      active = null;
      fill(editorHost, empty());
      target = next;
      onTargetChange?.(target);
    }
    paintPicker();
    if (target) loadFiles().then(() => { if (path) openFile(path); });
  }

  /** Called by the builder on every render; cheap when nothing changed. */
  function render() {
    const custom = paintPicker();
    if (!custom.length) { target = null; return false; }
    if (!target || !custom.some((c) => c.kind === target.kind && c.id === target.id)) setTarget({ kind: custom[0].kind, id: custom[0].id });
    return true;
  }

  function attach() {
    bundleOff?.();
    bundleOff = onOs((kind) => {
      if (typeof kind === "string" && kind.startsWith("bundle:")) {
        const id = kind.slice(7);
        onBundleChange(id, os.lastBundleChange?.id === id ? os.lastBundleChange.path : null);
      }
    });
  }
  attach();

  el.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && e.shiftKey) { e.preventDefault(); saveAll(); }
  });

  return {
    el, render, setTarget, openFile, saveAll,
    get target() { return target; },
    get dirty() { return open.some((t) => t.dirty); },
    hasDirty: () => open.some((t) => t.dirty),
    destroy() { bundleOff?.(); for (const t of open) t.editor.destroy(); },
  };
}
