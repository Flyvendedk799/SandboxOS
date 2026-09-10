// Phase 40: the schema, and why it is still v1.
//
// T5.4 of goal.md asked for schema v2 "when, and only when, it is earned". This
// is the answer, written as tests rather than as an opinion.
//
// Everything the document has gained since v1 — the keymap, do-not-disturb,
// proposals, checkpoints, first-run state, an app's suspended flag, the tiling
// tree, "open with", reduced motion, distro lineage — is *additive*, and
// `normalizeDoc` fills each one from the defaults when it is absent. No field
// changed meaning or shape. So the tests below load documents shaped the way
// every earlier wave of this project wrote them and prove two things: what they
// meant still survives, and what they never had arrives at its default.
//
// What a bump *will* need is machinery, and that is the second half: the version
// is read, and a document from a newer build is refused at the boundary where it
// would otherwise be silently cut down to what this build understands.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDoc, defaultDoc, docCompatibility, OS_DOC_VERSION, LIMITS,
} from "../packages/os/src/schema.js";
import { DEFAULT_KEYS } from "../packages/os/src/keys.js";
import { exportPayload, importPayload, DISTRO_PAYLOAD_VERSION } from "../packages/os/src/distro.js";
import { appDescriptor } from "../packages/os/src/apps.js";

// ── documents as earlier waves wrote them ───────────────────────────────────
//
// Each fixture is the document *as it was*: the fields that existed then, and
// nothing that did not. They are layered oldest first, so a failure says which
// era stopped loading.

/** The earliest shape: windows, widgets, one workspace, a theme, a dock. */
const earliest = {
  version: 1,
  id: "os_earliest",
  name: "early-machine",
  rev: 118,
  theme: { base: "midnight", tokens: { accent: "#ff8f5e" }, custom: {} },
  wm: { mode: "floating", gap: 12, snap: true, gridSize: 8 },
  shell: {
    menubar: { visible: true, showClock: true, showStatus: true },
    dock: { visible: true, position: "bottom", size: 42, autohide: false, pinned: ["files", "terminal"] },
    spotlight: { enabled: true },
  },
  workspaces: [{ id: "ws_1", n: 1, name: "Main", wallpaper: null }],
  activeWorkspace: 1,
  zTop: 22,
  windows: [
    { id: "w_early1", app: "files", title: "Files", x: 40, y: 60, w: 460, h: 300, z: 12, ws: 1, min: false, max: false, props: { path: "src" } },
    { id: "w_early2", app: "terminal", title: "Terminal", x: 520, y: 60, w: 520, h: 300, z: 13, ws: 1, min: false, max: false, props: {} },
  ],
  widgets: [{ id: "g_early1", kind: "clock", x: 24, y: 24, w: 220, h: 120, ws: 1, pin: "none", props: {} }],
  apps: {},
  widgetKinds: {},
  notifications: [],
};

/** Custom apps and widgets, a wallpaper, an animation preset. */
const withCustomApps = {
  ...earliest,
  id: "os_apps",
  animation: { preset: "genie", custom: {} },
  workspaces: [{ id: "ws_1", n: 1, name: "Main", wallpaper: "mesh" }],
  apps: {
    notebook: {
      id: "notebook", name: "Notebook", icon: "notes", hue: "#7be3d0", kind: "bundle",
      permissions: ["fs.read", "fs.write"], window: { w: 520, h: 360 }, entry: "index.html",
    },
  },
  widgetKinds: { ticker: { kind: "ticker", name: "Ticker", icon: "notes", size: { w: 220, h: 140 }, refreshMs: 5000 } },
  windows: [
    ...earliest.windows,
    { id: "w_apps1", app: "notebook", title: "Notebook", x: 100, y: 400, w: 520, h: 360, z: 14, ws: 1, min: false, max: false, props: {} },
  ],
};

/** Tiling, a second workspace, "open with", a companion server, lineage. */
const withTilingAndTools = {
  ...withCustomApps,
  id: "os_tiling",
  distro: { id: "dst_x", name: "someone-elses-box", forkedAt: 1_700_000_000_000 },
  wm: { mode: "tiling", gap: 10, snap: true, gridSize: 8 },
  shell: {
    ...withCustomApps.shell,
    wallpaperFit: "contain",
    associations: { ".md": "notes", ".png": "media" },
  },
  workspaces: [
    { id: "ws_1", n: 1, name: "Main", wallpaper: "mesh", layout: { dir: "row", ratio: 0.6, a: { leaf: "w_early1" }, b: { leaf: "w_early2" } } },
    { id: "ws_2", n: 2, name: "Build", wallpaper: null, layout: null },
  ],
  apps: {
    ...withCustomApps.apps,
    tooled: {
      id: "tooled", name: "Tooled", kind: "bundle", permissions: ["tooled.*"],
      mcp: { name: "tooled", entrypoint: "server.js", enabled: true },
    },
  },
};

const eras = [
  ["the earliest desktops", earliest],
  ["custom apps and widgets", withCustomApps],
  ["tiling, tools and lineage", withTilingAndTools],
];

test("every era of this document still loads, and still means what it meant", () => {
  for (const [era, fixture] of eras) {
    const d = normalizeDoc(fixture);

    // What it meant.
    assert.equal(d.name, "early-machine", `${era}: the name`);
    assert.equal(d.rev, 118, `${era}: the revision counter`);
    assert.equal(d.theme.base, "midnight", `${era}: the theme`);
    assert.equal(d.theme.tokens.accent, "#ff8f5e", `${era}: and its override`);
    assert.deepEqual(d.shell.dock.pinned, ["files", "terminal"], `${era}: the dock`);
    assert.equal(d.windows.length, fixture.windows.length, `${era}: every window`);
    assert.equal(d.windows[0].props.path, "src", `${era}: with its props`);
    assert.equal(d.widgets.length, 1, `${era}: the widget`);
    assert.equal(Object.keys(d.apps).length, Object.keys(fixture.apps).length, `${era}: every custom app`);
    assert.equal(Object.keys(d.widgetKinds).length, Object.keys(fixture.widgetKinds).length, `${era}: every custom widget`);

    // What it never had.
    assert.deepEqual(d.shell.keys, { ...DEFAULT_KEYS }, `${era}: the keymap arrives at its default`);
    assert.deepEqual(d.shell.notifications, { enabled: true, dnd: false, allow: ["agents"] }, `${era}: so does attention`);
    assert.deepEqual(d.proposals, [], `${era}: no proposals`);
    assert.deepEqual(d.checkpoints, [], `${era}: no checkpoints`);
    assert.deepEqual(d.setup, { done: false, seed: null, at: null }, `${era}: and it has not been set up`);
    assert.equal(d.version, OS_DOC_VERSION, `${era}: it comes out at the current version`);
    assert.ok(d.shell.associations[".md"], `${era}: "open with" has defaults`);
  }
});

test("what each era added is still carried, not flattened", () => {
  const apps = normalizeDoc(withCustomApps);
  assert.equal(apps.animation.preset, "genie", "the animation preset");
  assert.equal(apps.animation.reducedMotion, "auto", "and reduced motion defaults to honouring the viewer");
  assert.equal(apps.workspaces[0].wallpaper, "mesh", "the wallpaper");
  assert.equal(apps.apps.notebook.hue, "#7be3d0", "an app's accent");
  assert.deepEqual(apps.apps.notebook.permissions, ["fs.read", "fs.write"], "and what it asked for");
  // A flag the document omits when it is false — kept out to keep the document
  // small — reads as false through the descriptor every renderer uses.
  assert.equal(apps.apps.notebook.suspended, undefined, "the document does not carry a false flag");
  assert.equal(appDescriptor(apps, "notebook").suspended, false, "and the descriptor says it is not suspended");
  assert.equal(apps.widgetKinds.ticker.refreshMs, 5000, "a custom widget's clock");

  const tiling = normalizeDoc(withTilingAndTools);
  assert.equal(tiling.wm.mode, "tiling", "the layout mode");
  assert.ok(tiling.workspaces[0].layout, "the tiling tree survives");
  assert.equal(tiling.workspaces.length, 2, "and both workspaces");
  assert.equal(tiling.shell.wallpaperFit, "contain", "how the wallpaper is fitted");
  assert.equal(tiling.apps.tooled.mcp.enabled, true, "a companion server stays enabled in your own document");
  assert.equal(tiling.distro.name, "someone-elses-box", "and the machine still remembers what it grew from");
});

test("a document with no version at all is read as v1", () => {
  const { version: _drop, ...noVersion } = earliest;
  const compat = docCompatibility(noVersion);
  assert.deepEqual(compat, { version: 1, current: OS_DOC_VERSION, newer: false, older: false });
  const d = normalizeDoc(noVersion);
  assert.equal(d.windows.length, 2, "and it loads");
});

test("nothing branches on the version yet, because nothing needs to", () => {
  // The honest statement of T5.4: a v2 would say nothing a reader does not
  // already know from the fields being present. If that stops being true, this
  // test is the one to delete.
  assert.equal(OS_DOC_VERSION, 1);
  // Ids and timestamps are minted per call, so compare the shape rather than
  // the two clock readings either side of a millisecond boundary.
  const settle = (d) => JSON.parse(JSON.stringify(d, (k, v) => (
    ["id", "updatedAt", "createdAt", "ts", "at"].includes(k) ? 0 : v)));
  const asV1 = normalizeDoc({ ...withTilingAndTools, version: 1 });
  const noneAtAll = normalizeDoc({ ...withTilingAndTools, version: undefined });
  assert.deepEqual(settle(asV1), settle(noneAtAll),
    "the same document loads the same whether or not it says which version it is");
});

// ── a machine from the future ───────────────────────────────────────────────

test("a document from a newer build is named as newer", () => {
  const future = docCompatibility({ version: OS_DOC_VERSION + 1 });
  assert.equal(future.newer, true);
  assert.equal(future.version, OS_DOC_VERSION + 1);
  assert.equal(docCompatibility({ version: "nonsense" }).version, 1, "an unreadable version is v1, not a crash");
  assert.equal(docCompatibility(null).version, 1);
});

test("importing a newer document is refused rather than silently truncated", () => {
  const payload = exportPayload(normalizeDoc(withTilingAndTools), { name: "from-the-future" });
  payload.os.version = OS_DOC_VERSION + 1;
  assert.throws(() => importPayload(payload, { name: "mine" }), (e) => {
    assert.equal(e.code, "newer_document");
    assert.match(e.message, /newer SandboxOS \(document v2, this build reads v1\)/);
    assert.match(e.message, /would drop whatever it gained/);
    return true;
  });
});

test("a newer payload envelope is refused for the same reason", () => {
  const payload = exportPayload(normalizeDoc(earliest), { name: "future-envelope" });
  payload.payloadVersion = DISTRO_PAYLOAD_VERSION + 1;
  assert.throws(() => importPayload(payload, { name: "mine" }), (e) => {
    assert.equal(e.code, "newer_payload");
    assert.match(e.message, /update this build to fork it/);
    return true;
  });
});

test("a payload from this build, and from an older one, both import", () => {
  const current = exportPayload(normalizeDoc(withTilingAndTools), { name: "current" });
  const now = importPayload(current, { name: "mine" });
  assert.equal(now.doc.windows.length, 3);
  assert.equal(now.doc.rev, 0, "a forked machine starts at rev 0");
  assert.equal(now.doc.name, "mine");

  // An older publisher: v1 envelope, and no integrity block at all (they came
  // before hashes). Older is not newer, so it loads.
  const older = { payloadVersion: 1, name: "older", os: { ...earliest }, bundles: { apps: {}, widgets: {} } };
  const then = importPayload(older, { name: "mine-too" });
  assert.equal(then.doc.windows.length, 2);
  assert.deepEqual(then.doc.setup, { done: false, seed: null, at: null }, "and gains today's defaults");
});

// ── and the ceilings still hold on an old document ──────────────────────────

test("an old document cannot smuggle past today's limits", () => {
  const huge = {
    ...earliest,
    windows: Array.from({ length: LIMITS.windows + 40 }, (_, i) => ({
      id: `w_${i}`, app: "files", title: `w${i}`, x: 0, y: 0, w: 300, h: 200, z: i, ws: 1, min: false, max: false, props: {},
    })),
  };
  const d = normalizeDoc(huge);
  assert.equal(d.windows.length, LIMITS.windows, "the ceiling applies however old the document is");
  const defaults = defaultDoc("fresh");
  assert.equal(defaults.version, OS_DOC_VERSION);
});
