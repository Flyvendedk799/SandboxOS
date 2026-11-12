// Braiwser — the Browser app is a real Chromium driven through Braiwser's driver.
//
// What is pinned here: what a page may reach (the per-request policy), how an
// address typed by a person is read, that a window's session is its own and is
// reaped when nobody looks, and the Gateway's front door (net.browse, a host with
// no runtime yet). Chromium itself is exercised only when a runtime is supplied:
//   SANDBOXOS_BRAIWSER_TEST_ROOT=<installed runtime> npm test
import { TEST_HOME } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

process.env.SANDBOXOS_BRAIWSER_ROOT = path.join(TEST_HOME, "no-braiwser-here");
process.env.SANDBOXOS_BRAIWSER_AUTOINSTALL = "0";

const { classify, normalizeAddress, guardPublic, blockedPage, BraiwserSessions, inspectRuntime, pin, loadDriver } =
  await import("../packages/braiwser/src/index.js");
const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
const { ensureSeed, createSession, mintMachineToken } = await import("../packages/control-db/src/registry.js");
const { createServer } = await import("../apps/gateway/src/server.js");
const { _resetKernels } = await import("../packages/kernel/src/kernel.js");

// ── the address bar ────────────────────────────────────────────────────────

test("an address is read the way a browser's address bar reads it", () => {
  assert.equal(normalizeAddress("example.com"), "https://example.com");
  assert.equal(normalizeAddress("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeAddress("http://example.com"), "http://example.com");
  assert.equal(normalizeAddress("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeAddress(":5173/app"), "http://localhost:5173/app");
  assert.equal(normalizeAddress("8080"), "http://localhost:8080/");
  assert.equal(normalizeAddress("how do ports work"), "https://duckduckgo.com/?q=how%20do%20ports%20work");
  assert.equal(normalizeAddress(""), "about:blank");
  assert.equal(normalizeAddress("javascript:alert(1)"), "https://duckduckgo.com/?q=javascript%3Aalert(1)", "never a script URL");
});

// ── what a page may reach ──────────────────────────────────────────────────

test("localhost means this machine's port, and nothing else private is reachable", () => {
  assert.deepEqual(classify("http://localhost:3000/x"), { kind: "port", port: 3000, secure: false, host: "localhost" });
  assert.equal(classify("http://127.0.0.1:8080/").kind, "port");
  assert.equal(classify("http://[::1]:8080/").kind, "port");
  assert.equal(classify("ws://localhost:5173/hmr").port, 5173);
  assert.equal(classify("http://app.localhost/").kind, "port");
  for (const bad of ["http://169.254.169.254/latest", "http://10.1.2.3/", "http://192.168.0.1/", "http://[fd00::1]/", "http://intranet/", "http://printer.local/", "http://metadata.google.internal/"]) {
    assert.equal(classify(bad).kind, "blocked", bad);
  }
  assert.equal(classify("https://example.com/").kind, "public");
  assert.equal(classify("http://8.8.8.8/").kind, "public");
  assert.equal(classify("data:text/html,hi").kind, "other");
});

test("a public name follows the machine's egress policy and may not resolve somewhere private", async () => {
  await assert.rejects(guardPublic({ egress: "deny", allow: [] }, "example.com", new Map()), /network policy/);
  await assert.rejects(guardPublic({ egress: "allow", deny: ["*.example.com"] }, "a.example.com", new Map()), /network policy/);
  // `localtest.me` style names point public DNS at loopback; the guard resolves first.
  const cache = new Map([["sneaky.test", { until: Date.now() + 60_000, error: "sneaky.test points at a private address, which this browser does not open." }]]);
  await assert.rejects(guardPublic(null, "sneaky.test", cache), /private address/);
});

test("the refusal page escapes what it repeats", () => {
  const html = blockedPage("http://x/<script>", "<b>nope</b>");
  assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;") && html.includes("&lt;b&gt;"));
});

// ── sessions, against a driver that records what it was asked ──────────────

function fakeDriver() {
  const opened = [];
  const driver = {
    opened,
    async open(o) {
      const routes = [];
      const pages = new Map();
      let n = 0;
      const mkPage = () => {
        const id = `pg_${++n}`;
        const raw = { _url: "about:blank", screenshot: async () => Buffer.from([0xff, 0xd8, 0xff]), viewportSize: () => o.viewport, title: async () => `t${id}`,
          setViewportSize: async (v) => { o.viewport = v; }, goto: async (u) => { raw._url = u; }, mouse: { click: async () => {} } };
        const page = { pageId: id, _raw: raw, url: () => raw._url, inputs: [],
          navigate: async (u) => { raw._url = u; return { outcome: "ready", status: 200 }; },
          humanInput: async (i) => { page.inputs.push(i); return { dispatched: true }; },
          close: async () => { pages.delete(id); } };
        pages.set(id, page);
        return page;
      };
      mkPage();
      const session = { pages, routes, closed: false, options: o,
        _context: { route: async (pattern, fn) => routes.push(fn), routeWebSocket: async () => {} },
        newPage: async () => mkPage(), close: async () => { session.closed = true; } };
      opened.push(session);
      return session;
    },
  };
  return driver;
}

function fakeRoute(url, { navigation = true } = {}) {
  const frame = { page: () => ({ mainFrame: () => frame }) };
  const r = { result: null,
    request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => frame, headers: () => ({}) }),
    continue: async (o) => { r.result = { continue: o ?? null }; },
    fulfill: async (o) => { r.result = { fulfill: o }; },
    abort: async (why) => { r.result = { abort: why }; } };
  return r;
}

test("every request a page makes is decided by the policy, port routing included", async () => {
  const driver = fakeDriver();
  const asked = [];
  const mgr = new BraiwserSessions({ loadDriver: () => driver,
    resolvePort: async (sbx, port) => { asked.push([sbx, port]); if (port !== 3000) throw new Error(`port ${port} is not open`); return { host: "10.9.0.7", port: 3000 }; } });
  const s = await mgr.open({ sandboxId: "sbx1", windowId: "w1", width: 900, height: 600 });
  const session = driver.opened[0];
  assert.equal(session.options.requestFilter("https://example.com"), "block", "the driver underneath denies by default");
  const route = session.routes[0];

  let r = fakeRoute("http://localhost:3000/app?x=1"); await route(r);
  assert.deepEqual(r.result, { continue: { url: "http://10.9.0.7:3000/app?x=1" } }, "into this Sandbox's Cell");
  assert.deepEqual(asked, [["sbx1", 3000]]);

  r = fakeRoute("http://localhost:4000/"); await route(r);
  assert.equal(r.result.fulfill.status, 403, "a closed port is a readable refusal page");
  assert.match(r.result.fulfill.body, /port 4000 is not open/);
  assert.equal((await s.describe()).blocked.reason, "port 4000 is not open");

  r = fakeRoute("http://169.254.169.254/latest/meta-data", { navigation: false }); await route(r);
  assert.deepEqual(r.result, { abort: "blockedbyclient" }, "a sub-resource to a private place is just dropped");

  r = fakeRoute("https://localhost:3000/"); await route(r);
  assert.match(r.result.fulfill.body, /plain http/);
  await mgr.closeAll();
});

test("a window keeps its browser, a machine its share, and nobody watching closes it", async () => {
  let t = 1_000;
  const driver = fakeDriver();
  const mgr = new BraiwserSessions({ loadDriver: () => driver, resolvePort: async () => { throw new Error("no"); },
    maxSessions: 3, maxPerSandbox: 2, idleMs: 10_000, now: () => t });
  const a = await mgr.open({ sandboxId: "s", windowId: "a" });
  assert.equal(await mgr.open({ sandboxId: "s", windowId: "a" }), a, "reopening a window rejoins its page");
  t += 5; await mgr.open({ sandboxId: "s", windowId: "b" });
  t += 5; await mgr.open({ sandboxId: "s", windowId: "c" });
  assert.equal(mgr.get(BraiwserSessions.key("s", "a")), null, "a third window gives up the least recently watched one");
  assert.equal(driver.opened[0].closed, true);
  await mgr.open({ sandboxId: "other", windowId: "x" });
  await assert.rejects(mgr.open({ sandboxId: "third", windowId: "y" }), (e) => e.code === "BUSY" && e.status === 429, "the host total is never taken from someone else");
  await assert.rejects(mgr.open({ sandboxId: "s", windowId: "../etc" }), /window id/);

  const c = mgr.get(BraiwserSessions.key("s", "c"));
  await c.navigate("example.com");
  assert.equal(c.activeUrl(), "https://example.com");
  await c.input({ kind: "text", text: "hi" });
  assert.deepEqual(c.page().inputs, [{ kind: "text", x: undefined, y: undefined, key: undefined, text: "hi", deltaX: undefined, deltaY: undefined }]);
  await assert.rejects(c.input({ kind: "eval", text: "x" }), /unsupported input/);
  const tab = await c.tab("new");
  assert.equal(c.activePageId, tab.id);
  await c.tab("close", tab.id);
  assert.equal((await c.describe()).tabs.length, 1);
  const f = await c.frame();
  assert.equal(f.bytes[0], 0xff);

  t += 20_000;
  assert.equal(await mgr.reap(), 3, "every session nobody looked at for idleMs is closed");
  assert.equal(mgr.sessions.size, 0);
});

// ── the Gateway's front door ───────────────────────────────────────────────

test("the Gateway: net.browse is required, and a host without the runtime says so", async () => {
  openDb();
  const { owner, sandbox } = ensureSeed("local");
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/${sandbox.slug}/braiwser`;
  try {
    const cookie = { cookie: `sbx_session=${createSession(owner.id, "braiwser-test")}` };
    let res = await fetch(`${base}/status`, { headers: cookie });
    const st = await res.json();
    assert.equal(res.status, 200);
    assert.equal(st.ready, false);
    assert.equal(st.reason, "not-installed");
    assert.equal(st.revision, pin.revision);
    assert.equal(st.autoInstall, false);
    assert.equal(st.install.installing, false, "autoinstall off: nothing was started behind the operator's back");

    res = await fetch(`${base}/w1/open`, { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "BRAIWSER_UNAVAILABLE");

    res = await fetch(`${base}/w1/frame`, { headers: cookie });
    assert.equal(res.status, 404, "a window with no browser has no frame");

    const { token } = mintMachineToken(owner.id, sandbox.id, ["fs.read"], { label: "nobrowse" });
    res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /net\.browse/);
  } finally {
    srv.close(); _resetKernels(); closeDb();
  }
});

test("the runtime is the pinned revision or it is not ready", () => {
  assert.match(pin.repository, /Flyvendedk799\/Braiwser\.git$/);
  assert.match(pin.revision, /^[0-9a-f]{40}$/);
  const root = path.join(TEST_HOME, "fake-runtime");
  fs.mkdirSync(root, { recursive: true });
  assert.equal(inspectRuntime(root).reason, "not-installed");
  fs.writeFileSync(path.join(root, "runtime-revision"), "0".repeat(40));
  assert.equal(inspectRuntime(root).reason, "wrong-revision");
  fs.writeFileSync(path.join(root, "runtime-revision"), pin.revision);
  fs.writeFileSync(path.join(root, "runtime-browser.json"), JSON.stringify({ executablePath: path.join(root, "nope") }));
  assert.equal(inspectRuntime(root).reason, "no-chromium");
  assert.throws(() => loadDriver(inspectRuntime(root)), (e) => e.code === "BRAIWSER_UNAVAILABLE");
});

// ── real Chromium, when a runtime is supplied ──────────────────────────────

const REAL = process.env.SANDBOXOS_BRAIWSER_TEST_ROOT;
test("real Braiwser: a Cell port, its hot-reload socket, typing, tabs and refusals", { skip: !REAL && "set SANDBOXOS_BRAIWSER_TEST_ROOT to an installed runtime" }, async () => {
  const { upgradeWebSocket } = await import("../packages/pty/src/index.js");
  const cell = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>cell</title><input id=q autofocus><a href="/two" target="_blank" style="display:block;height:60px">pop</a>
<script>const ws=new WebSocket("ws://"+location.host+"/hmr");ws.onmessage=async e=>{document.title="ws:"+(typeof e.data==="string"?e.data:await e.data.text())};ws.onopen=()=>ws.send("hi")</script>`);
  });
  cell.on("upgrade", (req, socket, head) => { const ws = upgradeWebSocket(req, socket, head); ws.on("message", (m) => ws.send(`echo-${m}`)); ws.on("close", () => ws.close()); });
  await new Promise((r) => cell.listen(0, "127.0.0.1", r));
  const status = inspectRuntime(REAL);
  assert.ok(status.ready, JSON.stringify(status));
  const mgr = new BraiwserSessions({ loadDriver: () => loadDriver(status),
    resolvePort: async (_s, port) => { if (port !== 3000) throw new Error(`port ${port} is not open`); return { host: "127.0.0.1", port: cell.address().port }; } });
  try {
    const s = await mgr.open({ sandboxId: "s", windowId: "w", width: 800, height: 600 });
    assert.equal((await s.navigate("localhost:3000")).status, 200);
    const until = async (fn) => { for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail("timed out"); };
    await until(async () => (await s.describe()).tabs[0].title === "ws:echo-hi");
    const f = await s.frame();
    assert.equal(f.bytes[0], 0xff, "a JPEG frame");
    await s.input({ kind: "click", x: 20, y: 10 });
    await s.input({ kind: "text", text: "hello" });
    assert.equal(await s.page()._raw.evaluate(() => document.getElementById("q").value), "hello");
    await s.input({ kind: "click", x: 40, y: 50 });
    await until(async () => (await s.describe()).tabs.length === 2);
    assert.match((await s.describe()).url, /localhost:3000\/two/, "a popup becomes the shown tab");
    await s.navigate("http://169.254.169.254/");
    assert.ok((await s.describe()).blocked, "the metadata address is refused");
    await s.navigate("localhost:4000");
    assert.match((await s.describe()).blocked.reason, /port 4000/);
  } finally { await mgr.closeAll(); cell.close(); cell.closeAllConnections(); }
});

// ── agents browse through Braiwser too ─────────────────────────────────────

test("net.browse: an agent reads a JavaScript-rendered page through Braiwser, under the same rules", async () => {
  const { getKernel } = await import("../packages/kernel/src/kernel.js");
  const { grantsFor } = await import("../packages/control-db/src/registry.js");
  openDb();
  const { owner, sandbox } = ensureSeed("local");
  const kernel = await getKernel(sandbox);
  const held = grantsFor(owner.id, sandbox.id);
  const call = (server, tool, args) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  const saved = process.env.SANDBOXOS_BRAIWSER_ROOT;
  const app = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>spa</title><div id=root></div><script>root.textContent='rendered by script'</script>"); });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const port = app.address().port;
  try {
    let r = await call("net", "browse", { url: `http://localhost:${port}/` });
    assert.equal(r.ok, false);
    assert.match(r.error, /not installed on this host/, "no runtime: a sentence saying how to get one");
    if (!REAL) return;
    process.env.SANDBOXOS_BRAIWSER_ROOT = REAL;
    r = await call("net", "browse", { url: `http://localhost:${port}/` });
    assert.equal(r.ok, false);
    assert.match(r.error, /not exposed/, "an unexposed port is refused for an agent as for a person");
    assert.ok((await call("ports", "expose", { port, name: "spa" })).ok);
    r = await call("net", "browse", { url: `localhost:${port}` });
    assert.ok(r.ok, r.error);
    assert.equal(r.result.title, "spa");
    assert.match(r.result.text, /rendered by script/, "what fetch would miss");
    r = await call("net", "browse", { url: "http://169.254.169.254/latest/meta-data" });
    assert.equal(r.ok, false);
    assert.match(r.error, /private address/);
  } finally {
    process.env.SANDBOXOS_BRAIWSER_ROOT = saved;
    await call("ports", "unexpose", { port }).catch(() => {});
    app.close(); _resetKernels(); closeDb();
  }
});
