// Phase 1 core servers: mcp-registry, secrets, cron, net, self-admin kernel.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { cronTick } from "../packages/scheduler/src/cron-runner.js";
import { egressAllowed } from "../packages/kernel/src/servers/net.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

test("mcp-registry disables and re-enables a server, rebuilding the Kernel live", async () => {
  let r = await call("mcp-registry", "disable", { server: "pkg" });
  assert.ok(r.ok);
  assert.ok(!kernel.listTools().some((t) => t.name.startsWith("pkg.")), "pkg tools gone after disable");
  r = await call("mcp-registry", "enable", { server: "pkg" });
  assert.ok(r.ok);
  assert.ok(kernel.listTools().some((t) => t.name === "pkg.install"), "pkg tools back after enable");
});

test("protected servers (kernel, mcp-registry) cannot be disabled", async () => {
  const r = await call("mcp-registry", "disable", { server: "kernel" });
  assert.equal(r.ok, false);
  assert.match(r.error, /protected/);
});

test("secrets are reference-not-value", async () => {
  const put = await call("secrets", "put", { name: "API", value: "s3kr3t" });
  assert.equal(put.result.ref, "secret://API");
  const list = await call("secrets", "list", {});
  assert.ok(list.result.secrets.some((s) => s.name === "API"));
  assert.ok(!JSON.stringify(list.result).includes("s3kr3t"), "value never appears in list output");
  // useInEnv injects the value into the command env but returns only output.
  const used = await call("secrets", "useInEnv", { refs: ["secret://API"], cmd: "echo $API" });
  assert.match(used.result.stdout, /s3kr3t/);          // the command saw it
  assert.equal(used.result.value, undefined);          // the caller never gets the value field
});

test("cron schedules a job and the runner fires it on behalf of the scheduler", async () => {
  const at = await call("cron", "at", { delayMs: 10, server: "fs", tool: "write", args: { path: "cronned.txt", content: "tick" } });
  assert.ok(at.result.id);
  const { fired } = await cronTick(Date.now() + 1000);
  assert.ok(fired >= 1);
  const read = await call("fs", "read", { path: "cronned.txt" });
  assert.equal(read.result.content, "tick");
});

test("net egress policy gates fetch", async () => {
  // default-allow
  assert.ok(egressAllowed({ egress: "allow" }, "example.com"));
  assert.ok(!egressAllowed({ egress: "allow", deny: ["evil.com"] }, "evil.com"));
  // default-deny except allowlist (with wildcard)
  assert.ok(!egressAllowed({ egress: "deny", allow: [] }, "example.com"));
  assert.ok(egressAllowed({ egress: "deny", allow: ["*.anthropic.com"] }, "api.anthropic.com"));

  // and end-to-end through the server: switch net to deny, fetch is refused pre-network
  await call("mcp-registry", "configure", { server: "net", config: { egress: "deny", allow: [] } });
  const r = await call("net", "fetch", { url: "http://example.com" });
  assert.equal(r.ok, false);
  assert.match(r.error, /egress denied/);
  await call("mcp-registry", "configure", { server: "net", config: { egress: "allow", deny: [] } }); // restore
});

test("self-admin kernel server reports identity, capabilities, and manifest", async () => {
  assert.equal((await call("kernel", "whoami")).result.kind, "human");
  assert.deepEqual((await call("kernel", "capabilities")).result.capabilities, ["*"]);
  const m = (await call("kernel", "manifestGet")).result.manifest;
  assert.ok(m.servers.fs && m.servers.kernel);
  // auditQuery filters
  const denied = (await call("kernel", "auditQuery", { resultKind: "ok", limit: 5 })).result.events;
  assert.ok(denied.every((e) => e.result_kind === "ok"));
});

test("manifestSet must keep kernel + mcp-registry enabled", async () => {
  const r = await call("kernel", "manifestSet", { manifest: { name: "x", servers: { fs: {} } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /kernel \+ mcp-registry/);
});
