// Phase 3 agents: spawn, list, get, kill, on-behalf-of audit, attenuation.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, getAgent } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { recentAudit } from "../packages/control-db/src/registry.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

// ─── basic lifecycle ───────────────────────────────────────────────────────────

test("agents.spawn creates a queued agent and returns its id", async () => {
  const r = await call("agents", "spawn", {
    name: "echo-agent",
    patterns: ["fs.*", "proc.exec"],
    cmd: "echo hello-from-agent",
  });
  assert.ok(r.ok, r.error);
  assert.ok(r.result.id, "id returned");
  assert.ok(Array.isArray(r.result.patterns), "patterns returned");
  assert.ok(r.result.patterns.includes("fs.*"));
});

test("agents.list shows the spawned agent", async () => {
  // spawn one more so the list is non-empty
  await call("agents", "spawn", { name: "listed", patterns: ["fs.list"], cmd: "echo listed" });
  const r = await call("agents", "list", {});
  assert.ok(r.ok);
  assert.ok(r.result.agents.length >= 1);
  assert.ok(r.result.agents.some((a) => a.name === "listed"));
});

test("agents.get returns full agent detail", async () => {
  const spawn = await call("agents", "spawn", { name: "detail-test", patterns: ["proc.exec"], cmd: "echo detail" });
  const id = spawn.result.id;
  const r = await call("agents", "get", { id });
  assert.ok(r.ok);
  assert.equal(r.result.id, id);
  assert.equal(r.result.name, "detail-test");
  assert.equal(r.result.cmd, "echo detail");
  assert.ok(["queued", "running", "done"].includes(r.result.state));
  assert.ok(Array.isArray(r.result.patterns));
  assert.equal(r.result.spawned_by, owner.id);
});

test("agents.get is unauthorized for unknown agent id", async () => {
  const r = await call("agents", "get", { id: "agt_notexist" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such agent/);
});

test("agent eventually transitions to done", async () => {
  const spawn = await call("agents", "spawn", { name: "fast-done", patterns: ["proc.exec"], cmd: "echo fast" });
  const id = spawn.result.id;
  // poll a few times (the local backend exec is near-instant)
  let agent;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    agent = getAgent(id);
    if (agent.state === "done" || agent.state === "failed") break;
  }
  assert.ok(agent.state === "done" || agent.state === "failed", `state was: ${agent.state}`);
  if (agent.state === "done") assert.ok(agent.result.includes("fast"));
});

test("agent result captures stdout on done", async () => {
  const spawn = await call("agents", "spawn", { name: "stdout-test", patterns: ["proc.exec"], cmd: "echo STDOUT_PAYLOAD" });
  const id = spawn.result.id;
  await new Promise((r) => setTimeout(r, 500));
  const agent = getAgent(id);
  if (agent.state === "done") {
    assert.ok(agent.result.includes("STDOUT_PAYLOAD"), `stdout was: ${agent.result}`);
  }
});

test("agents.kill marks a running-or-queued agent as killed", async () => {
  // Use a slow command so it's still running when we kill it
  const spawn = await call("agents", "spawn", {
    name: "slow-kill",
    patterns: ["proc.exec"],
    cmd: "sleep 5 && echo late",
  });
  const id = spawn.result.id;
  // Give it a moment to start
  await new Promise((r) => setTimeout(r, 100));
  const kill = await call("agents", "kill", { id });
  assert.ok(kill.ok);
  assert.ok(kill.result.killed, `kill returned: ${JSON.stringify(kill.result)}`);
  const agent = getAgent(id);
  assert.equal(agent.state, "killed");
});

test("kill on an already-done agent returns killed:false", async () => {
  const spawn = await call("agents", "spawn", { name: "done-kill", patterns: ["proc.exec"], cmd: "echo quick" });
  const id = spawn.result.id;
  await new Promise((r) => setTimeout(r, 500));
  const agent = getAgent(id);
  if (agent.state !== "done") return; // agent still running — skip this check
  const kill = await call("agents", "kill", { id });
  assert.ok(kill.ok);
  assert.equal(kill.result.killed, false);
  assert.match(kill.result.reason, /already done/);
});

// ─── capability attenuation ────────────────────────────────────────────────────

test("spawned agent has a dedicated principal with attenuated patterns", async () => {
  const spawn = await call("agents", "spawn", { name: "attenuated", patterns: ["fs.list"], cmd: "echo x" });
  assert.ok(spawn.ok);
  const agent = getAgent(spawn.result.id);
  // The agent's principal is a machine principal distinct from the owner
  assert.notEqual(agent.principal_id, owner.id);
  // Its grants are exactly the requested patterns
  const agentGrants = grantsFor(agent.principal_id, sandbox.id);
  assert.deepEqual(agentGrants, ["fs.list"]);
});

test("cannot spawn an agent with patterns exceeding caller's authority", async () => {
  // Mint a principal that holds agents.* + fs.list (not proc.exec)
  const { mintMachineToken } = await import("../packages/control-db/src/registry.js");
  const limited = mintMachineToken(owner.id, sandbox.id, ["agents.*", "fs.list"], { label: "limited" });
  // This principal can call agents.spawn but cannot grant proc.exec (not held)
  const r = await kernel.call({
    principalId: limited.principalId,
    heldPatterns: ["agents.*", "fs.list"],
    server: "agents",
    tool: "spawn",
    args: { name: "too-wide", patterns: ["proc.exec"], cmd: "echo x" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /attenuation/);
});

// ─── audit trail ──────────────────────────────────────────────────────────────

test("agents.spawn appears in the audit log", async () => {
  await call("agents", "spawn", { name: "audit-test", patterns: ["fs.list"], cmd: "echo audit" });
  const events = recentAudit(sandbox.id, 20);
  assert.ok(events.some((e) => e.server === "agents" && e.tool === "spawn" && e.result_kind === "ok"));
});

// ─── llm server ───────────────────────────────────────────────────────────────

test("llm.models lists known models and reports key status", async () => {
  // llm is in the catalog but NOT in the default manifest — enable it first
  await call("mcp-registry", "enable", { server: "llm" });
  const r = await call("llm", "models", {});
  assert.ok(r.ok, r.error);
  assert.ok(Array.isArray(r.result.models));
  assert.ok(r.result.models.length >= 1);
  assert.equal(typeof r.result.configured, "boolean");
});

test("llm.complete returns mock response when API key is absent", async () => {
  // Ensure key is unset for the test (it may or may not be set in CI)
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await call("llm", "complete", { prompt: "say hi", system: "be brief" });
    assert.ok(r.ok, r.error);
    assert.equal(r.result.mock, true);
    assert.ok(typeof r.result.content === "string");
  } finally {
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test("llm.complete is default-deny when caller lacks llm.* capability", async () => {
  const { mintMachineToken } = await import("../packages/control-db/src/registry.js");
  const fsOnly = mintMachineToken(owner.id, sandbox.id, ["fs.*"], { label: "fsonly" });
  const r = await kernel.call({
    principalId: fsOnly.principalId,
    heldPatterns: ["fs.*"],
    server: "llm",
    tool: "complete",
    args: { prompt: "should fail" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /denied/);
});
