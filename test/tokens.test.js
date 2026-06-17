// Machine-token attenuation (unit) + Bearer-scoped access and multi-Sandbox (e2e).
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, mintMachineToken } from "../packages/control-db/src/registry.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox;
test.before(() => { openDb(); ({ owner, sandbox } = ensureSeed("local")); });
test.after(() => closeDb());

test("minting attenuates: you can only delegate a subset of what you hold", () => {
  // owner holds '*', so can mint a narrower token.
  const scoped = mintMachineToken(owner.id, sandbox.id, ["fs.*"], { label: "ci" });
  assert.deepEqual(grantsFor(scoped.principalId, sandbox.id), ["fs.*"]);

  // that scoped principal can re-mint a subset...
  const narrower = mintMachineToken(scoped.principalId, sandbox.id, ["fs.read"]);
  assert.deepEqual(narrower.patterns, ["fs.read"]);

  // ...but cannot widen beyond its own authority.
  assert.throws(() => mintMachineToken(scoped.principalId, sandbox.id, ["proc.exec"]), /attenuation/);
});

test("a Bearer machine token is scoped end-to-end through the Gateway", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // login (cookie) then mint a read-only token for a device
    const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const mint = await fetch(base + "/tobias/tokens", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ patterns: ["fs.list"], label: "phone" }),
    });
    const { token } = await mint.json();
    const bear = (line) => fetch(base + "/tobias/exec", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ line }),
    }).then((r) => r.json());

    const ls = await bear("ls");
    assert.ok(Array.isArray(ls.lines));                       // fs.list allowed
    const wr = await bear("write x.txt nope");
    assert.match(wr.lines.join(" "), /denied|✗/);             // fs.write denied by scope
  } finally {
    server.close();
  }
});

test("a tenant can create additional Sandboxes", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const mk = await fetch(base + "/api/sandboxes", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ slug: "second", name: "Second" }),
    });
    assert.deepEqual(await mk.json(), { ok: true, slug: "second" });

    // the creator is authorized on the new slug and can act in it
    const ex = await fetch(base + "/second/exec", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ line: "write hi.txt yo" }),
    }).then((r) => r.json());
    assert.match(ex.lines.join(" "), /wrote/);

    // duplicate slug is rejected
    const dup = await fetch(base + "/api/sandboxes", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ slug: "second" }),
    });
    assert.equal(dup.status, 409);
  } finally {
    server.close();
  }
});
