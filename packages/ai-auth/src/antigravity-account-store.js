// One tenant's Google subscription (Antigravity login), stored and kept fresh.
//
// The same shape as ClaudeAccountStore — sealed payload, non-secret meta beside it,
// refresh-and-write-back, one in-flight refresh per account — with two differences:
//
//   * Google names no plan the way a Claude subscription does, so status reports the
//     account's own email. The thing worth confirming is *which* Google account is
//     connected, not a tier name Google never sends back.
//   * Cloud Code needs a GCP project id when the account's license requires one. Nothing
//     in the OAuth exchange reveals it, so it is a value the user types in, kept beside
//     the tokens rather than derived from them, and preserved across refreshes.

import { SecretBox } from "./secret-box.js";
import { refreshAntigravityToken } from "./antigravity.js";

/** Refresh this far ahead of expiry so a call never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Namespaces the derived key. Never reuse it for another store — see SecretBox. */
const SECRET_LABEL = "ai-auth-antigravity-oauth";

const DISCONNECTED = { connected: false, email: null, expiresAt: null, expired: false, projectId: null };

export class AntigravityAccountStore {
  /**
   * @param {object} options
   * @param {object} options.store   a credential store (see store.js)
   * @param {string} options.secret  the host's own secret; hashed with a label
   * @param {string} [options.namespace]
   */
  constructor(options) {
    this.options = options;
    this.box = new SecretBox(options.secret, options.secretLabel ?? SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:antigravity:` : "antigravity:";
    this.now = options.now ?? Date.now;
    this.refreshing = new Map();
  }

  key(accountId) { return `${this.prefix}${accountId}`; }

  /**
   * @param {string|null} [projectId] undefined keeps whatever project was stored before
   */
  async save(accountId, identity, projectId) {
    const existing = await this.options.store.read(this.key(accountId));
    const kept = projectId !== undefined
      ? (typeof projectId === "string" && projectId.trim() ? projectId.trim() : null)
      : (typeof existing?.meta?.projectId === "string" ? existing.meta.projectId : null);
    await this.options.store.write(this.key(accountId), {
      payload: this.box.sealJson({
        accessToken: identity.accessToken,
        refreshToken: identity.refreshToken ?? null,
      }),
      meta: {
        email: identity.email ?? null,
        expiresAt: Math.round(identity.expiresAt ?? 0),
        projectId: kept,
      },
    });
  }

  /** Change the GCP project id without touching the tokens. */
  async setProjectId(accountId, projectId) {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return;
    await this.options.store.write(this.key(accountId), {
      payload: record.payload,
      meta: { ...record.meta, projectId: (typeof projectId === "string" && projectId.trim()) || null },
    });
  }

  async forget(accountId) {
    await this.options.store.delete(this.key(accountId));
  }

  async status(accountId, now = this.now()) {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return { ...DISCONNECTED };
    const payload = this.box.openJson(record.payload);
    // A rotated host secret or a tampered row reads as "not connected": the login again
    // is a working recovery, and throwing would take a page down over it.
    if (!payload || typeof payload.accessToken !== "string") return { ...DISCONNECTED };
    const expiresAt = Number(record.meta?.expiresAt ?? 0);
    return {
      connected: true,
      email: typeof record.meta?.email === "string" ? record.meta.email : null,
      expiresAt,
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      projectId: typeof record.meta?.projectId === "string" ? record.meta.projectId : null,
    };
  }

  /** A usable access token, refreshing if stale. Deduped per account. */
  async token(accountId) {
    const existing = this.refreshing.get(accountId);
    if (existing) return existing;
    const work = this.resolveToken(accountId);
    this.refreshing.set(accountId, work);
    try {
      return await work;
    } finally {
      this.refreshing.delete(accountId);
    }
  }

  async resolveToken(accountId) {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) throw new Error("This account has no Google subscription connected.");
    const payload = this.box.openJson(record.payload);
    if (!payload || typeof payload.accessToken !== "string") {
      throw new Error("The stored Google credential could not be read. Connect the subscription again.");
    }
    const expiresAt = Number(record.meta?.expiresAt ?? 0);
    if (expiresAt - EXPIRY_BUFFER_MS > this.now()) return payload.accessToken;
    if (!payload.refreshToken) {
      throw new Error("The Google subscription has expired and cannot be refreshed. Connect it again.");
    }
    const refreshed = await refreshAntigravityToken(payload.refreshToken, {
      now: this.now,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    // Written back before it is handed out, project id and all.
    await this.save(accountId, {
      accessToken: refreshed.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: refreshed.expiresAt,
      email: refreshed.email ?? (typeof record.meta?.email === "string" ? record.meta.email : null),
    });
    return refreshed.accessToken;
  }
}
