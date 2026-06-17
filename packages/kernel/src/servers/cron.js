// The `cron` core MCP server — time/scheduling as tools.
//
// (Doc 03 listed this as `scheduler`; renamed to `cron` here so it isn't confused
// with the control-plane Scheduler that manages Cell lifecycle. Tool names are
// dotless to fit the "<server>.<tool>" address grammar.)
//
// Jobs fire a Kernel tool call on behalf of the scheduling principal, with that
// principal's capabilities — so a scheduled action can never exceed what its
// author could do directly. Firing is driven by the control-plane cron runner.

import crypto from "node:crypto";
import { openDb } from "../../../control-db/src/db.js";

const now = () => Date.now();
const jid = () => `job_${crypto.randomUUID().slice(0, 8)}`;

export function cronServer(deps) {
  const { sandbox } = deps;
  const db = () => openDb();

  function schedule(principalId, { server, tool, args, dueAt, intervalMs }) {
    const id = jid();
    db().prepare(`INSERT INTO jobs (id,sandbox_id,principal_id,server,tool,args_json,due_at,interval_ms,enabled,created_at)
                  VALUES (?,?,?,?,?,?,?,?,1,?)`)
      .run(id, sandbox.id, principalId, server, tool, JSON.stringify(args ?? {}), dueAt, intervalMs ?? null, now());
    return { id, dueAt, intervalMs: intervalMs ?? null };
  }

  return {
    name: "cron",
    tools: {
      at: {
        description: "Schedule a one-shot tool call after delayMs.",
        inputSchema: {
          type: "object", required: ["delayMs", "server", "tool"],
          properties: { delayMs: { type: "number" }, server: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
        },
        async handler(ctx, a) {
          return schedule(ctx.principalId, { server: a.server, tool: a.tool, args: a.args, dueAt: now() + a.delayMs });
        },
      },
      every: {
        description: "Schedule a recurring tool call every intervalMs.",
        inputSchema: {
          type: "object", required: ["intervalMs", "server", "tool"],
          properties: { intervalMs: { type: "number" }, server: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
        },
        async handler(ctx, a) {
          return schedule(ctx.principalId, { server: a.server, tool: a.tool, args: a.args, dueAt: now() + a.intervalMs, intervalMs: a.intervalMs });
        },
      },
      list: {
        description: "List scheduled jobs in this Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const rows = db().prepare("SELECT id,server,tool,due_at,interval_ms,enabled FROM jobs WHERE sandbox_id=? ORDER BY due_at").all(sandbox.id);
          return { jobs: rows };
        },
      },
      cancel: {
        description: "Cancel a scheduled job by id.",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        async handler(_ctx, a) {
          const r = db().prepare("DELETE FROM jobs WHERE id=? AND sandbox_id=?").run(a.id, sandbox.id);
          return { cancelled: r.changes > 0 };
        },
      },
    },
  };
}
