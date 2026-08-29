// Phase 20: the OS primitives a real machine needs.
//   • fs   — mkdir/remove/move/copy/append/tree/search plus binary read/write
//   • proc — supervised background processes with tailable logs
//   • ports— declare a service inside the Cell and reach it through the Gateway
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
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

// ── fs ───────────────────────────────────────────────────────────────────────

test("fs.mkdir creates nested directories", async () => {
  await ok("fs", "mkdir", { path: "p20/src/lib" });
  const { entries } = await ok("fs", "list", { path: "p20/src" });
  assert.deepEqual(entries.map((e) => e.name), ["lib"]);
  assert.equal(entries[0].type, "dir");
});

test("fs.list reports size and mtime, directories first", async () => {
  await ok("fs", "write", { path: "p20/src/z.txt", content: "0123456789" });
  const { entries } = await ok("fs", "list", { path: "p20/src" });
  assert.deepEqual(entries.map((e) => e.name), ["lib", "z.txt"], "dirs sort before files");
  const file = entries.find((e) => e.name === "z.txt");
  assert.equal(file.size, 10);
  assert.ok(file.mtime > 0);
});

test("fs.append extends a file instead of truncating it", async () => {
  await ok("fs", "write", { path: "p20/log.txt", content: "one\n" });
  await ok("fs", "append", { path: "p20/log.txt", content: "two\n" });
  const { content } = await ok("fs", "read", { path: "p20/log.txt" });
  assert.equal(content, "one\ntwo\n");
});

test("fs.copy then fs.move relocates a file", async () => {
  await ok("fs", "copy", { from: "p20/log.txt", to: "p20/log-copy.txt" });
  await ok("fs", "move", { from: "p20/log-copy.txt", to: "p20/src/lib/moved.txt" });
  const { content } = await ok("fs", "read", { path: "p20/src/lib/moved.txt" });
  assert.equal(content, "one\ntwo\n");
  const gone = await call("fs", "read", { path: "p20/log-copy.txt" });
  assert.ok(!gone.ok, "the source must no longer exist after a move");
});

test("fs.tree walks a bounded, nested view of the filesystem", async () => {
  const t = await ok("fs", "tree", { path: "p20", depth: 3 });
  const src = t.tree.find((n) => n.name === "src");
  assert.equal(src.type, "dir");
  const lib = src.children.find((n) => n.name === "lib");
  assert.equal(lib.path, "p20/src/lib", "paths are Sandbox-relative and joinable");
  assert.ok(lib.children.some((n) => n.name === "moved.txt"));
});

test("fs.tree honours its depth bound", async () => {
  const t = await ok("fs", "tree", { path: "p20", depth: 1 });
  const src = t.tree.find((n) => n.name === "src");
  assert.deepEqual(src.children, [], "depth 1 stops before descending");
});

test("fs.search finds matching lines and reports their location", async () => {
  await ok("fs", "write", { path: "p20/src/app.js", content: "const port = 3000;\nlisten(port);\n" });
  const r = await ok("fs", "search", { query: "listen", path: "p20" });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, "p20/src/app.js");
  assert.equal(r.matches[0].line, 2);
});

test("fs.search filters by filename glob and supports regex", async () => {
  const txtOnly = await ok("fs", "search", { query: "one", path: "p20", include: "*.txt" });
  assert.ok(txtOnly.matches.every((m) => m.path.endsWith(".txt")));
  const rx = await ok("fs", "search", { query: "port\\s*=\\s*\\d+", path: "p20", regex: true });
  assert.equal(rx.matches.length, 1);
});

test("fs.writeBytes / fs.readBytes round-trip binary content", async () => {
  const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]);
  await ok("fs", "writeBytes", { path: "p20/blob.bin", base64: payload.toString("base64") });
  const r = await ok("fs", "readBytes", { path: "p20/blob.bin" });
  assert.equal(r.bytes, payload.length);
  assert.deepEqual(Buffer.from(r.base64, "base64"), payload);
});

test("fs.search skips binary files", async () => {
  const r = await ok("fs", "search", { query: "\\x7f", path: "p20", regex: true });
  assert.ok(r.matches.every((m) => !m.path.endsWith(".bin")));
});

test("fs.remove refuses a non-empty directory unless recursive", async () => {
  const guarded = await call("fs", "remove", { path: "p20/src" });
  assert.ok(!guarded.ok);
  assert.match(guarded.error, /not empty/);
  const forced = await ok("fs", "remove", { path: "p20/src", recursive: true });
  assert.equal(forced.removed, true);
});

test("fs.remove refuses to delete the Sandbox root", async () => {
  for (const p of [".", "/", ""]) {
    const r = await call("fs", "remove", { path: p });
    assert.ok(!r.ok, `removing ${JSON.stringify(p)} must fail`);
    assert.match(r.error, /Sandbox root/);
  }
});

test("the new fs tools stay inside the Cell volume", async () => {
  for (const args of [
    ["mkdir", { path: "../escape" }],
    ["append", { path: "../escape.txt", content: "x" }],
    ["copy", { from: "p20/log.txt", to: "../escape.txt" }],
    ["readBytes", { path: "../../etc/passwd" }],
  ]) {
    const r = await call("fs", args[0], args[1]);
    assert.ok(!r.ok, `fs.${args[0]} must reject an escaping path`);
  }
});

// ── proc ─────────────────────────────────────────────────────────────────────

test("proc.start supervises a background process and captures its output", async () => {
  const job = await ok("proc", "start", { cmd: "echo alpha; echo beta; echo gamma", name: "greeter" });
  assert.equal(job.state, "running");
  assert.equal(job.name, "greeter");

  // Poll until the process exits (it is a fraction of a second).
  let logs;
  for (let i = 0; i < 50; i += 1) {
    logs = await ok("proc", "logs", { id: job.id });
    if (logs.state !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(logs.state, "exited");
  assert.equal(logs.code, 0);
  assert.deepEqual(logs.logs.map((l) => l.text), ["alpha", "beta", "gamma"]);
});

test("proc.jobs lists supervised processes and proc.forget drops finished ones", async () => {
  const before = await ok("proc", "jobs");
  assert.ok(before.jobs.length >= 1);
  const finished = before.jobs.find((j) => j.state !== "running");
  const dropped = await ok("proc", "forget", { id: finished.id });
  assert.equal(dropped.forgotten, true);
  const after = await ok("proc", "jobs");
  assert.ok(!after.jobs.some((j) => j.id === finished.id));
});

test("proc.stop terminates a long-running process", async () => {
  const job = await ok("proc", "start", { cmd: "sleep 30", name: "sleeper" });
  const stopped = await ok("proc", "stop", { id: job.id });
  assert.equal(stopped.stopped, true);
  const after = await ok("proc", "logs", { id: job.id });
  assert.equal(after.state, "stopped");
  await ok("proc", "forget", { id: job.id });
});

test("stopping a process kills what it started, not just the wrapping shell", async () => {
  // The regression this guards: a command runs under `/bin/sh -c`, so killing
  // the process we spawned kills the shell and orphans the real work — a
  // supervised dev server that reads as "stopped" while still holding its port.
  const port = 7_000 + Math.floor(Math.random() * 900);
  const job = await ok("proc", "start", {
    cmd: `python3 -m http.server ${port} --bind 127.0.0.1`,
    name: "listener",
  });

  // Wait for it to bind.
  const reachable = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      return r.status > 0;
    } catch { return false; }
  };
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    up = await reachable();
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, `the listener never came up on :${port}`);

  await ok("proc", "stop", { id: job.id });

  let down = false;
  for (let i = 0; i < 60 && !down; i += 1) {
    down = !(await reachable());
    if (!down) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(down, `:${port} is still served — the shell died but its child did not`);
  await ok("proc", "forget", { id: job.id });
});

test("stopAllProcsEverywhere reaps supervised processes across Sandboxes", async () => {
  // These are children of the Gateway process. An orphan keeps its port bound,
  // so the next boot cannot rebind it — the shutdown path must reap them.
  const { stopAllProcsEverywhere } = await import("../packages/kernel/src/servers/proc.js");
  const a = await ok("proc", "start", { cmd: "sleep 30", name: "reap-a" });
  const b = await ok("proc", "start", { cmd: "sleep 30", name: "reap-b" });
  assert.equal(a.state, "running");
  assert.equal(b.state, "running");

  const killed = stopAllProcsEverywhere();
  assert.ok(killed >= 2, `expected at least 2 processes reaped, got ${killed}`);
  // The job table is dropped with them, so the ids are gone entirely.
  const after = await ok("proc", "jobs");
  assert.ok(!after.jobs.some((j) => j.id === a.id || j.id === b.id));
  assert.equal(stopAllProcsEverywhere(), 0, "reaping twice is a no-op");
});

test("proc.logs on an unknown id is an error, not a silent empty tail", async () => {
  const r = await call("proc", "logs", { id: "nope" });
  assert.ok(!r.ok);
  assert.match(r.error, /no such process/);
});

// ── ports ────────────────────────────────────────────────────────────────────

test("ports.expose records the port in the manifest and reports its route", async () => {
  const r = await ok("ports", "expose", { port: 4321, name: "web" });
  assert.equal(r.port, 4321);
  assert.equal(r.path, `/${sandbox.slug}/p/4321/`);
  const { ports } = await ok("ports", "list", { check: false });
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, "web");
});

test("ports.check reports a port with nothing listening as down", async () => {
  const r = await ok("ports", "check", { port: 4322, timeoutMs: 300 });
  assert.equal(r.up, false);
});

test("ports rejects an out-of-range port", async () => {
  const r = await call("ports", "expose", { port: 70000 });
  assert.ok(!r.ok);
  assert.match(r.error, /invalid port/);
});

test("the Gateway proxies an exposed port into the Cell", async () => {
  // Stand up a trivial "app inside the Cell". On the local backend the Cell shares
  // the host loopback, so a localhost listener is exactly what the Cell would serve.
  const app = http.createServer((req, res) => {
    if (req.url === "/api/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ pong: true, path: req.url }));
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>app</title></head><body>hi</body></html>");
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const appPort = app.address().port;

  try {
    await ok("ports", "expose", { port: appPort, name: "preview" });

    const up = await ok("ports", "check", { port: appPort });
    assert.equal(up.up, true, "the probe should see the listener");

    const json = await fetch(`${base}/${sandbox.slug}/p/${appPort}/api/ping`, { headers: { Cookie: cookie } });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { pong: true, path: "/api/ping" });

    // HTML gets a <base> injected so the app's relative URLs stay under the prefix.
    const html = await fetch(`${base}/${sandbox.slug}/p/${appPort}/`, { headers: { Cookie: cookie } });
    const body = await html.text();
    assert.match(body, new RegExp(`<base href="/${sandbox.slug}/p/${appPort}/">`));
  } finally {
    app.close();
    await call("ports", "unexpose", { port: appPort });
  }
});

test("the Gateway refuses to proxy a port that was never exposed", async () => {
  const r = await fetch(`${base}/${sandbox.slug}/p/9999/`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /not exposed/);
});

test("port preview requires authentication", async () => {
  const r = await fetch(`${base}/${sandbox.slug}/p/4321/`);
  assert.equal(r.status, 401);
});

test("proxying a port with nothing behind it reports a clear 502", async () => {
  const r = await fetch(`${base}/${sandbox.slug}/p/4321/`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /nothing is listening/);
});
