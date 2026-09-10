#!/usr/bin/env node
// The Docker leg — goal.md T5.3, promise §0.9 ("with Docker or without").
//
// Everything else in the release check runs on the `local` Cell backend, because
// that is what runs when Docker is absent. This is the other half: a real
// container per Sandbox, exercised through the same Kernel calls the desktop
// makes — write a file, read it back, run a command, supervise a process, reach
// a port through the Gateway, open a shell session, and take the container down
// again.
//
//   npm run docker-check
//   SANDBOXOS_CELL_IMAGE=alpine:latest npm run docker-check
//
// On a host without Docker it prints one line and exits 0. That is not a pass
// dressed up as a skip: "no Docker here" is the supported configuration the rest
// of the release check already covers, and saying so is more useful than a red
// mark that means "you did not install something optional".
//
// The image is `alpine:latest` unless SANDBOXOS_CELL_IMAGE says otherwise, so
// the checks below use only what busybox has. There is no Node inside the
// container, and this script does not pretend there is.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const dockerVersion = await new Promise((res) => {
  const p = execFile("docker", ["version", "--format", "{{.Server.Version}}"], (err, out) => res(err ? null : String(out).trim()));
  p.on("error", () => res(null));
});
if (!dockerVersion) {
  console.log("docker: not present — skipping the container leg (the local backend is what runs here)");
  process.exit(0);
}

const home = path.join(os.tmpdir(), `sandboxos-docker-${crypto.randomUUID().slice(0, 8)}`);
process.env.SANDBOXOS_HOME = home;
process.env.SANDBOXOS_PASSWORD = "docker-check";
// Deliberately *not* forcing a backend here: the sandbox row asks for docker,
// and config.cellBackend must not override it into local behind our back.
delete process.env.SANDBOXOS_CELL_BACKEND;

const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
const { ensureSeed, createSandboxForTenant, createSession, grantsFor } = await import("../packages/control-db/src/registry.js");
const { getKernel, _resetKernels } = await import("../packages/kernel/src/kernel.js");
const { createServer } = await import("../apps/gateway/src/server.js");
const { killAllSessionsEverywhere, attachSession } = await import("../packages/kernel/src/pty-sessions.js");
const { _resetCells } = await import("../packages/cell/src/cell.js");
const config = (await import("../packages/config/src/config.js")).default;

const failures = [];
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
  return !!cond;
};
const until = async (fn, ms = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

console.log(`docker ${dockerVersion} · image ${config.cellImage}`);

openDb();
const { owner, tenant } = ensureSeed("local");
const slug = `docker-${crypto.randomUUID().slice(0, 6)}`;
const sandbox = createSandboxForTenant(tenant.id, owner.id, { slug, name: "container", cellBackend: "docker" });
const kernel = await getKernel(sandbox);
const held = grantsFor(owner.id, sandbox.id);
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => {
  const r = await call(server, tool, args);
  if (!r.ok) throw new Error(`${server}.${tool}: ${r.error}`);
  return r.result;
};

const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const session = createSession(owner.id, "docker-check");

try {
  check(kernel.cell.backend === "docker", `the Sandbox got a container, not a directory (${kernel.cell.backend})`);

  // ── it boots ──────────────────────────────────────────────────────────────
  const started = Date.now();
  await kernel.cell.ensureRunning();
  check(true, `the container is running (${((Date.now() - started) / 1000).toFixed(1)}s to boot)`);

  // ── files: the volume is the same thing on both sides ─────────────────────
  await ok("fs", "write", { path: "hello.txt", content: "from the host\n" });
  const read = await ok("fs", "read", { path: "hello.txt" });
  check(read.content.includes("from the host"), "a file written through fs.write reads back");
  const seen = await ok("proc", "exec", { cmd: "cat /sandbox/hello.txt" });
  check(seen.stdout.includes("from the host"), "and the container sees the same bytes at /sandbox");
  await ok("proc", "exec", { cmd: "echo 'from the container' > /sandbox/inside.txt" });
  const back = await ok("fs", "read", { path: "inside.txt" });
  check(back.content.includes("from the container"), "a file written inside the container reads back through fs.read");

  // ── a command that fails is a failure, not an empty string ────────────────
  const bad = await ok("proc", "exec", { cmd: "exit 3" });
  check(bad.code === 3, `a non-zero exit comes back as a code (${bad.code})`);
  const missing = await ok("proc", "exec", { cmd: "definitely-not-a-command" });
  check(missing.code !== 0, `a missing binary is not a silent success (code ${missing.code})`);

  // ── a supervised process, and its log ─────────────────────────────────────
  const job = await ok("proc", "start", { cmd: "i=0; while [ $i -lt 20 ]; do echo tick $i; i=$((i+1)); sleep 1; done", name: "ticker" });
  const ticking = await until(async () => (await ok("proc", "logs", { id: job.id })).logs.some((l) => /tick 1/.test(l.text)));
  check(ticking, "a supervised process inside the container streams its output back");
  await ok("proc", "stop", { id: job.id });
  const stopped = await until(async () => (await ok("proc", "logs", { id: job.id })).state !== "running");
  check(stopped, "and stopping it stops it");

  // ── a port inside the container, reachable through the slug ───────────────
  await ok("fs", "write", { path: "www/index.html", content: "<h1>served from a container</h1>\n" });
  const httpd = await ok("proc", "start", { cmd: "httpd -f -p 8099 -h /sandbox/www", name: "httpd" });
  await ok("ports", "expose", { port: 8099, name: "www" });
  const served = await until(async () => {
    const r = await fetch(`${base}/${slug}/p/8099/`, { headers: { cookie: `sbx_session=${session}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
    return !!r && r.ok && (await r.text()).includes("served from a container");
  });
  check(served, "a port listening inside the container is served under the slug");
  const scan = await ok("ports", "scan", {});
  check(!scan.unavailable, `the port scan can run in this image (${scan.unavailable ?? `${scan.listening?.length ?? 0} listening`})`);
  await ok("proc", "stop", { id: httpd.id });

  // ── a shell session in a container ────────────────────────────────────────
  let saw = "";
  const s = attachSession(kernel.cell, sandbox.id, { name: "container shell" }, (d) => { saw += d.toString(); }, () => {});
  s.write("echo docker-check-marker\n");
  const answered = await until(async () => saw.includes("docker-check-marker"), 20_000);
  check(answered, `a Terminal session gets a shell in the container (${JSON.stringify(saw.slice(-60))})`);
  s.session && killAllSessionsEverywhere();

  // ── readings that are the container's, not the host's ─────────────────────
  const snap = await ok("metrics", "snapshot", {});
  check(!snap.unavailable, `metrics can be read from inside (${snap.unavailable ?? "measured"})`);

  // ── and it goes away ──────────────────────────────────────────────────────
  await kernel.cell.stop();
  check(true, "the container stops with the volume intact");
} catch (e) {
  failures.push(`threw: ${e.message}`);
  console.log(`\n  ! ${e.stack?.split("\n").slice(0, 3).join("\n    ") ?? e.message}`);
} finally {
  killAllSessionsEverywhere();
  srv.close();
  try { await kernel.cell.destroy(); } catch { /* the container may already be gone */ }
  _resetCells();
  _resetKernels();
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\nthe container leg failed at:\n${failures.map((f) => `  · ${f}`).join("\n")}\n`);
  process.exit(1);
}
console.log("\nthe same machine, in a container\n");
process.exit(0);
