// Model pricing and cost accounting.
//
// Rates are deliberately the *standard* published rates, not promotional ones.
// Under-estimating spend is the dangerous direction: it would let a budget guard wave
// through a call that costs more than it thinks. Over-estimating only means the ceiling
// bites slightly early, which is the safe failure.

import { pricingKeyFor } from "./models.js";

/**
 * Who to call and how the call is paid for — split by *billing*, not by vendor.
 *
 * `anthropic`, `openai` and `gemini` are metered API keys: every token has a published
 * price, so a ledger can add it up. `claude-code`, `codex` and `gemini-cli` are
 * subscriptions — the same wires (Cloud Code for Gemini), paid for by a plan already
 * bought. There is no per-token price to charge, so they cost the deployment nothing.
 * Modelling that as a *provider* rather than as a flag on one keeps the distinction in
 * one place instead of at every call site.
 *
 * SandboxOS calls the metered Anthropic provider `claude`; it is accepted here as an
 * alias of `anthropic` everywhere a provider is taken, because a wire lookup that did
 * not know it sent the API-key Claude provider the OpenAI catalogue.
 */
export const PROVIDER_IDS = ["anthropic", "openai", "gemini", "claude-code", "codex", "gemini-cli"];

/** Providers billed to a plan rather than by the token. */
export const SUBSCRIPTION_PROVIDERS = ["claude-code", "codex", "gemini-cli"];

export function isSubscription(provider) {
  return SUBSCRIPTION_PROVIDERS.includes(provider);
}

/** The wire a provider speaks, which is not the same question as who bills for it. */
export function wireOf(provider) {
  if (provider === "gemini" || provider === "gemini-cli") return "gemini";
  if (provider === "anthropic" || provider === "claude" || provider === "claude-code") return "anthropic";
  return "openai";
}

/**
 * USD per million tokens. Verify against the provider's pricing page before changing.
 *
 * `cacheRead` is the published cache-hit rate where it is not the usual tenth of input
 * (the 5.5 generation reads cache at a twentieth or less). `longContext` is a second
 * rate that applies to the whole call once the prompt passes `above` input tokens —
 * Haiku 5.5's is five times its base rate, and pricing a long prompt at the short rate
 * is the under-estimate this table must never make.
 */
export const PRICING = {
  "claude-fable-5-2": { input: 8.0, output: 40.0, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-5-5": {
    input: 0.1, output: 0.5,
    longContext: { above: 100_000, input: 0.5, output: 2.5 },
  },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },

  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o4-mini": { input: 1.1, output: 4.4 },

  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 5.0 },
  "gemini-3-flash": { input: 0.15, output: 0.6 },
  "gemini-3-pro": { input: 1.25, output: 5.0 },
  "gemini-3.1-pro": { input: 1.25, output: 5.0 },
  // Introductory rate through 2026-12-31; the standard rate afterward is $1.5 / $7.5.
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash-low": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash-medium": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash-high": { input: 0.75, output: 3.75 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.8-flash-low": { input: 0.75, output: 3.75 },
  "gemini-3.8-flash-medium": { input: 0.75, output: 3.75 },
  "gemini-3.8-flash-high": { input: 0.75, output: 3.75 },
  "gemini-4-argon": { input: 1.25, output: 5.0 },
  "gemini-4-argon-low": { input: 0.75, output: 3.75 },
  "gemini-4-argon-medium": { input: 1.25, output: 5.0 },
  "gemini-4-argon-high": { input: 2.5, output: 10.0 },
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
  const id = String(model ?? "");
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gemini")) return "gemini";
  return "openai";
}

/** The rates that apply to a call with this many prompt tokens. */
export function ratesAt(rates, promptTokens) {
  const long = rates.longContext;
  if (long && promptTokens > long.above) return { ...rates, input: long.input, output: long.output, cacheRead: undefined };
  return rates;
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

  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  const rates = ratesAt(pricingFor(model), promptTokens);
  const perToken = (perMillion) => perMillion / 1_000_000;

  const inputUsd = (usage.input_tokens ?? 0) * perToken(rates.input);
  const outputUsd = (usage.output_tokens ?? 0) * perToken(rates.output);
  const cacheWriteUsd = (usage.cache_creation_input_tokens ?? 0) * perToken(rates.input) * CACHE_WRITE_MULTIPLIER;
  const cacheReadUsd = (usage.cache_read_input_tokens ?? 0)
    * perToken(rates.cacheRead ?? rates.input * CACHE_READ_MULTIPLIER);

  return { inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, totalUsd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd };
}

/**
 * Worst-case cost of a call before making it. Assumes `max_tokens` are all produced,
 * because a guard has to reason about what a call *could* cost, not what a typical one does.
 */
export function worstCaseCost(model, estimatedInputTokens, maxTokens, provider) {
  if (provider && isSubscription(provider)) return 0;
  const rates = ratesAt(pricingFor(model), estimatedInputTokens);
  return (estimatedInputTokens * rates.input + maxTokens * rates.output) / 1_000_000;
}

export function formatUsd(amount) {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
