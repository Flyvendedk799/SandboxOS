// Phase 17: locks in the security/correctness hardening backlog (#1–#10).
// Every test is independent and uses unique slugs/usernames (suffix -p17) to
// avoid UNIQUE collisions. The whole file must end green.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, isOperator, setOperator,
  createTenant, createAccount, verifyAccount,
  createSession, resolveSession, purgeExpiredSessions,
  mintMachineToken, appendAudit, queryAudit, verifyAuditChain,
  deleteSandbox, createSandboxForTenant, getPrincipal,
} from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { isBlockedAddress, resolveAndGuard } from "../packages/kernel/src/servers/net.js";
import { runCommand } from "../packages/command-central/src/console.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, held, kernel;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

// ─── #1 Operator authority tier ────────────────────────────────────────────
test("#1 ensureSeed owner is an operator; a fresh signup is not; setOperator round-trips", () => {
  // The seed owner is the host operator.
  assert.equal(isOperator(owner.id), true);

  // A self-service signup principal is NEVER an operator.
  const t = createTenant("op-tier-p17");
  const acc = createAccount(t.id, { username: "signup-op-p17", password: "pw-p17" });
  assert.equal(isOperator(acc.principalId), false);

  // setOperator round-trips both directions.
  setOperator(acc.principalId, true);
  assert.equal(isOperator(acc.principalId), true);
  setOperator(acc.principalId, false);
  assert.equal(isOperator(acc.principalId), false);
});

// ─── #1 Quota IDOR via the gateway ──────────────────────────────────────────
test("#1 POST /api/quota: non-operator cannot set another tenant's quota (403), own tenant 200", async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    // A second, non-operator tenant with its own account + session.
    const t2 = createTenant("quota-idor-victim-p17");
    const attackerTenant = createTenant("quota-idor-attacker-p17");
    const attackerAcc = createAccount(attackerTenant.id, { username: "idor-attacker-p17", password: "pw-p17" });
    assert.equal(isOperator(attackerAcc.principalId), false, "attacker must be a non-operator");
    const attackerToken = createSession(attackerAcc.principalId, "session");

    const post = (body) =>
      fetch(`http://127.0.0.1:${port}/api/quota`, {
        method: "POST",
        headers: { Authorization: `Bearer ${attackerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // Cross-tenant write → 403.
    const r403 = await post({ tenantId: t2.id, maxRunning: 0 });
    assert.equal(r403.status, 403);

    // No tenantId → defaults to own tenant → 200.
    const r200 = await post({ maxRunning: 1 });
    assert.equal(r200.status, 200);
    const d = await r200.json();
    assert.equal(d.ok, true);
    assert.equal(d.quota.tenant_id, attackerTenant.id);
  } finally {
    srv.close();
  }
});

// ─── #2 Token hashing at rest ───────────────────────────────────────────────
test("#2 createSession stores only the sha256 digest; raw token resolves; purge runs", () => {
  const t = createTenant("tok-hash-p17");
  const acc = createAccount(t.id, { username: "tok-hash-p17", password: "pw-p17" });
  const raw = createSession(acc.principalId, "session");

  const db = openDb();
  // The raw token must NOT be a row.
  assert.equal(db.prepare("SELECT 1 FROM sessions WHERE token=?").get(raw), undefined);
  // The digest IS the stored row.
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE token=?").get(sha256hex(raw)));

  // resolveSession still works against the raw token.
  const sess = resolveSession(raw);
  assert.ok(sess);
  assert.equal(sess.principal_id, acc.principalId);

  // Plant an already-expired session for this principal and purge it.
  const expiredRaw = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (token,principal_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(sha256hex(expiredRaw), acc.principalId, "session", Date.now() - 1000, Date.now() - 2000);
  assert.equal(resolveSession(expiredRaw), null, "expired session should not resolve");
  const purged = purgeExpiredSessions();
  assert.ok(typeof purged === "number" && purged >= 1, "at least our expired row purged");
  assert.equal(db.prepare("SELECT 1 FROM sessions WHERE token=?").get(sha256hex(expiredRaw)), undefined);
});

// ─── #4 Audit append-only + verify + tamper detection ───────────────────────
test("#4 deleteSandbox preserves audit rows; verifyAuditChain detects tampering", () => {
  const t = createTenant("audit-keep-p17");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "audit-keep-p17", name: "ak", cellBackend: "local" });
  appendAudit({ sandboxId: sb.id, principalId: owner.id, server: "fs", tool: "write", resultKind: "ok", args: { path: "a.txt" } });
  appendAudit({ sandboxId: sb.id, principalId: owner.id, server: "fs", tool: "read", resultKind: "ok", args: { path: "a.txt" } });

  const before = queryAudit(sb.id, { limit: 50 });
  assert.ok(before.length >= 2);

  // Chain must verify before tampering.
  assert.equal(verifyAuditChain().ok, true);

  // Deleting the sandbox must NOT erase its audit history (append-only).
  deleteSandbox(sb.id);
  const after = queryAudit(sb.id, { limit: 50 });
  assert.equal(after.length, before.length, "audit rows survive sandbox deletion");

  // Tamper one row's args_json directly and the chain must break with a brokenAtId.
  const db = openDb();
  const victim = db.prepare("SELECT id FROM audit WHERE sandbox_id=? ORDER BY id ASC LIMIT 1").get(sb.id);
  db.prepare("UPDATE audit SET args_json=? WHERE id=?").run('{"tampered":true}', victim.id);
  const verdict = verifyAuditChain();
  assert.equal(verdict.ok, false);
  assert.ok(verdict.brokenAtId != null, "a brokenAtId should be reported");
  // Restore so later tests / full-suite chain verification aren't affected.
  // (We re-tamper deterministically: simplest is to leave it broken only here —
  //  but other tests may call verifyAuditChain, so we repair by recomputing.)
  // The cleanest repair: delete the two rows we appended and any rows after the
  // break would still be fine because audit is append-only and we only mutated
  // one historical row. Recompute the whole chain from scratch.
  _repairAuditChain(db);
  assert.equal(verifyAuditChain().ok, true, "chain repaired for downstream tests");
});

// Recompute hash/prev_hash for every audit row exactly as appendAudit does, so a
// deliberate tamper in one test does not poison verifyAuditChain in others.
function _repairAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit ORDER BY id ASC").all();
  let prevHash = "";
  for (const row of rows) {
    const payload = JSON.stringify({
      ts: row.ts, sandbox_id: row.sandbox_id ?? null, principal_id: row.principal_id ?? null,
      on_behalf_of: row.on_behalf_of ?? null, server: row.server, tool: row.tool,
      args: row.args_json ?? null, result_kind: row.result_kind, error: row.error ?? null,
      capability: row.capability ?? null, prevHash,
    });
    const hash = crypto.createHash("sha256").update(prevHash + payload).digest("hex");
    db.prepare("UPDATE audit SET prev_hash=?, hash=? WHERE id=?").run(prevHash, hash, row.id);
    prevHash = hash;
  }
}

// ─── #5 Deep, value-aware redaction ─────────────────────────────────────────
test("#5 audit redacts secrets.put value, fetch bearer header, and blob shapes", () => {
  const t = createTenant("redact-p17");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "redact-p17", name: "rd", cellBackend: "local" });
  const secretValue = "s3cr3tPLAINTEXTvalue-p17";
  const bearer = "Bearer SECRETxyzABCDEFGHIJ-p17";
  const blob = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL"; // >40 base64-ish chars
  const innocuous = "hello";

  appendAudit({
    sandboxId: sb.id, principalId: owner.id, server: "secrets", tool: "put", resultKind: "ok",
    args: {
      name: "API",
      value: secretValue,                       // secrets.put shape
      headers: { Authorization: bearer },       // net.fetch shape
      note: blob,                               // innocuous key, secret-shaped value
      label: innocuous,                         // short, non-secret → survives
    },
  });

  const row = queryAudit(sb.id, { limit: 1 }).at(-1);
  const json = row.args_json;
  assert.ok(!json.includes(secretValue), "secrets.put value must be redacted");
  assert.ok(!json.includes("SECRETxyzABCDEFGHIJ"), "bearer value must be redacted");
  assert.ok(!json.includes(blob), "long blob-shaped value must be redacted");
  assert.ok(json.includes(innocuous), "innocuous short value survives");
});

// ─── #3 fs symlink escape ───────────────────────────────────────────────────
test("#3 in-volume symlink escape is rejected for read/list/write; normal I/O works", async () => {
  const t = createTenant("symlink-p17");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "symlink-p17", name: "sl", cellBackend: "local" });
  const k = await getKernel(sb);
  const h = grantsFor(owner.id, sb.id);
  const c = (server, tool, args) => k.call({ principalId: owner.id, heldPatterns: h, server, tool, args });

  // Ensure the volume exists, then plant a symlink pointing outside it.
  await c("fs", "write", { path: ".keep", content: "x" });
  nodeFs.symlinkSync("/etc", path.join(k.cell.root, "escape"));

  const r1 = await c("fs", "read", { path: "escape/passwd" });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /escapes sandbox/);

  const r2 = await c("fs", "list", { path: "escape" });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /escapes sandbox/);

  const r3 = await c("fs", "write", { path: "escape/evil.txt", content: "pwned" });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /escapes sandbox/);

  // Regression guard: a normal in-volume write+read still works.
  const w = await c("fs", "write", { path: "ok.txt", content: "in-volume" });
  assert.ok(w.ok, w.error);
  const rd = await c("fs", "read", { path: "ok.txt" });
  assert.ok(rd.ok);
  assert.equal(rd.result.content, "in-volume");
});

// ─── #6 net SSRF guard ──────────────────────────────────────────────────────
test("#6 isBlockedAddress flags private/loopback/link-local; allows public", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fc00::1"]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("#6 resolveAndGuard rejects loopback unless operator explicitly allows it", async () => {
  await assert.rejects(() => resolveAndGuard({ egress: "allow" }, "127.0.0.1"), /egress blocked/);
  const ok = await resolveAndGuard({ egress: "allow", allow: ["127.0.0.1"] }, "127.0.0.1");
  assert.equal(ok.ip, "127.0.0.1");
});

// ─── #10 scrypt password hashing ────────────────────────────────────────────
test("#10 createAccount stores a scrypt$ hash; verifyAccount accepts right / rejects wrong", () => {
  const t = createTenant("scrypt-p17");
  const acc = createAccount(t.id, { username: "scrypt-user-p17", password: "correct horse-p17" });

  const db = openDb();
  const row = db.prepare("SELECT hash FROM accounts WHERE id=?").get(acc.id);
  assert.ok(row.hash.startsWith("scrypt$"), `expected scrypt$ hash, got ${row.hash.slice(0, 12)}…`);

  const good = verifyAccount("scrypt-user-p17", "correct horse-p17");
  assert.ok(good, "right password should verify");
  assert.equal(good.id, acc.principalId);

  const bad = verifyAccount("scrypt-user-p17", "wrong");
  assert.ok(!bad, "wrong password must not verify");
});

// ─── #9 transactional delete + orphan cleanup ───────────────────────────────
test("#9 deleteSandbox removes the minted machine principal, its session, and grants", () => {
  const t = createTenant("orphan-p17");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "orphan-p17", name: "orph", cellBackend: "local" });
  const minted = mintMachineToken(owner.id, sb.id, ["proc.exec"], { label: "orphan-p17" });

  const db = openDb();
  // Pre-conditions: machine principal + its session + grants exist.
  assert.ok(getPrincipal(minted.principalId));
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE principal_id=?").get(minted.principalId));
  assert.ok(db.prepare("SELECT 1 FROM grants WHERE principal_id=? AND sandbox_id=?").get(minted.principalId, sb.id));

  deleteSandbox(sb.id);

  // Post: principal, session, grants, agents, jobs, secrets all gone.
  assert.equal(getPrincipal(minted.principalId), null, "orphan machine principal removed");
  assert.equal(db.prepare("SELECT 1 FROM sessions WHERE principal_id=?").get(minted.principalId), undefined, "its session removed");
  assert.equal(db.prepare("SELECT 1 FROM grants WHERE sandbox_id=?").get(sb.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM agents WHERE sandbox_id=?").get(sb.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE sandbox_id=?").get(sb.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM secrets WHERE sandbox_id=?").get(sb.id), undefined);
});

// ─── #8 least-privilege agent spawn (via the console runCommand path) ────────
// parseSpawnPatterns is not exported, so we exercise it through runCommand and
// capture the args the console hands to the kernel for agents.spawn.
test("#8 agent spawn defaults to ['proc.exec']; --patterns= narrows explicitly", async () => {
  const captured = [];
  const fakeKernel = {
    sandbox: { id: "fake-p17" },
    listTools: () => [],
    call: async ({ server, tool, args }) => {
      captured.push({ server, tool, args });
      return { ok: true, result: { id: "agt_x", patterns: args.patterns ?? [] } };
    },
  };

  await runCommand({ kernel: fakeKernel, principalId: owner.id, heldPatterns: ["*"], line: 'agent spawn worker "echo hi"' });
  assert.deepEqual(captured.at(-1).args.patterns, ["proc.exec"], "default grant is exactly proc.exec");

  await runCommand({ kernel: fakeKernel, principalId: owner.id, heldPatterns: ["*"], line: 'agent spawn worker "echo hi" --patterns=fs.read,proc.exec' });
  assert.deepEqual(captured.at(-1).args.patterns, ["fs.read", "proc.exec"], "explicit --patterns is honored verbatim");
});

// ─── #7 local backend env isolation ─────────────────────────────────────────
test("#7 local backend does NOT inherit host secrets; PATH still works", async () => {
  const SENTINEL = "leak-me-p17";
  const prev = process.env.SBX_SECRET_SENTINEL;
  process.env.SBX_SECRET_SENTINEL = SENTINEL;
  try {
    const t = createTenant("env-iso-p17");
    const sb = createSandboxForTenant(t.id, owner.id, { slug: "env-iso-p17", name: "env", cellBackend: "local" });
    const k = await getKernel(sb);
    const h = grantsFor(owner.id, sb.id);
    const c = (cmd) => k.call({ principalId: owner.id, heldPatterns: h, server: "proc", tool: "exec", args: { cmd } });

    // The host sentinel must NOT appear in the command's environment.
    const leak = await c('/bin/sh -c \'echo "[$SBX_SECRET_SENTINEL]"\'');
    assert.ok(leak.ok, leak.error);
    assert.ok(!leak.result.stdout.includes(SENTINEL), "host secret env must not leak into the Cell");

    // And `env` as a whole must not contain the sentinel value.
    const envDump = await c("env");
    assert.ok(envDump.ok, envDump.error);
    assert.ok(!envDump.result.stdout.includes(SENTINEL), "sentinel absent from full env dump");

    // Regression: a normal command still works (PATH present so echo resolves).
    const hi = await c("echo hi");
    assert.ok(hi.ok, hi.error);
    assert.match(hi.result.stdout, /hi/);
  } finally {
    if (prev === undefined) delete process.env.SBX_SECRET_SENTINEL;
    else process.env.SBX_SECRET_SENTINEL = prev;
  }
});
