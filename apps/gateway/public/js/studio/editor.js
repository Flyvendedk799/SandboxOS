// editor.js — Studio custom app bundle code editor.
//
// Fulfills Acceptance Criterion C2:
// - Extends createCodePane from os/code.js with Studio review workflow
// - Agent proposal review with impact prediction and per-op argument inspection
// - Measured structural diff review from desktop.history after applying proposals
// - Proposal notification badge counter on editor rail

import { h, fill, icon, toast, toastError } from "../core.js";
import { os, call, onOs } from "../os/client.js";
import { createCodePane } from "../os/code.js";
import { proposalImpact } from "../os/lib/proposals.js";
import { renderStructuralDiff } from "./review.js";

export function createStudioCodeEditor({ onTargetChange } = {}) {
  const pane = createCodePane({ onTargetChange });
  pane.el.classList.add("stx-code-editor");

  const proposalBadge = h("span.proposal-badge", { hidden: true }, "0");
  const proposalBtn = h("button.rail-btn.sm.rel", {
    "data-action": "proposals",
    title: "Review agent proposals and structural diffs",
    onclick: () => toggleProposals(),
  }, icon("play", 13), proposalBadge);

  const head = pane.el.querySelector(".code-head");
  if (head) {
    const consoleBtn = head.querySelector('button[title*="console"]');
    if (consoleBtn) {
      consoleBtn.before(proposalBtn);
    } else {
      head.appendChild(proposalBtn);
    }
  }

  const proposalsEl = h("div.code-proposals", { hidden: true });
  const codeBody = pane.el.querySelector(".code-body");
  if (codeBody) {
    codeBody.before(proposalsEl);
  } else {
    pane.el.appendChild(proposalsEl);
  }

  let lastApplied = null;
  const expandedDetails = new Set(); // proposalId
  const busy = new Set(); // proposalId with an apply/discard in flight

  function updateProposalBadge() {
    const count = os.doc?.proposals?.length ?? 0;
    proposalBadge.hidden = count === 0;
    proposalBadge.textContent = String(count);
  }

  function toggleProposals(want) {
    const show = want ?? proposalsEl.hidden;
    proposalsEl.hidden = !show;
    if (!show) return;
    const findEl = pane.el.querySelector(".code-find");
    const symbolsEl = pane.el.querySelector(".code-symbols");
    const diffEl = pane.el.querySelector(".code-diff");
    if (findEl) findEl.hidden = true;
    if (symbolsEl) symbolsEl.hidden = true;
    if (diffEl) diffEl.hidden = true;
    paintProposals();
  }

  function renderAppliedDiff() {
    if (!lastApplied) return null;
    return h("div.proposal.applied.stx-applied-diff", null,
      h("div.hd", null,
        h("b", lastApplied.label),
        h("span.dim", `applied · r${lastApplied.rev}`)),
      h("div.touches", { style: { padding: "6px 10px 0", fontSize: "11px", fontWeight: "600", color: "var(--stx-text-2)" } },
        h("span", "Structural diff (measured from history):")),
      h("div.diff-box", { style: { margin: "6px 10px 8px" } },
        renderStructuralDiff(lastApplied.diff)),
      h("div.act", null,
        h("button.app-btn", {
          onclick: () => {
            lastApplied = null;
            paintProposals();
          },
        }, "Dismiss")),
    );
  }

  function paintProposals() {
    const list = os.doc?.proposals ?? [];
    updateProposalBadge();
    if (!list.length && !lastApplied) {
      fill(proposalsEl,
        h("div.row", null, icon("play", 13), h("b", "Agent Proposals Review"), h("span.spacer"),
          h("button.rail-btn.sm", { title: "Close", onclick: () => toggleProposals(false) }, icon("x", 12))),
        h("div.dim.ops-none", { style: { padding: "10px" } }, "No agent proposals queued. Changes proposed by the assistant or agent wait here for structural diff review."));
      return;
    }

    fill(proposalsEl,
      h("div.row", null,
        icon("play", 13),
        h("b", `Agent Proposals (${list.length})`),
        h("span.dim", "Structural diff review"),
        h("span.spacer"),
        h("button.rail-btn.sm", { title: "Close", onclick: () => toggleProposals(false) }, icon("x", 12))),
      h("div.proposals-body", null,
        ...list.map((p) => {
          const impact = proposalImpact(p);
          const showDetails = expandedDetails.has(p.id);
          return h("div.proposal.stx-editor-proposal", null,
            h("div.hd", null,
              h("b", p.label || "Agent Proposal"),
              h("span.dim", `${p.ops?.length ?? 0} op${p.ops?.length === 1 ? "" : "s"}`)),
            h("div.touches", null,
              h("span.dim", "would change:"),
              ...impact.sections.map((s) => h("span.chip-tag", s)),
              ...(impact.unknown ? [h("span.chip-tag.warn", `unknown: ${impact.unknown.join(", ")}`)] : [])),
            h("div.ops", null, ...(p.ops ?? []).map((op) => {
              const argsPretty = typeof op.args === "object" && op.args ? JSON.stringify(op.args, null, 2) : String(op.args ?? "");
              const argsSummary = typeof op.args === "object" && op.args ? JSON.stringify(op.args) : String(op.args ?? "");
              return h("div.op-item", { style: { padding: "3px 0", borderBottom: showDetails ? "1px solid var(--stx-line)" : "none" } },
                h("div.op", null,
                  h("code", `desktop.${op.tool}`),
                  !showDetails ? h("span.dim", argsSummary.slice(0, 60)) : null),
                showDetails ? h("pre.op-args-detail", {
                  style: {
                    margin: "4px 0 2px",
                    padding: "6px 8px",
                    background: "var(--stx-bg-1)",
                    borderRadius: "6px",
                    fontSize: "10px",
                    fontFamily: "var(--mono)",
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    color: "var(--stx-text-2)",
                  },
                }, argsPretty) : null);
            })),
            h("div.act", null,
              h("button.app-btn.primary", {
                onclick: async () => {
                  if (busy.has(p.id)) return;
                  busy.add(p.id);
                  try {
                    const r = await call("applyProposal", { id: p.id });
                    // Each op was its own revision, so what this proposal did
                    // starts that many revisions back from where it ended —
                    // the server's count, not a client rev that may lag.
                    const applied = r.applied?.length ?? 0;
                    let diff = null;
                    try {
                      const hist = await call("history", { rev: Math.max(0, r.rev - (applied + 1)) });
                      diff = hist?.diff ?? null;
                    } catch { /* history lookup */ }
                    lastApplied = {
                      label: p.label || "Agent Proposal",
                      rev: r.rev,
                      diff,
                    };
                    expandedDetails.delete(p.id);
                    // A proposal can stop part-way: the kernel reports that
                    // rather than throwing, and it is not a success.
                    if (r.failure) toast("Partly applied", { body: `${r.failure.tool}: ${r.failure.error}`, kind: "err", timeout: 5000 });
                    else toast("Applied proposal", { body: `${applied} ops applied`, kind: "ok" });
                    paintProposals();
                  } catch (e) { toastError("Could not apply", e); }
                  finally { busy.delete(p.id); }
                },
              }, "Apply"),
              h("button.app-btn", {
                onclick: async () => {
                  if (busy.has(p.id)) return;
                  busy.add(p.id);
                  try {
                    await call("discardProposal", { id: p.id });
                    expandedDetails.delete(p.id);
                    toast("Discarded proposal", { kind: "ok" });
                    paintProposals();
                  } catch (e) { toastError("Could not discard", e); }
                  finally { busy.delete(p.id); }
                },
              }, "Discard"),
              h("button.app-btn.ghost", {
                onclick: () => {
                  if (expandedDetails.has(p.id)) expandedDetails.delete(p.id);
                  else expandedDetails.add(p.id);
                  paintProposals();
                },
              }, showDetails ? "Hide details" : "Review details")),
          );
        }),
        ...(lastApplied ? [renderAppliedDiff()] : []),
      ));
  }

  pane.el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !proposalsEl.hidden) {
      e.preventDefault();
      toggleProposals(false);
    }
  });

  const offOs = onOs(() => {
    updateProposalBadge();
    if (!proposalsEl.hidden) paintProposals();
  });
  updateProposalBadge();

  const origDestroy = pane.destroy;
  pane.destroy = () => {
    offOs?.();
    origDestroy?.();
  };

  return Object.assign(pane, {
    toggleProposals,
    paintProposals,
    updateProposalBadge,
    get proposals() { return os.doc?.proposals ?? []; },
  });
}
