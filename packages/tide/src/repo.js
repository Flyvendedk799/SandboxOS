// Tide — the Repo: workspace operations over the object store.
//
// A workspace is a working directory under Tide management with a history of
// "tide marks" (commits). One store can hold many workspaces; each maps a name to
// { path (working dir), head (commit hash), live }. The Repo is backend-agnostic —
// the same class runs Sandbox-side (store beside the volume) and laptop-side (store
// in .tide/store), which is what makes push/pull symmetric.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildTreeFromDir, checkoutTree, diffTrees, summarizeDiff, writeCommit, readCommit,
  reachable, exportObjects, importObjects, isAncestor, writeState, readState,
  hasObject, readObject, assertSafePath, assertSafeEntryName, buildVolumeManifest,
  exportVolume, restoreVolume, IGNORE,
} from "./objects.js";

export class Repo {
  constructor(store) {
    this.store = store;
    this.regPath = path.join(store, "workspaces.json");
  }

  registry() {
    try { return JSON.parse(fs.readFileSync(this.regPath, "utf8")); } catch { return {}; }
  }
  _saveRegistry(reg) {
    fs.mkdirSync(this.store, { recursive: true });
    fs.writeFileSync(this.regPath, JSON.stringify(reg, null, 2));
  }
  get(name) {
    const ws = this.registry()[name];
    if (!ws) throw new Error(`no such workspace: ${name}`);
    return ws;
  }
  has(name) { return !!this.registry()[name]; }
  list() { return Object.entries(this.registry()).map(([name, ws]) => ({ name, ...ws })); }

  /** Register a workspace at a working dir (idempotent). */
  init(name, workdir) {
    assertSafeEntryName(name);
    const reg = this.registry();
    if (!reg[name]) {
      reg[name] = {
        path: workdir,
        head: null,
        live: false,
        currentBranch: "main",
        branches: {},
        states: {},
      };
    } else {
      reg[name].path = workdir;
      if (!reg[name].branches) reg[name].branches = {};
      if (!reg[name].currentBranch) reg[name].currentBranch = "main";
      if (!reg[name].states) reg[name].states = {};
    }
    this._saveRegistry(reg);
    fs.mkdirSync(workdir, { recursive: true });
    return reg[name];
  }

  setHead(name, head, extra = {}) {
    const reg = this.registry();
    const ws = reg[name] ?? {};
    const currentBranch = extra.currentBranch ?? ws.currentBranch ?? "main";
    const branches = { ...(ws.branches ?? {}), ...(extra.branches ?? {}) };
    if (currentBranch && head) {
      branches[currentBranch] = head;
    }
    reg[name] = {
      ...ws,
      head,
      currentBranch,
      branches,
      ...extra,
    };
    this._saveRegistry(reg);
  }

  head(name) { return this.get(name).head; }

  // ---- branch / mark tracking ---------------------------------------------

  /** Get the current branch name for a workspace. */
  currentBranch(name) {
    const ws = this.get(name);
    return ws.currentBranch ?? "main";
  }

  /** Create or update a named branch pointing to a commit (or current head). */
  branch(name, branchName, targetRef = null) {
    assertSafeEntryName(branchName);
    const ws = this.get(name);
    let targetHash = null;
    if (targetRef) {
      targetHash = this._resolveCommit(name, targetRef);
      if (!targetHash || !hasObject(this.store, targetHash)) {
        throw new Error(`cannot branch from "${targetRef}": commit does not exist`);
      }
      const obj = readObject(this.store, targetHash);
      if (obj.type !== "commit") {
        throw new Error(`cannot branch from "${targetRef}": object is a ${obj.type}, not a commit`);
      }
    } else {
      targetHash = ws.head;
    }
    const branches = { ...(ws.branches ?? {}), [branchName]: targetHash };
    const reg = this.registry();
    reg[name] = { ...ws, branches };
    this._saveRegistry(reg);
    return { name: branchName, head: targetHash };
  }

  /** List all branches for a workspace. */
  listBranches(name) {
    const ws = this.get(name);
    const current = ws.currentBranch ?? "main";
    const branches = { ...(ws.branches ?? {}) };
    if (!branches[current] && ws.head) {
      branches[current] = ws.head;
    }
    return Object.entries(branches).map(([bName, bHead]) => ({
      name: bName,
      head: bHead,
      current: bName === current,
    }));
  }

  /** Delete a named branch. */
  deleteBranch(name, branchName) {
    const ws = this.get(name);
    if (ws.currentBranch === branchName) {
      throw new Error(`cannot delete currently checked out branch: ${branchName}`);
    }
    const branches = { ...(ws.branches ?? {}) };
    if (!branches[branchName]) return false;
    delete branches[branchName];
    const reg = this.registry();
    reg[name] = { ...ws, branches };
    this._saveRegistry(reg);
    return true;
  }

  /** Helper to resolve a branch name or commit hash to a commit hash. */
  _resolveCommit(name, ref) {
    if (!ref) return null;
    const ws = this.get(name);
    if (ws.branches && ws.branches[ref]) return ws.branches[ref];
    return ref;
  }

  /** Working-tree vs head: list of {path, status}. */
  status(name, opts = {}) {
    const ws = this.get(name);
    const workTree = buildTreeFromDir(this.store, ws.path);
    const headTree = ws.head ? readCommit(this.store, ws.head).tree : null;
    return diffTrees(this.store, headTree, workTree, "", opts);
  }

  /** Snapshot the working tree as a new tide mark. Returns the commit hash (or null if no change). */
  mark(name, { message = "", author = "", ts = Date.now() } = {}) {
    const ws = this.get(name);
    const tree = buildTreeFromDir(this.store, ws.path);
    const headTree = ws.head ? readCommit(this.store, ws.head).tree : null;
    if (tree === headTree) return null; // nothing changed
    const commit = writeCommit(this.store, { tree, parents: ws.head ? [ws.head] : [], message, author, ts });
    this.setHead(name, commit);
    return commit;
  }

  log(name, opts = 50, fromArg = null) {
    let max = 50;
    let fromRef = fromArg;
    if (typeof opts === "number") {
      max = opts;
    } else if (typeof opts === "object" && opts !== null) {
      max = typeof opts.limit === "number" ? opts.limit : 50;
      fromRef = opts.from ?? fromArg;
    }

    const out = [];
    let h = fromRef ? this._resolveCommit(name, fromRef) : this.get(name).head;
    const seen = new Set();
    while (h && out.length < max && !seen.has(h)) {
      seen.add(h);
      const c = readCommit(this.store, h);
      out.push({ hash: h, message: c.message, author: c.author, ts: c.ts, parents: c.parents, tree: c.tree });
      h = c.parents[0];
    }
    return out;
  }

  diff(name, fromRef, toRef, opts = {}) {
    const ws = this.get(name);
    let optObj = opts;
    let from = fromRef;
    let to = toRef;
    if (typeof from === "object" && from !== null) {
      optObj = from;
      from = null;
      to = null;
    } else if (typeof to === "object" && to !== null) {
      optObj = to;
      to = null;
    }

    const resolvedFrom = this._resolveCommit(name, from);
    const resolvedTo = this._resolveCommit(name, to);

    const aTree = resolvedFrom
      ? readCommit(this.store, resolvedFrom).tree
      : (ws.head ? readCommit(this.store, ws.head).tree : null);
    const bTree = resolvedTo
      ? readCommit(this.store, resolvedTo).tree
      : buildTreeFromDir(this.store, ws.path);
    return diffTrees(this.store, aTree, bTree, "", optObj);
  }

  /** Compute summary mutation counts for a change list. */
  summarizeDiff(changes) {
    return summarizeDiff(changes);
  }

  /** Restore the working tree to a commit or branch and move head there. */
  checkout(name, ref) {
    const ws = this.get(name);
    const isBranch = ws.branches && Object.prototype.hasOwnProperty.call(ws.branches, ref);
    const commitHash = isBranch ? ws.branches[ref] : ref;

    const tree = commitHash ? readCommit(this.store, commitHash).tree : null;
    checkoutTree(this.store, tree, ws.path);

    if (isBranch) {
      this.setHead(name, commitHash, { currentBranch: ref });
    } else {
      this.setHead(name, commitHash);
    }
    return commitHash;
  }

  // ---- sync primitives (used by the client and the tide server) ----

  /** Objects reachable from this workspace's head, minus the `have` closures. */
  bundle(name, have = []) {
    const head = this.get(name).head;
    return { head, objects: exportObjects(this.store, reachable(this.store, head, have)) };
  }

  /** Ingest objects from a peer. */
  ingest(objects) { return importObjects(this.store, objects); }

  /** Can `proposedHead` fast-forward over the current head? */
  canFastForward(name, proposedHead) {
    const cur = this.has(name) ? this.get(name).head : null;
    return isAncestor(this.store, cur, proposedHead);
  }

  // ---- State objects (non-file machine state: env, manifest, servers, agents) ----

  /** Store a typed JSON state object (env, manifest, agents, …) for a workspace. */
  putState(name, type, data) {
    assertSafeEntryName(type);
    const ws = this.get(name);
    const hash = writeState(this.store, data);
    const reg = this.registry();
    reg[name] = { ...ws, states: { ...(ws.states ?? {}), [type]: hash } };
    this._saveRegistry(reg);
    return hash;
  }

  /** Read back a typed state object, or null if it hasn't been written. */
  getState(name, type) {
    const ws = this.get(name);
    const hash = (ws.states ?? {})[type];
    return hash ? readState(this.store, hash) : null;
  }

  /** List all state types stored for a workspace. */
  listStates(name) {
    return Object.keys((this.get(name).states ?? {}));
  }

  /** Read all state objects for a workspace into a typed map. */
  getAllStates(name) {
    const ws = this.get(name);
    const states = {};
    for (const [type, hash] of Object.entries(ws.states ?? {})) {
      states[type] = readState(this.store, hash);
    }
    return states;
  }

  // ---- Workspace Portability (Export & Restore) -----------------------------

  /**
   * Export an entire workspace into a portable snapshot containing metadata,
   * commit DAG, all branches, typed state objects, object closure, and volume manifest.
   */
  exportWorkspace(name, { includeHistory = true } = {}) {
    const ws = this.get(name);

    // Collect all reachable commit hashes from head and all branches
    const allHeads = new Set();
    if (ws.head) allHeads.add(ws.head);
    for (const bHead of Object.values(ws.branches ?? {})) {
      if (bHead) allHeads.add(bHead);
    }

    const allReachableHashes = new Set();
    for (const h of allHeads) {
      for (const objHash of reachable(this.store, h)) {
        allReachableHashes.add(objHash);
      }
    }

    // Add state object hashes to the closure
    for (const stateHash of Object.values(ws.states ?? {})) {
      if (hasObject(this.store, stateHash)) {
        allReachableHashes.add(stateHash);
      }
    }

    const objects = exportObjects(this.store, allReachableHashes);
    const volumeFiles = buildVolumeManifest(ws.path);
    const states = this.getAllStates(name);

    const snapshot = {
      version: 1,
      kind: "workspace-snapshot",
      workspace: name,
      exportedAt: Date.now(),
      head: ws.head,
      currentBranch: ws.currentBranch ?? "main",
      branches: { ...(ws.branches ?? {}) },
      states,
      objects,
      volume: {
        files: volumeFiles,
        count: volumeFiles.length,
      },
    };

    // Calculate integrity hash over the JSON payload (excluding integrity property)
    const digest = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    snapshot.integrity = digest;
    return snapshot;
  }

  /**
   * Restore a workspace from a portable snapshot into this Repo and its working directory.
   * Enforces strict integrity checks and path traversal protection.
   */
  restoreWorkspace(name, snapshot, { workdir = null, overwrite = false } = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("invalid snapshot payload: expected object");
    }
    if (snapshot.kind !== "workspace-snapshot") {
      throw new Error(`unsupported snapshot kind: ${snapshot.kind}`);
    }
    assertSafeEntryName(name);

    // Verify snapshot integrity if provided
    if (snapshot.integrity) {
      const copy = { ...snapshot };
      delete copy.integrity;
      const expected = crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
      if (expected !== snapshot.integrity) {
        throw new Error("snapshot corrupted: integrity check failed");
      }
    }

    // Determine target directory
    const targetWorkdir = workdir
      ? path.resolve(workdir)
      : (this.has(name) ? this.get(name).path : path.resolve(path.dirname(this.store), name));

    // Verify target directory containment (preventing traversal)
    assertSafePath(path.dirname(targetWorkdir), path.basename(targetWorkdir));

    if (!overwrite) {
      if (this.has(name)) {
        throw new Error(`cannot restore workspace "${name}": workspace already exists (use overwrite: true)`);
      }
      if (fs.existsSync(targetWorkdir)) {
        const entries = fs.readdirSync(targetWorkdir).filter((e) => !IGNORE.has(e));
        if (entries.length > 0) {
          throw new Error(`cannot restore into non-empty directory "${targetWorkdir}" (use overwrite: true)`);
        }
      }
    }

    // 1. Ingest all objects into store (validates hashes and prevents corruption)
    this.ingest(snapshot.objects ?? []);

    // 2. Initialize workspace in registry
    this.init(name, targetWorkdir);

    // 3. Restore all typed state objects
    if (snapshot.states && typeof snapshot.states === "object") {
      for (const [type, data] of Object.entries(snapshot.states)) {
        this.putState(name, type, data);
      }
    }

    // 4. Restore branches & head
    const branches = { ...(snapshot.branches ?? {}) };
    const currentBranch = snapshot.currentBranch ?? "main";
    if (snapshot.head && !branches[currentBranch]) {
      branches[currentBranch] = snapshot.head;
    }
    this.setHead(name, snapshot.head, {
      currentBranch,
      branches,
    });

    // 5. Restore volume working tree from commit head
    if (snapshot.head) {
      const commit = readCommit(this.store, snapshot.head);
      checkoutTree(this.store, commit.tree, targetWorkdir);
    }

    return {
      workspace: name,
      head: snapshot.head,
      currentBranch,
      path: targetWorkdir,
      restored: true,
    };
  }

  /** Export the current working volume of a workspace. */
  exportVolume(name) {
    const ws = this.get(name);
    return exportVolume(ws.path);
  }

  /** Restore a volume payload into a workspace. */
  restoreVolume(name, volumePayload, { clean = false } = {}) {
    const ws = this.get(name);
    return restoreVolume(ws.path, volumePayload, { clean });
  }
}
