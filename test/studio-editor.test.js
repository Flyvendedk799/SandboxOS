// test/studio-editor.test.js — Tests for Studio App Builder: Presets, Scaled Stage, Structural Diff, and Editor helpers.

import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { proposalImpact } from "../packages/os/src/proposals.js";
import { diffSummary } from "../packages/os/src/diff.js";

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

test("formatStageBadge accurately distinguishes device presets and formats doc state", () => {
  const doc = { wm: { mode: "floating" }, activeWorkspace: 1, rev: 42 };

  // Desktop
  const desktopBadge = formatStageBadge({ stageMode: "design", device: "desktop", scale: 0.75, doc });
  assert.ok(desktopBadge.includes("design"));
  assert.ok(desktopBadge.includes("1440×900"), "desktop badge shows 1440×900");
  assert.ok(desktopBadge.includes("75%"));
  assert.ok(desktopBadge.includes("floating"));
  assert.ok(desktopBadge.includes("r42"));

  // Tablet
  const tabletBadge = formatStageBadge({ stageMode: "design", device: "tablet", scale: 0.8, doc });
  assert.ok(tabletBadge.includes("1024×768"), "tablet badge shows 1024×768");
  assert.ok(!tabletBadge.includes("1440×900"), "tablet badge must not show desktop dimensions");

  // Phone
  const phoneBadge = formatStageBadge({ stageMode: "preview", device: "phone", scale: 1, doc });
  assert.ok(phoneBadge.includes("preview"));
  assert.ok(phoneBadge.includes("375×667"), "phone badge shows 375×667");
  assert.ok(!phoneBadge.includes("1440×900"), "phone badge must not show desktop dimensions");

  // Fit
  const fitBadge = formatStageBadge({ stageMode: "design", device: "fit", scale: 1, doc });
  assert.ok(fitBadge.includes("fit"), "fit badge shows fit");
  assert.ok(!fitBadge.includes("1440×900"), "fit badge must not show desktop dimensions");

  // All distinct presets produce distinct badge strings
  assert.notEqual(desktopBadge, tabletBadge, "desktop and tablet badges must differ");
  assert.notEqual(tabletBadge, phoneBadge, "tablet and phone badges must differ");
  assert.notEqual(phoneBadge, fitBadge, "phone and fit badges must differ");
});

// ── C2 & C3: Structural Diff Summary & Formatting ────────────────────────────

test("diffSummary formats kernel structural diffs into concise human summaries", () => {
  assert.equal(diffSummary(null), "identical to now");
  assert.equal(diffSummary({}), "identical to now");

  const diff = {
    windows: { added: 1, removed: 1, changed: 1 },
    widgets: { added: 2, removed: 0, changed: 0 },
    workspaces: { added: 0, removed: 0, changed: 1 },
    theme: ["base", "accent"],
    animation: ["natural"],
    wm: ["mode"],
    shell: ["dock"],
    apps: ["my-app"],
    widgetKinds: ["clock"],
    name: "New OS",
  };

  const summary = diffSummary(diff);
  assert.ok(summary.includes("3 windows"));
  assert.ok(summary.includes("2 widgets"));
  assert.ok(summary.includes("1 workspace"));
  assert.ok(summary.includes("theme (base, accent)"));
  assert.ok(summary.includes("motion"));
  assert.ok(summary.includes("layout (mode)"));
  assert.ok(summary.includes("shell (dock)"));
  assert.ok(summary.includes("apps (my-app)"));
  assert.ok(summary.includes("widget kinds (clock)"));
  assert.ok(summary.includes("name"));
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
