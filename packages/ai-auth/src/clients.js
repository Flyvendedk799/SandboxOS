// How to configure a call for each way of paying.
//
// What is carried here is a set of details that are individually small and each cost a
// day to find out. They are the reason this file exists.
//
// Two shapes are exported. `*Options` return the objects the official SDKs take, so a
// consumer using @anthropic-ai/sdk or openai can hand one straight to a constructor —
// neither SDK is imported anywhere here. `httpHeadersFor` turns the same facts into
// plain fetch headers, which is what SandboxOS itself uses: the spine talks to both
// APIs over global fetch and has no SDK to configure.

/**
 * The system block a Claude Code OAuth token has to carry.
 *
 * This is not decoration and it is not optional. Authenticating with a subscription
 * token and *not* sending it gets the premium models refused — with HTTP 429 and a
 * `rate_limit_error`, which is as misleading a status as the API could have picked,
 * because the plan is nowhere near its limit and the same token answers instantly on a
 * lighter model.
 *
 * Established by experiment against the live API, on one account, within a few seconds,
 * with only the system prompt varying:
 *
 *     opus-5   identity as the first system block                    → 200
 *     opus-5   identity as the second block                          → 429
 *     opus-5   a different opening sentence                          → 429
 *     opus-5   identity concatenated into one block with the prompt  → 429
 *     opus-5   no identity at all                                    → 429
 *     sonnet-5 identity as the first system block                    → 200
 *     haiku    no identity at all                                    → 200
 *
 * So three things are load-bearing, and each was a separate 429 before it was
 * understood: the text must match exactly, it must be the **first** block, and it must
 * be a block **of its own** — folding it into the front of your own prompt does not count.
 *
 * Haiku's exemption is the trap. It is the natural model to test with, being cheap and
 * fast, and it passes without the identity — so a request shape that is broken for every
 * model anyone actually wants looks perfectly healthy on the one they tried.
 *
 * The usual caveat applies, harder here than anywhere else: this makes the request claim
 * to be Claude Code, because that is whose client id minted the token and whose plan is
 * paying. Read the subscription terms before pointing a hosted deployment at a consumer plan.
 */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Your system prompt, with the identity block in front of it.
 *
 * Accepts a bare string or blocks you have already built, and is a no-op when the
 * identity is already first — so it is safe to apply at more than one layer, which
 * matters because the layer that knows the credential is a subscription is rarely the
 * layer that owns the prompt.
 *
 * The identity block is deliberately left uncached: it is one short sentence, caching
 * has a minimum size, and each `cache_control` marker spends one of the four breakpoints
 * a request is allowed — better spent on the prompt that is actually long.
 */
export function withClaudeCodeIdentity(system) {
  const given = typeof system === "string" ? [{ type: "text", text: system }] : [...(system ?? [])];
  // An empty block is dropped rather than carried. A caller with no prompt of its own —
  // `llm.complete` without a `system` argument is the ordinary case — would otherwise
  // produce `[identity, ""]`, and Anthropic refuses a request containing an empty text
  // block outright. The identity alone is the correct request, not a degenerate one.
  const blocks = given.filter((b) => typeof b?.text === "string" && b.text.length > 0);
  if (blocks[0]?.text === CLAUDE_CODE_SYSTEM) return blocks;
  return [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...blocks];
}

/**
 * The Claude Code client version this presents as. Anthropic gates the
 * OAuth-authenticated path on looking like the CLI. Bump it if a future release starts
 * refusing this one; it is not otherwise load-bearing.
 */
export const CLAUDE_CODE_VERSION = "2.1.75";

/** The beta flags a real Claude Code session sends. Read off the wire, not chosen. */
export const CLAUDE_CODE_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
].join(",");

export const ANTHROPIC_VERSION = "2023-06-01";

/** Codex speaks the OpenAI Responses API at its own host, not at api.openai.com. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** A metered Anthropic API key. Nothing surprising; here for symmetry with the other three. */
export function anthropicKeyOptions(apiKey) {
  return { apiKey };
}

/**
 * The same Anthropic wire, paid for by a subscription instead of a key.
 *
 * `authToken` rather than `apiKey`, and this is the one detail that has to be exactly
 * right. The SDK sends `Authorization: Bearer` for the former and `x-api-key` for the
 * latter, and Anthropic validates `x-api-key` whenever the header is *present*. A
 * placeholder key alongside a valid bearer token does not get ignored — it gets
 * rejected, and the request fails with "invalid x-api-key" while carrying a perfectly
 * good credential.
 *
 * So `apiKey` is null explicitly rather than merely omitted: left out, the SDK falls
 * back to ANTHROPIC_API_KEY from the environment, and a machine with both a key and a
 * subscription would send the key alongside the bearer and 401 — on a box where
 * everything looks correctly configured, which is the worst place for this to happen.
 *
 * **Not sufficient on their own.** Every request made with these must also open with the
 * Claude Code identity system block — see withClaudeCodeIdentity.
 */
export function anthropicSubscriptionOptions(accessToken) {
  return {
    authToken: accessToken,
    apiKey: null,
    defaultHeaders: {
      "anthropic-beta": CLAUDE_CODE_BETA,
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
      "x-app": "cli",
    },
  };
}

/** A metered OpenAI API key. */
export function openAiKeyOptions(apiKey) {
  return { apiKey };
}

/**
 * Codex, on a ChatGPT subscription.
 *
 * The account header is not optional in practice: without it the backend cannot tell
 * which subscription to bill and refuses the request. It is why the Codex identity goes
 * to the trouble of digging the account id out of the token's claims.
 */
export function codexOptions(identity, baseUrl = CODEX_BASE_URL) {
  return {
    apiKey: identity.accessToken,
    baseURL: baseUrl,
    defaultHeaders: {
      ...(identity.accountId ? { "chatgpt-account-id": identity.accountId } : {}),
      originator: "codex_cli_ts",
    },
  };
}

/**
 * The same four cases as fetch headers, for a caller with no SDK.
 *
 * Takes a resolved credential — `{ provider, apiKey, accessToken, accountId }` — and
 * returns exactly the headers that call needs. The subscription branches deliberately
 * emit no `x-api-key` at all, for the reason spelled out above: an unused key header
 * beside a working bearer token is not ignored, it is rejected.
 */
export function httpHeadersFor(credential) {
  const json = { "content-type": "application/json" };
  switch (credential.provider) {
    case "claude-code":
      return {
        ...json,
        authorization: `Bearer ${credential.accessToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": CLAUDE_CODE_BETA,
        "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
        "x-app": "cli",
      };
    case "codex":
      return {
        ...json,
        authorization: `Bearer ${credential.accessToken}`,
        ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
        originator: "codex_cli_ts",
      };
    case "openai":
      return { ...json, authorization: `Bearer ${credential.apiKey}` };
    default:
      return { ...json, "x-api-key": credential.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  }
}
