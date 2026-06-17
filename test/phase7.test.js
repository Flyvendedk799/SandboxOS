// Phase 7: The Marketplace — SDK, install/uninstall, mcp-registry additions.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createMcpServer } from "../packages/sdk/src/index.js";
import { createServer } from "../apps/gateway/src/server.js";

const EXAMPLE_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/example-server/src/index.js",
);

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

// ═════════════════════════════════════════════════════════════════════════════
// 1. SDK shape
// ═════════════════════════════════════════════════════════════════════════════

test("createMcpServer returns a factory that produces a named server def", () => {
  const factory = createMcpServer({
    name: "test-sdk",
    tools: {
      ping: {
        description: "Pong.",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { pong: true }; },
      },
    },
  });
  assert.equal(typeof factory, "function");
  const serverDef = factory({});
  assert.equal(serverDef.name, "test-sdk");
  assert.ok(serverDef.tools.ping);
});

test("SDK factory ignores deps and still returns a valid server def", () => {
  const factory = createMcpServer({ name: "no-deps", tools: {} });
  const def = factory({ cell: null, kernel: null });
  assert.equal(def.name, "no-deps");
  assert.deepEqual(def.tools, {});
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. mcp-registry.list includes installed field
// ═════════════════════════════════════════════════════════════════════════════

test("mcp-registry.list includes installed array (empty before any installs)", async () => {
  const r = await call("mcp-registry", "list", {});
  assert.ok(r.ok, r.error);
  assert.ok(Array.isArray(r.result.available), "available should be array");
  assert.ok(Array.isArray(r.result.installed), "installed should be array");
  assert.ok(Array.isArray(r.result.enabled), "enabled should be array");
  assert.ok(r.result.available.includes("fs"), "fs in available");
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Install a marketplace server
// ═════════════════════════════════════════════════════════════════════════════

test("mcp-registry.install loads a file-based server and auto-enables it", async () => {
  const r = await call("mcp-registry", "install", { name: "hello", source: EXAMPLE_SERVER });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.installed, "hello");
  assert.ok(r.result.enabled.includes("hello"), "hello in enabled list");
});

test("after install, hello.greet appears in the kernel tool catalog", async () => {
  const tools = kernel.listTools().map((t) => t.name);
  assert.ok(tools.includes("hello.greet"), `hello.greet not found in: ${tools.join(", ")}`);
});

test("kernel.call on hello.greet returns the greeting", async () => {
  const r = await call("hello", "greet", { name: "SandboxOS" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.message, "Hello, SandboxOS!");
});

test("hello.greet with default name returns Hello, world!", async () => {
  const r = await call("hello", "greet", {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.message, "Hello, world!");
});

test("mcp-registry.list shows hello in both installed and enabled", async () => {
  const r = await call("mcp-registry", "list", {});
  assert.ok(r.result.installed.includes("hello"), "hello in installed");
  assert.ok(r.result.enabled.includes("hello"), "hello in enabled");
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Disable / re-enable a marketplace server
// ═════════════════════════════════════════════════════════════════════════════

test("mcp-registry.disable removes hello tools from the live catalog", async () => {
  const r = await call("mcp-registry", "disable", { server: "hello" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!r.result.enabled.includes("hello"));
  assert.ok(!kernel.listTools().some((t) => t.name === "hello.greet"), "greet gone after disable");
});

test("mcp-registry.enable re-enables a marketplace server (using installed entry)", async () => {
  const r = await call("mcp-registry", "enable", { server: "hello" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.result.enabled.includes("hello"));
  assert.ok(kernel.listTools().some((t) => t.name === "hello.greet"), "greet back after enable");
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Uninstall
// ═════════════════════════════════════════════════════════════════════════════

test("mcp-registry.uninstall removes hello from installed and enabled", async () => {
  const r = await call("mcp-registry", "uninstall", { name: "hello" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.uninstalled, "hello");
  assert.ok(!r.result.enabled.includes("hello"));
});

test("after uninstall, hello.greet is absent from the live catalog", async () => {
  assert.ok(!kernel.listTools().some((t) => t.name === "hello.greet"), "greet gone after uninstall");
});

test("mcp-registry.uninstall on non-installed server returns error", async () => {
  const r = await call("mcp-registry", "uninstall", { name: "hello" });
  assert.ok(!r.ok);
  assert.ok(r.error.includes("not installed"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. mcp-registry.enable rejects unknown server (not in CATALOG or installed)
// ═════════════════════════════════════════════════════════════════════════════

test("mcp-registry.enable throws for a completely unknown server", async () => {
  const r = await call("mcp-registry", "enable", { server: "does-not-exist" });
  assert.ok(!r.ok);
  assert.ok(r.error.includes("unknown server"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Kernel cache — same instance across two getKernel calls
// ═════════════════════════════════════════════════════════════════════════════

test("getKernel returns the same Kernel instance when called twice", async () => {
  const k2 = await getKernel(sandbox);
  assert.strictEqual(k2, kernel, "expected the same cached Kernel instance");
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Marketplace factory survives a rebuild() call
// ═════════════════════════════════════════════════════════════════════════════

test("_marketplaceFactories survive kernel.rebuild()", async () => {
  // Install, confirm, rebuild explicitly, confirm again.
  await call("mcp-registry", "install", { name: "hello2", source: EXAMPLE_SERVER });
  assert.ok(kernel.listTools().some((t) => t.name === "hello2.greet"), "hello2.greet present after install");
  kernel.rebuild();
  assert.ok(kernel.listTools().some((t) => t.name === "hello2.greet"), "hello2.greet still present after explicit rebuild");
  await call("mcp-registry", "uninstall", { name: "hello2" });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. HTTP: installed server reachable through the gateway POST /:slug/mcp
// ═════════════════════════════════════════════════════════════════════════════

async function withServer(fn) {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base, srv); } finally { srv.close(); }
}

async function loginCookie(base) {
  const r = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  return r.headers.getSetCookie()[0].split(";")[0];
}

test("POST /:slug/mcp can call an installed marketplace server tool", async () => {
  // Install the server first via kernel call.
  await call("mcp-registry", "install", { name: "hello3", source: EXAMPLE_SERVER });
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ server: "hello3", tool: "greet", args: { name: "HTTP" } }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.equal(data.result.message, "Hello, HTTP!");
  });
  await call("mcp-registry", "uninstall", { name: "hello3" });
});
