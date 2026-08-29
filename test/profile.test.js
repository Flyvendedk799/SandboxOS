// Profile/onboarding API: provider choice + encrypted tenant API keys.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken } from "../packages/control-db/src/registry.js";
import { getTenantSecretValue } from "../packages/secrets/src/store.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, token, srv, port, savedAnthropic, savedOpenAI;

test.before(async () => {
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "profile-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;
});

test.after(() => {
  srv.close();
  closeDb();
  if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
  if (savedOpenAI) process.env.OPENAI_API_KEY = savedOpenAI;
});

async function api(path, { method = "GET", body, auth = true } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

test("GET /api/profile requires auth", async () => {
  const { status, data } = await api("/api/profile", { auth: false });
  assert.equal(status, 401);
  assert.equal(data.ok, false);
});

test("GET /api/profile returns default provider state without secrets", async () => {
  const { data } = await api("/api/profile");
  assert.equal(data.ok, true);
  assert.equal(data.profile.llmProvider, "claude");
  assert.equal(data.profile.onboardingCompleted, false);
  assert.equal(data.profile.keyConfigured, false);
  assert.deepEqual(data.profile.providers.map((p) => p.id), ["claude", "claude-code", "openai", "codex"]);
  // The two subscription providers are keyless: they carry no secret name, because their
  // credential is an OAuth login rather than anything anyone pastes into a settings box.
  const byId = Object.fromEntries(data.profile.providers.map((p) => [p.id, p]));
  assert.equal(byId["claude"].billing, "key");
  assert.equal(byId["claude-code"].billing, "subscription");
  assert.equal(byId["claude-code"].secretName, null);
  assert.equal(byId["claude-code"].configured, false, "nothing is connected on a fresh tenant");
  assert.ok(!JSON.stringify(data).includes("sk-test"), "profile response must not leak key material");
});

test("POST /api/profile stores OpenAI key encrypted and marks onboarding complete", async () => {
  const key = "sk-test-openai";
  const { data } = await api("/api/profile", {
    method: "POST",
    body: { llmProvider: "openai", apiKey: key, completeOnboarding: true },
  });
  assert.equal(data.ok, true);
  assert.equal(data.profile.llmProvider, "openai");
  assert.equal(data.profile.onboardingCompleted, true);
  assert.equal(data.profile.keyConfigured, true);
  assert.ok(data.profile.providers.find((p) => p.id === "openai")?.configured);
  assert.ok(!JSON.stringify(data).includes(key), "API key must not appear in response");
  assert.equal(getTenantSecretValue(owner.tenant_id, "OPENAI_API_KEY"), key);

  await api(`/${sandbox.slug}/mcp`, {
    method: "POST",
    body: { server: "mcp-registry", tool: "enable", args: { server: "llm" } },
  });
  const models = await api(`/${sandbox.slug}/mcp`, {
    method: "POST",
    body: { server: "llm", tool: "models", args: {} },
  });
  assert.equal(models.data.ok, true);
  assert.equal(models.data.result.provider, "openai");
  assert.equal(models.data.result.configured, true);
});

test("POST /api/profile can switch providers and clear the selected key", async () => {
  await api("/api/profile", {
    method: "POST",
    body: { llmProvider: "claude", apiKey: "sk-ant-test", completeOnboarding: true },
  });
  assert.equal(getTenantSecretValue(owner.tenant_id, "ANTHROPIC_API_KEY"), "sk-ant-test");

  const { data } = await api("/api/profile", {
    method: "POST",
    body: { llmProvider: "claude", clearApiKey: true },
  });
  assert.equal(data.ok, true);
  assert.equal(data.profile.llmProvider, "claude");
  assert.equal(data.profile.keyConfigured, false);
  assert.equal(getTenantSecretValue(owner.tenant_id, "ANTHROPIC_API_KEY"), null);
});

test("POST /api/profile rejects unknown providers", async () => {
  const { status, data } = await api("/api/profile", {
    method: "POST",
    body: { llmProvider: "other-ai" },
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});
