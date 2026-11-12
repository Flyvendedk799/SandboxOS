// ai-auth — bring-your-own-credential auth for Anthropic, OpenAI and Google Gemini.
//
// Three ways to pay for a model call, behind one small set of pieces:
//
//   * **A Claude subscription the tenant signs in to, here.** OAuth with PKCE, the same
//     flow `claude` runs, driven from the browser. Each account brings its own plan, so
//     a call costs the person who asked for it rather than whoever set the host up.
//   * **A subscription already signed in on the machine.** If `claude` or `codex` is
//     logged in on the box, the credential is already there. Read it, use it, never
//     disturb it.
//   * **An ordinary API key.** Encrypted at rest, resolved from storage or the
//     environment, masked for display and never readable back out.
//
// Ported from github.com/Flyvendedk799/ai-auth. No runtime dependencies, Node built-ins
// only — which is what let it come in as source rather than as a TypeScript build step
// the rest of this tree does not have. Storage is SandboxOS's own encrypted
// tenant_secrets rather than the library's Postgres/JSON adapters; the crypto and the
// wire details are unchanged, because those are the parts that cost a day each.

export { SecretBox, maskSecret } from "./secret-box.js";
export { MemoryCredentialStore, TenantCredentialStore, TENANT_CREDENTIAL_PREFIX } from "./store.js";

export {
  CLAUDE_OAUTH, ClaudeLoginError, exchangeClaudeCode, parsePastedCode, sameState,
  startClaudeLogin, tokenUrl,
} from "./oauth.js";

export {
  ClaudeCodeAuthError, ClaudeCodeCredential, isClaudeExpired, parseClaudeCredentials,
  readClaudeCodeLogin, refreshClaudeCodeToken,
} from "./local-cli.js";

export {
  CodexAuthError, CodexCredential, accountIdFromToken, decodeJwtClaims, isCodexExpired,
  parseCodexAuth, readCodexLogin,
} from "./codex.js";

export {
  ANTIGRAVITY_OAUTH, AntigravityAuthError, AntigravityCliCredential, AntigravityLoginError,
  antigravityTokenUrl, exchangeAntigravityCode, parseAntigravityToken, refreshAntigravityToken,
  startAntigravityLogin,
} from "./antigravity.js";

export { ClaudeAccountStore } from "./account-store.js";
export { AntigravityAccountStore } from "./antigravity-account-store.js";
export { antigravityAccounts, apiKeys, claudeAccounts, _resetHostSecret } from "./tenant.js";
export { ApiKeyStore } from "./key-store.js";

export {
  FREE, PRICING, PROVIDER_IDS, SUBSCRIPTION_PROVIDERS, UNKNOWN_MODEL_PRICING, costOf,
  formatUsd, isPricingKnown, isSubscription, pricingFor, providerOf, ratesAt, wireOf, worstCaseCost,
} from "./pricing.js";

export {
  MODELS, defaultModelFor, defaultModels, modelSpec, modelsFor, pricingKeyFor, providersForModel,
} from "./models.js";
export { describeProviderError, providerErrorFacts } from "./errors.js";

export {
  ANTHROPIC_VERSION, CLAUDE_CODE_BETA, CLAUDE_CODE_SYSTEM, CLAUDE_CODE_VERSION,
  CODEX_BASE_URL, anthropicKeyOptions, anthropicSubscriptionOptions, codexOptions,
  codexResponsesBody, httpHeadersFor, openAiKeyOptions, withClaudeCodeIdentity,
} from "./clients.js";

export {
  ANTIGRAVITY_CLIENT_VERSION, CLOUD_CODE_DAILY_BASE_URL, CLOUD_CODE_PROD_BASE_URL,
  GEMINI_38_FLASH_TIERED, GEMINI_STUDIO_BASE_URL, GOOGLE_ENTERPRISE_CLOUD_CODE_PROJECT,
  antigravityCliOptions, antigravityClientVersion, antigravityThinkingLevel, geminiKeyOptions,
  geminiStudioModelId, isAntigravityUpgradeNotice, normalizeAntigravityModelId,
  sanitizePersonalCloudCodeProject, toCodeAssistRequest,
} from "./gemini.js";

export { sanitizeGeminiFunctionParameters } from "./gemini-schema.js";
