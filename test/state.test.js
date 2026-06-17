// Phase 3 Tide State: putState / getState / listStates through the Kernel and directly on Repo.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import fs from "node:fs";
import { Repo } from "../packages/tide/src/repo.js";

const tmp = () => path.join(os.tmpdir(), `state-test-${crypto.randomUUID().slice(0, 8)}`);

// ─── Repo.putState / getState / listStates (unit) ─────────────────────────────

test("Repo.putState stores a JSON state object and returns its hash", () => {
  const store = tmp();
  const repo = new Repo(store);
  repo.init("ws", tmp());
  const hash = repo.putState("ws", "env", { KEY: "VALUE", PORT: 3000 });
  assert.ok(hash, "hash returned");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64); // sha256 hex
});

test("Repo.getState round-trips arbitrary JSON", () => {
  const store = tmp();
  const repo = new Repo(store);
  repo.init("ws", tmp());
  const data = { key: "hello", nested: { arr: [1, 2, 3] } };
  repo.putState("ws", "custom", data);
  const back = repo.getState("ws", "custom");
  assert.deepEqual(back, data);
});

test("Repo.getState returns null for an unwritten type", () => {
  const store = tmp();
  const repo = new Repo(store);
  repo.init("ws", tmp());
  assert.equal(repo.getState("ws", "nonexistent"), null);
});

test("Repo.listStates reflects written types", () => {
  const store = tmp();
  const repo = new Repo(store);
  repo.init("ws", tmp());
  repo.putState("ws", "env", { A: "1" });
  repo.putState("ws", "manifest", { servers: {} });
  const types = repo.listStates("ws");
  assert.ok(types.includes("env"));
  assert.ok(types.includes("manifest"));
});

test("Repo.putState with the same type overwrites the previous value", () => {
  const store = tmp();
  const repo = new Repo(store);
  repo.init("ws", tmp());
  repo.putState("ws", "env", { old: true });
  repo.putState("ws", "env", { new: true });
  const back = repo.getState("ws", "env");
  assert.deepEqual(back, { new: true });
  assert.equal(repo.listStates("ws").filter((t) => t === "env").length, 1);
});

test("State objects survive across Repo instances (disk persistence)", () => {
  const store = tmp();
  const workdir = tmp();
  const repo1 = new Repo(store);
  repo1.init("ws", workdir);
  repo1.putState("ws", "config", { host: "localhost", port: 4000 });

  const repo2 = new Repo(store); // new instance, same store path
  const back = repo2.getState("ws", "config");
  assert.deepEqual(back, { host: "localhost", port: 4000 });
});

test("State objects coexist with marks without interference", () => {
  const store = tmp();
  const workdir = tmp();
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, "f.txt"), "data");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  const commitHash = repo.mark("ws", { message: "first" });
  assert.ok(commitHash);
  repo.putState("ws", "env", { X: "1" });
  // head unchanged
  assert.equal(repo.head("ws"), commitHash);
  // state readable
  assert.deepEqual(repo.getState("ws", "env"), { X: "1" });
});

// ─── tide MCP server State tools (integration through Kernel) ─────────────────

{
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

  test("tide.putState stores a state object in the Sandbox tide store", async () => {
    await call("tide", "init", { workspace: "state-ws", path: "." });
    const r = await call("tide", "putState", { workspace: "state-ws", type: "env", data: { FOO: "bar" } });
    assert.ok(r.ok, r.error);
    assert.ok(r.result.hash);
    assert.equal(r.result.type, "env");
    assert.equal(r.result.workspace, "state-ws");
  });

  test("tide.getState retrieves the stored data", async () => {
    await call("tide", "putState", { workspace: "state-ws", type: "manifest", data: { servers: { fs: {}, proc: {} } } });
    const r = await call("tide", "getState", { workspace: "state-ws", type: "manifest" });
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.result.data, { servers: { fs: {}, proc: {} } });
  });

  test("tide.getState returns null for unwritten type", async () => {
    const r = await call("tide", "getState", { workspace: "state-ws", type: "never-written" });
    assert.ok(r.ok);
    assert.equal(r.result.data, null);
  });

  test("tide.listStates returns all written types", async () => {
    const r = await call("tide", "listStates", { workspace: "state-ws" });
    assert.ok(r.ok);
    assert.ok(r.result.types.includes("env"));
    assert.ok(r.result.types.includes("manifest"));
  });

  test("putState → getState round-trip preserves complex objects", async () => {
    const data = {
      agents: [{ name: "scraper", cmd: "wget ...", patterns: ["net.*"] }],
      tags: ["production", "web"],
      nested: { deep: { value: 42 } },
    };
    await call("tide", "putState", { workspace: "state-ws", type: "agents", data });
    const r = await call("tide", "getState", { workspace: "state-ws", type: "agents" });
    assert.deepEqual(r.result.data, data);
  });

  test("putState update replaces the previous value for the same type", async () => {
    await call("tide", "putState", { workspace: "state-ws", type: "env", data: { K: "v1" } });
    await call("tide", "putState", { workspace: "state-ws", type: "env", data: { K: "v2" } });
    const r = await call("tide", "getState", { workspace: "state-ws", type: "env" });
    assert.deepEqual(r.result.data, { K: "v2" });
    const list = await call("tide", "listStates", { workspace: "state-ws" });
    assert.equal(list.result.types.filter((t) => t === "env").length, 1);
  });
}
