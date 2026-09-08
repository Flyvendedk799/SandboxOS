// Gateway entry point — boot the SandboxOS spine.

import { safeSpawn } from "../../../packages/cell/src/spawn.js";
import { hostReport } from "../../../packages/cell/src/shell.js";
import config from "../../../packages/config/src/config.js";
import { assertSupportedNode, quietSqliteWarning } from "../../../packages/config/src/node-compat.js";
import { openDb } from "../../../packages/control-db/src/db.js";
import { ensureSeed, purgeExpiredSessions, verifyAuditChain } from "../../../packages/control-db/src/registry.js";
import { resolveBackend } from "../../../packages/cell/src/cell.js";
import { seedVolume } from "../../../packages/cell/src/seed.js";
import { cronTick } from "../../../packages/scheduler/src/cron-runner.js";
import { createServer, scheduler } from "./server.js";
import { stopAllProcsEverywhere } from "../../../packages/kernel/src/servers/proc.js";
import { killAllSessionsEverywhere, reapIdleSessions } from "../../../packages/kernel/src/pty-sessions.js";
import { killAllHosted } from "../../../packages/kernel/src/marketplace-pool.js";

// Say what is wrong at the top, once, before anything else can fail obscurely.
assertSupportedNode();
quietSqliteWarning();

// goal.md invariant 11 — no unhandled child, and no unhandled anything.
//
// A failure inside one Sandbox may end that Sandbox's operation; it may never end
// the host process, because the host process is everyone else's machine too. The
// classic way this went wrong: `spawn` reports a missing binary by emitting
// 'error' asynchronously, so opening a Terminal on a host without /bin/sh killed
// every session on the Gateway. Children now attach their own listeners
// (packages/cell/src/spawn.js); this is the floor under that.
let inFatalHandler = false;
function survive(kind, err) {
  // A failure *inside* the handler is the one case where staying up is not an
  // option: the log itself is broken, and a loop would be worse than an exit.
  if (inFatalHandler) process.exit(1);
  inFatalHandler = true;
  try {
    console.error(`
[${kind}] ${err?.stack ?? err}
  — the Gateway is staying up; the operation that caused this failed.`);
  } finally {
    inFatalHandler = false;
  }
}
process.on("uncaughtException", (err) => survive("uncaughtException", err));
process.on("unhandledRejection", (err) => survive("unhandledRejection", err));

const backend = await resolveBackend();
config.cellBackend = backend; // pin the resolved choice for the rest of the process

openDb();
const { tenant, sandbox } = ensureSeed(backend);
const { buildInfo } = await import("../../../packages/config/src/config.js");
const buildStamp = `${buildInfo().commit ?? "(unknown commit)"} · node ${process.versions.node}`;
console.log(`SandboxOS build ${buildStamp} · cells: ${backend}`);
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
setInterval(() => { try { reapIdleSessions(); } catch (e) { console.error("pty reaper:", e.message); } }, 5 * 60_000).unref();
setInterval(() => { try { purgeExpiredSessions(); } catch (e) { console.error("session purge:", e.message); } }, 60 * 60_000).unref();

/** Shut down cleanly: supervised processes and marketplace servers are children of
 *  this process, and an orphaned one keeps whatever it holds — a port, a lock —
 *  bound after we are gone. Idempotent, because SIGINT and exit can both fire. */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const procs = stopAllProcsEverywhere();
  killAllSessionsEverywhere();
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
    const cf = safeSpawn("cloudflared", ["tunnel", "run", "--token", tunnelToken], { stdio: "inherit" },
      (e) => console.error(`cloudflared: ${e.message} (is cloudflared installed?)`));
    cf.on("close", (code) => { if (code !== null) console.error(`cloudflared exited with code ${code}`); });
    tunnelLine = "  │  tunnel     Cloudflare Tunnel starting (SANDBOXOS_TUNNEL_TOKEN set)";
  }
  const host = hostReport();
  const hostLines = host.notes
    .flatMap((n) => (n.disables ? [`  │  ${n.text}`, `  │            ↳ unavailable: ${n.disables}`] : [`  │  ${n.text}`]))
    .join("\n");
  console.log(`
  ┌─ SandboxOS ── build ${buildStamp} ───────────────────────────
  │  gateway   ${base}
  │  slug      ${base}/${sandbox.slug}   (tenant: ${tenant.name})
  │  cell      ${backend} backend${backend === "local" ? "  (no isolation — install/run Docker for real Cells)" : ""}
${hostLines}
  │  password  ${config.password === "dev" ? "dev  (set SANDBOXOS_PASSWORD to change)" : "(from SANDBOXOS_PASSWORD)"}
  │  home      ${config.home}
  │
  │  Open the gateway, log in, and you're inside your machine.
${tunnelLine}
  └──────────────────────────────────────────────────────────────
`);
});
