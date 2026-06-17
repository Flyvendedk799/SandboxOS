// The cron runner — fires due jobs scheduled via the `cron` server.
//
// Driven on an interval by the Gateway (and called directly with a fixed `now` in
// tests). Each job fires a Kernel call on behalf of its scheduling principal, using
// that principal's current capabilities — so a job can never exceed its author.

import { openDb } from "../../control-db/src/db.js";
import { getSandbox, grantsFor } from "../../control-db/src/registry.js";
import { getKernel } from "../../kernel/src/kernel.js";

export async function cronTick(now = Date.now()) {
  const db = openDb();
  const due = db.prepare("SELECT * FROM jobs WHERE enabled=1 AND due_at<=? ORDER BY due_at").all(now);
  let fired = 0;
  for (const job of due) {
    const sandbox = getSandbox(job.sandbox_id);
    if (!sandbox) { db.prepare("UPDATE jobs SET enabled=0 WHERE id=?").run(job.id); continue; }
    const kernel = await getKernel(sandbox);
    const held = grantsFor(job.principal_id, sandbox.id);
    let args = {};
    try { args = JSON.parse(job.args_json ?? "{}"); } catch {}
    await kernel.call({
      principalId: job.principal_id, heldPatterns: held,
      server: job.server, tool: job.tool, args, onBehalfOf: `cron:${job.id}`,
    });
    fired++;
    if (job.interval_ms) {
      db.prepare("UPDATE jobs SET due_at=? WHERE id=?").run(now + job.interval_ms, job.id);
    } else {
      db.prepare("UPDATE jobs SET enabled=0 WHERE id=?").run(job.id); // one-shot done
    }
  }
  return { fired };
}
