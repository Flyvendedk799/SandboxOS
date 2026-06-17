// Phase 18: Out-of-process marketplace server isolation (backlog #12 — the real fix).
// Untrusted marketplace MCP servers must run in a SEPARATE process with no handle to
// the control plane, while still being governed by the Kernel's authorize + audit path.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, queryAudit } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { loadManifest } from "../packages/manifest/src/manifest.js";

const PROBE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/isolation-probe.js");

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  const inst = await call("mcp-registry", "install", { name: "probe", source: PROBE });
  assert.ok(inst.ok, JSON.stringify(inst));
});
test.after(async () => {
  await call("mcp-registry", "uninstall", { name: "probe" }).catch(() => {});
  _resetKernels(); // kills any out-of-process children
  closeDb();
});

test("marketplace tool is reachable through the Kernel", async () => {
  const r = await call("probe", "whoami", {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.result.pid > 0);
});

test("marketplace code runs in a SEPARATE process (#12)", async () => {
  const r = await call("probe", "whoami", {});
  assert.notStrictEqual(
    r.result.pid, process.pid,
    "marketplace code must NOT execute in the control-plane process",
  );
});

test("marketplace server gets NO host context — no cell/sandbox/kernel handle (#12)", async () => {
  const r = await call("probe", "whoami", {});
  assert.deepEqual(r.result.depsKeys, [], "factory deps must be empty");
  assert.deepEqual(r.result.ctxKeys, [], "tool ctx must be empty");
});

test("the out-of-process call is still authorized (default-deny) by the Kernel", async () => {
  // A caller lacking the capability is denied BEFORE the child is ever consulted.
  const denied = await kernel.call({
    principalId: owner.id, heldPatterns: ["fs.read"], server: "probe", tool: "whoami", args: {},
  });
  assert.ok(!denied.ok);
  assert.equal(denied.code, "denied");
});

test("the out-of-process call is audited like any other tool call", async () => {
  await call("probe", "whoami", {});
  const rows = queryAudit(sandbox.id, { server: "probe", tool: "whoami", limit: 10 });
  assert.ok(rows.some((r) => r.result_kind === "ok"), "expected an audited ok row for probe.whoami");
});

test("install recorded provenance (source + sha256 hash) for the marketplace server (#12)", () => {
  const m = loadManifest(sandbox);
  const meta = (m.installedMeta ?? {}).probe;
  assert.ok(meta, "installedMeta.probe should exist");
  assert.equal(meta.source, PROBE);
  assert.match(meta.hash ?? "", /^[0-9a-f]{64}$/, "hash should be a sha256 hex digest");
});

test("uninstall kills the child and removes the tool from the catalog", async () => {
  await call("mcp-registry", "uninstall", { name: "probe" });
  assert.ok(!kernel.listTools().some((t) => t.name === "probe.whoami"), "probe.whoami should be gone");
  // Reinstall so test.after's uninstall is a no-op-safe cleanup and other ordering holds.
  await call("mcp-registry", "install", { name: "probe", source: PROBE });
});
