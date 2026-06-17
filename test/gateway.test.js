// End-to-end through the front door: login → exec → audit, on a real HTTP server.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { createServer } from "../apps/gateway/src/server.js";

let server, base, cookie;

test.before(async () => {
  openDb();
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); closeDb(); });

const post = (path, body, withCookie = true) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

test("wrong password is rejected", async () => {
  const r = await post("/login", { password: "nope" }, false);
  assert.equal(r.status, 401);
});

test("login mints a session and returns the slug", async () => {
  const r = await post("/login", { password: "test" }, false);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.equal(data.slug, "tobias");
  cookie = r.headers.getSetCookie()[0].split(";")[0];
  assert.match(cookie, /^sbx_session=/);
});

test("unauthenticated exec is refused", async () => {
  const r = await post("/tobias/exec", { line: "ls" }, false);
  assert.equal(r.status, 401);
});

test("authenticated write → ls → cat round-trips via Command Central", async () => {
  let r = await post("/tobias/exec", { line: "write greet.txt hello from the spine" });
  let data = await r.json();
  assert.ok(data.lines.join(" ").includes("wrote"));

  r = await post("/tobias/exec", { line: "ls" });
  data = await r.json();
  assert.ok(data.lines.some((l) => l.includes("greet.txt")));

  r = await post("/tobias/exec", { line: "cat greet.txt" });
  data = await r.json();
  assert.ok(data.lines.join("\n").includes("hello from the spine"));
});

test("the actions show up in the audit log", async () => {
  const r = await fetch(base + "/tobias/audit", { headers: { Cookie: cookie } });
  const data = await r.json();
  const tools = data.events.map((e) => `${e.server}.${e.tool}`);
  assert.ok(tools.includes("fs.write"));
  assert.ok(tools.includes("fs.list"));
});

test("a bad slug 404s", async () => {
  const r = await fetch(base + "/nope/exec", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
});
