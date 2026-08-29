// ai-auth: bring-your-own-credential auth for Anthropic and OpenAI.
//
// The pure halves — the OAuth exchange, the sealed stores, the pricing table, the error
// mapping — are all testable without a network, and that matters more here than usual:
// every branch in errors.js only runs when something is already going wrong, and those
// are exactly the paths nobody exercises by hand.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, createTenant } from "../packages/control-db/src/registry.js";
import {
  ApiKeyStore, ClaudeAccountStore, MemoryCredentialStore, SecretBox, TenantCredentialStore,
  claudeAccounts, describeProviderError, exchangeClaudeCode, httpHeadersFor, isSubscription,
  maskSecret, parseClaudeCredentials, parseCodexAuth, parsePastedCode, pricingFor,
  pricingKeyFor, providerErrorFacts, sameState, startClaudeLogin, withClaudeCodeIdentity,
  CLAUDE_CODE_SYSTEM, UNKNOWN_MODEL_PRICING,
} from "../packages/ai-auth/src/index.js";

let owner;

test.before(() => {
  openDb();
  ({ owner } = ensureSeed("local"));
});
test.after(() => closeDb());

// ---- the login flow ---------------------------------------------------------

test("a started login carries a PKCE challenge and never leaks the verifier", () => {
  const started = startClaudeLogin();
  const url = new URL(started.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), started.state);
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(!started.url.includes(started.verifier), "the verifier must never cross to the browser");
  // `code=true` is what makes the authorize page show a code instead of redirecting to a
  // loopback port a Gateway does not have.
  assert.equal(url.searchParams.get("code"), "true");
});

test("a pasted code is accepted in every shape a person actually pastes", () => {
  assert.deepEqual(parsePastedCode("abc#xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parsePastedCode("  abc#xyz \n"), { code: "abc", state: "xyz" });
  assert.deepEqual(parsePastedCode("abc"), { code: "abc", state: null });
  assert.deepEqual(
    parsePastedCode("https://platform.claude.com/oauth/code/callback?code=abc&state=xyz"),
    { code: "abc", state: "xyz" },
  );
  assert.equal(parsePastedCode("   "), null);
});

test("state comparison rejects a code from a different login", () => {
  assert.ok(sameState("abcdef", "abcdef"));
  assert.ok(!sameState("abcdef", "abcdeg"));
  assert.ok(!sameState("abcdef", "abc"), "a length mismatch must not throw");
});

test("the code exchange posts the CLI's own body shape and reads the plan back", async () => {
  let seen = null;
  const identity = await exchangeClaudeCode({
    code: "the-code",
    state: "the-state",
    verifier: "the-verifier",
    now: () => 1_000_000,
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({
        access_token: "sk-oauth", refresh_token: "rt", expires_in: 60,
        scope: "user:inference user:profile", account: { subscription_type: "max" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(seen.headers["content-type"], "application/json", "form-encoded is refused by this endpoint");
  assert.equal(seen.body.grant_type, "authorization_code");
  assert.equal(seen.body.code_verifier, "the-verifier");
  assert.equal(seen.body.state, "the-state");
  assert.deepEqual(identity, {
    accessToken: "sk-oauth",
    refreshToken: "rt",
    expiresAt: 1_060_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  });
});

test("a spent authorization code is reported as needing a restart", async () => {
  await assert.rejects(
    exchangeClaudeCode({
      code: "x", state: "y", verifier: "z",
      fetchImpl: async () => new Response("nope", { status: 400 }),
    }),
    (e) => e.name === "ClaudeLoginError" && e.restart === true,
  );
});

// ---- storage ----------------------------------------------------------------

test("a sealed value opens under its own label and nowhere else", () => {
  const a = new SecretBox("host-secret", "label-a");
  const b = new SecretBox("host-secret", "label-b");
  const sealed = a.seal("sk-ant-secret");
  assert.equal(a.open(sealed), "sk-ant-secret");
  // Load-bearing: a bug that reads the wrong row must fail loudly rather than hand one
  // subsystem another's secret.
  assert.equal(b.open(sealed), null);
  assert.equal(a.open("not:even:ciphertext"), null);
});

test("masking keeps enough to recognise a key and not enough to use one", () => {
  assert.equal(maskSecret("sk-ant-api03-abcdefghij9ZQ"), "sk-ant-…j9ZQ");
  assert.equal(maskSecret("short"), "••••");
});

test("the tenant store round-trips a record and isolates tenants", async () => {
  const other = createTenant("ai-auth-other");
  const mine = new TenantCredentialStore(owner.tenant_id);
  const theirs = new TenantCredentialStore(other.id);

  await mine.write("claude:acct", { payload: "sealed-bytes", meta: { plan: "max", expiresAt: 42 } });
  assert.deepEqual(await mine.read("claude:acct"), { payload: "sealed-bytes", meta: { plan: "max", expiresAt: 42 } });
  assert.equal(await theirs.read("claude:acct"), null, "one tenant's row is not another's");
  assert.deepEqual(mine.keys(), ["claude:acct"]);

  await mine.delete("claude:acct");
  assert.equal(await mine.read("claude:acct"), null);
});

test("an account store hands back a live token and refreshes an expired one, writing the rotation back", async () => {
  let now = 10_000_000;
  const exchanges = [];
  const store = new MemoryCredentialStore();
  const accounts = new ClaudeAccountStore({
    store,
    secret: "host-secret",
    now: () => now,
    fetchImpl: async (_url, init) => {
      exchanges.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        access_token: "fresh", refresh_token: "rotated", expires_in: 3600,
      }), { status: 200 });
    },
  });

  await accounts.save("ten_1", {
    accessToken: "original", refreshToken: "rt-1", expiresAt: now + 3600_000,
    scopes: ["user:inference"], subscriptionType: "pro",
  });

  const status = await accounts.status("ten_1");
  assert.equal(status.connected, true);
  assert.equal(status.plan, "pro", "the plan is read from meta, without decrypting anything");
  assert.equal(status.expired, false);
  assert.equal(await accounts.token("ten_1"), "original");
  assert.equal(exchanges.length, 0, "a live token must not be refreshed");

  now += 3600_000; // the token has aged out
  assert.equal((await accounts.status("ten_1")).expired, true);
  assert.equal(await accounts.token("ten_1"), "fresh");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].grant_type, "refresh_token");
  assert.equal(exchanges[0].refresh_token, "rt-1");

  // The rotated refresh token is the only one that will work next time. Dropping it
  // works exactly once and then signs the user out for no reconstructible reason.
  now += 3600_000;
  assert.equal(await accounts.token("ten_1"), "fresh");
  assert.equal(exchanges[1].refresh_token, "rotated");

  await accounts.forget("ten_1");
  assert.equal((await accounts.status("ten_1")).connected, false);
});

test("simultaneous callers share one refresh rather than racing three", async () => {
  let exchanges = 0;
  const accounts = new ClaudeAccountStore({
    store: new MemoryCredentialStore(),
    secret: "host-secret",
    now: () => 5_000_000,
    fetchImpl: async () => {
      exchanges += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }), { status: 200 });
    },
  });
  await accounts.save("ten_1", {
    accessToken: "stale", refreshToken: "rt", expiresAt: 0, scopes: [], subscriptionType: null,
  });

  const tokens = await Promise.all([
    accounts.token("ten_1"), accounts.token("ten_1"), accounts.token("ten_1"),
  ]);
  assert.deepEqual(tokens, ["fresh", "fresh", "fresh"]);
  // The loser of a three-way race would be holding a refresh token the winner has
  // already rotated away, and the symptom is an intermittent logout.
  assert.equal(exchanges, 1);
});

test("a credential sealed under one host secret reads as disconnected under another", async () => {
  const store = new MemoryCredentialStore();
  const written = new ClaudeAccountStore({ store, secret: "secret-one" });
  await written.save("ten_1", {
    accessToken: "tok", refreshToken: null, expiresAt: Date.now() + 3600_000, scopes: [], subscriptionType: "max",
  });
  const rotated = new ClaudeAccountStore({ store, secret: "secret-two" });
  // Not a crash: a rotated host secret sends the user through the login again, which is
  // a working recovery, and throwing would take the settings page down instead.
  assert.equal((await rotated.status("ten_1")).connected, false);
});

test("claudeAccounts binds a real tenant to the host's own key custody", async () => {
  const accounts = claudeAccounts(owner.tenant_id);
  assert.equal((await accounts.status(owner.tenant_id)).connected, false);
  await accounts.save(owner.tenant_id, {
    accessToken: "tok", refreshToken: "rt", expiresAt: Date.now() + 3600_000,
    scopes: ["user:inference"], subscriptionType: "max",
  });
  const status = await accounts.status(owner.tenant_id);
  assert.equal(status.connected, true);
  assert.equal(status.plan, "max");
  await accounts.forget(owner.tenant_id);
});

// ---- API keys ---------------------------------------------------------------

test("a key resolves from storage, then the environment, and says which answered", async () => {
  const keys = new ApiKeyStore({
    store: new MemoryCredentialStore(),
    secret: "host-secret",
    env: { ANTHROPIC_API_KEY: "sk-ant-from-env" },
  });

  assert.deepEqual(await keys.resolve("anthropic"), { key: "sk-ant-from-env", source: "environment", ready: true });
  await keys.set("anthropic", "sk-ant-stored");
  assert.deepEqual(await keys.resolve("anthropic"), { key: "sk-ant-stored", source: "stored", ready: true });
  assert.equal(await keys.hint("anthropic"), maskSecret("sk-ant-stored"));

  // A UI that cannot tell "no key" from "a key from the environment" shows an empty
  // field over a working deployment, and the first fix anyone tries is a second key.
  assert.deepEqual(await keys.resolve("openai"), { key: null, source: "none", ready: false });

  // A subscription is ready without a key. Reporting it as unset would put a "configure
  // a key" prompt in front of a fully configured deployment.
  assert.deepEqual(await keys.resolve("claude-code"), { key: null, source: "subscription", ready: true });

  await keys.set("anthropic", "");
  assert.equal(await keys.stored("anthropic"), null);
});

// ---- what the CLIs left on disk ---------------------------------------------

test("the Claude credentials blob is parsed nested or flat, and refused without a token", () => {
  const nested = parseClaudeCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: "tok", refreshToken: "rt", expiresAt: 99, subscriptionType: "max", scopes: ["a"] },
  }), "file");
  assert.equal(nested.accessToken, "tok");
  assert.equal(nested.subscriptionType, "max");
  assert.equal(nested.source, "file");

  const flat = parseClaudeCredentials(JSON.stringify({ access_token: "tok2" }), "keychain");
  assert.equal(flat.accessToken, "tok2");
  // An absent expiry is treated as already expired: the refresh path can recover, while
  // a token wrongly assumed live fails in the middle of a generation instead.
  assert.equal(flat.expiresAt, 0);

  assert.equal(parseClaudeCredentials("{}", "file"), null);
  assert.equal(parseClaudeCredentials("not json", "file"), null);
});

test("the Codex auth file yields the account id the backend bills against", () => {
  const claims = Buffer.from(JSON.stringify({
    exp: 2_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_9", chatgpt_plan_type: "pro" },
  })).toString("base64url");
  const jwt = `header.${claims}.sig`;

  const identity = parseCodexAuth(JSON.stringify({ tokens: { access_token: jwt, refresh_token: "rt" } }));
  assert.equal(identity.accountId, "acct_9");
  assert.equal(identity.planType, "pro");
  assert.equal(identity.expiresAt, 2_000_000_000);
  assert.equal(parseCodexAuth(JSON.stringify({ tokens: {} })), null);
});

// ---- what a call actually sends ---------------------------------------------

test("a subscription call sends a bearer token and no x-api-key at all", () => {
  const headers = httpHeadersFor({ provider: "claude-code", accessToken: "sk-oauth" });
  assert.equal(headers.authorization, "Bearer sk-oauth");
  // Anthropic validates x-api-key whenever the header is *present*, so a placeholder
  // beside a valid bearer is not ignored — it is rejected, on a box where everything
  // looks correctly configured.
  assert.ok(!("x-api-key" in headers), "an unused key header beside a bearer token is a 401");
  assert.ok(headers["anthropic-beta"].includes("oauth-2025-04-20"));
  assert.ok(headers["user-agent"].startsWith("claude-cli/"));

  const keyed = httpHeadersFor({ provider: "claude", apiKey: "sk-ant-key" });
  assert.equal(keyed["x-api-key"], "sk-ant-key");
  assert.ok(!("authorization" in keyed));

  const codex = httpHeadersFor({ provider: "codex", accessToken: "tok", accountId: "acct_9" });
  assert.equal(codex["chatgpt-account-id"], "acct_9");
  assert.equal(codex.originator, "codex_cli_ts");
});

test("the Claude Code identity goes first, alone, and only once", () => {
  const blocks = withClaudeCodeIdentity("you are a helpful assistant");
  assert.equal(blocks[0].text, CLAUDE_CODE_SYSTEM);
  assert.equal(blocks.length, 2, "the identity is its own block — folding it in does not count");
  assert.equal(blocks[1].text, "you are a helpful assistant");

  // Safe to apply at more than one layer: the layer that knows the credential is a
  // subscription is rarely the layer that owns the prompt.
  assert.deepEqual(withClaudeCodeIdentity(blocks), blocks);

  // A caller with no prompt of its own must not produce a trailing empty block —
  // Anthropic refuses a request containing one outright.
  assert.deepEqual(withClaudeCodeIdentity(""), [{ type: "text", text: CLAUDE_CODE_SYSTEM }]);
  assert.deepEqual(withClaudeCodeIdentity([]), [{ type: "text", text: CLAUDE_CODE_SYSTEM }]);
});

// ---- pricing and error messages ---------------------------------------------

test("a dated model id resolves to its published rate, not the pessimistic fallback", () => {
  assert.equal(pricingKeyFor("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.deepEqual(pricingFor("claude-haiku-4-5-20251001"), { input: 1.0, output: 5.0 });
  // Longest match wins, so a sibling model cannot be swallowed by a shorter prefix.
  assert.equal(pricingKeyFor("gpt-4.1-mini"), "gpt-4.1-mini");
  // And an unlisted model is priced high, because guessing low would wave through a call
  // costing several times the estimate.
  assert.deepEqual(pricingFor("some-model-nobody-listed"), UNKNOWN_MODEL_PRICING);
  assert.ok(isSubscription("claude-code") && !isSubscription("anthropic"));
});

test("a 429 that says the plan is still allowed is not reported as an exhausted plan", () => {
  const error = {
    status: 429,
    message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}',
    headers: new Headers({
      "retry-after": "4",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.19",
    }),
  };

  const facts = providerErrorFacts(error);
  assert.equal(facts.retryAfter, 4);
  assert.equal(facts.planStatus, "allowed");
  assert.equal(facts.utilization, 0.19);
  assert.equal(facts.detail, null, 'Anthropic\'s placeholder "Error" is not a detail');

  const said = describeProviderError(error, "claude-code", "claude-opus-5", { configureAt: "Settings" });
  assert.match(said, /19% of its overall window/);
  assert.match(said, /lighter/);
  assert.ok(!/allowance is used up/.test(said), "telling someone their plan is gone would be untrue here");
});

test("the same status on a key and on a plan produce different advice", () => {
  const rejected = { status: 429, headers: new Headers({ "anthropic-ratelimit-unified-status": "rejected" }) };
  assert.match(describeProviderError(rejected, "claude-code", "claude-opus-5"), /limits each model separately/);
  assert.match(describeProviderError({ status: 429 }, "anthropic", "claude-opus-5"), /rate-limiting this key/);

  assert.match(describeProviderError({ status: 401 }, "claude-code", "claude-opus-5"), /Connect it again/);
  assert.match(describeProviderError({ status: 401 }, "anthropic", "claude-opus-5", { configureAt: "Settings" }), /check it in Settings/);
  assert.match(describeProviderError({ status: 404 }, "openai", "gpt-9"), /does not know a model called/);
  // 529 is Anthropic's overload code and has its own sentence — it must not be swallowed
  // by the generic 5xx branch.
  assert.match(describeProviderError({ status: 529 }, "anthropic", "claude-opus-5"), /overloaded/);
  // Nothing useful to add is null, not a vague catch-all: the status and body at least
  // give someone something to search for.
  assert.equal(describeProviderError({ status: 418 }, "anthropic", "claude-opus-5"), null);
});
