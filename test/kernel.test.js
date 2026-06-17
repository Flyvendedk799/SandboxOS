import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, recentAudit } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";

let kernel, owner, sandbox, held;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id); // ['*']
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

test("the tool catalog is the union of all manifest-enabled servers", () => {
  const names = new Set(kernel.listTools().map((t) => t.name));
  for (const t of ["fs.read", "fs.write", "proc.exec", "cron.at", "net.fetch", "secrets.put", "mcp-registry.list", "kernel.whoami"]) {
    assert.ok(names.has(t), `expected ${t} in catalog`);
  }
});

test("fs.write → fs.read round-trips through the Cell", async () => {
  const w = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "write", args: { path: "hello.txt", content: "hi tide" } });
  assert.ok(w.ok, w.error);
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "read", args: { path: "hello.txt" } });
  assert.ok(r.ok);
  assert.equal(r.result.content, "hi tide");
});

test("fs.list reflects what was written", async () => {
  const l = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "list", args: { path: "." } });
  assert.ok(l.ok);
  assert.ok(l.result.entries.some((e) => e.name === "hello.txt"));
});

test("proc.exec runs a command in the Cell", async () => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "proc", tool: "exec", args: { cmd: "echo sandboxos" } });
  assert.ok(r.ok);
  assert.match(r.result.stdout, /sandboxos/);
});

test("default-deny: a caller without the capability is refused and audited", async () => {
  const res = await kernel.call({ principalId: owner.id, heldPatterns: ["fs.read"], server: "fs", tool: "write", args: { path: "x", content: "y" } });
  assert.equal(res.ok, false);
  assert.equal(res.code, "denied");
  const denied = recentAudit(sandbox.id, 50).filter((a) => a.result_kind === "denied" && a.tool === "write");
  assert.ok(denied.length >= 1, "denied call should be on the audit log");
});

test("path escape is rejected by the fs server", async () => {
  const res = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "read", args: { path: "../../etc/passwd" } });
  assert.equal(res.ok, false);
  assert.match(res.error, /escapes sandbox/);
});

test("a live audit event is emitted for each call", async () => {
  const seen = [];
  kernel.events.on("audit", (e) => seen.push(e));
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "proc", tool: "list", args: {} });
  assert.ok(seen.some((e) => e.server === "proc" && e.tool === "list"));
});
