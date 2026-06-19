// Secret storage: AES-256-GCM at rest, reference-not-value to callers.
//
// The master key is a 32-byte file under the home dir by default (gitignored),
// or wherever SANDBOXOS_MASTER_KEY_PATH points (see masterKeyPath). It is a
// separate file from control.sqlite and must never be in a DB backup. Phase 1
// keeps it simple and local; a higher-assurance `vault` server (HSM-backed) is
// the documented escalation (docs/08).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import config from "../../config/src/config.js";
import { openDb } from "../../control-db/src/db.js";

const now = () => Date.now();
const id = () => `sec_${crypto.randomUUID().slice(0, 8)}`;

// Master-key custody (backlog item #11). The key never lives in the DB and must
// NEVER be included in any control.sqlite backup — it is a separate file, on
// purpose, so a leaked DB dump alone cannot decrypt secrets.
//
// SANDBOXOS_MASTER_KEY_PATH lets an operator relocate the key off the DB
// directory / onto a separate mount (e.g. a tmpfs or an encrypted volume).
// When unset we default to <home>/master.key — backward-compatible with the
// original layout next to control.sqlite.
//
function masterKeyPath() {
  const override = process.env.SANDBOXOS_MASTER_KEY_PATH;
  return override && override !== "" ? path.resolve(override) : path.join(config.home, "master.key");
}

function masterKey() {
  const file = masterKeyPath();
  try {
    const key = fs.readFileSync(file);
    // Repair loose perms on an existing key: the file may predate this hardening
    // or have been created with a permissive umask. Force owner-only 0600.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best-effort: a chmod failure (e.g. read-only mount) must not break reads.
    }
    return key;
  } catch {
    const key = crypto.randomBytes(32);
    // Create the parent dir for relocated keys too (override may point elsewhere).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // mode in writeFileSync is masked by umask, so chmod afterwards to guarantee
    // owner read/write only (0600) regardless of the process umask.
    fs.writeFileSync(file, key, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return key;
  }
}

// Per-tenant key derivation (backlog item #11). Every secret is sealed under a key
// derived from the master key AND the owning tenant's id via HKDF-SHA256, so a leak
// of one tenant's derived key (or its plaintext secrets) does not compromise any
// other tenant's ciphertext. The master key itself never directly encrypts a v1
// secret. key_version on the row records the scheme:
//   0 = legacy: master key directly (pre-#11 rows);
//   1 = current: HKDF(master, salt, info="tenant:<id>").
const SECRET_KEY_VERSION = 1;
const HKDF_SALT = Buffer.from("sandboxos/secret-key/v1");

/** Resolve a sandbox's owning tenant (secrets are sandbox-scoped; the key is tenant-scoped). */
function tenantOf(db, sandboxId) {
  const row = db.prepare("SELECT tenant_id FROM sandboxes WHERE id=?").get(sandboxId);
  if (!row) throw new Error(`unknown sandbox: ${sandboxId}`);
  return row.tenant_id;
}

/** 32-byte AES key bound to a tenant: HKDF-SHA256(master, salt, info="tenant:<id>"). */
function tenantKey(tenantId) {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey(), HKDF_SALT, Buffer.from(`tenant:${tenantId}`), 32));
}

/** The key a row's ciphertext was sealed under, per its version. */
function keyForVersion(version, tenantId) {
  return Number(version) >= 1 ? tenantKey(tenantId) : masterKey();
}

function encrypt(plaintext, tenantId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tenantKey(tenantId), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), version: SECRET_KEY_VERSION,
  };
}

function decrypt(row, tenantId) {
  const key = keyForVersion(row.key_version ?? 0, tenantId);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.ct, "base64")), decipher.final()]).toString("utf8");
}

export function putSecret(sandboxId, name, value) {
  const db = openDb();
  const tenantId = tenantOf(db, sandboxId);
  const enc = encrypt(value, tenantId);
  // Upsert by (sandbox, name). Any write seals under the current scheme (v1).
  const existing = db.prepare("SELECT id FROM secrets WHERE sandbox_id=? AND name=?").get(sandboxId, name);
  if (existing) {
    db.prepare("UPDATE secrets SET ct=?, iv=?, tag=?, key_version=?, created_at=? WHERE id=?")
      .run(enc.ct, enc.iv, enc.tag, enc.version, now(), existing.id);
  } else {
    db.prepare("INSERT INTO secrets (id,sandbox_id,name,ct,iv,tag,key_version,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id(), sandboxId, name, enc.ct, enc.iv, enc.tag, enc.version, now());
  }
  return { name, ref: `secret://${name}` };
}

export function putTenantSecret(tenantId, name, value) {
  const db = openDb();
  const enc = encrypt(value, tenantId);
  const existing = db.prepare("SELECT id FROM tenant_secrets WHERE tenant_id=? AND name=?").get(tenantId, name);
  if (existing) {
    db.prepare("UPDATE tenant_secrets SET ct=?, iv=?, tag=?, key_version=?, created_at=? WHERE id=?")
      .run(enc.ct, enc.iv, enc.tag, enc.version, now(), existing.id);
  } else {
    db.prepare("INSERT INTO tenant_secrets (id,tenant_id,name,ct,iv,tag,key_version,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id(), tenantId, name, enc.ct, enc.iv, enc.tag, enc.version, now());
  }
  return { name, ref: `tenant-secret://${name}` };
}

export function getTenantSecretValue(tenantId, name) {
  const row = openDb().prepare("SELECT * FROM tenant_secrets WHERE tenant_id=? AND name=?").get(tenantId, name);
  return row ? decrypt(row, tenantId) : null;
}

export function tenantSecretExists(tenantId, name) {
  return !!openDb().prepare("SELECT 1 FROM tenant_secrets WHERE tenant_id=? AND name=?").get(tenantId, name);
}

export function removeTenantSecret(tenantId, name) {
  const r = openDb().prepare("DELETE FROM tenant_secrets WHERE tenant_id=? AND name=?").run(tenantId, name);
  return { removed: r.changes > 0 };
}

export function listTenantSecrets(tenantId) {
  return openDb().prepare("SELECT name, created_at FROM tenant_secrets WHERE tenant_id=? ORDER BY name").all(tenantId)
    .map((r) => ({ name: r.name, ref: `tenant-secret://${r.name}`, created_at: r.created_at }));
}

/** Names + refs only — never values. */
export function listSecrets(sandboxId) {
  return openDb().prepare("SELECT name, created_at FROM secrets WHERE sandbox_id=? ORDER BY name").all(sandboxId)
    .map((r) => ({ name: r.name, ref: `secret://${r.name}`, created_at: r.created_at }));
}

export function removeSecret(sandboxId, name) {
  const r = openDb().prepare("DELETE FROM secrets WHERE sandbox_id=? AND name=?").run(sandboxId, name);
  return { removed: r.changes > 0 };
}

/** Resolve refs/names to a {NAME: value} env map. Internal use only (never returned to callers). */
export function resolveSecretEnv(sandboxId, refs) {
  const db = openDb();
  const tenantId = tenantOf(db, sandboxId);
  const env = {};
  for (const ref of refs) {
    const name = String(ref).replace(/^secret:\/\//, "");
    const row = db.prepare("SELECT * FROM secrets WHERE sandbox_id=? AND name=?").get(sandboxId, name);
    if (!row) throw new Error(`unknown secret: ${name}`);
    env[name] = decrypt(row, tenantId);
  }
  return env;
}

/**
 * Backlog #11 (rotation/upgrade): re-seal every legacy (v0, master-key) secret under
 * its tenant-derived key. Idempotent and safe to run on boot — rows already at the
 * current version are skipped. Returns the number of secrets upgraded.
 */
export function upgradeSecretsToPerTenant() {
  const db = openDb();
  const rows = db.prepare(
    `SELECT s.*, sb.tenant_id AS _tenant
       FROM secrets s JOIN sandboxes sb ON sb.id = s.sandbox_id
      WHERE COALESCE(s.key_version, 0) < ?`
  ).all(SECRET_KEY_VERSION);
  let upgraded = 0;
  for (const row of rows) {
    const value = decrypt(row, row._tenant);         // open under the old (v0) scheme
    const enc = encrypt(value, row._tenant);         // re-seal under the tenant key (v1)
    db.prepare("UPDATE secrets SET ct=?, iv=?, tag=?, key_version=? WHERE id=?")
      .run(enc.ct, enc.iv, enc.tag, enc.version, row.id);
    upgraded++;
  }
  return upgraded;
}
