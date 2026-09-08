// Phase 31: it cannot break.
//
// Track 0 of goal.md. Four properties, each of which used to be false:
//
//   1. A child that cannot start fails the call, not the host process.
//   2. A command that never ran says so, instead of reporting empty output.
//   3. A malformed call at the door is a sentence about a field, never a
//      sentence about SQLite.
//   4. A window move costs one document write and no stylesheet bytes, and a
//      stream that comes back after a gap catches up.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createSession, appendAudit } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { LocalBackend } from "../packages/cell/src/local-backend.js";
import { safeSpawn, detachedSpawn, execFileSafe, killTree } from "../packages/cell/src/spawn.js";
import { resolveShell, _resetShell, toShellPath, resolveNpm, hostReport } from "../packages/cell/src/shell.js";
import { themeKey } from "../packages/os/src/themes.js";
import { osHistory, osHistoryEntry, osPath, historyPath } from "../packages/os/src/store.js";

let kernel, owner, sandbox, held, srv, port, session;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  session = createSession(owner.id, "p31");
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); _resetShell(); });

const base = () => `http://127.0.0.1:${port}`;
const auth = () => ({ cookie: `sbx_session=${session}`, "content-type": "application/json" });

// ── T0.1 · the crash class ──────────────────────────────────────────────────

test("a child that cannot start reports an error instead of ending the process", async () => {
  // The bug this pins: `spawn` reports ENOENT by emitting 'error' asynchronously.
  // Unhandled, that is a fatal exception — which is how opening a Terminal on a
  // host without /bin/sh used to take down every session on the Gateway.
  const seen = await new Promise((resolve) => {
    const child = safeSpawn("sandboxos-no-such-binary-31", ["--nope"], {}, (err) => resolve(err));
    child.on("exit", () => resolve(null));
  });
  assert.ok(seen, "the error must reach the callback");
  assert.match(String(seen.code ?? seen.message), /ENOENT|EACCES|EINVAL/);
});

test("a fire-and-forget child that cannot start is silent, not fatal", async () => {
  const child = detachedSpawn("sandboxos-no-such-binary-31", []);
  assert.ok(child, "detachedSpawn returns the child it made");
  await new Promise((r) => setTimeout(r, 120)); // long enough for 'error' to fire
  assert.ok(true, "still here");
});

test("execFileSafe separates 'never ran' from 'ran and failed'", async () => {
  const missing = await execFileSafe("sandboxos-no-such-binary-31", []);
  assert.ok(missing.spawnError, "a missing binary is a spawn error");
  const sh = resolveShell();
  if (sh.ok) {
    const ran = await execFileSafe(sh.bin, sh.argv("exit 3"));
    assert.equal(ran.spawnError, null, "a command that ran has no spawn error");
    assert.equal(ran.code, 3);
  }
});

test("the Gateway installs a floor under unhandled errors", () => {
  // The entry point is what installs them; assert the contract rather than
  // re-importing a module that would boot a second Gateway inside the suite.
  const src = fs.readFileSync(new URL("../apps/gateway/src/index.js", import.meta.url), "utf8");
  assert.match(src, /process\.on\("uncaughtException"/);
  assert.match(src, /process\.on\("unhandledRejection"/);
  assert.doesNotMatch(src, /import \{ spawn \} from "node:child_process"/, "the entry point spawns through safeSpawn");
});

test("no backend spawns a child without an error listener", () => {
  const dir = new URL("../packages/cell/src/", import.meta.url);
  for (const file of ["local-backend.js", "docker-backend.js", "hardened-docker-backend.js", "firecracker-backend.js"]) {
    const src = fs.readFileSync(new URL(file, dir), "utf8");
    // `safeSpawn` / `detachedSpawn` attach one at birth; a bare `spawn(` cannot.
    const bare = src.match(/(?<![a-zA-Z])spawn\(/g) ?? [];
    assert.equal(bare.length, 0, `${file} calls spawn() directly: ${bare.length} time(s)`);
  }
});

// ── T0.2 · it runs where its owner runs it ──────────────────────────────────

test("the host's shell is resolved explicitly, and says what it cannot do", () => {
  const sh = resolveShell();
  assert.ok(sh.ok, `no shell resolved: ${sh.why}`);
  assert.ok(fs.existsSync(sh.bin), `resolved shell must exist: ${sh.bin}`);
  assert.ok(["posix", "powershell", "cmd"].includes(sh.kind));
  assert.deepEqual(sh.argv("echo hi").at(-1), "echo hi", "the command travels as one argument");
  const report = hostReport();
  assert.ok(report.notes.length >= 1, "the boot report says something about the host");
});

test("SANDBOXOS_SHELL overrides the search, and a bad one is refused honestly", () => {
  const before = process.env.SANDBOXOS_SHELL;
  try {
    process.env.SANDBOXOS_SHELL = "/definitely/not/a/shell";
    _resetShell();
    const sh = resolveShell();
    assert.equal(sh.ok, false);
    assert.match(sh.why, /SANDBOXOS_SHELL/);
  } finally {
    if (before === undefined) delete process.env.SANDBOXOS_SHELL; else process.env.SANDBOXOS_SHELL = before;
    _resetShell();
  }
});

test("a Windows path is spoken to a POSIX shell in its own dialect", () => {
  const sh = { kind: "posix" };
  const converted = toShellPath("C:\\Users\\x\\Temp", sh);
  if (process.platform === "win32") assert.equal(converted, "/c/Users/x/Temp");
  else assert.equal(converted, "C:\\Users\\x\\Temp"); // nothing to convert off Windows
});

test("npm is reachable without depending on how the platform spells it", () => {
  const npm = resolveNpm();
  assert.ok(npm.ok, npm.why);
  assert.ok(fs.existsSync(npm.bin), `npm runner must exist: ${npm.bin}`);
});

test("a real command runs, and its exit code and output come back", async () => {
  const r = await ok("proc", "exec", { cmd: "echo phase31" });
  assert.match(r.stdout, /phase31/);
  assert.equal(r.code, 0);
  const failed = await ok("proc", "exec", { cmd: "exit 7" });
  assert.equal(failed.code, 7);
});

// ── T0.3 · no silent success ────────────────────────────────────────────────

test("a host with no shell fails the call with a code and a fix, not empty output", async () => {
  const before = process.env.SANDBOXOS_SHELL;
  const cell = new LocalBackend({ id: sandbox.id, volume_path: sandbox.volume_path, name: sandbox.name });
  try {
    process.env.SANDBOXOS_SHELL = "/definitely/not/a/shell";
    _resetShell();

    const r = await cell.exec("echo hi");
    assert.equal(r.code, 127, "127 is 'command not found', which is what this is");
    assert.ok(r.failure, "the result carries the failure");
    assert.equal(r.failure.code, "unsupported_host");
    assert.match(r.stderr, /cannot run commands/);

    // Streaming says the same thing, on the same channel the caller is reading.
    const events = [];
    await new Promise((resolve) => {
      cell.execStream("echo hi", (ev) => { events.push(ev); if (ev.type === "done") resolve(); });
    });
    assert.ok(events.some((e) => e.type === "stderr" && /cannot run commands/.test(e.chunk)));
    assert.equal(events.at(-1).failure.code, "unsupported_host");

    // And an interactive session closes with an explanation rather than a blank.
    const said = [];
    await new Promise((resolve) => {
      const h = cell.execInteractive((d) => said.push(String(d)), resolve, {});
      assert.equal(typeof h.write, "function");
    });
    assert.match(said.join(""), /not an executable|no shell/, said.join(""));
  } finally {
    if (before === undefined) delete process.env.SANDBOXOS_SHELL; else process.env.SANDBOXOS_SHELL = before;
    _resetShell();
  }
});

test("proc.exec raises the failure rather than returning ok with nothing in it", async () => {
  const before = process.env.SANDBOXOS_SHELL;
  try {
    process.env.SANDBOXOS_SHELL = "/definitely/not/a/shell";
    _resetShell();
    const r = await call("proc", "exec", { cmd: "echo hi" });
    assert.equal(r.ok, false, "a command that could not start is not a successful call");
    assert.equal(r.code, "unsupported_host");
    assert.match(r.error, /cannot run commands/);
  } finally {
    if (before === undefined) delete process.env.SANDBOXOS_SHELL; else process.env.SANDBOXOS_SHELL = before;
    _resetShell();
  }
});

// ── T0.4 · validation at the door ───────────────────────────────────────────

test("a malformed MCP call is a 400 naming the field, never a database error", async () => {
  const bodies = [
    [{}, /missing field: server/],
    [{ server: "fs" }, /missing field: tool/],
    [{ server: "fs", tool: "list", args: [1, 2] }, /args must be an object/],
    [{ server: 42, tool: "list" }, /missing field: server/],
  ];
  for (const [body, expected] of bodies) {
    const res = await fetch(`${base()}/${sandbox.slug}/mcp`, { method: "POST", headers: auth(), body: JSON.stringify(body) });
    const j = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status} ${JSON.stringify(j)}`);
    assert.equal(j.code, "bad_request");
    assert.match(j.error, expected);
    assert.doesNotMatch(j.error, /SQLite|parameter/i, "a caller never reads about our database");
  }
});

test("the Kernel refuses a shapeless call before it can reach the audit log", async () => {
  for (const bad of [{ server: undefined, tool: "list" }, { server: "fs", tool: null }, { server: "fs/../etc", tool: "list" }]) {
    const r = await kernel.call({ principalId: owner.id, heldPatterns: held, ...bad });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_request", JSON.stringify(r));
  }
});

test("an audit row with missing fields is written, not thrown", () => {
  // The audit log is written on failure paths too; a binding error there would
  // replace a caller's real problem with a sentence about SQLite parameters.
  const ev = appendAudit({ sandboxId: sandbox.id, principalId: owner.id, resultKind: "error", error: "x" });
  assert.ok(ev.hash, "the chain still moves forward");
});

// ── T0.5 · cheap writes ─────────────────────────────────────────────────────

test("the theme is identified by appearance, not by revision", async () => {
  const one = { theme: { base: "midnight", tokens: {}, custom: {} }, animation: { preset: "spring", custom: {} } };
  const two = { ...one, theme: { ...one.theme, base: "aurora" } };
  assert.equal(themeKey(one), themeKey({ ...one, rev: 99, windows: [{ x: 1 }] }), "moving a window is not a new appearance");
  assert.notEqual(themeKey(one), themeKey(two), "a different theme is a different stylesheet");
});

test("theme.css revalidates by ETag and answers 304 when nothing changed", async () => {
  const url = `${base()}/${sandbox.slug}/os/theme.css`;
  const first = await fetch(url, { headers: { cookie: `sbx_session=${session}` } });
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "a stylesheet without an identity cannot be cached");
  const again = await fetch(url, { headers: { cookie: `sbx_session=${session}`, "if-none-match": etag } });
  assert.equal(again.status, 304, "the second ask costs no bytes");
});

test("moving a window does not change the stylesheet's identity", async () => {
  const before = (await ok("desktop", "state", {})).themeKey;
  const win = (await ok("desktop", "open", { app: "files" }));
  await ok("desktop", "move", { id: win.id ?? win.window?.id, x: 120, y: 90 });
  const after = await ok("desktop", "state", {});
  assert.equal(after.themeKey, before, "the appearance key survives geometry");
  await ok("desktop", "themeSet", { theme: "aurora" });
  const themed = await ok("desktop", "state", {});
  assert.notEqual(themed.themeKey, before, "…and moves when the theme does");
  await ok("desktop", "themeSet", { theme: "midnight" });
});

test("a revision costs one document on disk, not the last forty", async () => {
  const dir = path.join(path.dirname(osPath(sandbox)), "history");
  await ok("desktop", "open", { app: "notes" });
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.ok(Array.isArray(index) && index.length >= 1, "the index lists revisions");
  assert.ok(index.every((e) => typeof e.rev === "number" && !("doc" in e)), "the index holds names, not documents");
  const indexBytes = fs.statSync(path.join(dir, "index.json")).size;
  assert.ok(indexBytes < 8 * 1024, `the index stays small (${indexBytes} bytes)`);
  assert.ok(fs.existsSync(path.join(dir, `${index.at(-1).rev}.json`)), "each revision is its own file");
});

test("history still reads, reverts, and is bounded", async () => {
  const list = osHistory(sandbox);
  assert.ok(list.length >= 1);
  assert.equal(list[0].rev >= list.at(-1).rev, true, "newest first");
  const entry = osHistoryEntry(sandbox, list[0].rev);
  assert.ok(entry?.doc, "a stored revision still carries its document");
  assert.equal(osHistoryEntry(sandbox, -1), null);
  const r = await ok("desktop", "revert", { rev: list[0].rev });
  assert.ok(r.rev > 0);
});

test("an old single-file history is migrated rather than lost", async () => {
  const dir = path.dirname(osPath(sandbox));
  const legacyDocs = [
    { rev: 9001, ts: 1, label: "legacy one", doc: { version: 1, rev: 9001, name: "legacy" } },
    { rev: 9002, ts: 2, label: "legacy two", doc: { version: 1, rev: 9002, name: "legacy" } },
  ];
  fs.rmSync(path.join(dir, "history"), { recursive: true, force: true });
  fs.writeFileSync(historyPath(sandbox), JSON.stringify(legacyDocs));
  const list = osHistory(sandbox);
  assert.ok(list.some((e) => e.rev === 9002), "old revisions survive the move");
  assert.equal(osHistoryEntry(sandbox, 9001).doc.rev, 9001);
  assert.equal(fs.existsSync(historyPath(sandbox)), false, "and the old file is gone");
});

// ── T0.6 · resync ───────────────────────────────────────────────────────────

test("the event stream says where the document is, so a reconnect can catch up", async () => {
  const res = await fetch(`${base()}/${sandbox.slug}/os/events`, { headers: { cookie: `sbx_session=${session}` } });
  const reader = res.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(chunk, /event: hello/);
  const data = JSON.parse(/data: (.*)/.exec(chunk)[1]);
  assert.equal(typeof data.rev, "number", "hello carries the revision a client must match");
});

test("the client pulls when hello disagrees with what it holds", () => {
  const src = fs.readFileSync(new URL("../apps/gateway/public/js/os/client.js", import.meta.url), "utf8");
  assert.match(src, /addEventListener\("hello"/);
  assert.match(src, /if \(at != null && at !== \(os\.doc\?\.rev \?\? null\)\) loadOs\(\)/);
});

// ── the kill path, which is what "stop" means ───────────────────────────────

test("killTree ends the shell and what the shell started", async () => {
  const sh = resolveShell();
  if (!sh.ok) return;
  const p = 7_300 + Math.floor(Math.random() * 400);
  const server = `require('http').createServer((q,s)=>s.end('ok')).listen(${p},'127.0.0.1')`;
  const child = safeSpawn(sh.bin, sh.argv(`"${process.execPath}" -e "${server.replace(/"/g, '\\"')}"`),
    { detached: process.platform !== "win32" }, () => {});
  const reach = async () => fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false);
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) { up = await reach(); if (!up) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(up, `the listener never came up on :${p}`);
  killTree(child.pid, "SIGKILL", child);
  let down = false;
  for (let i = 0; i < 40 && !down; i += 1) { down = !(await reach()); if (!down) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(down, `:${p} is still served — the shell died but its child did not`);
});
