// studio.js — the Studio: build the OS on the left, run it on the right.
//
// The stage is not a mockup of the desktop. It is the desktop — the same window
// manager, the same widgets, the same custom app frames, reading the same live
// document. Which means there is no "publish to preview" step and no drift: the
// thing you are dragging is the thing your machine will look like from a phone
// ten minutes from now.

import { $, h, fill, icon, slug, toast, toastError } from "../core.js";
import { mountSprite } from "./sprite.js";
import { os, loadOs, connect, onOs, call, select } from "./client.js";
import { createScreen } from "./shell.js";
import { createBuilder, createInspector } from "./builder.js";
import { createAgentPanel, mountAssistantWindow } from "./agent.js";
import { startBroker } from "./frames.js";

mountSprite();
os.design = true;

const root = $("#studio-root");

let view = localStorage.getItem("sbx.studio.view") ?? "split";   // split | builder | os
let stageMode = "design";                                        // design | preview
let agentOpen = localStorage.getItem("sbx.studio.agent") !== "0";

// ── panels ──────────────────────────────────────────────────────────────────

const builder = createBuilder({ onOpenCode: (kind, id) => builder.openCode(kind, id) });
const inspector = createInspector();
const agent = createAgentPanel({ onClose: () => { agentOpen = false; persist(); layout(); } });

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
    btn("code", "code", "Code"),
    h("span.spacer"),
    h("button.rail-btn", { title: "Search (⌘K)", onclick: () => screen.spotlight() }, icon("search", 17)),
  );
}

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
    h("span.spacer"),
    h("button.seg", { title: "Arrange in a grid", onclick: () => call("arrange", { preset: "grid", viewport: screen.viewport() }) }, "Arrange"),
    stageBadge,
  );
  stageBadge.textContent = `${stageMode} · ${d.wm.mode} · ws ${d.activeWorkspace} · r${d.rev}`;
}

/** Rebuild the row of panels for the current view. */
function layout() {
  fill(body,
    rail,
    view !== "os" ? builder.el : null,
    view !== "builder" ? stage : null,
    view !== "os" ? inspector.el : null,
    agentOpen ? agent.el : null,
  );
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
    layout();
    document.title = `${os.doc.name} · SandboxOS Studio`;
  } catch (e) {
    toastError("Could not load this machine's OS", e);
  }
})();

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); location.href = `/${slug}/os`; }
  if (e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); location.href = `/${slug}`; }
});
