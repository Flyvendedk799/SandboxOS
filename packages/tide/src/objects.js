// Tide — the content-addressed object store (the versioned core, docs/05).
//
// Four object kinds, each addressed by the sha256 of its type-tagged content:
//   blob   — file bytes
//   tree   — a sorted map of named entries (dirs → blobs/subtrees)
//   commit — a "tide mark": { tree, parents[], author, ts, message }
//   state  — typed non-file state (env, manifest, agent defs) as JSON
//
// Identical content is stored once (dedup). Objects live on disk under
// <store>/objects/<hh>/<rest>, sharded by the first two hex chars, like git.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Files/dirs never captured by Tide.
export const IGNORE = new Set([".git", "node_modules", ".DS_Store", ".tide"]);

export function hashObject(type, buf) {
  return crypto.createHash("sha256").update(type).update("\0").update(buf).digest("hex");
}

const objPath = (store, hash) => path.join(store, "objects", hash.slice(0, 2), hash.slice(2));

export function writeObject(store, type, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const hash = hashObject(type, b);
  const p = objPath(store, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.concat([Buffer.from(`${type} ${b.length}\n`), b]));
  }
  return hash;
}

export function readObject(store, hash) {
  const raw = fs.readFileSync(objPath(store, hash));
  const nl = raw.indexOf(10);
  const [type] = raw.subarray(0, nl).toString().split(" ");
  return { type, buf: raw.subarray(nl + 1) };
}

export const hasObject = (store, hash) => fs.existsSync(objPath(store, hash));

// ---- typed helpers --------------------------------------------------------

export const writeBlob = (store, buf) => writeObject(store, "blob", buf);

export function writeTree(store, entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  return writeObject(store, "tree", Buffer.from(JSON.stringify(sorted)));
}
export const readTree = (store, hash) => JSON.parse(readObject(store, hash).buf.toString());

export function writeCommit(store, { tree, parents = [], message = "", author = "", ts }) {
  return writeObject(store, "commit", Buffer.from(JSON.stringify({ tree, parents, message, author, ts })));
}
export const readCommit = (store, hash) => JSON.parse(readObject(store, hash).buf.toString());

export const writeState = (store, data) => writeObject(store, "state", Buffer.from(JSON.stringify(data)));
export const readState = (store, hash) => JSON.parse(readObject(store, hash).buf.toString());

// ---- working-tree <-> object-tree ----------------------------------------

/** Snapshot a working directory into the store, returning the root tree hash. */
export function buildTreeFromDir(store, dir) {
  const entries = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (IGNORE.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) entries.push({ name, type: "tree", hash: buildTreeFromDir(store, full) });
    else if (st.isFile()) entries.push({ name, type: "blob", hash: writeBlob(store, fs.readFileSync(full)) });
  }
  return writeTree(store, entries);
}

/** Materialize a tree into a working directory (removes managed files not in the tree). */
export function checkoutTree(store, treeHash, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const want = treeHash ? readTree(store, treeHash) : [];
  const wantNames = new Set(want.map((e) => e.name));
  for (const name of fs.readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    if (!wantNames.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  for (const e of want) {
    const full = path.join(dir, e.name);
    if (e.type === "tree") checkoutTree(store, e.hash, full);
    else fs.writeFileSync(full, readObject(store, e.hash).buf);
  }
}

/** All blob paths under a tree (recursive). */
export function listTree(store, treeHash, prefix = "") {
  const out = [];
  for (const e of treeHash ? readTree(store, treeHash) : []) {
    if (e.type === "tree") out.push(...listTree(store, e.hash, prefix + e.name + "/"));
    else out.push(prefix + e.name);
  }
  return out;
}

/** Flat path-level diff between two trees: {path, status}. */
export function diffTrees(store, aHash, bHash, prefix = "") {
  const a = aHash ? readTree(store, aHash) : [];
  const b = bHash ? readTree(store, bHash) : [];
  const am = new Map(a.map((e) => [e.name, e]));
  const bm = new Map(b.map((e) => [e.name, e]));
  const out = [];
  for (const [name, be] of bm) {
    const ae = am.get(name);
    const p = prefix + name;
    if (!ae) {
      if (be.type === "tree") out.push(...listTree(store, be.hash, p + "/").map((x) => ({ path: x, status: "added" })));
      else out.push({ path: p, status: "added" });
    } else if (ae.hash !== be.hash) {
      if (ae.type === "tree" && be.type === "tree") out.push(...diffTrees(store, ae.hash, be.hash, p + "/"));
      else out.push({ path: p, status: "modified" });
    }
  }
  for (const [name, ae] of am) {
    if (!bm.has(name)) {
      const p = prefix + name;
      if (ae.type === "tree") out.push(...listTree(store, ae.hash, p + "/").map((x) => ({ path: x, status: "deleted" })));
      else out.push({ path: p, status: "deleted" });
    }
  }
  return out;
}

// ---- history & sync -------------------------------------------------------

/** Is `maybeAncestor` reachable by following parents from `head`? */
export function isAncestor(store, maybeAncestor, head) {
  if (!maybeAncestor) return true;          // null ancestor (empty history) is an ancestor of all
  if (!head) return false;
  const seen = new Set();
  const stack = [head];
  while (stack.length) {
    const h = stack.pop();
    if (h === maybeAncestor) return true;
    if (seen.has(h)) continue;
    seen.add(h);
    stack.push(...readCommit(store, h).parents);
  }
  return false;
}

/** Every object hash reachable from a commit, excluding closures of `have` commits. */
export function reachable(store, commitHash, have = []) {
  const stop = new Set();
  for (const h of have) if (hasObject(store, h)) collectClosure(store, h, "commit", stop);
  const out = new Set();
  if (commitHash) collectClosure(store, commitHash, "commit", out, stop);
  return out;
}

function collectClosure(store, hash, type, out, stop = new Set()) {
  const stack = [[type, hash]];
  while (stack.length) {
    const [t, h] = stack.pop();
    if (out.has(h) || stop.has(h)) continue;
    out.add(h);
    if (t === "commit") {
      const c = readCommit(store, h);
      stack.push(["tree", c.tree]);
      for (const p of c.parents) stack.push(["commit", p]);
    } else if (t === "tree") {
      for (const e of readTree(store, h)) stack.push([e.type === "tree" ? "tree" : "blob", e.hash]);
    }
  }
}

/** Lowest common ancestor of two commits (for 3-way merge). */
export function commonAncestor(store, a, b) {
  if (!a || !b) return null;
  const ancestorsOfA = new Set();
  let stack = [a];
  while (stack.length) {
    const h = stack.pop();
    if (ancestorsOfA.has(h)) continue;
    ancestorsOfA.add(h);
    stack.push(...readCommit(store, h).parents);
  }
  stack = [b];
  const seen = new Set();
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    if (ancestorsOfA.has(h)) return h;
    stack.push(...readCommit(store, h).parents);
  }
  return null;
}

/** Read a file's bytes from a tree by slash-path, or null if absent. */
export function readFileFromTree(store, treeHash, filePath) {
  let entries = treeHash ? readTree(store, treeHash) : [];
  const parts = filePath.split("/");
  for (let i = 0; i < parts.length; i++) {
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.type === "blob" ? readObject(store, e.hash).buf : null;
    if (e.type !== "tree") return null;
    entries = readTree(store, e.hash);
  }
  return null;
}

/** Serialize objects for transport. */
export function exportObjects(store, hashes) {
  return [...hashes].map((h) => {
    const { type, buf } = readObject(store, h);
    return { hash: h, type, payload: buf.toString("base64") };
  });
}

/** Ingest transported objects, verifying each hash. */
export function importObjects(store, objs) {
  for (const o of objs) {
    const buf = Buffer.from(o.payload, "base64");
    const h = writeObject(store, o.type, buf);
    if (h !== o.hash) throw new Error(`object hash mismatch: ${o.hash} != ${h}`);
  }
  return objs.length;
}
