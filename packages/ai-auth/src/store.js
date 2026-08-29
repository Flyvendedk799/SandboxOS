// Where credentials live, as an interface rather than a table.
//
// A credential store does three things, two of which are a map:
//
//   read(key)          → { payload, meta } | null
//   write(key, record) → void
//   delete(key)        → void
//
// Values are opaque strings, already sealed by the caller before they arrive. That is
// deliberate: an adapter cannot leak a plaintext token it was never given, so writing
// a new adapter involves no decisions about cryptography at all. `meta` carries the
// small non-secret facts — the plan name, the expiry — so a status page costs no
// decryption.

import {
  getTenantSecretValue, listTenantSecrets, putTenantSecret, removeTenantSecret,
} from "../../secrets/src/store.js";

/**
 * The store for a process that does not need persistence.
 *
 * Not only a test double: a CLI that signs in and does its work in one run genuinely
 * has nowhere better to put this.
 */
export class MemoryCredentialStore {
  constructor() { this.rows = new Map(); }
  async read(key) { return this.rows.get(key) ?? null; }
  async write(key, record) { this.rows.set(key, record); }
  async delete(key) { this.rows.delete(key); }
}

/** Every tenant_secrets row this package owns carries this prefix. */
export const TENANT_CREDENTIAL_PREFIX = "aiauth/";

/**
 * The SandboxOS adapter: one `tenant_secrets` row per credential.
 *
 * Two layers of encryption, and the second is not redundant. `tenant_secrets` seals
 * every row under a key derived from the master key *and* the owning tenant's id, so a
 * DB dump is useless on its own. The SecretBox layer above it is what keeps the OAuth
 * store and the key store from being able to read each other's rows — a property the
 * table cannot provide, because to the table both are just rows belonging to the same
 * tenant.
 */
export class TenantCredentialStore {
  /** @param {string} tenantId the tenant whose rows this store may touch */
  constructor(tenantId) {
    if (!tenantId) throw new Error("TenantCredentialStore needs a tenant id");
    this.tenantId = tenantId;
  }

  name(key) { return `${TENANT_CREDENTIAL_PREFIX}${key}`; }

  async read(key) {
    const raw = getTenantSecretValue(this.tenantId, this.name(key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // A row that is not the shape we write is a row somebody else owns, or one from a
      // scheme we no longer speak. Either way "no credential" is the honest answer, and
      // it is the one every caller already handles.
      if (!parsed || typeof parsed.payload !== "string") return null;
      return { payload: parsed.payload, meta: parsed.meta ?? {} };
    } catch {
      return null;
    }
  }

  async write(key, record) {
    putTenantSecret(this.tenantId, this.name(key), JSON.stringify({
      payload: record.payload,
      meta: record.meta ?? {},
    }));
  }

  async delete(key) {
    removeTenantSecret(this.tenantId, this.name(key));
  }

  /** The keys this tenant has stored, without opening any of them. */
  keys() {
    return listTenantSecrets(this.tenantId)
      .filter((s) => s.name.startsWith(TENANT_CREDENTIAL_PREFIX))
      .map((s) => s.name.slice(TENANT_CREDENTIAL_PREFIX.length));
  }
}
