// Tide — the sync client. Pushes/pulls a local Repo against a Sandbox over the
// Gateway's /:slug/mcp endpoint with a capability-scoped machine token.
//
// Symmetry: both sides are Repos over the same object format, so push and pull are
// just "send the objects the peer lacks + move the ref". Divergence is resolved
// locally with a 3-way merge into a merge mark (which is then a fast-forward push).

import fs from "node:fs";
import path from "node:path";
import {
  reachable, exportObjects, readCommit, writeCommit, listTree, buildTreeFromDir,
  commonAncestor, readFileFromTree,
} from "./objects.js";
import { merge3 } from "./merge.js";

export class TideClient {
  constructor({ url, slug, token }) {
    this.url = url.replace(/\/$/, "");
    this.slug = slug;
    this.token = token;
  }

  async mcp(server, tool, args = {}) {
    const res = await fetch(`${this.url}/${this.slug}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ server, tool, args }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `mcp ${server}.${tool} failed (http ${res.status})`);
    return data.result;
  }

  remoteHead(workspace) { return this.mcp("tide", "refs", { workspace }).then((r) => r.head); }

  /** Fetch remote objects and fast-forward (or merge) the local workspace. */
  async pull(repo, workspace) {
    const localHead = repo.has(workspace) ? repo.head(workspace) : null;
    const { head, objects } = await this.mcp("tide", "fetchObjects", { workspace, have: localHead ? [localHead] : [] });
    if (!head) return { head: localHead, changed: false };
    repo.ingest(objects);
    if (head === localHead) return { head, changed: false };
    if (repo.canFastForward(workspace, head)) { repo.checkout(workspace, head); return { head, changed: true, merged: false }; }
    const merged = this._merge(repo, workspace, head);
    return { head: merged, changed: true, merged: true };
  }

  /** Send local objects the remote lacks and fast-forward the remote ref. */
  async push(repo, workspace, { path: relPath } = {}) {
    const localHead = repo.head(workspace);
    if (!localHead) return { applied: false, reason: "nothing to mark" };
    const remoteHead = await this.remoteHead(workspace).catch(() => null);
    const objects = exportObjects(repo.store, reachable(repo.store, localHead, remoteHead ? [remoteHead] : []));
    return this.mcp("tide", "receiveObjects", { workspace, head: localHead, objects, path: relPath });
  }

  /** Create a local workspace and pull it down. */
  async clone(repo, workspace, workdir) {
    repo.init(workspace, workdir);
    return this.pull(repo, workspace);
  }

  // 3-way merge of divergent histories into a merge mark on top of both heads.
  _merge(repo, workspace, remoteHead) {
    const store = repo.store;
    const ws = repo.get(workspace);
    const localHead = ws.head;
    const base = commonAncestor(store, localHead, remoteHead);
    const baseTree = base ? readCommit(store, base).tree : null;
    const oursTree = localHead ? readCommit(store, localHead).tree : null;
    const theirsTree = readCommit(store, remoteHead).tree;
    const paths = new Set([...listTree(store, oursTree), ...listTree(store, theirsTree)]);

    for (const p of paths) {
      const o = readFileFromTree(store, oursTree, p);
      const t = readFileFromTree(store, theirsTree, p);
      const b = readFileFromTree(store, baseTree, p);
      let content;
      if (o && t && o.equals(t)) content = o;
      else if (!o) content = t;                  // added on theirs / deleted on ours → keep theirs
      else if (!t) content = o;                  // added on ours / deleted on theirs → keep ours
      else content = Buffer.from(merge3(b?.toString() ?? "", o.toString(), t.toString()).merged);
      const full = path.join(ws.path, p);
      if (content == null) { fs.rmSync(full, { force: true }); continue; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const tree = buildTreeFromDir(store, ws.path);
    const commit = writeCommit(store, { tree, parents: [localHead, remoteHead], message: "merge", author: "tide", ts: Date.now() });
    repo.setHead(workspace, commit);
    return commit;
  }
}
