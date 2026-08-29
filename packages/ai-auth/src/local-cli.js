// Harvest the Claude Code subscription login already on this machine.
//
// If `claude` is signed in on the box the Gateway runs on, there is already an OAuth
// credential there that bills to a *subscription* rather than to a metered API key. It
// is a real Anthropic credential for the real api.anthropic.com, so nothing about the
// request changes except how it authenticates and who pays.
//
// Claude Code stores it two ways depending on host:
//   macOS                     the Keychain, generic password `Claude Code-credentials`
//   Linux / headless / no keyring   ~/.claude/.credentials.json, plaintext
// Both hold the same blob, under `claudeAiOauth`.
//
// Two rules make this safe to lean on, and both are the opposite of what you would
// guess:
//
// **Re-read, do not own.** The file is Claude Code's, not ours. The CLI refreshes it on
// its own schedule, so every call re-reads rather than caching a token for the process
// lifetime — a `claude` login, logout or re-auth is picked up without restarting the
// Gateway.
//
// **Refresh only when it is already dead.** Anthropic rotates the refresh token on
// exchange, and a rotated token written nowhere would leave the *operator's own CLI*
// holding a credential the Gateway had already spent. So a refresh happens only once
// the stored access token has actually expired — by which point the CLI has to re-auth
// regardless — and the result is kept in memory only. A live login is never disturbed.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The macOS Keychain generic-password service Claude Code writes to. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Claude Code's public OAuth client id. Anthropic binds a refresh token to the client
 * that issued it, so a refresh has to present the same id. Public, not secret — PKCE is
 * what protects the exchange — but overridable for the day Anthropic issues a new one,
 * because the alternative is a redeploy to fix a token refresh.
 */
const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/** Treat a token as spent this long before it really expires, so a call cannot race it. */
export const EXPIRY_BUFFER_MS = 60_000;

function credentialsPath(env) {
  return env.CLAUDE_CREDENTIALS_FILE || join(homedir(), ".claude", ".credentials.json");
}

async function defaultKeychainRead() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // `security` exits 44 for "not found" and 51 for "interaction not allowed". Neither
    // is worth surfacing: both mean the same thing to a caller — no login here.
    return null;
  }
}

/**
 * Parse the credentials blob.
 *
 * The shape is somebody else's, and the only honest defence against it changing is to
 * fail closed on one we do not recognise. A missing access token returns null rather
 * than a half-built identity: "no login" is a state every caller already handles, and a
 * credential with no token in it is not a credential.
 */
export function parseClaudeCredentials(raw, source) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;

  // The blob nests under `claudeAiOauth`; older writes put the same fields at the root.
  const nested = parsed.claudeAiOauth;
  const oauth = (typeof nested === "object" && nested !== null) ? nested : parsed;

  const accessToken = oauth.accessToken ?? oauth.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;

  const refreshToken = oauth.refreshToken ?? oauth.refresh_token;
  const expiresAt = oauth.expiresAt ?? oauth.expires_at;
  const subscriptionType = oauth.subscriptionType ?? oauth.subscription_type;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    // An absent expiry is treated as already expired rather than as forever: the refresh
    // path can recover, whereas a token assumed valid that is not fails mid-generation.
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : 0,
    subscriptionType: typeof subscriptionType === "string" ? subscriptionType : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s) => typeof s === "string") : [],
    source,
  };
}

/** The login on this machine, or null when `claude` has never been signed in here. */
export async function readClaudeCodeLogin(options = {}) {
  const env = options.env ?? process.env;

  const fromKeychain = await (options.readKeychain ?? defaultKeychainRead)();
  if (fromKeychain) {
    const parsed = parseClaudeCredentials(fromKeychain, "keychain");
    if (parsed) return parsed;
  }

  const readPlain = options.readFile ?? (async () => {
    try { return await readFile(credentialsPath(env), "utf8"); } catch { return null; }
  });

  const raw = await readPlain();
  return raw ? parseClaudeCredentials(raw, "file") : null;
}

export function isClaudeExpired(identity, now = Date.now()) {
  return identity.expiresAt - EXPIRY_BUFFER_MS <= now;
}

export class ClaudeCodeAuthError extends Error {
  /** @param {boolean} needsLogin true when reconnecting cannot help — sign in again */
  constructor(message, needsLogin) {
    super(message);
    this.name = "ClaudeCodeAuthError";
    this.needsLogin = needsLogin;
  }
}

/**
 * Exchange a refresh token for a live access token. Only ever called on an identity
 * that has already expired — see the note at the top about not disturbing a live login.
 */
export async function refreshClaudeCodeToken(identity, options = {}) {
  if (!identity.refreshToken) {
    throw new ClaudeCodeAuthError(
      "That Claude subscription has expired and carries no refresh token. Connect it again.",
      true,
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response;
  try {
    response = await doFetch(
      options.endpoint ?? process.env.SANDBOXOS_CLAUDE_OAUTH_URL ?? OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: identity.refreshToken,
          client_id: options.clientId ?? process.env.CLAUDE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID,
        }),
      },
    );
  } catch (error) {
    throw new ClaudeCodeAuthError(
      `Could not reach Anthropic to refresh the Claude token: ${error.message}`,
      false,
    );
  }

  if (response.status === 400 || response.status === 401) {
    // Revoked or already rotated away. Retrying is noise; the user has to sign in again.
    throw new ClaudeCodeAuthError(
      "Anthropic rejected the stored Claude refresh token. Connect the subscription again.",
      true,
    );
  }
  if (!response.ok) {
    throw new ClaudeCodeAuthError(`Refreshing the Claude token failed with HTTP ${response.status}.`, false);
  }

  const body = await response.json().catch(() => null);
  const accessToken = body?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ClaudeCodeAuthError("Anthropic returned no access token when refreshing.", false);
  }

  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  const rotated = body?.refresh_token;

  return {
    ...identity,
    accessToken,
    refreshToken: typeof rotated === "string" && rotated.length > 0 ? rotated : identity.refreshToken,
    expiresAt: now() + expiresIn * 1000,
  };
}

/**
 * A live access token from the machine's own login, harvested and refreshed as needed.
 *
 * The in-memory cache holds one identity, because there is one login per machine. It
 * exists only to carry a *refreshed* token between calls — the file is still re-read
 * first every time, so the CLI signing out is noticed immediately.
 */
export class ClaudeCodeCredential {
  constructor(options = {}) {
    this.options = options;
    this.refreshed = null;
  }

  /** Is there a login, whose plan, and is it usable. */
  async status() {
    const identity = await readClaudeCodeLogin(this.options);
    if (!identity) {
      return { connected: false, subscriptionType: null, source: null, expiresAt: null, expired: false };
    }
    return {
      connected: true,
      subscriptionType: identity.subscriptionType,
      source: identity.source,
      expiresAt: identity.expiresAt || null,
      // Reported, not hidden: an expired token that can be refreshed still works, and
      // saying "expired" beside a working connection is more honest than a green light
      // relying on a refresh nobody mentioned.
      expired: isClaudeExpired(identity),
    };
  }

  async token() {
    const identity = await readClaudeCodeLogin(this.options);
    if (!identity) {
      throw new ClaudeCodeAuthError(
        "No Claude Code login found on this machine. Run `claude` and sign in, then try again.",
        true,
      );
    }

    if (!isClaudeExpired(identity)) {
      // The CLI's own token is live. Prefer it over anything cached: it is the newest
      // thing that exists, so a refresh we performed earlier cannot shadow a re-login.
      this.refreshed = null;
      return identity.accessToken;
    }

    if (this.refreshed && !isClaudeExpired(this.refreshed)) return this.refreshed.accessToken;

    this.refreshed = await refreshClaudeCodeToken(identity, this.options);
    return this.refreshed.accessToken;
  }
}
