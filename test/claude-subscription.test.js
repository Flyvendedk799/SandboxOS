// The browser login, end to end through the Gateway, and what a call made with the
// resulting credential actually puts on the wire.
//
// Nothing here touches the network: SANDBOXOS_CLAUDE_OAUTH_URL points the token exchange
// at a local stub, and SANDBOXOS_ANTHROPIC_URL points the `llm` server at another. That
// is the only way to test the parts that matter — the headers and the first system
// block — because both are invisible from the response.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken } from "../packages/control-db/src/registry.js";
import { createServer } from "../apps/gateway/src/server.js";
import { resolveLlmCredential, providerOptions } from "../packages/llm/src/providers.js";

let owner, sandbox, token, srv, port;
let oauth, oauthPort, oauthCalls;
let anthropic, anthropicPort, anthropicCalls;
let savedOauthUrl, savedAnthropicUrl;

/** A stub that answers the OAuth token endpoint, recording every body it is posted. */
function stubServer(handler) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req, body, res));
  });
}

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "claude-sub-test" }).token;

  oauthCalls = [];
  oauth = stubServer((req, body, res) => {
    oauthCalls.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      access_token: "sk-oauth-live", refresh_token: "rt-1", expires_in: 3600,
      scope: "user:inference user:profile", account: { subscription_type: "max" },
    }));
  });
  await new Promise((r) => oauth.listen(0, "127.0.0.1", r));
  oauthPort = oauth.address().port;
  savedOauthUrl = process.env.SANDBOXOS_CLAUDE_OAUTH_URL;
  process.env.SANDBOXOS_CLAUDE_OAUTH_URL = `http://127.0.0.1:${oauthPort}/token`;

  anthropicCalls = [];
  anthropic = stubServer((req, body, res) => {
    anthropicCalls.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "hi" }], model: "claude-haiku-4-5-20251001" }));
  });
  await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
  anthropicPort = anthropic.address().port;
  savedAnthropicUrl = process.env.SANDBOXOS_ANTHROPIC_URL;
  process.env.SANDBOXOS_ANTHROPIC_URL = `http://127.0.0.1:${anthropicPort}/v1/messages`;

  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});

test.after(() => {
  srv.close();
  oauth.close();
  anthropic.close();
  if (savedOauthUrl) process.env.SANDBOXOS_CLAUDE_OAUTH_URL = savedOauthUrl;
  else delete process.env.SANDBOXOS_CLAUDE_OAUTH_URL;
  if (savedAnthropicUrl) process.env.SANDBOXOS_ANTHROPIC_URL = savedAnthropicUrl;
  else delete process.env.SANDBOXOS_ANTHROPIC_URL;
  closeDb();
});

async function api(path, { method = "GET", body, auth = true } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

test("the subscription routes require authentication", async () => {
  const { status } = await api("/api/claude-code", { auth: false });
  assert.equal(status, 401);
});

test("a fresh tenant reports no subscription", async () => {
  const { data } = await api("/api/claude-code");
  assert.equal(data.ok, true);
  assert.equal(data.connected, false);
  assert.equal(data.plan, null);
});

test("completing a login without starting one is refused", async () => {
  const { status, data } = await api("/api/claude-code/login/complete", { method: "POST", body: { code: "abc#def" } });
  assert.equal(status, 400);
  assert.match(data.error, /expired or was never started/);
});

test("the login round trip connects a plan and never returns the token", async () => {
  const start = await api("/api/claude-code/login", { method: "POST" });
  assert.equal(start.status, 200);
  const url = new URL(start.data.url);
  assert.equal(url.origin + url.pathname, "https://platform.claude.com/oauth/authorize");
  const state = url.searchParams.get("state");
  assert.ok(state);
  assert.ok(!JSON.stringify(start.data).includes("code_verifier"), "the verifier stays on the Gateway");

  // A code from somebody else's approval, pasted here, has to be refused — that is the
  // entire job of the state parameter.
  const wrong = await api("/api/claude-code/login/complete", { method: "POST", body: { code: "the-code#not-the-state" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /different login/);

  const done = await api("/api/claude-code/login/complete", { method: "POST", body: { code: `the-code#${state}` } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.connected, true);
  assert.equal(done.data.plan, "max");
  assert.ok(!JSON.stringify(done.data).includes("sk-oauth-live"), "the access token must never reach the browser");

  const exchanged = oauthCalls.at(-1);
  assert.equal(exchanged.grant_type, "authorization_code");
  assert.equal(exchanged.state, state);
  assert.ok(exchanged.code_verifier);

  // Single use: the same code must not be replayable even with the right state.
  const replay = await api("/api/claude-code/login/complete", { method: "POST", body: { code: `the-code#${state}` } });
  assert.equal(replay.status, 400);
});

test("the connected plan shows up on the profile without any key material", async () => {
  const { data } = await api("/api/profile");
  const sub = data.profile.providers.find((p) => p.id === "claude-code");
  assert.equal(sub.configured, true);
  assert.equal(sub.plan, "max");
  assert.ok(!JSON.stringify(data).includes("sk-oauth-live"));
});

test("a call on the subscription sends a bearer token and opens with the Claude Code identity", async () => {
  await api("/api/profile", { method: "POST", body: { llmProvider: "claude-code" } });

  const credential = await resolveLlmCredential(owner.tenant_id);
  assert.equal(credential.provider, "claude-code");
  assert.equal(credential.billing, "subscription");
  assert.equal(credential.source, "subscription");
  assert.equal(credential.accessToken, "sk-oauth-live");

  await api(`/${sandbox.slug}/mcp`, {
    method: "POST", body: { server: "mcp-registry", tool: "enable", args: { server: "llm" } },
  });
  const out = await api(`/${sandbox.slug}/mcp`, {
    method: "POST", body: { server: "llm", tool: "complete", args: { prompt: "hello" } },
  });
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.result.mock, false);

  const sent = anthropicCalls.at(-1);
  assert.equal(sent.headers.authorization, "Bearer sk-oauth-live");
  assert.ok(!("x-api-key" in sent.headers), "a key header beside a bearer token is rejected by Anthropic");
  assert.ok(sent.headers["anthropic-beta"].includes("oauth-2025-04-20"));
  // The identity block must be first and must stand alone, or Sonnet and Opus come back
  // 429 on a plan nowhere near its limit — while Haiku, the model you would test with,
  // answers fine.
  assert.equal(sent.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(sent.body.system.length, 1, "no caller prompt was supplied, so there is nothing after it");
});

test("disconnecting falls the tenant back to needing a key", async () => {
  const { data } = await api("/api/claude-code", { method: "DELETE" });
  assert.equal(data.connected, false);

  const options = await providerOptions(owner.tenant_id);
  const sub = options.find((p) => p.id === "claude-code");
  assert.equal(sub.configured, false);
  assert.match(sub.detail, /no Claude subscription connected/);

  const credential = await resolveLlmCredential(owner.tenant_id);
  assert.equal(credential.configured, false);
  assert.match(credential.error, /Connect one in Settings/);
});

test("codex stays off until the operator opts the host login in", async () => {
  const off = await providerOptions(owner.tenant_id);
  assert.match(off.find((p) => p.id === "codex").detail, /SANDBOXOS_HOST_SUBSCRIPTION=1/);

  const credential = await resolveLlmCredential(owner.tenant_id, "codex");
  assert.equal(credential.configured, false);
  // Silently billing every tenant's work to the operator's own plan is the failure this
  // default exists to prevent.
  assert.match(credential.error, /host's own `codex` login/);
});
