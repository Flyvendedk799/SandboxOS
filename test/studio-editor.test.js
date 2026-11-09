// test/studio-editor.test.js — Tests for Studio App Builder: Presets, Scaled Stage, Structural Diff, and Editor helpers.

import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { proposalImpact } from "../packages/os/src/proposals.js";

import {
  structuralDiff,
  diffSummary,
  changedSections,
  lineDiff,
  symbolsIn,
} from "../packages/os/src/diff.js";

import {
  DEVICES,
  deviceOf,
  computeStageLayout,
  formatStageBadge,
} from "../apps/gateway/public/js/studio/presets.js";

// ── C1: Viewport Presets & Live Scaled Stage Layout ──────────────────────────

test("DEVICES contains contract viewport presets", () => {
  const ids = DEVICES.map((d) => d.id);
  assert.ok(ids.includes("desktop"), "desktop preset exists");
  assert.ok(ids.includes("tablet"), "tablet preset exists");
  assert.ok(ids.includes("phone"), "phone preset exists");
  assert.ok(ids.includes("fit"), "fit preset exists");

  const desktop = deviceOf("desktop");
  assert.equal(desktop.w, 1440);
  assert.equal(desktop.h, 900);

  const tablet = deviceOf("tablet");
  assert.equal(tablet.w, 1024);
  assert.equal(tablet.h, 768);

  const phone = deviceOf("phone");
  assert.equal(phone.w, 375);
  assert.equal(phone.h, 667);

  const fit = deviceOf("fit");
  assert.equal(fit.w, null);
  assert.equal(fit.h, null);
});

test("deviceOf falls back gracefully to desktop for unknown presets", () => {
  const d = deviceOf("unknown-device");
  assert.equal(d.id, "desktop");
  assert.equal(d.w, 1440);
});

test("computeStageLayout scales down for pane smaller than device without collapsing layout", () => {
  const desktop = deviceOf("desktop"); // 1440x900
  // Suppose pane is 800x600, pad is 28 (avail: 744x544)
  const layout = computeStageLayout({
    paneWidth: 800,
    paneHeight: 600,
    device: desktop,
    pad: 28,
  });

  assert.equal(layout.staged, true);
  assert.equal(layout.width, 1440);
  assert.equal(layout.height, 900);
  assert.ok(layout.scale < 1, "scale should be reduced to fit pane");
  // scale = min(744/1440, 544/900) = min(0.51666, 0.60444) = 0.51666
  assert.ok(layout.scale > 0.5 && layout.scale < 0.6);
  assert.equal(layout.transform, `translate(-50%, -50%) scale(${layout.scale})`);
});

test("computeStageLayout caps scale at 1.0 when pane is larger than device", () => {
  const phone = deviceOf("phone"); // 375x667
  const layout = computeStageLayout({
    paneWidth: 1920,
    paneHeight: 1080,
    device: phone,
    pad: 28,
  });

  assert.equal(layout.staged, true);
  assert.equal(layout.scale, 1, "should not scale up above 100%");
  assert.equal(layout.transform, "translate(-50%, -50%) scale(1)");
});

test("computeStageLayout handles fit preset", () => {
  const fit = deviceOf("fit");
  const layout = computeStageLayout({
    paneWidth: 1000,
    paneHeight: 700,
    device: fit,
    pad: 28,
  });

  assert.equal(layout.staged, false);
  assert.equal(layout.scale, 1);
  assert.equal(layout.transform, "");
});

test("formatStageBadge formats device scale and doc info", () => {
  const doc = { wm: { mode: "floating" }, activeWorkspace: 1, rev: 42 };
  const badge = formatStageBadge({
    stageMode: "design",
    device: "desktop",
    scale: 0.75,
    doc,
  });
  assert.ok(badge.includes("design"));
  assert.ok(badge.includes("1440×900"));
  assert.ok(badge.includes("75%"));
  assert.ok(badge.includes("floating"));
  assert.ok(badge.includes("r42"));
});

// ── C2 & C3: Structural Document Diffing ──────────────────────────────────────

test("structuralDiff accurately tracks added, removed, and modified elements", () => {
  const before = {
    windows: [
      { id: "w1", app: "notes", title: "My Note", x: 100, y: 100, w: 400, h: 300, ws: 1 },
      { id: "w2", app: "terminal", title: "Terminal", x: 200, y: 200, w: 500, h: 400, ws: 1 },
    ],
    widgets: [
      { id: "g1", kind: "clock", x: 10, y: 10, w: 100, h: 50, ws: 1, pin: "none" },
    ],
    workspaces: [
      { n: 1, name: "Main", wallpaper: "default" },
    ],
    theme: { base: "sand", tokens: { accent: "#ff8800" } },
    animation: { preset: "natural" },
    wm: { mode: "floating" },
    shell: { dock: "bottom" },
    apps: { "custom-app": { name: "Custom App" } },
    widgetKinds: { "custom-widget": { name: "Custom Widget" } },
    name: "Initial OS",
  };

  const after = {
    windows: [
      { id: "w1", app: "notes", title: "Updated Note", x: 120, y: 100, w: 400, h: 300, ws: 1 }, // changed title & x
      // w2 removed
      { id: "w3", app: "browser", title: "Web", x: 50, y: 50, w: 800, h: 600, ws: 1 }, // added
    ],
    widgets: [
      { id: "g1", kind: "clock", x: 10, y: 10, w: 100, h: 50, ws: 1, pin: "none" }, // unchanged
      { id: "g2", kind: "weather", x: 120, y: 10, w: 100, h: 50, ws: 1, pin: "none" }, // added
    ],
    workspaces: [
      { n: 1, name: "Main", wallpaper: "ocean" }, // changed wallpaper
      { n: 2, name: "Dev", wallpaper: "dark" }, // added
    ],
    theme: { base: "sand", tokens: { accent: "#00aaff" } }, // changed accent
    animation: { preset: "snappy" }, // changed animation
    wm: { mode: "tiling" }, // changed wm
    shell: { dock: "left" }, // changed shell
    apps: { "custom-app": { name: "Custom App" }, "new-app": { name: "New" } },
    widgetKinds: { "custom-widget": { name: "Custom Widget" } },
    name: "Redesigned OS",
  };

  const diff = structuralDiff(before, after);

  // Windows: 1 added, 1 removed, 1 changed
  assert.equal(diff.windows.added, 1);
  assert.equal(diff.windows.removed, 1);
  assert.equal(diff.windows.changed, 1);
  assert.equal(diff.windows.changedItems[0].id, "w1");
  assert.deepEqual(diff.windows.changedItems[0].keys.sort(), ["title", "x"].sort());

  // Widgets: 1 added, 0 removed, 0 changed
  assert.equal(diff.widgets.added, 1);
  assert.equal(diff.widgets.removed, 0);
  assert.equal(diff.widgets.changed, 0);

  // Workspaces: 1 added, 0 removed, 1 changed
  assert.equal(diff.workspaces.added, 1);
  assert.equal(diff.workspaces.changed, 1);

  // Theme & Animation & Layout & Shell
  assert.ok(diff.theme.includes("accent"));
  assert.deepEqual(diff.animation, ["snappy"]);
  assert.ok(diff.wm.includes("mode"));
  assert.ok(diff.shell.includes("dock"));
  assert.ok(diff.apps.includes("new-app"));
  assert.equal(diff.name, true);

  // diffSummary produces clear description
  const summary = diffSummary(diff);
  assert.ok(summary.includes("3 windows"));
  assert.ok(summary.includes("1 widget"));
  assert.ok(summary.includes("2 workspaces"));
  assert.ok(summary.includes("theme"));
  assert.ok(summary.includes("motion"));
  assert.ok(summary.includes("layout"));
  assert.ok(summary.includes("shell"));
  assert.ok(summary.includes("name"));

  // changedSections produces list of touched section names
  const sections = changedSections(diff);
  assert.ok(sections.includes("windows"));
  assert.ok(sections.includes("widgets"));
  assert.ok(sections.includes("workspaces"));
  assert.ok(sections.includes("theme"));
  assert.ok(sections.includes("animation"));
  assert.ok(sections.includes("layout"));
  assert.ok(sections.includes("shell"));
  assert.ok(sections.includes("apps"));
});

// ── C2: Editor Symbol Jumping & Line Diffs ─────────────────────────────────────

test("symbolsIn extracts functions, classes, and IDs from source", () => {
  const jsCode = `
export function renderDashboard() {
  const x = 1;
}

class WidgetManager {
  init() {}
}

const calculateTotal = (a, b) => a + b;
`;

  const symbols = symbolsIn(jsCode, "app.js");
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("renderDashboard"));
  assert.ok(names.includes("WidgetManager"));
  assert.ok(names.includes("calculateTotal"));

  const htmlCode = `
<div id="main-header">
  <button id="submit-button">Submit</button>
</div>
`;
  const htmlSymbols = symbolsIn(htmlCode, "index.html");
  const htmlNames = htmlSymbols.map((s) => s.name);
  assert.ok(htmlNames.includes("#main-header"));
  assert.ok(htmlNames.includes("#submit-button"));
});

test("lineDiff computes line additions, removals, and unchanged lines", () => {
  const before = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
  const after = "const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b);";

  const diff = lineDiff(before, after);
  assert.ok(Array.isArray(diff));

  const kinds = diff.map((d) => d.kind);
  assert.ok(kinds.includes(" "));
  assert.ok(kinds.includes("-"));
  assert.ok(kinds.includes("+"));

  // Find added line
  const added = diff.filter((d) => d.kind === "+").map((d) => d.text);
  assert.ok(added.includes("const b = 3;"));
  assert.ok(added.includes("const c = 4;"));

  // Find removed line
  const removed = diff.filter((d) => d.kind === "-").map((d) => d.text);
  assert.ok(removed.includes("const b = 2;"));
});

// ── C2 & C3: Proposal Review Flow & Measured Structural Diffs ─────────────────

test("proposal review flow: impact prediction, op argument inspection, and measured history diff", async () => {
  openDb();
  const { owner, sandbox } = ensureSeed("local");
  const held = grantsFor(owner.id, sandbox.id);
  const kernel = await getKernel(sandbox);
  const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  const ok = async (server, tool, args) => {
    const r = await call(server, tool, args);
    assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
    return r.result;
  };

  try {
    await ok("desktop", "reset", {});

    // Propose changes: theme change and adding a clock widget
    const makeProposal = await ok("desktop", "propose", {
      label: "Studio Theme & Clock",
      ops: [
        { tool: "themeSet", args: { theme: "aurora" } },
        { tool: "widgetAdd", args: { kind: "clock" } },
      ],
    });
    assert.ok(makeProposal.proposal?.id, "proposal created");

    // Retrieve pending proposals (as studio/editor.js does in paintProposals)
    const { proposals } = await ok("desktop", "proposals", {});
    const p = proposals.find((x) => x.id === makeProposal.proposal.id);
    assert.ok(p, "proposal in list");

    // 1. Before apply: check impact calculation and op details
    const impact = proposalImpact(p);
    assert.deepEqual(impact.sections.sort(), ["theme", "widgets"].sort());
    assert.equal(p.ops.length, 2);
    assert.equal(p.ops[0].tool, "themeSet");
    assert.deepEqual(p.ops[0].args, { theme: "aurora" });
    assert.equal(p.ops[1].tool, "widgetAdd");
    assert.deepEqual(p.ops[1].args, { kind: "clock" });

    // 2. Track revision before apply (as studio/editor.js does)
    const beforeState = await ok("desktop", "state", {});
    const beforeRev = beforeState.doc.rev;

    // 3. Apply proposal
    const applied = await ok("desktop", "applyProposal", { id: p.id });
    assert.ok(applied.ok, "applied successfully");
    assert.deepEqual(applied.applied, ["themeSet", "widgetAdd"]);

    // 4. Query desktop.history from beforeRev to measure exact structural diff
    const historyRes = await ok("desktop", "history", { rev: Math.max(0, beforeRev) });
    assert.ok(historyRes.diff, "history provides structural diff");
    assert.ok(historyRes.diff.theme?.includes("base") || historyRes.diff.theme?.length);
    assert.equal(historyRes.diff.widgets?.added, 1);

    const summary = diffSummary(historyRes.diff);
    assert.ok(summary.includes("theme") || summary.includes("widget"));
  } finally {
    _resetKernels();
    closeDb();
  }
});

// ── C3: Checkpoint Snapshot Creation, Comparison & Restoration ────────────────

test("checkpoint workflow: creation, structural diffing, and rollback restoration", async () => {
  openDb();
  const { owner, sandbox } = ensureSeed("local");
  const held = grantsFor(owner.id, sandbox.id);
  const kernel = await getKernel(sandbox);
  const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  const ok = async (server, tool, args) => {
    const r = await call(server, tool, args);
    assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
    return r.result;
  };

  try {
    await ok("desktop", "reset", {});
    const initialDoc = (await ok("desktop", "state", {})).doc;

    // 1. Create a named checkpoint snapshot
    const cp = await ok("desktop", "checkpoint", { name: "baseline-snapshot" });
    assert.ok(cp.checkpoint?.id, "checkpoint created");

    // 2. List checkpoints
    const { checkpoints } = await ok("desktop", "checkpoints", {});
    const saved = checkpoints.find((c) => c.name === "baseline-snapshot");
    assert.ok(saved, "checkpoint found in list");

    // 3. Mutate desktop document
    await ok("desktop", "themeSet", { theme: "aurora" });
    await ok("desktop", "widgetAdd", { kind: "clock" });
    const mutatedDoc = (await ok("desktop", "state", {})).doc;
    assert.notEqual(mutatedDoc.theme.base, initialDoc.theme.base);
    assert.equal(mutatedDoc.widgets.length, initialDoc.widgets.length + 1);

    // 4. Compare snapshot against current doc via checkpointDiff
    const diffRes = await ok("desktop", "checkpointDiff", { id: saved.id });
    assert.ok(diffRes.diff, "checkpointDiff returns structural diff");
    assert.ok(diffRes.diff.widgets?.added === 1 || diffRes.diff.widgets?.removed === 1 || diffRes.diff.theme);

    // 5. Restore checkpoint
    const restored = await ok("desktop", "checkpointRestore", { id: saved.id });
    assert.ok(restored.ok, "checkpoint restored");

    const finalDoc = (await ok("desktop", "state", {})).doc;
    assert.equal(finalDoc.theme.base, initialDoc.theme.base, "theme restored to snapshot baseline");
    assert.equal(finalDoc.widgets.length, initialDoc.widgets.length, "widget list restored to snapshot baseline");
    assert.ok(finalDoc.rev > mutatedDoc.rev, "restoring is recorded as a new forward revision");
  } finally {
    _resetKernels();
    closeDb();
  }
});
