// Gateway entry point — boot the SandboxOS spine.

import { spawn } from "node:child_process";
import config from "../../../packages/config/src/config.js";
import { assertSupportedNode, quietSqliteWarning } from "../../../packages/config/src/node-compat.js";
import { openDb } from "../../../packages/control-db/src/db.js";
import { ensureSeed, purgeExpiredSessions, verifyAuditChain } from "../../../packages/control-db/src/registry.js";
import { resolveBackend } from "../../../packages/cell/src/cell.js";
import { seedVolume } from "../../../packages/cell/src/seed.js";
import { cronTick } from "../../../packages/scheduler/src/cron-runner.js";
import { createServer, scheduler } from "./server.js";
import { stopAllProcsEverywhere } from "../../../packages/kernel/src/servers/proc.js";
import { killAllHosted } from "../../../packages/kernel/src/marketplace-pool.js";

// Say what is wrong at the top, once, before anything else can fail obscurely.
assertSupportedNode();
quietSqliteWarning();

const backend = await resolveBackend();
config.cellBackend = backend; // pin the resolved choice for the rest of the process

openDb();
const { tenant, sandbox } = ensureSeed(backend);
seedVolume(sandbox); // first run only — an existing volume is never touched

// Backlog #4: verify the audit hash-chain on boot — tamper-evidence is only
// assurance if it is actually checked. Log loudly if a break is found.
try {
  const v = verifyAuditChain();
  if (!v.ok) console.error(`AUDIT INTEGRITY: hash-chain broken at row id=${v.brokenAtId} (verified ${v.count} rows)`);
} catch (e) { console.error("audit verify:", e.message); }

// Background loops: fire due cron jobs, hibernate idle Cells (single-host budget),
// and purge expired session/machine tokens so stale credential rows don't accumulate (backlog #2).
setInterval(() => cronTick().catch((e) => console.error("cron:", e.message)), 1000).unref();
setInterval(() => scheduler.reapIdle().catch((e) => console.error("reaper:", e.message)), 30_000).unref();
setInterval(() => { try { purgeExpiredSessions(); } catch (e) { console.error("session purge:", e.message); } }, 60 * 60_000).unref();

/** Shut down cleanly: supervised processes and marketplace servers are children of
 *  this process, and an orphaned one keeps whatever it holds — a port, a lock —
 *  bound after we are gone. Idempotent, because SIGINT and exit can both fire. */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const procs = stopAllProcsEverywhere();
  killAllHosted();
  if (procs) console.log(`\nstopped ${procs} supervised process${procs === 1 ? "" : "es"}`);
  if (signal) process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
process.on("exit", () => shutdown(null));

const server = createServer();
server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  const tunnelToken = process.env.SANDBOXOS_TUNNEL_TOKEN;
  let tunnelLine = `  │  Public access:  cloudflared tunnel --url ${base}`;
  if (tunnelToken) {
    const cf = spawn("cloudflared", ["tunnel", "run", "--token", tunnelToken], { stdio: "inherit" });
    cf.on("error", (e) => console.error(`cloudflared: ${e.message} (is cloudflared installed?)`));
    cf.on("close", (code) => { if (code !== null) console.error(`cloudflared exited with code ${code}`); });
    tunnelLine = "  │  tunnel     Cloudflare Tunnel starting (SANDBOXOS_TUNNEL_TOKEN set)";
  }
  console.log(`
  ┌─ SandboxOS ── Phase 19 · per-tenant keys · agent cap · db ───
  │  gateway   ${base}
  │  slug      ${base}/${sandbox.slug}   (tenant: ${tenant.name})
  │  cell      ${backend} backend${backend === "local" ? "  (no isolation — install/run Docker for real Cells)" : ""}
  │  password  ${config.password === "dev" ? "dev  (set SANDBOXOS_PASSWORD to change)" : "(from SANDBOXOS_PASSWORD)"}
  │  home      ${config.home}
  │
  │  Open the gateway, log in, and you're inside your machine.
${tunnelLine}
  └──────────────────────────────────────────────────────────────
`);
});
