# `ai-auth` — three ways to pay for a model call

A port of [Flyvendedk799/ai-auth](https://github.com/Flyvendedk799/ai-auth) into the
SandboxOS tree. Same mechanisms, same constants, same traps; plain JS ESM instead of a
TypeScript build, and SandboxOS's own encrypted `tenant_secrets` instead of the library's
JSON/Postgres adapters.

Three ways a tenant can pay for an LLM call:

| provider | credential | who pays |
|---|---|---|
| `claude` · `openai` | a metered API key, encrypted at rest | the deployment's card |
| `claude-code` | a Claude subscription the tenant signed in to *here*, via OAuth + PKCE | that tenant's plan |
| `codex` | the ChatGPT login the `codex` CLI left on this machine | the operator's plan |

## Why it is a port and not a dependency

The upstream package publishes only TypeScript sources on GitHub; installing it means
running `tsc` at install time. SandboxOS's whole premise is "no dependencies to install"
and there is no build step anywhere in the tree, so the source came in instead. It has no
runtime dependencies of its own, which is what made that possible.

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
7. **The consent screen says Claude Code**, because that is whose client id this flow
   uses. Tell your users, and read Anthropic's and OpenAI's subscription terms before
   pointing a hosted deployment at consumer plans. The mechanism is sound; whether a given
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
key-store.js     bring-your-own API keys, resolved and masked
models.js        the catalogue, with a tier per model
pricing.js       rates, cost accounting, the subscription/metered split
errors.js        an SDK failure turned into a sentence someone can act on
clients.js       the identity block, SDK options, and fetch headers
```
