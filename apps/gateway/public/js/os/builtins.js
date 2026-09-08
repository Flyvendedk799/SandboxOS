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
import { OPS_APPS } from "./ops.js";

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
    // Dual pane: a second listing, for moving things between two places.
    let dual = !!win.props?.dual;
    const listEl2 = h("div.file-list.second", { hidden: !dual });
    drop.insertBefore(listEl2, paneEl);
    let cwd2 = win.props?.path2 ?? ".";
    // Tide: which files changed since the last mark, as a badge, when the
    // machine has a workspace. No workspace, no badges — not fake ones.
    let changed = new Map();
    async function tideStatus() {
      const ws = await api.tryMcp("tide", "listWorkspaces", {});
      const first = ws?.workspaces?.[0];
      const name = typeof first === "string" ? first : first?.name;
      if (!name) { changed = new Map(); return; }
      const st = await api.tryMcp("tide", "status", { workspace: name });
      changed = new Map((st?.changes ?? []).map((c) => [String(c.path ?? c.file ?? c).replace(/^\.\//, ""), c.kind ?? c.status ?? "changed"]));
    }

    fill(host, h("div.app", null,
      h("div.app-bar", null,
        h("button.app-btn", { title: "Up a level", onclick: () => go(dirname(cwd)) }, icon("back", 12)),
        crumbs,
        saveBtn,
        h("button.app-btn", { title: "New…", onclick: (e) => newMenu(e.currentTarget) }, icon("plus", 12)),
        h("button.app-btn", { title: dual ? "One pane" : "Two panes", onclick: () => { dual = !dual; listEl2.hidden = !dual; call("windowSet", { id: win.id, props: { dual } }).catch(() => {}); if (dual) go2(cwd2); } }, icon("split", 12)),
        h("button.app-btn", { title: "Refresh", onclick: () => go(cwd) }, icon("refresh", 12)),
      ),
      drop,
    ));

    async function go2(path) {
      cwd2 = path || ".";
      call("windowSet", { id: win.id, props: { path2: cwd2 } }).catch(() => {});
      try {
        const r = await api.mcp("fs", "list", { path: cwd2 });
        const list = [...r.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        fill(listEl2,
          h("button.row-line.head", { onclick: () => go2(dirname(cwd2)) }, h("span", cwd2 === "." ? "/" : `/${cwd2}`), h("span.sz", "↑")),
          ...list.map((e) => {
            const p = join(cwd2, e.name);
            return h("button.row-line", {
              onclick: () => (e.type === "dir" ? go2(p) : open(p)),
              oncontextmenu: (ev) => { ev.preventDefault(); menu({ x: ev.clientX, y: ev.clientY }, [
                { label: `Move to ${cwd === "." ? "/" : "/" + cwd}`, run: async () => { try { await api.mcp("fs", "move", { from: p, to: join(cwd, e.name) }); go(cwd); go2(cwd2); } catch (err) { toastError("Could not move", err); } } },
                { label: `Copy to ${cwd === "." ? "/" : "/" + cwd}`, run: async () => { try { await api.mcp("fs", "copy", { from: p, to: join(cwd, e.name) }); go(cwd); } catch (err) { toastError("Could not copy", err); } } },
              ]); },
            }, h("span", e.type === "dir" ? `${e.name}/` : e.name), h("span.sz", e.type === "dir" ? "" : fmtBytes(e.size)));
          }));
      } catch (e) { fill(listEl2, h("div.dim", { style: { padding: "10px", fontSize: "11px" } }, e.message)); }
    }

    // ── listing ─────────────────────────────────────────────────────────────

    async function go(path) {
      cwd = path || ".";
      openPath = null;
      call("windowSet", { id: win.id, props: { path: cwd } }).catch(() => {});
      crumbs.textContent = cwd === "." ? "/" : `/${cwd}`;
      try {
        const [r] = await Promise.all([api.mcp("fs", "list", { path: cwd }), tideStatus()]);
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
          changed.has(p) ? h("span.tide-badge", { title: `Tide: ${changed.get(p)} since the last mark` }, changed.get(p)[0].toUpperCase()) : null,
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
    if (dual) go2(cwd2);
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
    const input = h("textarea", { spellcheck: "false", rows: 1, placeholder: "ls · run \"npm start\" web · :call fs.list {} · ? plain English" });
    const history = JSON.parse(sessionStorage.getItem(`sbx.console.${slug}`) ?? "[]");
    let hi = history.length;
    let busy = false;

    const scroll = () => { host.querySelector(".app-body").scrollTop = 1e6; };
    const entry = (cmd) => {
      const block = h("div.console-entry", null,
        h("div.in", null, h("span.prompt", "▸"), h("b", cmd), h("span.t", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }))),
        h("div.body"));
      out.append(block);
      scroll();
      return block.querySelector(".body");
    };

    async function run(cmd) {
      const body = entry(cmd);
      history.push(cmd);
      hi = history.length;
      try { sessionStorage.setItem(`sbx.console.${slug}`, JSON.stringify(history.slice(-100))); } catch { /* fine */ }
      busy = true;
      body.append(h("span.spinner"));
      try {
        const r = await api.post(`/${slug}/exec`, { line: cmd });
        body.replaceChildren(...(r.lines ?? []).map((l) => h("div.out", l)));
        if (r.proposed) body.append(h("div.out", `proposed: ${r.proposed}`));
        if (!(r.lines ?? []).length && !r.proposed) body.append(h("div.out.dim", "(no output)"));
      } catch (e) { body.replaceChildren(h("div.err", e.message)); }
      busy = false;
      scroll();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = input.value.trim();
        input.value = ""; input.style.height = "";
        if (cmd && !busy) run(cmd);
      } else if (e.key === "ArrowUp" && !input.value.includes("\n")) {
        e.preventDefault();
        if (hi > 0) { hi -= 1; input.value = history[hi] ?? ""; }
      } else if (e.key === "ArrowDown" && !input.value.includes("\n")) {
        e.preventDefault();
        hi = Math.min(history.length, hi + 1);
        input.value = history[hi] ?? "";
      } else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); out.replaceChildren(); }
    });
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(96, input.scrollHeight)}px`; });

    fill(host, h("div.app", null,
      h("div.app-body", out),
      h("div.term-input.multi", null, h("span", "▸"), input),
    ));
    host.addEventListener("pointerdown", () => setTimeout(() => input.focus(), 0));
    const hello = entry("help");
    hello.append(h("div.out", "Command Central, one line at a time. Shell verbs (ls, cat, run, jobs, logs, port), `:call server.tool {}` for any MCP tool, `? plain English` to have it translated first. ⇧↵ for a second line, ^L to clear."));
    if (win.props?.run) run(String(win.props.run));
    return () => {};
  },
};

// ── Notes ───────────────────────────────────────────────────────────────────

/** A small, closed Markdown renderer: headings, emphasis, code, lists, links.
 *  Everything is escaped first, so a note cannot script the window it is in. */
function renderMarkdown(src) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null, code = null;
  for (const raw of String(src ?? "").split("\n")) {
    if (code !== null) { if (/^```/.test(raw)) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = null; } else code.push(raw); continue; }
    if (/^```/.test(raw)) { code = []; continue; }
    const li = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (hd) { out.push(`<h${hd[1].length}>${inline(hd[2])}</h${hd[1].length}>`); continue; }
    if (/^\s*$/.test(raw)) continue;
    if (/^>\s?/.test(raw)) { out.push(`<blockquote>${inline(raw.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  if (code !== null) out.push(`<pre>${esc(code.join("\n"))}</pre>`);
  return out.join("");
}

const notes = {
  mount(host, win, ctx) {
    // A folder of notes (notes/ by default), a sidebar listing them, and a
    // preview toggle. Still nothing but fs.* — the folder is ordinary files.
    let path = win.props?.path ?? "notes/scratch.md";
    let folder = win.props?.folder ?? (dirname(path) === "." ? "notes" : dirname(path));
    let preview = !!win.props?.preview;
    const ta = h("textarea.note-editor", { spellcheck: "false", placeholder: "Write something… Markdown is welcome." });
    const view = h("div.note-preview", { hidden: true });
    const side = h("div.note-list");
    const nameEl = h("input", { value: basename(path), style: { flex: "1", fontFamily: "var(--mono)" }, title: "Rename this note" });
    const state = h("span.dim", { style: { fontSize: "10.5px" } }, "");
    const previewBtn = h("button.app-btn", { title: "Preview (⌘⇧V)", onclick: () => togglePreview() }, icon("eye", 12));
    let timer = null;

    async function listNotes() {
      try {
        const r = await api.mcp("fs", "list", { path: folder });
        const files = r.entries.filter((e) => e.type === "file" && /\.(md|markdown|txt)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
        fill(side,
          h("div.hd", null, h("span", `/${folder}`), h("button", { title: "New note", onclick: newNote }, icon("plus", 11))),
          ...(files.length ? files.map((f) => h("button.row-line", { class: join(folder, f.name) === path ? "on" : "", onclick: () => switchTo(join(folder, f.name)) }, h("span", f.name))) : [h("div.dim", { style: { padding: "8px 10px", fontSize: "11px" } }, "No notes yet.")]));
      } catch { fill(side, h("div.hd", null, h("span", `/${folder}`), h("button", { title: "New note", onclick: newNote }, icon("plus", 11))), h("div.dim", { style: { padding: "8px 10px", fontSize: "11px" } }, "Folder does not exist yet — the first save creates it.")); }
    }
    async function load() {
      try { const r = await api.mcp("fs", "read", { path }); ta.value = r.content; state.textContent = "loaded"; }
      catch { ta.value = ""; state.textContent = "new file"; }
      nameEl.value = basename(path);
      ctx.setTitle?.(basename(path));
      if (preview) view.innerHTML = renderMarkdown(ta.value);
    }
    async function save() {
      try {
        await api.mcp("fs", "write", { path, content: ta.value });
        state.textContent = `saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        listNotes();
      } catch (e) { toastError("Could not save the note", e); }
    }
    function switchTo(p) {
      clearTimeout(timer);
      path = p;
      call("windowSet", { id: win.id, props: { path, folder } }).catch(() => {});
      load(); listNotes();
    }
    async function newNote() {
      const got = await dialog({ title: "New note", fields: [{ name: "name", label: "Name", placeholder: "ideas.md" }], confirmLabel: "Create" });
      if (!got?.name) return;
      const name = /\.\w+$/.test(got.name) ? got.name : `${got.name}.md`;
      try { await api.mcp("fs", "write", { path: join(folder, name), content: `# ${name.replace(/\.\w+$/, "")}\n\n` }); switchTo(join(folder, name)); }
      catch (e) { toastError("Could not create the note", e); }
    }
    function togglePreview(next = !preview) {
      preview = next;
      view.hidden = !preview; ta.hidden = preview;
      if (preview) view.innerHTML = renderMarkdown(ta.value);
      previewBtn.classList.toggle("primary", preview);
      call("windowSet", { id: win.id, props: { preview } }).catch(() => {});
    }

    ta.addEventListener("input", () => { state.textContent = "…"; clearTimeout(timer); timer = setTimeout(save, 900); });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); clearTimeout(timer); save(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") { e.preventDefault(); togglePreview(); }
    });
    nameEl.addEventListener("change", async () => {
      const next = join(folder, nameEl.value.trim() || basename(path));
      if (next === path) return;
      try { await api.mcp("fs", "move", { from: path, to: next }); switchTo(next); }
      catch { switchTo(next); }
    });

    fill(host, h("div.app", null,
      h("div.app-bar", null, nameEl, state, previewBtn, h("button.app-btn", { onclick: save }, "Save")),
      h("div.app-body", { style: { display: "flex" } }, side, h("div.note-main", null, ta, view)),
    ));
    load(); listNotes();
    if (preview) togglePreview(true);
    return () => clearTimeout(timer);
  },
};

// ── Observability ───────────────────────────────────────────────────────────

const metrics = {
  mount(host, win, ctx) {
    const grid = h("div.stat-grid");
    const sparkLoad = h("div.spark", { title: "load, last 24 samples" });
    const sparkMem = h("div.spark.mem", { title: "memory, last 24 samples" });
    const foot = h("div.metrics-foot");
    const recent = h("div.w-feed", { style: { padding: "0 12px 12px", marginTop: "0" } });
    fill(host, h("div.app", null, h("div.app-body", null, grid,
      h("div.spark-label", "Load"), sparkLoad, h("div.spark-label", "Memory"), sparkMem, foot,
      h("div.spark-label", { style: { display: "flex", justifyContent: "space-between" } }, h("span", "Recent calls"),
        h("a", { href: `/${slug}#activity`, title: "Open the audit explorer in Command Central" }, "audit explorer →")),
      recent)));

    const stat = (k, v, sub) => h("div.stat", null, h("div.k", k), h("div.v", v), sub ? h("div.s", sub) : null);
    const bars = (el, values, max) => fill(el, ...values.map((v) => h("i", { style: { height: `${Math.max(4, (v / max) * 100)}%` }, title: String(v) })));
    let alive = true;

    async function tick() {
      if (!alive || document.hidden) return;
      try {
        const [m, hist, audit] = await Promise.all([
          api.mcp("metrics", "snapshot", {}),
          api.tryMcp("metrics", "history", { limit: 24 }),
          api.tryMcp("metrics", "recent", { limit: 6 }),
        ]);
        const mem = m.memory;
        fill(grid,
          stat("Load", m.load?.[0]?.toFixed(2) ?? "—", m.load ? `${m.load[1]?.toFixed(2)} · ${m.load[2]?.toFixed(2)}` : null),
          stat("Memory", mem?.used ? fmtBytes(mem.used) : "—", mem?.total ? `of ${fmtBytes(mem.total)}` : null),
          stat("Processes", m.processes ?? "—", m.jobs != null ? `${m.jobs} supervised` : null),
          stat("Tools", m.tools ?? "—", m.servers?.length ? `${m.servers.length} servers` : null));
        const samples = hist?.samples ?? [];
        bars(sparkLoad, samples.map((s2) => s2.load ?? 0), Math.max(0.01, ...samples.map((s2) => s2.load ?? 0)));
        bars(sparkMem, samples.map((s2) => s2.memory?.used ?? s2.mem ?? 0), Math.max(1, ...samples.map((s2) => s2.memory?.used ?? s2.mem ?? 0)));
        foot.textContent = `${m.servers?.length ?? 0} servers · ports ${m.ports?.join(", ") || "none"} · ${m.disk?.files ?? "—"} files${m.disk?.bytes ? ` · ${fmtBytes(m.disk.bytes)}` : ""}`;
        const events = audit?.events ?? audit?.recent ?? [];
        fill(recent, ...(events.length ? events.slice(0, 6).map((e) => h("div.line", null,
          h("span", { class: e.result_kind ?? e.resultKind ?? "" }, e.result_kind ?? e.resultKind ?? "?"),
          h("span.what", `${e.server}.${e.tool}`),
          h("span.dim", { style: { marginLeft: "auto" } }, e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")))
          : [h("span.dim", { style: { fontSize: "10px" } }, "nothing yet")]));
      } catch (e) {
        fill(grid, h("div.dim", { style: { padding: "10px", fontSize: "11px" } }, e.message));
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    void win; void ctx;
    return () => { alive = false; clearInterval(id); };
  },
};

// ── Media ───────────────────────────────────────────────────────────────────

const AUDIO = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".m4v"]);

const media = {
  mount(host, win) {
    // A grid of what is in a folder, a lightbox to look at one thing, and a
    // poll that notices when the folder changes. Audio and video play through
    // the same raw file endpoint as images: nothing here is transcoded or
    // uploaded anywhere, and a format the browser cannot play says so.
    let dir = win.props?.path ?? ".";
    if (extname(dir)) dir = dirname(dir);
    const grid = h("div.tile-grid");
    const pathEl = h("input", { value: dir, style: { flex: "1", fontFamily: "var(--mono)" } });
    const count = h("span.dim", { style: { fontSize: "10.5px" } }, "");
    const lightbox = h("div.lightbox", { hidden: true });
    let items = [];
    let shown = -1;
    let stamp = "";

    const kindOf = (name) => (IMAGE.has(extname(name)) ? "image" : AUDIO.has(extname(name)) ? "audio" : VIDEO.has(extname(name)) ? "video" : null);

    async function load({ quiet = false } = {}) {
      try {
        const r = await api.mcp("fs", "list", { path: dir });
        const next = r.entries.filter((e) => e.type === "file" && kindOf(e.name)).map((e) => ({ path: join(dir, e.name), name: e.name, kind: kindOf(e.name), size: e.size }));
        const sig = next.map((i) => `${i.path}:${i.size}`).join("|");
        if (quiet && sig === stamp) return;
        stamp = sig;
        items = next;
        count.textContent = items.length ? `${items.length} items` : "";
        if (!items.length) {
          fill(grid, h("div.dim", { style: { gridColumn: "1 / -1", padding: "12px", fontSize: "11px" } },
            `Nothing to show in /${dir === "." ? "" : dir}. Images, audio and video appear here; point this window anywhere in the machine.`));
          return;
        }
        fill(grid, ...items.map((it, i) => h("button.tile", { title: `${it.name} · ${fmtBytes(it.size)}`, onclick: () => show(i) },
          it.kind === "image" ? h("img", { src: fileUrl(it.path), alt: it.name, loading: "lazy" })
            : h("div.glyph", null, icon(it.kind === "audio" ? "play" : "media", 22), h("span", it.name)))));
      } catch (e) {
        fill(grid, h("div.dim", { style: { gridColumn: "1 / -1", padding: "12px", fontSize: "11px" } }, e.message));
      }
    }

    function show(i) {
      shown = i;
      const it = items[i];
      if (!it) { lightbox.hidden = true; return; }
      const body = it.kind === "image" ? h("img", { src: fileUrl(it.path), alt: it.name })
        : it.kind === "audio" ? h("audio", { src: fileUrl(it.path), controls: true, autoplay: true })
          : h("video", { src: fileUrl(it.path), controls: true, autoplay: true, playsinline: true });
      body.addEventListener("error", () => fill(body.parentElement, h("div.dim", `${it.name}: this browser cannot play ${extname(it.name)}. Download it instead.`)));
      fill(lightbox,
        h("div.lb-bar", null,
          h("span.name", it.name), h("span.dim", fmtBytes(it.size)), h("span.spacer"),
          h("button.app-btn", { onclick: () => show(i - 1), disabled: i === 0 }, "‹"),
          h("span.dim", `${i + 1} / ${items.length}`),
          h("button.app-btn", { onclick: () => show(i + 1), disabled: i >= items.length - 1 }, "›"),
          h("button.app-btn", { onclick: () => window.open(fileUrl(it.path, true), "_blank") }, icon("save", 12)),
          h("button.app-btn", { onclick: () => { lightbox.hidden = true; shown = -1; } }, icon("x", 12))),
        h("div.lb-body", body));
      lightbox.hidden = false;
    }
    lightbox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { lightbox.hidden = true; shown = -1; }
      if (e.key === "ArrowLeft" && shown > 0) show(shown - 1);
      if (e.key === "ArrowRight" && shown < items.length - 1) show(shown + 1);
    });
    lightbox.tabIndex = 0;

    pathEl.addEventListener("change", () => {
      dir = pathEl.value.trim() || ".";
      call("windowSet", { id: win.id, props: { path: dir } }).catch(() => {});
      load();
    });

    fill(host, h("div.app", null,
      h("div.app-bar", null, pathEl, count, h("button.app-btn", { onclick: () => load(), title: "Refresh" }, icon("refresh", 12))),
      h("div.app-body", { style: { position: "relative" } }, grid, lightbox)));
    load();
    // Directory watch: a poll, because fs has no inotify across Cell backends.
    // Cheap (one fs.list), quiet (only repaints on change), and stops with the window.
    const watch = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, 5000);
    return () => clearInterval(watch);
  },
};

// ── Browser ─────────────────────────────────────────────────────────────────

const browser = {
  mount(host, win) {
    // Ports proxied through the Gateway. The window remembers which port and
    // which paths you visited in its props, so a re-opened Browser lands back
    // where you were — on any tab, tomorrow.
    const bar = h("div.app-bar");
    const body = h("div.app-body", { style: { padding: 0 } });
    fill(host, h("div.app", null, bar, body));
    let ports = [];
    let port = win.props?.port ? String(win.props.port) : "";
    let path = win.props?.path ?? "/";
    let history = Array.isArray(win.props?.history) ? win.props.history.slice(-20) : [];
    const persist = () => call("windowSet", { id: win.id, props: { port, path, history } }).catch(() => {});

    // Quick access: what is *listening* right now, exposed or not. One click
    // exposes it (the same ports.expose the Console would run) and opens it —
    // nobody should have to know what "expose" means to see their dev server.
    let listening = [];
    async function scan() {
      const [r, sc] = await Promise.all([api.tryMcp("ports", "list", {}), api.tryMcp("ports", "scan", {})]);
      ports = r?.ports ?? [];
      listening = (sc?.listening ?? []).filter((l) => !ports.some((p) => Number(p.port) === Number(l.port)));
      paintBar();
      if (port && !ports.some((p) => String(p.port) === port)) note(`Port ${port} is not exposed any more. Pick it below and it comes back.`);
      else if (port) show(port, path, { record: false });
      else empty();
    }

    async function quickOpen(p) {
      const already = ports.some((x) => String(x.port) === String(p));
      if (!already) {
        try { await api.mcp("ports", "expose", { port: Number(p), name: `port-${p}` }); }
        catch (e) { toastError(`Could not open port ${p}`, e); return; }
        const r = await api.tryMcp("ports", "list", {});
        ports = r?.ports ?? [];
        listening = listening.filter((l) => Number(l.port) !== Number(p));
      }
      show(String(p), "/");
    }

    function paintBar() {
      const select = h("select", null,
        h("option", { value: "" }, ports.length || listening.length ? "choose a port…" : "nothing listening"),
        ...ports.map((p) => h("option", { value: String(p.port), selected: String(p.port) === port }, `${p.port}${p.name ? ` · ${p.name}` : ""}`)),
        ...listening.map((l) => h("option", { value: `new:${l.port}` }, `${l.port} · running now — open it`)));
      select.addEventListener("change", () => (select.value.startsWith("new:") ? quickOpen(select.value.slice(4)) : show(select.value, "/")));
      const pathEl = h("input", { value: path, placeholder: "/", style: { flex: "1", fontFamily: "var(--mono)" }, title: "Path on the service" });
      pathEl.addEventListener("keydown", (e) => { if (e.key === "Enter") show(port, pathEl.value.trim() || "/"); });
      const hist = h("select.hist", { title: "History" }, h("option", { value: "" }, "history"),
        ...[...history].reverse().map((hh) => h("option", { value: `${hh.port}${hh.path}` }, `:${hh.port}${hh.path}`)));
      hist.addEventListener("change", () => { const m = /^(\d+)(.*)$/.exec(hist.value); if (m) show(m[1], m[2] || "/"); hist.value = ""; });
      fill(bar, select, pathEl, history.length ? hist : null,
        h("button.app-btn", { onclick: () => show(port, path, { record: false }), title: "Reload" }, icon("refresh", 12)),
        h("button.app-btn", { onclick: () => port && window.open(`/${slug}/p/${port}${path}`, "_blank"), title: "Open in a tab", disabled: !port }, icon("browser", 12)),
        h("button.app-btn", { onclick: scan, title: "Look for running services again" }, "Rescan"));
    }

    function empty() {
      const any = ports.length || listening.length;
      fill(body, h("div.browser-empty", null,
        icon("browser", 26),
        h("h3", any ? "Quick access" : "Nothing is listening yet"),
        listening.length ? h("div.port-list", null,
          h("span.dim", { style: { width: "100%", fontSize: "10.5px" } }, "Running inside this machine right now — one click opens it:"),
          ...listening.map((l) => h("button.app-btn.primary", { onclick: () => quickOpen(l.port) }, `:${l.port} — open`))) : null,
        ports.length ? h("div.port-list", null,
          h("span.dim", { style: { width: "100%", fontSize: "10.5px" } }, "Already reachable:"),
          ...ports.map((p) => h("button.app-btn", { onclick: () => show(String(p.port), "/") }, `:${p.port}${p.name ? ` ${p.name}` : ""}`))) : null,
        h("p", null, any
          ? "Opening a port here makes it reachable through the Gateway at this machine's address — WebSockets included, so a dev server's hot reload works."
          : "Start something that listens on a port — a dev server, a notebook, a preview — and it shows up here as soon as it does. Nothing to configure."),
        h("button.app-btn", { onclick: scan }, "Look again")));
    }
    function note(text) { fill(body, h("div.browser-empty", null, icon("browser", 26), h("p", text))); }

    function show(p, nextPath = "/", { record = true } = {}) {
      if (!p) { port = ""; persist(); paintBar(); empty(); return; }
      port = String(p);
      path = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
      if (record) history = [...history.filter((hh) => !(hh.port === port && hh.path === path)), { port, path, at: Date.now() }].slice(-20);
      persist();
      paintBar();
      fill(body, h("iframe", { src: `/${slug}/p/${port}${path}`, style: { width: "100%", height: "100%", border: "0" }, title: `port ${port}` }));
    }

    scan();
    // A dev server started after the window opened should appear without a
    // click: rescan quietly while nothing is shown.
    const rescan = setInterval(() => { if (!port && !document.hidden) scan(); }, 6000);
    return () => clearInterval(rescan);
  },
};

// ── Settings ────────────────────────────────────────────────────────────────

const settings = {
  mount(host, win, ctx) {
    // Every control here is a desktop.* call — the same ones an agent makes.
    // The Desktop section reshapes the machine without opening the Studio.
    const body = h("div.app-body", { style: { padding: "8px" } });
    fill(host, h("div.app", body));
    let section = win.props?.section ?? "desktop";

    // The Gateway says which commit it runs; the page knows nothing until it asks.
    const buildEl = h("span.v", "…");
    api.get("/health").then((hh) => {
      const b = hh?.build;
      buildEl.textContent = b ? `${b.commit ?? "unknown commit"} · up since ${new Date(b.startedAt).toLocaleString()}` : "unavailable";
    }).catch(() => { buildEl.textContent = "unavailable"; });

    function render() {
      const d = os.doc;
      if (!d) return;
      const sel = (options, value, onchange) => {
        const el = h("select", null, ...options.map((o) =>
          h("option", { value: o.value, selected: String(o.value) === String(value) }, o.label)));
        el.addEventListener("change", () => onchange(el.value));
        return el;
      };
      const onoff = (value, onchange) => sel([{ value: "on", label: "on" }, { value: "off", label: "off" }], value ? "on" : "off", (v) => onchange(v === "on"));
      const num = (value, min, max, onchange) => {
        const el = h("input", { type: "number", min, max, value, style: { width: "64px" } });
        el.addEventListener("change", () => onchange(Number(el.value)));
        return el;
      };
      const row = (k, v) => h("div.kv", null, h("span.k", k), v);
      const label = (t) => h("div.section-label", { style: { padding: "14px 11px 6px" } }, t);
      const tab = (id, t) => h("button.chip", { class: section === id ? "on" : "", onclick: () => { section = id; call("windowSet", { id: win.id, props: { section } }).catch(() => {}); render(); } }, t);

      const nameEl = h("input", { value: d.name });
      nameEl.addEventListener("change", () => call("rename", { name: nameEl.value }));
      const assoc = Object.entries(d.shell.associations ?? {});
      const apps = (os.snap.apps ?? []).map((a) => ({ value: a.id, label: a.name }));

      const desktopSection = [
        label("Appearance"),
        row("Theme", sel((os.snap.themes ?? []).map((t) => ({ value: t.key, label: t.name })), d.theme.base, (v) => call("themeSet", { theme: v }))),
        row("Motion", sel((os.snap.animations ?? []).map((a) => ({ value: a.key, label: a.name })), d.animation.preset, (v) => call("animationSet", { preset: v }))),
        row("Reduced motion", sel([{ value: "auto", label: "follow my system setting" }, { value: "ignore", label: "always play the preset" }], d.animation.reducedMotion ?? "auto",
          (v) => call("patch", { patch: { animation: { reducedMotion: v } } }))),
        row("Wallpaper fit", sel(["cover", "contain", "tile"].map((f) => ({ value: f, label: f })), d.shell.wallpaperFit, (v) => call("shellSet", { wallpaperFit: v }))),
        label("Windows"),
        row("Layout", sel([{ value: "floating", label: "floating" }, { value: "tiling", label: "tiling" }], d.wm.mode, (v) => call("layoutSet", { mode: v }))),
        row("Tiling preset", sel([{ value: "", label: "keep the tree" }, ...["master-stack", "columns", "rows", "grid"].map((p) => ({ value: p, label: p }))], "", (v) => v && call("layoutSet", { preset: v }))),
        row("Gap", num(d.wm.gap, 0, 64, (v) => call("layoutSet", { gap: v }))),
        row("Snap to grid", onoff(d.wm.snap, (v) => call("layoutSet", { snap: v }))),
        row("Grid size", num(d.wm.gridSize, 1, 64, (v) => call("layoutSet", { gridSize: v }))),
        label("Dock"),
        row("Position", sel(["bottom", "top", "left", "right", "hidden"].map((p) => ({ value: p, label: p })), d.shell.dock.position, (v) => call("dockSet", { position: v, visible: v !== "hidden" }))),
        row("Size", num(d.shell.dock.size, 28, 96, (v) => call("dockSet", { size: v }))),
        row("Auto-hide", onoff(d.shell.dock.autohide, (v) => call("dockSet", { autohide: v }))),
        row("Pinned", h("span.v", d.shell.dock.pinned.join(", ") || "nothing")),
        label("Menu bar"),
        row("Visible", onoff(d.shell.menubar.visible, (v) => call("shellSet", { menubar: { visible: v } }))),
        row("Clock", onoff(d.shell.menubar.showClock, (v) => call("shellSet", { menubar: { showClock: v } }))),
        row("Status readings", onoff(d.shell.menubar.showStatus, (v) => call("shellSet", { menubar: { showStatus: v } }))),
        label("Notifications"),
        row("Enabled", onoff(d.shell.notifications.enabled, (v) => call("shellSet", { notifications: { enabled: v } }))),
        row("Kept", h("span.v", `${d.notifications.length} of ${os.snap.limits?.notifications ?? 60}`)),
        label("Opens with"),
        ...(assoc.length ? assoc.map(([ext, appId]) => row(h("span.mono", ext),
          sel([...apps, { value: "", label: "— clear —" }], appId, (v) => call("associate", { ext, app: v || null })))) : [h("div.dim", { style: { padding: "0 11px", fontSize: "11px" } }, "No associations. Right-click a file in Files → Open with…")]),
        (() => {
          const ext = h("input", { placeholder: ".csv", style: { width: "70px" } });
          const app = sel(apps, "files", () => {});
          return h("div.kv", null, h("span.k", "Add"), h("span", { style: { display: "flex", gap: "6px" } }, ext, app,
            h("button.app-btn", { onclick: () => ext.value.trim() && call("associate", { ext: ext.value.trim(), app: app.value }).catch((e) => toastError("Could not associate", e)) }, "Set")));
        })(),
      ];

      const machineSection = [
        label("This machine"),
        row("OS name", nameEl),
        row("Revision", h("span.v", `r${d.rev}`)),
        row("Workspaces", h("span.v", String(d.workspaces.length))),
        row("Custom apps", h("span.v", `${Object.keys(d.apps).length}${Object.values(d.apps).filter((a) => a.mcp).length ? ` (${Object.values(d.apps).filter((a) => a.mcp).length} with tools)` : ""}`)),
        row("Distro", h("span.v", d.distro?.name ? `${d.distro.name}${d.distro.tenant ? " · another tenant" : ""}` : "none")),
        row("Server build", buildEl),
        h("div", { style: { padding: "10px", display: "flex", gap: "8px", flexWrap: "wrap" } },
          h("button.app-btn", { onclick: () => ctx.openStudio?.() }, "Open Studio"),
          h("button.app-btn", { onclick: () => (location.href = `/${slug}`) }, "Command Central"),
          h("button.app-btn", { onclick: () => ctx.launch?.("terminal") }, "Terminal"),
          h("button.app-btn", {
            onclick: async () => {
              if (await confirmDialog("Reset the desktop?", "Your windows, widgets and theme go back to the first-run seed. It is one revision — undo it from the Studio's history.")) call("reset", {});
            },
          }, "Reset desktop")),
        h("div.dim", { style: { padding: "0 10px 10px", fontSize: "11px", lineHeight: "1.6" } },
          "Every setting on this page is a ", h("code", "desktop.*"), " call — the same ones an agent makes. ⌘? shows the keyboard."),
      ];

      fill(body,
        h("div.chip-row", { style: { padding: "4px 6px 8px" } }, tab("desktop", "Desktop"), tab("machine", "Machine")),
        ...(section === "machine" ? machineSection : desktopSection));
    }

    render();
    return ctx.onDoc?.(render) ?? (() => {});
  },
};

export const APPS = {
  files, terminal, console: consoleApp, notes, metrics, media, browser, settings,
  // The machine's own work — processes, ports, agents, secrets, sync, access, the
  // audit log — lives in ops.js, so this file stays about the desk and that one
  // stays about the machine.
  ...OPS_APPS,
};

/** Mount a built-in app into a window body. Returns a stopper, or null when the
 *  id is not built in (a bundle or URL app — the window manager handles those). */
export function mountApp(appId, host, win, ctx) {
  const app = APPS[appId];
  if (!app) return null;
  return app.mount(host, win, ctx) ?? (() => {});
}

export const knownBuiltin = (id) => Object.hasOwn(APPS, id);
