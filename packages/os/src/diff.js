// diff.js — structural diffs of the OS document and proposal review utilities.
//
// Comparing two OS documents structurally rather than as raw JSON text gives
// human-meaningful answers: "2 windows moved, theme switched to aurora" rather
// than a wall of JSON diffs. Used across the history browser, proposal reviews,
// and checkpoint restorations.

/**
 * Compare two OS documents structurally.
 * Returns added, removed, changed counts for entity collections,
 * and lists of modified keys for configuration sections.
 */
export function structuralDiff(from, to) {
  const f = from ?? {};
  const t = to ?? {};

  const ids = (list) => new Map((list ?? []).map((x) => [x.id ?? x.n, x]));
  const diffList = (a, b, keys) => {
    const A = ids(a), B = ids(b);
    let added = 0, removed = 0, changed = 0;
    const addedItems = [];
    const removedItems = [];
    const changedItems = [];

    for (const [id, item] of B) {
      if (!A.has(id)) {
        added += 1;
        addedItems.push(item);
      }
    }
    for (const [id, x] of A) {
      if (!B.has(id)) {
        removed += 1;
        removedItems.push(x);
        continue;
      }
      const y = B.get(id);
      const diffKeys = keys.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
      if (diffKeys.length > 0) {
        changed += 1;
        changedItems.push({ id, before: x, after: y, keys: diffKeys });
      }
    }
    return { added, removed, changed, addedItems, removedItems, changedItems };
  };

  const keysChanged = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
    .filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));

  return {
    windows: diffList(f.windows, t.windows, ["app", "title", "x", "y", "w", "h", "ws", "min", "max", "props"]),
    widgets: diffList(f.widgets, t.widgets, ["kind", "x", "y", "w", "h", "ws", "pin", "props"]),
    workspaces: diffList(f.workspaces, t.workspaces, ["name", "wallpaper", "layout"]),
    theme: keysChanged({ base: f.theme?.base, ...f.theme?.tokens }, { base: t.theme?.base, ...t.theme?.tokens }),
    animation: f.animation?.preset !== t.animation?.preset ? [t.animation?.preset].filter(Boolean) : [],
    wm: keysChanged(f.wm, t.wm),
    shell: keysChanged(f.shell, t.shell),
    apps: keysChanged(f.apps, t.apps),
    widgetKinds: keysChanged(f.widgetKinds, t.widgetKinds),
    name: f.name !== t.name,
  };
}

/**
 * Summarize a structural diff in concise words: "3 windows · theme · dock".
 */
export function diffSummary(diff) {
  if (!diff) return "identical";
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
  return parts.length ? parts.join(" · ") : "identical";
}

/**
 * Sections of the document modified in the given structural diff.
 */
export function changedSections(diff) {
  if (!diff) return [];
  const hasChanges = (d) => !!d && ((d.added ?? 0) > 0 || (d.removed ?? 0) > 0 || (d.changed ?? 0) > 0);
  const out = [];
  if (hasChanges(diff.windows)) out.push("windows");
  if (hasChanges(diff.widgets)) out.push("widgets");
  if (hasChanges(diff.workspaces)) out.push("workspaces");
  if (diff.theme?.length) out.push("theme");
  if (diff.animation?.length) out.push("animation");
  if (diff.wm?.length) out.push("layout");
  if (diff.shell?.length) out.push("shell");
  if (diff.apps?.length) out.push("apps");
  if (diff.widgetKinds?.length) out.push("widgetKinds");
  if (diff.name) out.push("name");
  return out;
}

/**
 * Line diff between two text documents (LCS algorithm).
 */
export function lineDiff(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i], line: j + 1 }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "-", text: a[i], line: null }); i += 1; }
    else { out.push({ kind: "+", text: b[j], line: j + 1 }); j += 1; }
  }
  while (i < n) { out.push({ kind: "-", text: a[i], line: null }); i += 1; }
  while (j < m) { out.push({ kind: "+", text: b[j], line: j + 1 }); j += 1; }
  return out;
}

export const SYMBOL_RULES = [
  [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "fn"],
  [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "fn"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "const"],
  [/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/, "method"],
  [/^\s*(#[\w-]+|\.[\w-]+(?:[\s,][^{]*)?)\s*\{/, "css"],
  [/<[a-z][\w-]*[^>]*\sid=["']([\w-]+)["']/i, "id"],
];

/**
 * Extract symbol definitions (functions, classes, variables, CSS selectors, HTML IDs) from source.
 */
export function symbolsIn(text, langOrPath = "js") {
  const lang = langOrPath?.endsWith(".html") ? "html"
    : langOrPath?.endsWith(".css") ? "css"
    : langOrPath?.endsWith(".js") || langOrPath?.endsWith(".mjs") || langOrPath?.endsWith(".ts") ? "js"
    : langOrPath ?? "js";

  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const [re, kind] of SYMBOL_RULES) {
      if ((kind === "css" && lang !== "css") || (kind === "id" && lang !== "html")) continue;
      const m = re.exec(line);
      if (!m) continue;
      out.push({ name: kind === "id" && !m[1].startsWith("#") ? `#${m[1].trim()}` : m[1].trim(), kind, line: i + 1 });
      break;
    }
  }
  return out;
}

