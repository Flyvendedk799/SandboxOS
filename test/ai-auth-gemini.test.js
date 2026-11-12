// ai-auth parity: the newest catalogue, the Gemini providers, and the wire details that
// come with them. Pure functions and in-memory stores only — nothing touches a network.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AntigravityAccountStore, MemoryCredentialStore, MODELS, PRICING, PROVIDER_IDS,
  antigravityCliOptions, antigravityThinkingLevel, codexResponsesBody, costOf, defaultModelFor,
  describeProviderError, exchangeAntigravityCode, geminiStudioModelId, httpHeadersFor,
  isAntigravityUpgradeNotice, isPricingKnown, isSubscription, modelSpec, modelsFor,
  normalizeAntigravityModelId, parseAntigravityToken, pricingFor, providerOf, providersForModel,
  sanitizeGeminiFunctionParameters, sanitizePersonalCloudCodeProject, startAntigravityLogin,
  toCodeAssistRequest, wireOf, worstCaseCost, CLOUD_CODE_DAILY_BASE_URL,
} from "../packages/ai-auth/src/index.js";
import { LLM_PROVIDERS } from "../packages/control-db/src/registry.js";
import { PROVIDERS, chooseModel, modelFitsProvider } from "../packages/llm/src/providers.js";

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

// ---- the catalogue ------------------------------------------------------------

test("the catalogue carries the newest Claude models, with a tier each", () => {
  const tiers = Object.fromEntries(MODELS.map((m) => [m.id, m.tier]));
  assert.equal(tiers["claude-haiku-5-5"], "light");
  assert.equal(tiers["claude-sonnet-5-5"], "balanced");
  assert.equal(tiers["claude-opus-5-5"], "heavy");
  assert.equal(tiers["claude-fable-5-2"], "heavy");
  // Superseded models stay listed — a saved choice must keep working — but say so.
  for (const id of ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"]) {
    assert.equal(modelSpec(id)?.previous, true, `${id} should be marked previous`);
  }
  for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]) {
    assert.ok(!modelSpec(id).previous, `${id} is current`);
    assert.ok(!/-\d{8}$/.test(id), "current ids carry no date suffix");
  }
  assert.ok(MODELS.every((m) => m.label && m.note && ["light", "balanced", "heavy"].includes(m.tier)));
});

test("every model in the catalogue has a published price", () => {
  for (const m of MODELS) assert.ok(isPricingKnown(m.id), `${m.id} would fall to the unknown-model rate`);
});

test("every provider id maps to its wire — the API-key `claude` provider included", () => {
  const expected = {
    anthropic: "anthropic", claude: "anthropic", "claude-code": "anthropic",
    openai: "openai", codex: "openai", gemini: "gemini", "gemini-cli": "gemini",
  };
  for (const [provider, wire] of Object.entries(expected)) assert.equal(wireOf(provider), wire, provider);
  // The bug this guards: modelsFor("claude") used to answer with the OpenAI catalogue.
  assert.ok(modelsFor("claude").every((m) => m.wire === "anthropic"));
  assert.ok(modelsFor("claude").length > 0);
  for (const id of LLM_PROVIDERS) {
    assert.equal(wireOf(id), PROVIDERS[id].wire, `${id}: SandboxOS and ai-auth must agree on the wire`);
    assert.ok(modelsFor(id).length > 0, `${id} offers models`);
  }
});

test("defaults come from the catalogue: the current balanced model per wire", () => {
  assert.equal(defaultModelFor("claude"), "claude-sonnet-5-5");
  assert.equal(defaultModelFor("claude-code"), "claude-sonnet-5-5");
  assert.equal(defaultModelFor("openai"), "gpt-5");
  assert.equal(defaultModelFor("codex"), "gpt-5");
  assert.equal(defaultModelFor("gemini"), "gemini-3.8-flash-medium");
  assert.equal(defaultModelFor("gemini-cli"), "gemini-3.8-flash-medium");
  for (const id of LLM_PROVIDERS) assert.equal(PROVIDERS[id].defaultModel, defaultModelFor(id));
});

test("lightest first, and within a tier the current model before the one it replaced", () => {
  const ids = modelsFor("claude").map((m) => m.id);
  assert.equal(ids[0], "claude-haiku-5-5");
  assert.ok(ids.indexOf("claude-sonnet-5-5") < ids.indexOf("claude-sonnet-5"));
  assert.ok(ids.indexOf("claude-opus-5-5") < ids.indexOf("claude-opus-5"));
});

test("providersForModel names every provider that lists a model, and none for a stranger", () => {
  assert.deepEqual(providersForModel("claude-opus-5-5", LLM_PROVIDERS), ["claude", "claude-code"]);
  assert.deepEqual(providersForModel("gpt-5", LLM_PROVIDERS), ["openai", "codex"]);
  assert.deepEqual(providersForModel("gemini-3.1-pro", LLM_PROVIDERS), ["gemini", "gemini-cli"]);
  // A bare tiered id is its medium tier.
  assert.deepEqual(providersForModel("gemini-3.8-flash", LLM_PROVIDERS), ["gemini", "gemini-cli"]);
  assert.deepEqual(providersForModel("some-new-model", LLM_PROVIDERS), []);
  assert.deepEqual(providersForModel("", LLM_PROVIDERS), []);
  assert.ok(providersForModel("claude-fable-5-2").includes("anthropic"), "ai-auth's own ids by default");
});

test("model choice: request, then the tenant's, then the catalogue — a foreign saved model is skipped", () => {
  assert.equal(chooseModel("claude", { requested: "claude-opus-5-5", saved: "claude-haiku-5-5" }), "claude-opus-5-5");
  assert.equal(chooseModel("claude", { saved: "claude-haiku-5-5" }), "claude-haiku-5-5");
  assert.equal(chooseModel("claude", { saved: "gpt-5" }), "claude-sonnet-5-5");
  assert.equal(chooseModel("claude", { saved: "claude-typed-in" }), "claude-typed-in");
  assert.equal(chooseModel("gemini-cli", {}), "gemini-3.8-flash-medium");
  assert.ok(modelFitsProvider("anything-unlisted", "codex"));
  assert.ok(!modelFitsProvider("claude-opus-5-5", "openai"));
});

// ---- pricing --------------------------------------------------------------------

test("the newest models are priced at their published rates", () => {
  assert.deepEqual([pricingFor("claude-fable-5-2").input, pricingFor("claude-fable-5-2").output], [8, 40]);
  assert.deepEqual([pricingFor("claude-fable-5-1").input, pricingFor("claude-fable-5-1").output], [10, 50]);
  assert.deepEqual([pricingFor("claude-opus-5-5").input, pricingFor("claude-opus-5-5").output], [4, 20]);
  assert.deepEqual([pricingFor("claude-sonnet-5-5").input, pricingFor("claude-sonnet-5-5").output], [2, 10]);
  assert.deepEqual([pricingFor("claude-haiku-5-5").input, pricingFor("claude-haiku-5-5").output], [0.1, 0.5]);
  assert.equal(pricingFor("claude-haiku-4-5-20251001").input, 1, "a dated id still finds its rate");
  assert.ok(PRICING["gemini-3.8-flash-medium"]);
});

test("cache reads use the model's own rate, and a long Haiku 5.5 prompt its long-context rate", () => {
  const read = costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(read.cacheReadUsd, 0.2);
  const shortCall = costOf("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1_000_000 });
  near(shortCall.outputUsd, 0.5);
  const longCall = costOf("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1_000_000 });
  near(longCall.inputUsd, 0.1);
  near(longCall.outputUsd, 2.5);
  // The budget guard must price a long prompt at the long rate before the call, too.
  assert.ok(worstCaseCost("claude-haiku-5-5", 200_000, 0) > worstCaseCost("claude-haiku-5-5", 100_000, 0) * 4);
});

test("Gemini is a provider of its own, and its subscription is free to the deployment", () => {
  assert.ok(PROVIDER_IDS.includes("gemini") && PROVIDER_IDS.includes("gemini-cli"));
  assert.ok(isSubscription("gemini-cli"));
  assert.ok(!isSubscription("gemini"));
  assert.equal(providerOf("gemini-3.1-pro"), "gemini");
  assert.equal(costOf("gemini-3.1-pro", { input_tokens: 1e6, output_tokens: 1e6 }, "gemini-cli").totalUsd, 0);
  assert.equal(worstCaseCost("gemini-3.1-pro", 1e6, 1e6, "gemini-cli"), 0);
});

// ---- the Gemini wire ----------------------------------------------------------------

test("a tiered Gemini 3.8 Flash id becomes the tiered model plus a thinking level", () => {
  assert.equal(antigravityThinkingLevel("gemini-3.8-flash-high"), "high");
  assert.equal(antigravityThinkingLevel("gemini-3.8-flash"), "medium");
  assert.equal(antigravityThinkingLevel("gemini-3.1-pro"), undefined);

  const high = toCodeAssistRequest("gemini-3.8-flash-high", "hi");
  assert.equal(high.model, "gemini-3.8-flash-tiered");
  assert.equal(high.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.deepEqual(high.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);

  const low = toCodeAssistRequest("models/gemini-3.8-flash-low", "hi");
  assert.equal(low.request.generationConfig.thinkingConfig.thinkingLevel, "low");

  const pro = toCodeAssistRequest("gemini-3.1-pro", "hi");
  assert.equal(pro.model, "gemini-3.1-pro-low");
  assert.equal(pro.request.generationConfig, undefined, "only tiered models carry a thinking level");
});

test("Cloud Code ids are normalized the way agy names them", () => {
  assert.equal(normalizeAntigravityModelId("gemini-4-argon"), "gemini-4-argon-medium");
  assert.equal(normalizeAntigravityModelId("gemini-3.7-flash"), "gemini-3.7-flash-medium");
  assert.equal(normalizeAntigravityModelId("gemini-3.7-flash-HIGH"), "gemini-3.7-flash-high");
  assert.equal(normalizeAntigravityModelId("gemini-3.2-flash-lite"), "gemini-3-flash");
  assert.equal(normalizeAntigravityModelId("gemini-4-argon-high"), "gemini-4-argon-high");
  // AI Studio has no effort-tier models: the suffix comes off.
  assert.equal(geminiStudioModelId("gemini-3.8-flash-high"), "gemini-3.8-flash");
  assert.equal(geminiStudioModelId("gemini-3.1-pro"), "gemini-3.1-pro");
});

test("a Code Assist request carries project, system, tools and toolChoice where asked", () => {
  const body = toCodeAssistRequest("gemini-3.1-pro", "hi", {
    projectId: "my-project-1", systemInstruction: "be brief", userPromptId: "p1", toolChoice: "none",
    includeThoughts: true,
    tools: [{ name: "fs__read", description: "read", input_schema: { type: "object", properties: { path: { type: ["string", "null"] } }, additionalProperties: false } }],
  });
  assert.equal(body.project, "my-project-1");
  assert.equal(body.user_prompt_id, "p1");
  assert.deepEqual(body.request.systemInstruction, { role: "system", parts: [{ text: "be brief" }] });
  const decl = body.request.tools[0].functionDeclarations[0];
  assert.equal(decl.name, "fs__read");
  assert.deepEqual(decl.parameters, { type: "object", properties: { path: { type: "string", nullable: true } } });
  assert.deepEqual(body.request.toolConfig, { functionCallingConfig: { mode: "NONE" } });
  assert.equal(body.request.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(toCodeAssistRequest("gemini-3.1-pro", "hi").project, undefined);
});

test("the schema sanitizer speaks Gemini's dialect", () => {
  assert.deepEqual(sanitizeGeminiFunctionParameters(null), { type: "object", properties: {} });
  // const → one-value enum; unknown keywords dropped; a property named `type` survives.
  assert.deepEqual(sanitizeGeminiFunctionParameters({
    $schema: "x", type: "object", additionalProperties: false,
    properties: { mode: { const: "fast" }, type: { type: "string" } },
  }), { type: "object", properties: { mode: { enum: ["fast"] }, type: { type: "string" } } });
  // A non-string enum is refused by Gemini: the values move into the description.
  assert.deepEqual(sanitizeGeminiFunctionParameters({ enum: [1, 2], description: "Level." }),
    { description: "Level. Allowed value(s): 1, 2.", type: "integer" });
  // A union of literals collapses to one enum.
  assert.deepEqual(sanitizeGeminiFunctionParameters({ anyOf: [{ type: "string", const: "a" }, { type: "string", const: "b" }] }),
    { type: "string", enum: ["a", "b"] });
  // Several non-null types keep every alternative.
  assert.deepEqual(sanitizeGeminiFunctionParameters({ type: ["string", "number"] }).anyOf.map((b) => b.type), ["string", "number"]);
  // Nested items and required imply an object.
  assert.equal(sanitizeGeminiFunctionParameters({ required: ["a"] }).type, "object");
  assert.deepEqual(sanitizeGeminiFunctionParameters({ type: "array", items: { type: ["integer", "null"] } }).items,
    { type: "integer", nullable: true });
});

test("a Google subscription call goes to the daily host and never sends the shared project as a header", () => {
  const opts = antigravityCliOptions({ accessToken: "ya29.t", projectId: "aicode-consumers" });
  assert.equal(opts.baseURL, CLOUD_CODE_DAILY_BASE_URL);
  assert.equal(opts.defaultHeaders.authorization, "Bearer ya29.t");
  assert.ok(!("x-goog-user-project" in opts.defaultHeaders));
  assert.match(opts.defaultHeaders["user-agent"], /^antigravity\/2\.29\.0 /);
  assert.equal(antigravityCliOptions({ accessToken: "t", projectId: "mine-123" }).defaultHeaders["x-goog-user-project"], "mine-123");
  assert.equal(sanitizePersonalCloudCodeProject("  "), null);

  process.env.ANTIGRAVITY_CLIENT_VERSION = "3.1.4";
  try {
    assert.match(antigravityCliOptions({ accessToken: "t" }).defaultHeaders["user-agent"], /^antigravity\/3\.1\.4 /);
  } finally { delete process.env.ANTIGRAVITY_CLIENT_VERSION; }
  assert.ok(isAntigravityUpgradeNotice("This version of Antigravity is no longer supported. Download at antigravity.google/download"));
  assert.ok(!isAntigravityUpgradeNotice("Here is your answer."));
});

test("fetch headers: a Gemini key goes in a header, a Google token as a bearer", () => {
  const key = httpHeadersFor({ provider: "gemini", apiKey: "AIza-test" });
  assert.equal(key["x-goog-api-key"], "AIza-test");
  assert.ok(!("authorization" in key));
  const sub = httpHeadersFor({ provider: "gemini-cli", accessToken: "ya29.t", projectId: null });
  assert.equal(sub.authorization, "Bearer ya29.t");
  assert.ok(!("x-goog-api-key" in sub));
  // SandboxOS's `claude` is the metered Anthropic key.
  assert.equal(httpHeadersFor({ provider: "claude", apiKey: "sk-ant" })["x-api-key"], "sk-ant");
});

test("the Codex body is the Responses shape the ChatGPT backend takes", () => {
  const body = codexResponsesBody({ model: "gpt-5", instructions: "be brief", input: [{ role: "user", content: "hi" }] });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "be brief");
  assert.ok(!("max_output_tokens" in body) && !("max_tokens" in body) && !("messages" in body));
  assert.ok(codexResponsesBody({ model: "gpt-5", input: [] }).instructions, "instructions are required");
});

test("a refused Google plan says so, and names agy", () => {
  const msg = describeProviderError({ status: 429, message: "429 {}" }, "gemini-cli", "gemini-3.1-pro");
  assert.match(msg, /Google \/ Gemini plan refused/);
  assert.match(msg, /`agy`/);
  assert.match(describeProviderError({ status: 401 }, "gemini-cli", "x"), /agy/);
});

// ---- the Antigravity login --------------------------------------------------------

test("a Google login carries PKCE, asks for a refresh token, and keeps the verifier home", () => {
  const started = startAntigravityLogin({ email: "a@example.com" });
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("redirect_uri"), "https://antigravity.google/oauth-callback");
  assert.equal(url.searchParams.get("login_hint"), "a@example.com");
  assert.ok(url.searchParams.get("scope").includes("https://www.googleapis.com/auth/aicode"));
  assert.ok(!started.url.includes(started.verifier));
});

test("the Google code exchange is form-encoded, carries the secret, and reads the email back", async () => {
  let seen = null;
  const identity = await exchangeAntigravityCode({
    code: "4/abc", verifier: "v1", now: () => 1000,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        access_token: "ya29.live", refresh_token: "1//rt", expires_in: 3599,
        id_token: jwt({ email: "me@example.com" }),
      }), { status: 200 });
    },
  });
  assert.equal(seen.init.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(seen.init.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "v1");
  assert.ok(form.get("client_secret"));
  assert.deepEqual(identity, {
    accessToken: "ya29.live", refreshToken: "1//rt", expiresAt: 1000 + 3599_000, email: "me@example.com", isDogfood: false,
  });

  await assert.rejects(exchangeAntigravityCode({
    code: "spent", verifier: "v",
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 }),
  }), (e) => e.name === "AntigravityLoginError" && e.restart === true);
});

test("the Google account store refreshes a stale token and keeps the project id", async () => {
  let now = 10_000_000;
  let refreshes = 0;
  const store = new AntigravityAccountStore({
    store: new MemoryCredentialStore(), secret: "host-secret", now: () => now,
    fetchImpl: async (_url, init) => {
      refreshes += 1;
      assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
      return new Response(JSON.stringify({ access_token: `fresh-${refreshes}`, expires_in: 3600 }), { status: 200 });
    },
  });
  await store.save("t1", { accessToken: "old", refreshToken: "1//rt", expiresAt: now + 3600_000, email: "me@example.com" }, "my-project-1");
  assert.equal(await store.token("t1"), "old");

  now += 2 * 3600_000;
  const [a, b] = await Promise.all([store.token("t1"), store.token("t1")]);
  assert.equal(a, "fresh-1");
  assert.equal(b, "fresh-1");
  assert.equal(refreshes, 1, "simultaneous callers share one refresh");
  const status = await store.status("t1");
  assert.equal(status.projectId, "my-project-1", "a refresh must not drop the project id");
  assert.equal(status.email, "me@example.com");
  assert.equal(status.expired, false);

  await store.setProjectId("t1", "  ");
  assert.equal((await store.status("t1")).projectId, null);
  // Sealed under its own label: the Claude store's secret cannot open it, and vice versa.
  const other = new AntigravityAccountStore({ store: store.options.store, secret: "another-secret" });
  assert.equal((await other.status("t1")).connected, false);
});

test("the agy token file is read nested, with the email and client out of the id token", () => {
  const parsed = parseAntigravityToken(JSON.stringify({
    token: { access_token: "ya29.a", refresh_token: "1//r", expiry: "2030-01-01T00:00:00Z" },
    id_token: jwt({ email: "op@example.com", azp: "884354919052-x" }),
  }));
  assert.equal(parsed.accessToken, "ya29.a");
  assert.equal(parsed.email, "op@example.com");
  assert.equal(parsed.isDogfood, true);
  assert.equal(parsed.expiresAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(parseAntigravityToken("{}"), null);
  assert.equal(parseAntigravityToken("not json"), null);
});
