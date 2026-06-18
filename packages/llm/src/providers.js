import { getTenantProfile, LLM_PROVIDERS } from "../../control-db/src/registry.js";
import { getTenantSecretValue, tenantSecretExists } from "../../secrets/src/store.js";

export const PROVIDERS = {
  claude: {
    id: "claude",
    label: "Claude",
    envName: "ANTHROPIC_API_KEY",
    secretName: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5-20251001",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    envName: "OPENAI_API_KEY",
    secretName: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
  },
};

export function providerConfig(provider) {
  return PROVIDERS[provider] ?? PROVIDERS.claude;
}

export function providerOptions(tenantId) {
  return LLM_PROVIDERS.map((id) => {
    const cfg = providerConfig(id);
    return {
      id,
      label: cfg.label,
      secretName: cfg.secretName,
      configured: tenantSecretExists(tenantId, cfg.secretName) || !!process.env[cfg.envName],
    };
  });
}

export function resolveLlmCredential(tenantId, providerOverride = null) {
  const profile = getTenantProfile(tenantId);
  const provider = providerOverride ?? profile.llm_provider ?? "claude";
  const cfg = providerConfig(provider);
  const stored = getTenantSecretValue(tenantId, cfg.secretName);
  const env = process.env[cfg.envName] || null;
  const apiKey = stored || env;
  return {
    provider: cfg.id,
    label: cfg.label,
    modelDefault: cfg.defaultModel,
    models: cfg.models,
    secretName: cfg.secretName,
    envName: cfg.envName,
    apiKey,
    source: stored ? "profile" : env ? "env" : null,
    configured: !!apiKey,
    profile,
  };
}
