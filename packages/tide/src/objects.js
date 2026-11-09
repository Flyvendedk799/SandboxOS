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

/** Assert that a name is a safe single-segment tree entry name (no slashes, no ..). */
export function assertSafeEntryName(name) {
  if (typeof name !== "string" || !name) {
    throw new Error(`path traversal forbidden: invalid entry name "${name}"`);
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`path traversal forbidden: unsafe entry name "${name}"`);
  }
  return name;
}

/** Assert that a path resolves strictly inside baseDir without path traversal. */
export function assertSafePath(baseDir, relPath) {
  if (typeof relPath !== "string" || !relPath) {
    throw new Error(`path traversal forbidden: invalid relative path "${relPath}"`);
  }
  if (relPath.includes("\0")) {
    throw new Error(`path traversal forbidden: null byte in path "${relPath}"`);
  }
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new Error(`path traversal forbidden: absolute path "${relPath}"`);
  }
  const parts = relPath.split(/[/\\]/);
  for (const part of parts) {
    if (part === "..") {
      throw new Error(`path traversal forbidden: parent segment in "${relPath}"`);
    }
  }
  const normBase = path.resolve(baseDir);
  const resolved = path.resolve(normBase, "." + path.sep + relPath.replace(/^[/\\]+/, ""));
  if (resolved !== normBase && !resolved.startsWith(normBase + path.sep)) {
    throw new Error(`path escapes target directory: "${relPath}"`);
  }
  return resolved;
}

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
  const clean = entries.map((e) => {
    assertSafeEntryName(e.name);
    return { name: e.name, type: e.type === "tree" ? "tree" : "blob", hash: e.hash };
  });
  const sorted = [...clean].sort((a, b) => (a.name < b.name ? -1 : 1));
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
  const normDir = path.resolve(dir);
  fs.mkdirSync(normDir, { recursive: true });
  const want = treeHash ? readTree(store, treeHash) : [];
  const wantNames = new Set();
  for (const e of want) {
    assertSafeEntryName(e.name);
    wantNames.add(e.name);
  }
  for (const name of fs.readdirSync(normDir)) {
    if (IGNORE.has(name)) continue;
    if (!wantNames.has(name)) {
      const full = assertSafePath(normDir, name);
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
  for (const e of want) {
    const full = assertSafePath(normDir, e.name);
    if (e.type === "tree") checkoutTree(store, e.hash, full);
    else fs.writeFileSync(full, readObject(store, e.hash).buf);
  }
}

/** All leaf blobs under a tree: [{ path, hash }]. */
export function collectTreeBlobs(store, treeHash, prefix = "") {
  const out = [];
  for (const e of treeHash ? readTree(store, treeHash) : []) {
    if (e.type === "tree") {
      out.push(...collectTreeBlobs(store, e.hash, prefix + e.name + "/"));
    } else {
      out.push({ path: prefix + e.name, hash: e.hash });
    }
  }
  return out;
}

/** All blob paths under a tree (recursive). */
export function listTree(store, treeHash, prefix = "") {
  return collectTreeBlobs(store, treeHash, prefix).map((b) => b.path);
}

/** Compute summary mutation counts for a change list. */
export function summarizeDiff(changes) {
  const added = changes.filter((c) => c.status === "added").length;
  const modified = changes.filter((c) => c.status === "modified").length;
  const deleted = changes.filter((c) => c.status === "deleted").length;
  return { added, modified, deleted, files: changes.length };
}

/** Flat path-level diff between two trees: {path, status} by default; {path, status, oldHash, newHash} with detail: true. */
export function diffTrees(store, aHash, bHash, prefix = "", opts = {}) {
  let options = {};
  let pfx = "";
  if (typeof prefix === "object" && prefix !== null) {
    options = prefix;
    pfx = options.prefix ?? "";
  } else {
    pfx = prefix || "";
    if (typeof opts === "object" && opts !== null) {
      options = opts;
    }
  }
  const detail = !!options.detail;

  const a = aHash ? readTree(store, aHash) : [];
  const b = bHash ? readTree(store, bHash) : [];
  const am = new Map(a.map((e) => [e.name, e]));
  const bm = new Map(b.map((e) => [e.name, e]));
  const out = [];

  const makeEntry = (itemPath, status, oldHash = null, newHash = null) => {
    return detail
      ? { path: itemPath, status, oldHash, newHash }
      : { path: itemPath, status };
  };

  for (const [name, be] of bm) {
    const ae = am.get(name);
    const p = pfx + name;
    if (!ae) {
      if (be.type === "tree") {
        for (const leaf of collectTreeBlobs(store, be.hash, p + "/")) {
          out.push(makeEntry(leaf.path, "added", null, leaf.hash));
        }
      } else {
        out.push(makeEntry(p, "added", null, be.hash));
      }
    } else if (ae.hash !== be.hash) {
      if (ae.type === "tree" && be.type === "tree") {
        out.push(...diffTrees(store, ae.hash, be.hash, p + "/", options));
      } else if (ae.type === "tree" && be.type === "blob") {
        for (const leaf of collectTreeBlobs(store, ae.hash, p + "/")) {
          out.push(makeEntry(leaf.path, "deleted", leaf.hash, null));
        }
        out.push(makeEntry(p, "added", null, be.hash));
      } else if (ae.type === "blob" && be.type === "tree") {
        out.push(makeEntry(p, "deleted", ae.hash, null));
        for (const leaf of collectTreeBlobs(store, be.hash, p + "/")) {
          out.push(makeEntry(leaf.path, "added", null, leaf.hash));
        }
      } else {
        out.push(makeEntry(p, "modified", ae.hash, be.hash));
      }
    }
  }
  for (const [name, ae] of am) {
    if (!bm.has(name)) {
      const p = pfx + name;
      if (ae.type === "tree") {
        for (const leaf of collectTreeBlobs(store, ae.hash, p + "/")) {
          out.push(makeEntry(leaf.path, "deleted", leaf.hash, null));
        }
      } else {
        out.push(makeEntry(p, "deleted", ae.hash, null));
      }
    }
  }

  return out;
}

/** Opt-in detailed flat path-level diff between two trees: {path, status, oldHash, newHash}. */
export function diffTreesDetailed(store, aHash, bHash, prefix = "") {
  return diffTrees(store, aHash, bHash, prefix, { detail: true });
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
  if (typeof filePath !== "string") return null;
  const parts = filePath.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") return null;
  }
  let entries = treeHash ? readTree(store, treeHash) : [];
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
  if (!Array.isArray(objs)) return 0;
  for (const o of objs) {
    if (!o || !o.payload || !o.hash || !o.type) {
      throw new Error(`invalid object descriptor for import: ${JSON.stringify(o)}`);
    }
    const buf = Buffer.from(o.payload, "base64");
    const h = writeObject(store, o.type, buf);
    if (h !== o.hash) throw new Error(`object hash mismatch: ${o.hash} != ${h}`);
  }
  return objs.length;
}

// ---- volume portability & integrity ---------------------------------------

/** Compute sha256 checksum of a buffer. */
export function sha256(buf) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).digest("hex");
}

/** Build a volume manifest: list of { path, size, sha256 } sorted by path. */
export function buildVolumeManifest(dir, prefix = "") {
  const normDir = path.resolve(dir);
  if (!fs.existsSync(normDir)) return [];
  const files = [];

  function walk(currentDir, currentRel) {
    for (const name of fs.readdirSync(currentDir)) {
      if (IGNORE.has(name)) continue;
      const full = path.join(currentDir, name);
      const rel = currentRel ? `${currentRel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else if (st.isFile()) {
        const buf = fs.readFileSync(full);
        files.push({
          path: rel,
          size: st.size,
          sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        });
      }
    }
  }

  walk(normDir, prefix);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return files;
}

/** Export a directory volume into a self-contained portable structure. */
export function exportVolume(dir) {
  const normDir = path.resolve(dir);
  const manifest = buildVolumeManifest(normDir);
  const files = manifest.map((m) => {
    const full = path.join(normDir, m.path);
    const buf = fs.readFileSync(full);
    return {
      path: m.path,
      size: m.size,
      sha256: m.sha256,
      payload: buf.toString("base64"),
    };
  });

  return {
    version: 1,
    kind: "volume",
    exportedAt: Date.now(),
    files,
  };
}

/** Restore files from a volume payload into targetDir with strict path traversal checks and checksum verification. */
export function restoreVolume(dir, volumePayload, { clean = false } = {}) {
  if (!volumePayload || typeof volumePayload !== "object") {
    throw new Error("invalid volume payload");
  }
  const files = Array.isArray(volumePayload.files) ? volumePayload.files : [];
  const normDir = path.resolve(dir);
  fs.mkdirSync(normDir, { recursive: true });

  const targetPaths = new Set();
  let totalBytes = 0;

  // First pass: validate all entries against path traversal and checksum corruption
  const validated = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string") {
      throw new Error(`invalid volume file entry: ${JSON.stringify(f)}`);
    }
    const safeTarget = assertSafePath(normDir, f.path);
    const buf = Buffer.from(f.payload ?? "", "base64");
    if (f.sha256) {
      const digest = crypto.createHash("sha256").update(buf).digest("hex");
      if (digest !== f.sha256) {
        throw new Error(`volume file corrupted: sha256 mismatch for "${f.path}" (${digest} != ${f.sha256})`);
      }
    }
    targetPaths.add(f.path);
    validated.push({ path: f.path, target: safeTarget, buf });
  }

  // If clean is requested, delete files currently on disk that are not in the volume
  if (clean && fs.existsSync(normDir)) {
    const currentFiles = buildVolumeManifest(normDir);
    for (const cur of currentFiles) {
      if (!targetPaths.has(cur.path)) {
        const full = assertSafePath(normDir, cur.path);
        fs.rmSync(full, { force: true });
      }
    }
  }

  // Second pass: write all verified files
  for (const item of validated) {
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    fs.writeFileSync(item.target, item.buf);
    totalBytes += item.buf.length;
  }

  return { restored: validated.length, bytes: totalBytes };
}
