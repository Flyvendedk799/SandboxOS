import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, createSession, resolveSession, revokeSession,
  appendAudit, recentAudit, getSandboxBySlug,
} from "../packages/control-db/src/registry.js";

test.before(() => openDb());
test.after(() => closeDb());

test("seed creates a tenant, owner, sandbox with a '*' grant — idempotently", () => {
  const a = ensureSeed("local");
  const b = ensureSeed("local");
  assert.equal(a.sandbox.id, b.sandbox.id);          // idempotent
  assert.equal(getSandboxBySlug("tobias").id, a.sandbox.id);
  assert.deepEqual(grantsFor(a.owner.id, a.sandbox.id), ["*"]);
});

test("sessions resolve and revoke", () => {
  const { owner } = ensureSeed("local");
  const token = createSession(owner.id);
  assert.equal(resolveSession(token).principal_id, owner.id);
  revokeSession(token);
  assert.equal(resolveSession(token), null);
  assert.equal(resolveSession("garbage"), null);
});

test("audit is hash-chained and queryable", () => {
  const { sandbox, owner } = ensureSeed("local");
  appendAudit({ sandboxId: sandbox.id, principalId: owner.id, server: "fs", tool: "read", resultKind: "ok", capability: "*" });
  appendAudit({ sandboxId: sandbox.id, principalId: owner.id, server: "fs", tool: "write", args: { secret: "x" }, resultKind: "ok", capability: "*" });
  const rows = recentAudit(sandbox.id, 10);
  assert.ok(rows.length >= 2);
  const last = rows[rows.length - 1];
  assert.equal(last.tool, "write");
  assert.match(last.args_json, /\[redacted\]/);     // sensitive key redacted
  assert.ok(last.hash && last.prev_hash);            // chained
});
