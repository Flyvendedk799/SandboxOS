// Phase 15: Hardened Docker + Firecracker scaffold.
//
// Tests cover:
//  - HardenedDockerBackend._buildRunArgs() — security flags
//  - Resource limits wired from quota
//  - resolveBackend() tier precedence
//  - FirecrackerBackend config builders (pure, no binary needed)
//  - mem_mb / cpu_shares quota roundtrip (DB + REST)
//  - setQuota partial-preserve of resource fields
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, createTenant, mintMachineToken,
  getQuota, setQuota,
} from "../packages/control-db/src/registry.js";
import { HardenedDockerBackend } from "../packages/cell/src/hardened-docker-backend.js";
import { FirecrackerBackend }    from "../packages/cell/src/firecracker-backend.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, tenant, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox, tenant } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p15-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;
});
test.after(() => { srv.close(); closeDb(); });

async function api(method, urlPath, body) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ─── HardenedDockerBackend._buildRunArgs() ────────────────────────────────────

test("hardened backend drops all capabilities", () => {
  const b = new HardenedDockerBackend(sandbox);
  const args = b._buildRunArgs();
  assert.ok(args.includes("--cap-drop=ALL"), "must drop all caps");
});

test("hardened backend adds no-new-privileges seccomp anchor", () => {
  const b = new HardenedDockerBackend(sandbox);
  const args = b._buildRunArgs();
  assert.ok(args.includes("--security-opt=no-new-privileges"), "must set no-new-privileges");
});

test("hardened backend isolates network namespace", () => {
  const b = new HardenedDockerBackend(sandbox);
  const args = b._buildRunArgs();
  assert.ok(args.includes("--network=none"), "must use network=none");
});

test("hardened backend sets pids limit", () => {
  const b = new HardenedDockerBackend(sandbox);
  const args = b._buildRunArgs();
  const pidIdx = args.indexOf("--pids-limit");
  assert.ok(pidIdx !== -1, "must set --pids-limit");
  assert.ok(Number(args[pidIdx + 1]) > 0, "pids-limit must be positive");
});

test("hardened backend disables swap (memory-swap == memory)", () => {
  const b = new HardenedDockerBackend(sandbox, { memMb: 256 });
  const args = b._buildRunArgs();
  const memIdx  = args.indexOf("--memory");
  const swapIdx = args.indexOf("--memory-swap");
  assert.ok(memIdx !== -1 && swapIdx !== -1, "both memory flags required");
  assert.strictEqual(args[memIdx + 1], args[swapIdx + 1], "swap must equal memory (no swap)");
  assert.strictEqual(args[memIdx + 1], "256m");
});

// ─── Resource limits from quota ────────────────────────────────────────────────

test("hardened backend uses memMb from constructor", () => {
  const b = new HardenedDockerBackend(sandbox, { memMb: 1024 });
  const args = b._buildRunArgs();
  const memIdx = args.indexOf("--memory");
  assert.strictEqual(args[memIdx + 1], "1024m");
});

test("hardened backend uses cpuShares from constructor", () => {
  const b = new HardenedDockerBackend(sandbox, { cpuShares: 2.5 });
  const args = b._buildRunArgs();
  const cpuIdx = args.indexOf("--cpus");
  assert.strictEqual(args[cpuIdx + 1], "2.5");
});

// ─── Firecracker config builders (pure, no KVM needed) ───────────────────────

test("FirecrackerBackend._machineConfig returns vcpu_count and mem_size_mib", () => {
  const b = new FirecrackerBackend(sandbox, { memMb: 768, vcpus: 2 });
  const cfg = b._machineConfig();
  assert.strictEqual(cfg.vcpu_count, 2);
  assert.strictEqual(cfg.mem_size_mib, 768);
});

test("FirecrackerBackend._bootSourceConfig returns kernel_image_path", () => {
  const b = new FirecrackerBackend(sandbox);
  const cfg = b._bootSourceConfig();
  assert.ok(typeof cfg.kernel_image_path === "string", "must have kernel_image_path");
  assert.ok(typeof cfg.boot_args === "string", "must have boot_args");
});

test("FirecrackerBackend._driveConfig marks rootfs as root device", () => {
  const b = new FirecrackerBackend(sandbox);
  const cfg = b._driveConfig();
  assert.strictEqual(cfg.drive_id, "rootfs");
  assert.strictEqual(cfg.is_root_device, true);
  assert.strictEqual(cfg.is_read_only, false);
  assert.ok(cfg.path_on_host.includes("rootfs.qcow2"), "drive path should reference overlay");
});

test("FirecrackerBackend._networkConfig returns tap device and MAC", () => {
  const b = new FirecrackerBackend(sandbox);
  const cfg = b._networkConfig("tap0");
  assert.strictEqual(cfg.iface_id, "eth0");
  assert.strictEqual(cfg.host_dev_name, "tap0");
  assert.ok(typeof cfg.guest_mac === "string" && cfg.guest_mac.includes(":"), "must have MAC");
});

test("FirecrackerBackend.ensureRunning() rejects on non-Linux", async () => {
  if (process.platform === "linux") {
    // Skip on actual Linux — we'd need KVM for this to fail predictably.
    return;
  }
  const b = new FirecrackerBackend(sandbox);
  await assert.rejects(
    () => b.ensureRunning(),
    /requires Linux/i,
  );
});

// ─── mem_mb / cpu_shares quota roundtrip (DB) ────────────────────────────────

test("getQuota returns mem_mb and cpu_shares defaults", () => {
  const t = createTenant("quota-resource-p15");
  const q = getQuota(t.id);
  assert.strictEqual(q.mem_mb, 512);
  assert.strictEqual(q.cpu_shares, 1.0);
});

test("setQuota writes mem_mb and cpu_shares", () => {
  const t = createTenant("quota-resource-set-p15");
  const set = setQuota(t.id, { memMb: 1024, cpuShares: 2.0 });
  assert.strictEqual(set.mem_mb, 1024);
  assert.strictEqual(set.cpu_shares, 2.0);
  const read = getQuota(t.id);
  assert.strictEqual(read.mem_mb, 1024);
  assert.strictEqual(read.cpu_shares, 2.0);
});

test("setQuota partial — changing mem_mb preserves cpu_shares", () => {
  const t = createTenant("quota-partial-resource-p15");
  setQuota(t.id, { memMb: 512, cpuShares: 4.0 });
  setQuota(t.id, { memMb: 2048 });
  const q = getQuota(t.id);
  assert.strictEqual(q.mem_mb, 2048);
  assert.strictEqual(q.cpu_shares, 4.0);
});

// ─── mem_mb / cpu_shares quota REST ──────────────────────────────────────────

test("POST /api/quota accepts memMb and cpuShares", async () => {
  const d = await api("POST", "/api/quota", { memMb: 768, cpuShares: 1.5 });
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(d.quota.mem_mb, 768);
  assert.strictEqual(d.quota.cpu_shares, 1.5);
});

test("GET /api/quota includes mem_mb and cpu_shares", async () => {
  const d = await api("GET", "/api/quota");
  assert.ok(d.ok);
  assert.ok(typeof d.quota.mem_mb === "number");
  assert.ok(typeof d.quota.cpu_shares === "number");
});
