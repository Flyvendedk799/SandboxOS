// review.js — proposal structural diff review and checkpoint snapshot restoration.
//
// Acceptance Criteria C2 & C3:
// - Structural diff review for agent proposals before applying and after applying.
// - Checkpoint snapshot creation and one-click restoration to previous states.

import { h, fill, icon, dialog, confirmDialog, toast, toastError } from "../core.js";
import { os, call, loadOs, onOs } from "../os/client.js";
import { proposalImpact, diffSummary } from "/static/js/os/lib/proposals.js";

/**
 * Render a structural diff object as a formatted DOM element.
 */
export function renderStructuralDiff(diff) {
  if (!diff) return h("div.diff-box.empty", "No structural changes");
  const host = h("div.stx-diff-viewer");

  const diffRow = (label, value, extra = null) => h("div.diff-row", null,
    h("span.k", label),
    h("span.v", value),
    extra ? h("span.dim", { style: { marginLeft: "6px" } }, extra) : null,
  );

  const formatList = (d) => {
    if (!d) return "0";
    const parts = [];
    if (d.added) parts.push(`+${d.added}`);
    if (d.removed) parts.push(`−${d.removed}`);
    if (d.changed) parts.push(`~${d.changed}`);
    return parts.length ? parts.join(" ") : "0";
  };

  const sections = [
    { key: "windows", label: "Windows", val: formatList(diff.windows) },
    { key: "widgets", label: "Widgets", val: formatList(diff.widgets) },
    { key: "workspaces", label: "Workspaces", val: formatList(diff.workspaces) },
    { key: "theme", label: "Theme", val: diff.theme?.length ? diff.theme.join(", ") : "—" },
    { key: "animation", label: "Motion", val: diff.animation?.length ? diff.animation.join(", ") : "—" },
    { key: "wm", label: "Layout", val: diff.wm?.length ? diff.wm.join(", ") : "—" },
    { key: "shell", label: "Shell", val: diff.shell?.length ? diff.shell.join(", ") : "—" },
    { key: "apps", label: "Apps", val: diff.apps?.length ? diff.apps.join(", ") : "—" },
    { key: "widgetKinds", label: "Widget Kinds", val: diff.widgetKinds?.length ? diff.widgetKinds.join(", ") : "—" },
  ];

  fill(host,
    ...sections
      .filter((s) => s.val !== "0" && s.val !== "—")
      .map((s) => diffRow(s.label, s.val)),
    h("div.dim", { style: { fontSize: "10px", marginTop: "4px" } },
      diffSummary(diff)),
  );

  return host;
}

/**
 * Create the Review Workflow component combining proposal review and checkpoint restoration.
 */
export function createReviewWorkflow({ onApplied } = {}) {
  const el = h("div.stx-review-workflow");
  const proposalsSection = h("div.stx-proposals-section");
  const checkpointsSection = h("div.stx-checkpoints-section");

  let lastApplied = null;
  let expandedDiffs = new Set(); // proposalId -> boolean

  // ── Proposals Review ────────────────────────────────────────────────────────

  function renderProposals() {
    const list = os.doc?.proposals ?? [];
    if (!list.length && !lastApplied) {
      fill(proposalsSection,
        h("div.section-label", "Agent Proposals"),
        h("div.dim.ops-none", { style: { padding: "8px 10px", fontSize: "11px" } },
          "No pending agent proposals. Changes from the build agent will appear here for review."));
      return;
    }

    fill(proposalsSection,
      h("div.section-label", "Agent Proposals"),
      ...list.map((p) => {
        const impact = proposalImpact(p);
        const isOpen = expandedDiffs.has(p.id);
        const diffHost = h("div.diff-box", { hidden: !isOpen });

        return h("div.proposal.stx-proposal-card", null,
          h("div.hd", null,
            h("b", p.label || "Proposed change"),
            h("span.dim", `${p.ops?.length ?? 0} operation${p.ops?.length === 1 ? "" : "s"}`)),
          h("div.touches", null,
            h("span.dim", "would change:"),
            ...impact.sections.map((sec) => h("span.chip-tag", sec)),
            ...(impact.unknown ? [h("span.chip-tag.warn", `unknown: ${impact.unknown.join(", ")}`)] : [])),
          h("div.ops", null, ...(p.ops ?? []).map((op) => h("div.op", null,
            h("code", `desktop.${op.tool}`),
            h("span.dim", typeof op.args === "object" ? JSON.stringify(op.args).slice(0, 70) : String(op.args))))),
          h("div.act", null,
            h("button.app-btn.primary", { onclick: () => apply(p) }, "Apply"),
            h("button.app-btn", { onclick: () => discard(p) }, "Discard"),
            h("button.app-btn.ghost", {
              onclick: () => {
                if (expandedDiffs.has(p.id)) expandedDiffs.delete(p.id);
                else expandedDiffs.add(p.id);
                renderProposals();
              },
            }, isOpen ? "Hide review" : "Review diff")),
          diffHost,
        );
      }),
      ...(lastApplied ? [renderLastApplied()] : []),
    );
  }

  function renderLastApplied() {
    return h("div.proposal.applied", null,
      h("div.hd", null,
        h("b", lastApplied.label),
        h("span.dim", `applied · r${lastApplied.rev}`)),
      h("div.act", null,
        h("button.app-btn", { onclick: showAppliedDiff }, "What changed"),
        h("button.app-btn", { onclick: () => { lastApplied = null; renderProposals(); } }, "Dismiss")),
    );
  }

  async function apply(p) {
    try {
      const r = await call("applyProposal", { id: p.id });
      lastApplied = { label: p.label, rev: r.rev, ops: (r.applied?.length ?? 0) + 1 };
      expandedDiffs.delete(p.id);
      await loadOs();
      if (r.failure) toast("Partly applied", { body: `${r.failure.tool}: ${r.failure.error}`, kind: "err", timeout: 5000 });
      else toast("Applied proposal", { body: `${r.applied?.length ?? 0} change(s) applied to OS`, kind: "ok", timeout: 2200 });
      onApplied?.(lastApplied);
      render();
    } catch (e) {
      toastError("Could not apply proposal", e);
    }
  }

  async function discard(p) {
    try {
      await call("discardProposal", { id: p.id });
      expandedDiffs.delete(p.id);
      await loadOs();
      toast("Proposal discarded", { kind: "ok" });
      render();
    } catch (e) {
      toastError("Could not discard proposal", e);
    }
  }

  async function showAppliedDiff() {
    if (!lastApplied) return;
    try {
      const r = await call("history", { rev: Math.max(0, lastApplied.rev - lastApplied.ops) });
      const d = r.diff ?? {};
      const summary = diffSummary(d);
      toast(lastApplied.label, { body: summary, timeout: 6000 });
    } catch (e) {
      toastError("Could not inspect applied diff", e);
    }
  }

  // ── Checkpoint Restoration ──────────────────────────────────────────────────

  async function renderCheckpoints() {
    try {
      const r = await call("checkpoints", {});
      const list = r.checkpoints ?? [];
      const openDiffs = new Set();

      const paintList = () => {
        fill(checkpointsSection,
          h("div.stx-section-head", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
            h("div.section-label", { style: { margin: "0" } }, "Checkpoints & Snapshots"),
            h("button.ghost.sm", { onclick: createCheckpointPrompt }, "+ New snapshot")),
          ...(list.length ? list.map((c) => {
            const diffBox = h("div.diff-box", { hidden: !openDiffs.has(c.id) });
            return h("div.hist-item.stx-checkpoint-item", null,
              h("div.layer-line", null,
                h("button.layer-row", {
                  title: `Restore snapshot "${c.name}"`,
                  onclick: () => restoreCheckpoint(c),
                }, icon("history", 14),
                  h("span.nm", c.name),
                  h("span.sub", `r${c.rev}${c.ts ? ` · ${new Date(c.ts).toLocaleDateString()}` : ""}`)),
                h("button.diff-toggle", {
                  title: "Compare snapshot against current document",
                  onclick: async () => {
                    if (openDiffs.has(c.id)) {
                      openDiffs.delete(c.id);
                      diffBox.hidden = true;
                    } else {
                      openDiffs.add(c.id);
                      diffBox.hidden = false;
                      try {
                        const d = await call("checkpointDiff", { id: c.id });
                        fill(diffBox, renderStructuralDiff(d.diff));
                      } catch (err) {
                        fill(diffBox, h("div.dim", err.message));
                      }
                    }
                  },
                }, openDiffs.has(c.id) ? "hide" : "diff")),
              diffBox,
            );
          }) : [h("div.dim.ops-none", { style: { padding: "8px 10px", fontSize: "11px" } }, "No snapshots yet. Create a named snapshot to preserve desktop state.")]),
        );
      };

      paintList();
    } catch {
      fill(checkpointsSection,
        h("div.section-label", "Checkpoints & Snapshots"),
        h("div.dim", "Checkpoints unavailable"));
    }
  }

  async function createCheckpointPrompt() {
    const got = await dialog({
      title: "Create checkpoint snapshot",
      fields: [{ name: "name", label: "Snapshot name", placeholder: "e.g. Before redesign", required: true }],
      confirmLabel: "Snapshot",
    });
    if (!got?.name) return;
    try {
      await call("checkpoint", { name: got.name.trim() });
      toast(`Created snapshot “${got.name}”`, { kind: "ok" });
      renderCheckpoints();
    } catch (e) {
      toastError("Could not create checkpoint", e);
    }
  }

  async function restoreCheckpoint(c) {
    let diff = null;
    try {
      const d = await call("checkpointDiff", { id: c.id });
      diff = d.diff;
    } catch { /* fine */ }

    const summary = diff ? diffSummary(diff) : "";
    const confirmed = await confirmDialog(
      `Restore snapshot “${c.name}”?`,
      `${summary ? `Would change: ${summary}. ` : ""}Restoring is recorded as a new revision, preserving rollback safety.`,
      { confirmLabel: "Restore snapshot" },
    );
    if (!confirmed) return;

    try {
      await call("checkpointRestore", { id: c.id });
      await loadOs();
      toast(`Restored “${c.name}”`, { kind: "ok" });
      render();
    } catch (e) {
      toastError("Could not restore checkpoint", e);
    }
  }

  function render() {
    renderProposals();
    renderCheckpoints();
  }

  fill(el, proposalsSection, checkpointsSection);
  render();

  const off = onOs((kind) => {
    if (kind === "doc" || kind === "local") render();
  });

  return {
    el,
    render,
    destroy() { off(); },
    get lastApplied() { return lastApplied; },
  };
}
