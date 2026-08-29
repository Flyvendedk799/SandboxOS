// Phase 23: access, tokens, and taking the audit log with you.
//
// The capability model has always been able to answer "who can touch this
// machine, and to do what". These tests pin down the routes that finally ask it,
// plus the rule that governs every form of delegation here: you cannot give away
// what you do not hold.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, createTenant, createAccount, getAccountByUsername,
  listSandboxAccess, revokeSandboxAccess, shareSandbox, listMachineTokens,
  mintMachineToken, resolveSession, setOperator, createSandboxForTenant,
} from "../packages/control-db/src/registry.js";
import { _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, server, base, cookie, guest;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  // A second account to share with.
  const tenant = createTenant("guest-co");
  guest = createAccount(tenant.id, { username: "guest", password: "guest-password" });
  // Login resolves a primary Sandbox, so the guest tenant needs one of its own.
  createSandboxForTenant(tenant.id, guest.principalId, { slug: "guest", name: "Guest", cellBackend: "local" });
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

const authed = (path, init = {}) =>
  fetch(`${base}/${sandbox.slug}/${path}`, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ── Access ───────────────────────────────────────────────────────────────────

test("listSandboxAccess names every principal that can reach the machine", () => {
  const access = listSandboxAccess(sandbox.id);
  const me = access.find((a) => a.principalId === owner.id);
  assert.ok(me, "the owner must appear");
  assert.deepEqual(me.patterns, ["*"]);
  assert.equal(me.kind, "human");
});

test("sharing grants exactly the patterns asked for", () => {
  const shared = shareSandbox(owner.id, sandbox.id, "guest", ["fs.read", "proc.list"]);
  assert.deepEqual(shared.added.sort(), ["fs.read", "proc.list"]);
  assert.deepEqual(grantsFor(guest.principalId, sandbox.id).sort(), ["fs.read", "proc.list"]);
});

test("sharing is idempotent — re-sharing the same pattern adds nothing", () => {
  const again = shareSandbox(owner.id, sandbox.id, "guest", ["fs.read"]);
  assert.deepEqual(again.added, []);
  assert.equal(grantsFor(guest.principalId, sandbox.id).filter((p) => p === "fs.read").length, 1);
});

test("you cannot share what you do not hold", () => {
  // The guest holds only fs.read and proc.list — sharing '*' must be refused.
  assert.throws(
    () => shareSandbox(guest.principalId, sandbox.id, "guest", ["*"]),
    /attenuation/,
  );
});

test("sharing with an unknown account fails clearly", () => {
  assert.throws(() => shareSandbox(owner.id, sandbox.id, "nobody", ["fs.read"]), /no such account/);
});

test("a principal with no access cannot share at all", () => {
  const stranger = createAccount(createTenant("stranger-co").id, { username: "stranger", password: "stranger-pw" });
  assert.throws(() => shareSandbox(stranger.principalId, sandbox.id, "guest", ["fs.read"]), /no access/);
});

test("revoking access removes every grant the principal held here", () => {
  const before = grantsFor(guest.principalId, sandbox.id);
  assert.ok(before.length);
  const r = revokeSandboxAccess(sandbox.id, guest.principalId);
  assert.equal(r.removed, before.length);
  assert.deepEqual(grantsFor(guest.principalId, sandbox.id), []);
});

test("a revoked human keeps their login — they just lose this Sandbox", () => {
  assert.ok(getAccountByUsername("guest"), "the account still exists");
});

// ── Machine tokens ───────────────────────────────────────────────────────────

test("a minted token shows up as a machine principal with its patterns", () => {
  const minted = mintMachineToken(owner.id, sandbox.id, ["fs.read", "proc.exec"], { label: "laptop" });
  const tokens = listMachineTokens(sandbox.id);
  const mine = tokens.find((t) => t.principalId === minted.principalId);
  assert.ok(mine);
  assert.match(mine.label, /^laptop-/);
  assert.deepEqual(mine.patterns.sort(), ["fs.read", "proc.exec"]);
  assert.equal(mine.active, true);
  assert.ok(mine.expiresAt > Date.now());
});

test("revoking a token takes the credential with it, not just the grants", () => {
  const minted = mintMachineToken(owner.id, sandbox.id, ["fs.read"], { label: "ci" });
  assert.ok(resolveSession(minted.token), "the token authenticates before revocation");

  const r = revokeSandboxAccess(sandbox.id, minted.principalId);
  assert.ok(r.removed > 0);
  assert.ok(r.tokensRevoked > 0, "the bearer token must be destroyed too");
  assert.equal(resolveSession(minted.token), null, "a revoked token must stop authenticating");
});

// ── Over the Gateway ─────────────────────────────────────────────────────────

test("GET /:slug/access lists access and marks who you are", async () => {
  const r = await (await authed("access")).json();
  assert.equal(r.you, owner.id);
  assert.ok(r.access.some((a) => a.principalId === owner.id));
});

test("POST /:slug/access shares, DELETE revokes", async () => {
  const shared = await (await authed("access", {
    method: "POST", body: JSON.stringify({ username: "guest", patterns: ["fs.read"] }),
  })).json();
  assert.equal(shared.ok, true);
  assert.deepEqual(shared.added, ["fs.read"]);

  const listed = await (await authed("access")).json();
  const them = listed.access.find((a) => a.username === "guest");
  assert.ok(them, "the guest should now be listed by username");

  const revoked = await (await authed(`access/${them.principalId}`, { method: "DELETE" })).json();
  assert.equal(revoked.ok, true);
  assert.deepEqual(grantsFor(them.principalId, sandbox.id), []);
});

test("an over-broad share is refused by the Gateway with a readable reason", async () => {
  // Log in as the guest, give them a narrow grant, and have them try to widen it.
  shareSandbox(owner.id, sandbox.id, "guest", ["fs.read"]);
  const login = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "guest", password: "guest-password" }),
  });
  const guestCookie = login.headers.getSetCookie()[0].split(";")[0];

  const res = await fetch(`${base}/${sandbox.slug}/access`, {
    method: "POST",
    headers: { Cookie: guestCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "guest", patterns: ["*"] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /attenuation/);
});

test("you cannot revoke your own access", async () => {
  const res = await authed(`access/${owner.id}`, { method: "DELETE" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /your own access/);
});

test("revoking a principal with no grants here is a 404", async () => {
  const res = await authed("access/prn_nope", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("GET /:slug/tokens lists tokens and DELETE revokes one", async () => {
  const minted = await (await authed("tokens", {
    method: "POST", body: JSON.stringify({ label: "phone", patterns: ["fs.read"] }),
  })).json();
  assert.ok(minted.token);

  const listed = await (await authed("tokens")).json();
  const mine = listed.tokens.find((t) => t.label.startsWith("phone-"));
  assert.ok(mine);
  assert.equal(mine.active, true);

  const revoked = await (await authed(`tokens/${mine.principalId}`, { method: "DELETE" })).json();
  assert.equal(revoked.ok, true);
  assert.equal(resolveSession(minted.token), null);
});

// ── Audit export ─────────────────────────────────────────────────────────────

test("the audit log exports as JSON with a download filename", async () => {
  await authed("exec", { method: "POST", body: JSON.stringify({ line: "ls" }) });
  const res = await authed("audit/export");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="audit-.*\.json"/);
  const data = await res.json();
  assert.equal(data.sandbox, sandbox.slug);
  assert.ok(data.events.length > 0);
  assert.ok(data.events.every((e) => e.server && e.tool));
});

test("the audit log exports as CSV, quoting fields that contain commas", async () => {
  const res = await authed("audit/export?format=csv");
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const csv = await res.text();
  const [header, ...rows] = csv.split("\n");
  assert.equal(header, "id,ts,server,tool,result_kind,capability,error");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.startsWith('"')));
});

test("the export honours the same filters as the audit query", async () => {
  const res = await authed("audit/export?server=fs&kind=ok");
  const data = await res.json();
  assert.ok(data.events.length > 0);
  assert.ok(data.events.every((e) => e.server === "fs" && e.result_kind === "ok"));
});

// ── Chain verification ───────────────────────────────────────────────────────

test("chain verification is operator-only, and passes on an untampered log", async () => {
  // The seed owner is the host operator; a self-service account is not.
  const login = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "guest", password: "guest-password" }),
  });
  const guestCookie = login.headers.getSetCookie()[0].split(";")[0];
  const denied = await fetch(`${base}/api/admin/audit/verify`, { headers: { Cookie: guestCookie } });
  assert.equal(denied.status, 403, "a plain tenant must not verify the host-wide chain");

  const res = await fetch(`${base}/api/admin/audit/verify`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.brokenAtId, null);
  assert.ok(data.count > 0);
});
