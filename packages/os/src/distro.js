// Distros — a whole operating system, packaged.
//
// A distro is the OS document plus the source of every custom app and widget it
// depends on. That is the entire promise of "totally customizable": if you can
// build it, you can hand it to someone else and they get exactly your machine —
// same theme, same motion, same windows, same code behind the windows.
//
// Nothing in here touches the disk or the database. It turns documents into
// payloads and payloads back into documents; `store.js` does the I/O and the
// `desktop` MCP server does the authorization.

import { normalizeDoc, defaultDoc, rid, LIMITS } from "./schema.js";
import { BUILTIN_DISTROS, builtinApp, builtinWidget } from "./catalog.js";
import { BUILTIN_THEMES } from "./themes.js";

export const DISTRO_PAYLOAD_VERSION = 1;

/** Lay windows out in a readable cascade rather than stacking them at one point. */
function cascade(i) {
  return { x: 56 + (i % 4) * 42, y: 52 + (i % 4) * 36 };
}

/** Build a fresh OS document from one of the built-in distro seeds. */
export function docFromDistroSpec(spec, { name } = {}) {
  const doc = defaultDoc(name ?? spec.name ?? "untitled-os");
  doc.theme.base = BUILTIN_THEMES[spec.theme] ? spec.theme : doc.theme.base;
  doc.distro = { id: spec.id, name: spec.name, forkedAt: Date.now() };
  doc.shell.dock.pinned = [...new Set([...(spec.apps ?? []), "settings"])];

  let z = 10;
  doc.windows = (spec.apps ?? []).filter(builtinApp).map((appId, i) => {
    const meta = builtinApp(appId);
    return {
      id: rid("w"), app: appId, title: meta.name, ...cascade(i),
      w: meta.window.w, h: meta.window.h, z: ++z, ws: 1, min: false, max: false, props: {},
    };
  });
  doc.zTop = z;

  let gy = 20;
  doc.widgets = (spec.widgets ?? []).filter(builtinWidget).map((kind) => {
    const meta = builtinWidget(kind);
    const g = { id: rid("g"), kind, x: 24, y: gy, w: meta.size.w, h: meta.size.h, ws: 1, pin: "none", props: {} };
    gy += meta.size.h + 16;
    return g;
  });

  return normalizeDoc(doc);
}

/** The document a brand-new Sandbox wakes up wearing. */
export function firstRunDoc(name) {
  const dev = BUILTIN_DISTROS.find((d) => d.id === "dev") ?? BUILTIN_DISTROS[0];
  const doc = docFromDistroSpec(dev, { name: name ?? "my-os" });
  doc.notifications = [{
    id: rid("n"), app: "SandboxOS", kind: "accent",
    title: "Your machine is yours",
    body: "Open OS Studio (or ask the agent) to add apps, widgets, themes and motion. Nothing here is fixed.",
    ts: Date.now(), read: false,
  }];
  return normalizeDoc(doc);
}

/**
 * Package a document + its bundle sources into a portable payload.
 * Runtime state (which windows happen to be open, notifications, the active
 * workspace) is deliberately KEPT: a distro should hand you a machine that is
 * already arranged, not an empty desktop with the right colours.
 */
export function exportPayload(doc, { apps = {}, widgets = {}, name, description } = {}) {
  const clean = normalizeDoc(doc);
  return {
    payloadVersion: DISTRO_PAYLOAD_VERSION,
    name: name ?? clean.name,
    description: description ?? "",
    exportedAt: Date.now(),
    os: { ...clean, notifications: [], rev: 0 },
    bundles: {
      apps: pickBundles(apps, Object.keys(clean.apps)),
      widgets: pickBundles(widgets, Object.keys(clean.widgetKinds)),
    },
  };
}

function pickBundles(map, ids) {
  const out = {};
  for (const id of ids) if (map[id]) out[id] = map[id];
  return out;
}

/**
 * Turn a payload back into a document. The importing Sandbox gets fresh element
 * ids so two forks of the same distro never collide, and the lineage is recorded
 * so the machine can always say what it grew from.
 */
export function importPayload(payload, { name, distro } = {}) {
  const src = payload?.os ?? payload;
  const doc = normalizeDoc(src, { name: name ?? payload?.name });
  doc.id = rid("os");
  doc.rev = 0;
  doc.name = (name ?? payload?.name ?? doc.name).slice(0, LIMITS.nameLen);
  doc.distro = distro ? { id: distro.id, name: distro.name, forkedAt: Date.now() } : doc.distro;
  for (const w of doc.windows) w.id = rid("w");
  for (const g of doc.widgets) g.id = rid("g");
  for (const ws of doc.workspaces) ws.id = rid("ws");
  return {
    doc: normalizeDoc(doc),
    bundles: {
      apps: payload?.bundles?.apps ?? {},
      widgets: payload?.bundles?.widgets ?? {},
    },
  };
}

/** The distros anyone can fork without having published anything yet. */
export function builtinDistroList() {
  return BUILTIN_DISTROS.map((d) => ({
    id: d.id, name: d.name, description: d.description, hue: d.hue,
    theme: d.theme, apps: d.apps, widgets: d.widgets, builtin: true,
  }));
}
