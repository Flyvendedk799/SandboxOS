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

import { PRICING, PROVIDER_IDS, wireOf } from "./pricing.js";

/**
 * `previous` marks a model a newer one supersedes. It stays listed on purpose: a saved
 * choice is checked against this catalogue (providersForModel), and dropping the entry
 * would refuse a choice that still works. `default` marks the one model per wire a
 * provider uses when nobody has chosen — the balanced current model, not the cheapest,
 * because the cheapest is the one people then have to discover they should change.
 */
export const MODELS = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    id: "claude-haiku-5-5", label: "Haiku 5.5", wire: "anthropic", tier: "light",
    note: "Fastest and cheapest current Claude. The one still answering when a plan refuses the others.",
  },
  {
    id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", wire: "anthropic", tier: "light", previous: true,
    note: "Previous Haiku, superseded by Haiku 5.5.",
  },
  {
    id: "claude-sonnet-5-5", label: "Sonnet 5.5", wire: "anthropic", tier: "balanced", default: true,
    note: "The usual choice — strong coding and agent work without Opus prices.",
  },
  {
    id: "claude-sonnet-5", label: "Sonnet 5", wire: "anthropic", tier: "balanced", previous: true,
    note: "Previous Sonnet, superseded by Sonnet 5.5.",
  },
  {
    id: "claude-opus-5-5", label: "Opus 5.5", wire: "anthropic", tier: "heavy",
    note: "The current Opus — deep reasoning and long agent runs, below Fable prices.",
  },
  {
    id: "claude-fable-5-2", label: "Fable 5.2", wire: "anthropic", tier: "heavy",
    note: "Most capable Claude. Strictest allowance on a plan, highest rate on a key.",
  },
  {
    id: "claude-fable-5-1", label: "Fable 5.1", wire: "anthropic", tier: "heavy", previous: true,
    note: "Previous Fable, superseded by Fable 5.2.",
  },
  {
    id: "claude-opus-5", label: "Opus 5", wire: "anthropic", tier: "heavy", previous: true,
    note: "Previous Opus, superseded by Opus 5.5.",
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { id: "gpt-5-mini", label: "GPT-5 mini", wire: "openai", tier: "light", note: "Fast and cheap." },
  { id: "o4-mini", label: "o4-mini", wire: "openai", tier: "light", note: "Reasoning model, small." },
  {
    id: "gpt-5", label: "GPT-5", wire: "openai", tier: "balanced", default: true,
    note: "The usual choice on the OpenAI wire.",
  },
  {
    id: "gpt-4.1", label: "GPT-4.1", wire: "openai", tier: "balanced", previous: true,
    note: "Previous generation, still solid.",
  },

  // ── Gemini ─────────────────────────────────────────────────────────────────
  // The -low/-medium/-high ids are effort tiers of one model. AI Studio is sent the id
  // without the suffix; Cloud Code is sent its own id plus a thinking level (gemini.js).
  {
    id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", wire: "gemini", tier: "light",
    note: "Fastest Gemini 3.8 Flash tier — lowest latency and allowance use.",
  },
  {
    id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", wire: "gemini", tier: "balanced", default: true,
    note: "Balanced Gemini 3.8 Flash tier — long-horizon agent work at Flash pricing.",
  },
  {
    id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", wire: "gemini", tier: "balanced",
    note: "Deepest Gemini 3.8 Flash reasoning tier for complex agent workflows.",
  },
  {
    id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", wire: "gemini", tier: "light",
    note: "Fastest Gemini 4 Argon tier — lower latency and allowance use.",
  },
  {
    id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", wire: "gemini", tier: "balanced",
    note: "Balanced Gemini 4 Argon tier — everyday coding and reasoning.",
  },
  {
    id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", wire: "gemini", tier: "heavy",
    note: "Deepest Gemini 4 Argon reasoning tier for complex tasks.",
  },
  {
    id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", wire: "gemini", tier: "heavy",
    note: "High-reasoning flagship model.",
  },
  {
    id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)", wire: "gemini", tier: "light", previous: true,
    note: "Previous Flash, superseded by Gemini 3.8 Flash.",
  },
  {
    id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)", wire: "gemini", tier: "light", previous: true,
    note: "Previous Flash, superseded by Gemini 3.8 Flash.",
  },
  {
    id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", wire: "gemini", tier: "balanced", previous: true,
    note: "Previous Flash, superseded by Gemini 3.8 Flash.",
  },
  {
    id: "gemini-3-flash", label: "Gemini 3 Flash", wire: "gemini", tier: "light", previous: true,
    note: "Earlier fast reasoning model.",
  },
  {
    id: "gemini-3-pro", label: "Gemini 3 Pro", wire: "gemini", tier: "heavy", previous: true,
    note: "Earlier flagship, superseded by Gemini 3.1 Pro.",
  },
  {
    id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", wire: "gemini", tier: "light", previous: true,
    note: "Older lightweight workhorse, large context.",
  },
  {
    id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", wire: "gemini", tier: "balanced", previous: true,
    note: "Older reasoning model.",
  },
];

const TIER_ORDER = { light: 0, balanced: 1, heavy: 2 };

/**
 * The models that make sense for a provider, lightest first; within a tier, current
 * models before previous ones. Accepts SandboxOS's `claude` as well as ai-auth's ids.
 */
export function modelsFor(provider) {
  const wire = wireOf(provider);
  return MODELS.filter((model) => model.wire === wire)
    .map((model, index) => ({ model, index }))
    .sort((a, b) => (TIER_ORDER[a.model.tier] - TIER_ORDER[b.model.tier])
      || (Number(!!a.model.previous) - Number(!!b.model.previous))
      || (a.index - b.index))
    .map(({ model }) => model);
}

/** The model a provider uses when nobody has chosen one. Derived, never hardcoded per call site. */
export function defaultModelFor(provider) {
  const models = modelsFor(provider);
  return (models.find((m) => m.default) ?? models[0])?.id ?? null;
}

/** Every provider's default, for a picker's "default: X" label. */
export function defaultModels(providers = PROVIDER_IDS) {
  return Object.fromEntries(providers.map((p) => [p, defaultModelFor(p)]));
}

export function modelSpec(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

/**
 * Every provider whose catalogue lists this model — `gemini-3.1-pro` is on both `gemini`
 * and `gemini-cli`, `claude-opus-5-5` on both `claude`/`anthropic` and `claude-code`.
 * A bare tiered id (`gemini-3.8-flash`) counts as its -medium/-low tier, the way the
 * wires treat it. Empty for an id the catalogue does not know — which is *not* a refusal:
 * the catalogue is the shortcut, not the gate.
 *
 * @param {string} model
 * @param {string[]} [providers] the ids to consider; SandboxOS passes its own list
 */
export function providersForModel(model, providers = PROVIDER_IDS) {
  if (!model) return [];
  const id = String(model);
  return providers.filter((p) => modelsFor(p).some((m) => m.id === id || m.id === `${id}-medium` || m.id === `${id}-low`));
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
