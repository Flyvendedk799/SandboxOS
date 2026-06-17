// Tide — 3-way text merge for the live mirror.
//
// Phase 2 handles the common live cases cleanly: when only one side changed a file
// since the common base, take that side. When both changed identically, take it.
// True concurrent divergence falls back to conflict markers (and flags a conflict).
// Character-level CRDT convergence (Yjs/Automerge-class) is the documented target;
// this is the honest interim that doesn't pretend to merge what it can't.

/** @returns {{merged: string, conflict: boolean}} */
export function merge3(base, ours, theirs) {
  if (ours === theirs) return { merged: ours, conflict: false };
  if (base === ours) return { merged: theirs, conflict: false };   // only theirs changed
  if (base === theirs) return { merged: ours, conflict: false };   // only ours changed

  // Both diverged: attempt a line-level merge of non-overlapping hunks.
  const b = lines(base), o = lines(ours), t = lines(theirs);
  if (disjointLineEdits(b, o, t)) return { merged: applyBoth(b, o, t).join("\n"), conflict: false };

  return {
    merged: `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs`,
    conflict: true,
  };
}

const lines = (s) => (s ?? "").split("\n");

/** True if ours and theirs never modified the same base line. */
function disjointLineEdits(b, o, t) {
  // Cheap heuristic: line counts equal and changes touch different indices.
  if (o.length !== b.length || t.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (o[i] !== b[i] && t[i] !== b[i] && o[i] !== t[i]) return false;
  }
  return true;
}

function applyBoth(b, o, t) {
  return b.map((line, i) => (o[i] !== line ? o[i] : t[i] !== line ? t[i] : line));
}
