// Model pricing and cost accounting.
//
// Rates are deliberately the *standard* published rates, not promotional ones.
// Under-estimating spend is the dangerous direction: it would let a budget guard wave
// through a call that costs more than it thinks. Over-estimating only means the ceiling
// bites slightly early, which is the safe failure.

import { pricingKeyFor } from "./models.js";

/**
 * Who to call and how the call is paid for — four, split by *billing*, not by vendor.
 *
 * `anthropic` and `openai` are metered API keys: every token has a published price, so
 * a ledger can add it up. `claude-code` and `codex` are subscriptions — the same wires,
 * the same endpoints, but paid for by a plan already bought. There is no per-token price
 * to charge, so they cost the deployment nothing. Modelling that as a *provider* rather
 * than as a flag on one keeps the distinction in one place instead of at every call site.
 */
export const PROVIDER_IDS = ["anthropic", "openai", "claude-code", "codex"];

/** Providers billed to a plan rather than by the token. */
export const SUBSCRIPTION_PROVIDERS = ["claude-code", "codex"];

export function isSubscription(provider) {
  return SUBSCRIPTION_PROVIDERS.includes(provider);
}

/** The wire a provider speaks, which is not the same question as who bills for it. */
export function wireOf(provider) {
  return provider === "anthropic" || provider === "claude-code" ? "anthropic" : "openai";
}

/** USD per million tokens. Verify against the provider's pricing page before changing. */
export const PRICING = {
  // Sonnet 5 had promotional $2/$10 rates into 2026; budgeting uses the standard rates.
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },

  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o4-mini": { input: 1.1, output: 4.4 },
};

/**
 * What an unlisted model is assumed to cost. Deliberately expensive: a model can be
 * typed into a settings field, so the table will fall behind, and a budget guard must
 * never be the thing that discovers it. Guessing low waves through a call costing
 * several times the estimate; guessing high only makes the ceiling bite early.
 */
export const UNKNOWN_MODEL_PRICING = { input: 15.0, output: 75.0 };

export function pricingFor(model) {
  const key = pricingKeyFor(model);
  return (key !== null ? PRICING[key] : undefined) ?? UNKNOWN_MODEL_PRICING;
}

/** True when the model is priced from the table rather than the pessimistic fallback. */
export function isPricingKnown(model) {
  return pricingKeyFor(model) !== null;
}

/**
 * Which provider a model belongs to, inferred from its name. Answers with a *metered*
 * provider on purpose: it is used where only a model name is in hand — a ledger row read
 * back from disk — and the metered rate is the conservative reading.
 */
export function providerOf(model) {
  return String(model ?? "").startsWith("claude") ? "anthropic" : "openai";
}

/** Cache writes cost more than fresh input; cache reads cost a fraction of it. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Nothing was spent, and every field says so. Used for the subscription providers. */
export const FREE = { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, totalUsd: 0 };

export function costOf(model, usage, provider) {
  // A plan has already been paid for, so there is no per-token amount to attribute. The
  // token counts are still reported — they are the honest measure of what a generation
  // took — but they cost this deployment nothing and a ledger must not pretend otherwise.
  if (provider && isSubscription(provider)) return { ...FREE };

  const rates = pricingFor(model);
  const perToken = (perMillion) => perMillion / 1_000_000;

  const inputUsd = (usage.input_tokens ?? 0) * perToken(rates.input);
  const outputUsd = (usage.output_tokens ?? 0) * perToken(rates.output);
  const cacheWriteUsd = (usage.cache_creation_input_tokens ?? 0) * perToken(rates.input) * CACHE_WRITE_MULTIPLIER;
  const cacheReadUsd = (usage.cache_read_input_tokens ?? 0) * perToken(rates.input) * CACHE_READ_MULTIPLIER;

  return { inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, totalUsd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd };
}

/**
 * Worst-case cost of a call before making it. Assumes `max_tokens` are all produced,
 * because a guard has to reason about what a call *could* cost, not what a typical one does.
 */
export function worstCaseCost(model, estimatedInputTokens, maxTokens, provider) {
  if (provider && isSubscription(provider)) return 0;
  const rates = pricingFor(model);
  return (estimatedInputTokens * rates.input + maxTokens * rates.output) / 1_000_000;
}

export function formatUsd(amount) {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
