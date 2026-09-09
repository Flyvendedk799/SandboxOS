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
    suspended: !!c.suspended,
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
    suspended: !!c.suspended,
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
 * The capabilities an app frame actually gets: the *intersection* of what it
 * declared and what the human opening it holds.
 *
 * The word intersection is load-bearing, and it used not to be. An app asking
 * for `fs.*` from someone who holds only `fs.read` got **nothing**, because the
 * check was "is this request fully covered". That is safe but wrong: it makes a
 * generously-declared app useless to a narrow user, and it teaches app authors
 * to ask for less than they need. So a declared pattern is narrowed to the parts
 * the opener actually holds — `fs.*` ∩ {`fs.read`} is `fs.read` — and never
 * widened: an app can still never hold more than the person who opened it.
 *
 * One deliberate exception: a bare `*` is *not* narrowed. An app that declares
 * "everything" has not declared anything, and the OS will not fill that in on
 * its behalf — it gets what a literal `*` grant covers, which is to say nothing
 * unless its opener really did hand it the whole machine. Name what you need.
 */
export function effectivePermissions(requested, held) {
  const want = cleanPatterns(requested);
  const out = new Set();
  for (const p of want) {
    if (held.some((h) => patternCovers(h, p))) { out.add(p); continue; }
    if (p === "*") continue;   // "everything" is not a declaration
    // Not covered whole; take the parts of it the opener does hold.
    for (const h of held) if (patternCovers(p, h)) out.add(h);
  }
  return [...out];
}

/**
 * What the opener could not grant, as the app asked for it — shown in the UI,
 * never thrown. A pattern that was *narrowed* rather than refused still appears
 * here, because "you asked for fs.* and got fs.read" is something the app and
 * the person should both be able to see.
 */
export function withheldPermissions(requested, held) {
  const want = cleanPatterns(requested);
  return want.filter((p) => !held.some((h) => patternCovers(h, p)));
}
