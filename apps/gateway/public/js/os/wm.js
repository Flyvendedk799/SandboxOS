// wm.js — the window manager.
//
// It reconciles the desktop against the OS document by id rather than redrawing
// it: a window that is still there keeps its element, which means its terminal
// keeps its scrollback and its custom-app iframe is never reloaded. Only geometry,
// chrome and z-order are re-applied. That is the difference between a live desktop
// and a screenshot that refreshes.
//
// Gestures are optimistic and commit once. Dragging paints locally at pointer
// speed and writes a single `desktop.move` on release — sixty writes per drag
// would be sixty audit rows describing one intention.

import { h, fill, icon, toastError } from "../core.js";
import { os, call, localPatch, select, appMeta, widgetMeta, onOs } from "./client.js";
import { mountApp } from "./builtins.js";
import { mountWidget } from "./widgets.js";
import { createFrame, destroyFrame, appSession, reloadFramesFor } from "./frames.js";
import { iconName } from "./sprite.js";

/** How close to an edge a drag has to get before it offers to snap. */
const SNAP_EDGE = 26;

/** Below this, floating windows stop being a good idea and the OS goes phone-shaped. */
const COMPACT_WIDTH = 720;

export function createDesktop({ root, ctx = {} }) {
  const wins = new Map();    // window id → {el, body, stop, frame, app}
  const widgets = new Map(); // widget id → {el, stop, frame, kind}
  let gesture = null;

  const design = () => !!os.design;
  const doc = () => os.doc;
  const viewport = () => {
    const r = root.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };

  const snapGhost = h("div.os-snap-ghost", { hidden: true });
  root.append(snapGhost);

  // ── geometry ──────────────────────────────────────────────────────────────

  function tileBoxes(list) {
    const gap = doc().wm.gap ?? 12;
    const rect = root.getBoundingClientRect();
    const cols = Math.ceil(Math.sqrt(list.length)) || 1;
    const rows = Math.ceil(list.length / cols) || 1;
    const cw = (rect.width - gap * (cols + 1)) / cols;
    const ch = (rect.height - gap * (rows + 1)) / rows;
    const out = new Map();
    list.forEach((w, i) => {
      out.set(w.id, {
        left: gap + (i % cols) * (cw + gap),
        top: gap + Math.floor(i / cols) * (ch + gap),
        width: Math.max(160, cw),
        height: Math.max(100, ch),
      });
    });
    return out;
  }

  const isCompact = () => root.getBoundingClientRect().width < COMPACT_WIDTH;

  function placeWindow(el, w, tiles, front) {
    const rect = root.getBoundingClientRect();
    // On a phone, "floating windows" is the wrong answer to a real question. The
    // document does not change — the same desktop, the same revision — but only
    // the front window is shown, full-bleed, and the dock becomes the switcher.
    if (isCompact()) {
      Object.assign(el.style, { left: "0px", top: "0px", width: `${rect.width}px`, height: `${rect.height}px` });
      el.style.zIndex = String(w.z);
      el.hidden = w.min || w.ws !== doc().activeWorkspace || w.id !== front;
      return;
    }
    if (w.max) {
      Object.assign(el.style, { left: "8px", top: "8px", width: `${rect.width - 16}px`, height: `${rect.height - 16}px` });
    } else if (tiles?.has(w.id)) {
      const b = tiles.get(w.id);
      Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    } else {
      Object.assign(el.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` });
    }
    el.style.zIndex = String(w.z);
    el.hidden = w.min || w.ws !== doc().activeWorkspace;
  }

  /** Which snap region a pointer at (x,y) inside the desktop is asking for. */
  function regionAt(x, y) {
    const r = root.getBoundingClientRect();
    const nearL = x - r.left < SNAP_EDGE;
    const nearR = r.right - x < SNAP_EDGE;
    const nearT = y - r.top < SNAP_EDGE;
    const nearB = r.bottom - y < SNAP_EDGE;
    if (nearT && nearL) return "topleft";
    if (nearT && nearR) return "topright";
    if (nearB && nearL) return "bottomleft";
    if (nearB && nearR) return "bottomright";
    if (nearT) return "full";
    if (nearL) return "left";
    if (nearR) return "right";
    if (nearB) return "bottom";
    return null;
  }

  /** The same arithmetic the `desktop.snap` tool does, for the preview. */
  function regionBox(region) {
    const { w: vw, h: vh } = viewport();
    const g = doc().wm.gap;
    const halfW = Math.floor((vw - g * 3) / 2);
    const halfH = Math.floor((vh - g * 3) / 2);
    return {
      left: { x: g, y: g, w: halfW, h: vh - g * 2 },
      right: { x: g * 2 + halfW, y: g, w: halfW, h: vh - g * 2 },
      bottom: { x: g, y: g * 2 + halfH, w: vw - g * 2, h: halfH },
      topleft: { x: g, y: g, w: halfW, h: halfH },
      topright: { x: g * 2 + halfW, y: g, w: halfW, h: halfH },
      bottomleft: { x: g, y: g * 2 + halfH, w: halfW, h: halfH },
      bottomright: { x: g * 2 + halfW, y: g * 2 + halfH, w: halfW, h: halfH },
      full: { x: g, y: g, w: vw - g * 2, h: vh - g * 2 },
    }[region] ?? null;
  }

  function showGhost(region) {
    const box = region ? regionBox(region) : null;
    if (!box) { snapGhost.hidden = true; return; }
    snapGhost.hidden = false;
    Object.assign(snapGhost.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  }

  // ── window construction ───────────────────────────────────────────────────

  function appContent(win, meta) {
    const body = h("div.os-window-body");
    const stopFns = [];
    const appCtx = {
      ...ctx,
      setTitle: (title) => call("windowSet", { id: win.id, title }).catch(() => {}),
      notify: (title, bodyText) => call("notify", { title, body: bodyText ?? "", app: win.app, kind: "ok" }).catch(() => {}),
      onDoc: (fn) => onOs((kind) => { if (kind === "doc") fn(); }),
    };

    if (meta?.kind === "builtin") {
      const stop = mountApp(win.app, body, win, appCtx);
      if (stop) { stopFns.push(stop); return { body, stop: () => stopFns.forEach((f) => f()) }; }
      // A built-in we ship a descriptor for but no renderer (assistant, studio) is
      // supplied by the host page, which knows about chat streams and builder panes.
      const supplied = ctx.mountSpecial?.(win.app, body, win, appCtx);
      if (supplied) stopFns.push(supplied);
      else fill(body, h("div.dim", { style: { padding: "14px", fontSize: "11.5px" } }, `${win.app} has no renderer here.`));
      return { body, stop: () => stopFns.forEach((f) => f()) };
    }

    if (meta?.kind === "url") {
      fill(body, h("iframe", {
        src: meta.source.url,
        sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
        referrerpolicy: "no-referrer",
      }));
      return { body, stop: () => {} };
    }

    // A bundle: untrusted code, opaque origin, brokered calls.
    const frame = createFrame({
      id: win.app,
      kind: "app",
      onTitle: (title) => call("windowSet", { id: win.id, title }).catch(() => {}),
      onResize: (w, hh) => call("resize", { id: win.id, ...(w ? { w } : {}), ...(hh ? { h: hh } : {}) }).catch(() => {}),
      onClose: () => call("close", { id: win.id }).catch(() => {}),
    });
    fill(body, frame);
    appSession(win.app).then((s) => {
      if (s.withheld?.length) body.prepend(h("div.perm-warn", `Not granted: ${s.withheld.join(", ")}`));
    });
    return { body, frame, stop: () => destroyFrame(frame) };
  }

  function buildWindow(win) {
    const meta = appMeta(win.app);
    const { body, frame, stop } = appContent(win, meta);

    const title = h("span.os-title", win.title);
    const bar = h("div.os-titlebar", null,
      h("div.os-lights", null,
        h("button.close", { title: "Close", onclick: (e) => { e.stopPropagation(); closeWindow(win.id); } }),
        h("button.min", { title: "Minimise", onclick: (e) => { e.stopPropagation(); call("windowSet", { id: win.id, min: true }); } }),
        h("button.max", { title: "Zoom", onclick: (e) => { e.stopPropagation(); call("windowSet", { id: win.id, max: !win.max }); } }),
      ),
      h("span", { style: { color: meta?.hue ?? "var(--os-accent)", display: "flex", marginLeft: "4px" } }, icon(iconName(meta?.icon ?? "apps"), 14)),
      title,
    );

    const grip = h("div.os-resize");
    const el = h("div.os-window", null, bar, body, grip);
    el.dataset.id = win.id;

    bar.addEventListener("pointerdown", (e) => startDrag(e, win.id, "win"));
    bar.addEventListener("dblclick", () => call("windowSet", { id: win.id, max: !doc().windows.find((w) => w.id === win.id)?.max }));
    grip.addEventListener("pointerdown", (e) => startResize(e, win.id, "win"));
    el.addEventListener("pointerdown", () => raise(win.id), true);

    root.append(el);
    return { el, body, title, bar, frame, stop, app: win.app };
  }

  function closeWindow(id) {
    const entry = wins.get(id);
    if (entry) {
      entry.el.classList.add("closing");
      setTimeout(() => call("close", { id }).catch((e) => toastError("Could not close the window", e)), 90);
    }
  }

  let raiseTimer = null;
  function raise(id) {
    const w = doc().windows.find((x) => x.id === id);
    if (!w) return;
    if (design()) select(id, "win");
    if (w.z >= doc().zTop) return;
    // Coalesce: clicking around inside a window should not write a revision per click.
    clearTimeout(raiseTimer);
    raiseTimer = setTimeout(() => call("focus", { id }).catch(() => {}), 60);
  }

  // ── widget construction ───────────────────────────────────────────────────

  function buildWidget(g) {
    const meta = widgetMeta(g.kind);
    const el = h("div.os-widget");
    el.dataset.id = g.id;
    let stop = () => {};
    let frame = null;

    if (meta && !meta.builtin) {
      // A frame swallows pointer events, so a widget made of one needs somewhere
      // to be picked up by. The strip doubles as its label, which a chrome-less
      // widget otherwise has nowhere to put.
      const handle = h("div.os-widget-handle", h("span", meta.name));
      handle.addEventListener("pointerdown", (e) => {
        if (design()) select(g.id, "widget");
        startDrag(e, g.id, "widget");
      });
      frame = createFrame({ id: g.kind, kind: "widget" });
      el.append(handle, frame);
      el.classList.add("framed");
      stop = () => destroyFrame(frame);
    } else {
      const inner = mountWidget(g.kind, el, g, ctx);
      if (inner) stop = inner;
      else fill(el, h("div.w-label", g.kind), h("div.dim", { style: { fontSize: "11px", marginTop: "8px" } }, "unknown widget"));
    }

    const grip = h("div.os-resize");
    grip.addEventListener("pointerdown", (e) => startResize(e, g.id, "widget"));
    el.append(grip);

    el.addEventListener("pointerdown", (e) => {
      if (design()) select(g.id, "widget");
      startDrag(e, g.id, "widget");
    });
    root.append(el);
    return { el, stop, frame, kind: g.kind };
  }

  function placeWidget(el, g) {
    const rect = root.getBoundingClientRect();
    el.style.width = `${g.w}px`;
    el.style.height = `${g.h}px`;
    el.style.top = `${g.y}px`;
    if (g.pin === "right") { el.style.right = "20px"; el.style.left = "auto"; }
    else { el.style.left = `${g.x}px`; el.style.right = "auto"; }
    el.hidden = g.ws !== doc().activeWorkspace;
    if (g.x > rect.width) el.style.left = `${Math.max(0, rect.width - g.w - 20)}px`;
  }

  // ── gestures ──────────────────────────────────────────────────────────────

  function startDrag(e, id, kind) {
    if (e.button !== 0) return;
    if (kind === "win" && doc().wm.mode === "tiling") return;
    const item = kind === "win"
      ? doc().windows.find((w) => w.id === id)
      : doc().widgets.find((g) => g.id === id);
    if (!item || (kind === "win" && item.max)) return;
    if (e.target.closest("input, textarea, select, button, a, iframe, .os-resize")) return;

    gesture = { type: "move", id, kind, sx: e.clientX, sy: e.clientY, ox: item.x, oy: item.y, region: null };
    (kind === "win" ? wins : widgets).get(id)?.el.classList.add("dragging");
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startResize(e, id, kind) {
    if (e.button !== 0) return;
    const item = kind === "win"
      ? doc().windows.find((x) => x.id === id)
      : doc().widgets.find((x) => x.id === id);
    if (!item) return;
    gesture = { type: "resize", id, kind, sx: e.clientX, sy: e.clientY, ow: item.w, oh: item.h };
    (kind === "win" ? wins : widgets).get(id)?.el.classList.add("dragging");
    e.stopPropagation();
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function snap(v) {
    const grid = doc().wm.snap ? (doc().wm.gridSize ?? 8) : 1;
    return Math.round(v / grid) * grid;
  }

  function onMove(e) {
    if (!gesture) return;
    const dx = e.clientX - gesture.sx;
    const dy = e.clientY - gesture.sy;

    if (gesture.type === "move" && gesture.kind === "win") {
      gesture.region = regionAt(e.clientX, e.clientY);
      showGhost(gesture.region);
    }

    localPatch((d) => {
      const list = gesture.kind === "win" ? d.windows : d.widgets;
      const item = list.find((x) => x.id === gesture.id);
      if (!item) return;
      if (gesture.type === "move") {
        item.x = Math.max(0, snap(gesture.ox + dx));
        item.y = Math.max(0, snap(gesture.oy + dy));
        if (gesture.kind === "widget") item.pin = "none";
      } else {
        const min = gesture.kind === "win" ? { w: 200, h: 120 } : { w: 120, h: 80 };
        item.w = Math.max(min.w, snap(gesture.ow + dx));
        item.h = Math.max(min.h, snap(gesture.oh + dy));
      }
    });
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    snapGhost.hidden = true;
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    (g.kind === "win" ? wins : widgets).get(g.id)?.el.classList.remove("dragging");

    // Dropped on an edge: one `desktop.snap`, and the region is what gets audited
    // rather than a pair of coordinates nobody can read back.
    if (g.type === "move" && g.kind === "win" && g.region) {
      call("snap", { id: g.id, region: g.region, viewport: viewport() })
        .catch((e) => toastError("Could not snap the window", e));
      return;
    }

    const list = g.kind === "win" ? doc().windows : doc().widgets;
    const item = list.find((x) => x.id === g.id);
    if (!item) return;
    const moved = g.type === "move"
      ? item.x !== g.ox || item.y !== g.oy
      : item.w !== g.ow || item.h !== g.oh;
    if (!moved) return;

    const tool = g.kind === "widget" ? "widgetSet" : g.type === "move" ? "move" : "resize";
    const args = g.type === "move"
      ? { id: g.id, x: item.x, y: item.y, ...(g.kind === "widget" ? { pin: "none" } : {}) }
      : { id: g.id, w: item.w, h: item.h };
    call(tool, args).catch((e) => toastError("Could not save the layout", e));
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    const d = doc();
    if (!d) return;
    root.classList.toggle("design", design());

    // Windows.
    const live = new Set(d.windows.map((w) => w.id));
    for (const [id, entry] of wins) {
      if (!live.has(id)) { entry.stop?.(); entry.el.remove(); wins.delete(id); }
    }
    const openHere = d.windows.filter((w) => w.ws === d.activeWorkspace && !w.min);
    const compact = isCompact();
    root.classList.toggle("compact", compact);
    const tiles = !compact && d.wm.mode === "tiling" ? tileBoxes(openHere.filter((w) => !w.max)) : null;
    const front = [...openHere].sort((a, b) => b.z - a.z)[0]?.id ?? null;

    for (const w of d.windows) {
      let entry = wins.get(w.id);
      if (!entry) { entry = buildWindow(w); wins.set(w.id, entry); }
      else if (entry.app !== w.app) {
        // The same id cannot change app, but a fork can reuse ids: rebuild.
        entry.stop?.(); entry.el.remove();
        entry = buildWindow(w); wins.set(w.id, entry);
      }
      if (entry.title.textContent !== w.title) entry.title.textContent = w.title;
      entry.el.classList.toggle("selected", design() && os.sel.id === w.id);
      entry.el.classList.toggle("draggable", !compact && d.wm.mode === "floating" && !w.max);
      entry.el.querySelector(".os-resize").hidden = compact || d.wm.mode === "tiling" || w.max;
      placeWindow(entry.el, w, tiles, front);
    }

    // Widgets.
    const liveW = new Set(d.widgets.map((g) => g.id));
    for (const [id, entry] of widgets) {
      if (!liveW.has(id)) { entry.stop?.(); entry.el.remove(); widgets.delete(id); }
    }
    for (const g of d.widgets) {
      let entry = widgets.get(g.id);
      if (!entry || entry.kind !== g.kind) {
        entry?.stop?.(); entry?.el.remove();
        entry = buildWidget(g);
        widgets.set(g.id, entry);
      }
      entry.el.classList.toggle("selected", design() && os.sel.id === g.id);
      entry.el.classList.add("draggable");
      placeWidget(entry.el, g);
    }
  }

  /** The window in front on this workspace — what a keyboard shortcut acts on. */
  function focused() {
    const d = doc();
    if (!d) return null;
    return d.windows
      .filter((w) => w.ws === d.activeWorkspace && !w.min)
      .sort((a, b) => b.z - a.z)[0] ?? null;
  }

  // Clicking inside a custom app's frame never reaches us — the frame is a
  // separate document — so a window made of one would never come to the front.
  // Focus moving to an iframe is the signal we do get, and it means exactly that.
  const onBlur = () => setTimeout(() => {
    const active = document.activeElement;
    if (active?.tagName !== "IFRAME") return;
    const id = active.closest(".os-window")?.dataset.id;
    if (id) raise(id);
  }, 0);
  window.addEventListener("blur", onBlur);

  // Tiling geometry and the compact/floating decision both depend on our size.
  const ro = new ResizeObserver(() => render());
  ro.observe(root);

  // An app whose source just changed should show the change. This is what closes
  // the loop when the agent (or you, in the Studio's Code tab) writes a file.
  const offBundle = onOs((kind) => {
    if (typeof kind === "string" && kind.startsWith("bundle:")) reloadFramesFor(kind.slice(7));
  });

  return {
    render,
    focused,
    viewport,
    destroy() {
      ro.disconnect();
      offBundle();
      window.removeEventListener("blur", onBlur);
      for (const e of wins.values()) { e.stop?.(); e.el.remove(); }
      for (const e of widgets.values()) { e.stop?.(); e.el.remove(); }
      wins.clear();
      widgets.clear();
    },
  };
}
