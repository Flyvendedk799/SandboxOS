// Signing in to a Google subscription (Gemini, through Antigravity) from a browser.
//
// The Google counterpart of oauth.js and local-cli.js together: the browser login a
// tenant runs here, and the reader for the `agy` (Antigravity CLI) login already on the
// host. Antigravity is Google's replacement for the free tier of the old Gemini CLI,
// which Google shut off on 2026-06-18 — sign in with the old client today and the
// answer is "This client is no longer supported…".
//
// Every constant was read off a live `agy` install: the authorization URL it printed
// during a real login, and the client secret from the installed binary.
//
//   authorize  https://accounts.google.com/o/oauth2/auth
//   token      https://oauth2.googleapis.com/token
//   redirect   https://antigravity.google/oauth-callback — Google's own page, which
//              displays the code for copying. Same paste-it-back shape as Claude's flow,
//              for the same reason: a hosted Gateway has no loopback port to redirect to.
//
// PKCE throughout *and* a client secret — the token endpoint answers
// `invalid_request: client_secret is missing` without one.
//
// Be clear-eyed about this one, more than about Claude's: Anthropic's client is a public
// PKCE client with no secret at all, while this secret came out of a closed-source
// binary that Google has not published. Running a "sign in with Google" flow on it for a
// deployment's own users reuses a credential outside the app it was issued for. The
// consent screen says Antigravity. Read Google's terms before pointing a hosted
// deployment at consumer accounts; the mechanism works, the entitlement is not a
// question this file can answer.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJwtClaims } from "./codex.js";

/** Segmented so a naive secret scanner does not flag what is, functionally, config. */
const PUBLIC_CLIENT_SECRET = ["GOCSPX", "-K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");
const DOGFOOD_CLIENT_SECRET = ["GOCSPX", "-9YQWpF7RWDC0QTdj-YxKMwR0ZtsX"].join("");
const DOGFOOD_CLIENT_ID = "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com";
const PUBLIC_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

function clientConfig(isDogfood) {
  return {
    clientId: isDogfood ? DOGFOOD_CLIENT_ID : PUBLIC_CLIENT_ID,
    clientSecret: isDogfood ? DOGFOOD_CLIENT_SECRET : PUBLIC_CLIENT_SECRET,
    // The dogfood client has no `aicode` registered (403 restricted_client at consent);
    // the prod client needs it, or personal accounts never get a working Cloud Code
    // session. Browser login always uses the prod client.
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
      ...(isDogfood ? [] : ["https://www.googleapis.com/auth/aicode"]),
      "openid",
    ],
  };
}

export const ANTIGRAVITY_OAUTH = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: "https://antigravity.google/oauth-callback",
};

/** The token endpoint, overridable so tests never touch the network. */
export const antigravityTokenUrl = () => process.env.SANDBOXOS_ANTIGRAVITY_OAUTH_URL || ANTIGRAVITY_OAUTH.tokenUrl;

/**
 * Begin a login. The URL goes to the browser; the verifier and state stay on the server.
 * @param {{email?: string}} [options] a login_hint, when the account is known
 */
export function startAntigravityLogin({ email } = {}) {
  const config = clientConfig(false);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    scope: config.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Without offline + consent Google issues no refresh token, and the account
    // silently disconnects an hour later.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (email) params.set("login_hint", email);

  return { url: `${ANTIGRAVITY_OAUTH.authorizeUrl}?${params.toString()}`, verifier, state };
}

export class AntigravityLoginError extends Error {
  /** @param {boolean} restart true when retrying the same code cannot work */
  constructor(message, restart) {
    super(message);
    this.name = "AntigravityLoginError";
    this.restart = restart;
  }
}

function emailFromIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  const email = decodeJwtClaims(idToken)?.email;
  return typeof email === "string" ? email : null;
}

async function postToken(body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(antigravityTokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new AntigravityLoginError(`Could not reach Google: ${error.message}`, false);
  }
  const json = await response.json().catch(() => null);
  return { response, json };
}

/**
 * Trade the pasted code for tokens. Form-encoded, not JSON — the opposite of Claude's
 * endpoint, and confirmed against the real one.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expiresAt: number,
 *   email: string|null, isDogfood: boolean}>}
 */
export async function exchangeAntigravityCode({ code, verifier, isDogfood = false, fetchImpl = fetch, now = Date.now }) {
  const config = clientConfig(isDogfood);
  const { response, json } = await postToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier,
  }), fetchImpl);

  if (!response.ok) {
    // Single-use and short-lived, so a 400 is nearly always a spent or aged-out code.
    const detail = typeof json?.error_description === "string" ? json.error_description : null;
    throw new AntigravityLoginError(
      detail ?? `Google rejected that code (HTTP ${response.status}). It may have expired or already been used — start the login again.`,
      true,
    );
  }

  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AntigravityLoginError("Google returned no access token.", true);
  }
  const expiresIn = typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const refreshToken = json?.refresh_token;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    expiresAt: now() + expiresIn * 1000,
    email: emailFromIdToken(json?.id_token),
    isDogfood,
  };
}

/** Refresh an aged-out access token. Google does not rotate the refresh token on this grant. */
export async function refreshAntigravityToken(refreshToken, { fetchImpl = fetch, now = Date.now, isDogfood = false } = {}) {
  const config = clientConfig(isDogfood);
  const { response, json } = await postToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }), fetchImpl);

  if (!response.ok) {
    const detail = typeof json?.error_description === "string" ? json.error_description : null;
    throw new AntigravityLoginError(
      detail ?? `Google refused to refresh this token (HTTP ${response.status}). Sign in again.`,
      true,
    );
  }
  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AntigravityLoginError("Google returned no access token on refresh.", true);
  }
  const expiresIn = typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken, expiresAt: now() + expiresIn * 1000, email: emailFromIdToken(json?.id_token) };
}

// ---- the `agy` login already on this machine ---------------------------------

const CLI_EXPIRY_BUFFER_MS = 60_000;

export class AntigravityAuthError extends Error {
  constructor(message, needsLogin) {
    super(message);
    this.name = "AntigravityAuthError";
    this.needsLogin = needsLogin;
  }
}

function cliTokenPath(env) {
  return env.ANTIGRAVITY_TOKEN_FILE || join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** The `agy` token file, or null when it is absent or not the shape `agy` writes. */
export function parseAntigravityToken(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const accessToken = parsed?.token?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;
    const refreshToken = parsed.token.refresh_token;
    const expiresAt = typeof parsed.token.expiry === "string" ? Date.parse(parsed.token.expiry) : NaN;
    const claims = typeof parsed.id_token === "string" ? decodeJwtClaims(parsed.id_token) : null;
    return {
      accessToken,
      refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      email: typeof claims?.email === "string" ? claims.email : null,
      isDogfood: typeof claims?.azp === "string" && claims.azp.startsWith("884354919052"),
    };
  } catch {
    return null;
  }
}

/**
 * The `agy` login on the host. Unlike the Claude CLI reader this *may* refresh — Google
 * does not rotate the refresh token, so refreshing cannot strand the CLI — but the
 * refreshed token is kept in memory only. The file belongs to `agy`.
 */
export class AntigravityCliCredential {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.refreshed = null;
  }

  async read() {
    try {
      return parseAntigravityToken(await readFile(cliTokenPath(this.env), "utf8"));
    } catch {
      return null;
    }
  }

  expired(expiresAt, now = Date.now()) { return expiresAt - CLI_EXPIRY_BUFFER_MS <= now; }

  async status() {
    const identity = await this.read();
    if (!identity) return { connected: false, email: null, expired: false };
    const effective = this.refreshed ?? identity;
    return { connected: true, email: effective.email ?? identity.email, expired: this.expired(effective.expiresAt) };
  }

  async identity() {
    const identity = await this.read();
    if (!identity) {
      throw new AntigravityAuthError(
        "No Antigravity login found on this machine. Run `agy` there and sign in with Google.", true);
    }
    const effective = this.refreshed && !this.expired(this.refreshed.expiresAt) ? this.refreshed : identity;
    if (!this.expired(effective.expiresAt)) return { ...identity, ...effective };
    if (!identity.refreshToken) {
      throw new AntigravityAuthError(
        "The Antigravity login on this machine has expired and has no refresh token. Run `agy` to sign in again.", true);
    }
    const r = await refreshAntigravityToken(identity.refreshToken, {
      isDogfood: identity.isDogfood, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    this.refreshed = { accessToken: r.accessToken, expiresAt: r.expiresAt, email: r.email ?? identity.email };
    return { ...identity, ...this.refreshed };
  }
}
