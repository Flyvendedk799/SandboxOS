// The `tide` core MCP server — the sync protocol as tools (docs/05).
//
// Sandbox-side Tide: the object store lives beside the Cell volume
// (<sandbox>/tide), and workspace working dirs live *inside* the volume so the
// container sees synced files. Because it's an MCP server, agents sync too — and
// every mark/push/pull is authorized + audited like any other call.
//
// fetchObjects/receiveObjects are the wire primitives the laptop daemon drives over
// the Gateway's /:slug/mcp endpoint. receiveObjects is fast-forward-only; the client
// merges on divergence and pushes a merge mark (FF), keeping the server simple.

import path from "node:path";
import { Repo } from "../../../tide/src/repo.js";

export function tideServer(deps) {
  const { cell, sandbox } = deps;
  const store = path.join(path.dirname(sandbox.volume_path), "tide");
  const repo = new Repo(store);
  const workdir = (rel) => path.join(cell.root, rel && rel !== "." ? rel : "");

  return {
    name: "tide",
    tools: {
      init: {
        description: "Create a Tide workspace mapped to a Sandbox path.",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" }, path: { type: "string" } } },
        async handler(_ctx, a) {
          const ws = repo.init(a.workspace, workdir(a.path ?? a.workspace));
          return { workspace: a.workspace, path: ws.path, head: ws.head };
        },
      },
      listWorkspaces: {
        description: "List Tide workspaces in this Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { workspaces: repo.list() }; },
      },
      status: {
        description: "Working-tree changes since the last mark.",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" } } },
        async handler(_ctx, a) { return { changes: repo.status(a.workspace) }; },
      },
      mark: {
        description: "Snapshot the workspace as a new tide mark (commit).",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" }, message: { type: "string" } } },
        async handler(ctx, a) {
          const commit = repo.mark(a.workspace, { message: a.message ?? "", author: ctx.principalId });
          return { commit, changed: !!commit, head: repo.head(a.workspace) };
        },
      },
      log: {
        description: "History of tide marks for a workspace.",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" }, limit: { type: "number" } } },
        async handler(_ctx, a) { return { marks: repo.log(a.workspace, a.limit ?? 50) }; },
      },
      diff: {
        description: "Diff two refs (or working tree vs head) in a workspace.",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" }, from: { type: "string" }, to: { type: "string" } } },
        async handler(_ctx, a) { return { changes: repo.diff(a.workspace, a.from, a.to) }; },
      },
      checkout: {
        description: "Restore the workspace working tree to a mark.",
        inputSchema: { type: "object", required: ["workspace", "ref"], properties: { workspace: { type: "string" }, ref: { type: "string" } } },
        async handler(_ctx, a) { return { head: repo.checkout(a.workspace, a.ref) }; },
      },
      refs: {
        description: "The current head of a workspace.",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" } } },
        async handler(_ctx, a) { return { head: repo.has(a.workspace) ? repo.head(a.workspace) : null }; },
      },

      // ---- State objects (non-file machine state) ----
      putState: {
        description: "Write a typed JSON state object (env, manifest, agents, …) into the workspace.",
        inputSchema: {
          type: "object", required: ["workspace", "type", "data"],
          properties: { workspace: { type: "string" }, type: { type: "string" }, data: {} },
        },
        async handler(_ctx, a) {
          const hash = repo.putState(a.workspace, a.type, a.data);
          return { workspace: a.workspace, type: a.type, hash };
        },
      },
      getState: {
        description: "Read a typed state object from the workspace.",
        inputSchema: {
          type: "object", required: ["workspace", "type"],
          properties: { workspace: { type: "string" }, type: { type: "string" } },
        },
        async handler(_ctx, a) {
          const data = repo.getState(a.workspace, a.type);
          return { workspace: a.workspace, type: a.type, data };
        },
      },
      listStates: {
        description: "List state types stored in a workspace.",
        inputSchema: {
          type: "object", required: ["workspace"],
          properties: { workspace: { type: "string" } },
        },
        async handler(_ctx, a) {
          return { workspace: a.workspace, types: repo.listStates(a.workspace) };
        },
      },

      // ---- wire primitives ----
      fetchObjects: {
        description: "Return head + objects reachable from it that the caller lacks (pull).",
        inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" }, have: { type: "array", items: { type: "string" } } } },
        async handler(_ctx, a) {
          if (!repo.has(a.workspace)) return { head: null, objects: [] };
          return repo.bundle(a.workspace, a.have ?? []);
        },
      },
      receiveObjects: {
        description: "Ingest pushed objects; fast-forward the workspace and check it out (push).",
        inputSchema: {
          type: "object", required: ["workspace", "head", "objects"],
          properties: { workspace: { type: "string" }, head: {}, objects: { type: "array" }, path: { type: "string" } },
        },
        async handler(_ctx, a) {
          if (!repo.has(a.workspace)) repo.init(a.workspace, workdir(a.path ?? a.workspace));
          repo.ingest(a.objects);
          if (!repo.canFastForward(a.workspace, a.head)) {
            return { applied: false, reason: "non-fast-forward", head: repo.head(a.workspace) };
          }
          repo.checkout(a.workspace, a.head); // updates head AND materializes into the volume
          return { applied: true, head: a.head };
        },
      },
    },
  };
}
