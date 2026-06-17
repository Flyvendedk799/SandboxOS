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
// DEFERRED (documented next step, needs a cross-file migration — NOT done here):
//   - per-tenant key derivation via HKDF(master, tenantId) so a single tenant's
//     compromise can't decrypt every tenant's secrets;
//   - master-key rotation (re-encrypt ct/iv/tag under a new key + key versioning).
// Both change the encrypt/decrypt contract and the secrets schema, so they are
// owned by a later phase; this item only hardens custody of the single key.
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

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.ct, "base64")), decipher.final()]).toString("utf8");
}

export function putSecret(sandboxId, name, value) {
  const db = openDb();
  const enc = encrypt(value);
  // Upsert by (sandbox, name).
  const existing = db.prepare("SELECT id FROM secrets WHERE sandbox_id=? AND name=?").get(sandboxId, name);
  if (existing) {
    db.prepare("UPDATE secrets SET ct=?, iv=?, tag=?, created_at=? WHERE id=?")
      .run(enc.ct, enc.iv, enc.tag, now(), existing.id);
  } else {
    db.prepare("INSERT INTO secrets (id,sandbox_id,name,ct,iv,tag,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id(), sandboxId, name, enc.ct, enc.iv, enc.tag, now());
  }
  return { name, ref: `secret://${name}` };
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
  const env = {};
  for (const ref of refs) {
    const name = String(ref).replace(/^secret:\/\//, "");
    const row = db.prepare("SELECT * FROM secrets WHERE sandbox_id=? AND name=?").get(sandboxId, name);
    if (!row) throw new Error(`unknown secret: ${name}`);
    env[name] = decrypt(row);
  }
  return env;
}
