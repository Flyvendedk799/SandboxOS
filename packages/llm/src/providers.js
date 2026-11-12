// Which provider a tenant uses, which model, and what it takes to make a call as them.
//
// Six providers, and the split is by *billing*, not by vendor (the distinction ai-auth
// draws, and the reason it is drawn once here rather than at every call site):
//
//   claude       the Anthropic wire, paid for by a metered API key
//   claude-code  the same Anthropic wire, paid for by a Claude subscription the tenant
//                signed in to through the Gateway
//   openai       the OpenAI wire, paid for by a metered API key
//   codex        the OpenAI Responses API at ChatGPT's own host, paid for by a
//                subscription the operator signed in to with the `codex` CLI here
//   gemini       Google AI Studio, paid for by a metered API key
//   gemini-cli   Gemini through Google's Cloud Code endpoint, paid for by a Google
//                account the tenant signed in to through the Gateway (Antigravity)
//
// The subscription providers are why resolution is async: a key is a row read, but a
// subscription token may have to be refreshed before it can be used.
//
// The model is chosen the way OpenBot chooses it: the request's own model if it names
// one, else the tenant's saved default, else the provider's catalogue default — and the
// catalogue is ai-auth's, so a picker can never offer a model the ledger has not heard of.

import { getTenantProfile, LLM_PROVIDERS } from "../../control-db/src/registry.js";
import { getTenantSecretValue, tenantSecretExists } from "../../secrets/src/store.js";
import { antigravityAccounts, claudeAccounts } from "../../ai-auth/src/tenant.js";
import { ClaudeCodeCredential } from "../../ai-auth/src/local-cli.js";
import { CodexCredential } from "../../ai-auth/src/codex.js";
import { AntigravityCliCredential } from "../../ai-auth/src/antigravity.js";
import { defaultModelFor, modelsFor, providersForModel } from "../../ai-auth/src/models.js";
import { httpHeadersFor, withClaudeCodeIdentity } from "../../ai-auth/src/clients.js";

export const PROVIDERS = {
  claude: {
    id: "claude", label: "Claude (API key)", vendor: "Anthropic", wire: "anthropic", billing: "key",
    envName: "ANTHROPIC_API_KEY", secretName: "ANTHROPIC_API_KEY",
  },
  "claude-code": {
    id: "claude-code", label: "Claude subscription", vendor: "Anthropic", wire: "anthropic", billing: "subscription",
    envName: null, secretName: null,
  },
  openai: {
    id: "openai", label: "OpenAI (API key)", vendor: "OpenAI", wire: "openai", billing: "key",
    envName: "OPENAI_API_KEY", secretName: "OPENAI_API_KEY",
  },
  codex: {
    id: "codex", label: "ChatGPT subscription (Codex)", vendor: "OpenAI", wire: "openai", billing: "subscription",
    envName: null, secretName: null,
  },
  gemini: {
    id: "gemini", label: "Gemini (API key)", vendor: "Google", wire: "gemini", billing: "key",
    envName: "GEMINI_API_KEY", secretName: "GEMINI_API_KEY",
  },
  "gemini-cli": {
    id: "gemini-cli", label: "Google subscription (Antigravity)", vendor: "Google", wire: "gemini", billing: "subscription",
    envName: null, secretName: null,
  },
};

// Each provider's default model comes from the catalogue, never from a literal here: a
// hardcoded default is the one place a catalogue update does not reach.
for (const cfg of Object.values(PROVIDERS)) {
  Object.defineProperty(cfg, "defaultModel", { enumerable: true, get: () => defaultModelFor(cfg.id) });
}

/** The provider ids a tenant may select. The Registry owns the list, because it is the
 *  Registry that refuses to store anything else on a profile row. */
export const PROVIDER_IDS = LLM_PROVIDERS;

/** Each provider's catalogue default, OpenBot's DEFAULT_MODELS. */
export function defaultModels() {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, defaultModelFor(id)]));
}

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

/** Every SandboxOS provider whose catalogue lists this model. */
export function providersFor(model) {
  return providersForModel(model, PROVIDER_IDS);
}

/**
 * May this model be used with this provider? Yes when the catalogue lists it there, and
 * yes when the catalogue has never heard of it at all — a typed-in id is how a model
 * newer than the catalogue gets used. No only when the catalogue knows the model *and*
 * knows it belongs to a different wire: `gpt-5` on a Claude key is a mistake, not a
 * model too new to be listed.
 */
export function modelFitsProvider(model, provider) {
  const owners = providersFor(model);
  return owners.length === 0 || owners.includes(provider);
}

/**
 * The model a call should use: the request's own choice, else the tenant's saved one,
 * else the provider's catalogue default. A saved model that belongs to a different
 * provider (the tenant switched provider since) is passed over rather than sent.
 */
export function chooseModel(provider, { requested, saved } = {}) {
  const r = typeof requested === "string" ? requested.trim() : "";
  if (r) return r;
  const s = typeof saved === "string" ? saved.trim() : "";
  if (s && modelFitsProvider(s, provider)) return s;
  return defaultModelFor(provider);
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

  if (cfg.id === "gemini-cli") {
    const status = await antigravityAccounts(tenantId).status(tenantId);
    if (status.connected) {
      return { configured: true, detail: null, plan: status.email, expired: status.expired, projectId: status.projectId };
    }
    if (hostLoginAllowed()) {
      const host = await new AntigravityCliCredential().status();
      if (host.connected) return { configured: true, detail: "using the `agy` login on the host", plan: host.email };
    }
    return { configured: false, detail: "no Google subscription connected" };
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

/** Every provider with its configured state and catalogue — for a picker, never with key material. */
export async function providerOptions(tenantId) {
  return Promise.all(PROVIDER_IDS.map(async (id) => {
    const cfg = providerConfig(id);
    const state = await readiness(tenantId, cfg);
    return {
      id,
      label: cfg.label,
      vendor: cfg.vendor,
      billing: cfg.billing,
      wire: cfg.wire,
      secretName: cfg.secretName,
      configured: state.configured,
      detail: state.detail,
      plan: state.plan ?? null,
      models: providerModels(id),
      // What a picker shows: weight and a line on when to reach for each.
      catalogue: providerModelSpecs(id).map((m) => ({
        id: m.id, label: m.label, tier: m.tier, note: m.note, previous: !!m.previous,
      })),
      defaultModel: defaultModelFor(id),
    };
  }));
}

/**
 * The credential a call should be made with, and everything the caller needs to make it.
 *
 * `modelDefault` is the model a call uses when it does not name one: the tenant's saved
 * choice if it fits this provider, else the catalogue default. Pass `model` in `options`
 * to have it resolved the same way (request → tenant → catalogue) into `model`.
 *
 * Never throws for a missing credential: `configured: false` with an `error` sentence is
 * the answer, because every caller already has a path for "not set up" and none of them
 * wants an exception in the middle of a turn. It does propagate a *refresh* failure,
 * which is a different thing — the account is connected and the provider refused it, and
 * silently reporting that as "not configured" would send the user to paste a key they
 * do not need.
 */
export async function resolveLlmCredential(tenantId, providerOverride = null, options = {}) {
  const profile = getTenantProfile(tenantId);
  const provider = providerOverride ?? profile?.llm_provider ?? "claude";
  const cfg = providerConfig(provider);
  const modelDefault = chooseModel(cfg.id, { saved: profile?.llm_model });

  const base = {
    provider: cfg.id,
    label: cfg.label,
    wire: cfg.wire,
    billing: cfg.billing,
    modelDefault,
    model: chooseModel(cfg.id, { requested: options.model, saved: profile?.llm_model }),
    catalogueDefault: defaultModelFor(cfg.id),
    models: providerModels(cfg.id),
    secretName: cfg.secretName,
    envName: cfg.envName,
    apiKey: null,
    accessToken: null,
    accountId: null,
    projectId: null,
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

  if (cfg.id === "gemini-cli") {
    const accounts = antigravityAccounts(tenantId);
    const status = await accounts.status(tenantId);
    if (status.connected) {
      return {
        ...base, accessToken: await accounts.token(tenantId), projectId: status.projectId,
        source: "subscription", configured: true,
      };
    }
    if (hostLoginAllowed()) {
      const host = new AntigravityCliCredential();
      if ((await host.status()).connected) {
        const identity = await host.identity();
        return { ...base, accessToken: identity.accessToken, source: "host-cli", configured: true };
      }
    }
    return { ...base, error: "No Google subscription is connected for this tenant. Connect one in Settings." };
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
