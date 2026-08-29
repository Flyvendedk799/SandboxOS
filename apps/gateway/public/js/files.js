// files.js — the Files workspace: a lazy tree on the left, a tabbed editor on
// the right, and every mutation going through the Kernel's fs server so it lands
// in the audit log exactly like a command typed at the console.

import {
  $, h, clear, fill, icon, api, bus, state, toast, toastError, dialog, confirmDialog,
  menu, fmtBytes, fmtAgo, basename, dirname, extname, emptyState, debounce, mod,
} from "./core.js";
import { createEditor, languageFor } from "./editor.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif", ".bmp"]);
const BINARY_EXT = new Set([".pdf", ".zip", ".gz", ".tar", ".mp3", ".mp4", ".webm", ".wav",
  ".woff", ".woff2", ".ttf", ".otf", ".so", ".dylib", ".exe", ".bin", ".db", ".sqlite"]);

/** A folder-ish glyph per file kind — enough signal to scan a tree quickly. */
function glyphFor(entry) {
  if (entry.type === "dir") return "▸";
  const ext = extname(entry.name);
  if (IMAGE_EXT.has(ext)) return "▣";
  if (BINARY_EXT.has(ext)) return "▨";
  return "▤";
}

export function initFiles() {
  const treeEl = $("#tree");
  const tabsEl = $("#editor-tabs");
  const hostEl = $("#editor-host");
  const pathEl = $("#editor-path");
  const posEl = $("#editor-pos");
  const saveBtn = $("#editor-save");
  const dlBtn = $("#editor-download");

  /** Expansion + child cache, keyed by directory path. */
  const expanded = new Set();
  const children = new Map();
  /** Open documents, keyed by path. */
  const docs = new Map();
  let activePath = null;
  let selectedPath = null;
  let filter = "";
  let editor = null;

  // ── Tree ───────────────────────────────────────────────────────────────────

  async function loadDir(path) {
    if (children.has(path)) return children.get(path);
    const { entries } = await api.mcp("fs", "list", { path });
    children.set(path, entries);
    return entries;
  }

  async function refresh(path = ".") {
    children.delete(path);
    await loadDir(path).catch(() => {});
    renderTree();
  }

  async function refreshAll() {
    children.clear();
    await loadDir(".").catch((e) => toastError("Could not list files", e));
    renderTree();
  }

  function matches(name) {
    return !filter || name.toLowerCase().includes(filter);
  }

  function renderNode(entry, dir) {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    const isDir = entry.type === "dir";
    const open = expanded.has(path);

    const node = h("div.tree-node", {
      class: selectedPath === path ? "selected" : "",
      title: `${path}${isDir ? "" : ` · ${fmtBytes(entry.size)} · ${fmtAgo(entry.mtime)}`}`,
      onclick: () => (isDir ? toggleDir(path) : openFile(path)),
      oncontextmenu: (e) => { e.preventDefault(); nodeMenu(e, path, entry, dir); },
    },
      h("span.tw", { class: open ? "open" : "" }, isDir ? "▶" : ""),
      h("span.ic", glyphFor(entry)),
      h("span.nm", entry.name),
      isDir ? null : h("span.sz", fmtBytes(entry.size)),
    );

    if (!isDir || !open) return node;
    const kids = children.get(path);
    const wrap = h("div.tree-children");
    if (!kids) wrap.append(h("div.tree-node.dim", null, h("span.tw"), h("span.nm", "loading…")));
    else if (!kids.length) wrap.append(h("div.tree-node.dim", null, h("span.tw"), h("span.nm", "empty")));
    else for (const kid of kids) if (matches(kid.name) || kid.type === "dir") wrap.append(renderNode(kid, path));
    return h("div", null, node, wrap);
  }

  function renderTree() {
    const root = children.get(".");
    if (!root) {
      fill(treeEl, h("div", null, ...Array.from({ length: 7 }, () =>
        h("div.skeleton", { style: { margin: "8px 10px", width: `${45 + Math.random() * 45}%` } }))));
      return;
    }
    const visible = root.filter((e) => matches(e.name) || e.type === "dir");
    if (!visible.length) {
      fill(treeEl, emptyState("▤", filter ? "No matches" : "Empty sandbox",
        filter ? `Nothing here matches “${filter}”.` : "Create a file to get started.",
        filter ? null : { label: "New file", run: () => newFile(".") }));
      return;
    }
    fill(treeEl, ...visible.map((e) => renderNode(e, ".")));
  }

  async function toggleDir(path) {
    if (expanded.has(path)) expanded.delete(path);
    else {
      expanded.add(path);
      renderTree();
      try { await loadDir(path); } catch (e) { toastError(`Could not open ${path}`, e); expanded.delete(path); }
    }
    renderTree();
  }

  /** Expand every ancestor of `path` so a deep file becomes visible in the tree. */
  async function revealPath(path) {
    const parts = path.split("/").slice(0, -1);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      expanded.add(acc);
      await loadDir(acc).catch(() => {});
    }
    renderTree();
  }

  function nodeMenu(e, path, entry, dir) {
    const isDir = entry.type === "dir";
    menu({ x: e.clientX, y: e.clientY }, [
      isDir
        ? { label: "New file here", icon: "plus", run: () => newFile(path) }
        : { label: "Open", icon: "files", run: () => openFile(path) },
      isDir ? { label: "New folder here", icon: "files", run: () => newFolder(path) } : null,
      "-",
      { label: "Rename…", run: () => renamePath(path, dir) },
      { label: "Duplicate", run: () => duplicatePath(path) },
      !isDir ? { label: "Download", icon: "down", run: () => download(path) } : null,
      { label: "Copy path", run: () => navigator.clipboard?.writeText(path).then(() => toast("Path copied", { body: path })) },
      "-",
      { label: "Delete…", icon: "trash", danger: true, run: () => deletePath(path, isDir, dir) },
    ].filter(Boolean));
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async function newFile(dir) {
    const got = await dialog({
      title: "New file",
      fields: [{ name: "name", label: "Path", placeholder: "src/index.js", value: dir === "." ? "" : `${dir}/` }],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    try {
      await api.mcp("fs", "write", { path: got.name, content: "" });
      await refresh(dirname(got.name));
      await revealPath(got.name);
      openFile(got.name);
      toast("File created", { body: got.name, kind: "ok" });
    } catch (e) { toastError("Could not create file", e); }
  }

  async function newFolder(dir) {
    const got = await dialog({
      title: "New folder",
      fields: [{ name: "name", label: "Path", placeholder: "src/components", value: dir === "." ? "" : `${dir}/` }],
      confirmLabel: "Create",
    });
    if (!got?.name) return;
    try {
      await api.mcp("fs", "mkdir", { path: got.name });
      await refresh(dirname(got.name));
      renderTree();
      toast("Folder created", { body: got.name, kind: "ok" });
    } catch (e) { toastError("Could not create folder", e); }
  }

  async function renamePath(path, dir) {
    const got = await dialog({
      title: "Rename", message: path,
      fields: [{ name: "to", label: "New path", value: path }],
      confirmLabel: "Rename",
    });
    if (!got?.to || got.to === path) return;
    try {
      await api.mcp("fs", "move", { from: path, to: got.to });
      if (docs.has(path)) {
        const doc = docs.get(path);
        docs.delete(path);
        docs.set(got.to, { ...doc, path: got.to });
        if (activePath === path) activePath = got.to;
      }
      await refresh(dir);
      await refresh(dirname(got.to));
      renderTabs();
      renderTree();
      toast("Renamed", { body: `${path} → ${got.to}`, kind: "ok" });
    } catch (e) { toastError("Rename failed", e); }
  }

  async function duplicatePath(path) {
    const ext = extname(path);
    const to = ext ? `${path.slice(0, -ext.length)}-copy${ext}` : `${path}-copy`;
    try {
      await api.mcp("fs", "copy", { from: path, to });
      await refresh(dirname(path));
      renderTree();
      toast("Duplicated", { body: to, kind: "ok" });
    } catch (e) { toastError("Copy failed", e); }
  }

  async function deletePath(path, isDir, dir) {
    const yes = await confirmDialog(
      `Delete ${isDir ? "folder" : "file"}?`,
      `${path} will be removed from the Sandbox${isDir ? ", along with everything inside it" : ""}. This cannot be undone.`,
      { confirmLabel: "Delete" },
    );
    if (!yes) return;
    try {
      await api.mcp("fs", "remove", { path, recursive: isDir });
      closeTab(path, true);
      expanded.delete(path);
      await refresh(dir ?? dirname(path));
      renderTree();
      toast("Deleted", { body: path, kind: "ok" });
    } catch (e) { toastError("Delete failed", e); }
  }

  const download = (path) => { location.href = api.fileUrl(path, true); };

  async function uploadFiles(fileList) {
    let done = 0;
    for (const file of fileList) {
      try {
        await api.uploadFile(file.name, file);
        done += 1;
      } catch (e) { toastError(`Upload failed: ${file.name}`, e); }
    }
    if (done) {
      await refresh(".");
      renderTree();
      toast(`Uploaded ${done} file${done === 1 ? "" : "s"}`, { kind: "ok" });
    }
  }

  // ── Tabs + editor ──────────────────────────────────────────────────────────

  function renderTabs() {
    clear(tabsEl);
    for (const [path, doc] of docs) {
      tabsEl.append(h("button.editor-tab", {
        class: [path === activePath ? "active" : "", doc.dirty ? "dirty" : ""].filter(Boolean).join(" "),
        title: path,
        onclick: () => activate(path),
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(path); } },
      },
        h("span", basename(path)),
        h("span.x", { onclick: (e) => { e.stopPropagation(); closeTab(path); } }),
      ));
    }
  }

  function showBlank() {
    editor?.destroy();
    editor = null;
    activePath = null;
    pathEl.textContent = "no file open";
    posEl.textContent = "";
    saveBtn.disabled = true;
    dlBtn.disabled = true;
    fill(hostEl, h("div.editor-blank", null, emptyState("⇌", "No file open",
      `Pick a file from the tree, or press ${mod}+K and start typing a filename.`)));
  }

  async function openFile(path) {
    selectedPath = path;
    if (docs.has(path)) { activate(path); renderTree(); return; }

    const ext = extname(path);
    if (IMAGE_EXT.has(ext)) { docs.set(path, { path, kind: "image" }); activate(path); renderTabs(); renderTree(); return; }
    if (BINARY_EXT.has(ext)) { docs.set(path, { path, kind: "binary" }); activate(path); renderTabs(); renderTree(); return; }

    try {
      const { content } = await api.mcp("fs", "read", { path });
      docs.set(path, { path, kind: "text", content, saved: content, dirty: false });
      renderTabs();
      activate(path);
      renderTree();
    } catch (e) {
      // A read failure on a file with an unknown extension is usually "it is binary".
      docs.set(path, { path, kind: "binary" });
      renderTabs();
      activate(path);
      toast("Opened as binary", { body: `${path} is not UTF-8 text`, kind: "warn" });
    }
  }

  function activate(path) {
    const doc = docs.get(path);
    if (!doc) return showBlank();
    activePath = path;
    selectedPath = path;
    pathEl.textContent = path;
    dlBtn.disabled = false;
    renderTabs();
    renderTree();

    editor?.destroy();
    editor = null;

    if (doc.kind === "image") {
      saveBtn.disabled = true;
      posEl.textContent = "image";
      fill(hostEl, h("div.preview-host", null, h("img", { src: api.fileUrl(path), alt: path })));
      return;
    }
    if (doc.kind === "binary") {
      saveBtn.disabled = true;
      posEl.textContent = "binary";
      fill(hostEl, h("div.preview-host", null, emptyState("▨", "Binary file",
        "This file is not text. Download it to inspect it locally.",
        { label: "Download", run: () => download(path) })));
      return;
    }

    saveBtn.disabled = !doc.dirty;
    posEl.textContent = "";
    const mount = h("div", { style: { display: "flex", flex: "1", minHeight: "0" } });
    fill(hostEl, mount);
    editor = createEditor(mount, {
      value: doc.content,
      language: languageFor(path),
      onChange: (v) => {
        doc.content = v;
        const dirty = v !== doc.saved;
        if (dirty !== doc.dirty) { doc.dirty = dirty; renderTabs(); }
        saveBtn.disabled = !dirty;
      },
      onSave: () => save(path),
    });
    editor.onCaret(({ line, col }) => { posEl.textContent = `Ln ${line}, Col ${col}`; });
    editor.focus();
    const c = editor.caret();
    posEl.textContent = `Ln ${c.line}, Col ${c.col}`;
  }

  async function save(path = activePath) {
    const doc = docs.get(path);
    if (!doc || doc.kind !== "text") return;
    try {
      await api.mcp("fs", "write", { path, content: doc.content });
      doc.saved = doc.content;
      doc.dirty = false;
      renderTabs();
      if (path === activePath) saveBtn.disabled = true;
      children.delete(dirname(path));
      await loadDir(dirname(path)).catch(() => {});
      renderTree();
      toast("Saved", { body: path, kind: "ok", timeout: 1800 });
    } catch (e) { toastError("Save failed", e); }
  }

  async function closeTab(path, force = false) {
    const doc = docs.get(path);
    if (!doc) return;
    if (doc.dirty && !force) {
      const yes = await confirmDialog("Discard unsaved changes?",
        `${path} has changes that have not been written to the Sandbox.`,
        { confirmLabel: "Discard" });
      if (!yes) return;
    }
    docs.delete(path);
    renderTabs();
    if (activePath === path) {
      const next = [...docs.keys()].pop();
      if (next) activate(next); else showBlank();
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  $("#tree-refresh").addEventListener("click", () => refreshAll());
  $("#file-new").addEventListener("click", () => newFile("."));
  $("#file-upload").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
  $("#editor-save").addEventListener("click", () => save());
  $("#editor-download").addEventListener("click", () => activePath && download(activePath));
  $("#tree-filter").addEventListener("input", debounce((e) => {
    filter = e.target.value.trim().toLowerCase();
    renderTree();
  }, 120));

  // Drag a file from the desktop onto the tree to upload it.
  const pane = $("#ws-files");
  pane.addEventListener("dragover", (e) => { e.preventDefault(); pane.style.outline = "2px dashed var(--accent)"; });
  pane.addEventListener("dragleave", () => { pane.style.outline = ""; });
  pane.addEventListener("drop", (e) => {
    e.preventDefault();
    pane.style.outline = "";
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  showBlank();
  bus.on("workspace:files", () => { if (!children.has(".")) refreshAll(); });
  bus.on("files:changed", () => refreshAll());

  return {
    refresh: refreshAll,
    open: async (path) => { await revealPath(path); openFile(path); },
    save,
    /** Paths currently known to the tree — the palette searches these. */
    known() {
      const out = [];
      for (const [dir, entries] of children) {
        for (const e of entries) out.push({ path: dir === "." ? e.name : `${dir}/${e.name}`, type: e.type });
      }
      return out;
    },
  };
}
