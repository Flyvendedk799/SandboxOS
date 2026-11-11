// Multi-tenant Onboarding, Routing, and Quota Management test suite.
// Covers Acceptance Criteria C1, C2, and C3.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed } from "../packages/control-db/src/registry.js";
import { createServer } from "../apps/gateway/src/server.js";

let srv, baseUrl;
let _ipSeq = 1;
const nextIp = () => `10.99.0.${(_ipSeq++ % 200) + 1}`;

test.before(async () => {
  openDb();
  ensureSeed("local");
  srv = createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(() => {
  if (srv) srv.close();
  closeDb();
});

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
  // The session is the cookie; nothing echoes it into a body a script could read.
  const token = /sbx_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;
  return { status: res.status, data: await res.json(), headers: res.headers, token };
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp(), ...headers },
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

async function deleteJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp(), ...headers },
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

// ═════════════════════════════════════════════════════════════════════════════
// C1: Tenant self-service signup, login, profile management without SQLite binding errors
// ═════════════════════════════════════════════════════════════════════════════

test("C1: POST /signup succeeds with valid credentials and returns token and slug", async () => {
  const username = `tenant_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const res = await postJson("/signup", { username, password });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.ok(typeof res.token === "string" && res.token.length > 0);
  assert.ok(typeof res.data.slug === "string" && res.data.slug.length > 0);
  assert.equal(res.data.username, username);
});

test("C1: POST /signup handles missing/undefined parameters gracefully without 500 SQLite error", async () => {
  // Test undefined/missing fields
  const missingBoth = await postJson("/signup", {});
  assert.equal(missingBoth.status, 400);
  assert.equal(missingBoth.data.ok, false);
  assert.notEqual(missingBoth.status, 500);

  const missingPass = await postJson("/signup", { username: "lonely_user" });
  assert.equal(missingPass.status, 400);
  assert.equal(missingPass.data.ok, false);
  assert.notEqual(missingPass.status, 500);

  const missingUser = await postJson("/signup", { password: "ValidPassword123!" });
  assert.equal(missingUser.status, 400);
  assert.equal(missingUser.data.ok, false);
  assert.notEqual(missingUser.status, 500);

  // Test null / invalid types
  const nullValues = await postJson("/signup", { username: null, password: null });
  assert.equal(nullValues.status, 400);
  assert.equal(nullValues.data.ok, false);
  assert.notEqual(nullValues.status, 500);
});

test("C1: POST /login handles valid login and invalid/missing parameters without 500 SQLite error", async () => {
  const username = `login_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signupRes = await postJson("/signup", { username, password });
  assert.equal(signupRes.status, 200);

  // Valid login
  const loginRes = await postJson("/login", { username, password });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.ok, true);
  assert.ok(typeof loginRes.token === "string");
  assert.ok(typeof loginRes.data.slug === "string");

  // Invalid password -> 401
  const badPass = await postJson("/login", { username, password: "wrong-password" });
  assert.equal(badPass.status, 401);
  assert.equal(badPass.data.ok, false);
  assert.notEqual(badPass.status, 500);

  // Non-existent user -> 401
  const unknownUser = await postJson("/login", { username: "does_not_exist_xyz", password });
  assert.equal(unknownUser.status, 401);
  assert.equal(unknownUser.data.ok, false);
  assert.notEqual(unknownUser.status, 500);

  // Missing fields -> 400 or 401, never 500
  const emptyLogin = await postJson("/login", {});
  assert.ok([400, 401].includes(emptyLogin.status));
  assert.notEqual(emptyLogin.status, 500);

  const nullLogin = await postJson("/login", { username: null, password: null });
  assert.ok([400, 401].includes(nullLogin.status));
  assert.notEqual(nullLogin.status, 500);
});

test("C1: Profile management operates without 500 errors", async () => {
  const username = `profile_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  // GET /api/profile
  const getProf = await getJson("/api/profile", authHeader);
  assert.equal(getProf.status, 200);
  assert.equal(getProf.data.ok, true);
  assert.equal(getProf.data.profile.llmProvider, "claude");

  // POST /api/profile with valid config
  const updateProf = await postJson(
    "/api/profile",
    { llmProvider: "openai", apiKey: "sk-tenant-test-key", completeOnboarding: true },
    authHeader
  );
  assert.equal(updateProf.status, 200);
  assert.equal(updateProf.data.ok, true);
  assert.equal(updateProf.data.profile.llmProvider, "openai");
  assert.equal(updateProf.data.profile.onboardingCompleted, true);

  // POST /api/profile with invalid inputs -> 400, not 500
  const badProvider = await postJson("/api/profile", { llmProvider: "invalid-provider" }, authHeader);
  assert.equal(badProvider.status, 400);
  assert.notEqual(badProvider.status, 500);
});

// ═════════════════════════════════════════════════════════════════════════════
// C2: Quota resource limits strictly checked and enforced on sandbox creation & agent spawn
// ═════════════════════════════════════════════════════════════════════════════

test("C2: Quota limits configuration and live reporting via GET/POST /api/quota", async () => {
  const username = `quota_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  // Check default quota
  const defaultQuota = await getJson("/api/quota", authHeader);
  assert.equal(defaultQuota.status, 200);
  assert.equal(defaultQuota.data.quota.max_sandboxes, 3);
  assert.equal(defaultQuota.data.quota.max_agents, 10);
  assert.equal(defaultQuota.data.quota.max_disk_mb, 1024);
  assert.equal(defaultQuota.data.quota.network_egress, "allow");

  // Update quota
  const updateQuota = await postJson(
    "/api/quota",
    { maxSandboxes: 2, maxAgents: 1, maxDiskMb: 2048, networkEgress: "deny" },
    authHeader
  );
  assert.equal(updateQuota.status, 200);
  assert.equal(updateQuota.data.quota.max_sandboxes, 2);
  assert.equal(updateQuota.data.quota.max_agents, 1);
  assert.equal(updateQuota.data.quota.max_disk_mb, 2048);
  assert.equal(updateQuota.data.quota.network_egress, "deny");

  // Verify live usage reporting in /api/quota
  assert.ok(typeof updateQuota.data.usage === "object");
  assert.equal(updateQuota.data.usage.sandboxes, 1); // signup created primary sandbox
  assert.equal(updateQuota.data.usage.runningAgents, 0);
});

test("C2: Strictly enforce max_sandboxes quota on sandbox creation", async () => {
  const username = `sb_quota_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  // Set max_sandboxes to 2 (user already has 1 sandbox from signup)
  await postJson("/api/quota", { maxSandboxes: 2 }, authHeader);

  // Create 2nd sandbox -> should succeed
  const sb2Slug = `sb2-${Date.now().toString(36)}`;
  const sb2Res = await postJson("/api/sandboxes", { slug: sb2Slug, name: "Second Sandbox" }, authHeader);
  assert.equal(sb2Res.status, 200);
  assert.equal(sb2Res.data.ok, true);

  // Attempt 3rd sandbox -> should be blocked by 429 quota exceeded
  const sb3Slug = `sb3-${Date.now().toString(36)}`;
  const sb3Res = await postJson("/api/sandboxes", { slug: sb3Slug, name: "Third Sandbox" }, authHeader);
  assert.equal(sb3Res.status, 429);
  assert.equal(sb3Res.data.ok, false);
  assert.ok(sb3Res.data.error.includes("sandbox quota exceeded"));
});

test("C2: Strictly enforce max_agents quota on agent spawning", async () => {
  const username = `ag_quota_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };
  const userSlug = signup.data.slug;

  // Set max_agents to 1
  await postJson("/api/quota", { maxAgents: 1 }, authHeader);

  // Spawn agent 1 with a command that keeps running
  const a1 = await postJson(
    `/${userSlug}/mcp`,
    { server: "agents", tool: "spawn", args: { name: "agent-1", patterns: ["proc.exec"], cmd: "sleep 10" } },
    authHeader
  );
  assert.equal(a1.status, 200);
  assert.equal(a1.data.ok, true);

  // Attempt to spawn agent 2 -> should be blocked by 429 agent quota exceeded
  const a2 = await postJson(
    `/${userSlug}/mcp`,
    { server: "agents", tool: "spawn", args: { name: "agent-2", patterns: ["proc.exec"], cmd: "sleep 10" } },
    authHeader
  );
  assert.equal(a2.status, 429);
  assert.equal(a2.data.ok, false);
  assert.ok(a2.data.error.includes("agent quota exceeded"));

  // Kill agent 1
  if (a1.data.result?.id) {
    await deleteJson(`/${userSlug}/agents/${a1.data.result.id}`, authHeader);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// C3: Multi-tenant self-service onboarding, team access, vanity routing, live reporting
// ═════════════════════════════════════════════════════════════════════════════

test("C3: Organization team access endpoints (GET /api/team, POST /api/team, DELETE /api/team/:id)", async () => {
  const username = `org_admin_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  // GET /api/team -> initially includes the signup admin user
  const initialTeam = await getJson("/api/team", authHeader);
  assert.equal(initialTeam.status, 200);
  assert.equal(initialTeam.data.ok, true);
  assert.ok(Array.isArray(initialTeam.data.members));
  assert.equal(initialTeam.data.members.length, 1);
  assert.equal(initialTeam.data.members[0].username, username);

  // POST /api/team -> invite/create team member
  const memberUser = `colleague_${Date.now()}`;
  const memberPass = "ColleaguePass123!";
  const addMember = await postJson(
    "/api/team",
    { username: memberUser, password: memberPass, name: "Colleague Linus" },
    authHeader
  );
  assert.ok(addMember.status === 200 || addMember.status === 201);
  assert.equal(addMember.data.ok, true);
  assert.equal(addMember.data.member.username, memberUser);
  const createdMemberId = addMember.data.member.id;

  // Verify list has 2 members now
  const updatedTeam = await getJson("/api/team", authHeader);
  assert.equal(updatedTeam.data.members.length, 2);
  const found = updatedTeam.data.members.find((m) => m.username === memberUser);
  assert.ok(found);
  assert.equal(found.name, "Colleague Linus");

  // New team member can log in
  const memberLogin = await postJson("/login", { username: memberUser, password: memberPass });
  assert.equal(memberLogin.status, 200);
  assert.equal(memberLogin.data.ok, true);
  const memberAuth = { Authorization: `Bearer ${memberLogin.token}` };

  // Authorization check: non-admin member cannot add new team members (403)
  const nonAdminAdd = await postJson(
    "/api/team",
    { username: `sub_member_${Date.now()}`, password: "SubPass123!" },
    memberAuth
  );
  assert.equal(nonAdminAdd.status, 403);
  assert.equal(nonAdminAdd.data.ok, false);
  assert.ok(nonAdminAdd.data.error.includes("admin or operator authority required"));

  // Authorization check: non-admin member cannot delete other members (403)
  const adminPrincipalId = initialTeam.data.members[0].id;
  const nonAdminRemove = await deleteJson(`/api/team/${adminPrincipalId}`, memberAuth);
  assert.equal(nonAdminRemove.status, 403);
  assert.equal(nonAdminRemove.data.ok, false);
  assert.ok(nonAdminRemove.data.error.includes("admin or operator authority required"));

  // Authorization check: cannot remove yourself from team (400)
  const selfRemove = await deleteJson(`/api/team/${adminPrincipalId}`, authHeader);
  assert.equal(selfRemove.status, 400);
  assert.equal(selfRemove.data.ok, false);

  // DELETE /api/team/:id -> admin removes member
  const removeRes = await deleteJson(`/api/team/${createdMemberId}`, authHeader);
  assert.equal(removeRes.status, 200);
  assert.equal(removeRes.data.ok, true);

  // Verify list is back to 1 member
  const afterRemove = await getJson("/api/team", authHeader);
  assert.equal(afterRemove.data.members.length, 1);
  assert.ok(!afterRemove.data.members.some((m) => m.id === createdMemberId));

  // Deleted member can no longer log in
  const deletedLogin = await postJson("/login", { username: memberUser, password: memberPass });
  assert.equal(deletedLogin.status, 401);

  // Safety check: cannot remove the last human member of a team
  const { removeTeamMember, getPrincipal } = await import("../packages/control-db/src/registry.js");
  const lastPrincipal = getPrincipal(afterRemove.data.members[0].id);
  assert.throws(
    () => removeTeamMember(lastPrincipal.tenant_id, lastPrincipal.id),
    /cannot remove the last member of a team/
  );
});

test("C3: Vanity domain management, resolution, and request routing", async () => {
  const username = `vanity_owner_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };
  const userSlug = signup.data.slug;

  const vanityDomain = `client-app-${Date.now().toString(36)}.example.com`;

  // Set vanity domain via POST /api/sandboxes/:slug/domain
  const setDom = await postJson(
    `/api/sandboxes/${userSlug}/domain`,
    { domain: vanityDomain },
    authHeader
  );
  assert.equal(setDom.status, 200);
  assert.equal(setDom.data.ok, true);
  assert.equal(setDom.data.vanityDomain, vanityDomain);

  // Duplicate vanity domain assignment is rejected with 409
  // Create another tenant to try stealing this vanity domain
  const user2 = await postJson("/signup", { username: `user2_${Date.now()}`, password: "ValidPassword123!" });
  const auth2 = { Authorization: `Bearer ${user2.token}` };
  const dupeDom = await postJson(
    `/api/sandboxes/${user2.data.slug}/domain`,
    { domain: vanityDomain },
    auth2
  );
  assert.equal(dupeDom.status, 409);
  assert.equal(dupeDom.data.ok, false);
  assert.ok(dupeDom.data.error.includes("already in use"));

  // Domain resolution via GET /api/resolve?domain=...
  const resolveHit = await getJson(`/api/resolve?domain=${vanityDomain}`);
  assert.equal(resolveHit.status, 200);
  assert.equal(resolveHit.data.ok, true);
  assert.equal(resolveHit.data.slug, userSlug);
  // Unauthenticated resolve must not leak internal database IDs
  assert.equal(resolveHit.data.sandboxId, undefined);
  assert.equal(resolveHit.data.tenantId, undefined);

  const resolveMiss = await getJson(`/api/resolve?domain=unknown-non-existent.example.com`);
  assert.equal(resolveMiss.status, 404);
  assert.equal(resolveMiss.data.ok, false);

  // Vanity Host routing: sending Host: <vanityDomain> to the gateway
  // Requesting /mcp on vanity host routes directly into userSlug. fetch will not
  // send a Host of our choosing, so the test stands in for a trusted proxy —
  // which is also the only time X-Forwarded-Host is believed.
  const unrouted = await postJson(
    "/mcp",
    { server: "proc", tool: "exec", args: { cmd: "echo no" } },
    { ...authHeader, "X-Forwarded-Host": vanityDomain }
  );
  assert.notEqual(unrouted.status, 200, "without a trusted proxy, X-Forwarded-Host routes nothing");
  process.env.SANDBOXOS_TRUST_PROXY = "1";
  try {
  const mcpOnVanity = await postJson(
    "/mcp",
    { server: "proc", tool: "exec", args: { cmd: "echo routed-via-vanity-host" } },
    { ...authHeader, Host: vanityDomain, "X-Forwarded-Host": vanityDomain }
  );
  assert.equal(mcpOnVanity.status, 200);
  assert.equal(mcpOnVanity.data.ok, true);
  assert.ok(mcpOnVanity.data.result.stdout.includes("routed-via-vanity-host"));

  // Subdomain Host routing: test with configured SANDBOXOS_DOMAIN
  process.env.SANDBOXOS_DOMAIN = "sandbox.local";
  const subHost = `${userSlug}.sandbox.local`;
  const mcpOnSub = await postJson(
    "/mcp",
    { server: "proc", tool: "exec", args: { cmd: "echo routed-via-subdomain" } },
    { ...authHeader, Host: subHost, "X-Forwarded-Host": subHost }
  );
  assert.equal(mcpOnSub.status, 200);
  assert.equal(mcpOnSub.data.ok, true);
  assert.ok(mcpOnSub.data.result.stdout.includes("routed-via-subdomain"));

  // Global endpoints (/health, /api/quota, /signup) remain unhijacked when requested under Host
  const healthOnSub = await getJson("/health", { Host: subHost, "X-Forwarded-Host": subHost });
  assert.equal(healthOnSub.status, 200);
  assert.equal(healthOnSub.data.ok, true);
  } finally {
    delete process.env.SANDBOXOS_DOMAIN;
    delete process.env.SANDBOXOS_TRUST_PROXY;
  }
});

test("C3: Live usage reporting in GET /api/stats and GET /api/quota", async () => {
  const username = `stats_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  const statsRes = await getJson("/api/stats", authHeader);
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.data.ok, true);
  assert.equal(statsRes.data.sandboxes, 1);
  assert.ok(typeof statsRes.data.runningSandboxes === "number");
  assert.ok(typeof statsRes.data.runningAgents === "number");
  assert.ok(typeof statsRes.data.agents === "object");
  assert.ok(typeof statsRes.data.quota === "object");
  assert.equal(statsRes.data.quota.maxSandboxes, 3);
  assert.equal(statsRes.data.quota.maxAgents, 10);
});

test("C2: Quota door validation rejects invalid parameter values with 400 naming the invalid field", async () => {
  const username = `quota_val_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };

  const badCases = [
    { payload: { maxSandboxes: -1 }, field: "maxSandboxes" },
    { payload: { maxSandboxes: "five" }, field: "maxSandboxes" },
    { payload: { maxSandboxes: 2.5 }, field: "maxSandboxes" },
    { payload: { maxAgents: -1 }, field: "maxAgents" },
    { payload: { maxAgents: "ten" }, field: "maxAgents" },
    { payload: { maxAgents: 1.2 }, field: "maxAgents" },
    { payload: { maxRunning: -3 }, field: "maxRunning" },
    { payload: { maxRunning: "three" }, field: "maxRunning" },
    { payload: { memMb: -512 }, field: "memMb" },
    { payload: { memMb: "2048mb" }, field: "memMb" },
    { payload: { memMb: 1024.5 }, field: "memMb" },
    { payload: { cpuShares: -0.5 }, field: "cpuShares" },
    { payload: { cpuShares: "high" }, field: "cpuShares" },
    { payload: { maxDiskMb: -100 }, field: "maxDiskMb" },
    { payload: { maxDiskMb: "5gb" }, field: "maxDiskMb" },
    { payload: { networkEgress: "unrestricted" }, field: "networkEgress" },
    { payload: { networkEgress: 123 }, field: "networkEgress" },
  ];

  for (const { payload, field } of badCases) {
    const res = await postJson("/api/quota", payload, authHeader);
    assert.equal(res.status, 400, `Expected 400 for bad ${field}: ${JSON.stringify(payload)}`);
    assert.equal(res.data.ok, false);
    assert.ok(
      res.data.error.toLowerCase().includes(field.toLowerCase()),
      `Expected error message to mention '${field}', got: '${res.data.error}'`
    );
  }

  // Valid inputs should succeed
  const validRes = await postJson(
    "/api/quota",
    { maxSandboxes: 4, maxAgents: 2, maxRunning: 1, memMb: 1024, cpuShares: 0.5, maxDiskMb: 4096, networkEgress: "deny" },
    authHeader
  );
  assert.equal(validRes.status, 200);
  assert.equal(validRes.data.ok, true);
  assert.equal(validRes.data.quota.max_sandboxes, 4);
  assert.equal(validRes.data.quota.cpu_shares, 0.5);
  assert.equal(validRes.data.quota.network_egress, "deny");
});

test("C3: Vanity domain door validation rejects invalid domains with 400 and duplicate domains with 409", async () => {
  const username = `domain_val_user_${Date.now()}`;
  const password = "ValidPassword123!";
  const signup = await postJson("/signup", { username, password });
  const authHeader = { Authorization: `Bearer ${signup.token}` };
  const userSlug = signup.data.slug;

  process.env.SANDBOXOS_DOMAIN = "sbx.test";

  const invalidDomains = [
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "::1",
    "2001:db8::1",
    "sbx.test",           // Collision with configured domain
    "foo.sbx.test",       // Subdomain of configured domain
    "no-dot",             // Missing dot
    "-start-hyphen.com",  // Label starts with hyphen
    "end-hyphen-.com",    // Label ends with hyphen
    "bad..dot.com",       // Consecutive dots
    "invalid_char.com",   // Underscore not allowed in hostname
    "a".repeat(250) + ".com", // Exceeds 253 characters
  ];

  // Test invalid domains via POST /api/sandboxes/:slug/domain
  for (const domain of invalidDomains) {
    const res = await postJson(`/api/sandboxes/${userSlug}/domain`, { domain }, authHeader);
    assert.equal(res.status, 400, `Expected 400 for invalid domain '${domain}', got ${res.status}`);
    assert.equal(res.data.ok, false);
    assert.ok(res.data.error.includes("invalid domain"));
  }

  // Test invalid domain via POST /api/sandboxes on creation
  const createInvalidRes = await postJson(
    "/api/sandboxes",
    { slug: `sb-inv-${Date.now().toString(36)}`, vanityDomain: "invalid_domain.org" },
    authHeader
  );
  assert.equal(createInvalidRes.status, 400);
  assert.equal(createInvalidRes.data.ok, false);

  // Set a valid vanity domain
  const validDomain = `good-app-${Date.now().toString(36)}.example.com`;
  const setValidRes = await postJson(`/api/sandboxes/${userSlug}/domain`, { domain: validDomain }, authHeader);
  assert.equal(setValidRes.status, 200);
  assert.equal(setValidRes.data.ok, true);

  // Attempting to create a new sandbox with the same vanity domain returns 409
  const createDupeRes = await postJson(
    "/api/sandboxes",
    { slug: `sb-dupe-${Date.now().toString(36)}`, vanityDomain: validDomain },
    authHeader
  );
  assert.equal(createDupeRes.status, 409);
  assert.equal(createDupeRes.data.ok, false);
  assert.ok(createDupeRes.data.error.includes("already in use"));

  delete process.env.SANDBOXOS_DOMAIN;
});

test("C1: Profile update rejects duplicate tenant name with 409", async () => {
  const user1 = `tenant_one_${Date.now()}`;
  const pass = "ValidPassword123!";
  const signup1 = await postJson("/signup", { username: user1, password: pass });
  assert.equal(signup1.status, 200);

  const user2 = `tenant_two_${Date.now()}`;
  const signup2 = await postJson("/signup", { username: user2, password: pass });
  assert.equal(signup2.status, 200);
  const auth2 = { Authorization: `Bearer ${signup2.token}` };

  // User 2 attempts to rename their tenant to User 1's tenant name
  const renameRes = await postJson(
    "/api/profile",
    { tenantName: user1 },
    auth2
  );
  assert.equal(renameRes.status, 409, `Expected 409 on duplicate tenant name, got ${renameRes.status}`);
  assert.equal(renameRes.data.ok, false);
  assert.ok(renameRes.data.error.includes("already in use"));
});

// ── review follow-ups: a member is not the tenant, and a name is not an identity ──

test("a team member without admin authority cannot administer the organization", async () => {
  const admin = await postJson("/signup", { username: `boss_${Date.now()}`, password: "ValidPassword123!" });
  const adminAuth = { Authorization: `Bearer ${admin.token}` };
  const memberUser = `hand_${Date.now()}`;
  const added = await postJson("/api/team", { username: memberUser, password: "MemberPass123!" }, adminAuth);
  assert.equal(added.status, 201);
  const member = await postJson("/login", { username: memberUser, password: "MemberPass123!" });
  const memberAuth = { Authorization: `Bearer ${member.token}` };

  const second = await postJson("/api/sandboxes", { slug: `spare-${Date.now().toString(36)}` }, adminAuth);
  assert.equal(second.status, 200);

  const quota = await postJson("/api/quota", { maxRunning: 0 }, memberAuth);
  assert.equal(quota.status, 403, "a member cannot rewrite the tenant's quota");
  const rename = await postJson("/api/profile", { tenantName: `taken-over-${Date.now()}` }, memberAuth);
  assert.equal(rename.status, 403, "a member cannot rename the tenant");
  const domain = await postJson(`/api/sandboxes/${admin.data.slug}/domain`, { domain: `m-${Date.now()}.example.com` }, memberAuth);
  assert.equal(domain.status, 403, "a member cannot point a domain at the tenant's Sandbox");
  const del = await deleteJson(`/api/sandboxes/${second.data.slug}`, memberAuth);
  assert.equal(del.status, 403, "a member cannot delete a Sandbox they hold nothing on");

  assert.equal((await postJson("/api/quota", { maxRunning: 3 }, adminAuth)).status, 200, "the admin still can");
  const weak = await postJson("/api/team", { username: `w_${Date.now()}`, password: "x" }, adminAuth);
  assert.equal(weak.status, 400, "a team member's password is held to the signup minimum");
});

test("a member who has used the product can still be removed", async () => {
  const { createConversation, getSandboxBySlug } = await import("../packages/control-db/src/registry.js");
  const admin = await postJson("/signup", { username: `lead_${Date.now()}`, password: "ValidPassword123!" });
  const adminAuth = { Authorization: `Bearer ${admin.token}` };
  const added = await postJson("/api/team", { username: `leaver_${Date.now()}`, password: "MemberPass123!" }, adminAuth);
  const sb = getSandboxBySlug(admin.data.slug);
  createConversation(sb.id, added.data.member.id, "notes");
  const removed = await deleteJson(`/api/team/${added.data.member.id}`, adminAuth);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
});

test("renaming a tenant to the seed tenant's name does not make it the operator", async () => {
  const { config } = await import("../packages/config/src/config.js");
  const { ensureSeed: seed, updateTenantName, getTenant, isOperator, getPrincipal } = await import("../packages/control-db/src/registry.js");
  const { tenant: seedTenant, owner: seedOwner } = seed("local");
  const attacker = await postJson("/signup", { username: `mallory_${Date.now()}`, password: "ValidPassword123!" });
  const attackerAuth = { Authorization: `Bearer ${attacker.token}` };
  const team = await getJson("/api/team", attackerAuth);
  const attackerId = team.data.members[0].id;

  // The seed tenant's admin renames it, freeing the name…
  const original = getTenant(seedTenant.id).name;
  updateTenantName(seedTenant.id, `renamed-${Date.now()}`);
  try {
    // …and the name still cannot be taken, nor would taking it matter.
    const grab = await postJson("/api/profile", { tenantName: config.seed.tenantName }, attackerAuth);
    assert.equal(grab.status, 409);
    const again = seed("local");
    assert.equal(again.owner.id, seedOwner.id, "the seed owner is found by the seed Sandbox, not by a name");
    assert.equal(isOperator(attackerId), false);
    assert.equal(getPrincipal(attackerId).tenant_id !== seedTenant.id, true);
  } finally {
    updateTenantName(seedTenant.id, original);
  }
});

test("a tenant cannot claim the gateway's own hostname as a vanity domain", async () => {
  const user = await postJson("/signup", { username: `squat_${Date.now()}`, password: "ValidPassword123!" });
  const auth = { Authorization: `Bearer ${user.token}` };
  process.env.SANDBOXOS_PUBLIC_HOSTS = "os.example.org";
  try {
    const res = await postJson(`/api/sandboxes/${user.data.slug}/domain`, { domain: "os.example.org" }, auth);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /gateway itself/);
  } finally {
    delete process.env.SANDBOXOS_PUBLIC_HOSTS;
  }
});
