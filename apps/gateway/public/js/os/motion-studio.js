// motion-studio.js — a motion designer that can only produce numbers.
//
// A preset is opacity/scale/x/y/rotate/blur at either end of a transition, a
// duration and an easing from a closed set. Those are the controls here, and
// nothing else: there is no "custom CSS" box because the document is agent-
// writable and the compiler is the security boundary. The preview compiles the
// candidate with the same `animationCss` the Gateway uses, renamed so it plays
// on the sample window alone until you save it as a preset.

import { h, fill, icon, dialog, confirmDialog, toast, toastError } from "../core.js";
import { os, call, loadOs } from "./client.js";
import { BUILTIN_ANIMATIONS, cleanAnimation, animationCss } from "./lib/animations.js";

const EASINGS = ["spring", "smooth", "snap", "linear", "ease", "ease-out", "ease-in"];
const FIELDS = [
  { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, dflt: 1 },
  { key: "scale", label: "Scale", min: 0.1, max: 3, step: 0.02, dflt: 1 },
  { key: "x", label: "X offset", min: -400, max: 400, step: 2, dflt: 0 },
  { key: "y", label: "Y offset", min: -400, max: 400, step: 2, dflt: 0 },
  { key: "rotate", label: "Rotate", min: -180, max: 180, step: 1, dflt: 0 },
  { key: "blur", label: "Blur", min: 0, max: 40, step: 1, dflt: 0 },
];

let styleEl = null;
function previewCss(preset) {
  const css = animationCss(preset)
    .replaceAll("os-open", "os-preview-open").replaceAll("os-close", "os-preview-close")
    .replace(":root", ".motion-sample");
  if (!styleEl) { styleEl = h("style", { id: "os-motion-preview" }); document.head.append(styleEl); }
  styleEl.textContent = css;
}

export function createMotionStudio() {
  const el = h("div");
  let draft = null;     // the preset being edited (cleaned numbers)
  let editingKey = null;

  const sample = h("div.motion-sample", null,
    h("div.os-window.sample", null,
      h("div.os-titlebar", null, h("div.os-lights", null, h("span.close"), h("span.min"), h("span.max")), h("span.os-title", "Sample window")),
      h("div.os-window-body", h("div.dim", { style: { padding: "12px", fontSize: "11px" } }, "Open · Close"))));

  function play(kind) {
    const win = sample.querySelector(".os-window");
    win.style.animation = "none";
    void win.offsetWidth; // restart the animation
    win.style.animation = `os-preview-${kind} var(--os-anim-duration) var(--os-anim-easing) ${kind === "close" ? "forwards" : ""}`;
    if (kind === "close") setTimeout(() => { win.style.animation = "none"; void win.offsetWidth; win.style.animation = ""; }, (draft?.duration ?? 240) + 400);
  }

  function startFrom(key) {
    const src = BUILTIN_ANIMATIONS[key] ?? os.doc.animation.custom[key];
    draft = cleanAnimation(structuredClone(src ?? BUILTIN_ANIMATIONS.spring));
    editingKey = BUILTIN_ANIMATIONS[key] ? null : key;
    if (!editingKey) draft.name = `${draft.name} copy`;
    render();
    previewCss(draft);
    play("open");
  }

  function endEditor(title, frame) {
    return h("div.motion-end", null,
      h("div.section-label.tight", title),
      ...FIELDS.map((f) => {
        const val = frame[f.key] ?? f.dflt;
        const range = h("input", { type: "range", min: f.min, max: f.max, step: f.step, value: val });
        const num = h("input", { type: "number", min: f.min, max: f.max, step: f.step, value: val, style: { width: "62px" } });
        const set = (v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          if (n === f.dflt) delete frame[f.key]; else frame[f.key] = n;
          range.value = n; num.value = n;
          previewCss(draft);
        };
        range.addEventListener("input", () => set(range.value));
        range.addEventListener("change", () => play(title.startsWith("Open") ? "open" : "close"));
        num.addEventListener("change", () => { set(num.value); play(title.startsWith("Open") ? "open" : "close"); });
        return h("div.motion-row", null, h("label", f.label), range, num);
      }));
  }

  async function save() {
    const got = await dialog({
      title: editingKey ? `Save ${draft.name}` : "Save as a motion preset",
      fields: [
        { name: "name", label: "Name", value: draft.name },
        { name: "key", label: "Id", value: editingKey ?? draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) },
      ],
      confirmLabel: "Save preset",
    });
    if (!got?.name) return;
    const key = String(got.key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    try {
      await call("animationDefine", { key, name: got.name, duration: draft.duration, easing: draft.easing, open: draft.open, close: draft.close });
      await call("animationSet", { preset: key });
      await loadOs();
      editingKey = key;
      draft.name = got.name;
      toast(`Wearing ${got.name}`, { kind: "ok" });
      render();
    } catch (e) { toastError("Could not save the preset", e); }
  }

  async function remove(key) {
    if (!await confirmDialog(`Delete the ${os.doc.animation.custom[key]?.name ?? key} preset?`, "Anything using it falls back to Spring.")) return;
    await call("animationRemove", { key });
    await loadOs();
    if (editingKey === key) { draft = null; editingKey = null; }
    render();
  }

  function render() {
    const list = os.snap.animations ?? [];
    const gallery = h("div.card-grid", ...list.map((a) => h("button.lib-row", {
      class: a.key === os.doc.animation.preset ? "on" : "",
      style: { justifyContent: "space-between" },
      title: `${a.duration}ms · click to wear · right-click to duplicate & edit`,
      onclick: () => call("animationSet", { preset: a.key }),
      oncontextmenu: (e) => { e.preventDefault(); startFrom(a.key); },
    }, h("span.nm", { style: { fontSize: "11px" } }, a.name, a.builtin ? null : h("span.sub", " · yours")),
      h("span", { style: { display: "flex", gap: "4px" } },
        h("button.rail-btn.sm", { title: "Duplicate & edit", onclick: (e) => { e.stopPropagation(); startFrom(a.key); } }, icon("code", 12)),
        a.builtin ? null : h("button.rail-btn.sm", { title: "Delete", onclick: (e) => { e.stopPropagation(); remove(a.key); } }, icon("trash", 12))))));

    const editor = draft ? (() => {
      const dur = h("input", { type: "range", min: 0, max: 2000, step: 10, value: draft.duration });
      const durNum = h("input", { type: "number", min: 0, max: 2000, step: 10, value: draft.duration, style: { width: "62px" } });
      const setDur = (v) => { draft.duration = Math.max(0, Math.min(2000, Number(v) || 0)); dur.value = draft.duration; durNum.value = draft.duration; previewCss(draft); };
      dur.addEventListener("input", () => setDur(dur.value));
      durNum.addEventListener("change", () => setDur(durNum.value));
      const ease = h("select", null, ...EASINGS.map((e) => h("option", { value: e, selected: e === draft.easing }, e)));
      ease.addEventListener("change", () => { draft.easing = ease.value; previewCss(draft); play("open"); });
      return h("div.motion-editor", null,
        h("div.section-label", editingKey ? `Editing ${draft.name}` : `New preset from ${draft.name.replace(/ copy$/, "")}`),
        sample,
        h("div", { style: { display: "flex", gap: "6px", margin: "8px 0" } },
          h("button.ghost", { onclick: () => play("open") }, "▶ open"),
          h("button.ghost", { onclick: () => play("close") }, "▶ close"),
          h("span.spacer"),
          h("button.ghost", { onclick: () => { draft = null; editingKey = null; styleEl?.remove(); styleEl = null; render(); } }, "Discard")),
        h("div.motion-row", null, h("label", "Duration"), dur, durNum),
        h("div.motion-row", null, h("label", "Easing"), ease),
        endEditor("Open — starts from", draft.open.from),
        endEditor("Close — ends at", draft.close.to),
        h("button.ghost.wide", { style: { marginTop: "10px" }, onclick: save }, editingKey ? "Save changes" : "Save as preset…"),
      );
    })() : h("div.dim", { style: { fontSize: "11px", padding: "6px 4px" } }, "Right-click a preset (or its edit button) to duplicate it and design from there.");

    fill(el,
      h("div.section-label", "Motion presets"), gallery,
      h("div", { style: { marginTop: "14px" } }, editor),
      h("div.note", null, "Presets are numbers — opacity, scale, offset, rotation, blur, a duration and a named easing — compiled to keyframes by ",
        h("code", "animationCss"), ". Wide expressive range, closed injection surface."));
  }

  return { el, render, destroy() { styleEl?.remove(); styleEl = null; } };
}
