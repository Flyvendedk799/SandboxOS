// The models worth offering, and how heavy each one is.
//
// A catalogue rather than a hardcoded list in one settings page, because two separate
// things need to agree about it: whatever renders a chooser, and whatever prices a call.
// When they disagree you get a picker offering a model the ledger has never heard of.
//
// `tier` is the field that earns this file. A subscription meters each model on its
// **own** allowance, so a heavy model can be refused for hours while a light one answers
// every request — and the fastest fix for that 429 is to pick something lighter. A
// chooser that shows only names cannot help anyone do that; one that shows weight can.
//
// The list is not a closed set. Providers ship models faster than any catalogue updates,
// so a typed-in id is still accepted everywhere — this is the shortcut, not the gate.

import { PRICING, wireOf } from "./pricing.js";

export const MODELS = [
  {
    id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", wire: "anthropic", tier: "light",
    note: "Fastest and cheapest. The one still answering when a plan refuses the others.",
  },
  {
    id: "claude-sonnet-5", label: "Sonnet 5", wire: "anthropic", tier: "balanced",
    note: "The usual choice — strong output without Opus prices.",
  },
  {
    id: "claude-opus-5", label: "Opus 5", wire: "anthropic", tier: "heavy",
    note: "Most capable, strictest allowance, highest rate.",
  },
  { id: "gpt-5-mini", label: "GPT-5 mini", wire: "openai", tier: "light", note: "Fast and cheap." },
  { id: "gpt-5", label: "GPT-5", wire: "openai", tier: "balanced", note: "The usual choice on the OpenAI wire." },
  { id: "o4-mini", label: "o4-mini", wire: "openai", tier: "light", note: "Reasoning model, small." },
  { id: "gpt-4.1", label: "GPT-4.1", wire: "openai", tier: "balanced", note: "Previous generation, still solid." },
];

const TIER_ORDER = { light: 0, balanced: 1, heavy: 2 };

/** The models that make sense for a provider, lightest first. */
export function modelsFor(provider) {
  const wire = wireOf(provider);
  return MODELS.filter((model) => model.wire === wire)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

export function modelSpec(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

/**
 * The pricing table's key for a model id, allowing for a dated suffix.
 *
 * Vendors publish both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, and the
 * second is the one you actually call. Exact-matching the table meant the dated id fell
 * through to the pessimistic unknown-model rate — so a correctly configured deployment
 * was told its model had no published price and its budget guard quietly priced it at
 * several times the truth.
 *
 * Longest match wins, so `gpt-4.1-mini` cannot be swallowed by `gpt-4.1`.
 */
export function pricingKeyFor(model) {
  const id = String(model ?? "");
  if (PRICING[id]) return id;
  let best = null;
  for (const key of Object.keys(PRICING)) {
    if (!id.startsWith(key)) continue;
    // A dated suffix, not a different model: `gpt-4.1-mini` must not match `gpt-4.1`.
    if (!/^-\d{6,8}$/.test(id.slice(key.length))) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best;
}
