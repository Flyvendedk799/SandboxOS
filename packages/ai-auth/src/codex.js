// Harvest the Codex / ChatGPT subscription login already on this machine.
//
// The counterpart to local-cli.js: the `codex` CLI, once signed in with a ChatGPT
// subscription rather than an API key, leaves an OAuth credential at
// ~/.codex/auth.json. Calls made with it are billed to the plan.
//
// One difference from the Claude side, and it is deliberate: **this never refreshes.**
// The `codex` CLI keeps its own token fresh, and OpenAI rotates the refresh token on
// exchange — so a refresh performed here would hand the Gateway a token the CLI does
// not have and leave the CLI holding one that has been spent. Breaking the operator's
// own CLI to save them one sign-in is a bad trade. When the token has expired the
// answer is "run `codex` again", which costs nothing because the CLI refreshes on start.
//
// The file has no `expires_in`; the expiry is in the access token's own JWT claims.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPIRY_BUFFER_MS = 60_000;

export class CodexAuthError extends Error {
  constructor(message, needsLogin) {
    super(message);
    this.name = "CodexAuthError";
    this.needsLogin = needsLogin;
  }
}

function authPath(env) {
  return env.CODEX_AUTH_FILE || join(homedir(), ".codex", "auth.json");
}

/**
 * The claims of a JWT, without verifying it.
 *
 * Verification would need OpenAI's signing keys and would buy nothing: this is not a
 * token we are *accepting*, it is one we are about to *present*. The only things read
 * out of it are when it expires and which account it belongs to, and being wrong about
 * either costs one rejected request.
 */
export function decodeJwtClaims(jwt) {
  const parts = String(jwt ?? "").split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** The ChatGPT account id, from wherever this token happens to carry it. */
export function accountIdFromToken(jwt) {
  const claims = decodeJwtClaims(jwt);
  if (!claims) return null;

  const auth = claims["https://api.openai.com/auth"];
  if (typeof auth === "object" && auth !== null) {
    const id = auth.chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }

  const orgs = claims.organizations;
  if (Array.isArray(orgs) && orgs.length > 0 && typeof orgs[0]?.id === "string" && orgs[0].id) {
    return orgs[0].id;
  }

  return null;
}

function planFromToken(jwt) {
  const auth = decodeJwtClaims(jwt)?.["https://api.openai.com/auth"];
  if (typeof auth !== "object" || auth === null) return null;
  return typeof auth.chatgpt_plan_type === "string" && auth.chatgpt_plan_type ? auth.chatgpt_plan_type : null;
}

/**
 * Parse ~/.codex/auth.json.
 *
 * The CLI has written both `{ tokens: {...} }` and a flat object over its life, and
 * both snake_case and camelCase within, so all four shapes are accepted — this is
 * somebody else's file format and the cost of being generous is four `??`s.
 */
export function parseCodexAuth(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;

  const nested = parsed.tokens;
  const tokens = (typeof nested === "object" && nested !== null) ? nested : parsed;

  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;

  const refreshToken = tokens.refresh_token ?? tokens.refreshToken;
  const idTokenRaw = tokens.id_token ?? tokens.idToken;
  const idToken = typeof idTokenRaw === "string" ? idTokenRaw : "";
  const direct = tokens.account_id ?? tokens.accountId;
  const exp = decodeJwtClaims(accessToken)?.exp;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    accountId: (typeof direct === "string" && direct.length > 0)
      ? direct
      : accountIdFromToken(accessToken) ?? (idToken ? accountIdFromToken(idToken) : null),
    // No `exp` claim is treated as already expired, for the same reason as the Claude
    // side: a token wrongly assumed live fails in the middle of a generation.
    expiresAt: typeof exp === "number" && exp > 0 ? exp * 1000 : 0,
    email: typeof tokens.email === "string" ? tokens.email : null,
    planType: planFromToken(accessToken) ?? (idToken ? planFromToken(idToken) : null),
  };
}

export async function readCodexLogin(options = {}) {
  const env = options.env ?? process.env;
  const read = options.readFile ?? (async () => {
    try { return await readFile(authPath(env), "utf8"); } catch { return null; }
  });
  const raw = await read();
  return raw ? parseCodexAuth(raw) : null;
}

export function isCodexExpired(identity, now = Date.now()) {
  return identity.expiresAt - EXPIRY_BUFFER_MS <= now;
}

/** Re-read on every call, exactly as with Claude Code: the CLI owns this file, not us. */
export class CodexCredential {
  constructor(options = {}) { this.options = options; }

  async status() {
    const identity = await readCodexLogin(this.options);
    if (!identity) {
      return { connected: false, planType: null, email: null, accountId: null, expiresAt: null, expired: false };
    }
    return {
      connected: true,
      planType: identity.planType,
      email: identity.email,
      accountId: identity.accountId,
      expiresAt: identity.expiresAt || null,
      expired: isCodexExpired(identity, (this.options.now ?? Date.now)()),
    };
  }

  async identity() {
    const identity = await readCodexLogin(this.options);
    if (!identity) {
      throw new CodexAuthError(
        "No Codex login found on this machine. Run `codex` and sign in with your ChatGPT account.",
        true,
      );
    }
    if (isCodexExpired(identity, (this.options.now ?? Date.now)())) {
      throw new CodexAuthError(
        "The Codex login on this machine has expired. Run `codex` once to refresh it — the CLI keeps its own token current.",
        true,
      );
    }
    return identity;
  }
}
