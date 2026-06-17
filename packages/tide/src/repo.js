// Tide — the Repo: workspace operations over the object store.
//
// A workspace is a working directory under Tide management with a history of
// "tide marks" (commits). One store can hold many workspaces; each maps a name to
// { path (working dir), head (commit hash), live }. The Repo is backend-agnostic —
// the same class runs Sandbox-side (store beside the volume) and laptop-side (store
// in .tide/store), which is what makes push/pull symmetric.

import fs from "node:fs";
import path from "node:path";
import {
  buildTreeFromDir, checkoutTree, diffTrees, writeCommit, readCommit,
  reachable, exportObjects, importObjects, isAncestor, writeState, readState,
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
    const reg = this.registry();
    if (!reg[name]) reg[name] = { path: workdir, head: null, live: false };
    else reg[name].path = workdir;
    this._saveRegistry(reg);
    fs.mkdirSync(workdir, { recursive: true });
    return reg[name];
  }

  setHead(name, head, extra = {}) {
    const reg = this.registry();
    reg[name] = { ...reg[name], head, ...extra };
    this._saveRegistry(reg);
  }

  head(name) { return this.get(name).head; }

  /** Working-tree vs head: list of {path, status}. */
  status(name) {
    const ws = this.get(name);
    const workTree = buildTreeFromDir(this.store, ws.path);
    const headTree = ws.head ? readCommit(this.store, ws.head).tree : null;
    return diffTrees(this.store, headTree, workTree);
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

  log(name, limit = 50) {
    const out = [];
    let h = this.get(name).head;
    const seen = new Set();
    while (h && out.length < limit && !seen.has(h)) {
      seen.add(h);
      const c = readCommit(this.store, h);
      out.push({ hash: h, message: c.message, author: c.author, ts: c.ts, parents: c.parents });
      h = c.parents[0];
    }
    return out;
  }

  diff(name, fromRef, toRef) {
    const ws = this.get(name);
    const aTree = fromRef ? readCommit(this.store, fromRef).tree : (ws.head ? readCommit(this.store, ws.head).tree : null);
    const bTree = toRef ? readCommit(this.store, toRef).tree : buildTreeFromDir(this.store, ws.path);
    return diffTrees(this.store, aTree, bTree);
  }

  /** Restore the working tree to a commit and move head there. */
  checkout(name, commitHash) {
    const ws = this.get(name);
    const tree = commitHash ? readCommit(this.store, commitHash).tree : null;
    checkoutTree(this.store, tree, ws.path);
    this.setHead(name, commitHash);
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

  // ---- State objects (non-file machine state: env, manifest, agents) --------

  /** Store a typed JSON state object (env, manifest, agents, …) for a workspace. */
  putState(name, type, data) {
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
}
