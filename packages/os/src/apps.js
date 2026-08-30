// App resolution — turning an app id into something the shell can open.
//
// The shell should not care whether an app is one we shipped, one the user's
// agent wrote this morning, or a URL pointing at a service running on a port
// inside the Cell. It asks for a descriptor and gets the same shape back either
// way. Everything downstream — the dock, the launcher, spotlight, the window
// chrome, the capability broker — reads that one shape.

import { BUILTIN_APPS, BUILTIN_WIDGETS, builtinApp, builtinWidget } from "./catalog.js";
import { cleanPatterns } from "./schema.js";

/**
 * Resolve one app id against a document.
 * @returns {null | {id,name,icon,hue,kind,source,permissions,window,builtin}}
 */
export function appDescriptor(doc, id) {
  const b = builtinApp(id);
  if (b) {
    return {
      id: b.id, name: b.name, icon: b.icon, hue: b.hue,
      kind: "builtin", source: null, description: "",
      permissions: b.needs ?? [], window: { ...b.window, resizable: true, singleton: false },
      builtin: true,
    };
  }
  const c = doc?.apps?.[id];
  if (!c) return null;
  return {
    id: c.id, name: c.name, icon: c.icon, hue: c.hue,
    kind: c.kind, description: c.description,
    source: c.kind === "url"
      ? { type: "url", url: c.url }
      : c.kind === "alias"
        ? { type: "alias", target: c.target }
        : { type: "bundle", entry: c.entry, origin: c.origin, volumePath: c.volumePath ?? null },
    permissions: c.permissions ?? [],
    window: c.window,
    builtin: false,
    updatedAt: c.updatedAt,
  };
}

export function widgetDescriptor(doc, kind) {
  const b = builtinWidget(kind);
  if (b) {
    return { kind: b.kind, name: b.name, icon: b.icon, builtin: true, source: null, permissions: [], size: b.size, refreshMs: 0 };
  }
  const c = doc?.widgetKinds?.[kind];
  if (!c) return null;
  return {
    kind: c.kind, name: c.name, icon: c.icon, builtin: false,
    description: c.description,
    source: { type: "bundle", entry: c.entry, origin: c.origin, volumePath: c.volumePath ?? null },
    permissions: c.permissions ?? [],
    size: c.size, refreshMs: c.refreshMs, updatedAt: c.updatedAt,
  };
}

/** Everything this machine can launch right now. */
export function listApps(doc) {
  const out = BUILTIN_APPS.map((a) => appDescriptor(doc, a.id));
  for (const id of Object.keys(doc?.apps ?? {})) out.push(appDescriptor(doc, id));
  return out.filter(Boolean);
}

export function listWidgetKinds(doc) {
  const out = BUILTIN_WIDGETS.map((w) => widgetDescriptor(doc, w.kind));
  for (const k of Object.keys(doc?.widgetKinds ?? {})) out.push(widgetDescriptor(doc, k));
  return out.filter(Boolean);
}

// ---- capability brokering --------------------------------------------------

/** Does `held` (a caller's grants) cover `wanted` (an app's request)? */
export function patternCovers(held, wanted) {
  if (held === "*") return true;
  if (held === wanted) return true;
  const [hs, ht] = held.split(".");
  const [ws, wt] = wanted.split(".");
  if (hs !== ws) return false;
  return ht === "*" || ht === wt;
}

/**
 * The capabilities an app frame actually gets: the intersection of what it
 * declared and what the human opening it holds. An app can never be granted more
 * than the person running it, and asking for more than you hold is not an error —
 * it just does not arrive. Attenuation, applied at the door.
 */
export function effectivePermissions(requested, held) {
  const want = cleanPatterns(requested);
  return want.filter((p) => held.some((h) => patternCovers(h, p)));
}

/** Requested patterns the opener could not grant — shown in the UI, not thrown. */
export function withheldPermissions(requested, held) {
  const want = cleanPatterns(requested);
  return want.filter((p) => !held.some((h) => patternCovers(h, p)));
}
