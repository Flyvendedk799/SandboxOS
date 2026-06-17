// Phase 13: Deferred Completions — secrets.useInEnv REST, audit cursor pagination,
// npm: marketplace installs.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken, queryAudit } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PKG = path.join(__dir, "fixtures", "mcp-test-server");

let owner, sandbox, kernel, held, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  kernel = await getKernel(sandbox);
  held = ["*"];
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p13-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;

  // Store a secret we can use in tests.
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "secrets", tool: "put", args: { name: "P13_KEY", value: "hello-p13" } });

  // Seed audit events for cursor pagination tests.
  for (let i = 0; i < 5; i++) {
    await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "list", args: { path: "." } });
  }
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

// ─── secrets.useInEnv kernel tests ──────────────────────────────────────────

test("secrets.useInEnv injects secret value as env var", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "secrets", tool: "useInEnv",
    args: { refs: ["secret://P13_KEY"], cmd: "echo $P13_KEY" },
  });
  assert.ok(r.ok, `useInEnv failed: ${r.error}`);
  assert.ok(r.result.stdout.includes("hello-p13"), `expected stdout to contain secret value, got: ${r.result.stdout}`);
});

test("secrets.useInEnv returns stdout stderr and code", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "secrets", tool: "useInEnv",
    args: { refs: ["secret://P13_KEY"], cmd: "echo ok && echo err >&2 && exit 0" },
  });
  assert.ok(r.ok);
  assert.ok(typeof r.result.stdout === "string");
  assert.ok(typeof r.result.stderr === "string");
  assert.strictEqual(r.result.code, 0);
});

test("secrets.useInEnv with unknown secret ref throws", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "secrets", tool: "useInEnv",
    args: { refs: ["secret://NONEXISTENT_P13"], cmd: "echo hi" },
  });
  assert.ok(!r.ok);
});

// ─── POST /:slug/secrets/:name/use REST tests ────────────────────────────────

test("POST /:slug/secrets/:name/use requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets/P13_KEY/use`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: "echo hi" }),
  });
  const d = await r.json();
  assert.strictEqual(r.status, 401);
  assert.ok(!d.ok);
});

test("POST /:slug/secrets/:name/use injects secret and returns stdout", async () => {
  const d = await api("POST", `/${sandbox.slug}/secrets/P13_KEY/use`, { cmd: "echo $P13_KEY" });
  assert.ok(d.ok, `expected ok, got: ${JSON.stringify(d)}`);
  assert.ok(d.stdout.includes("hello-p13"), `stdout: ${d.stdout}`);
});

test("POST /:slug/secrets/:name/use returns 400 when cmd missing", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets/P13_KEY/use`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const d = await r.json();
  assert.strictEqual(r.status, 400);
  assert.ok(!d.ok);
});

test("POST /:slug/secrets/:name/use non-zero exit code returned", async () => {
  const d = await api("POST", `/${sandbox.slug}/secrets/P13_KEY/use`, { cmd: "exit 42" });
  assert.ok(d.ok);
  assert.strictEqual(d.code, 42);
});

test("POST /:slug/secrets/:name/use with unknown secret returns error", async () => {
  const d = await api("POST", `/${sandbox.slug}/secrets/MISSING_P13/use`, { cmd: "echo hi" });
  assert.ok(!d.ok);
  assert.ok(typeof d.error === "string");
});

// ─── Audit cursor pagination unit tests ─────────────────────────────────────

test("queryAudit with cursor returns only events after cursor id", () => {
  const all = queryAudit(sandbox.id, { limit: 500 });
  assert.ok(all.length >= 5, `expected ≥5 events, got ${all.length}`);
  const mid = all[Math.floor(all.length / 2)];
  const after = queryAudit(sandbox.id, { cursor: mid.id });
  assert.ok(after.every((e) => e.id > mid.id), "event at-or-before cursor leaked in");
  assert.ok(after.length > 0, "expected events after cursor");
});

test("queryAudit cursor returns events in ascending order", () => {
  const all = queryAudit(sandbox.id);
  if (all.length < 2) return;
  const cursor = all[0].id;
  const paged = queryAudit(sandbox.id, { cursor, limit: 10 });
  for (let i = 1; i < paged.length; i++) {
    assert.ok(paged[i].id > paged[i - 1].id, "events not in ascending order");
  }
});

test("queryAudit cursor + server filter combined", () => {
  const all = queryAudit(sandbox.id, { server: "fs", limit: 500 });
  if (all.length < 2) return;
  const cursor = all[0].id;
  const paged = queryAudit(sandbox.id, { server: "fs", cursor, limit: 100 });
  assert.ok(paged.every((e) => e.server === "fs" && e.id > cursor));
});

test("queryAudit cursor past last event returns empty array", () => {
  const all = queryAudit(sandbox.id, { limit: 500 });
  const lastId = all[all.length - 1]?.id ?? 999_999_999;
  const empty = queryAudit(sandbox.id, { cursor: lastId + 999_999_999 });
  assert.deepStrictEqual(empty, []);
});

// ─── GET /:slug/audit?cursor= REST tests ────────────────────────────────────

test("GET /:slug/audit returns nextCursor when results fill limit", async () => {
  const d = await api("GET", `/${sandbox.slug}/audit?limit=2`);
  assert.ok(d.ok);
  // If there are ≥2 events (there are), nextCursor should be set.
  assert.ok(d.events.length <= 2);
  if (d.events.length === 2) {
    assert.ok(d.nextCursor !== null, "expected nextCursor when limit filled");
    assert.strictEqual(d.nextCursor, d.events[d.events.length - 1].id);
  }
});

test("GET /:slug/audit nextCursor is null when results < limit", async () => {
  // Use a huge limit that exceeds event count.
  const d = await api("GET", `/${sandbox.slug}/audit?limit=500`);
  assert.ok(d.ok);
  assert.strictEqual(d.nextCursor, null, "expected null nextCursor when all events fit in one page");
});

test("GET /:slug/audit?cursor= paginates forward", async () => {
  const first = await api("GET", `/${sandbox.slug}/audit?limit=2`);
  assert.ok(first.ok && first.events.length === 2 && first.nextCursor !== null);
  const second = await api("GET", `/${sandbox.slug}/audit?cursor=${first.nextCursor}`);
  assert.ok(second.ok);
  assert.ok(second.events.every((e) => e.id > first.nextCursor), "event at-or-before cursor leaked in");
});

test("GET /:slug/audit?cursor= returns ascending events", async () => {
  const d = await api("GET", `/${sandbox.slug}/audit?limit=3`);
  if (d.nextCursor === null) return; // not enough events
  const paged = await api("GET", `/${sandbox.slug}/audit?cursor=${d.nextCursor}&limit=10`);
  for (let i = 1; i < paged.events.length; i++) {
    assert.ok(paged.events[i].id > paged.events[i - 1].id);
  }
});

// ─── mcp-registry npm: install tests ────────────────────────────────────────

test("mcp-registry.install supports npm: prefix (local file: package)", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "mcp-registry", tool: "install",
    args: { name: "mcp-test-server", source: `npm:file:${FIXTURE_PKG}` },
  });
  assert.ok(r.ok, `install failed: ${r.error}`);
  assert.strictEqual(r.result.installed, "mcp-test-server");
  assert.ok(r.result.enabled.includes("mcp-test-server"));
});

test("installed npm: server responds to tool calls", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "mcp-test-server", tool: "ping", args: {},
  });
  assert.ok(r.ok, `ping failed: ${r.error}`);
  assert.deepStrictEqual(r.result, { pong: true });
});

test("mcp-registry.install npm: with bad package name fails gracefully", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "mcp-registry", tool: "install",
    args: { name: "no-such-thing-p13", source: "npm:this-package-absolutely-does-not-exist-p13xqz" },
  });
  assert.ok(!r.ok, "expected install to fail for non-existent npm package");
  assert.ok(r.error.includes("npm install failed") || r.error.includes("not found") || typeof r.error === "string");
});

test("mcp-registry.list shows npm-installed server in installed list", async () => {
  const r = await kernel.call({
    principalId: owner.id, heldPatterns: held,
    server: "mcp-registry", tool: "list", args: {},
  });
  assert.ok(r.ok);
  assert.ok(r.result.installed.includes("mcp-test-server"), "expected mcp-test-server in installed");
  assert.ok(r.result.enabled.includes("mcp-test-server"), "expected mcp-test-server enabled");
});
