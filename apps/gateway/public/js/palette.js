// palette.js — ⌘K.
//
// One box that answers "where is that thing". It searches four sources at once:
// workspaces, actions registered by panels, files in the tree, and the live MCP
// tool catalogue. Ranking is a small fuzzy subsequence score, so `pjs` finds
// `packages/kernel/proc.js` and `fsw` finds `fs.write`.

import { $, h, fill, icon, api, bus, state, toast } from "./core.js";
import { WORKSPACES, show } from "./shell.js";

/** Fuzzy subsequence score, or -1 when `q` is not a subsequence of `text`. */
export function score(text, q) {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, s = 0, streak = 0;
  for (const ch of q.toLowerCase()) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return -1;
    // Consecutive characters and matches at a word boundary are worth more.
    streak = at === ti ? streak + 1 : 0;
    const boundary = at === 0 || /[\s/._-]/.test(t[at - 1]);
    s += 10 + streak * 6 + (boundary ? 8 : 0) - Math.min(at - ti, 12);
    ti = at + 1;
  }
  return s + Math.max(0, 30 - text.length) / 3;
}

/** The single live palette instance's opener, wired up by initPalette(). */
let openPalette = () => {};

const actions = [];
/** Panels register their own verbs here so the palette stays a single surface. */
export function registerAction(action) { actions.push(action); }

export function initPalette({ files, assistant, runCommand } = {}) {
  let backdrop = null;
  let items = [];
  let cursor = 0;

  function baseItems() {
    const out = WORKSPACES.map((w) => ({
      group: "Go to", icon: w.icon, label: w.label, sub: `⌘${w.key}`,
      run: () => show(w.id),
    }));
    for (const a of actions) {
      out.push({ group: a.group ?? "Actions", icon: a.icon ?? "console", label: a.label, sub: a.sub, run: a.run });
    }
    return out;
  }

  function search(q) {
    const pool = [...baseItems()];

    for (const f of files?.known?.() ?? []) {
      if (f.type === "dir") continue;
      pool.push({ group: "Files", icon: "files", label: f.path, run: () => { show("files"); files.open(f.path); } });
    }
    for (const t of state.tools ?? []) {
      pool.push({ group: "MCP tools", icon: "console", label: t, sub: "run",
        run: () => runCommand?.(`:call ${t} {}`) });
    }
    if (q.trim()) {
      pool.push({ group: "Console", icon: "console", label: `Run: ${q}`, sub: "⏎",
        run: () => runCommand?.(q), always: true });
      pool.push({ group: "Console", icon: "console", label: `Translate: ${q}`, sub: "natural language",
        run: () => runCommand?.(`? ${q}`), always: true });
      if (assistant) {
        pool.push({ group: "Console", icon: "assistant", label: `Ask the assistant: ${q}`, sub: "chat",
          run: () => assistant.ask(q), always: true });
      }
    }

    if (!q.trim()) return pool.filter((i) => !i.always).slice(0, 40);
    return pool
      .map((i) => ({ i, s: i.always ? 1e6 : score(i.label, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.i);
  }

  function render(list, q) {
    items = search(q);
    cursor = 0;
    if (!items.length) {
      fill(list, h("div.palette-empty", `Nothing matches “${q}”.`));
      return;
    }
    clearAndGroup(list);
  }

  function clearAndGroup(list) {
    fill(list);
    let group = null;
    items.forEach((item, idx) => {
      if (item.group !== group) {
        group = item.group;
        list.append(h("div.palette-group", group));
      }
      list.append(h("div.palette-item", {
        class: idx === cursor ? "on" : "",
        dataset: { idx: String(idx) },
        onmousemove: () => setCursor(list, idx),
        onclick: () => choose(idx),
      },
        h("span.ic", icon(item.icon ?? "console")),
        h("span.lbl", item.label),
        item.sub ? h("span.sub", item.sub) : null,
      ));
    });
  }

  function setCursor(list, idx) {
    if (idx === cursor) return;
    list.querySelector(".palette-item.on")?.classList.remove("on");
    cursor = Math.max(0, Math.min(items.length - 1, idx));
    const el = list.querySelector(`.palette-item[data-idx="${cursor}"]`);
    el?.classList.add("on");
    el?.scrollIntoView({ block: "nearest" });
  }

  function choose(idx) {
    const item = items[idx ?? cursor];
    close();
    item?.run?.();
  }

  function close() {
    backdrop?.remove();
    backdrop = null;
  }

  openPalette = function open(initial = "") {
    if (backdrop) return;
    const list = h("div.palette-list");
    const input = h("input", {
      placeholder: "Search files, tools, actions… or type a command",
      value: initial,
      oninput: (e) => render(list, e.target.value),
      onkeydown: (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setCursor(list, cursor + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(list, cursor - 1); }
        else if (e.key === "Enter") { e.preventDefault(); choose(); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      },
    });
    backdrop = h("div.backdrop.top", { onmousedown: (e) => { if (e.target === backdrop) close(); } },
      h("div.palette", null, input, list));
    $("#overlays").append(backdrop);
    render(list, initial);
    input.focus();
    input.select();
  };

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (backdrop) close(); else openPalette();
    }
  });
  $("#omni").addEventListener("click", () => openPalette());

  return { open: (q) => openPalette(q), close };
}
