// Out-of-process host for ONE untrusted marketplace MCP server (backlog #12).
//
// This file runs as a forked child process. It imports the third-party server
// factory and serves tool calls over the fork IPC channel. The crucial isolation
// property: the factory and its tool handlers are instantiated with a MINIMAL deps
// object — NO cell, sandbox, or kernel — so untrusted marketplace code cannot reach
// the control plane, the host filesystem custody (master.key, control.sqlite), or
// call back into the Kernel. All authorization + audit happens in the PARENT before
// a call is ever forwarded here; this process only computes a tool result from args.
//
// Protocol (parent -> child): { id, op: "describe"|"call", tool?, args? }
//          (child -> parent): { id, ok: true, result } | { id, ok: false, error }

import { pathToFileURL } from "node:url";

const source = process.argv[2];
let server = null;
let initError = null;

async function init() {
  try {
    const url = source.startsWith("file:") ? source : pathToFileURL(source).href;
    const mod = await import(url);
    const factory = mod.default ?? mod.createServer;
    if (!factory) throw new Error(`${source} has no default or createServer export`);
    // MINIMAL deps. Deliberately {} — untrusted code gets no host handle.
    server = typeof factory === "function" ? factory({}) : factory;
    if (!server || typeof server !== "object" || !server.tools) {
      throw new Error(`${source} did not produce a valid { name, tools } server`);
    }
  } catch (e) {
    initError = e?.message ?? String(e);
  }
}
const ready = init();

// When the parent exits/disconnects, this orphaned child must not linger.
process.on("disconnect", () => process.exit(0));

process.on("message", async (msg) => {
  await ready;
  const { id, op, tool, args } = msg ?? {};
  try {
    if (initError) throw new Error(`marketplace server failed to load: ${initError}`);

    if (op === "describe") {
      const tools = Object.entries(server.tools ?? {}).map(([name, t]) => ({
        name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" },
      }));
      process.send({ id, ok: true, result: { name: server.name, tools } });
      return;
    }

    // op === "call"
    const t = server.tools?.[tool];
    if (!t || typeof t.handler !== "function") throw new Error(`unknown tool: ${tool}`);
    const result = await t.handler({}, args ?? {}); // empty ctx — no kernel/cell/sandbox
    process.send({ id, ok: true, result });
  } catch (e) {
    process.send({ id, ok: false, error: e?.message ?? String(e) });
  }
});
