// One tenant's Claude subscription, stored and kept fresh.
//
// The machine-local reader in local-cli.js deliberately never refreshes a live token:
// that credential belongs to the `claude` CLI, and rotating its refresh token would
// break the CLI's own session. This is the opposite case in every respect. The
// credential was minted *for* this deployment by a login the user did here, no CLI is
// holding a second copy, and nothing else will ever refresh it — so refreshing is not
// merely safe, it is the only thing keeping the account connected past the first hour.
//
// Which means the rotated refresh token has to be written back. A refresh that returns
// a new refresh token and drops it on the floor works exactly once and then signs the
// user out for reasons nobody can reconstruct afterwards.

import { SecretBox } from "./secret-box.js";
import { ClaudeCodeAuthError, refreshClaudeCodeToken } from "./local-cli.js";

/** Refresh this far ahead of expiry so a call never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Namespaces the derived key. Never reuse it for another store — see SecretBox. */
const SECRET_LABEL = "ai-auth-claude-oauth";

const DISCONNECTED = { connected: false, plan: null, expiresAt: null, expired: false, scopes: [] };

export class ClaudeAccountStore {
  /**
   * @param {object}  options
   * @param {object}  options.store       a credential store (see store.js)
   * @param {string}  options.secret      the host's own secret; hashed with a label
   * @param {string} [options.namespace]  prefixes store keys so apps can share a table
   * @param {string} [options.secretLabel] override only when adopting existing rows
   */
  constructor(options) {
    this.options = options;
    this.box = new SecretBox(options.secret, options.secretLabel ?? SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:claude:` : "claude:";
    this.now = options.now ?? Date.now;
    /** One in-flight refresh per account, so a burst of calls triggers a single exchange. */
    this.refreshing = new Map();
  }

  key(accountId) { return `${this.prefix}${accountId}`; }

  async save(accountId, identity) {
    await this.options.store.write(this.key(accountId), {
      payload: this.box.sealJson({
        accessToken: identity.accessToken,
        refreshToken: identity.refreshToken ?? null,
        scopes: identity.scopes ?? [],
      }),
      // Beside the payload rather than inside it: a status page should not have to
      // decrypt a token to say which plan is connected and when it runs out.
      meta: {
        plan: identity.subscriptionType ?? null,
        expiresAt: Math.round(identity.expiresAt ?? 0),
      },
    });
  }

  async forget(accountId) {
    await this.options.store.delete(this.key(accountId));
  }

  async status(accountId, now = this.now()) {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return { ...DISCONNECTED };

    const payload = this.box.openJson(record.payload);
    // A rotated host secret, or a tampered row. Reading it as "not connected" sends the
    // user through the login again, which is a working recovery; throwing would take a
    // page down over a credential that is merely unreadable.
    if (!payload || typeof payload.accessToken !== "string") return { ...DISCONNECTED };

    const expiresAt = Number(record.meta?.expiresAt ?? 0);
    return {
      connected: true,
      plan: typeof record.meta?.plan === "string" ? record.meta.plan : null,
      expiresAt,
      // Reported rather than hidden. It is not a failure — a refresh happens on the next
      // call — but "connected" beside a dead token is a status line that will look like a
      // lie the first time something else goes wrong.
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
    };
  }

  /**
   * A usable access token for this account, refreshing if it has gone stale.
   *
   * Deduped per account: three simultaneous calls must not race three refreshes against
   * each other, because the loser of that race holds a refresh token the winner has
   * already rotated away. The promise is registered synchronously, before the first
   * await — reading the store first and registering afterwards is a check-then-act
   * across an await, and the symptom is an intermittent logout.
   */
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
    if (!record) {
      throw new ClaudeCodeAuthError("This account has no Claude subscription connected.", true);
    }

    const payload = this.box.openJson(record.payload);
    if (!payload || typeof payload.accessToken !== "string") {
      throw new ClaudeCodeAuthError(
        "The stored Claude credential could not be read. Connect the subscription again.",
        true,
      );
    }

    const expiresAt = Number(record.meta?.expiresAt ?? 0);
    if (expiresAt - EXPIRY_BUFFER_MS > this.now()) return payload.accessToken;

    const refreshed = await refreshClaudeCodeToken({
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? null,
      expiresAt,
      subscriptionType: typeof record.meta?.plan === "string" ? record.meta.plan : null,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
      source: "file",
    }, {
      now: this.now,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    // Written back before it is handed out: the rotated refresh token is the only one
    // that will work next time, and losing it costs a re-login for no visible reason.
    await this.save(accountId, refreshed);
    return refreshed.accessToken;
  }
}
