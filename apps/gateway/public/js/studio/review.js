// review.js — proposal structural diff review and checkpoint snapshot restoration.
//
// Acceptance Criteria C2 & C3:
// - Structural diff review for agent proposals before applying and after applying.
// - Formatted structural diff rendering for checkpoint snapshot comparisons.

import { h, fill } from "../core.js";
import { diffSummary } from "../os/lib/diff.js";

/**
 * Render a structural diff object as a formatted DOM element.
 *
 * @param {object} diff - Structural diff produced by structuralDiff()
 * @returns {HTMLElement} Formatted DOM tree visualizing document modifications
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
