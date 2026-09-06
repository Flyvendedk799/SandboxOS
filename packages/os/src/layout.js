// layout.js — the tiling tree, and the arithmetic that turns it into boxes.
//
// A tiled workspace is a binary tree: a split node divides its box between two
// children along an axis at a ratio; a leaf is a window. The tree is *semantic*
// — it says "Terminal takes the left 60%, the other two stack on the right" and
// nothing about pixels. Pixels are a client concern: this module is served to
// the browser as well as imported by the Kernel, so the shell, the `desktop`
// server and a future TUI all compute the same boxes from the same tree.
//
// No Node imports here on purpose. It has to run in both places unchanged.

export const MAX_TREE_DEPTH = 12;
export const TREE_PRESETS = ["master-stack", "columns", "rows", "grid"];
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

const clampRatio = (r) => {
  const n = Number(r);
  return Number.isFinite(n) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, n)) : 0.5;
};

export const leaf = (id) => ({ type: "leaf", id });
export const split = (dir, a, b, ratio = 0.5) => ({ type: "split", dir: dir === "col" ? "col" : "row", ratio: clampRatio(ratio), a, b });

/** Every window id in the tree, left to right. */
export function treeLeaves(tree, out = []) {
  if (!tree) return out;
  if (tree.type === "leaf") { out.push(tree.id); return out; }
  treeLeaves(tree.a, out);
  treeLeaves(tree.b, out);
  return out;
}

/**
 * Take anything and return a well-formed tree over `keep` (a list of ids), or
 * null when nothing survives. Dead leaves are dropped, single-child splits
 * collapse, ratios are clamped, depth is bounded. Never throws.
 */
export function normalizeTree(tree, keep, depth = 0) {
  if (!tree || typeof tree !== "object" || depth > MAX_TREE_DEPTH) return null;
  const allowed = keep instanceof Set ? keep : new Set(keep ?? []);
  if (tree.type === "leaf") return typeof tree.id === "string" && allowed.has(tree.id) ? leaf(tree.id) : null;
  if (tree.type !== "split") return null;
  const a = normalizeTree(tree.a, allowed, depth + 1);
  const b = normalizeTree(tree.b, allowed, depth + 1);
  if (a && b) return split(tree.dir, a, b, tree.ratio);
  return a ?? b;
}

/** The tree with only these ids left in it (what a renderer does with hidden windows). */
export function pruneTree(tree, keep) {
  return normalizeTree(tree, keep);
}

/** Remove duplicate leaves, keeping the first occurrence. */
function dedupe(tree, seen = new Set()) {
  if (!tree) return null;
  if (tree.type === "leaf") { if (seen.has(tree.id)) return null; seen.add(tree.id); return tree; }
  const a = dedupe(tree.a, seen);
  const b = dedupe(tree.b, seen);
  if (a && b) return { ...tree, a, b };
  return a ?? b;
}

function depthOf(tree, id, d = 0) {
  if (!tree) return -1;
  if (tree.type === "leaf") return tree.id === id ? d : -1;
  const a = depthOf(tree.a, id, d + 1);
  return a >= 0 ? a : depthOf(tree.b, id, d + 1);
}

/** Split the shallowest (roughly: largest) leaf to make room for a new window. */
export function insertLeaf(tree, id) {
  if (!tree) return leaf(id);
  if (treeLeaves(tree).includes(id)) return tree;
  const leaves = treeLeaves(tree);
  let target = leaves[0], best = Infinity;
  for (const l of leaves) { const d = depthOf(tree, l); if (d < best) { best = d; target = l; } }
  const rewrite = (node, d) => {
    if (node.type === "leaf") {
      if (node.id !== target) return node;
      if (d >= MAX_TREE_DEPTH) return node;
      return split(d % 2 === 0 ? "row" : "col", node, leaf(id));
    }
    return { ...node, a: rewrite(node.a, d + 1), b: rewrite(node.b, d + 1) };
  };
  return rewrite(tree, 0);
}

export function removeLeaf(tree, id) {
  return normalizeTree(tree, treeLeaves(tree).filter((x) => x !== id));
}

/** Make the tree hold exactly these ids: prune what is gone, add what is new. */
export function reconcileTree(tree, ids) {
  let t = dedupe(normalizeTree(tree, ids));
  for (const id of ids) t = insertLeaf(t, id);
  return t;
}

/** A fresh tree over `ids` in one of the named shapes. */
export function buildTree(ids, preset = "grid", { ratio = 0.6 } = {}) {
  const list = [...new Set(ids)];
  if (!list.length) return null;
  if (list.length === 1) return leaf(list[0]);
  const stack = (arr, dir) => arr.length === 1 ? leaf(arr[0]) : split(dir, leaf(arr[0]), stack(arr.slice(1), dir), 1 / arr.length);
  if (preset === "master-stack") return split("row", leaf(list[0]), stack(list.slice(1), "col"), ratio);
  if (preset === "columns") return stack(list, "row");
  if (preset === "rows") return stack(list, "col");
  // grid: balanced, alternating axes
  const balanced = (arr, dir) => {
    if (arr.length === 1) return leaf(arr[0]);
    const mid = Math.ceil(arr.length / 2);
    const next = dir === "row" ? "col" : "row";
    return split(dir, balanced(arr.slice(0, mid), next), balanced(arr.slice(mid), next), mid / arr.length);
  };
  return balanced(list, "row");
}

/** Path ("a.b.a") → node, or null. "" is the root. */
export function nodeAt(tree, path) {
  let node = tree;
  for (const step of String(path ?? "").split(".").filter(Boolean)) {
    if (!node || node.type !== "split" || (step !== "a" && step !== "b")) return null;
    node = node[step];
  }
  return node ?? null;
}

function pathTo(tree, id, path = "") {
  if (!tree) return null;
  if (tree.type === "leaf") return tree.id === id ? path : null;
  return pathTo(tree.a, id, path ? `${path}.a` : "a") ?? pathTo(tree.b, id, path ? `${path}.b` : "b");
}

/** The path of the split that separates two leaves (their lowest common split),
 *  or, with one id, the split immediately containing it. */
export function splitFor(tree, id, id2 = null) {
  const p1 = pathTo(tree, id);
  if (p1 == null) return null;
  if (id2 == null) { const i = p1.lastIndexOf("."); return i === -1 ? (p1 ? "" : null) : p1.slice(0, i); }
  const p2 = pathTo(tree, id2);
  if (p2 == null) return null;
  const a = p1.split("."), b = p2.split(".");
  const common = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i += 1) common.push(a[i]);
  return common.join(".");
}

function mapPath(tree, path, fn) {
  const steps = String(path ?? "").split(".").filter(Boolean);
  const walk = (node, i) => {
    if (i === steps.length) return fn(node);
    if (!node || node.type !== "split") return node;
    return { ...node, [steps[i]]: walk(node[steps[i]], i + 1) };
  };
  return walk(tree, 0);
}

export function setRatio(tree, path, ratio) {
  return mapPath(tree, path, (n) => (n?.type === "split" ? { ...n, ratio: clampRatio(ratio) } : n));
}

export function setDir(tree, path, dir) {
  return mapPath(tree, path, (n) => (n?.type === "split" ? { ...n, dir: dir === "col" ? "col" : "row" } : n));
}

export function swapLeaves(tree, idA, idB) {
  const walk = (n) => {
    if (!n) return n;
    if (n.type === "leaf") return n.id === idA ? leaf(idB) : n.id === idB ? leaf(idA) : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(tree);
}

/**
 * Boxes for every leaf, from a rect and a gap. The gap is applied around the
 * whole rect and between siblings, so the result is what a shell paints.
 * @returns Map<id, {x, y, w, h}>
 */
export function treeBoxes(tree, rect, gap = 0, out = new Map()) {
  if (!tree) return out;
  const g = Math.max(0, Number(gap) || 0);
  const box = { x: rect.x + g, y: rect.y + g, w: Math.max(0, rect.w - g * 2), h: Math.max(0, rect.h - g * 2) };
  const place = (node, b) => {
    if (node.type === "leaf") { out.set(node.id, { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }); return; }
    if (node.dir === "row") {
      const aw = Math.max(0, (b.w - g) * node.ratio);
      place(node.a, { x: b.x, y: b.y, w: aw, h: b.h });
      place(node.b, { x: b.x + aw + g, y: b.y, w: Math.max(0, b.w - aw - g), h: b.h });
    } else {
      const ah = Math.max(0, (b.h - g) * node.ratio);
      place(node.a, { x: b.x, y: b.y, w: b.w, h: ah });
      place(node.b, { x: b.x, y: b.y + ah + g, w: b.w, h: Math.max(0, b.h - ah - g) });
    }
  };
  place(tree, box);
  return out;
}

/** The sashes between siblings — where a pointer can grab to change a ratio.
 *  Each carries the first leaf on either side, which is how a client names the
 *  split to the server without depending on a path in a pruned tree. */
export function treeSashes(tree, rect, gap = 0, out = []) {
  if (!tree) return out;
  const g = Math.max(0, Number(gap) || 0);
  const grab = Math.max(6, g);
  const box = { x: rect.x + g, y: rect.y + g, w: Math.max(0, rect.w - g * 2), h: Math.max(0, rect.h - g * 2) };
  const walk = (node, b, path) => {
    if (node.type === "leaf") return;
    const a = treeLeaves(node.a)[0], bb = treeLeaves(node.b)[0];
    if (node.dir === "row") {
      const aw = Math.max(0, (b.w - g) * node.ratio);
      out.push({ path, dir: "row", a, b: bb, x: b.x + aw - (grab - g) / 2, y: b.y, w: grab, h: b.h, ratio: node.ratio, span: b.w - g, origin: b.x });
      walk(node.a, { x: b.x, y: b.y, w: aw, h: b.h }, path ? `${path}.a` : "a");
      walk(node.b, { x: b.x + aw + g, y: b.y, w: Math.max(0, b.w - aw - g), h: b.h }, path ? `${path}.b` : "b");
    } else {
      const ah = Math.max(0, (b.h - g) * node.ratio);
      out.push({ path, dir: "col", a, b: bb, x: b.x, y: b.y + ah - (grab - g) / 2, w: b.w, h: grab, ratio: node.ratio, span: b.h - g, origin: b.y });
      walk(node.a, { x: b.x, y: b.y, w: b.w, h: ah }, path ? `${path}.a` : "a");
      walk(node.b, { x: b.x, y: b.y + ah + g, w: b.w, h: Math.max(0, b.h - ah - g) }, path ? `${path}.b` : "b");
    }
  };
  walk(tree, box, "");
  return out;
}

/** A one-line description of a tree, for logs, tool results and the desktop map. */
export function describeTree(tree, names = {}) {
  if (!tree) return "empty";
  if (tree.type === "leaf") return names[tree.id] ?? tree.id;
  const pct = Math.round(tree.ratio * 100);
  return `${tree.dir === "row" ? "⇔" : "⇕"}${pct}%[${describeTree(tree.a, names)} | ${describeTree(tree.b, names)}]`;
}
