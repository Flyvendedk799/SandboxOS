// Signing in to a Claude subscription from a browser, the way the CLI does it.
//
// The alternative — harvesting the one `claude` login on the host machine, which
// local-cli.js does — is right for a self-hosted box and wrong for a shared one:
// every tenant's calls would be billed to whoever set the Gateway up. This is the
// fix. Each account brings its own subscription, so a call costs the person who
// asked for it.
//
// The flow is Claude Code's own, and deliberately the *manual* half of it rather
// than the localhost-callback half: the CLI can open a browser and listen on
// 127.0.0.1, and a Gateway cannot listen on the user's machine at all. So the user
// opens an authorization URL, approves there, and pastes back a code — exactly the
// path the CLI takes when it cannot bind a port, and the reason that path exists.
//
// Every constant below was read out of the installed CLI rather than guessed,
// because a wrong endpoint fails as an opaque HTML page rather than as an error.
//
// PKCE throughout. There is no client secret — this is a public client — so the
// verifier is the only thing binding the code to the session that asked for it, and
// it must never leave the Gateway.
//
// One thing to be clear-eyed about: the consent screen says **Claude Code**, because
// that is whose client id this flow uses. Tell your users, and read Anthropic's
// subscription terms before pointing a hosted deployment at consumer plans. The
// mechanism is sound; whether a given deployment is entitled to use it is not a
// question this file can answer.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CLAUDE_OAUTH = {
  authorizeUrl: "https://platform.claude.com/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  /** Where the code is shown for copying, rather than posted back to us. */
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  /**
   * Exactly what a real Claude Code login asks for — read off a live credential
   * rather than chosen. Asking for less risks the token being refused for inference;
   * asking for more would be a broader grant than the CLI itself takes.
   */
  scopes: [
    "user:file_upload",
    "user:inference",
    "user:mcp_servers",
    "user:profile",
    "user:sessions:claude_code",
  ],
};

/** The token endpoint, overridable so tests never touch the network. */
export const tokenUrl = () => process.env.SANDBOXOS_CLAUDE_OAUTH_URL || CLAUDE_OAUTH.tokenUrl;

/**
 * Begin a login.
 * @returns {{url: string, verifier: string, state: string}} the URL is shown to the
 *   user; the verifier and state stay on the server.
 */
export function startClaudeLogin() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const params = new URLSearchParams({
    // Tells the authorize page to display a code for copying instead of redirecting
    // to a loopback port we do not have.
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  return { url: `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`, verifier, state };
}

/**
 * Split what the user pasted.
 *
 * The authorize page hands back `code#state`, and people paste it with whitespace,
 * wrapped across lines, or occasionally as the whole URL they were looking at. All
 * three are the same intent and none is a mistake worth refusing — so the shapes are
 * accepted and only a genuinely empty code is rejected.
 *
 * @returns {{code: string, state: string|null}|null}
 */
export function parsePastedCode(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\s+/g, "");
  if (trimmed.length === 0) return null;

  // Someone pasted the address bar. Take the query's code and state, not the URL.
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code");
      if (!code) return null;
      return { code, state: url.searchParams.get("state") };
    } catch {
      return null;
    }
  }

  const [code, state] = trimmed.split("#");
  if (!code) return null;
  return { code, state: state && state.length > 0 ? state : null };
}

/**
 * Constant-time state comparison.
 *
 * `state` is what stops a code obtained in someone else's login from being pasted
 * into this one, so this is the security check and not a formality. Constant time
 * because the cost of doing it properly is one function call.
 */
export function sameState(expected, actual) {
  const a = Buffer.from(String(expected ?? ""));
  const b = Buffer.from(String(actual ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class ClaudeLoginError extends Error {
  /** @param {boolean} restart true when retrying the same code cannot work */
  constructor(message, restart) {
    super(message);
    this.name = "ClaudeLoginError";
    this.restart = restart;
  }
}

/**
 * Trade the pasted code for tokens.
 *
 * The body shape is the CLI's, field for field — `grant_type`, `code`, `redirect_uri`,
 * `client_id`, `code_verifier`, `state`, posted as JSON. Sending it form-encoded,
 * which is what most OAuth servers expect, is rejected here.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expiresAt: number,
 *   scopes: string[], subscriptionType: string|null}>}
 */
export async function exchangeClaudeCode({ code, state, verifier, fetchImpl = fetch, now = Date.now }) {
  let response;
  try {
    response = await fetchImpl(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        client_id: CLAUDE_OAUTH.clientId,
        code_verifier: verifier,
        state,
      }),
    });
  } catch (error) {
    throw new ClaudeLoginError(`Could not reach Anthropic: ${error.message}`, false);
  }

  if (response.status === 401 || response.status === 400) {
    // An authorization code is single-use and short-lived, so this is nearly always a
    // code already spent or aged out — neither of which a retry fixes.
    throw new ClaudeLoginError(
      "Anthropic rejected that code. It may have expired or already been used — start the login again.",
      true,
    );
  }
  if (!response.ok) {
    throw new ClaudeLoginError(`Anthropic returned HTTP ${response.status}.`, false);
  }

  const body = await response.json().catch(() => null);
  const accessToken = body?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ClaudeLoginError("Anthropic returned no access token.", true);
  }

  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  const refreshToken = body?.refresh_token;
  const scope = body?.scope;
  const account = body?.account;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    expiresAt: now() + expiresIn * 1000,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
    subscriptionType: account && typeof account === "object" ? account.subscription_type ?? null : null,
  };
}
