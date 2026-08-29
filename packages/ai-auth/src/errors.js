// Turning a provider's failure into a sentence someone can act on.
//
// Everything that goes wrong out at the model arrives as a raw response body —
// `429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}` — and
// forwarding that to a browser verbatim is the default. It says what happened in the
// protocol and nothing about what to do, which is the only part a person needs.
//
// The remedy also depends on *how the call was paid for*, which is why this takes a
// provider. A 429 on a metered key means "you are sending too fast"; the same status on
// a subscription means the plan's own allowance is used up — often by something else
// entirely, because a plan is shared with every tool signed in to it, the `claude` CLI
// included. Different problems, different fixes, and one "rate limited" would send half
// the people who see it to the wrong one.
//
// A pure function of (error, provider, model), so the mapping is testable without a
// network — which matters, because every branch here only runs when something is
// already going wrong, and those are exactly the paths nobody exercises by hand.

import { isSubscription } from "./pricing.js";

function headerOf(error, name) {
  const headers = error?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const hit = headers[name] ?? headers[name.toLowerCase()];
  return typeof hit === "string" ? hit : null;
}

function numberFrom(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function statusOf(error) {
  return typeof error?.status === "number" ? error.status : null;
}

/** The provider's own words, when it bothered to say anything useful. */
function detailOf(error) {
  const raw = error?.message;
  if (typeof raw !== "string" || raw.length === 0) return null;
  // The body arrives prefixed with the status and then JSON. Dig out the human part if
  // there is one, and ignore the placeholder "Error" Anthropic sends for a 429.
  const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const message = match?.[1]?.replace(/\\"/g, '"');
  if (!message || message === "Error") return null;
  return message;
}

/**
 * What the provider actually told us, kept separate from what we choose to say about it.
 *
 * Worth its own shape because the interesting facts arrive in *headers*. A 429 carrying
 * `retry-after: 4` from a plan reporting 19% utilisation is a burst throttle that clears
 * in seconds. A 429 from a plan reporting `rejected` is an exhausted allowance. Opposite
 * problems, opposite remedies, distinguishable from the response itself — and announcing
 * the second when it was the first sends someone off to buy credits they did not need.
 *
 * Worth storing beside a failure, too: a message alone is undiagnosable an hour later.
 */
export function providerErrorFacts(error) {
  return {
    status: statusOf(error),
    retryAfter: numberFrom(headerOf(error, "retry-after")),
    planStatus: headerOf(error, "anthropic-ratelimit-unified-status"),
    utilization: numberFrom(headerOf(error, "anthropic-ratelimit-unified-5h-utilization")),
    detail: detailOf(error),
  };
}

/** Which CLI owns the login behind a subscription provider, for the "run this" sentence. */
function cliFor(provider) {
  return provider === "codex" ? "codex" : "claude";
}

/**
 * A message for the browser, or null when nothing better than the raw error can be said.
 *
 * Null rather than a vague catch-all: "something went wrong" is worse than the status
 * code and the body, which at least give someone something to search for.
 *
 * @param {object} [options.configureAt] what this deployment calls the place these are
 *   changed — "Settings", "the admin page". Half of these messages end in an instruction,
 *   and one that cannot say *where* is markedly less useful than one that can.
 */
export function describeProviderError(error, provider, model, options = {}) {
  const status = statusOf(error);
  const detail = detailOf(error);
  const subscription = isSubscription(provider);
  const cli = cliFor(provider);
  const at = options.configureAt ? ` in ${options.configureAt}` : "";

  if (status === 429) {
    const facts = providerErrorFacts(error);
    const wait = facts.retryAfter !== null ? ` It asked us to wait ${facts.retryAfter} seconds.` : "";

    // The plan says it is fine. Then this is a burst throttle, a per-model limit, or
    // something sitting between us and the provider — and telling someone their allowance
    // is gone would be a plain untruth they could lose an afternoon acting on.
    if (facts.planStatus !== null && facts.planStatus !== "rejected") {
      const used = facts.utilization !== null
        ? ` The plan reports ${Math.round(facts.utilization * 100)}% of its overall window used, so the overall allowance is not the problem.`
        : " The plan itself reports as available, so the overall allowance is not the problem.";
      return "The provider refused the call with a rate limit, but says the plan is still allowed."
        + used + wait
        + ` A subscription limits each model separately, so \`${model}\` may be exhausted while a`
        + " lighter one still answers. Try a lighter model, or fewer calls at once.";
    }

    if (subscription) {
      // Per-model first, because it is both the commonest cause and the one with a remedy
      // that works immediately. A plan limits Opus, Sonnet and Haiku on separate
      // allowances: the heavy model can be refused for hours while the light one answers
      // every time, and "your plan is rate-limited" sends people off to wait when they
      // could have switched model and carried on.
      return `Your ${provider === "codex" ? "ChatGPT" : "Claude"} plan refused this call for \`${model}\`. `
        + "A plan limits each model separately, so a heavier model can be exhausted while a "
        + "lighter one still works — switching model is usually the fastest fix. The allowance "
        + `is also shared with everything signed in to the plan, the \`${cli}\` CLI included.`
        + wait
        + ` Pick a lighter model, wait for the window to reset, or switch to an API key${at}.`;
    }

    return "The provider is rate-limiting this key." + wait
      + " Wait a moment and try again, or slow down how many calls run at once.";
  }

  if (status === 401 || status === 403) {
    return subscription
      ? `The ${cli} subscription behind this call was rejected. Connect it again${at}, or run \``
        + `${cli}\` on the host and sign in there.`
      : `The API key was rejected${at ? ` — check it${at}` : ""}. A key that has been `
        + "revoked or rotated fails exactly like this.";
  }

  if (status === 400 && detail) {
    // Almost always a model that does not accept something the request carried. Name the
    // model, because the setting that caused it is a free-text box and the message is
    // about a parameter the user never typed.
    return `${detail} (model: ${model}). Choose a different model${at}.`;
  }

  if (status === 404) {
    return `The provider does not know a model called \`${model}\`. Check the model name${at}.`;
  }

  if (status === 529) return "The provider is overloaded. Try again shortly.";

  if (status !== null && status >= 500) {
    return "The provider had a server error. That is on their side — try again shortly.";
  }

  return detail;
}
