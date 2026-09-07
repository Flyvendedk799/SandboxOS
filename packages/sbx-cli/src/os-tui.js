// os-tui.js — the desktop, in a terminal.
//
// The second renderer the document was always meant to have. It reads
// `desktop.state`, follows `/:slug/os/events` so it stays current without
// polling, and drives the machine with the same tools the browser shell uses:
// focus, close, open, workspaceSwitch, layoutSet. If a machine's browser tab is
// closed and you are on SSH, this is still your desktop.
//
// Rendering is deliberately plain ANSI: no dependency, no alternate-screen
// tricks beyond clearing and homing. It proves the contract, it does not
// compete with the browser.

import { summarizeDoc } from "../../os/src/summary.js";
import { treeBoxes, pruneTree } from "../../os/src/layout.js";

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const accent = (s) => `${ESC}[36m${s}${ESC}[0m`;
const inv = (s) => `${ESC}[7m${s}${ESC}[0m`;

export async function runTui({ cfg, api, die }) {
  const desktop = async (tool, args = {}) => {
    const res = await api(cfg, `/${cfg.slug}/mcp`, { method: "POST", body: { server: "desktop", tool, args } });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || `desktop.${tool} failed`);
    return d.result;
  };

  let doc = (await desktop("state")).doc;
  let snap = null;
  try { snap = await desktop("get"); } catch { /* catalogs are a nicety */ }
  let cursor = 0;
  let view = "windows";   // windows | map
  let message = "";

  const out = (s) => process.stdout.write(s);
  const size = () => ({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });

  function windowsHere() {
    return doc.windows.filter((w) => w.ws === doc.activeWorkspace).sort((a, b) => b.z - a.z);
  }
  const appName = (id) => snap?.apps?.find((a) => a.id === id)?.name ?? id;

  /** A miniature of the workspace: boxes in character cells, from the same tree
   *  arithmetic the browser uses. Floating windows use their own geometry. */
  function miniature(width, height) {
    const grid = Array.from({ length: height }, () => Array(width).fill(" "));
    const wins = windowsHere().filter((w) => !w.min);
    let boxes;
    if (doc.wm.mode === "tiling") {
      const ws = doc.workspaces.find((w) => w.n === doc.activeWorkspace);
      boxes = treeBoxes(pruneTree(ws?.layout, wins.map((w) => w.id)), { x: 0, y: 0, w: width, h: height }, 0);
    } else {
      const vw = Math.max(1, ...wins.map((w) => w.x + w.w), 1280), vh = Math.max(1, ...wins.map((w) => w.y + w.h), 800);
      boxes = new Map(wins.map((w) => [w.id, { x: Math.floor(w.x / vw * width), y: Math.floor(w.y / vh * height), w: Math.max(3, Math.floor(w.w / vw * width)), h: Math.max(2, Math.floor(w.h / vh * height)) }]));
    }
    for (const w of [...wins].reverse()) {
      const b = boxes.get(w.id);
      if (!b) continue;
      const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(width - 1, b.x + b.w - 1), y1 = Math.min(height - 1, b.y + b.h - 1);
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        grid[y][x] = (y === y0 || y === y1) ? "─" : (x === x0 || x === x1) ? "│" : " ";
      }
      if (x1 > x0 && y1 > y0) { grid[y0][x0] = "┌"; grid[y0][x1] = "┐"; grid[y1][x0] = "└"; grid[y1][x1] = "┘"; }
      const label = ` ${w.title.slice(0, Math.max(0, x1 - x0 - 3))} `;
      for (let i = 0; i < label.length && x0 + 1 + i < x1; i += 1) grid[y0][x0 + 1 + i] = label[i];
    }
    return grid.map((r) => r.join(""));
  }

  function paint() {
    const { cols, rows } = size();
    const lines = [];
    const wsBar = doc.workspaces.map((w) => (w.n === doc.activeWorkspace ? inv(` ${w.n} ${w.name} `) : dim(` ${w.n} ${w.name} `))).join(" ");
    lines.push(`${bold(doc.name)}  ${dim(`r${doc.rev}`)}  ${wsBar}  ${dim(`${doc.wm.mode} · ${doc.theme.base}`)}`);
    lines.push("");
    if (view === "map") {
      for (const l of summarizeDoc(doc, snap).split("\n")) lines.push(l);
    } else {
      const wins = windowsHere();
      const listW = Math.min(44, Math.floor(cols * 0.42));
      const mini = miniature(Math.max(20, cols - listW - 4), Math.max(6, rows - 6));
      const list = wins.length ? wins.map((w, i) => {
        const line = `${w.min ? "·" : w.max ? "▣" : "▢"} ${appName(w.app).padEnd(12).slice(0, 12)} ${w.title.slice(0, listW - 18)}`;
        return i === cursor ? accent(`▸ ${line}`) : `  ${line}`;
      }) : [dim("  no windows on this workspace")];
      const widgets = doc.widgets.filter((g) => g.ws === doc.activeWorkspace);
      if (widgets.length) { list.push(""); list.push(dim(`  ${widgets.length} widget${widgets.length > 1 ? "s" : ""}: ${widgets.map((g) => g.kind).join(", ")}`)); }
      const h = Math.max(list.length, mini.length);
      for (let i = 0; i < h; i += 1) lines.push(`${(list[i] ?? "").padEnd(listW)}  ${mini[i] ?? ""}`);
    }
    lines.push("");
    lines.push(dim("j/k move · ↵ focus · x close · m minimise · z zoom · 1-9 workspace · o open · t tile/float · p preset · M map · r refresh · q quit") + (message ? `   ${accent(message)}` : ""));
    out(CLEAR + lines.slice(0, rows - 1).map((l) => l.slice(0, cols + 40)).join("\n"));
  }

  async function act(fn, label) {
    try { await fn(); message = label; }
    catch (e) { message = `error: ${e.message}`; }
    paint();
  }

  // Follow the live stream so an agent's change appears without a keypress.
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${cfg.url}/${cfg.slug}/os/events`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const data = f.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev.doc && ev.doc.rev >= doc.rev) { doc = ev.doc; cursor = Math.min(cursor, Math.max(0, windowsHere().length - 1)); paint(); }
        }
      }
    } catch { /* stream closed */ }
  })();

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  paint();
  process.stdout.on("resize", paint);

  await new Promise((resolve) => {
    process.stdin.on("data", async (key) => {
      const wins = windowsHere();
      const cur = wins[cursor];
      if (key === "q" || key === "\x03") { resolve(); return; }
      if (key === "j" || key === "\x1b[B") { cursor = Math.min(wins.length - 1, cursor + 1); paint(); return; }
      if (key === "k" || key === "\x1b[A") { cursor = Math.max(0, cursor - 1); paint(); return; }
      if (key === "\r" && cur) return act(() => desktop("focus", { id: cur.id }), `focused ${cur.title}`);
      if (key === "x" && cur) return act(() => desktop("close", { id: cur.id }), `closed ${cur.title}`);
      if (key === "m" && cur) return act(() => desktop("windowSet", { id: cur.id, min: !cur.min }), cur.min ? "restored" : "minimised");
      if (key === "z" && cur) return act(() => desktop("windowSet", { id: cur.id, max: !cur.max }), cur.max ? "unzoomed" : "zoomed");
      if (/^[1-9]$/.test(key)) return act(() => desktop("workspaceSwitch", { n: Number(key) }), `workspace ${key}`);
      if (key === "t") return act(() => desktop("layoutSet", { mode: doc.wm.mode === "tiling" ? "floating" : "tiling" }), "layout toggled");
      if (key === "p") { const presets = ["master-stack", "columns", "rows", "grid"]; const next = presets[(presets.indexOf(message.replace("preset ", "")) + 1) % presets.length]; return act(() => desktop("layoutSet", { mode: "tiling", preset: next }), `preset ${next}`); }
      if (key === "M") { view = view === "map" ? "windows" : "map"; paint(); return; }
      if (key === "r") return act(async () => { doc = (await desktop("state")).doc; }, "refreshed");
      if (key === "o") {
        process.stdin.setRawMode?.(false);
        out(`\n${accent("open which app?")} `);
        const name = await new Promise((r) => process.stdin.once("data", (d) => r(String(d).trim())));
        process.stdin.setRawMode?.(true);
        if (name) return act(() => desktop("open", { app: name }), `opened ${name}`);
        paint();
      }
    });
  });

  ac.abort();
  process.stdin.setRawMode?.(false);
  out(`${CLEAR}`);
  process.exit(0);
  void die;
}
