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

import crypto from "node:crypto";
import { normalizeDoc, defaultDoc, rid, LIMITS } from "./schema.js";
import { BUILTIN_DISTROS, builtinApp, builtinWidget } from "./catalog.js";
import { BUILTIN_THEMES } from "./themes.js";

export const DISTRO_PAYLOAD_VERSION = 2;

/** A content hash of one bundle — every path and every byte, in path order. */
export function bundleHash(files) {
  const h = crypto.createHash("sha256");
  for (const rel of Object.keys(files ?? {}).sort()) {
    const f = files[rel] ?? {};
    h.update(rel).update("\0").update(f.base64 ? "b64:" : "utf8:").update(String(f.content ?? "")).update("\0");
  }
  return h.digest("hex");
}

/** The integrity manifest of a payload: sha256 per bundle. Verified on import,
 *  so a distro that was edited in transit is refused rather than installed. A
 *  stub of the Phase-6 signing story — hashes now, signatures later. */
export function integrityOf(bundles) {
  return {
    algorithm: "sha256",
    apps: Object.fromEntries(Object.entries(bundles?.apps ?? {}).map(([id, f]) => [id, bundleHash(f)])),
    widgets: Object.fromEntries(Object.entries(bundles?.widgets ?? {}).map(([k, f]) => [k, bundleHash(f)])),
  };
}

/** Throws when a payload's integrity block disagrees with its bundles. A payload
 *  with no block (version 1) passes: it predates the check. */
export function verifyIntegrity(payload) {
  const want = payload?.integrity;
  if (!want) return { verified: false, reason: "no integrity block" };
  if (want.algorithm !== "sha256") throw new Error(`unsupported integrity algorithm: ${want.algorithm}`);
  const have = integrityOf(payload.bundles);
  for (const kind of ["apps", "widgets"]) {
    for (const [id, hash] of Object.entries(want[kind] ?? {})) {
      if (have[kind][id] !== hash) throw new Error(`integrity check failed for ${kind.slice(0, -1)} ${id}: bundle was modified after publish`);
    }
    for (const id of Object.keys(have[kind])) {
      if (!(id in (want[kind] ?? {}))) throw new Error(`integrity check failed: ${kind.slice(0, -1)} ${id} is not in the manifest`);
    }
  }
  return { verified: true };
}

/** Lay windows out in a readable cascade rather than stacking them at one point. */
function cascade(i) {
  return { x: 56 + (i % 4) * 42, y: 52 + (i % 4) * 36 };
}

/** Build a fresh OS document from one of the built-in distro seeds. */
export function docFromDistroSpec(spec, { name } = {}) {
  const doc = defaultDoc(name ?? spec.name ?? "untitled-os");
  doc.theme.base = BUILTIN_THEMES[spec.theme] ? spec.theme : doc.theme.base;
  doc.distro = { id: spec.id, name: spec.name, forkedAt: Date.now() };
  // A seed can pin more than it opens: the machine's own tools belong within
  // reach whether or not a window for them is on screen at first run.
  doc.shell.dock.pinned = [...new Set([...(spec.dock ?? spec.apps ?? []), "settings"])];

  let z = 10;
  doc.windows = (spec.apps ?? []).filter(builtinApp).map((appId, i) => {
    const meta = builtinApp(appId);
    return {
      id: rid("w"), app: appId, title: meta.name, ...cascade(i),
      w: meta.window.w, h: meta.window.h, z: ++z, ws: 1, min: false, max: false, props: {},
    };
  });
  // Custom apps a seed ships with (Workshop's volume-origin Notebook). Their
  // files are the forker's job — see desktop.distroFork — because writing into
  // a Cell is an authorized act, and this module holds no authority.
  for (const a of spec.customApps ?? []) {
    doc.apps[a.id] = { ...a, createdAt: Date.now(), updatedAt: Date.now() };
    const meta = a.window ?? {};
    doc.windows.push({
      id: rid("w"), app: a.id, title: a.name, ...cascade(doc.windows.length),
      w: meta.w ?? 420, h: meta.h ?? 300, z: ++z, ws: 1, min: false, max: false, props: {},
    });
    doc.shell.dock.pinned = [...new Set([...doc.shell.dock.pinned, a.id])];
  }
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
export function exportPayload(doc, { apps = {}, widgets = {}, name, description, manifest = null, tags = [], keepNotifications = false } = {}) {
  const clean = normalizeDoc(doc);
  const bundles = {
    apps: pickBundles(apps, Object.keys(clean.apps)),
    widgets: pickBundles(widgets, Object.keys(clean.widgetKinds)),
  };
  return {
    payloadVersion: DISTRO_PAYLOAD_VERSION,
    name: name ?? clean.name,
    description: description ?? "",
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 12),
    exportedAt: Date.now(),
    os: { ...clean, notifications: keepNotifications ? clean.notifications : [], rev: 0 },
    bundles,
    integrity: integrityOf(bundles),
    // The Cell's composition travels beside the desktop (Wave D1): which servers
    // are enabled and how they are configured. Secrets never do; neither do the
    // resolved file URLs of installed marketplace servers — only their names.
    ...(manifest ? { manifest: portableManifest(manifest) } : {}),
  };
}

/**
 * A whole machine, not just its face (goal.md T3.4).
 *
 * A distro payload is the desktop plus the apps plus the Cell's composition — what
 * you hand to someone else. A *backup* is that plus the parts that are yours
 * alone: the named checkpoints, and a manifest of the volume so a restore can say
 * what is missing rather than pretend the files came back.
 *
 * The manifest is names, sizes and hashes — deliberately not contents. Bytes
 * belong to Tide (or to whatever the operator backs the volume up with); what this
 * adds is the ability to answer "is this the machine I saved?" honestly.
 */
export function machinePayload({ payload, checkpoints = [], volume = null, tide = null }) {
  return {
    ...payload,
    kind: "machine",
    checkpoints,
    ...(volume ? { volume } : {}),
    ...(tide ? { tide } : {}),
  };
}

/**
 * Compare a saved volume manifest against what is on disk now. Three answers,
 * because "restored" is not one of them: present and identical, present and
 * different, gone.
 */
export function compareVolume(manifest, current) {
  const now = new Map((current ?? []).map((f) => [f.path, f]));
  const missing = [];
  const changed = [];
  for (const f of manifest ?? []) {
    const seen = now.get(f.path);
    if (!seen) { missing.push(f.path); continue; }
    if (seen.sha256 && f.sha256 && seen.sha256 !== f.sha256) changed.push(f.path);
    else if (!seen.sha256 && seen.size !== f.size) changed.push(f.path);
  }
  const added = [...now.keys()].filter((p) => !(manifest ?? []).some((f) => f.path === p));
  return { files: (manifest ?? []).length, missing, changed, added };
}

/** The part of a Sandboxfile that makes sense on another machine. */
export function portableManifest(m) {
  if (!m || typeof m !== "object") return null;
  return {
    servers: Object.fromEntries(Object.entries(m.servers ?? {}).map(([k, v]) => [k, v && typeof v === "object" ? v : {}])),
    installed: Object.fromEntries(Object.entries(m.installedMeta ?? {}).map(([k, v]) => [k, { source: v?.source ?? null }])),
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
export function importPayload(payload, { name, distro, trusted = false } = {}) {
  verifyIntegrity(payload);
  const src = payload?.os ?? payload;
  const doc = normalizeDoc(src, { name: name ?? payload?.name });
  // Someone else's companion servers arrive switched off. A distro is a
  // document, not a grant: the person forking it turns each server on once
  // they have read what it does. Façades carry no code, so they stay on.
  if (!trusted) {
    for (const app of Object.values(doc.apps)) {
      if (app.mcp?.entrypoint) app.mcp.enabled = false;
    }
  }
  doc.id = rid("os");
  doc.rev = 0;
  doc.name = (name ?? payload?.name ?? doc.name).slice(0, LIMITS.nameLen);
  doc.distro = distro ? { id: distro.id, name: distro.name, forkedAt: Date.now(), ...(distro.tenant ? { tenant: distro.tenant } : {}), ...(distro.visibility ? { visibility: distro.visibility } : {}) } : doc.distro;
  for (const w of doc.windows) w.id = rid("w");
  for (const g of doc.widgets) g.id = rid("g");
  for (const ws of doc.workspaces) ws.id = rid("ws");
  return {
    doc: normalizeDoc(doc),
    bundles: {
      apps: payload?.bundles?.apps ?? {},
      widgets: payload?.bundles?.widgets ?? {},
    },
    manifest: payload?.manifest ?? null,
  };
}

/** The distros anyone can fork without having published anything yet. */
export function builtinDistroList() {
  return BUILTIN_DISTROS.map((d) => ({
    id: d.id, name: d.name, description: d.description, hue: d.hue,
    theme: d.theme, apps: d.apps, widgets: d.widgets, builtin: true,
    customApps: (d.customApps ?? []).map((a) => a.id), seedFiles: Object.keys(d.seedFiles ?? {}).length,
    tags: ["seed"],
  }));
}
