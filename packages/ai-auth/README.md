# `ai-auth` — every way to pay for a model call

A port of [Flyvendedk799/ai-auth](https://github.com/Flyvendedk799/ai-auth) into the
SandboxOS tree. Same mechanisms, same constants, same traps; plain JS ESM instead of a
TypeScript build, and SandboxOS's own encrypted `tenant_secrets` instead of the library's
JSON/Postgres adapters.

The ways a tenant can pay for an LLM call:

| provider | wire | credential | who pays |
|---|---|---|---|
| `claude` · `openai` · `gemini` | Anthropic · OpenAI chat · Google AI Studio | a metered API key, encrypted at rest | the deployment's card |
| `claude-code` | Anthropic | a Claude subscription the tenant signed in to *here*, via OAuth + PKCE | that tenant's plan |
| `gemini-cli` | Google Cloud Code (`v1internal`) | a Google account the tenant signed in to *here*, via Antigravity's OAuth + PKCE | that tenant's plan |
| `codex` | OpenAI Responses at chatgpt.com | the ChatGPT login the `codex` CLI left on this machine | the operator's plan |

`claude` is SandboxOS's name for upstream's `anthropic`; `wireOf`, `modelsFor` and
`providersForModel` accept both. (They did not, once: `wireOf("claude")` fell through to
`openai`, and the API-key Claude provider advertised GPT models.)

## Models

`models.js` is the catalogue every picker and every ledger reads, newest first within
each tier: Haiku 5.5 (light), Sonnet 5.5 (balanced, the default), Opus 5.5 and Fable 5.2
(heavy) on the Anthropic wire; GPT-5 on OpenAI's; Gemini 3.8 Flash (Low/Medium/High), Gemini
4 Argon and Gemini 3.1 Pro on Google's. Superseded models stay listed with `previous: true`
so a saved choice keeps working. A provider's default is the entry marked `default` on its
wire (`defaultModelFor`), never a literal at a call site. `providersForModel` says which
providers list a model; an empty answer means "not catalogued", which is accepted — the
catalogue is the shortcut, not the gate. Prices are in `pricing.js`, including the 5.5
generation's own cache-read rates and Haiku 5.5's long-context rate above 100K prompt tokens.

## Why it is a port and not a dependency

The upstream package publishes only TypeScript sources on GitHub; installing it means
running `tsc` at install time. SandboxOS's whole premise is "no dependencies to install"
and there is no build step anywhere in the tree, so the source came in instead. It has no
runtime dependencies of its own, which is what made that possible.

Each file follows the newest upstream copy: the Antigravity client pieces
(`ANTIGRAVITY_CLIENT_VERSION`, the upgrade-notice check, `includeThoughts`, `toolChoice`)
from OpenBot's vendored copy, `gemini-schema` (const/enum handling) from ai-auth itself.
Not ported: the React terminals and Fastify routes (SandboxOS has its own UI and routes),
and OpenBot's several-Google-accounts rotation — one account per tenant here, as for Claude.

Two things changed on the way in:

* **Storage.** Upstream ships `MemoryCredentialStore`, `JsonFileCredentialStore` and a
  Postgres adapter. Here the adapter is `TenantCredentialStore`, one row per credential in
  `tenant_secrets` — which means credentials inherit the master-key custody and per-tenant
  HKDF derivation the secrets server already has. The `SecretBox` layer above it stays,
  because it is what stops the OAuth store and the key store reading each other's rows.
* **The host secret.** Upstream asks the app for one. SandboxOS already has exactly one
  such thing, so `hostSecret("ai-auth")` derives it from the master key rather than
  introducing a second secret to back up and lose.

The wire details are unchanged, because those are the parts that cost a day each.

## The traps, in one place

Each of these is a real failure that took a day to diagnose. The code that avoids them is
named beside each one.

1. **A subscription token must say it is Claude Code.** Every request on a Claude Code
   OAuth token must open with the CLI's identity system block — exact text, first
   position, its own block. Without it Anthropic refuses Opus and Sonnet with `429
   rate_limit_error` on a plan nowhere near its limit. **Haiku is exempt, and that is the
   trap**: it is the model you reach for to test a credential, so a request shape that is
   broken for everything you want looks healthy on the one you tried. → `withClaudeCodeIdentity`,
   applied by `systemFor` in `packages/llm/src/providers.js`.
2. **A 429 does not mean the plan is exhausted.** Check
   `anthropic-ratelimit-unified-status`: `allowed` beside a 429 means a per-model limit or
   a burst throttle, and "your allowance is gone" would be a plain untruth someone could
   lose an afternoon acting on. → `providerErrorFacts`, `describeProviderError`.
3. **`authToken`, not `apiKey`.** Anthropic validates `x-api-key` whenever the header is
   *present*, so a placeholder beside a valid bearer token is rejected rather than ignored.
   → `httpHeadersFor` emits no key header at all on the subscription path.
4. **The encryption label is half the key.** `sha256(label + ":" + secret)`. Change the
   label and nothing throws — stored values simply stop decrypting and every connected
   account reads as disconnected. → `SecretBox`, one label per store, never reused.
5. **Dated model ids are real ids.** `claude-haiku-4-5-20251001` is what you call, and
   exact-matching a pricing table sends it to the pessimistic unknown-model fallback. →
   `pricingKeyFor`, longest match wins.
6. **Refresh only what is yours.** The machine-local reader never refreshes a live token:
   the providers rotate refresh tokens on exchange, so refreshing the CLI's credential
   would leave the operator's own CLI holding one the Gateway had already spent. The
   per-tenant store is the opposite case and must refresh *and write the rotation back*. →
   `ClaudeCodeCredential` vs. `ClaudeAccountStore`.
7. **Gemini on a subscription is not the Gemini API.** A Google token does not work on
   `generativelanguage.googleapis.com`; it goes to Cloud Code's `v1internal:generateContent`
   on the **daily** host (prod answers healthy personal accounts with a false 429), with the
   request wrapped in `{ model, project, request }`. → `antigravityCliOptions`,
   `toCodeAssistRequest`.
8. **The catalogue's Gemini ids are not the wire's.** `gemini-3.8-flash-high` is a 404 on both
   APIs: AI Studio wants `gemini-3.8-flash`, Cloud Code wants `gemini-3.8-flash-tiered` with
   `thinkingLevel: "high"`. → `geminiStudioModelId`, `normalizeAntigravityModelId`,
   `antigravityThinkingLevel`.
9. **An outdated client gets a 200.** Below Google's version floor Cloud Code answers
   successfully with an upgrade notice as the "model output". Treat it as an error and raise
   `ANTIGRAVITY_CLIENT_VERSION`. → `isAntigravityUpgradeNotice`.
10. **Never send `aicode-consumers` as `x-goog-user-project`** — personal tokens 403 on it.
    A project id of the user's own goes in both header and body. →
    `sanitizePersonalCloudCodeProject`.
11. **Gemini's schema is not JSON Schema.** Array `type`, `const`, numeric `enum` and unknown
    keywords are each a 400. → `sanitizeGeminiFunctionParameters`.
12. **Gemini 3 wants its thought signatures back.** A function call echoed into the next
    request without the `thoughtSignature` it came with is refused; keep the model's parts
    whole (SandboxOS's `packages/llm/src/wires.js` does).
13. **Codex is Responses-only.** The ChatGPT backend has no `/chat/completions`; it takes
    `/responses` with `instructions`, `store: false` and `stream: true`. → `codexResponsesBody`.
14. **The 5.x Claude models refuse sampling knobs.** A non-default `temperature`/`top_p`/`top_k`,
    `thinking: {type: "disabled"}` or `budget_tokens`, a forced `tool_choice` and assistant
    prefill are all 400s on Fable 5.x, Opus 5.5, Sonnet 5.5 and Haiku 5.5. The SandboxOS
    callers send none of them; `output_config.effort` is the supported dial.
15. **The consent screen says Claude Code** — or Antigravity, for Google, because that is whose client id this flow
   uses. Tell your users, and read Anthropic's, OpenAI's and Google's subscription terms
   before pointing a hosted deployment at consumer plans. The Google client secret, unlike
   Anthropic's public client, came out of the closed-source `agy` binary. The mechanism is sound; whether a given
   deployment is entitled to use it is not a question this package can answer.

## Layout

```
secret-box.js    AES-256-GCM at rest, one label per store
store.js         the credential-store contract + the tenant_secrets adapter
tenant.js        the SandboxOS wiring: which store, which secret
oauth.js         the browser login — PKCE, the exchange, the pasted code
local-cli.js     the `claude` login already on this machine
codex.js         the `codex` login already on this machine
account-store.js one tenant's connected subscription, kept fresh
antigravity.js   the Google login (Antigravity's client) and the `agy` login on this machine
antigravity-account-store.js  one tenant's Google account, its project id, kept fresh
gemini.js        AI Studio and Cloud Code: options, model-id mapping, toCodeAssistRequest
gemini-schema.js JSON Schema → Gemini's Schema message
key-store.js     bring-your-own API keys, resolved and masked
models.js        the catalogue, with a tier per model
pricing.js       rates, cost accounting, the subscription/metered split
errors.js        an SDK failure turned into a sentence someone can act on
clients.js       the identity block, SDK options, fetch headers, the Codex body
```
