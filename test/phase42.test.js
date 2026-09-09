// Phase 42: the door, on every route.
//
// T0.4 of goal.md asked for a fuzz test that "posts malformed bodies to every
// route and asserts: no 500 without a Gateway-authored message, and no database
// string ever reaching a client". `test/phase31.test.js` did that for
// `POST /:slug/mcp` — the one that matters most, and the one that used to answer
// a shapeless call with a sentence about SQLite parameters. This does it for the
// rest of them, and for the process: the Gateway is still answering afterwards.
//
// What "authored" means here: whatever comes back, a caller reads a sentence this
// project wrote. Not a stack, not a driver's complaint, not the inside of a
// prepared statement.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createSession } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { stopAllProcsEverywhere } from "../packages/kernel/src/servers/proc.js";
import { killAllSessionsEverywhere } from "../packages/kernel/src/pty-sessions.js";

let owner, sandbox, srv, base, session, kernel;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  kernel = await getKernel(sandbox);
  session = createSession(owner.id, "phase42");
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => {
  stopAllProcsEverywhere();
  killAllSessionsEverywhere();
  srv.close();
  _resetKernels();
  closeDb();
});

/** Every POST route under a slug that a signed-in person can reach. */
const POST_ROUTES = [
  "mcp", "exec", "exec-stream", "stream", "propose",
  "access", "chats", "secrets", "tokens", "wake", "hibernate",
  "os/apps/nope/session",
];

/** Bodies designed to reach a handler that assumed a shape. */
const BAD_BODIES = [
  "",                                   // no body at all
  "not json",                           // not JSON
  "null",                               // JSON, but nothing
  "[]",                                 // an array where an object goes
  '"a string"',                         // a scalar
  "123",
  "{",                                  // truncated
  '{"server":{"$ne":null},"tool":{}}',  // objects where names go
  '{"server":"fs","tool":"list","args":"' + "x".repeat(2000) + '"}',
  '{"cmd":null}',
  '{"cmd":["echo","hi"]}',
  '{"name":null,"value":null}',
  '{"patterns":"not-an-array","username":42}',
  '{"__proto__":{"admin":true}}',       // prototype pollution, as a body
  '{"id":"../../etc/passwd"}',
  '{"rev":"NaN","only":"windows"}',
];

/** Nothing a caller reads may come from inside the machine. */
const LEAKS = [
  /SQLite/i, /SQLITE_/, /sqlite3/i, /better-sqlite3/,
  /prepared statement/i, /parameter \d/i,
  /at Object\.<anonymous>/, /\n\s+at .*\(.*:\d+:\d+\)/,   // a stack
  /node:internal/, /C:\\Users/, /\/home\/[a-z]/,          // a host path
];

const clean = (text, where) => {
  for (const bad of LEAKS) {
    assert.doesNotMatch(text, bad, `${where} leaked something a caller must never read`);
  }
};

const alive = async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200, "the Gateway is still answering");
  return r.json();
};

test("every POST route under a slug survives a malformed body", async () => {
  const cookie = `sbx_session=${session}`;
  for (const route of POST_ROUTES) {
    for (const body of BAD_BODIES) {
      const where = `POST /${sandbox.slug}/${route} ${JSON.stringify(body.slice(0, 40))}`;
      const res = await fetch(`${base}/${sandbox.slug}/${route}`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body,
      });
      const text = await res.text();
      clean(text, where);
      // A 500 is allowed only if the sentence in it is ours. Anything else is a
      // handler that met a shape it did not expect and told the caller about our
      // internals.
      if (res.status >= 500) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON at all */ }
        assert.ok(parsed && parsed.ok === false && typeof parsed.error === "string" && parsed.error.length > 0,
          `${where} → ${res.status} with an unauthored body: ${text.slice(0, 200)}`);
      }
    }
  }
  await alive();
});

test("a malformed body cannot pollute a prototype", async () => {
  await fetch(`${base}/${sandbox.slug}/mcp`, {
    method: "POST",
    headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" },
    body: '{"__proto__":{"polluted":"yes"},"server":"kernel","tool":"whoami"}',
  });
  assert.equal({}.polluted, undefined, "nothing on the object prototype");
  assert.equal(Object.prototype.polluted, undefined);
});

test("a GET route given nonsense answers a sentence, not a stack", async () => {
  const cookie = `sbx_session=${session}`;
  const paths = [
    "os/manual/../../package.json",
    "os/manual/%2e%2e%2f%2e%2e%2fpackage.json",
    "os/apps//",
    "os/apps/%00/index.html",
    "os/widgets/../../../etc/hosts",
    "p/notaport/",
    "p/-1/",
    "p/99999999/",
    "os/theme.css?x=" + "y".repeat(4000),
    "files?path=" + encodeURIComponent("../".repeat(40) + "etc/passwd"),
    "logs?id=%00",
    "nope/nope/nope",
  ];
  for (const p of paths) {
    const res = await fetch(`${base}/${sandbox.slug}/${p}`, { headers: { cookie } }).catch((e) => ({ status: 0, text: async () => e.message }));
    const text = await res.text();
    clean(text, `GET /${sandbox.slug}/${p}`);
    assert.ok(res.status !== 0, `GET /${p} got an answer`);
    assert.equal(/root:x:0:0|BEGIN [A-Z ]*PRIVATE KEY|devDependencies/.test(text), false,
      `GET /${p} must not return anything from outside the machine`);
  }
  await alive();
});

test("an unauthenticated caller is refused, not crashed into", async () => {
  for (const route of POST_ROUTES) {
    const res = await fetch(`${base}/${sandbox.slug}/${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"server":"fs","tool":"list"}',
    });
    const text = await res.text();
    clean(text, `unauthenticated POST /${route}`);
    assert.ok(res.status === 401 || res.status === 403 || res.status === 302 || res.status === 404,
      `POST /${route} without a session → ${res.status}`);
  }
  await alive();
});

test("a slug that is not a slug is a 404, whatever it is made of", async () => {
  const slugs = ["../../etc", "%2e%2e", "a".repeat(300), "sbx'; drop table sandboxes; --", "‮rtl", "nul"];
  for (const slug of slugs) {
    const res = await fetch(`${base}/${encodeURIComponent(slug)}/mcp`, {
      method: "POST", headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" },
      body: '{"server":"kernel","tool":"whoami"}',
    });
    const text = await res.text();
    clean(text, `slug ${slug}`);
    assert.ok(res.status >= 400, `${slug} → ${res.status}`);
  }
  // The table is still there, which is the point of the third one.
  const r = await fetch(`${base}/${sandbox.slug}/mcp`, {
    method: "POST", headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" },
    body: '{"server":"kernel","tool":"whoami"}',
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true, "and the machine still works");
});

test("a body far larger than any route wants is refused rather than buffered", async () => {
  const huge = JSON.stringify({ server: "desktop", tool: "set", args: { name: "x".repeat(4 * 1024 * 1024) } });
  const res = await fetch(`${base}/${sandbox.slug}/mcp`, {
    method: "POST", headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" }, body: huge,
  }).catch((e) => ({ status: 0, text: async () => e.message }));
  const text = await res.text();
  clean(text, "an oversized body");
  assert.ok(res.status === 0 || res.status >= 400, `an oversized body is refused (${res.status})`);
  await alive();
});

test("the cap is above anything real and below anything abusive", async () => {
  const { MAX_BODY_BYTES } = await import("../apps/gateway/src/server.js");
  const { LIMITS } = await import("../packages/os/src/schema.js");
  assert.ok(MAX_BODY_BYTES > LIMITS.docBytes, "a whole OS document still fits through the door");
  assert.ok(MAX_BODY_BYTES <= 4 * 1024 * 1024, "and the door is not a way to make us hold megabytes");

  // A distro payload — the biggest legitimate thing anyone posts — goes through.
  const real = JSON.stringify({ server: "desktop", tool: "distroImport", args: { payload: { os: { name: "x".repeat(LIMITS.docBytes / 2) } } } });
  assert.ok(real.length < MAX_BODY_BYTES, `a half-megabyte payload is under the cap (${real.length})`);
  const res = await fetch(`${base}/${sandbox.slug}/mcp`, {
    method: "POST", headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" }, body: real,
  });
  assert.notEqual(res.status, 413, "so it is not refused at the door");
});

test("a body that lies about its length is still bounded", async () => {
  // No content-length to check: the reader has to stop on its own.
  const { MAX_BODY_BYTES } = await import("../apps/gateway/src/server.js");
  const chunk = "x".repeat(64 * 1024);
  const stream = new ReadableStream({
    start(c) {
      for (let sent = 0; sent < MAX_BODY_BYTES * 2; sent += chunk.length) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  const res = await fetch(`${base}/${sandbox.slug}/mcp`, {
    method: "POST", duplex: "half",
    headers: { cookie: `sbx_session=${session}`, "content-type": "application/json" },
    body: stream,
  }).catch((e) => ({ status: 0, text: async () => e.message }));
  const text = await res.text();
  clean(text, "a chunked oversized body");
  // Either the door refused it or the reader dropped it and the route answered
  // with its own sentence. What must not happen is a 200.
  assert.notEqual(res.status, 200, `a chunked flood is not a success (${res.status})`);
  await alive();
});
