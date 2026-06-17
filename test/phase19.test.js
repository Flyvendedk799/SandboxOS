// Phase 19: remaining deferred hardening —
//   #11 per-tenant secret key derivation + rotation
//   #13 host-global agent concurrency ceiling
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import config from "../packages/config/src/config.js";
import {
  ensureSeed, grantsFor, createTenant, createPrincipal, createSandboxForTenant,
} from "../packages/control-db/src/registry.js";
import {
  putSecret, resolveSecretEnv, upgradeSecretsToPerTenant,
} from "../packages/secrets/src/store.js";
import { getKernel } from "../packages/kernel/src/kernel.js";

let owner, sandbox, sbA, sbB;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  // Two sandboxes in two DIFFERENT tenants, to exercise per-tenant key isolation.
  const tA = createTenant("p19-tenantA");
  const pA = createPrincipal(tA.id, "human", "p19-A-owner");
  sbA = createSandboxForTenant(tA.id, pA.id, { slug: "p19-a", name: "A", cellBackend: "local" });
  const tB = createTenant("p19-tenantB");
  const pB = createPrincipal(tB.id, "human", "p19-B-owner");
  sbB = createSandboxForTenant(tB.id, pB.id, { slug: "p19-b", name: "B", cellBackend: "local" });
});
test.after(() => closeDb());

// ─── #11 per-tenant secret keys ──────────────────────────────────────────────

test("secret round-trips and is sealed under the per-tenant scheme (key_version=1)", () => {
  putSecret(sbA.id, "API_KEY", "valueA");
  assert.equal(resolveSecretEnv(sbA.id, ["API_KEY"]).API_KEY, "valueA");
  const row = openDb().prepare("SELECT key_version FROM secrets WHERE sandbox_id=? AND name=?").get(sbA.id, "API_KEY");
  assert.equal(row.key_version, 1);
});

test("a tenant's ciphertext can't be decrypted under another tenant's key (#11 isolation)", () => {
  putSecret(sbA.id, "SHARED", "topsecretA");
  const db = openDb();
  const row = db.prepare("SELECT ct,iv,tag,key_version FROM secrets WHERE sandbox_id=? AND name=?").get(sbA.id, "SHARED");
  // Plant tenant A's EXACT ciphertext under tenant B's sandbox.
  db.prepare("INSERT INTO secrets (id,sandbox_id,name,ct,iv,tag,key_version,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("sec_planted_p19", sbB.id, "SHARED", row.ct, row.iv, row.tag, row.key_version, Date.now());
  // B derives a different key from the master, so GCM authentication must fail.
  assert.throws(() => resolveSecretEnv(sbB.id, ["SHARED"]));
  // A still reads its own secret.
  assert.equal(resolveSecretEnv(sbA.id, ["SHARED"]).SHARED, "topsecretA");
});

test("legacy (v0 master-key) secrets still decrypt, and upgrade re-seals to v1 (#11 rotation)", () => {
  const db = openDb();
  putSecret(sbA.id, "_ensure_key", "x"); // forces the master.key file to exist
  const masterKey = fs.readFileSync(path.join(config.home, "master.key"));
  // Craft a pre-#11 row: AES-256-GCM directly under the master key, key_version=0.
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([c.update("legacy-value", "utf8"), c.final()]);
  db.prepare("INSERT INTO secrets (id,sandbox_id,name,ct,iv,tag,key_version,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("sec_legacy_p19", sbA.id, "LEGACY", ct.toString("base64"), iv.toString("base64"), c.getAuthTag().toString("base64"), 0, Date.now());
  // Backward compat: decrypts via the v0 path.
  assert.equal(resolveSecretEnv(sbA.id, ["LEGACY"]).LEGACY, "legacy-value");
  // Rotation: upgrade re-seals legacy rows under the tenant key.
  assert.ok(upgradeSecretsToPerTenant() >= 1, "expected the legacy row upgraded");
  const row = db.prepare("SELECT key_version FROM secrets WHERE sandbox_id=? AND name=?").get(sbA.id, "LEGACY");
  assert.equal(row.key_version, 1);
  assert.equal(resolveSecretEnv(sbA.id, ["LEGACY"]).LEGACY, "legacy-value"); // still readable after upgrade
});

// ─── #13 host-global agent ceiling ───────────────────────────────────────────

test("agents.spawn is blocked by the host-global ceiling (#13)", async () => {
  const kernel = await getKernel(sandbox);
  const held = grantsFor(owner.id, sandbox.id);
  process.env.SANDBOXOS_MAX_AGENTS_GLOBAL = "0";
  try {
    const r = await kernel.call({
      principalId: owner.id, heldPatterns: held, server: "agents", tool: "spawn",
      args: { name: "blocked-p19", patterns: ["proc.exec"], cmd: "echo hi" },
    });
    assert.ok(!r.ok, JSON.stringify(r));
    assert.match(r.error, /host agent capacity/i);
  } finally {
    delete process.env.SANDBOXOS_MAX_AGENTS_GLOBAL;
  }
});

test("agents.spawn succeeds when under the host-global ceiling (#13)", async () => {
  const kernel = await getKernel(sandbox);
  const held = grantsFor(owner.id, sandbox.id);
  process.env.SANDBOXOS_MAX_AGENTS_GLOBAL = "100";
  try {
    const r = await kernel.call({
      principalId: owner.id, heldPatterns: held, server: "agents", tool: "spawn",
      args: { name: "ok-agent-p19", patterns: ["proc.exec"], cmd: "echo hi" },
    });
    assert.ok(r.ok, JSON.stringify(r));
  } finally {
    delete process.env.SANDBOXOS_MAX_AGENTS_GLOBAL;
  }
});
