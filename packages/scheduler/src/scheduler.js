// The control-plane Scheduler — Cell lifecycle on a single host (docs/04).
//
// Owns wake / hibernate / resource budget. The key single-host invariant: only
// `maxRunning` Cells may be hot at once. Waking past the budget evicts the
// least-recently-active Cell (LRU) to disk; an idle reaper hibernates Cells that
// have gone quiet. A Sandbox is its volume + manifest, so hibernation is cheap and
// lossless. (Generic warm-pool pre-booting conflicts with per-Cell bind volumes and
// is deferred to Phase 5 with a different volume strategy — see PHASE1.md.)

import { getCell } from "../../cell/src/cell.js";
import { getSandbox, setSandboxState, runningCountForTenant } from "../../control-db/src/registry.js";

const nowMs = () => Date.now();

export class Scheduler {
  constructor({ maxRunning = 4, idleMs = 10 * 60 * 1000 } = {}) {
    this.maxRunning = maxRunning;
    this.idleMs = idleMs;
    this.running = new Map(); // sandboxId -> lastActiveMs
  }

  runningCount() { return this.running.size; }
  isRunning(sandboxId) { return this.running.has(sandboxId); }

  /** Wake a Sandbox's Cell, evicting the LRU Cell first if over-budget.
   *  Enforces both the global maxRunning cap and the per-tenant max_running quota.
   *  @param {object} [quota] - Tenant quota row from getQuota() — used for max_running + resource limits.
   */
  async wake(sandbox, quota = {}, now = nowMs()) {
    if (this.running.has(sandbox.id)) { this.running.set(sandbox.id, now); return { state: "running", evicted: null }; }

    // Per-tenant running cap: check DB state (persists across restarts).
    if (quota.max_running != null) {
      const tenantRunning = runningCountForTenant(sandbox.tenant_id);
      if (tenantRunning >= quota.max_running) {
        throw new Error(`tenant running-cell limit reached (max ${quota.max_running})`);
      }
    }

    let evicted = null;
    if (this.running.size >= this.maxRunning) evicted = await this._evictLRU();
    const cellOpts = quota.mem_mb != null ? { memMb: quota.mem_mb, cpuShares: quota.cpu_shares } : {};
    await getCell(sandbox, cellOpts).ensureRunning();
    setSandboxState(sandbox.id, "running");
    this.running.set(sandbox.id, now);
    return { state: "running", evicted };
  }

  /** Record activity so the Cell isn't reaped as idle. */
  touch(sandboxId, now = nowMs()) {
    if (this.running.has(sandboxId)) this.running.set(sandboxId, now);
  }

  async hibernate(sandbox) {
    await getCell(sandbox).stop();
    setSandboxState(sandbox.id, "stopped");
    this.running.delete(sandbox.id);
    return { state: "stopped" };
  }

  /** Hibernate the least-recently-active running Cell. Returns its sandboxId. */
  async _evictLRU() {
    let victimId = null, oldest = Infinity;
    for (const [id, last] of this.running) if (last < oldest) { oldest = last; victimId = id; }
    if (!victimId) return null;
    const sandbox = getSandbox(victimId);
    if (sandbox) await this.hibernate(sandbox);
    else this.running.delete(victimId);
    return victimId;
  }

  /** Hibernate every Cell idle longer than idleMs. Returns the sandboxIds reaped. */
  async reapIdle(now = nowMs()) {
    const reaped = [];
    for (const [id, last] of [...this.running]) {
      if (now - last > this.idleMs) {
        const sandbox = getSandbox(id);
        if (sandbox) { await this.hibernate(sandbox); reaped.push(id); }
        else this.running.delete(id);
      }
    }
    return reaped;
  }
}
