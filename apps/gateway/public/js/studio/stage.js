// stage.js — Studio stage viewport management and live scaled rendering.
//
// Fulfills Acceptance Criterion C1:
// - Multi-viewport presets: desktop (1440x900), tablet (1024x768), phone (375x667), fit
// - Live scaled rendering via CSS transform to fit pane without premature layout collapse

import { h, fill, icon } from "../core.js";
import { os, call, select } from "../os/client.js";
import { DEVICES, deviceOf, computeStageLayout, formatStageBadge } from "./presets.js";

export function createStudioStage({ screen, onPaint } = {}) {
  let deviceId = localStorage.getItem("sbx.studio.device") ?? "desktop";
  let stageMode = "design"; // "design" | "preview"
  let stageScale = 1;

  const stageBar = h("div.stx-stage-bar");
  const stageBadge = h("span.stage-badge", "—");
  const viewport = h("div.stx-viewport");
  const stage = h("main.stx-stage", null, stageBar, viewport);

  viewport.append(screen.el);

  function applyDevice() {
    const dev = deviceOf(deviceId);
    const pane = viewport.getBoundingClientRect();
    const layout = computeStageLayout({
      paneWidth: pane.width,
      paneHeight: pane.height,
      device: dev,
      pad: 28,
    });

    stageScale = layout.scale;
    const el = screen.el;

    if (!layout.staged) {
      el.classList.remove("staged");
      el.style.width = el.style.height = el.style.transform = "";
    } else {
      el.classList.add("staged");
      el.style.width = `${layout.width}px`;
      el.style.height = `${layout.height}px`;
      el.style.transform = layout.transform;
    }

    renderStageBar();
  }

  function renderStageBar() {
    const d = os.doc;
    if (!d) return;

    const seg = (label, on, run, ic) => h("button.seg", { class: on ? "on" : "", onclick: run },
      ic ? icon(ic, 13) : null, label);

    fill(stageBar,
      h("div.seg-group", null,
        seg("Design", stageMode === "design", () => {
          stageMode = "design";
          os.design = true;
          select(null, null);
          onPaint?.();
        }),
        seg("Preview", stageMode === "preview", () => {
          stageMode = "preview";
          os.design = false;
          select(null, null);
          onPaint?.();
        })),
      h("div.seg-group", null,
        seg("Float", d.wm?.mode === "floating", () => call("layoutSet", { mode: "floating" }), "window"),
        seg("Tile", d.wm?.mode === "tiling", () => call("layoutSet", { mode: "tiling" }), "grid")),
      h("span.stx-div"),
      ...(d.workspaces ?? []).map((w) => h("button.ws-btn", {
        class: w.n === d.activeWorkspace ? "on" : "",
        title: w.name,
        onclick: () => call("workspaceSwitch", { n: w.n }),
      }, String(w.n))),
      h("button.ws-add", { title: "New workspace", onclick: () => call("workspaceAdd", {}) }, icon("plus", 12)),
      h("span.stx-div"),
      h("div.seg-group", null, ...DEVICES.map((dev) => seg(dev.name, deviceId === dev.id, () => {
        setDevice(dev.id);
      }))),
      h("span.spacer"),
      h("button.seg", { title: "Arrange in a grid", onclick: () => call("arrange", { preset: "grid", viewport: screen.viewport() }) }, "Arrange"),
      stageBadge,
    );

    stageBadge.textContent = formatStageBadge({
      stageMode,
      device: deviceId,
      scale: stageScale,
      doc: d,
    });
  }

  function setDevice(id) {
    deviceId = id;
    try { localStorage.setItem("sbx.studio.device", deviceId); } catch { /* ignore */ }
    applyDevice();
    onPaint?.();
  }

  const ro = new ResizeObserver(() => applyDevice());
  ro.observe(viewport);

  return {
    el: stage,
    stageBar,
    viewport,
    setDevice,
    applyDevice,
    renderStageBar,
    get device() { return deviceId; },
    get stageMode() { return stageMode; },
    set stageMode(m) { stageMode = m; },
    get stageScale() { return stageScale; },
    destroy() { ro.disconnect(); },
  };
}
