// Which provider a tenant uses, and what it takes to make a call as them.
//
// Four providers, and the split is by *billing*, not by vendor (the distinction ai-auth
// draws, and the reason it is drawn once here rather than at every call site):
//
//   claude       the Anthropic wire, paid for by a metered API key
//   openai       the OpenAI wire, paid for by a metered API key
//   claude-code  the same Anthropic wire, paid for by a Claude subscription the tenant
//                signed in to through the Gateway
//   codex        the OpenAI wire at ChatGPT's own host, paid for by a subscription the
//                operator signed in to with the `codex` CLI on this machine
//
// The two subscription providers are why resolution is async: a key is a row read, but a
// subscription token may have to be refreshed against Anthropic before it can be used.

import { getTenantProfile, LLM_PROVIDERS } from "../../control-db/src/registry.js";
import { getTenantSecretValue, tenantSecretExists } from "../../secrets/src/store.js";
import { claudeAccounts } from "../../ai-auth/src/tenant.js";
import { ClaudeCodeCredential } from "../../ai-auth/src/local-cli.js";
import { CodexCredential } from "../../ai-auth/src/codex.js";
import { modelsFor } from "../../ai-auth/src/models.js";
import { httpHeadersFor, withClaudeCodeIdentity } from "../../ai-auth/src/clients.js";

export const PROVIDERS = {
  claude: {
    id: "claude",
    label: "Claude (API key)",
    wire: "anthropic",
    billing: "key",
    envName: "ANTHROPIC_API_KEY",
    secretName: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5-20251001",
  },
  openai: {
    id: "openai",
    label: "OpenAI (API key)",
    wire: "openai",
    billing: "key",
    envName: "OPENAI_API_KEY",
    secretName: "OPENAI_API_KEY",
    defaultModel: "gpt-5-mini",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude subscription",
    wire: "anthropic",
    billing: "subscription",
    envName: null,
    secretName: null,
    defaultModel: "claude-haiku-4-5-20251001",
  },
  codex: {
    id: "codex",
    label: "ChatGPT subscription (Codex)",
    wire: "openai",
    billing: "subscription",
    envName: null,
    secretName: null,
    defaultModel: "gpt-5-mini",
  },
};

/** The provider ids a tenant may select. The Registry owns the list, because it is the
 *  Registry that refuses to store anything else on a profile row. */
export const PROVIDER_IDS = LLM_PROVIDERS;

/**
 * May a subscription signed in on the *host machine* pay for a tenant's calls?
 *
 * Off by default, and the default is the whole point. On a shared host, quietly falling
 * back to the operator's own `claude` login would bill every tenant's work to one
 * person's plan — a bill they would not see until it arrived. Self-hosting a single-user
 * instance is the case where that is exactly what you want, so it is one env var away.
 */
const hostLoginAllowed = () => process.env.SANDBOXOS_HOST_SUBSCRIPTION === "1";

export function providerConfig(provider) {
  return PROVIDERS[provider] ?? PROVIDERS.claude;
}

/** The models worth offering for a provider, lightest first. Never a closed set. */
export function providerModels(provider) {
  return modelsFor(providerConfig(provider).id).map((m) => m.id);
}

/** The full catalogue entry for each model, for a picker that wants to show weight. */
export function providerModelSpecs(provider) {
  return modelsFor(providerConfig(provider).id);
}

/** Is this provider ready to make a call for this tenant, and why not if it is not. */
async function readiness(tenantId, cfg) {
  if (cfg.billing === "key") {
    const configured = tenantSecretExists(tenantId, cfg.secretName) || !!process.env[cfg.envName];
    return { configured, detail: configured ? null : `no ${cfg.secretName} stored for this tenant` };
  }

  if (cfg.id === "claude-code") {
    const status = await claudeAccounts(tenantId).status(tenantId);
    if (status.connected) return { configured: true, detail: null, plan: status.plan, expired: status.expired };
    if (hostLoginAllowed()) {
      const host = await new ClaudeCodeCredential().status();
      if (host.connected) {
        return { configured: true, detail: "using the `claude` login on the host", plan: host.subscriptionType };
      }
    }
    return { configured: false, detail: "no Claude subscription connected" };
  }

  // Codex has no browser login: OpenAI's device flow is not something a Gateway can
  // stand in for, so the only Codex credential that exists is the one the `codex` CLI
  // wrote on this machine — and using it on behalf of a tenant is the host-login case.
  if (!hostLoginAllowed()) {
    return { configured: false, detail: "set SANDBOXOS_HOST_SUBSCRIPTION=1 to use the host's `codex` login" };
  }
  const status = await new CodexCredential().status();
  return {
    configured: status.connected && !status.expired,
    detail: status.connected
      ? (status.expired ? "the host's `codex` login has expired — run `codex` once" : null)
      : "no `codex` login on this machine",
    plan: status.planType,
  };
}

/** Every provider with its configured state — for a picker, never with key material. */
export async function providerOptions(tenantId) {
  return Promise.all(PROVIDER_IDS.map(async (id) => {
    const cfg = providerConfig(id);
    const state = await readiness(tenantId, cfg);
    return {
      id,
      label: cfg.label,
      billing: cfg.billing,
      wire: cfg.wire,
      secretName: cfg.secretName,
      configured: state.configured,
      detail: state.detail,
      plan: state.plan ?? null,
      models: providerModels(id),
    };
  }));
}

/**
 * The credential a call should be made with, and everything the caller needs to make it.
 *
 * Never throws for a missing credential: `configured: false` with an `error` sentence is
 * the answer, because every caller already has a path for "not set up" and none of them
 * wants an exception in the middle of a turn. It does propagate a *refresh* failure,
 * which is a different thing — the account is connected and Anthropic refused it, and
 * silently reporting that as "not configured" would send the user to paste a key they
 * do not need.
 */
export async function resolveLlmCredential(tenantId, providerOverride = null) {
  const profile = getTenantProfile(tenantId);
  const provider = providerOverride ?? profile?.llm_provider ?? "claude";
  const cfg = providerConfig(provider);

  const base = {
    provider: cfg.id,
    label: cfg.label,
    wire: cfg.wire,
    billing: cfg.billing,
    modelDefault: cfg.defaultModel,
    models: providerModels(cfg.id),
    secretName: cfg.secretName,
    envName: cfg.envName,
    apiKey: null,
    accessToken: null,
    accountId: null,
    source: null,
    configured: false,
    error: null,
    profile,
  };

  if (cfg.billing === "key") {
    const stored = getTenantSecretValue(tenantId, cfg.secretName);
    const env = process.env[cfg.envName] || null;
    const apiKey = stored || env;
    return {
      ...base,
      apiKey,
      source: stored ? "profile" : env ? "env" : null,
      configured: !!apiKey,
      // The variable name is in the sentence on purpose: "no key is set" leaves an
      // operator guessing which of two they are missing, and the answer is on the row.
      error: apiKey ? null : `No ${cfg.label} key for this tenant — set ${cfg.secretName} in Settings or the environment.`,
    };
  }

  if (cfg.id === "claude-code") {
    const accounts = claudeAccounts(tenantId);
    if ((await accounts.status(tenantId)).connected) {
      return { ...base, accessToken: await accounts.token(tenantId), source: "subscription", configured: true };
    }
    if (hostLoginAllowed()) {
      const host = new ClaudeCodeCredential();
      if ((await host.status()).connected) {
        return { ...base, accessToken: await host.token(), source: "host-cli", configured: true };
      }
    }
    return { ...base, error: "No Claude subscription is connected for this tenant. Connect one in Settings." };
  }

  if (!hostLoginAllowed()) {
    return { ...base, error: "Codex runs on the host's own `codex` login; set SANDBOXOS_HOST_SUBSCRIPTION=1 to allow it." };
  }
  const codex = new CodexCredential();
  if (!(await codex.status()).connected) {
    return { ...base, error: "No `codex` login on this machine. Run `codex` and sign in with your ChatGPT account." };
  }
  const identity = await codex.identity();
  return {
    ...base,
    accessToken: identity.accessToken,
    accountId: identity.accountId,
    source: "host-cli",
    configured: true,
  };
}

/** The fetch headers this credential's call needs. See ai-auth's clients.js for why. */
export function credentialHeaders(credential) {
  return httpHeadersFor(credential);
}

/**
 * The system prompt in the shape this credential requires.
 *
 * On a subscription token the Claude Code identity block must come first and must be a
 * block of its own, or Anthropic refuses Sonnet and Opus with a 429 naming a rate limit
 * the plan is nowhere near — while Haiku, the model you would naturally test with,
 * answers fine. See CLAUDE_CODE_SYSTEM in ai-auth's clients.js for the measurements.
 */
export function systemFor(credential, system) {
  if (credential.provider !== "claude-code") return system;
  return withClaudeCodeIdentity(system ?? "");
}

/** Codex speaks the OpenAI wire at ChatGPT's own host, not at api.openai.com. */
export function baseUrlFor(credential, anthropicUrl, openaiUrl, codexUrl) {
  if (credential.provider === "codex") return codexUrl;
  return credential.wire === "openai" ? openaiUrl : anthropicUrl;
}
