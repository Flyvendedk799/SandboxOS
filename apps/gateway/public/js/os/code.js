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
import { frameLogs, clearFrameLogs, onFrameLog } from "./frames.js";

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
  const findEl = h("div.code-find", { hidden: true });
  const symbolsEl = h("div.code-symbols", { hidden: true });
  const diffEl = h("div.code-diff", { hidden: true });
  const consoleEl = h("div.code-console", { hidden: true });
  let logOff = null;
  const el = h("div.code-pane", null,
    h("div.code-head", null, picker,
      h("button.rail-btn.sm", { title: "Find and replace (⌘F)", onclick: () => toggleFind() }, icon("search", 13)),
      h("button.rail-btn.sm", { title: "Jump to a definition in this file (⌘⇧O)", onclick: () => toggleSymbols() }, icon("tag", 13)),
      h("button.rail-btn.sm", { title: "What has changed since the last save", onclick: () => toggleDiff() }, icon("split", 13)),
      h("button.rail-btn.sm", { title: "The app's own console", onclick: () => toggleConsole() }, icon("list", 13)),
      h("button.rail-btn.sm", { title: "New file", onclick: () => addFile() }, icon("plus", 13)),
      h("button.rail-btn.sm", { title: "Reload files", onclick: () => loadFiles() }, icon("refresh", 13))),
    findEl,
    symbolsEl,
    diffEl,
    h("div.code-body", null, treeEl, h("div.code-main", null, tabsEl, editorHost, consoleEl, statusEl)));

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

  // ── symbols: the definitions in this file ─────────────────────────────────
  //
  // Not a parser. These are the shapes a definition takes in the four languages
  // a bundle is made of, matched line by line, which is enough to answer "where
  // is that defined" in a file of a few hundred lines — and is honest about
  // being a list of lines rather than a symbol table. A wrong jump is cheap; a
  // JavaScript parser in the Studio would not be.
  const SYMBOL_RULES = [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "fn"],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "fn"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "const"],
    [/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/, "method"],
    [/^\s*(#[\w-]+|\.[\w-]+(?:[\s,][^{]*)?)\s*\{/, "css"],
    [/<[a-z][\w-]*[^>]*\sid=["']([\w-]+)["']/i, "id"],
  ];

  function symbolsIn(text, lang) {
    const out = [];
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim() || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const [re, kind] of SYMBOL_RULES) {
        if ((kind === "css" && lang !== "css") || (kind === "id" && lang !== "html")) continue;
        const m = re.exec(line);
        if (!m) continue;
        out.push({ name: m[1].trim(), kind, line: i + 1 });
        break;
      }
    }
    return out;
  }

  function toggleSymbols(want) {
    const show = want ?? symbolsEl.hidden;
    symbolsEl.hidden = !show;
    if (!show) return;
    diffEl.hidden = true;
    const tab = open.find((t) => t.path === active);
    if (!tab) { fill(symbolsEl, h("div.dim", { style: { padding: "8px 10px", fontSize: "11px" } }, "open a file first")); return; }
    const found = symbolsIn(tab.editor.getValue(), tab.editor.language);
    const filter = h("input", { placeholder: `filter ${found.length} definitions`, autofocus: true });
    const list = h("div.hits");
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = q ? found.filter((sym) => sym.name.toLowerCase().includes(q)) : found;
      fill(list, ...(shown.length
        ? shown.slice(0, 200).map((sym) => h("button.hit", {
            onclick: () => { toggleSymbols(false); tab.editor.reveal(sym.line, { column: 1, length: 0 }); },
          }, h("code", sym.kind), h("span.tx", sym.name), h("span.ln", `:${sym.line}`)))
        : [h("div.dim", { style: { padding: "8px 10px", fontSize: "11px" } },
            found.length ? "nothing matches" : "no definitions found in this file")]));
    };
    filter.addEventListener("input", paint);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); toggleSymbols(false); tab.editor.focus(); }
      if (e.key === "Enter") { e.preventDefault(); list.querySelector(".code-hit")?.click(); }
    });
    fill(symbolsEl, h("div.row", null, icon("tag", 13), filter,
      h("button.rail-btn.sm", { title: "Close", onclick: () => toggleSymbols(false) }, icon("x", 12))), list);
    setTimeout(() => filter.focus(), 0);
    paint();
  }

  // ── what has changed since the last save ──────────────────────────────────
  //
  // Every tab already holds the text it was opened or last saved with, so this
  // costs nothing but the comparison: a line diff between what is on disk and
  // what is in front of you. The point is to be able to answer "what am I about
  // to write" before pressing save — including after an agent wrote the file
  // underneath you.
  function lineDiff(before, after) {
    const a = String(before).split("\n");
    const b = String(after).split("\n");
    // Longest common subsequence over lines. Bundle files are small; this is a
    // few hundred by a few hundred at worst.
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ kind: " ", text: a[i], line: j + 1 }); i += 1; j += 1; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "-", text: a[i], line: null }); i += 1; }
      else { out.push({ kind: "+", text: b[j], line: j + 1 }); j += 1; }
    }
    while (i < n) { out.push({ kind: "-", text: a[i], line: null }); i += 1; }
    while (j < m) { out.push({ kind: "+", text: b[j], line: j + 1 }); j += 1; }
    return out;
  }

  function toggleDiff(want) {
    const show = want ?? diffEl.hidden;
    diffEl.hidden = !show;
    if (!show) return;
    symbolsEl.hidden = true;
    const tab = open.find((t) => t.path === active);
    if (!tab) { fill(diffEl, h("div.dim", { style: { padding: "8px 10px", fontSize: "11px" } }, "open a file first")); return; }
    const rows = lineDiff(tab.saved ?? "", tab.editor.getValue());
    const changed = rows.filter((r) => r.kind !== " ");
    // Context only: a hundred unchanged lines is not a diff anybody reads.
    const keep = new Set();
    rows.forEach((r, idx) => { if (r.kind !== " ") { for (let k = idx - 2; k <= idx + 2; k += 1) keep.add(k); } });
    fill(diffEl,
      h("div.row", null, icon("split", 13),
        h("span.dim", changed.length
          ? `${changed.filter((r) => r.kind === "+").length} added, ${changed.filter((r) => r.kind === "-").length} removed since the last save`
          : "nothing has changed since the last save"),
        h("span.spacer"),
        h("button.rail-btn.sm", { title: "Close", onclick: () => toggleDiff(false) }, icon("x", 12))),
      ...(changed.length
        ? [h("div.code-diff-body", null, ...rows
            .map((r, idx) => (keep.has(idx)
              ? h("div.code-diff-line", { class: r.kind === "+" ? "add" : r.kind === "-" ? "del" : "" },
                  h("span.ln", r.line ? String(r.line) : ""),
                  h("span.mk", r.kind),
                  h("span.tx", r.text || " "))
              : null))
            .filter(Boolean))]
        : []));
  }

  // ── find and replace, across the whole bundle ─────────────────────────────
  //
  // A bundle is a handful of files that refer to each other, so "where is this
  // used" is a question about the bundle rather than about the open tab.
  // Searching reads every file (they are small, and already ours); replacing
  // writes them through the same appWrite an agent uses, one revision per file.

  const findInput = h("input", { placeholder: "find", oninput: () => runFind() });
  const replaceInput = h("input", { placeholder: "replace with" });
  const findHits = h("div.hits");
  const findCount = h("span.dim", "");
  fill(findEl,
    h("div.row", null,
      findInput, replaceInput,
      h("button.app-btn", { onclick: () => replaceIn(active) }, "Replace here"),
      h("button.app-btn", { onclick: () => replaceIn(null) }, "Replace everywhere"),
      findCount,
      h("button.rail-btn.sm", { title: "Close", onclick: () => toggleFind(false) }, icon("x", 12))),
    findHits);

  function toggleFind(show = findEl.hidden) {
    findEl.hidden = !show;
    if (show) { findInput.focus(); findInput.select(); runFind(); }
  }

  /** Every file's current text: an open tab's live value wins over the store. */
  async function bundleText() {
    const out = new Map();
    for (const f of files) {
      const tab = open.find((t) => t.path === f.path);
      if (tab) { out.set(f.path, tab.editor.getValue()); continue; }
      if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(f.path)) continue;
      try { out.set(f.path, await readFile(f.path)); } catch { /* unreadable is not a hit */ }
    }
    return out;
  }

  async function runFind() {
    const needle = findInput.value;
    if (!needle) { fill(findHits); findCount.textContent = ""; return; }
    const texts = await bundleText();
    let total = 0;
    const rows = [];
    for (const [path, text] of texts) {
      text.split("\n").forEach((line, i) => {
        let at = line.indexOf(needle);
        while (at !== -1) {
          total += 1;
          if (rows.length < 200) {
            const col = at + 1;
            rows.push(h("button.hit", { onclick: () => goTo(path, i + 1, col, needle.length) },
              h("code", path.split("/").pop()), h("span.ln", String(i + 1)), h("span.tx", line.trim().slice(0, 90))));
          }
          at = line.indexOf(needle, at + needle.length);
        }
      });
    }
    findCount.textContent = `${total} match${total === 1 ? "" : "es"} in ${texts.size} file${texts.size === 1 ? "" : "s"}`;
    fill(findHits, ...(rows.length ? rows : [h("div.dim.ops-none", "no matches")]));
  }

  async function goTo(path, line, column, length) {
    await openFile(path);
    open.find((t) => t.path === path)?.editor.reveal(line, { column, length });
  }

  /** Replace in one file, or in every file. Each write is its own revision. */
  async function replaceIn(onlyPath) {
    const needle = findInput.value;
    if (!needle) return;
    const next = replaceInput.value;
    const texts = await bundleText();
    let changed = 0, hits = 0;
    for (const [path, text] of texts) {
      if (onlyPath && path !== onlyPath) continue;
      if (!text.includes(needle)) continue;
      hits += text.split(needle).length - 1;
      const replaced = text.split(needle).join(next);
      const tab = open.find((t) => t.path === path);
      if (tab) tab.editor.setValue(replaced);
      await writeFile(path, replaced);
      if (tab) { tab.dirty = false; tab.saved = replaced; }
      changed += 1;
    }
    paintTabs(); paintTree();
    status(`replaced ${hits} in ${changed} file${changed === 1 ? "" : "s"}`);
    runFind();
  }

  // ── the app's own console ─────────────────────────────────────────────────
  //
  // A custom app runs in an opaque-origin frame, so its errors used to die where
  // the person who could fix them could not see them (goal.md T2.2). bridge.js
  // reports them out; this is where they land, beside the source.

  function toggleConsole(show = consoleEl.hidden) {
    consoleEl.hidden = !show;
    if (show) paintConsole();
  }

  function paintConsole() {
    if (consoleEl.hidden || !target) return;
    const list = frameLogs(target.id);
    fill(consoleEl,
      h("div.hd", null,
        h("b", "Console"), h("span.dim", target.id),
        h("span.spacer"),
        h("button.app-btn", { onclick: () => { clearFrameLogs(target.id); paintConsole(); } }, "Clear"),
        h("button.rail-btn.sm", { title: "Hide", onclick: () => toggleConsole(false) }, icon("x", 12))),
      h("div.lines", null, ...(list.length
        ? list.slice(-120).map((l) => h("div.line", { class: l.level },
            h("span.t", new Date(l.at).toLocaleTimeString()),
            h("span.m", l.text),
            l.where ? h("span.where", l.where) : null))
        : [h("div.dim.ops-none", "nothing from this app yet — errors, warnings and console.error land here")])));
    const lines = consoleEl.querySelector(".lines");
    if (lines) lines.scrollTop = lines.scrollHeight;
  }

  // An error while the console is closed still deserves to be noticed once.
  logOff = onFrameLog((id, entry) => {
    if (!target || id !== target.id) return;
    if (!consoleEl.hidden) { paintConsole(); return; }
    if (entry?.level === "error") {
      status(`${target.id}: ${entry.text.slice(0, 80)}`);
      toast("The app reported an error", { body: entry.text.slice(0, 160), kind: "err", timeout: 4500 });
      toggleConsole(true);
    }
  });

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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); toggleFind(true); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); toggleSymbols(true); }
    if (e.key === "Escape" && !findEl.hidden) { e.preventDefault(); toggleFind(false); }
    if (e.key === "Escape" && !symbolsEl.hidden) { e.preventDefault(); toggleSymbols(false); }
    if (e.key === "Escape" && !diffEl.hidden) { e.preventDefault(); toggleDiff(false); }
  });

  return {
    el, render, setTarget, openFile, saveAll,
    get target() { return target; },
    get dirty() { return open.some((t) => t.dirty); },
    hasDirty: () => open.some((t) => t.dirty),
    find: (show = true) => toggleFind(show),
    console: (show = true) => toggleConsole(show),
    destroy() { bundleOff?.(); logOff?.(); for (const t of open) t.editor.destroy(); },
  };
}
