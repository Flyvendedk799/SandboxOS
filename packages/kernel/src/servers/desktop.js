// The `desktop` MCP server — the OS experience, as a syscall surface.
//
// This is the feature the rest of SandboxOS was built to make possible: the
// machine at your slug is not just reachable, it is a place — windows, widgets,
// workspaces, a dock, a theme, motion — and every one of those is a tool call.
//
// Which means the agent has exactly the same powers over your desktop that you
// do, through exactly the same door: authorize → route → execute → audit. There
// is no privileged path that draws the UI behind the Kernel's back. "Ask the
// agent to build me a media gallery and put it bottom-right" is `desktop.open`
// plus `desktop.move`, both audited, both revertible with `desktop.revert`.
//
// Two rules hold everything together:
//
//   · Every mutation goes through store.mutateOs, so it is normalized, revved,
//     announced on the live bus and pushed onto the undo history.
//   · Nothing here renders anything. Tools write the document; the shell reads
//     it. A tool that needed to know the pixel size of the screen would be a
//     tool in the wrong layer.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  loadOs, mutateOs, saveOs, resetOs, osHistory, osHistoryEntry, revertOs, REVERT_SCOPES, announce,
  normalizeDoc, normApp, normWidgetKind, cleanTokens, cleanAnimation, cleanPatterns,
  isId, rid, LIMITS, DOCK_POSITIONS, WM_MODES, resolveAlias,
  buildTree, treeBoxes, treeLeaves, splitFor, setRatio, setDir, swapLeaves, normalizeTree, describeTree, TREE_PRESETS,
  BUILTIN_THEMES, listThemes, resolveTheme, themeKey, checkContrast, contrastRatio,
  BUILTIN_ANIMATIONS, listAnimations, resolveAnimation,
  builtinApp, builtinWidget, appDescriptor, widgetDescriptor, listApps, listWidgetKinds,
  writeBundleFile, readBundleFile, listBundleFiles, removeBundleFile, removeBundle,
  exportBundle, importBundle, starterApp, starterAppCss, starterAppJs, starterWidget, starterServerJs, starterAppToolsJs,
  exportPayload, importPayload, builtinDistroList, docFromDistroSpec, RESERVED_SERVER_NAMES,
  machinePayload, compareVolume,
  summarizeDoc, silhouetteSvg, READ_ONLY_DESKTOP_TOOLS,
  writeCheckpoint, readCheckpoint, removeCheckpoint, restoreCheckpoint,
  KEY_ACTIONS, DEFAULT_KEYS, isChord, NOTIFY_KINDS, prettyChord,
  firstRunFiles, firstRunServer, firstRunPort, proposalImpact,
} from "../../../os/src/index.js";
import { loadManifest, saveManifest } from "../../../manifest/src/manifest.js";
import { CATALOG } from "../catalog.js";
import { BUILTIN_DISTROS } from "../../../os/src/catalog.js";
import {
  createDistro, listDistros, getDistro, getDistroByName, deleteDistro, listGallery, setDistroVisibility, bumpDistroForks,
  listSandboxAccess, revokeSandboxAccess, queryAudit,
} from "../../../control-db/src/registry.js";
import { canDelegate } from "../capabilities.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

/** Windows arrive somewhere sensible rather than all on top of each other. */
function cascadeFor(doc, ws) {
  const n = doc.windows.filter((w) => w.ws === ws).length;
  return { x: 56 + (n % 5) * 28, y: 52 + (n % 5) * 24 };
}

/** An imported distro is untrusted input; bound it before it becomes disk. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** What a gallery card needs to draw a machine without seeing its contents:
 *  the palette, and the silhouettes of its windows and widgets. No titles, no
 *  file paths, no props — a shape, not a screenshot. */
function previewOf(d) {
  const t = resolveTheme(d);
  const ws = d.activeWorkspace;
  return {
    theme: { bg0: t.bg0, bg1: t.bg1, accent: t.accent, wall: t.wall, scheme: t.scheme },
    windows: d.windows.filter((w) => w.ws === ws && !w.min).slice(0, 12).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, app: builtinApp(w.app) ? w.app : "custom" })),
    widgets: d.widgets.filter((g) => g.ws === ws).slice(0, 12).map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, pin: g.pin })),
    dock: d.shell.dock.position,
    workspaces: d.workspaces.length,
    apps: Object.keys(d.apps).length,
    tools: Object.values(d.apps).filter((x) => x.mcp).length,
    wm: d.wm.mode,
  };
}

/** Props merge shallowly; a null value removes the key (the same convention as `patch`). */
function mergeProps(current, patch) {
  const out = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}

const findWindow = (doc, id) => doc.windows.find((w) => w.id === id);
const findWidget = (doc, id) => doc.widgets.find((g) => g.id === id);

function mustWindow(doc, id) {
  const w = findWindow(doc, id);
  if (!w) throw new Error(`no such window: ${id}`);
  return w;
}
function mustWidget(doc, id) {
  const g = findWidget(doc, id);
  if (!g) throw new Error(`no such widget: ${id}`);
  return g;
}

/** App descriptors plus, for apps with a tool face, what that face serves now. */
function annotatedApps(d, kernel) {
  const live = kernel ? new Set(kernel.listTools().map((t) => t.name)) : new Set();
  return listApps(d).map((a) => {
    const m = d.apps[a.id]?.mcp;
    if (!m) return a;
    const declared = m.entrypoint ? [] : m.tools.map((t) => t.name);
    const served = [...live].filter((n) => n.startsWith(`${m.name}.`)).map((n) => n.slice(m.name.length + 1));
    return { ...a, mcp: { name: m.name, enabled: m.enabled, entrypoint: m.entrypoint ?? null, tools: served.length ? served : declared, live: served.length > 0 } };
  });
}

/** The document plus everything a shell needs to paint it in one round trip. */
function snapshot(doc, kernel = null) {
  return {
    doc,
    rev: doc.rev,
    themeKey: themeKey(doc),
    theme: resolveTheme(doc),
    animation: resolveAnimation(doc),
    apps: annotatedApps(doc, kernel),
    widgetKinds: listWidgetKinds(doc),
    themes: listThemes(doc).map(({ key, name, scheme, builtin, tokens }) => ({
      key, name, scheme, builtin, accent: tokens.accent, wall: tokens.wall,
    })),
    animations: listAnimations(doc),
    limits: LIMITS,
  };
}

/** Which workspace a tool means: the one named, else the active one. */
function wsOf(d, n) {
  const ws = n != null ? Number(n) : d.activeWorkspace;
  const found = d.workspaces.find((w) => w.n === ws);
  if (!found) throw new Error(`no such workspace: ${ws}`);
  return found;
}

/** Everything a revision changed against another, structurally — for a history UI
 *  that can say "3 windows, the theme, the dock" rather than "rev 41". */
function structuralDiff(from, to) {
  const ids = (list) => new Map((list ?? []).map((x) => [x.id, x]));
  const diffList = (a, b, keys) => {
    const A = ids(a), B = ids(b);
    let added = 0, removed = 0, changed = 0;
    for (const id of B.keys()) if (!A.has(id)) added += 1;
    for (const [id, x] of A) {
      if (!B.has(id)) { removed += 1; continue; }
      if (keys.some((k) => JSON.stringify(x[k]) !== JSON.stringify(B.get(id)[k]))) changed += 1;
    }
    return { added, removed, changed };
  };
  const keysChanged = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
    .filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  return {
    windows: diffList(from.windows, to.windows, ["app", "title", "x", "y", "w", "h", "ws", "min", "max", "props"]),
    widgets: diffList(from.widgets, to.widgets, ["kind", "x", "y", "w", "h", "ws", "pin", "props"]),
    workspaces: diffList(from.workspaces, to.workspaces, ["name", "wallpaper", "layout"]),
    theme: keysChanged({ base: from.theme?.base, ...from.theme?.tokens }, { base: to.theme?.base, ...to.theme?.tokens }),
    animation: from.animation?.preset !== to.animation?.preset ? [to.animation?.preset] : [],
    wm: keysChanged(from.wm, to.wm),
    shell: keysChanged(from.shell, to.shell),
    apps: keysChanged(from.apps, to.apps),
    widgetKinds: keysChanged(from.widgetKinds, to.widgetKinds),
    name: from.name !== to.name,
  };
}

export function desktopServer(deps) {
  const { sandbox, kernel } = deps;
  const doc = () => loadOs(sandbox);
  /** Register/deregister app servers now rather than waiting for the bus, so a
   *  tool defined by this call is callable by the next one. */
  const syncServers = async () => {
    try {
      const r = await kernel?.syncAppServers?.();
      // The catalog changed after the document did; tell the shells to re-read it.
      announce(sandbox.id, "appServers", { registered: r?.registered ?? [] });
      return r;
    } catch { return null; }
  };

  /** Apply a distro's portable manifest to this Cell: core servers and their
   *  config. Marketplace servers are named, not installed — installing code is
   *  a separate, explicit act (mcp-registry.install). */
  function applyPortableManifest(portable) {
    if (!portable?.servers || typeof portable.servers !== "object") return { applied: [], skipped: [] };
    const m = loadManifest(sandbox);
    const applied = [], skipped = [];
    const next = {};
    for (const [name, cfg] of Object.entries(portable.servers)) {
      if (CATALOG[name]) { next[name] = cfg && typeof cfg === "object" ? cfg : {}; applied.push(name); }
      else if (m.installed?.[name]) { next[name] = m.servers?.[name] ?? {}; applied.push(name); }
      else skipped.push(name);
    }
    // Never let a distro lock the machine or remove its desktop.
    for (const keep of ["kernel", "mcp-registry", "desktop"]) next[keep] ??= m.servers?.[keep] ?? {};
    m.servers = next;
    saveManifest(sandbox, m);
    kernel?.rebuild?.();
    return { applied, skipped: [...skipped, ...Object.keys(portable.installed ?? {}).filter((n) => !m.installed?.[n])] };
  }
  const mutate = (fn, op, label, expectRev = null) => mutateOs(sandbox, fn, { op, label, expectRev });

  /** Gallery rows as the shell shows them: never the payload, always the preview. */
  const galleryRows = (principalId, opts = {}) => listGallery(sandbox.tenant_id, { principalId, ...opts })
    .filter((d) => d.has_os)
    .map((d) => ({
      id: d.id, name: d.name, description: d.description ?? "", builtin: false, createdAt: d.created_at,
      visibility: d.visibility ?? "tenant", tags: d.tags ?? [], preview: d.preview ?? null, forks: d.forks ?? 0,
      mine: !!d.mine, hue: d.preview?.theme?.accent ?? null,
    }));

  /** Custom app/widget bundles this Sandbox holds, as a portable map. */
  const collectBundles = (d) => ({
    apps: Object.fromEntries(Object.keys(d.apps).map((id) => [id, exportBundle(sandbox, "app", id)])),
    widgets: Object.fromEntries(Object.keys(d.widgetKinds).map((k) => [k, exportBundle(sandbox, "widget", k)])),
  });

  // The server refers to its own tools when applying a proposal: a proposal is a
  // list of ordinary calls, and it must not become a second, weaker way in.
  const self = {
    name: "desktop",
    tools: {

      // ── the document ────────────────────────────────────────────────────

      get: {
        description: "The whole OS: document, resolved theme and motion, and the app/widget/distro catalogs.",
        inputSchema: obj({}),
        async handler(ctx) {
          return { ...snapshot(doc(), kernel), distros: [...builtinDistroList(), ...galleryRows(ctx?.principalId)] };
        },
      },

      state: {
        description: "Just the OS document (no catalogs) — the cheap poll.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { doc: d, rev: d.rev, themeKey: themeKey(d) }; },
      },

      summarize: {
        description:
          "The desktop as a short textual map sized for a model's context: workspaces, windows with app/title/geometry, " +
          "the tiling tree, widgets, theme, custom apps and their tools, revision. Read this before rearranging a desktop you cannot see.",
        inputSchema: obj({}),
        async handler() {
          const d = doc();
          return { rev: d.rev, map: summarizeDoc(d, snapshot(d, kernel)) };
        },
      },

      silhouette: {
        description: "A semantic screenshot: an SVG of window and widget shapes in the theme's colours, drawn from the document — never a pixel of what is inside them.",
        inputSchema: obj({ width: N, height: N }),
        async handler(_ctx, a) {
          const d = doc();
          const width = Math.max(64, Math.min(1600, Number(a.width) || 320));
          const height = Math.max(40, Math.min(1000, Number(a.height) || 200));
          return { rev: d.rev, svg: silhouetteSvg({ ...previewOf(d), label: d.name }, { width, height }) };
        },
      },

      set: {
        description: "Replace the entire OS document. Optionally conditional on a revision.",
        inputSchema: obj({ doc: { type: "object" }, expectRev: N, label: S }, ["doc"]),
        async handler(_ctx, a) {
          const next = saveOs(sandbox, a.doc, { expectRev: a.expectRev ?? null, label: a.label ?? "set" });
          return { ok: true, rev: next.rev };
        },
      },

      patch: {
        description: "Deep-merge a partial document into the OS (nulls delete keys).",
        inputSchema: obj({ patch: { type: "object" }, expectRev: N, label: S }, ["patch"]),
        async handler(_ctx, a) {
          const next = mutateOs(sandbox, (d) => deepMerge(d, a.patch), {
            op: "patch", label: a.label ?? "patch", expectRev: a.expectRev ?? null,
          });
          return { ok: true, rev: next.rev };
        },
      },

      rename: {
        description: "Rename this OS.",
        inputSchema: obj({ name: S }, ["name"]),
        async handler(_ctx, a) {
          const next = mutate((d) => { d.name = String(a.name).slice(0, LIMITS.nameLen); }, "rename", `name → ${a.name}`);
          return { ok: true, name: next.name, rev: next.rev };
        },
      },

      history: {
        description: "Revisions available to revert to, newest first. Pass rev to also get what that revision changed against the current document.",
        inputSchema: obj({ rev: N }),
        async handler(_ctx, a) {
          const d = doc();
          const out = { revisions: osHistory(sandbox), current: d.rev };
          if (a.rev != null) {
            const entry = osHistoryEntry(sandbox, a.rev);
            if (!entry) throw new Error(`no such revision: ${a.rev}`);
            out.rev = entry.rev;
            out.label = entry.label;
            out.ts = entry.ts;
            out.diff = structuralDiff(entry.doc, d);
          }
          return out;
        },
      },

      revert: {
        description:
          "Restore a previous revision (itself recorded as a new revision). Pass only:['windows'] to take back " +
          "just part of it — undo an alignment without losing the widget that was added after it.",
        inputSchema: obj({ rev: N, only: { type: "array", items: { type: "string", enum: [...REVERT_SCOPES] } } }, ["rev"]),
        async handler(_ctx, a) {
          const only = Array.isArray(a.only) && a.only.length ? a.only : null;
          const next = revertOs(sandbox, a.rev, { only });
          await syncServers();
          return { ok: true, rev: next.rev, restored: Number(a.rev), ...(only ? { only } : {}) };
        },
      },

      // ── first run: ten minutes to useful (goal.md T5.1) ─────────────────
      //
      // A new machine used to open on a tidy but idle desktop. This makes the
      // first thing you see the machine doing work: a seed you picked, a small
      // project written into the volume, a static server supervised as a job,
      // and that page open in the Browser under your own slug.
      //
      // Every step reports whether it happened and why not, because an
      // onboarding that quietly does three of five things is how a person learns
      // not to trust the thing they just installed.

      setupSeeds: {
        description: "The seeds first run can start from, with what each one opens.",
        inputSchema: obj({}),
        async handler() {
          return {
            seeds: builtinDistroList().map((d) => ({ id: d.id, name: d.name, description: d.description, hue: d.hue, theme: d.theme })),
            setup: doc().setup,
          };
        },
      },

      setup: {
        description:
          "First run: adopt a seed, write a small project into the volume, serve it as a supervised job, and open it. " +
          "Reports every step and what this host could not do. skip:true just marks the machine set up.",
        inputSchema: obj({
          seed: S, name: S,
          serve: { type: "boolean", description: "Start a static server for the project (default true)." },
          skip: { type: "boolean", description: "Mark first run done without changing anything." },
        }),
        async handler(ctx, a) {
          const mark = (d, seed) => { d.setup = { done: true, seed: seed ?? null, at: Date.now() }; };

          if (a.skip) {
            const next = mutate((d) => mark(d, null), "setup", "first run: skipped");
            return { ok: true, rev: next.rev, skipped: true, steps: [] };
          }

          const seedId = a.seed ?? "dev";
          const seed = BUILTIN_DISTROS.find((x) => x.id === seedId);
          if (!seed) throw new Error(`no such seed: ${seedId} — try ${BUILTIN_DISTROS.map((x) => x.id).join(", ")}`);

          const steps = [];
          const step = (what, ok, why = null) => { steps.push({ what, ok, ...(why ? { why } : {}) }); return ok; };
          const asMe = (server, tool, args) => kernel.call({
            principalId: ctx?.principalId ?? null, heldPatterns: ctx?.heldPatterns ?? [],
            onBehalfOf: "first-run", server, tool, args,
          });

          // 1 · the desktop the seed describes, wearing this machine's name.
          const current = doc();
          saveOs(sandbox, docFromDistroSpec(seed, { name: a.name ?? current.name }), { label: `first run: ${seed.name}` });
          step(`adopt the ${seed.name} seed`, true);

          // 2 · a project in the volume. Files, not a database: everything here
          //     is an ordinary file you can open, edit and delete.
          const files = firstRunFiles(a.name ?? current.name, seed);
          let wrote = 0;
          let writeWhy = null;
          for (const [rel, content] of Object.entries(files)) {
            const r = await asMe("fs", "write", { path: rel, content });
            if (r.ok) wrote += 1; else writeWhy = r.error;
          }
          step(`write ${Object.keys(files).length} files into the volume`, wrote === Object.keys(files).length, writeWhy);

          // 3 · serve it, if this host can. The Cell may be an image with no
          //     Node and no Python; that is a fact to report, not a failure to
          //     hide behind a spinner.
          let port = null;
          let job = null;
          if (a.serve !== false && wrote) {
            const found = await firstRunServer(asMe);
            if (!found.cmd) step("serve the project", false, found.why);
            else if (!(port = await firstRunPort(asMe))) {
              step("serve the project", false, "every port it tried is already in use on this host — expose one yourself from Ports");
            } else {
              const started = await asMe("proc", "start", { cmd: found.cmd(port), name: "welcome" });
              if (!started.ok) step(`serve the project with ${found.label}`, false, started.error);
              else {
                job = started.result;
                // proc.start returns as soon as the process is spawned, and a
                // static server's usual failure — the port is already taken —
                // happens a few milliseconds later. Reporting "serving" and then
                // handing over a dead job is the exact shape of a silent success,
                // so look again before saying it worked.
                await new Promise((r) => setTimeout(r, 700));
                const after = await asMe("proc", "logs", { id: job.id, tail: 6 });
                const alive = after.ok && after.result.state === "running";
                const why = alive ? null
                  : ((after.result?.logs ?? []).map((l) => l.text).filter(Boolean).at(-1)
                    ?? `it exited with code ${after.result?.code ?? "?"}`);
                if (!step(`serve the project with ${found.label} on :${port}`, alive, why)) {
                  port = null;
                } else {
                  const exposed = await asMe("ports", "expose", { port, name: "welcome" });
                  step(`expose :${port} under /${sandbox.slug}/p/${port}/`, exposed.ok, exposed.ok ? null : exposed.error);
                  if (!exposed.ok) port = null;
                }
              }
            }
          }

          // 4 · open it, and mark the machine set up. One revision.
          const next = mutate((d) => {
            const open = (app, props = {}, box = {}) => {
              const meta = appDescriptor(d, app);
              if (!meta) return;
              d.windows.push({
                id: rid("w"), app, title: meta.name, props,
                x: box.x ?? 60, y: box.y ?? 60, w: box.w ?? meta.window.w, h: box.h ?? meta.window.h,
                z: ++d.zTop, ws: d.activeWorkspace, min: false, max: false,
              });
            };
            if (port) open("browser", { port, path: "/" }, { x: 60, y: 60, w: 620, h: 420 });
            // The seed already opened a Files window in most cases; point that
            // one at the welcome folder rather than stacking a second one on it.
            const existingFiles = d.windows.find((w) => w.app === "files");
            if (existingFiles) existingFiles.props = { ...existingFiles.props, path: "welcome" };
            else open("files", { path: "welcome" }, { x: 700, y: 60, w: 480, h: 300 });
            open("help", {}, { x: 700, y: 380, w: 620, h: 380 });
            d.notifications = [{
              id: rid("n"), app: "SandboxOS", kind: "accent",
              title: port ? "Your machine is serving something" : "Your machine is ready",
              body: port
                ? `The welcome page is a folder in your volume, served by a job you can stop. Everything you see is one document.`
                : `The welcome folder is in your volume. This host could not start a server for it — the Manual says what else to try.`,
              ts: Date.now(), read: false,
            }];
            mark(d, seed.id);
          }, "setup", `first run: ${seed.name}`);

          await syncServers();
          return {
            ok: true, rev: next.rev, seed: seed.id, steps,
            ...(port ? { port, url: `/${sandbox.slug}/p/${port}/` } : {}),
            ...(job ? { job: { id: job.id, name: job.name } } : {}),
          };
        },
      },

      revertScopes: {
        description: "The parts of the desktop an undo can be aimed at, for revert's only:[…].",
        inputSchema: obj({}),
        async handler() { return { scopes: [...REVERT_SCOPES] }; },
      },

      reset: {
        description: "Throw the desktop away and start from the first-run seed.",
        inputSchema: obj({ name: S }),
        async handler(_ctx, a) {
          const next = resetOs(sandbox, { name: a.name });
          return { ok: true, rev: next.rev };
        },
      },

      // ── appearance ──────────────────────────────────────────────────────

      themeList: {
        description: "Every theme this OS can wear, built-in and custom.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { themes: listThemes(d), active: d.theme.base, tokens: d.theme.tokens }; },
      },

      themeSet: {
        description: "Wear a theme, optionally overriding individual tokens (e.g. accent).",
        inputSchema: obj({ theme: S, tokens: { type: "object" }, clearTokens: B }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.theme != null) {
              if (!BUILTIN_THEMES[a.theme] && !d.theme.custom[a.theme]) throw new Error(`no such theme: ${a.theme}`);
              d.theme.base = a.theme;
            }
            if (a.clearTokens) d.theme.tokens = {};
            if (a.tokens) d.theme.tokens = { ...d.theme.tokens, ...cleanTokens(a.tokens) };
          }, "theme", `theme → ${a.theme ?? "tokens"}`);
          return { ok: true, theme: resolveTheme(next), rev: next.rev };
        },
      },

      themeDefine: {
        description: "Create or update a custom theme from a base plus token overrides.",
        inputSchema: obj({
          key: S, name: S, base: S, scheme: { type: "string", enum: ["dark", "light"] }, tokens: { type: "object" },
        }, ["key"]),
        async handler(_ctx, a) {
          if (!isId(a.key)) throw new Error("key must be lowercase letters, digits, - or _");
          if (BUILTIN_THEMES[a.key]) throw new Error(`${a.key} is a built-in theme`);
          const next = mutate((d) => {
            if (!d.theme.custom[a.key] && Object.keys(d.theme.custom).length >= LIMITS.themes) {
              throw new Error(`theme limit reached (${LIMITS.themes})`);
            }
            d.theme.custom[a.key] = {
              name: a.name ?? d.theme.custom[a.key]?.name ?? a.key,
              base: BUILTIN_THEMES[a.base] ? a.base : (d.theme.custom[a.key]?.base ?? "midnight"),
              scheme: a.scheme ?? d.theme.custom[a.key]?.scheme,
              tokens: { ...(d.theme.custom[a.key]?.tokens ?? {}), ...cleanTokens(a.tokens ?? {}) },
            };
          }, "themeDefine", `theme ${a.key}`);
          // A theme nobody can read is a theme that shipped a bug into every
          // window at once. The check is advice, not a veto — it is your
          // machine — except when the body text is genuinely invisible on its
          // own panels, which is refused before it becomes the whole desktop.
          const resolved = resolveTheme({ theme: { base: a.key, custom: next.theme.custom, tokens: {} } });
          const readability = checkContrast(resolved);
          if (readability.unreadable.length) {
            // Take it back out rather than leave an unusable theme behind.
            const reverted = mutate((d) => { delete d.theme.custom[a.key]; }, "themeDefine", `refused ${a.key}`);
            const err = new Error(`refused: ${readability.unreadable[0].text} — text on a panel has to be readable`);
            err.code = "unreadable_theme";
            void reverted;
            throw err;
          }
          return {
            ok: true, key: a.key, themes: listThemes(next).length, rev: next.rev,
            ...(readability.warnings.length ? { warnings: readability.warnings } : {}),
          };
        },
      },

      themeRemove: {
        description: "Delete a custom theme (falls back to Midnight if it was in use).",
        inputSchema: obj({ key: S }, ["key"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            delete d.theme.custom[a.key];
            if (d.theme.base === a.key) d.theme.base = "midnight";
          }, "themeRemove", `theme ${a.key} removed`);
          return { ok: true, rev: next.rev };
        },
      },

      wallpaperSet: {
        description: "Set the desktop wallpaper (a CSS gradient/colour), globally or per workspace.",
        inputSchema: obj({ wallpaper: S, workspace: N }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.workspace != null) {
              const ws = d.workspaces.find((w) => w.n === Number(a.workspace));
              if (!ws) throw new Error(`no such workspace: ${a.workspace}`);
              ws.wallpaper = a.wallpaper ?? null;
            } else {
              d.theme.tokens = { ...d.theme.tokens, wall: a.wallpaper };
            }
          }, "wallpaper", "wallpaper");
          const applied = a.workspace != null
            ? next.workspaces.find((w) => w.n === Number(a.workspace))?.wallpaper
            : resolveTheme(next).wall;
          return { ok: true, wallpaper: applied ?? null, rev: next.rev };
        },
      },

      animationList: {
        description: "Motion presets available to this OS.",
        inputSchema: obj({}),
        async handler() { const d = doc(); return { animations: listAnimations(d), active: d.animation.preset }; },
      },

      animationSet: {
        description: "Choose the motion preset windows open and close with.",
        inputSchema: obj({ preset: S }, ["preset"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!BUILTIN_ANIMATIONS[a.preset] && !d.animation.custom[a.preset]) throw new Error(`no such animation: ${a.preset}`);
            d.animation.preset = a.preset;
          }, "animation", `motion → ${a.preset}`);
          return { ok: true, animation: resolveAnimation(next), rev: next.rev };
        },
      },

      animationDefine: {
        description: "Define a custom motion preset from numbers (opacity/scale/x/y/rotate/blur), not CSS.",
        inputSchema: obj({
          key: S, name: S, duration: N,
          easing: { type: "string", enum: ["spring", "smooth", "snap", "linear", "ease", "ease-out", "ease-in"] },
          open: { type: "object" }, close: { type: "object" },
        }, ["key"]),
        async handler(_ctx, a) {
          if (!isId(a.key)) throw new Error("key must be lowercase letters, digits, - or _");
          if (BUILTIN_ANIMATIONS[a.key]) throw new Error(`${a.key} is a built-in preset`);
          const cleaned = cleanAnimation(a);
          const next = mutate((d) => {
            if (!d.animation.custom[a.key] && Object.keys(d.animation.custom).length >= LIMITS.animations) {
              throw new Error(`animation limit reached (${LIMITS.animations})`);
            }
            d.animation.custom[a.key] = cleaned;
          }, "animationDefine", `motion ${a.key}`);
          return { ok: true, key: a.key, animation: cleaned, rev: next.rev };
        },
      },

      animationRemove: {
        description: "Delete a custom motion preset.",
        inputSchema: obj({ key: S }, ["key"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            delete d.animation.custom[a.key];
            if (d.animation.preset === a.key) d.animation.preset = "spring";
          }, "animationRemove", `motion ${a.key} removed`);
          return { ok: true, rev: next.rev };
        },
      },

      // ── shell chrome ────────────────────────────────────────────────────

      dockSet: {
        description: "Configure the dock: position, size, visibility, autohide, pinned apps.",
        inputSchema: obj({
          position: { type: "string", enum: DOCK_POSITIONS }, size: N,
          visible: B, autohide: B, pinned: { type: "array", items: S },
        }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const dock = d.shell.dock;
            if (a.position != null) dock.position = a.position;
            if (a.size != null) dock.size = a.size;
            if (a.visible != null) dock.visible = a.visible;
            if (a.autohide != null) dock.autohide = a.autohide;
            if (Array.isArray(a.pinned)) {
              for (const id of a.pinned) if (!builtinApp(id) && !d.apps[id]) throw new Error(`cannot pin unknown app: ${id}`);
              dock.pinned = a.pinned;
            }
          }, "dock", "dock");
          return { ok: true, dock: next.shell.dock, rev: next.rev };
        },
      },

      dockPin: {
        description: "Pin or unpin one app on the dock.",
        inputSchema: obj({ app: S, pinned: B }, ["app"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!builtinApp(a.app) && !d.apps[a.app]) throw new Error(`no such app: ${a.app}`);
            const list = new Set(d.shell.dock.pinned);
            if (a.pinned === false) list.delete(a.app); else list.add(a.app);
            d.shell.dock.pinned = [...list];
          }, "dockPin", `dock ${a.app}`);
          return { ok: true, pinned: next.shell.dock.pinned, rev: next.rev };
        },
      },

      shellSet: {
        description: "Configure the menu bar, spotlight and notification centre.",
        inputSchema: obj({
          menubar: { type: "object" }, spotlight: { type: "object" },
          notifications: { type: "object" }, wallpaperFit: S,
        }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (a.menubar) Object.assign(d.shell.menubar, a.menubar);
            if (a.spotlight) Object.assign(d.shell.spotlight, a.spotlight);
            if (a.notifications) {
              const n = a.notifications;
              if (n.enabled != null) d.shell.notifications.enabled = !!n.enabled;
              if (n.dnd != null) d.shell.notifications.dnd = !!n.dnd;
              if (Array.isArray(n.allow)) {
                d.shell.notifications.allow = n.allow.filter((k) => NOTIFY_KINDS.includes(k));
              }
            }
            if (a.wallpaperFit) d.shell.wallpaperFit = a.wallpaperFit;
          }, "shell", "shell");
          return { ok: true, shell: next.shell, rev: next.rev };
        },
      },

      layoutSet: {
        description:
          "Window management: floating or tiling, gap, snapping, grid size — and the tiling tree itself. " +
          "preset rebuilds a workspace's tree (master-stack, columns, rows, grid); tree sets one explicitly " +
          "({type:'split',dir:'row'|'col',ratio,a,b} | {type:'leaf',id}). Pixels are the client's business.",
        inputSchema: obj({
          mode: { type: "string", enum: WM_MODES }, gap: N, snap: B, gridSize: N,
          preset: { type: "string", enum: TREE_PRESETS }, ratio: N, ws: N, tree: { type: "object" },
          expectRev: N,
        }),
        async handler(_ctx, a) {
          let ws = null;
          const next = mutate((d) => {
            if (a.mode != null) d.wm.mode = a.mode;
            if (a.gap != null) d.wm.gap = a.gap;
            if (a.snap != null) d.wm.snap = a.snap;
            if (a.gridSize != null) d.wm.gridSize = a.gridSize;
            if (a.preset || a.tree) {
              ws = wsOf(d, a.ws);
              const here = d.windows.filter((w) => w.ws === ws.n);
              if (a.tree) {
                const cleaned = normalizeTree(a.tree, here.map((w) => w.id));
                if (!cleaned && here.length) throw new Error("tree names no window on this workspace");
                ws.layout = cleaned;
              } else {
                // Front-most first, so master-stack gives the master to the window in front.
                const ordered = [...here].sort((x, y) => y.z - x.z).map((w) => w.id);
                ws.layout = buildTree(ordered, a.preset, { ratio: a.ratio ?? 0.6 });
              }
            }
          }, "layout", `layout → ${a.preset ?? a.mode ?? "tuned"}`, a.expectRev ?? null);
          const at = ws ? next.workspaces.find((w) => w.n === ws.n) : null;
          return { ok: true, wm: next.wm, ...(at ? { ws: at.n, layout: at.layout, tree: describeTree(at.layout) } : {}), rev: next.rev };
        },
      },

      tile: {
        description:
          "Edit the tiling tree of a workspace in place: ratio sets the sash between window id and window with " +
          "(their lowest common split; without `with`, the split holding id), dir flips that split, swap exchanges two leaves.",
        inputSchema: obj({
          ws: N, id: S, with: S, ratio: N, dir: { type: "string", enum: ["row", "col"] }, swap: S, expectRev: N,
        }, ["id"]),
        async handler(_ctx, a) {
          let wsN;
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            const ws = wsOf(d, a.ws ?? w.ws);
            wsN = ws.n;
            let tree = ws.layout;
            if (!tree || !treeLeaves(tree).includes(a.id)) throw new Error(`${a.id} is not on workspace ${ws.n}`);
            if (a.swap) {
              const other = mustWindow(d, a.swap);
              if (other.ws !== ws.n) throw new Error(`${a.swap} is on another workspace`);
              tree = swapLeaves(tree, a.id, a.swap);
            }
            if (a.ratio != null || a.dir) {
              if (a.with) mustWindow(d, a.with);
              const path = splitFor(tree, a.id, a.with ?? null);
              if (path == null) throw new Error("no split between those windows");
              if (a.ratio != null) tree = setRatio(tree, path, a.ratio);
              if (a.dir) tree = setDir(tree, path, a.dir);
            }
            ws.layout = tree;
          }, "tile", a.swap ? "swap tiles" : a.dir ? "flip split" : "resize split", a.expectRev ?? null);
          const at = next.workspaces.find((w) => w.n === wsN);
          return { ok: true, ws: wsN, layout: at.layout, tree: describeTree(at.layout), rev: next.rev };
        },
      },

      // ── workspaces ──────────────────────────────────────────────────────

      workspaceList: {
        description: "List workspaces and what lives on each.",
        inputSchema: obj({}),
        async handler() {
          const d = doc();
          return {
            active: d.activeWorkspace,
            workspaces: d.workspaces.map((w) => ({
              ...w,
              windows: d.windows.filter((x) => x.ws === w.n).length,
              widgets: d.widgets.filter((x) => x.ws === w.n).length,
            })),
          };
        },
      },

      workspaceAdd: {
        description: "Add a workspace.",
        inputSchema: obj({ name: S, switchTo: B }),
        async handler(_ctx, a) {
          let created;
          const next = mutate((d) => {
            if (d.workspaces.length >= LIMITS.workspaces) throw new Error(`workspace limit reached (${LIMITS.workspaces})`);
            const n = d.workspaces.length + 1;
            created = { id: rid("ws"), n, name: a.name ?? `Workspace ${n}`, wallpaper: null };
            d.workspaces.push(created);
            if (a.switchTo !== false) d.activeWorkspace = n;
          }, "workspaceAdd", "workspace added");
          return { ok: true, workspace: created, active: next.activeWorkspace, rev: next.rev };
        },
      },

      workspaceRemove: {
        description: "Remove a workspace; its windows and widgets move to the first one.",
        inputSchema: obj({ n: N }, ["n"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (d.workspaces.length <= 1) throw new Error("a machine needs at least one workspace");
            const idx = d.workspaces.findIndex((w) => w.n === Number(a.n));
            if (idx === -1) throw new Error(`no such workspace: ${a.n}`);
            d.workspaces.splice(idx, 1);
            // Renumber densely, then re-home anything that pointed at the gap.
            const remap = new Map();
            d.workspaces.forEach((w, i) => { remap.set(w.n, i + 1); w.n = i + 1; });
            for (const list of [d.windows, d.widgets]) {
              for (const it of list) it.ws = remap.get(it.ws) ?? 1;
            }
            d.activeWorkspace = remap.get(d.activeWorkspace) ?? 1;
          }, "workspaceRemove", "workspace removed");
          return { ok: true, workspaces: next.workspaces, rev: next.rev };
        },
      },

      workspaceRename: {
        description: "Rename a workspace.",
        inputSchema: obj({ n: N, name: S }, ["n", "name"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const ws = d.workspaces.find((w) => w.n === Number(a.n));
            if (!ws) throw new Error(`no such workspace: ${a.n}`);
            ws.name = String(a.name).slice(0, LIMITS.nameLen);
          }, "workspaceRename", "workspace renamed");
          return { ok: true, workspaces: next.workspaces, rev: next.rev };
        },
      },

      workspaceSwitch: {
        description: "Switch the active workspace.",
        inputSchema: obj({ n: N }, ["n"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.workspaces.some((w) => w.n === Number(a.n))) throw new Error(`no such workspace: ${a.n}`);
            d.activeWorkspace = Number(a.n);
          }, "workspaceSwitch", `workspace ${a.n}`);
          return { ok: true, active: next.activeWorkspace, rev: next.rev };
        },
      },

      // ── windows ─────────────────────────────────────────────────────────

      windowList: {
        description: "List open windows, optionally for one workspace.",
        inputSchema: obj({ ws: N }),
        async handler(_ctx, a) {
          const d = doc();
          const windows = a.ws != null ? d.windows.filter((w) => w.ws === Number(a.ws)) : d.windows;
          return { windows, active: d.activeWorkspace };
        },
      },

      open: {
        description: "Open an app in a window (focuses the existing one if it is a singleton).",
        inputSchema: obj({
          app: S, title: S, ws: N, x: N, y: N, w: N, h: N,
          props: { type: "object" }, focus: B,
        }, ["app"]),
        async handler(_ctx, a) {
          let win;
          const next = mutate((d) => {
            // An alias is a name for another app: the window runs the target,
            // wears the alias's title, and the dock lights the alias's icon.
            const alias = appDescriptor(d, a.app);
            if (!alias) throw new Error(`no such app: ${a.app}`);
            const targetId = alias.kind === "alias" ? resolveAlias(d, a.app) : a.app;
            const desc = targetId ? appDescriptor(d, targetId) : null;
            if (!desc || desc.kind === "alias") throw new Error(`${a.app} points at an app this machine does not have`);
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            if (!d.workspaces.some((x) => x.n === ws)) throw new Error(`no such workspace: ${ws}`);

            const existing = desc.window?.singleton
              ? d.windows.find((x) => x.app === targetId && x.ws === ws) : null;
            if (existing) {
              existing.min = false;
              existing.z = ++d.zTop;
              win = existing;
              return;
            }
            if (d.windows.length >= LIMITS.windows) throw new Error(`window limit reached (${LIMITS.windows})`);
            const at = cascadeFor(d, ws);
            win = {
              id: rid("w"), app: targetId,
              title: a.title ?? alias.name,
              x: a.x ?? at.x, y: a.y ?? at.y,
              w: a.w ?? desc.window.w, h: a.h ?? desc.window.h,
              z: ++d.zTop, ws, min: false, max: false, props: a.props ?? {},
            };
            d.windows.push(win);
          }, "open", `open ${a.app}`);
          return { ok: true, window: findWindow(next, win.id) ?? win, rev: next.rev };
        },
      },

      close: {
        description: "Close a window.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const before = d.windows.length;
            d.windows = d.windows.filter((w) => w.id !== a.id);
            if (d.windows.length === before) throw new Error(`no such window: ${a.id}`);
          }, "close", "close window");
          return { ok: true, rev: next.rev };
        },
      },

      move: {
        description: "Move a window — or several windows and widgets at once with items:[{id,x,y}] (one revision, one audit row: an alignment is one intention).",
        inputSchema: obj({ id: S, x: N, y: N, items: { type: "array", items: { type: "object" } }, expectRev: N }),
        async handler(_ctx, a) {
          const items = Array.isArray(a.items) ? a.items : a.id ? [{ id: a.id, x: a.x, y: a.y }] : [];
          if (!items.length) throw new Error("id or items required");
          const next = mutate((d) => {
            for (const it of items) {
              const el = findWindow(d, it.id) ?? mustWidget(d, it.id);
              if (it.x != null) el.x = Number(it.x);
              if (it.y != null) el.y = Number(it.y);
              if (it.pin != null && el.kind) el.pin = it.pin;
            }
          }, "move", items.length > 1 ? `move ${items.length} elements` : "move window", a.expectRev ?? null);
          return { ok: true, window: a.id ? findWindow(next, a.id) ?? findWidget(next, a.id) : null, moved: items.length, rev: next.rev };
        },
      },

      resize: {
        description: "Resize a window — or several windows and widgets at once with items:[{id,w,h}].",
        inputSchema: obj({ id: S, w: N, h: N, items: { type: "array", items: { type: "object" } }, expectRev: N }),
        async handler(_ctx, a) {
          const items = Array.isArray(a.items) ? a.items : a.id ? [{ id: a.id, w: a.w, h: a.h }] : [];
          if (!items.length) throw new Error("id or items required");
          const next = mutate((d) => {
            for (const it of items) {
              const el = findWindow(d, it.id) ?? mustWidget(d, it.id);
              if (it.w != null) el.w = Number(it.w);
              if (it.h != null) el.h = Number(it.h);
            }
          }, "resize", items.length > 1 ? `resize ${items.length} elements` : "resize window", a.expectRev ?? null);
          return { ok: true, window: a.id ? findWindow(next, a.id) ?? findWidget(next, a.id) : null, resized: items.length, rev: next.rev };
        },
      },

      focus: {
        description: "Raise a window to the top and unminimize it.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            w.min = false;
            w.z = ++d.zTop;
            d.activeWorkspace = w.ws;
          }, "focus", "focus window");
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      windowSet: {
        description: "Change a window: title, minimized, maximized, workspace, props; back:true sends it behind everything.",
        inputSchema: obj({ id: S, title: S, min: B, max: B, ws: N, props: { type: "object" }, back: B, expectRev: N }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            if (a.title != null) w.title = String(a.title).slice(0, LIMITS.titleLen);
            if (a.min != null) w.min = !!a.min;
            if (a.max != null) w.max = !!a.max;
            if (a.ws != null) {
              if (!d.workspaces.some((x) => x.n === Number(a.ws))) throw new Error(`no such workspace: ${a.ws}`);
              w.ws = Number(a.ws);
            }
            if (a.props) w.props = mergeProps(w.props, a.props);
            if (a.back) {
              // Everything else steps up by one; this window takes the floor.
              const floor = Math.min(...d.windows.map((x) => x.z));
              w.z = Math.max(0, floor - 1);
            }
          }, "windowSet", a.back ? "send to back" : "window", a.expectRev ?? null);
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      arrange: {
        description:
          "Lay out a workspace's windows: grid, cascade, stack, center, master-stack, columns, rows, or " +
          "fullscreen-focus. In tiling mode the tree presets rebuild the tree; in floating mode they " +
          "write geometry from the viewport you pass.",
        inputSchema: obj({
          preset: { type: "string", enum: ["grid", "cascade", "stack", "center", ...TREE_PRESETS, "fullscreen-focus"] },
          ws: N, viewport: { type: "object" }, ratio: N, expectRev: N,
        }, ["preset"]),
        async handler(_ctx, a) {
          const vw = Math.max(320, Number(a.viewport?.w) || 1280);
          const vh = Math.max(240, Number(a.viewport?.h) || 760);
          const next = mutate((d) => {
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            const wins = d.windows.filter((w) => w.ws === ws && !w.min);
            if (!wins.length) return;
            const gap = d.wm.gap;
            if (a.preset === "fullscreen-focus") {
              const top = [...wins].sort((x, y) => y.z - x.z)[0];
              for (const w of wins) w.max = w.id === top.id;
              return;
            }
            if (TREE_PRESETS.includes(a.preset) && a.preset !== "grid" || (a.preset === "grid" && d.wm.mode === "tiling")) {
              const ordered = [...wins].sort((x, y) => y.z - x.z).map((w) => w.id);
              const tree = buildTree(ordered, a.preset, { ratio: a.ratio ?? 0.6 });
              const here = wsOf(d, ws);
              here.layout = normalizeTree(tree, d.windows.filter((w) => w.ws === ws).map((w) => w.id));
              if (d.wm.mode !== "tiling") {
                // Floating: the tree is the recipe, the viewport makes it pixels.
                const boxes = treeBoxes(tree, { x: 0, y: 0, w: vw, h: vh }, gap);
                for (const w of wins) {
                  const b = boxes.get(w.id);
                  if (b) Object.assign(w, b, { max: false });
                }
              }
              return;
            }
            if (a.preset === "grid") {
              const cols = Math.ceil(Math.sqrt(wins.length));
              const rows = Math.ceil(wins.length / cols);
              const cw = Math.floor((vw - gap * (cols + 1)) / cols);
              const ch = Math.floor((vh - gap * (rows + 1)) / rows);
              wins.forEach((w, i) => {
                w.max = false;
                w.x = gap + (i % cols) * (cw + gap);
                w.y = gap + Math.floor(i / cols) * (ch + gap);
                w.w = cw; w.h = ch;
              });
            } else if (a.preset === "cascade") {
              wins.forEach((w, i) => {
                w.max = false;
                w.x = 40 + i * 30; w.y = 40 + i * 26;
                w.w = Math.min(w.w, vw - w.x - 40);
                w.h = Math.min(w.h, vh - w.y - 40);
              });
            } else if (a.preset === "stack") {
              wins.forEach((w) => { w.max = false; w.x = gap; w.y = gap; w.w = vw - gap * 2; w.h = vh - gap * 2; });
            } else {
              wins.forEach((w) => {
                w.max = false;
                w.x = Math.max(gap, Math.round((vw - w.w) / 2));
                w.y = Math.max(gap, Math.round((vh - w.h) / 2));
              });
            }
          }, "arrange", `arrange ${a.preset}`, a.expectRev ?? null);
          const wsN = a.ws != null ? Number(a.ws) : next.activeWorkspace;
          const layout = next.workspaces.find((w) => w.n === wsN)?.layout ?? null;
          return { ok: true, windows: next.windows.filter((w) => w.ws === wsN), layout, rev: next.rev };
        },
      },

      snap: {
        description:
          "Snap a window to a region of the screen: left/right/top/bottom halves, a quarter, full, or centre. " +
          "Pass the viewport you are snapping within (the shell does; an agent can guess).",
        inputSchema: obj({
          id: S,
          region: {
            type: "string",
            enum: ["left", "right", "top", "bottom", "topleft", "topright", "bottomleft", "bottomright", "full", "center"],
          },
          viewport: { type: "object" }, expectRev: N,
        }, ["id", "region"]),
        async handler(_ctx, a) {
          const vw = Math.max(320, Number(a.viewport?.w) || 1280);
          const vh = Math.max(240, Number(a.viewport?.h) || 760);
          const next = mutate((d) => {
            const w = mustWindow(d, a.id);
            const g = d.wm.gap;
            const halfW = Math.floor((vw - g * 3) / 2);
            const halfH = Math.floor((vh - g * 3) / 2);
            const box = {
              left: { x: g, y: g, w: halfW, h: vh - g * 2 },
              right: { x: g * 2 + halfW, y: g, w: halfW, h: vh - g * 2 },
              top: { x: g, y: g, w: vw - g * 2, h: halfH },
              bottom: { x: g, y: g * 2 + halfH, w: vw - g * 2, h: halfH },
              topleft: { x: g, y: g, w: halfW, h: halfH },
              topright: { x: g * 2 + halfW, y: g, w: halfW, h: halfH },
              bottomleft: { x: g, y: g * 2 + halfH, w: halfW, h: halfH },
              bottomright: { x: g * 2 + halfW, y: g * 2 + halfH, w: halfW, h: halfH },
              full: { x: g, y: g, w: vw - g * 2, h: vh - g * 2 },
              center: { x: Math.round((vw - w.w) / 2), y: Math.round((vh - w.h) / 2), w: w.w, h: w.h },
            }[a.region];
            Object.assign(w, box, { min: false, max: false, z: ++d.zTop });
          }, "snap", `snap ${a.region}`, a.expectRev ?? null);
          return { ok: true, window: findWindow(next, a.id), rev: next.rev };
        },
      },

      cycleFocus: {
        description: "Focus the next (or previous) window on this workspace.",
        inputSchema: obj({ direction: { type: "string", enum: ["next", "prev"] } }),
        async handler(_ctx, a) {
          let focused = null;
          const next = mutate((d) => {
            const here = d.windows.filter((w) => w.ws === d.activeWorkspace && !w.min)
              .sort((x, y) => x.z - y.z);
            if (here.length < 2) { focused = here[0] ?? null; return; }
            // The top window is the one in front; "next" means send it behind and
            // raise whatever was underneath, which is what alt-tab does.
            focused = a.direction === "prev" ? here[here.length - 2] : here[0];
            focused.z = ++d.zTop;
          }, "cycleFocus", "cycle windows");
          return { ok: true, window: focused ? findWindow(next, focused.id) : null, rev: next.rev };
        },
      },

      minimizeAll: {
        description: "Minimize every window on a workspace (or restore them all).",
        inputSchema: obj({ ws: N, restore: B }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            for (const w of d.windows) if (w.ws === ws) w.min = !a.restore;
          }, "minimizeAll", a.restore ? "restore all" : "show desktop");
          return { ok: true, rev: next.rev };
        },
      },

      associate: {
        description: "Set (or clear) which app opens a file extension. Pass app:null to clear.",
        inputSchema: obj({ ext: S, app: S }, ["ext"]),
        async handler(_ctx, a) {
          const ext = String(a.ext).toLowerCase().replace(/^\*?\.?/, ".");
          const next = mutate((d) => {
            if (a.app == null || a.app === "") { delete d.shell.associations[ext]; return; }
            if (!builtinApp(a.app) && !d.apps[a.app]) throw new Error(`no such app: ${a.app}`);
            d.shell.associations[ext] = a.app;
          }, "associate", `${ext} → ${a.app ?? "default"}`);
          return { ok: true, associations: next.shell.associations, rev: next.rev };
        },
      },

      // ── widgets ─────────────────────────────────────────────────────────

      widgetList: {
        description: "Widgets placed on the desktop, and the kinds available to place.",
        inputSchema: obj({ ws: N }),
        async handler(_ctx, a) {
          const d = doc();
          return {
            widgets: a.ws != null ? d.widgets.filter((g) => g.ws === Number(a.ws)) : d.widgets,
            kinds: listWidgetKinds(d),
          };
        },
      },

      widgetAdd: {
        description: "Place a widget on the desktop.",
        inputSchema: obj({ kind: S, ws: N, x: N, y: N, w: N, h: N, pin: S, props: { type: "object" } }, ["kind"]),
        async handler(_ctx, a) {
          let widget;
          const next = mutate((d) => {
            const desc = widgetDescriptor(d, a.kind);
            if (!desc) throw new Error(`no such widget kind: ${a.kind}`);
            if (d.widgets.length >= LIMITS.widgets) throw new Error(`widget limit reached (${LIMITS.widgets})`);
            const ws = a.ws != null ? Number(a.ws) : d.activeWorkspace;
            if (!d.workspaces.some((x) => x.n === ws)) throw new Error(`no such workspace: ${ws}`);
            const n = d.widgets.filter((g) => g.ws === ws).length;
            widget = {
              id: rid("g"), kind: a.kind,
              x: a.x ?? 24 + (n % 3) * 26, y: a.y ?? 20 + (n % 4) * 30,
              w: a.w ?? desc.size.w, h: a.h ?? desc.size.h,
              ws, pin: a.pin ?? "none", props: a.props ?? {},
            };
            d.widgets.push(widget);
          }, "widgetAdd", `widget ${a.kind}`);
          return { ok: true, widget: findWidget(next, widget.id) ?? widget, rev: next.rev };
        },
      },

      widgetRemove: {
        description: "Remove a widget from the desktop.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const before = d.widgets.length;
            d.widgets = d.widgets.filter((g) => g.id !== a.id);
            if (d.widgets.length === before) throw new Error(`no such widget: ${a.id}`);
          }, "widgetRemove", "widget removed");
          return { ok: true, rev: next.rev };
        },
      },

      widgetSet: {
        description: "Move, resize, re-home or reconfigure a placed widget.",
        inputSchema: obj({ id: S, x: N, y: N, w: N, h: N, ws: N, pin: S, props: { type: "object" }, expectRev: N }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            const g = mustWidget(d, a.id);
            for (const k of ["x", "y", "w", "h"]) if (a[k] != null) g[k] = Number(a[k]);
            if (a.pin != null) g.pin = a.pin;
            if (a.ws != null) {
              if (!d.workspaces.some((x) => x.n === Number(a.ws))) throw new Error(`no such workspace: ${a.ws}`);
              g.ws = Number(a.ws);
            }
            if (a.props) g.props = mergeProps(g.props, a.props);
          }, "widgetSet", "widget", a.expectRev ?? null);
          return { ok: true, widget: findWidget(next, a.id), rev: next.rev };
        },
      },

      // ── apps: definitions and their source ──────────────────────────────

      appList: {
        description: "Every app this machine can launch — built-in, custom bundle, or URL — and, for apps with a tool face, the tools it currently serves.",
        inputSchema: obj({}),
        async handler() { return { apps: annotatedApps(doc(), kernel) }; },
      },

      appDefine: {
        description:
          "Create or update a custom app. kind='bundle' ships HTML/CSS/JS served into a sandboxed frame; " +
          "kind='url' points at a service (e.g. an exposed port). A new bundle is seeded with a runnable starter.",
        inputSchema: obj({
          id: S, name: S, icon: S, hue: S, description: S,
          kind: { type: "string", enum: ["bundle", "url", "alias"] },
          url: S, target: S, entry: S,
          origin: { type: "string", enum: ["store", "volume"] }, volumePath: S,
          permissions: { type: "array", items: S },
          window: { type: "object" },
          files: { type: "object" },
          starter: { type: ["boolean", "string"], description: "false: no starter; 'tools': a UI + companion server starter" },
          mcp: { type: ["object", "null"], description: "The app's tool face: { name, enabled, entrypoint } or { tools: [{ name, description, inputSchema, proxy: { server, tool, args } }] }. null removes it." },
        }, ["id"]),
        async handler(_ctx, a) {
          if (!isId(a.id)) throw new Error("id must be lowercase letters, digits, - or _");
          if (builtinApp(a.id)) throw new Error(`${a.id} is a built-in app`);
          const wantsTools = a.starter === "tools";
          let seeded = false;
          const next = mutate((d) => {
            const prior = d.apps[a.id];
            if (!prior && Object.keys(d.apps).length >= LIMITS.apps) throw new Error(`app limit reached (${LIMITS.apps})`);
            // The tool face merges rather than replaces, so `{ mcp: { enabled: true } }`
            // flips a switch without restating the tools. null removes it.
            let mcp = a.mcp === null ? undefined : a.mcp ? { ...(prior?.mcp ?? {}), ...a.mcp } : prior?.mcp;
            if (!prior && wantsTools && !mcp) mcp = { entrypoint: "server.js", enabled: true };
            if (mcp) {
              const name = isId(mcp.name) ? mcp.name : a.id;
              if (RESERVED_SERVER_NAMES.has(name)) throw new Error(`${name} is a reserved server name`);
              if (kernel?.isCoreServer?.(name)) throw new Error(`${name} is already a server on this machine`);
              if (Object.values(d.apps).some((x) => x.id !== a.id && x.mcp?.name === name)) throw new Error(`another app already serves as ${name}`);
            }
            const permissions = a.permissions ?? prior?.permissions ?? [];
            // An *update* only overwrites what it names. Spreading the whole
            // argument object would hand `normApp` an unreadable value (a colour
            // that is not one, say) and get the *default* back — quietly
            // replacing a good value with a different one, which is worse than
            // refusing. So a field arriving as junk leaves the prior value alone.
            const named = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
            const app = normApp({
              ...(prior ?? {}), ...named, id: a.id, createdAt: prior?.createdAt, updatedAt: Date.now(),
              mcp, permissions: wantsTools && !prior ? [...new Set([...permissions, `${a.id}.*`])] : permissions,
            });
            if (prior) {
              // Keep what the caller did not (validly) change: normApp's defaults
              // are for a *new* app, not for a field someone typed badly.
              const HUE = /^#[0-9a-f]{3,8}$/i;
              if (a.hue !== undefined && !HUE.test(String(a.hue))) app.hue = prior.hue;
              if (a.icon !== undefined && !String(a.icon).trim()) app.icon = prior.icon;
              if (a.name !== undefined && !String(a.name).trim()) app.name = prior.name;
            }
            if (!app) throw new Error("invalid app definition");
            if (mcp && !app.mcp) throw new Error("the mcp block needs an entrypoint (a .js file in the bundle) or at least one proxy tool");
            if (app.kind === "url" && !app.url) throw new Error("kind='url' needs a http(s) url");
            d.apps[a.id] = app;
            if (app.kind === "alias" && !resolveAlias(d, a.id)) throw new Error(`${a.id} would point at itself, round a loop, or through too many aliases`);
            seeded = !prior && app.kind === "bundle" && app.origin === "store";
          }, "appDefine", `app ${a.id}`);

          const app = next.apps[a.id];
          const written = [];
          if (app.kind === "bundle" && app.origin === "store") {
            if (a.files && typeof a.files === "object") {
              for (const [rel, content] of Object.entries(a.files)) {
                const entry = typeof content === "string" ? { content } : content;
                written.push(writeBundleFile(sandbox, "app", a.id, rel, entry?.content ?? "", { base64: !!entry?.base64 }));
              }
            } else if (seeded && a.starter !== false) {
              written.push(writeBundleFile(sandbox, "app", a.id, app.entry, starterApp({ name: app.name, kind: wantsTools ? "UI + tools app" : "app" })));
              written.push(writeBundleFile(sandbox, "app", a.id, "app.css", starterAppCss()));
              written.push(writeBundleFile(sandbox, "app", a.id, "app.js", wantsTools ? starterAppToolsJs({ id: a.id }) : starterAppJs()));
              if (wantsTools) written.push(writeBundleFile(sandbox, "app", a.id, "server.js", starterServerJs({ id: app.mcp?.name ?? a.id, name: app.name })));
            }
            if (written.length) announce(sandbox.id, "appFiles", { app: a.id });
          }
          const servers = app.mcp ? await syncServers() : null;
          const skipped = servers?.skipped?.find((x) => x.app === a.id) ?? null;
          return {
            ok: true, app: appDescriptor(next, a.id), files: written, rev: next.rev,
            ...(app.mcp ? { server: { name: app.mcp.name, enabled: app.mcp.enabled, live: !!servers?.registered?.includes(app.mcp.name), ...(skipped ? { problem: skipped.reason } : {}) } } : {}),
          };
        },
      },

      appRemove: {
        description: "Remove a custom app (and its source, unless keepFiles).",
        inputSchema: obj({ id: S, keepFiles: B }, ["id"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
            delete d.apps[a.id];
            d.windows = d.windows.filter((w) => w.app !== a.id);
            d.shell.dock.pinned = d.shell.dock.pinned.filter((x) => x !== a.id);
          }, "appRemove", `app ${a.id} removed`);
          await syncServers(); // its server, if any, goes with it — before its files do
          const filesRemoved = a.keepFiles ? false : removeBundle(sandbox, "app", a.id);
          return { ok: true, filesRemoved, rev: next.rev };
        },
      },

      appFiles: {
        description: "List the files behind a custom app.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          return { id: a.id, files: listBundleFiles(sandbox, "app", a.id) };
        },
      },

      appRead: {
        description: "Read one file of a custom app's source.",
        inputSchema: obj({ id: S, path: S, base64: B }, ["id", "path"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          return readBundleFile(sandbox, "app", a.id, a.path, { encoding: a.base64 ? "base64" : "utf8" });
        },
      },

      appWrite: {
        description: "Write one file of a custom app's source. This is how an agent builds UI.",
        inputSchema: obj({ id: S, path: S, content: S, base64: B }, ["id", "path", "content"]),
        async handler(_ctx, a) {
          const d = doc();
          if (!d.apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          if (d.apps[a.id].origin !== "store") throw new Error(`${a.id} is served from the Cell volume — write it with fs.write`);
          const w = writeBundleFile(sandbox, "app", a.id, a.path, a.content, { base64: !!a.base64 });
          mutate((x) => { x.apps[a.id].updatedAt = Date.now(); }, "appWrite", `app ${a.id} · ${w.path}`);
          announce(sandbox.id, "appFiles", { app: a.id, path: w.path });
          // Rewriting the companion's source restarts it: the signature includes updatedAt.
          if (d.apps[a.id].mcp?.entrypoint === w.path) await syncServers();
          return { ok: true, ...w };
        },
      },

      appDelete: {
        description: "Delete one file from a custom app's source.",
        inputSchema: obj({ id: S, path: S }, ["id", "path"]),
        async handler(_ctx, a) {
          if (!doc().apps[a.id]) throw new Error(`no such custom app: ${a.id}`);
          const r = removeBundleFile(sandbox, "app", a.id, a.path);
          announce(sandbox.id, "appFiles", { app: a.id, path: r.path });
          return { ok: true, ...r };
        },
      },

      // ── widget kinds: the same machinery, smaller chrome ────────────────

      widgetDefine: {
        description: "Create or update a custom widget kind (a bundle rendered without window chrome).",
        inputSchema: obj({
          kind: S, name: S, icon: S, description: S, entry: S,
          origin: { type: "string", enum: ["store", "volume"] }, volumePath: S,
          permissions: { type: "array", items: S }, size: { type: "object" }, refreshMs: N,
          files: { type: "object" }, starter: B,
        }, ["kind"]),
        async handler(_ctx, a) {
          if (!isId(a.kind)) throw new Error("kind must be lowercase letters, digits, - or _");
          if (builtinWidget(a.kind)) throw new Error(`${a.kind} is a built-in widget`);
          let seeded = false;
          const next = mutate((d) => {
            const prior = d.widgetKinds[a.kind];
            if (!prior && Object.keys(d.widgetKinds).length >= LIMITS.widgetKinds) {
              throw new Error(`widget-kind limit reached (${LIMITS.widgetKinds})`);
            }
            const wk = normWidgetKind({ ...(prior ?? {}), ...a, kind: a.kind, createdAt: prior?.createdAt, updatedAt: Date.now() });
            if (!wk) throw new Error("invalid widget definition");
            d.widgetKinds[a.kind] = wk;
            seeded = !prior && wk.origin === "store";
          }, "widgetDefine", `widget kind ${a.kind}`);

          const wk = next.widgetKinds[a.kind];
          const written = [];
          if (wk.origin === "store") {
            if (a.files && typeof a.files === "object") {
              for (const [rel, content] of Object.entries(a.files)) {
                const entry = typeof content === "string" ? { content } : content;
                written.push(writeBundleFile(sandbox, "widget", a.kind, rel, entry?.content ?? "", { base64: !!entry?.base64 }));
              }
            } else if (seeded && a.starter !== false) {
              written.push(writeBundleFile(sandbox, "widget", a.kind, wk.entry, starterWidget({ name: wk.name })));
            }
            if (written.length) announce(sandbox.id, "widgetFiles", { kind: a.kind });
          }
          return { ok: true, widget: widgetDescriptor(next, a.kind), files: written, rev: next.rev };
        },
      },

      widgetKindRemove: {
        description: "Remove a custom widget kind, its source, and every placed instance.",
        inputSchema: obj({ kind: S, keepFiles: B }, ["kind"]),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            if (!d.widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
            delete d.widgetKinds[a.kind];
            d.widgets = d.widgets.filter((g) => g.kind !== a.kind);
          }, "widgetKindRemove", `widget kind ${a.kind} removed`);
          const filesRemoved = a.keepFiles ? false : removeBundle(sandbox, "widget", a.kind);
          return { ok: true, filesRemoved, rev: next.rev };
        },
      },

      widgetFiles: {
        description: "List the files behind a custom widget kind.",
        inputSchema: obj({ kind: S }, ["kind"]),
        async handler(_ctx, a) {
          if (!doc().widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          return { kind: a.kind, files: listBundleFiles(sandbox, "widget", a.kind) };
        },
      },

      widgetRead: {
        description: "Read one file of a custom widget's source.",
        inputSchema: obj({ kind: S, path: S, base64: B }, ["kind", "path"]),
        async handler(_ctx, a) {
          if (!doc().widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          return readBundleFile(sandbox, "widget", a.kind, a.path, { encoding: a.base64 ? "base64" : "utf8" });
        },
      },

      widgetWrite: {
        description: "Write one file of a custom widget's source.",
        inputSchema: obj({ kind: S, path: S, content: S, base64: B }, ["kind", "path", "content"]),
        async handler(_ctx, a) {
          const d = doc();
          if (!d.widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          if (d.widgetKinds[a.kind].origin !== "store") throw new Error(`${a.kind} is served from the Cell volume — write it with fs.write`);
          const w = writeBundleFile(sandbox, "widget", a.kind, a.path, a.content, { base64: !!a.base64 });
          mutate((x) => { x.widgetKinds[a.kind].updatedAt = Date.now(); }, "widgetWrite", `widget ${a.kind} · ${w.path}`);
          announce(sandbox.id, "widgetFiles", { kind: a.kind, path: w.path });
          return { ok: true, ...w };
        },
      },

      widgetDelete: {
        description: "Delete one file from a custom widget's source.",
        inputSchema: obj({ kind: S, path: S }, ["kind", "path"]),
        async handler(_ctx, a) {
          if (!doc().widgetKinds[a.kind]) throw new Error(`no such custom widget kind: ${a.kind}`);
          const r = removeBundleFile(sandbox, "widget", a.kind, a.path);
          announce(sandbox.id, "widgetFiles", { kind: a.kind, path: r.path });
          return { ok: true, ...r };
        },
      },

      // ── notifications ───────────────────────────────────────────────────

      notify: {
        description: "Post a notification to the OS notification centre.",
        inputSchema: obj({
          title: S, body: S, app: S,
          kind: { type: "string", enum: ["ok", "warn", "err", "info", "accent"] },
          action: { type: "object" },
        }, ["title"]),
        async handler(_ctx, a) {
          let note;
          const next = mutate((d) => {
            note = {
              id: rid("n"), app: a.app ?? "system", title: a.title,
              body: a.body ?? "", kind: a.kind ?? "info", ts: Date.now(), read: false,
              ...(a.action ? { action: a.action } : {}),
            };
            d.notifications.push(note);
            while (d.notifications.length > LIMITS.notifications) d.notifications.shift();
          }, "notify", "notification");
          return { ok: true, notification: note, unread: next.notifications.filter((n) => !n.read).length };
        },
      },

      notificationsRead: {
        description: "Mark notifications read (all, or one by id).",
        inputSchema: obj({ id: S }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            for (const n of d.notifications) if (!a.id || n.id === a.id) n.read = true;
          }, "notificationsRead", "notifications read");
          return { ok: true, unread: next.notifications.filter((n) => !n.read).length };
        },
      },

      notificationsClear: {
        description: "Empty the notification centre, or dismiss one by id.",
        inputSchema: obj({ id: S }),
        async handler(_ctx, a) {
          const next = mutate((d) => {
            d.notifications = a.id ? d.notifications.filter((n) => n.id !== a.id) : [];
          }, "notificationsClear", a.id ? "notification dismissed" : "notifications cleared");
          return { ok: true, remaining: next.notifications.length, rev: next.rev };
        },
      },

      // ── distros: a whole machine, packaged ──────────────────────────────

      distroList: {
        description: "The gallery: built-in seeds, your tenant's distros, and every public one. q searches name, description and tags.",
        inputSchema: obj({ q: S, scope: { type: "string", enum: ["all", "mine", "public"] } }),
        async handler(ctx, a) {
          const rows = galleryRows(ctx?.principalId, { q: a.q ?? "", publicOnly: a.scope === "public" })
            .filter((d) => a.scope !== "mine" || d.mine);
          return { distros: [...(a.scope === "public" || a.q ? [] : builtinDistroList()), ...rows] };
        },
      },

      distroSet: {
        description: "Change who can see a distro you published: private, tenant or public.",
        inputSchema: obj({ name: S, visibility: { type: "string", enum: ["private", "tenant", "public"] } }, ["name", "visibility"]),
        async handler(_ctx, a) {
          const r = setDistroVisibility(sandbox.tenant_id, a.name, a.visibility);
          if (!r.updated) throw new Error(`no such distro: ${a.name}`);
          return { ok: true, name: a.name, visibility: a.visibility };
        },
      },

      distroPublish: {
        description:
          "Publish this whole machine as a forkable distro: the OS document, every custom app's source (and tools), " +
          "and the Cell's composition (which servers are enabled). visibility: private (you), tenant (default), public (every tenant).",
        inputSchema: obj({
          name: S, description: S, replace: B, tags: { type: "array", items: S },
          visibility: { type: "string", enum: ["private", "tenant", "public"] }, keepNotifications: B, includeManifest: B,
        }, ["name"]),
        async handler(ctx, a) {
          const d = doc();
          const manifest = a.includeManifest === false ? null : loadManifest(sandbox);
          const payload = exportPayload(d, {
            ...collectBundles(d), name: a.name, description: a.description, manifest, tags: a.tags, keepNotifications: !!a.keepNotifications,
          });
          if (a.replace) deleteDistro(sandbox.tenant_id, a.name);
          const created = createDistro(sandbox.tenant_id, {
            name: a.name,
            description: a.description ?? `${d.name} · ${d.windows.length} windows, ${Object.keys(d.apps).length} custom apps`,
            // The row's manifest is a real Sandboxfile shape so POST /api/sandboxes
            // can instantiate the Cell from it; the OS payload carries the desktop.
            manifest: { ...(manifest ? { servers: manifest.servers } : {}), installed: {}, from: "desktop", os: true },
            os: payload,
            visibility: a.visibility ?? "tenant",
            tags: payload.tags,
            preview: previewOf(d),
            publisher: ctx?.principalId ?? null,
          });
          return {
            ok: true, id: created.id, name: created.name, visibility: created.visibility ?? "tenant",
            apps: Object.keys(payload.bundles.apps).length,
            widgets: Object.keys(payload.bundles.widgets).length,
            tools: Object.values(d.apps).filter((x) => x.mcp).length,
            servers: manifest ? Object.keys(manifest.servers).length : 0,
          };
        },
      },

      distroFork: {
        description: "Replace this machine's OS with a distro — built-in by id, or one published by this tenant.",
        inputSchema: obj({ id: S, name: S, keepName: B, applyManifest: B }),
        async handler(ctx, a) {
          const key = a.id ?? a.name;
          if (!key) throw new Error("id or name required");
          const builtin = BUILTIN_DISTROS.find((x) => x.id === key || x.name === key);
          const current = doc();

          if (builtin) {
            const next = saveOs(sandbox, docFromDistroSpec(builtin, {
              name: a.keepName ? current.name : builtin.name,
            }), { label: `fork ${builtin.name}` });
            // A seed's volume-origin app needs its files in the Cell. They are
            // written through fs.write as the caller — audited, and refused if
            // the caller cannot write files, in which case the app simply says so.
            const seeded = [];
            for (const [rel, content] of Object.entries(builtin.seedFiles ?? {})) {
              const r = await kernel?.call({ principalId: ctx?.principalId, heldPatterns: ctx?.heldPatterns ?? [], onBehalfOf: `distro:${builtin.id}`, server: "fs", tool: "write", args: { path: rel, content } });
              if (r?.ok) seeded.push(rel);
            }
            await syncServers();
            return { ok: true, distro: { id: builtin.id, name: builtin.name, builtin: true }, seeded, rev: next.rev };
          }

          const row = getDistroByName(sandbox.tenant_id, key) ?? getDistro(key);
          // Yours, your tenant's, or anyone's if they published it publicly.
          const mine = row && row.tenant_id === sandbox.tenant_id;
          if (!row || !(mine || row.visibility === "public")) throw new Error(`no such distro: ${key}`);
          if (!row.os) throw new Error(`${row.name} is a manifest-only distro and has no OS to fork`);

          // Your own distro is trusted: its companion servers come back enabled.
          const { doc: forked, bundles, manifest } = importPayload(row.os, {
            name: a.keepName ? current.name : row.name,
            distro: { id: row.id, name: row.name, tenant: row.tenant_id, visibility: row.visibility ?? "tenant" },
            trusted: mine,
          });
          for (const [id, files] of Object.entries(bundles.apps ?? {})) importBundle(sandbox, "app", id, files);
          for (const [kind, files] of Object.entries(bundles.widgets ?? {})) importBundle(sandbox, "widget", kind, files);
          const composition = a.applyManifest === false ? null : applyPortableManifest(manifest);
          const next = saveOs(sandbox, forked, { label: `fork ${row.name}` });
          const servers = await syncServers();
          if (!mine) bumpDistroForks(row.id);
          return {
            ok: true,
            distro: { id: row.id, name: row.name, builtin: false, tenant: row.tenant_id, visibility: row.visibility ?? "tenant" },
            apps: Object.keys(bundles.apps ?? {}).length,
            tools: Object.values(next.apps).filter((x) => x.mcp).map((x) => ({ app: x.id, server: x.mcp.name, enabled: x.mcp.enabled })),
            ...(composition ? { composition } : {}),
            ...(servers ? { servers } : {}),
            rev: next.rev,
          };
        },
      },

      // ── backup and restore: the machine, not just its face ────────────────
      //
      // A distro is what you hand to someone else. A backup is what you keep:
      // the same desktop and apps and composition, plus your named checkpoints
      // and a manifest of the volume — names, sizes and hashes, so a restore can
      // say what is missing instead of pretending the bytes came back (T3.4).

      machineExport: {
        description:
          "Back this machine up: the desktop, every custom app's source, the Cell's composition, your named checkpoints, " +
          "and a manifest of the volume (names, sizes, hashes — not contents).",
        inputSchema: obj({ name: S, volume: B }),
        async handler(_ctx, a) {
          const d = doc();
          const base = exportPayload(d, { ...collectBundles(d), name: a.name ?? d.name, manifest: loadManifest(sandbox), keepNotifications: false });
          const checkpoints = (d.checkpoints ?? []).map((c) => ({ ...c, doc: readCheckpoint(sandbox, c.id) })).filter((c) => c.doc);
          const volume = a.volume === false ? null : volumeManifest(kernel?.cell?.root ?? null);
          let tide = null;
          try {
            const ws = await kernel?.call?.({ principalId: null, heldPatterns: ["tide.*"], server: "tide", tool: "listWorkspaces", args: {} });
            const first = ws?.result?.workspaces?.[0];
            if (first) tide = { workspace: typeof first === "string" ? first : first.name, head: first?.head ?? null };
          } catch { /* a machine without Tide is a machine without Tide */ }
          return { payload: machinePayload({ payload: base, checkpoints, volume, tide }) };
        },
      },

      machineRestore: {
        description:
          "Restore a machine backup. With plan: true it changes nothing and reports what it would do — including which volume files " +
          "the manifest expects and this machine no longer has. File contents are never in a backup; Tide moves those.",
        inputSchema: obj({ payload: { type: "object" }, plan: B, applyManifest: B }, ["payload"]),
        async handler(_ctx, a) {
          const size = JSON.stringify(a.payload ?? {}).length;
          if (size > MAX_PAYLOAD_BYTES) throw new Error(`backup too large: ${size} bytes (max ${MAX_PAYLOAD_BYTES})`);
          const { doc: incoming, bundles, manifest } = importPayload(a.payload, {});
          const current = doc();
          const volume = compareVolume(a.payload?.volume?.files ?? [], volumeManifest(kernel?.cell?.root ?? null)?.files ?? []);
          const plan = {
            desktop: structuralDiff(current, incoming),
            apps: Object.keys(bundles.apps ?? {}).length,
            widgets: Object.keys(bundles.widgets ?? {}).length,
            checkpoints: (a.payload?.checkpoints ?? []).length,
            composition: a.applyManifest ? Object.keys(manifest?.servers ?? {}).length : 0,
            volume,
            // Said plainly, because the alternative is someone believing a backup
            // restored files it never carried.
            note: "a backup carries the desktop, the apps and the composition. File contents are not in it: a missing file is missing.",
          };
          if (a.plan) return { plan, applied: false };

          for (const [id, files] of Object.entries(bundles.apps ?? {})) importBundle(sandbox, "app", id, files);
          for (const [kind, files] of Object.entries(bundles.widgets ?? {})) importBundle(sandbox, "widget", kind, files);
          // Checkpoints come back as files plus an index, so the restored machine
          // has its own way back as well.
          const index = [];
          for (const c of a.payload?.checkpoints ?? []) {
            if (!c?.id || !c.doc) continue;
            if (writeCheckpoint(sandbox, c.id, c.doc)) index.push({ id: c.id, name: c.name ?? c.id, rev: c.rev ?? 0, ts: c.ts ?? Date.now() });
          }
          const composition = a.applyManifest ? applyPortableManifest(manifest) : null;
          const next = saveOs(sandbox, { ...incoming, checkpoints: index }, { label: "restore" });
          await syncServers();
          return {
            ok: true, rev: next.rev, applied: true, plan,
            ...(composition ? { composition } : {}),
          };
        },
      },

      distroExport: {
        description: "Export this OS as a portable payload (document + every custom app's source).",
        inputSchema: obj({ name: S, description: S }),
        async handler(_ctx, a) {
          const d = doc();
          return { payload: exportPayload(d, { ...collectBundles(d), name: a.name, description: a.description }) };
        },
      },

      // ── checkpoints: a desktop you meant to come back to ──────────────────
      //
      // History is the last forty revisions, which answers "undo that". A
      // checkpoint answers "take me back to the desktop I liked": a named copy
      // of the whole document, kept outside the pruning window (goal.md T2.4).

      checkpoint: {
        description:
          "Save the desktop as a named state you can come back to, whatever happens to the revision history. " +
          "auto:true marks it as the scheduler's, which keeps it in its own budget so it cannot evict one you named.",
        inputSchema: obj({ name: S, auto: B }, ["name"]),
        async handler(_ctx, a) {
          const name = String(a.name ?? "").trim().slice(0, LIMITS.nameLen);
          if (!name) throw new Error("a checkpoint needs a name");
          const auto = !!a.auto;
          const current = doc();
          const id = rid("cp");
          if (!writeCheckpoint(sandbox, id, current)) throw new Error("could not write the checkpoint");
          const next = mutateOs(sandbox, (d) => {
            d.checkpoints = [...(d.checkpoints ?? []), { id, name, rev: current.rev, ts: Date.now(), ...(auto ? { auto: true } : {}) }];
            const drop = (pick) => {
              const gone = d.checkpoints.find(pick);
              if (!gone) return false;
              d.checkpoints = d.checkpoints.filter((c) => c !== gone);
              // The file goes with the entry, or the disk keeps a state nothing
              // can reach.
              removeCheckpoint(sandbox, gone.id);
              return true;
            };
            // An hourly snapshot has its own, smaller budget: without this, a day
            // of scheduled snapshots would push out the desktop you named on
            // purpose, which is the opposite of what a checkpoint is for.
            while (d.checkpoints.filter((c) => c.auto).length > LIMITS.autoCheckpoints) {
              if (!drop((c) => c.auto)) break;
            }
            // And when the whole shelf is full, the scheduler's oldest goes first.
            while (d.checkpoints.length > LIMITS.checkpoints) {
              if (!drop((c) => c.auto) && !drop(() => true)) break;
            }
          }, { op: "checkpoint", label: `checkpoint: ${name}` });
          return { ok: true, rev: next.rev, checkpoint: next.checkpoints.find((c) => c.id === id) ?? null };
        },
      },

      checkpoints: {
        description: "The named desktop states this machine has kept.",
        inputSchema: obj({}),
        async handler() { return { checkpoints: doc().checkpoints ?? [] }; },
      },

      checkpointRestore: {
        description: "Go back to a named state. The restore is itself a revision, so it can be undone.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const found = (doc().checkpoints ?? []).find((c) => c.id === a.id);
          if (!found) throw new Error(`no such checkpoint: ${a.id}`);
          const next = restoreCheckpoint(sandbox, a.id, { label: `restore "${found.name}"` });
          await syncServers();
          return { ok: true, rev: next.rev, restored: found };
        },
      },

      checkpointRemove: {
        description: "Forget a named state, and delete the copy it kept.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          if (!(doc().checkpoints ?? []).some((c) => c.id === a.id)) throw new Error(`no such checkpoint: ${a.id}`);
          const next = mutateOs(sandbox, (d) => {
            d.checkpoints = (d.checkpoints ?? []).filter((c) => c.id !== a.id);
          }, { op: "checkpointRemove", label: `forget ${a.id}` });
          removeCheckpoint(sandbox, a.id);
          return { ok: true, rev: next.rev };
        },
      },

      checkpointDiff: {
        description: "What changed between a named state and now — or between two named states. Structural: windows, widgets, theme, apps.",
        inputSchema: obj({ id: S, against: S }, ["id"]),
        async handler(_ctx, a) {
          const from = readCheckpoint(sandbox, a.id);
          if (!from) throw new Error(`no such checkpoint: ${a.id}`);
          const to = a.against ? readCheckpoint(sandbox, a.against) : doc();
          if (!to) throw new Error(`no such checkpoint: ${a.against}`);
          return { from: a.id, to: a.against ?? "now", diff: structuralDiff(from, to) };
        },
      },

      // ── the keyboard, remappable ──────────────────────────────────────────

      keyList: {
        description: "Every keyboard action the shell honours, its chord, and what it does. The cheat sheet reads this, so a remap shows up there too.",
        inputSchema: obj({}),
        async handler() {
          const keys = doc().shell.keys ?? {};
          return {
            keys,
            actions: Object.entries(KEY_ACTIONS).map(([action, what]) => ({
              action, what, chord: keys[action] ?? null, default: DEFAULT_KEYS[action] ?? null,
            })),
          };
        },
      },

      keySet: {
        description: "Rebind a keyboard action. A chord is modifiers plus one key: mod+shift+k. Pass chord: null to unbind it, or omit action to restore every default.",
        inputSchema: obj({ action: S, chord: S }),
        async handler(_ctx, a) {
          if (a.action != null && !Object.hasOwn(KEY_ACTIONS, a.action)) {
            throw new Error(`unknown keyboard action: ${a.action} (try one of ${Object.keys(KEY_ACTIONS).join(", ")})`);
          }
          if (a.action != null && a.chord != null && !isChord(a.chord)) {
            throw new Error(`not a chord: ${a.chord} — modifiers (mod, shift, alt) plus one key, like mod+shift+k`);
          }
          // A chord that already belongs to something else is a collision, and
          // silently stealing it would leave the other action dead.
          const keys = doc().shell.keys ?? {};
          if (a.action != null && a.chord) {
            const clash = Object.entries(keys).find(([act, ch]) => ch === a.chord && act !== a.action);
            if (clash) throw new Error(`${a.chord} is already ${clash[0]} — unbind that first`);
          }
          const next = mutateOs(sandbox, (d) => {
            if (a.action == null) { d.shell.keys = { ...DEFAULT_KEYS }; return; }
            d.shell.keys = { ...(d.shell.keys ?? {}) };
            if (a.chord == null) d.shell.keys[a.action] = null;   // unbound, on purpose
            else d.shell.keys[a.action] = a.chord;
          }, { op: "keySet", label: a.action ? `key ${a.action} → ${a.chord ?? "none"}` : "keys reset" });
          return { ok: true, rev: next.rev, keys: next.shell.keys };
        },
      },

      // ── the capability ledger ─────────────────────────────────────────────
      //
      // "An app is a real principal" was true and invisible. This is what makes
      // it visible (goal.md T3.1): what an app asked for, what it was actually
      // granted, what was withheld, which principals it has called as, and every
      // call it has made — from the same audit log everything else lands in.

      appLedger: {
        description: "What a custom app may do and what it has actually done: declared and granted capabilities, what was withheld, and its recent calls from the audit log.",
        inputSchema: obj({ id: S, limit: N }, ["id"]),
        async handler(ctx, a) {
          const d = doc();
          const desc = appDescriptor(d, a.id) ?? widgetDescriptor(d, a.id);
          if (!desc) throw new Error(`no such app: ${a.id}`);
          const held = ctx?.heldPatterns ?? [];
          const declared = desc.permissions ?? [];
          const granted = declared.filter((p) => canDelegate(held, p));
          const withheld = declared.filter((p) => !canDelegate(held, p));

          // An app calls as machine principals minted for it: label `app-<id>-…`.
          const principals = listSandboxAccess(sandbox.id)
            .filter((p) => p.kind === "machine" && String(p.name ?? "").startsWith(`app-${a.id}-`))
            .map((p) => ({ principalId: p.principalId, patterns: p.patterns, since: p.grantedAt, live: p.liveSessions > 0 }));

          const limit = Math.min(Math.max(1, Number(a.limit) || 50), 200);
          const calls = principals
            .flatMap((p) => queryAudit(sandbox.id, { principalId: p.principalId, limit }))
            .sort((x, y) => y.ts - x.ts)
            .slice(0, limit)
            .map((r) => ({ tool: `${r.server}.${r.tool}`, kind: r.result_kind, at: r.ts, error: r.error ?? null }));

          const counts = calls.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] ?? 0) + 1; return acc; }, {});
          return {
            id: a.id,
            kind: desc.kind ?? "bundle",
            suspended: !!desc.suspended,
            declared, granted, withheld,
            principals, calls, counts,
            // Nothing here is a live grant: a suspended app has no session to
            // mint, and revoking a principal takes its token with it.
            note: desc.suspended ? "suspended: no new session will be minted for this app" : null,
          };
        },
      },

      appSuspend: {
        description: "Suspend a custom app: no new capability session is minted for it, and its live tokens are revoked. Restore it with suspended: false.",
        inputSchema: obj({ id: S, suspended: B }, ["id"]),
        async handler(_ctx, a) {
          const d = doc();
          const isWidget = !!d.widgetKinds?.[a.id];
          if (!d.apps?.[a.id] && !isWidget) throw new Error(`no such app: ${a.id}`);
          const suspended = a.suspended !== false;
          const next = mutateOs(sandbox, (draft) => {
            const def = isWidget ? draft.widgetKinds[a.id] : draft.apps[a.id];
            def.suspended = suspended;
            def.updatedAt = Date.now();
          }, { op: "appSuspend", label: `${suspended ? "suspended" : "restored"} ${a.id}` });

          // Suspending is not a promise about the future only: the sessions this
          // app already holds go away, so the next call it makes is refused.
          let revoked = 0;
          if (suspended) {
            for (const p of listSandboxAccess(sandbox.id)) {
              if (p.kind !== "machine" || !String(p.name ?? "").startsWith(`app-${a.id}-`)) continue;
              const r = revokeSandboxAccess(sandbox.id, p.principalId);
              revoked += (r.tokensRevoked ?? 0) + (r.removed ?? 0);
            }
          }
          return { ok: true, rev: next.rev, id: a.id, suspended, revoked };
        },
      },

      // ── proposals: a change you can read before it happens ────────────────
      //
      // "The agent restyled my desktop" is revertible, but reviewable is better.
      // A proposal is a document object holding `desktop.*` calls; applying it
      // runs them through these very tools, as the caller who applied it — so a
      // proposal can never do something its applier could not do by hand.

      propose: {
        description: "Propose desktop changes for review instead of making them. Ops are desktop tool names with their arguments; nothing happens until someone applies it.",
        inputSchema: obj({
          label: S,
          ops: { type: "array", items: { type: "object", properties: { tool: S, args: { type: "object" } }, required: ["tool"] } },
        }, ["ops"]),
        async handler(ctx, a) {
          const ops = (Array.isArray(a.ops) ? a.ops : []).map((op) => ({ tool: String(op?.tool ?? ""), args: op?.args ?? {} }));
          if (!ops.length) throw new Error("a proposal needs at least one op");
          for (const op of ops) {
            const t = self.tools[op.tool];
            if (!t) throw new Error(`unknown tool in proposal: desktop.${op.tool}`);
            if (READ_ONLY_DESKTOP_TOOLS.has(op.tool)) throw new Error(`desktop.${op.tool} changes nothing — a proposal is for changes`);
          }
          const proposal = { id: rid("prop"), label: a.label ?? "proposed change", by: ctx?.principalId ?? "agent", createdAt: Date.now(), ops };
          const next = mutateOs(sandbox, (d) => {
            d.proposals = [...(d.proposals ?? []), proposal].slice(-LIMITS.proposals);
          }, { op: "propose", label: `propose: ${proposal.label}` });
          return { ok: true, rev: next.rev, proposal: next.proposals.at(-1) };
        },
      },

      proposals: {
        description: "Changes waiting for review, with the calls each one would make.",
        inputSchema: obj({}),
        async handler() {
          const d = doc();
          // Each one says which parts of the document it would touch. Not a
          // predicted diff: a call that has not run cannot be diffed, and a
          // prediction that turned out wrong would be worse than none (T2.3).
          return {
            proposals: (d.proposals ?? []).map((p) => ({ ...p, impact: proposalImpact(p) })),
          };
        },
      },

      applyProposal: {
        description: "Apply a proposed change: its ops run in order, as you, and the proposal is dropped. Stops at the first failure and reports what did land.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(ctx, a) {
          const found = (doc().proposals ?? []).find((p) => p.id === a.id);
          if (!found) throw new Error(`no such proposal: ${a.id}`);
          const applied = [];
          let failure = null;
          for (const op of found.ops) {
            // Each op goes back through the Kernel rather than straight to the
            // handler. Calling handlers directly would have made
            // `desktop.applyProposal` a way to run every desktop tool without
            // holding it — the hostile-day test caught exactly that. Through the
            // Kernel, an op is authorized against the *applier's* own grants and
            // audited as its own row, which is also better provenance: the log
            // shows what was actually done, not one opaque "applied".
            const r = await kernel.call({
              principalId: ctx?.principalId ?? null,
              heldPatterns: ctx?.heldPatterns ?? [],
              server: "desktop", tool: op.tool, args: op.args ?? {},
              onBehalfOf: found.by && found.by !== ctx?.principalId ? found.by : null,
            });
            if (r.ok) { applied.push(op.tool); continue; }
            // Partial application is reported, not hidden: the ops that ran are
            // each their own revision, and revert can take them back.
            failure = { tool: op.tool, error: r.error, ...(r.code ? { code: r.code } : {}) };
            break;
          }
          const next = mutateOs(sandbox, (d) => {
            d.proposals = (d.proposals ?? []).filter((p) => p.id !== a.id);
          }, { op: "applyProposal", label: `applied: ${found.label}` });
          await syncServers();
          return { ok: !failure, rev: next.rev, applied, ...(failure ? { failure } : {}) };
        },
      },

      discardProposal: {
        description: "Throw a proposed change away without applying it.",
        inputSchema: obj({ id: S }, ["id"]),
        async handler(_ctx, a) {
          const found = (doc().proposals ?? []).find((p) => p.id === a.id);
          if (!found) throw new Error(`no such proposal: ${a.id}`);
          const next = mutateOs(sandbox, (d) => {
            d.proposals = (d.proposals ?? []).filter((p) => p.id !== a.id);
          }, { op: "discardProposal", label: `discarded: ${found.label}` });
          return { ok: true, rev: next.rev };
        },
      },

      distroImport: {
        description: "Install a portable payload over this machine's OS.",
        inputSchema: obj({ payload: { type: "object" }, name: S, applyManifest: B }, ["payload"]),
        async handler(_ctx, a) {
          // A payload arrives from outside — a file someone was sent, a registry we
          // do not control. Bound it before it becomes disk.
          const size = JSON.stringify(a.payload ?? {}).length;
          if (size > MAX_PAYLOAD_BYTES) {
            throw new Error(`distro payload too large: ${size} bytes (max ${MAX_PAYLOAD_BYTES})`);
          }
          const { doc: imported, bundles, manifest } = importPayload(a.payload, { name: a.name });
          for (const [id, files] of Object.entries(bundles.apps ?? {})) importBundle(sandbox, "app", id, files);
          for (const [kind, files] of Object.entries(bundles.widgets ?? {})) importBundle(sandbox, "widget", kind, files);
          const composition = a.applyManifest ? applyPortableManifest(manifest) : null;
          const next = saveOs(sandbox, imported, { label: "import" });
          await syncServers();
          return {
            ok: true, rev: next.rev, apps: Object.keys(bundles.apps ?? {}).length,
            verified: !!a.payload?.integrity,
            disabledServers: Object.values(next.apps).filter((x) => x.mcp?.entrypoint && !x.mcp.enabled).map((x) => x.id),
            ...(composition ? { composition } : {}),
          };
        },
      },
    },
  };

  return self;
}

/**
 * A manifest of the Cell volume: relative path, size, and a hash of the contents.
 *
 * Bounded on purpose — 5000 files, and no hash for anything over 8 MB — because a
 * backup of the desktop should not become a scan of a node_modules tree. What it
 * is for is answering "is this the machine I saved?", not moving the bytes.
 */
function volumeManifest(root, { maxFiles = 5000, hashUnder = 8 * 1024 * 1024 } = {}) {
  if (!root) return null;
  const files = [];
  let truncated = false;
  const skip = new Set(["node_modules", ".git", ".mcp-packages", ".tide"]);
  const walk = (dir, rel) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (e.isSymbolicLink()) continue;   // a link is not contents
      const abs = path.join(dir, e.name);
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(abs, at); continue; }
      try {
        const st = fs.statSync(abs);
        const entry = { path: at, size: st.size };
        if (st.size <= hashUnder) {
          entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
        }
        files.push(entry);
      } catch { /* unreadable is not in the manifest */ }
    }
  };
  walk(root, "");
  return { files, truncated, skipped: [...skip], at: Date.now() };
}

/** Recursive merge for `desktop.patch`. A null value deletes the key. */
function deepMerge(target, patch) {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
