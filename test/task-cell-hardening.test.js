// Test suite for Cell Execution Substrate Hardening and Egress Security
// Criteria covered:
// C1: Every spawn/execFile child process has an error listener attached at instantiation time, preventing unhandled crash events.
// C2: Process supervision reliably recovers, tracks exit states, and handles line-buffered log ring streams without orphaned processes.
// C3: Hardened Cell execution substrate and egress security: Cell backend execution enforces process supervision recovery, strict egress network policies, and isolated execution across local, docker, and microVM backends without unhandled child failures.

import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { safeSpawn } from "../packages/cell/src/spawn.js";
import { LocalBackend } from "../packages/cell/src/local-backend.js";
import { DockerBackend } from "../packages/cell/src/docker-backend.js";
import { HardenedDockerBackend } from "../packages/cell/src/hardened-docker-backend.js";
import { FirecrackerBackend } from "../packages/cell/src/firecracker-backend.js";
import { resolveBackend } from "../packages/cell/src/cell.js";
import { isBlockedAddress, resolveAndGuard, egressAllowed } from "../packages/kernel/src/servers/net.js";
import {
  restoreJobs, stopAllProcsEverywhere, _resetJobRestore,
} from "../packages/kernel/src/servers/proc.js";
import { clearJobs } from "../packages/kernel/src/servers/job-store.js";

let owner, sandbox, held, kernel;

const call = (srv, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: srv, tool, args });

const ok = async (srv, tool, args) => {
  const r = await call(srv, tool, args);
  assert.ok(r.ok, `${srv}.${tool}: ${r.error}`);
  return r.result;
};

const until = async (fn, ms = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});

test.after(() => {
  stopAllProcsEverywhere();
  clearJobs(sandbox);
  _resetKernels();
  closeDb();
});

// ═════════════════════════════════════════════════════════════════════════════
// Criterion C1: Error listener attachment at instantiation time & crash prevention
// ═════════════════════════════════════════════════════════════════════════════

test("C1: safeSpawn attaches error listener immediately when binary does not exist", async () => {
  let callbackError = null;
  let eventError = null;

  const child = safeSpawn("this-binary-definitely-does-not-exist-xyz123", ["--arg"], {}, (err) => {
    callbackError = err;
  });

  child.on("error", (err) => {
    eventError = err;
  });

  // Wait for the async ENOENT error event to dispatch without crashing the process
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(callbackError, "onError callback must be invoked on spawn failure");
  assert.equal(callbackError.code, "ENOENT");
  assert.ok(eventError, "error event must be emitted and captured by attached listener");
  assert.equal(eventError.code, "ENOENT");
  assert.equal(child.spawnError.code, "ENOENT");
});

test("C1: safeSpawn catches synchronous spawn errors and provides synthetic child", async () => {
  let callbackError = null;
  let eventError = null;

  // Passing invalid binary argument type causes spawn to throw synchronously on Node.js
  const child = safeSpawn(12345, [], {}, (err) => {
    callbackError = err;
  });

  assert.ok(child, "safeSpawn must return an emitter even when spawn throws synchronously");
  assert.equal(child.pid, null);
  assert.equal(typeof child.kill, "function");
  assert.equal(child.kill(), false);

  child.on("error", (err) => {
    eventError = err;
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(callbackError || child.spawnError, "synchronous error must be caught and stashed");
  assert.ok(eventError || child.spawnError, "error must be reported without uncaught exception crash");
});

test("C1: LocalBackend handles failed command without unhandled error", async () => {
  const backend = new LocalBackend(sandbox);
  try {
    // Nonexistent binary via exec
    const res = await backend.exec("/nonexistent/binary/xyz-404");
    assert.ok(res.code !== 0, "nonexistent binary should return non-zero exit code");

    // execStream with failing command
    let doneEvent = null;
    await new Promise((resolve) => {
      backend.execStream("/nonexistent/binary/xyz-404", (ev) => {
        if (ev.type === "done") {
          doneEvent = ev;
          resolve();
        }
      });
    });
    assert.ok(doneEvent, "done event must be delivered even for broken command");
    assert.ok(doneEvent.code !== 0 || doneEvent.failure, "failure must be indicated");
  } finally {
    await backend.cleanup();
  }
});

test("C1: backend detection helpers handle missing CLI tools safely", async () => {
  const tier = await resolveBackend();
  assert.ok(["firecracker", "hardened-docker", "docker", "local"].includes(tier),
    `resolveBackend returned valid tier: ${tier}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Criterion C2: Process supervision recovery, exit states, and ring buffering
// ═════════════════════════════════════════════════════════════════════════════

test("C2: supervised process logs handle interleaved stdout and stderr without tearing", async () => {
  // Run a command that writes alternating stdout and stderr chunks
  const script = `
    printf "out-line-1\\npart-out-"
    sleep 0.1
    >&2 printf "err-line-1\\npart-err-"
    sleep 0.1
    printf "finish\\n"
    sleep 0.1
    >&2 printf "finish\\n"
  `;
  const job = await ok("proc", "start", { cmd: `/bin/sh -c '${script}'`, name: "stream-test" });

  assert.ok(await until(async () => {
    const info = await ok("proc", "logs", { id: job.id });
    return info.state !== "running";
  }, 10_000), "job should finish running");

  const info = await ok("proc", "logs", { id: job.id });
  const stdoutLines = info.logs.filter((l) => l.stream === "stdout").map((l) => l.text);
  const stderrLines = info.logs.filter((l) => l.stream === "stderr").map((l) => l.text);

  assert.ok(stdoutLines.includes("out-line-1"), "complete stdout line retained");
  assert.ok(stdoutLines.includes("part-out-finish"), "re-assembled stdout partial chunk retained without tearing");
  assert.ok(stderrLines.includes("err-line-1"), "complete stderr line retained");
  assert.ok(stderrLines.includes("part-err-finish"), "re-assembled stderr partial chunk retained without tearing");

  await ok("proc", "forget", { id: job.id });
});

test("C2: process exit state tracking (running -> exited, running -> failed, running -> stopped)", async () => {
  // Successful exit
  const jobOk = await ok("proc", "start", { cmd: "exit 0", name: "exit-zero" });
  assert.ok(await until(async () => (await ok("proc", "logs", { id: jobOk.id })).state !== "running"));
  const viewOk = await ok("proc", "logs", { id: jobOk.id });
  assert.equal(viewOk.state, "exited");
  assert.equal(viewOk.code, 0);
  await ok("proc", "forget", { id: jobOk.id });

  // Failed exit
  const jobFail = await ok("proc", "start", { cmd: "exit 42", name: "exit-nonzero" });
  assert.ok(await until(async () => (await ok("proc", "logs", { id: jobFail.id })).state !== "running"));
  const viewFail = await ok("proc", "logs", { id: jobFail.id });
  assert.equal(viewFail.state, "failed");
  assert.equal(viewFail.code, 42);
  await ok("proc", "forget", { id: jobFail.id });

  // Explicit stop
  const jobStop = await ok("proc", "start", { cmd: "sleep 30", name: "stop-test" });
  const stopRes = await ok("proc", "stop", { id: jobStop.id });
  assert.equal(stopRes.stopped, true);
  const viewStop = await ok("proc", "logs", { id: jobStop.id });
  assert.equal(viewStop.state, "stopped");
  await ok("proc", "forget", { id: jobStop.id });
});

test("C2: supervised process restart recovery preserves IDs and history", async () => {
  clearJobs(sandbox);
  const job = await ok("proc", "start", { cmd: "sleep 30", name: "recover-me" });

  // Gateway dies / stops all procs
  stopAllProcsEverywhere();
  assert.deepEqual((await ok("proc", "jobs")).jobs, []);

  // Simulate restart
  _resetJobRestore();
  const res = await restoreJobs(kernel.cell, sandbox);
  assert.equal(res.restored, 1);

  const jobsList = (await ok("proc", "jobs")).jobs;
  const restored = jobsList.find((j) => j.id === job.id);
  assert.ok(restored, "job recovered under its original id");
  assert.equal(restored.state, "running");
  assert.equal(restored.cmd, "sleep 30");

  await ok("proc", "stop", { id: job.id });
  clearJobs(sandbox);
});

// ═════════════════════════════════════════════════════════════════════════════
// Criterion C3: Hardened Cell execution substrate and egress security
// ═════════════════════════════════════════════════════════════════════════════

test("C3: all Cell backends implement the unified contract and cleanup method", async () => {
  const dummySandbox = { id: "test-sbx", volume_path: "/tmp", cell_backend: "local" };
  const backends = [
    new LocalBackend(dummySandbox),
    new DockerBackend(dummySandbox),
    new HardenedDockerBackend(dummySandbox),
    new FirecrackerBackend(dummySandbox),
  ];

  for (const b of backends) {
    assert.equal(typeof b.exec, "function", `${b.constructor.name} has exec`);
    assert.equal(typeof b.execStream, "function", `${b.constructor.name} has execStream`);
    assert.equal(typeof b.execInteractive, "function", `${b.constructor.name} has execInteractive`);
    assert.equal(typeof b.cleanup, "function", `${b.constructor.name} has async cleanup`);
    assert.equal(typeof b.endpoint, "function", `${b.constructor.name} has endpoint`);
    // Calling cleanup on unbooted backend must resolve safely
    await assert.doesNotReject(() => b.cleanup(), `${b.constructor.name}.cleanup must resolve cleanly`);
  }
});

test("C3: egress security blocks IPv4 private, loopback, CGNAT, multicast, and reserved ranges", () => {
  const blockedV4 = [
    "127.0.0.1", "127.1.2.3",           // loopback
    "10.0.0.1", "10.254.0.1",           // RFC1918 10/8
    "172.16.0.1", "172.31.255.254",     // RFC1918 172.16/12
    "192.168.0.1", "192.168.1.1",       // RFC1918 192.168/16
    "169.254.169.254",                  // AWS/cloud link-local metadata
    "0.0.0.0",                          // this host
    "100.64.0.1", "100.127.255.254",    // CGNAT RFC6598
    "224.0.0.1", "239.255.255.255",     // multicast
    "240.0.0.1", "255.255.255.255",     // reserved / broadcast
    "192.0.2.1", "198.51.100.1", "203.0.113.1", // documentation
    "198.18.0.1", "198.19.255.254",     // benchmarking
  ];

  for (const ip of blockedV4) {
    assert.equal(isBlockedAddress(ip), true, `IPv4 address ${ip} must be blocked`);
    assert.equal(isBlockedAddress(`[${ip}]`), true, `bracketed IPv4 address [${ip}] must be blocked`);
  }

  // Allowed public addresses
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
  assert.equal(isBlockedAddress("93.184.216.34"), false);
});

test("C3: egress security blocks IPv6 loopback, link-local, unique-local, multicast, and hex IPv4-mapped forms", () => {
  const blockedV6 = [
    "::",                               // unspecified
    "::1",                              // loopback
    "fe80::1", "fe80::dead:beef",       // link-local
    "fc00::1", "fd00::1234",           // unique-local
    "ff02::1",                          // multicast
    "100::1",                           // discard
    "2001:db8::1",                      // documentation
    // Dotted-decimal IPv4-mapped IPv6
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    // Hexadecimal IPv4-mapped IPv6 (SSRF bypass attempt)
    "::ffff:7f00:1",                    // 127.0.0.1 in hex
    "::ffff:0a00:0001",                 // 10.0.0.1 in hex
    "::ffff:a9fe:a9fe",                 // 169.254.169.254 in hex
    "::ffff:c0a8:0101",                 // 192.168.1.1 in hex
    "::ffff:6440:0001",                 // 100.64.0.1 (CGNAT) in hex
    // 6to4 mapped addresses embedding private IPv4
    "2002:7f00:0001::",                 // 127.0.0.1
    "2002:0a00:0001::",                 // 10.0.0.1
    "2002:a9fe:a9fe::",                 // 169.254.169.254
  ];

  for (const ip of blockedV6) {
    assert.equal(isBlockedAddress(ip), true, `IPv6 address ${ip} must be blocked`);
    assert.equal(isBlockedAddress(`[${ip}]`), true, `bracketed IPv6 address [${ip}] must be blocked`);
  }

  // Allowed public IPv6
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
});

test("C3: egress policy enforcement and resolveAndGuard pin validated IP", async () => {
  // Domain policy filtering
  const policyAllow = { egress: "deny", allow: ["api.example.com", "*.trusted.org"] };
  assert.equal(egressAllowed(policyAllow, "api.example.com"), true);
  assert.equal(egressAllowed(policyAllow, "sub.trusted.org"), true);
  assert.equal(egressAllowed(policyAllow, "evil.com"), false);

  const policyDeny = { egress: "allow", deny: ["malicious.com", "*.blocked.net"] };
  assert.equal(egressAllowed(policyDeny, "example.com"), true);
  assert.equal(egressAllowed(policyDeny, "malicious.com"), false);
  assert.equal(egressAllowed(policyDeny, "sub.blocked.net"), false);

  // resolveAndGuard rejects private targets
  await assert.rejects(
    () => resolveAndGuard({ egress: "allow" }, "169.254.169.254"),
    /egress blocked/
  );
  await assert.rejects(
    () => resolveAndGuard({ egress: "allow" }, "[::ffff:7f00:1]"),
    /egress blocked/
  );

  // resolveAndGuard allows explicitly allowlisted private target
  const explicitlyAllowed = await resolveAndGuard(
    { egress: "allow", allow: ["127.0.0.1"] },
    "127.0.0.1"
  );
  assert.equal(explicitlyAllowed.ip, "127.0.0.1");
  assert.equal(explicitlyAllowed.family, 4);
});

test("C3: packages/kernel/src/servers/net.js - net.fetch blocks private IP and SSRF attempts through kernel", async () => {
  // SSRF attempts via net.fetch tool through kernel must be blocked
  const res1 = await call("net", "fetch", { url: "http://169.254.169.254/latest/meta-data" });
  assert.equal(res1.ok, false);
  assert.match(res1.error, /egress blocked/);

  // Hexadecimal IPv4-mapped IPv6 literal via net.fetch must be blocked
  const res2 = await call("net", "fetch", { url: "http://[::ffff:7f00:1]:8080" });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /egress blocked/);

  // CGNAT range via net.fetch must be blocked
  const res3 = await call("net", "fetch", { url: "http://100.64.0.1:8080" });
  assert.equal(res3.ok, false);
  assert.match(res3.error, /egress blocked/);
});
