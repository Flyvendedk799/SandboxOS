// studio.js — the Studio: build the OS on the left, run it on the right.
//
// The stage is not a mockup of the desktop. It is the desktop — the same window
// manager, the same widgets, the same custom app frames, reading the same live
// document. Which means there is no "publish to preview" step and no drift: the
// thing you are dragging is the thing your machine will look like from a phone
// ten minutes from now.

import { $, h, fill, icon, api, slug, toast, toastError } from "../core.js";
import { mountSprite } from "./sprite.js";
import { os, loadOs, connect, onOs, call, select } from "./client.js";
import { createScreen } from "./shell.js";
import { createBuilder, createInspector } from "./builder.js";
import { createStudioPalette } from "./palette.js";
import { createAgentPanel, mountAssistantWindow } from "./agent.js";
import { startBroker } from "./frames.js";
import { firstRun, needsFirstRun } from "./first-run.js";

mountSprite();
os.design = true;

const root = $("#studio-root");

let view = localStorage.getItem("sbx.studio.view") ?? "split";   // split | builder | os
let stageMode = "design";                                        // design | preview
let agentOpen = localStorage.getItem("sbx.studio.agent") !== "0";

// ── panels ──────────────────────────────────────────────────────────────────

const builder = createBuilder({ onOpenCode: (kind, id, path) => builder.openCode(kind, id, path) });
const inspector = createInspector();
inspector.onOpenCode = (kind, id) => builder.openCode(kind, id);

/** Agent tool cards deep-link into the builder: what it wrote, where it put it. */
function linkForTool({ tool, args, result }) {
  if (tool === "appWrite" && args?.id) return { label: "open in Code", auto: true, run: () => builder.openCode("app", args.id, args.path) };
  if (tool === "widgetWrite" && args?.kind) return { label: "open in Code", auto: true, run: () => builder.openCode("widget", args.kind, args.path) };
  if (tool === "appDefine" && args?.id) return { label: "open in Code", auto: false, run: () => builder.openCode("app", args.id) };
  if ((tool === "open" || tool === "focus" || tool === "snap" || tool === "move" || tool === "resize") && result?.window?.id) {
    return { label: "select", auto: tool === "open", run: () => { select(result.window.id, "win"); builder.setTab("layers"); } };
  }
  if (tool === "widgetAdd" && result?.widget?.id) return { label: "select", auto: true, run: () => { select(result.widget.id, "widget"); builder.setTab("layers"); } };
  if (tool === "themeSet" || tool === "themeDefine" || tool === "wallpaperSet") return { label: "open Theme", auto: false, run: () => builder.setTab("theme") };
  if (tool === "animationDefine" || tool === "animationSet") return { label: "open Motion", auto: false, run: () => builder.setTab("motion") };
  if (tool === "revert" || tool === "history") return { label: "open Layers", auto: false, run: () => builder.setTab("layers") };
  return null;
}
const agent = createAgentPanel({ onClose: () => { agentOpen = false; persist(); layout(); }, onTool: linkForTool, review: true });

const screen = createScreen({
  ctx: {
    mountSpecial: (appId, host, win, ctx) => {
      if (appId === "assistant") return mountAssistantWindow(host, win, ctx);
      if (appId === "studio") {
        host.append(h("div.empty", null, icon("layers", 26), h("h3", "You are in the Studio"),
          h("p", "The builder is the panel on the left.")));
        return () => {};
      }
      return null;
    },
    openStudio: () => {},
    onSelect: (id, kind) => select(id, kind),
  },
});

// ── chrome ──────────────────────────────────────────────────────────────────

const statusEl = h("div.stx-status", h("span.dot"), h("span", "connecting"));
const stageBadge = h("span.stage-badge", "—");

const viewSeg = (id, label) => h("button.seg", {
  class: view === id ? "on" : "",
  onclick: () => { view = id; persist(); layout(); },
}, label);

const top = h("header.stx-top");
const rail = h("nav.stx-rail");
const stageBar = h("div.stx-stage-bar");
const viewport = h("div.stx-viewport");
const stage = h("main.stx-stage", null, stageBar, viewport);
const body = h("div.stx-body");

viewport.append(screen.el);
root.append(h("div.stx-shell", null, top, body));

function renderTop() {
  fill(top,
    h("div.stx-brand", null,
      h("div.stx-mark", "⇌"),
      h("div.stx-names", null,
        h("b", "SandboxOS Studio"),
        h("span", `${slug} · ${os.doc?.name ?? "…"}`))),
    h("span.stx-div"),
    viewSeg("split", "Split"), viewSeg("builder", "Builder"), viewSeg("os", "OS"),
    h("span.spacer"),
    statusEl,
    h("button.pill", { class: agentOpen ? "on" : "", onclick: () => { agentOpen = !agentOpen; persist(); layout(); } },
      h("span", { style: { color: "var(--stx-agent)", display: "flex" } }, icon("assistant", 14)), "Agent"),
    h("button.pill", { onclick: () => window.open(`/${slug}/os`, "_blank") }, "Open OS"),
    h("button.pill.primary", { onclick: publish }, "Publish distro"),
  );
}

function renderRail() {
  const btn = (tab, ic, title) => h("button.rail-btn", {
    class: builder.tab === tab && view !== "os" ? "on" : "",
    title,
    onclick: () => { if (view === "os") { view = "split"; persist(); } builder.setTab(tab); layout(); },
  }, icon(ic, 18));
  fill(rail,
    btn("library", "library", "Build"),
    btn("layers", "layers", "Layers"),
    btn("theme", "theme", "Theme"),
    btn("motion", "play", "Motion"),
    btn("code", "code", "Code"),
    h("span.spacer"),
    h("button.rail-btn", { title: "Studio actions (⌘⇧P)", onclick: () => palette.open() }, icon("apps", 17)),
    h("button.rail-btn", { title: "Search (⌘K)", onclick: () => screen.spotlight() }, icon("search", 17)),
  );
}

// ── the builder's width is chrome, not desktop truth: it lives in localStorage ──
const sash = h("div.stx-sash", { title: "Drag to resize the builder" });
let builderW = Number(localStorage.getItem("sbx.studio.builderW")) || 0;
if (builderW) builder.el.style.width = `${builderW}px`;
sash.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const start = e.clientX, w0 = builder.el.getBoundingClientRect().width;
  document.body.classList.add("sashing");
  const onMove = (ev) => { builderW = Math.max(260, Math.min(900, w0 + ev.clientX - start)); builder.el.style.width = `${builderW}px`; };
  const onUp = () => { window.removeEventListener("pointermove", onMove); document.body.classList.remove("sashing"); localStorage.setItem("sbx.studio.builderW", String(builderW)); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
});

const palette = createStudioPalette({
  actions: () => [
    ...builder.paletteActions(),
    { name: "Design mode", sub: "Stage", icon: "layers", run: () => { stageMode = "design"; os.design = true; paint(); } },
    { name: "Preview mode", sub: "Stage", icon: "eye", run: () => { stageMode = "preview"; os.design = false; select(null, null); paint(); } },
    ...DEVICES.map((dev) => ({
      name: dev.w ? `Render at ${dev.name} (${dev.w}×${dev.h})` : "Render at pane size",
      sub: "Stage", icon: "window",
      run: () => { device = dev.id; persist(); applyDevice(); paint(); },
    })),
    { name: "Split view", sub: "Studio", icon: "window", run: () => { view = "split"; persist(); layout(); } },
    { name: "Builder only", sub: "Studio", icon: "window", run: () => { view = "builder"; persist(); layout(); } },
    { name: "OS only", sub: "Studio", icon: "window", run: () => { view = "os"; persist(); layout(); } },
    { name: agentOpen ? "Hide the agent" : "Show the agent", sub: "Studio", icon: "assistant", run: () => { agentOpen = !agentOpen; persist(); layout(); } },
    { name: "Open the OS full screen", sub: "Studio", icon: "window", run: () => window.open(`/${slug}/os`, "_blank") },
    { name: "Revert to a revision…", sub: "History", icon: "refresh", run: () => builder.setTab("layers") },
  ],
});

function renderStageBar() {
  const d = os.doc;
  if (!d) return;
  const seg = (label, on, run, ic) => h("button.seg", { class: on ? "on" : "", onclick: run },
    ic ? icon(ic, 13) : null, label);

  fill(stageBar,
    h("div.seg-group", null,
      seg("Design", stageMode === "design", () => { stageMode = "design"; os.design = true; select(null, null); paint(); }),
      seg("Preview", stageMode === "preview", () => { stageMode = "preview"; os.design = false; select(null, null); paint(); })),
    h("div.seg-group", null,
      seg("Float", d.wm.mode === "floating", () => call("layoutSet", { mode: "floating" }), "window"),
      seg("Tile", d.wm.mode === "tiling", () => call("layoutSet", { mode: "tiling" }), "grid")),
    h("span.stx-div"),
    ...d.workspaces.map((w) => h("button.ws-btn", {
      class: w.n === d.activeWorkspace ? "on" : "",
      title: w.name,
      onclick: () => call("workspaceSwitch", { n: w.n }),
    }, String(w.n))),
    h("button.ws-add", { title: "New workspace", onclick: () => call("workspaceAdd", {}) }, icon("plus", 12)),
    h("span.stx-div"),
    h("div.seg-group", null, ...DEVICES.map((dev) => seg(dev.name, device === dev.id, () => {
      device = dev.id;
      persist();
      applyDevice();
      paint();
    }))),
    h("span.spacer"),
    h("button.seg", { title: "Arrange in a grid", onclick: () => call("arrange", { preset: "grid", viewport: screen.viewport() }) }, "Arrange"),
    stageBadge,
  );
  const dev = deviceOf();
  const size = dev.w ? `${dev.w}×${dev.h}${stageScale < 0.995 ? ` · ${Math.round(stageScale * 100)}%` : ""}` : "fit";
  stageBadge.textContent = `${stageMode} · ${size} · ${d.wm.mode} · ws ${d.activeWorkspace} · r${d.rev}`;
}

/** Rebuild the row of panels for the current view. */
// ── the stage renders a machine, not a pane ─────────────────────────────────
//
// The fold to a phone belongs to the viewport a document is arranged for, and the
// Studio's stage is a few hundred pixels wide on a laptop. Rendering the desktop
// at pane size meant the builder showed a phone — one window, a widget shelf, no
// sashes — which is the wrong answer to "design my desktop" (goal.md T2.1). So
// the stage picks a device, renders the screen at that size, and scales the whole
// thing down to fit. The document does not change; the pixels do.

const DEVICES = [
  { id: "desktop", name: "Desktop", w: 1440, h: 900 },
  { id: "tablet", name: "Tablet", w: 1024, h: 768 },
  { id: "phone", name: "Phone", w: 390, h: 780 },
  { id: "fit", name: "Fit", w: null, h: null }, // the pane itself, whatever it is
];
let device = localStorage.getItem("sbx.studio.device") ?? "desktop";
const deviceOf = () => DEVICES.find((d) => d.id === device) ?? DEVICES[0];
let stageScale = 1;

function applyDevice() {
  const dev = deviceOf();
  const el = screen.el;
  if (!dev.w) {
    el.classList.remove("staged");
    el.style.width = el.style.height = el.style.transform = "";
    stageScale = 1;
  } else {
    const pane = viewport.getBoundingClientRect();
    const pad = 28; // the viewport's own padding, both sides
    stageScale = Math.min(1, Math.min((pane.width - pad) / dev.w, (pane.height - pad) / dev.h));
    el.classList.add("staged");
    el.style.width = `${dev.w}px`;
    el.style.height = `${dev.h}px`;
    el.style.transform = `translate(-50%, -50%) scale(${stageScale})`;
  }
  if (stageBadge.isConnected) renderStageBar();
}

// The pane changes size when the builder's sash moves and when the window does.
new ResizeObserver(() => applyDevice()).observe(viewport);

function layout() {
  fill(body,
    rail,
    view !== "os" ? builder.el : null,
    view === "split" ? sash : null,
    view !== "builder" ? stage : null,
    view !== "os" ? inspector.el : null,
    agentOpen ? agent.el : null,
  );
  applyDevice();
  paint();
}

function paint() {
  if (!os.doc) return;
  renderTop();
  renderRail();
  renderStageBar();
  builder.render();
  inspector.render();
  screen.render();
}

function persist() {
  localStorage.setItem("sbx.studio.view", view);
  localStorage.setItem("sbx.studio.agent", agentOpen ? "1" : "0");
  localStorage.setItem("sbx.studio.device", device);
}

async function publish() {
  const name = os.doc?.name ?? "my-os";
  try {
    const r = await call("distroPublish", { name, description: `${name} · published from the Studio`, replace: true });
    await loadOs();
    toast(`Published ${r.name}`, { body: `${r.apps} custom apps packaged. Fork it from any machine in your tenant.`, kind: "ok" });
  } catch (e) { toastError("Could not publish this OS", e); }
}

// ── boot ────────────────────────────────────────────────────────────────────

startBroker({ notify: ({ title, body: b, kind, app }) => call("notify", { title, body: b, kind, app }).catch(() => {}) });

onOs((kind) => {
  if (kind === "conn") {
    statusEl.className = `stx-status ${os.connected ? "on" : "warn"}`;
    statusEl.lastChild.textContent = os.connected ? "Cell running" : "reconnecting";
    return;
  }
  paint();
});

(async () => {
  try {
    await loadOs();
    connect();

    // The same one screen the desktop shows, before the Studio paints: a machine
    // that has never been set up is a machine with nothing to build on.
    if (needsFirstRun(os.doc)) {
      const host = h("div", { id: "studio-first-run" });
      root.append(host);
      try {
        const { seeds } = await api.mcp("desktop", "setupSeeds", {});
        await firstRun(host, { seeds, viewport: { w: window.innerWidth, h: window.innerHeight - 64 }, onDone: () => loadOs() });
      } catch (e) {
        toastError("The welcome screen could not load", e);
      }
      host.remove();
    }

    layout();
    document.title = `${os.doc.name} · SandboxOS Studio`;
  } catch (e) {
    toastError("Could not load this machine's OS", e);
  }
})();

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); palette.open(); return; }
  if (e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); location.href = `/${slug}/os`; }
  if (e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); location.href = `/${slug}`; }
});

// Unsaved files in Code are the one thing the Studio holds that the document
// does not; leaving the page should ask.
window.addEventListener("beforeunload", (e) => { if (builder.dirty) { e.preventDefault(); e.returnValue = ""; } });

// A deep link (#code=app:port-monitor/index.html) from Spotlight or a tool card.
(function deepLink() {
  const m = /^#code=(app|widget):([a-z0-9_-]+)(?:\/(.+))?$/.exec(location.hash);
  if (!m) return;
  const off = onOs(() => { if (!os.doc) return; off(); builder.openCode(m[1], m[2], m[3] ?? null); });
})();
