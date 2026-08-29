// Phase 21: the desktop's data plane.
//   • raw file transfer — streamed download and upload, contained and audited
//   • metrics server    — snapshot / history / activity rollups
//   • kernel.tools      — the catalogue the palette and completion are built on
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, queryAudit, auditRollup } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let kernel, owner, sandbox, held, server, base, cookie;
const call = (srv, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: srv, tool, args });
const ok = async (srv, tool, args) => {
  const r = await call(srv, tool, args);
  assert.ok(r.ok, `${srv}.${tool}: ${r.error}`);
  return r.result;
};
const auth = (extra = {}) => ({ Cookie: cookie, ...extra });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  cookie = r.headers.getSetCookie()[0].split(";")[0];
});
test.after(() => { server.close(); _resetKernels(); closeDb(); });

const fileUrl = (p, q = "") => `${base}/${sandbox.slug}/file?path=${encodeURIComponent(p)}${q}`;

// ── Raw file transfer ────────────────────────────────────────────────────────

test("PUT /:slug/file streams an upload into the Cell", async () => {
  const body = "line one\nline two\n";
  const r = await fetch(fileUrl("p21/upload.txt"), { method: "PUT", headers: auth(), body });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.bytes, Buffer.byteLength(body));

  const { content } = await ok("fs", "read", { path: "p21/upload.txt" });
  assert.equal(content, body, "the uploaded bytes must be what the fs server reads back");
});

test("GET /:slug/file streams the file back with a useful content type", async () => {
  const r = await fetch(fileUrl("p21/upload.txt"), { headers: auth() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain/);
  assert.equal(await r.text(), "line one\nline two\n");
});

test("binary content survives a PUT/GET round trip byte for byte", async () => {
  const payload = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);
  const put = await fetch(fileUrl("p21/blob.bin"), { method: "PUT", headers: auth(), body: payload });
  assert.equal(put.status, 200);
  const got = Buffer.from(await (await fetch(fileUrl("p21/blob.bin"), { headers: auth() })).arrayBuffer());
  assert.deepEqual(got, payload);
});

test("?download=1 asks the browser to save rather than render", async () => {
  const r = await fetch(fileUrl("p21/upload.txt", "&download=1"), { headers: auth() });
  assert.match(r.headers.get("content-disposition"), /attachment; filename="upload\.txt"/);
});

test("a streamed upload is audited like the fs.write it stands in for", async () => {
  await fetch(fileUrl("p21/audited.txt"), { method: "PUT", headers: auth(), body: "x" });
  const events = queryAudit(sandbox.id, { server: "fs", tool: "write", limit: 50 });
  assert.ok(
    events.some((e) => (e.args_json ?? "").includes("p21/audited.txt")),
    "the streamed path must appear in the audit log",
  );
});

test("file transfer refuses to escape the Cell volume", async () => {
  for (const p of ["../escape.txt", "p21/../../escape.txt", "../../../etc/passwd"]) {
    const put = await fetch(fileUrl(p), { method: "PUT", headers: auth(), body: "nope" });
    assert.equal(put.status, 400, `PUT ${p} must be refused`);
    const get = await fetch(fileUrl(p), { headers: auth() });
    assert.equal(get.status, 400, `GET ${p} must be refused`);
  }
  assert.ok(!fs.existsSync(path.join(sandbox.volume_path, "..", "escape.txt")));
});

test("an absolute path means the Sandbox's root, not the host's", async () => {
  // A slug is a machine: inside it, /etc/hosts is that machine's /etc/hosts.
  // The write must land in the volume and must not touch the host file.
  const put = await fetch(fileUrl("/etc/hosts"), { method: "PUT", headers: auth(), body: "127.0.0.1 sandbox" });
  assert.equal(put.status, 200);
  assert.equal(
    fs.readFileSync(path.join(sandbox.volume_path, "etc", "hosts"), "utf8"),
    "127.0.0.1 sandbox",
  );
  assert.ok(!fs.readFileSync("/etc/hosts", "utf8").includes("127.0.0.1 sandbox"));
});

test("file transfer requires authentication", async () => {
  assert.equal((await fetch(fileUrl("p21/upload.txt"))).status, 401);
  assert.equal((await fetch(fileUrl("p21/upload.txt"), { method: "PUT", body: "x" })).status, 401);
});

test("GET on a directory and on a missing file are distinguishable", async () => {
  assert.equal((await fetch(fileUrl("p21"), { headers: auth() })).status, 400);
  assert.equal((await fetch(fileUrl("p21/nope.txt"), { headers: auth() })).status, 404);
});

// ── metrics server ───────────────────────────────────────────────────────────

test("metrics.snapshot reports the machine's shape", async () => {
  const s = await ok("metrics", "snapshot", {});
  assert.equal(s.sandbox.slug, sandbox.slug);
  assert.ok(s.servers.includes("metrics"));
  assert.ok(s.tools > 0);
  assert.ok(s.disk.bytes >= 0);
  assert.ok(s.hostUptimeMs > 0);
});

test("metrics.history accumulates a sample per snapshot", async () => {
  const before = (await ok("metrics", "history", {})).samples.length;
  await ok("metrics", "snapshot", {});
  const after = (await ok("metrics", "history", {})).samples;
  assert.equal(after.length, before + 1);
  assert.ok(after.at(-1).ts > 0);
});

test("metrics.activity rolls the audit log up by kind, server and tool", async () => {
  await ok("fs", "list", { path: "." });
  const a = await ok("metrics", "activity", { windowMs: 3_600_000 });
  assert.ok(a.total > 0);
  assert.ok(a.byKind.ok > 0);
  assert.ok(a.byServer.some((r) => r.server === "fs"));
  assert.ok(a.byTool.some((r) => r.server === "fs" && r.tool === "list"));
});

test("the activity histogram spans the whole window, not just the busy part", async () => {
  const a = await ok("metrics", "activity", { windowMs: 3_600_000 });
  assert.ok(a.histogram.length > 1, "a quiet stretch should read as a gap, not be omitted");
  assert.ok(a.histogram.some((b) => b.n === 0), "empty buckets are filled in");
  assert.equal(a.histogram.at(-1).ts - a.histogram.at(-2).ts, a.bucketMs, "buckets are evenly spaced");
});

test("auditRollup counts denials separately from errors", () => {
  const before = auditRollup(sandbox.id, 0);
  const total = Object.values(before.byKind).reduce((n, x) => n + x, 0);
  assert.equal(total, before.total);
});

// ── kernel.tools ─────────────────────────────────────────────────────────────

test("kernel.tools returns the whole catalogue with its servers", async () => {
  const r = await ok("kernel", "tools", {});
  assert.ok(r.tools.length > 20);
  assert.ok(r.servers.includes("fs"));
  const names = r.tools.map((t) => t.name);
  assert.ok(names.includes("fs.write"));
  assert.ok(names.includes("ports.expose"));
  assert.ok(names.includes("metrics.snapshot"));
  for (const t of r.tools) assert.ok(t.description, `${t.name} must document itself`);
});

test("the catalogue tracks the manifest — disabling a server removes its tools", async () => {
  await ok("mcp-registry", "disable", { server: "metrics" });
  const without = (await ok("kernel", "tools", {})).tools.map((t) => t.name);
  assert.ok(!without.some((n) => n.startsWith("metrics.")));
  await ok("mcp-registry", "enable", { server: "metrics" });
  const with_ = (await ok("kernel", "tools", {})).tools.map((t) => t.name);
  assert.ok(with_.some((n) => n.startsWith("metrics.")));
});
