// diff.js — structural diff summary utilities.
//
// Summarizes structural diffs of the OS document into concise human words:
// "3 windows · theme · dock" rather than a wall of JSON diffs.
// Used across the history browser, proposal reviews, and checkpoint restorations.

/**
 * Summarize a structural diff in concise words: "3 windows · theme · dock".
 */
export function diffSummary(diff) {
  if (!diff) return "identical to now";
  const parts = [];
  const list = (name, d) => {
    const n = (d?.added ?? 0) + (d?.removed ?? 0) + (d?.changed ?? 0);
    if (n) parts.push(`${n} ${name}${n > 1 ? "s" : ""}`);
  };
  list("window", diff.windows);
  list("widget", diff.widgets);
  list("workspace", diff.workspaces);
  if (diff.theme?.length) parts.push(`theme (${diff.theme.join(", ")})`);
  if (diff.animation?.length) parts.push("motion");
  if (diff.wm?.length) parts.push(`layout (${diff.wm.join(", ")})`);
  if (diff.shell?.length) parts.push(`shell (${diff.shell.join(", ")})`);
  if (diff.apps?.length) parts.push(`apps (${diff.apps.join(", ")})`);
  if (diff.widgetKinds?.length) parts.push(`widget kinds (${diff.widgetKinds.join(", ")})`);
  if (diff.name) parts.push("name");
  return parts.length ? parts.join(" · ") : "identical to now";
}
