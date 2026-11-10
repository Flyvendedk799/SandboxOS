// Task tests: Production CLI and Client SDK Developer Tooling
//
// Explicitly validates Acceptance Criteria C1, C2, and C3:
// C1: `sbx` CLI executes all core commands (login, run, proc, port, os, fs, ask) with binary-safe streaming and clean output.
// C2: `SandboxClient` SDK provides complete tool wrappers and throws structured `SandboxError` instances with meaningful error codes and remediation notes.
// C3: CLI and SDK production developer tooling: complete command routing, machine token authentication, binary-safe file streaming, and structured SandboxError responses.

import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken, createTenant, createAccount } from "../packages/control-db/src/registry.js";
import { _resetKernels } from "../packages/kernel/src/kernel.js";
import { attachSession, killAllSessions } from "../packages/kernel/src/pty-sessions.js";
import { stopAllProcs } from "../packages/kernel/src/servers/proc.js";
import { getCell } from "../packages/cell/src/cell.js";
import { createServer } from "../apps/gateway/src/server.js";
import { SandboxClient, SandboxError } from "../packages/sdk/src/index.js";
import { stubProvider } from "./fixtures/stub-provider.js";

const SBX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/sbx-cli/src/sbx.js");

let owner, sandbox, server, base, sbx, token, cliConfig;

function runSbx(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SBX, ...args], {
      env: { ...process.env, SBX_CONFIG: cliConfig },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({
      code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    }));

    if (input != null) {
      child.stdin.end(input);
    }
  });
}

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "developer-tooling-test" }).token;
  sbx = new SandboxClient({ url: base, slug: sandbox.slug, token });

  cliConfig = path.join(os.tmpdir(), `sbx-cli-task-${Date.now()}.json`);
  fs.writeFileSync(cliConfig, JSON.stringify({ url: base, slug: sandbox.slug, token }));
});

test.after(() => {
  try { fs.unlinkSync(cliConfig); } catch { /* ignore */ }
  killAllSessions(sandbox.id);
  stopAllProcs(sandbox.id);
  server.close();
  _resetKernels();
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// C2: SandboxClient tool wrappers and structured SandboxError
// ─────────────────────────────────────────────────────────────────────────────

test("C2: SandboxError carries structured code, server, tool, status, remediation, and toJSON", async () => {
  const err = new SandboxError("denied: proc.exec", {
    status: 403,
    server: "proc",
    tool: "exec",
    code: "denied",
  });

  assert.equal(err.name, "SandboxError");
  assert.equal(err.code, "denied");
  assert.equal(err.server, "proc");
  assert.equal(err.tool, "exec");
  assert.equal(err.status, 403);
  assert.ok(typeof err.remediation === "string" && err.remediation.length > 0);
  assert.match(err.remediation, /token|capability/i);

  const json = err.toJSON();
  assert.equal(json.name, "SandboxError");
  assert.equal(json.code, "denied");
  assert.equal(json.server, "proc");
  assert.equal(json.tool, "exec");
  assert.equal(json.remediation, err.remediation);

  // Auto-derivation of code and remediation from server/tool/status
  const unknownToolErr = new SandboxError("unknown tool: custom.doSomething", {
    server: "custom",
    tool: "doSomething",
    status: 400,
  });
  assert.equal(unknownToolErr.code, "unknown_tool");
  assert.match(unknownToolErr.remediation, /tools/i);

  const notFoundErr = new SandboxError("file not found", {
    server: "fs",
    tool: "read",
    status: 404,
  });
  assert.equal(notFoundErr.code, "not_found");
  assert.match(notFoundErr.remediation, /path|exists/i);
});

test("C2: SandboxClient tool wrappers across fs, proc, ports, agents, desktop, tokens", async () => {
  // fs wrappers
  await sbx.fs.write("tool-test/a.txt", "content a");
  const stat = await sbx.fs.stat("tool-test/a.txt");
  assert.equal(stat.path, "tool-test/a.txt");
  assert.equal(stat.type, "file");
  assert.equal(stat.size, 9);

  await sbx.fs.cp("tool-test/a.txt", "tool-test/b.txt");
  assert.equal(await sbx.fs.read("tool-test/b.txt"), "content a");

  await sbx.fs.mv("tool-test/b.txt", "tool-test/c.txt");
  assert.equal(await sbx.fs.read("tool-test/c.txt"), "content a");

  const rawBytes = new Uint8Array([10, 20, 30, 40]);
  await sbx.fs.writeBytes("tool-test/raw.bin", rawBytes);
  const backBytes = await sbx.fs.readBytes("tool-test/raw.bin");
  assert.deepEqual(Array.from(backBytes), [10, 20, 30, 40]);

  // proc wrappers
  const job = await sbx.proc.start("echo hello-wrapper", { name: "wrapper-proc" });
  assert.equal(job.name, "wrapper-proc");
  const waited = await sbx.proc.wait(job.id, { intervalMs: 50, timeoutMs: 10_000 });
  assert.equal(waited.state, "exited");

  const forgetRes = await sbx.proc.forget(job.id);
  assert.equal(forgetRes.forgotten, true);

  const sessions = await sbx.proc.sessions();
  assert.ok(Array.isArray(sessions));

  // ports wrappers
  const scanRes = await sbx.ports.scan();
  assert.ok(Array.isArray(scanRes));

  await sbx.ports.expose(7123, "wrapper-port");
  const checkRes = await sbx.ports.check(7123);
  assert.equal(checkRes.port, 7123);
  await sbx.ports.unexpose(7123);

  // desktop wrappers
  const deskState = await sbx.desktop.get();
  assert.ok(deskState.doc);

  const cpRes = await sbx.desktop.checkpoint("test-sdk-cp");
  assert.ok(cpRes.checkpoint);
  const cps = await sbx.desktop.checkpoints();
  assert.ok(cps.checkpoints.length >= 1);

  // tokens wrappers
  const minted = await sbx.tokens.mint(["fs.read"], { label: "narrow-wrapper" });
  assert.ok(minted.token);
  const tokensList = await sbx.tokens.list();
  const found = tokensList.find((t) => t.label?.includes("narrow-wrapper") || (t.patterns && t.patterns.includes("fs.read")));
  assert.ok(found);
  const revoked = await sbx.tokens.revoke(found.principalId);
  assert.equal(revoked.ok, true);

  // cleanup test folder
  await sbx.fs.rm("tool-test", { recursive: true });
});

test("C2: Structured SandboxError on capability denial with actionable remediation", async () => {
  const narrowToken = mintMachineToken(owner.id, sandbox.id, ["fs.read"], { label: "readonly" }).token;
  const narrowClient = new SandboxClient({ url: base, slug: sandbox.slug, token: narrowToken });

  let caught = null;
  try {
    await narrowClient.proc.exec("echo denied");
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof SandboxError);
  assert.equal(caught.code, "denied");
  assert.equal(caught.server, "proc");
  assert.equal(caught.tool, "exec");
  assert.ok(caught.remediation.includes("token"));
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 & C3: sbx CLI core commands, binary-safe streaming, token authentication
// ─────────────────────────────────────────────────────────────────────────────

test("C1 & C3: sbx login with machine token directly sets up config", async () => {
  const customConfig = path.join(os.tmpdir(), `sbx-custom-${Date.now()}.json`);
  try {
    const testToken = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "direct-token-login" }).token;
    const r = await new Promise((resolve) => {
      execFile(process.execPath, [SBX, "login", "--url", base, "--slug", sandbox.slug, "--token", testToken], {
        env: { ...process.env, SBX_CONFIG: customConfig },
        timeout: 10_000,
      }, (err, stdout, stderr) => resolve({
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      }));
    });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /logged in/);

    const saved = JSON.parse(fs.readFileSync(customConfig, "utf8"));
    assert.equal(saved.token, testToken);
    assert.equal(saved.slug, sandbox.slug);
    assert.equal(saved.url, base);

    // Bad token is rejected and exits non-zero without writing config
    const badConfig = path.join(os.tmpdir(), `sbx-bad-${Date.now()}.json`);
    try {
      const badRes = await new Promise((resolve) => {
        execFile(process.execPath, [SBX, "login", "--url", base, "--slug", sandbox.slug, "--token", "invalid-token-12345"], {
          env: { ...process.env, SBX_CONFIG: badConfig },
          timeout: 10_000,
        }, (err, stdout, stderr) => resolve({
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        }));
      });
      assert.notEqual(badRes.code, 0, "login with invalid token must fail");
      assert.equal(fs.existsSync(badConfig), false, "config file must not be created on failed login");
    } finally {
      try { fs.unlinkSync(badConfig); } catch {}
    }
  } finally {
    try { fs.unlinkSync(customConfig); } catch {}
  }
});

test("C1 & C3: sbx token list, mint, and revoke commands", async () => {
  // Mint a narrower token
  const mintRes = await runSbx(["token", "--patterns", "fs.read,fs.list", "--label", "cli-test-token"]);
  assert.equal(mintRes.code, 0, mintRes.stderr);
  assert.match(mintRes.stderr, /scope: fs\.read, fs\.list/);
  const mintedTokenString = mintRes.stdout.trim();

  // List tokens
  const listRes = await runSbx(["token", "list"]);
  assert.equal(listRes.code, 0, listRes.stderr);
  assert.match(listRes.stdout, /cli-test-token/);

  // Extract principalId directly from token list output
  const tokenLine = listRes.stdout.split("\n").find((l) => l.includes("cli-test-token"));
  assert.ok(tokenLine, "token must appear in token list");
  const principalId = tokenLine.trim().split(/\s+/)[0];
  assert.ok(principalId, "token list must output principalId in first column");

  // Revoke token via principalId
  const revokeRes = await runSbx(["token", "revoke", principalId]);
  assert.equal(revokeRes.code, 0, revokeRes.stderr);
  assert.match(revokeRes.stdout, /revoked token/);

  // Calling the Gateway with the revoked token must be rejected (401 / denied)
  const revokedClient = new SandboxClient({ url: base, slug: sandbox.slug, token: mintedTokenString });
  let revokedErr = null;
  try {
    await revokedClient.proc.exec("echo should-fail");
  } catch (err) {
    revokedErr = err;
  }
  assert.ok(revokedErr instanceof SandboxError, "revoked token request must throw SandboxError");
  assert.equal(revokedErr.status, 401, "revoked token request must be refused with HTTP 401");

  // Ambiguous revoke by shared prefix/label must be refused with non-zero exit and candidates listed
  const dup1 = await runSbx(["token", "--patterns", "fs.read", "--label", "duplicate-cli-label"]);
  assert.equal(dup1.code, 0, dup1.stderr);
  const dup2 = await runSbx(["token", "--patterns", "fs.read", "--label", "duplicate-cli-label"]);
  assert.equal(dup2.code, 0, dup2.stderr);

  const ambigRes = await runSbx(["token", "revoke", "duplicate-cli-label"]);
  assert.notEqual(ambigRes.code, 0, "ambiguous token revocation must fail");
  assert.match(ambigRes.stderr, /ambiguous token "duplicate-cli-label" matches multiple tokens/);
});

test("C1: sbx fs commands: cp, mv, stat, and binary-safe stdio streaming with -", async () => {
  const binaryPayload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41, 0x42, 0x00]);

  // Upload binary from stdin via '-'
  const putRes = await runSbx(["fs", "put", "-", "p24-task/stdio.bin"], { input: binaryPayload });
  assert.equal(putRes.code, 0, putRes.stderr);
  assert.match(putRes.stdout, /p24-task\/stdio\.bin/);

  // Stat file
  const statRes = await runSbx(["fs", "stat", "p24-task/stdio.bin"]);
  assert.equal(statRes.code, 0, statRes.stderr);
  assert.match(statRes.stdout, /file/);
  assert.match(statRes.stdout, /7 B/);

  // Copy file
  const cpRes = await runSbx(["fs", "cp", "p24-task/stdio.bin", "p24-task/stdio-cp.bin"]);
  assert.equal(cpRes.code, 0, cpRes.stderr);
  assert.match(cpRes.stdout, /copied/);

  // Move file
  const mvRes = await runSbx(["fs", "mv", "p24-task/stdio-cp.bin", "p24-task/stdio-mv.bin"]);
  assert.equal(mvRes.code, 0, mvRes.stderr);
  assert.match(mvRes.stdout, /moved/);

  // Download binary to stdout via '-'
  const getChild = execFile(process.execPath, [SBX, "fs", "get", "p24-task/stdio-mv.bin", "-"], {
    env: { ...process.env, SBX_CONFIG: cliConfig },
    encoding: "buffer",
    timeout: 10_000,
  });

  const downloadedChunks = [];
  getChild.stdout.on("data", (chunk) => downloadedChunks.push(chunk));
  const exitCode = await new Promise((resolve) => getChild.on("close", resolve));
  assert.equal(exitCode, 0);

  const downloadedBuf = Buffer.concat(downloadedChunks);
  assert.deepEqual(Array.from(downloadedBuf), Array.from(binaryPayload));

  // Clean up
  await runSbx(["fs", "rm", "p24-task", "-r"]);

  // Argument order flexibility: rm with flag before path
  await sbx.fs.write("p24-task-flag/file.txt", "data");
  const rmFlagFirstRes = await runSbx(["fs", "rm", "-r", "p24-task-flag"]);
  assert.equal(rmFlagFirstRes.code, 0, rmFlagFirstRes.stderr);
  assert.match(rmFlagFirstRes.stdout, /removed p24-task-flag/);
});

test("C1: sbx proc commands: start, logs, stop, forget, sessions", async () => {
  const startRes = await runSbx(["proc", "start", "echo testing-sbx-proc", "--name", "quick-proc"]);
  assert.equal(startRes.code, 0, startRes.stderr);
  const id = startRes.stdout.trim().split(/\s+/)[0];

  // Wait for finish
  await sbx.proc.wait(id, { intervalMs: 50, timeoutMs: 10_000 });

  const logsRes = await runSbx(["proc", "logs", id]);
  assert.equal(logsRes.code, 0, logsRes.stderr);
  assert.match(logsRes.stdout, /testing-sbx-proc/);

  const forgetRes = await runSbx(["proc", "forget", id]);
  assert.equal(forgetRes.code, 0, forgetRes.stderr);
  assert.match(forgetRes.stdout, /forgotten/);

  // Attach a session so proc sessions output displays active session details
  const cell = getCell(sandbox);
  const activeSession = attachSession(cell, sandbox.id, { name: "cli-test-session" }, () => {}, () => {});
  try {
    const sessionsRes = await runSbx(["proc", "sessions"]);
    assert.equal(sessionsRes.code, 0, sessionsRes.stderr);
    assert.match(sessionsRes.stdout, new RegExp(activeSession.id));
    assert.match(sessionsRes.stdout, /cli-test-session/);
    assert.match(sessionsRes.stdout, /alive/);
    assert.match(sessionsRes.stdout, /attached:1/);
  } finally {
    activeSession.kill();
  }
});

test("C1: sbx port commands: expose, check, scan, close", async () => {
  const exposeRes = await runSbx(["port", "expose", "6321", "test-svc"]);
  assert.equal(exposeRes.code, 0, exposeRes.stderr);

  const checkRes = await runSbx(["port", "check", "6321"]);
  assert.equal(checkRes.code, 0, checkRes.stderr);
  assert.match(checkRes.stdout, /port 6321:/);

  const scanRes = await runSbx(["port", "scan"]);
  assert.equal(scanRes.code, 0, scanRes.stderr);

  const closeRes = await runSbx(["port", "close", "6321"]);
  assert.equal(closeRes.code, 0, closeRes.stderr);
  assert.match(closeRes.stdout, /closed :6321/);
});

test("C1: sbx os commands: show, checkpoint, checkpoints, arrange", async () => {
  const showRes = await runSbx(["os", "show"]);
  assert.equal(showRes.code, 0, showRes.stderr);
  assert.match(showRes.stdout, /workspaces/);

  const arrangeRes = await runSbx(["os", "arrange", "grid"]);
  assert.equal(arrangeRes.code, 0, arrangeRes.stderr);
  assert.match(arrangeRes.stdout, /arranged: grid/);

  const cpRes = await runSbx(["os", "checkpoint", "cli-test-checkpoint"]);
  assert.equal(cpRes.code, 0, cpRes.stderr);
  assert.match(cpRes.stdout, /checkpoint created:/);

  const cpsRes = await runSbx(["os", "checkpoints"]);
  assert.equal(cpsRes.code, 0, cpsRes.stderr);
  assert.match(cpsRes.stdout, /cli-test-checkpoint/);
});

test("C1: sbx run, stream, and ask core commands execute cleanly", async () => {
  // run
  const runRes = await runSbx(["run", "echo 'hello from run'"]);
  assert.equal(runRes.code, 0, runRes.stderr);
  assert.match(runRes.stdout, /hello from run/);

  // stream
  const streamRes = await runSbx(["stream", "echo 'streaming line 1'; echo 'streaming line 2'"]);
  assert.equal(streamRes.code, 0, streamRes.stderr);
  assert.match(streamRes.stdout, /streaming line 1/);
  assert.match(streamRes.stdout, /streaming line 2/);

  // ask
  process.env.ANTHROPIC_API_KEY = "test-key";
  const stub = stubProvider([
    { tools: [{ name: "fs__list", args: { path: "." } }] },
    { text: "Developer tooling is functioning properly." },
  ]);
  const url = await stub.listen();
  try {
    process.env.SANDBOXOS_ANTHROPIC_URL = url;
    const askRes = await runSbx(["ask", "verify status"]);
    assert.equal(askRes.code, 0, askRes.stderr);
    assert.match(askRes.stdout, /Developer tooling is functioning properly\./);
  } finally {
    stub.close();
    delete process.env.SANDBOXOS_ANTHROPIC_URL;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("C1 & C3: sbx access revoke safeguards against ambiguity and encodes parameters", async () => {
  const tenant = createTenant(`access-tenant-${Date.now()}`);
  createAccount(tenant.id, { username: "user_alpha", password: "pw" });
  createAccount(tenant.id, { username: "user_alpha_beta", password: "pw" });

  const share1 = await runSbx(["access", "share", "user_alpha", "--patterns", "fs.read"]);
  assert.equal(share1.code, 0, share1.stderr);
  const share2 = await runSbx(["access", "share", "user_alpha_beta", "--patterns", "fs.read"]);
  assert.equal(share2.code, 0, share2.stderr);

  // Ambiguous prefix matches multiple entries
  const ambigAccess = await runSbx(["access", "revoke", "user_al"]);
  assert.notEqual(ambigAccess.code, 0, "ambiguous access revoke must fail");
  assert.match(ambigAccess.stderr, /ambiguous access identifier "user_al" matches multiple entries/);

  // Exact match succeeds
  const exactRevoke = await runSbx(["access", "revoke", "user_alpha"]);
  assert.equal(exactRevoke.code, 0, exactRevoke.stderr);
  assert.match(exactRevoke.stdout, /revoked user_alpha/);

  // Clean up remaining
  const exactRevoke2 = await runSbx(["access", "revoke", "user_alpha_beta"]);
  assert.equal(exactRevoke2.code, 0, exactRevoke2.stderr);
});

test("C2 & C3: SandboxClient encodes dynamic URL paths", async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method });
    return new Response(JSON.stringify({ ok: true, deleted: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const testClient = new SandboxClient({ url: "http://127.0.0.1:9999", slug: "test-sbx", fetch: mockFetch });

  await testClient.sandboxes.delete("test/unsafe slug");
  assert.ok(calls.some((c) => c.url.includes("/api/sandboxes/test%2Funsafe%20slug") && c.method === "DELETE"));

  await testClient.access.revoke("user@domain.com/id#1");
  assert.ok(calls.some((c) => c.url.includes("/access/user%40domain.com%2Fid%231") && c.method === "DELETE"));

  await testClient.tokens.revoke("token/id#1");
  assert.ok(calls.some((c) => c.url.includes("/tokens/token%2Fid%231") && c.method === "DELETE"));

  await testClient.assistant.remove("chat/id#1");
  assert.ok(calls.some((c) => c.url.includes("/chats/chat%2Fid%231") && c.method === "DELETE"));
});
