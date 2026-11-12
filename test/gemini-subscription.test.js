// The Google login end to end through the Gateway, and what each of the new call paths
// actually puts on the wire: Gemini on a subscription (Cloud Code), Gemini on a key
// (AI Studio), and Codex on the Responses API.
//
// Nothing touches the network. Every endpoint is a local stub found through its
// SANDBOXOS_* override, because the parts that matter — the host, the headers, the body
// envelope, the thought signature echoed back — are invisible from a response.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { TEST_HOME } from "./_setup.js";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, mintMachineToken, updateTenantProfile } from "../packages/control-db/src/registry.js";
import { putTenantSecret } from "../packages/secrets/src/store.js";
import { createServer } from "../apps/gateway/src/server.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { runTurn, renderTranscript } from "../packages/assistant/src/assistant.js";
import { resolveLlmCredential } from "../packages/llm/src/providers.js";
import { runAI } from "../packages/agents/src/ai-runner.js";
import { createAgent, getAgent } from "../packages/control-db/src/registry.js";

let owner, sandbox, token, srv, port, kernel, held;
const stubs = [];
const calls = { oauth: [], cloud: [], studio: [], codex: [] };
const saved = {};
/** What the Cloud Code stub answers next, one script entry per call. */
let cloudScript = [];

function stub(handler) {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req, body, res));
  });
  stubs.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
}

function setEnv(name, value) {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

const sse = (res, frames) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end();
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "gemini-sub-test" }).token;
  held = grantsFor(owner.id, sandbox.id);

  const oauth = await stub((req, body, res) => {
    calls.oauth.push({ headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { "content-type": "application/json" });
    const claims = Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url");
    res.end(JSON.stringify({ access_token: "ya29.live", refresh_token: "1//rt", expires_in: 3600, id_token: `h.${claims}.s` }));
  });
  setEnv("SANDBOXOS_ANTIGRAVITY_OAUTH_URL", `${oauth}/token`);

  const cloud = await stub((req, body, res) => {
    calls.cloud.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const next = cloudScript.shift() ?? { parts: [{ text: "ok" }] };
    const frame = { response: { candidates: [{ content: { role: "model", parts: next.parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } };
    if (req.url.includes("streamGenerateContent")) return sse(res, [frame]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(frame));
  });
  setEnv("SANDBOXOS_CLOUD_CODE_URL", `${cloud}/v1internal`);

  const studio = await stub((req, body, res) => {
    calls.studio.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "from studio" }] } }] }));
  });
  setEnv("SANDBOXOS_GEMINI_URL", `${studio}/v1beta`);

  const codex = await stub((req, body, res) => {
    calls.codex.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    sse(res, [
      { type: "response.output_text.delta", delta: "from " },
      { type: "response.output_text.delta", delta: "codex" },
      { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } },
    ]);
  });
  setEnv("SANDBOXOS_CODEX_URL", `${codex}/backend-api/codex/responses`);

  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  kernel = await getKernel(sandbox);
});

test.after(() => {
  srv.close();
  for (const s of stubs) s.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetKernels();
  closeDb();
});

async function api(p, { method = "GET", body, auth = true } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

async function complete(args) {
  await api(`/${sandbox.slug}/mcp`, { method: "POST", body: { server: "mcp-registry", tool: "enable", args: { server: "llm" } } });
  return api(`/${sandbox.slug}/mcp`, { method: "POST", body: { server: "llm", tool: "complete", args } });
}

// ---- the login --------------------------------------------------------------

test("the Google login routes require authentication and start disconnected", async () => {
  assert.equal((await api("/api/antigravity", { auth: false })).status, 401);
  const { data } = await api("/api/antigravity");
  assert.equal(data.connected, false);
  const done = await api("/api/antigravity/login/complete", { method: "POST", body: { code: "x" } });
  assert.equal(done.status, 400, "completing a login nobody started is refused");
});

test("the Google login round trip connects an account and never returns the token", async () => {
  const started = await api("/api/antigravity/login", { method: "POST", body: {} });
  assert.equal(started.status, 200);
  assert.match(started.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);

  const bad = await api("/api/antigravity/login/complete", { method: "POST", body: { code: "4/abc", projectId: "Not A Project" } });
  assert.equal(bad.status, 400);

  await api("/api/antigravity/login", { method: "POST", body: {} });
  const { status, data } = await api("/api/antigravity/login/complete", {
    method: "POST", body: { code: "4/abc", projectId: "my-project-1" },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.connected, true);
  assert.equal(data.email, "me@example.com");
  assert.equal(data.projectId, "my-project-1");
  assert.ok(!JSON.stringify(data).includes("ya29.live"));
  assert.equal(calls.oauth.at(-1).form.code, "4/abc");
  assert.ok(calls.oauth.at(-1).form.code_verifier, "the verifier held on the Gateway is sent");

  const profile = await api("/api/profile");
  const sub = profile.data.profile.providers.find((p) => p.id === "gemini-cli");
  assert.equal(sub.configured, true);
  assert.equal(sub.plan, "me@example.com");
});

test("the project id can be changed and cleared without logging in again", async () => {
  assert.equal((await api("/api/antigravity/project", { method: "POST", body: { projectId: "UPPER" } })).status, 400);
  const set = await api("/api/antigravity/project", { method: "POST", body: { projectId: "other-proj" } });
  assert.equal(set.data.projectId, "other-proj");
  const cleared = await api("/api/antigravity/project", { method: "POST", body: { projectId: "" } });
  assert.equal(cleared.data.projectId, null);
  await api("/api/antigravity/project", { method: "POST", body: { projectId: "my-project-1" } });
});

// ---- the calls ----------------------------------------------------------------

test("a Gemini subscription call goes to Cloud Code, wrapped, with a bearer and a thinking level", async () => {
  await api("/api/profile", { method: "POST", body: { llmProvider: "gemini-cli", llmModel: "gemini-3.8-flash-high" } });
  const credential = await resolveLlmCredential(owner.tenant_id);
  assert.equal(credential.model, "gemini-3.8-flash-high");
  assert.equal(credential.projectId, "my-project-1");

  const out = await complete({ prompt: "hello", system: "be brief" });
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.result.content, "ok");
  assert.equal(out.data.result.mock, false);

  const sent = calls.cloud.at(-1);
  assert.equal(sent.url, "/v1internal:generateContent");
  assert.equal(sent.headers.authorization, "Bearer ya29.live");
  assert.equal(sent.headers["x-goog-user-project"], "my-project-1");
  assert.match(sent.headers["user-agent"], /^antigravity\//);
  assert.equal(sent.body.model, "gemini-3.8-flash-tiered");
  assert.equal(sent.body.project, "my-project-1");
  assert.equal(sent.body.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.deepEqual(sent.body.request.systemInstruction.parts, [{ text: "be brief" }]);
});

test("an outdated-client notice from Cloud Code is an error, not an answer", async () => {
  cloudScript = [{ parts: [{ text: "This version of Antigravity is no longer supported. Visit antigravity.google/download" }] }];
  const out = await complete({ prompt: "hello" });
  assert.equal(out.data.ok, false);
  assert.match(out.data.error, /ANTIGRAVITY_CLIENT_VERSION/);
});

test("the Assistant runs a Gemini tool loop and echoes the call back with its thought signature", async () => {
  cloudScript = [
    { parts: [{ functionCall: { name: "fs__list", args: { path: "." } }, thoughtSignature: "sig-123" }] },
    { parts: [{ text: "listed it" }] },
  ];
  const before = calls.cloud.length;
  const events = [];
  const out = await runTurn({
    kernel, sandbox, principalId: owner.id, heldPatterns: held, input: "what is here?",
    emit: (e) => events.push(e),
  });
  assert.equal(out.stopped, "end_turn", JSON.stringify(events.filter((e) => e.type === "error")));
  const [first, second] = calls.cloud.slice(before);
  assert.match(first.url, /:streamGenerateContent\?alt=sse$/);
  assert.ok(first.body.request.tools[0].functionDeclarations.some((d) => d.name === "fs__list"));
  const echoed = second.body.request.contents.find((c) => c.role === "model");
  assert.equal(echoed.parts[0].thoughtSignature, "sig-123", "Gemini 3 refuses a call echoed without its signature");
  const result = second.body.request.contents.at(-1);
  assert.equal(result.parts[0].functionResponse.name, "fs__list");
  assert.ok(events.some((e) => e.type === "tool_call" && e.server === "fs" && e.tool === "list"));
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "listed it");

  const rendered = renderTranscript(out.messages);
  assert.ok(rendered.some((r) => r.kind === "tool_call" && r.name === "fs.list"));
  assert.ok(rendered.some((r) => r.kind === "text" && r.text === "listed it"));
});

test("an AI agent runs its tool loop on a Gemini subscription", async () => {
  cloudScript = [
    { parts: [{ functionCall: { name: "fs__list", args: { path: "." } }, thoughtSignature: "sig-9" }] },
    { parts: [{ text: "agent done" }] },
  ];
  const minted = mintMachineToken(owner.id, sandbox.id, ["fs.*"], { label: "gemini-agent" });
  const agent = createAgent(sandbox.id, {
    principalId: minted.principalId, spawnedBy: owner.id, name: "g", patterns: minted.patterns,
    cmd: "", kind: "ai", prompt: "list", systemPrompt: "be brief",
  });
  const before = calls.cloud.length;
  await runAI(agent.id, {
    agentPrincipalId: minted.principalId, spawnedBy: owner.id, patterns: minted.patterns,
    prompt: "list", systemPrompt: "be brief", kernel, sandbox, model: "gemini-3.1-pro",
  });
  const finished = getAgent(agent.id);
  assert.equal(finished.state, "done", JSON.stringify(finished));
  assert.match(String(finished.result), /agent done/);
  const [first, second] = calls.cloud.slice(before);
  assert.equal(first.url, "/v1internal:generateContent");
  assert.equal(first.body.model, "gemini-3.1-pro-low", "the request's own model wins over the tenant's");
  assert.equal(second.body.request.contents[1].parts[0].thoughtSignature, "sig-9");
  assert.ok(second.body.request.contents[2].parts[0].functionResponse);
});

test("a conversation started on Claude carries on with Gemini as text", async () => {
  cloudScript = [{ parts: [{ text: "continuing" }] }];
  const history = [
    { role: "user", content: [{ type: "text", text: "first question" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }, { type: "tool_use", id: "t1", name: "fs__list", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] },
  ];
  const before = calls.cloud.length;
  const out = await runTurn({
    kernel, sandbox, principalId: owner.id, heldPatterns: held, history, input: "and now?", emit: () => {},
  });
  assert.equal(out.stopped, "end_turn");
  const contents = calls.cloud[before].body.request.contents;
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(contents[1].parts[0].text, "first answer");
});

test("a Gemini key call goes to AI Studio with the key in a header and the tier stripped from the id", async () => {
  putTenantSecret(owner.tenant_id, "GEMINI_API_KEY", "AIza-test");
  await api("/api/profile", { method: "POST", body: { llmProvider: "gemini", llmModel: "gemini-3.8-flash-low" } });
  const out = await complete({ prompt: "hi" });
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.result.content, "from studio");
  const sent = calls.studio.at(-1);
  assert.equal(sent.url, "/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(sent.headers["x-goog-api-key"], "AIza-test");
  assert.ok(!sent.url.includes("AIza"), "a key in the URL ends up in logs");
  assert.equal(sent.body.model, undefined, "AI Studio takes the bare request, not the Cloud Code envelope");
  assert.equal(sent.body.generationConfig.thinkingConfig.thinkingLevel, "low");
});

test("Codex posts the Responses API to /responses, never chat completions", async () => {
  const authFile = path.join(TEST_HOME, "codex-auth.json");
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
  fs.mkdirSync(TEST_HOME, { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: `h.${claims}.s` } }));
  setEnv("CODEX_AUTH_FILE", authFile);
  setEnv("SANDBOXOS_HOST_SUBSCRIPTION", "1");
  updateTenantProfile(owner.tenant_id, { llmProvider: "codex", llmModel: null });

  const out = await complete({ prompt: "hi", system: "be brief" });
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.result.content, "from codex");
  const sent = calls.codex.at(-1);
  assert.equal(sent.url, "/backend-api/codex/responses");
  assert.equal(sent.headers["chatgpt-account-id"], "acct-1");
  assert.equal(sent.body.model, "gpt-5");
  assert.equal(sent.body.instructions, "be brief");
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  assert.ok(!("messages" in sent.body));

  updateTenantProfile(owner.tenant_id, { llmProvider: "claude", llmModel: null });
});

test("disconnecting the Google account falls the tenant back to needing one", async () => {
  const { data } = await api("/api/antigravity", { method: "DELETE" });
  assert.equal(data.connected, false);
  const credential = await resolveLlmCredential(owner.tenant_id, "gemini-cli");
  assert.equal(credential.configured, false);
  assert.match(credential.error, /No Google subscription/);
});
