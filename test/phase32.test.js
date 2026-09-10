// Phase 32: the desktop can run the machine.
//
// Track 1 of goal.md. A shell outlives the window it was opened in, and the
// things you actually do with a machine — processes, ports, agents, secrets,
// sync, access, the audit log — are apps on the desktop rather than reasons to
// leave it for a console.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import {
  attachSession, listSessions, getSession, killSession, killAllSessions, renameSession,
} from "../packages/kernel/src/pty-sessions.js";
import { BUILTIN_APPS } from "../packages/os/src/catalog.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => { killAllSessions(sandbox.id); _resetKernels(); closeDb(); });

/** Wait for a predicate over accumulated output, or fail with what we did see. */
async function until(fn, what, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ── T1.8 · a terminal is a session, not a socket ────────────────────────────

test("a session outlives the window that opened it, scrollback and all", async () => {
  let seen = "";
  const first = attachSession(kernel.cell, sandbox.id, { name: "work" }, (d) => { seen += d.toString(); }, () => {});
  first.write("echo phase32-alpha\n");
  await until(() => seen.includes("phase32-alpha"), "the shell to answer");

  // Closing the window detaches. The shell keeps working while nobody watches.
  first.detach();
  const detached = listSessions(sandbox.id).find((s) => s.id === first.id);
  assert.equal(detached.attached, 0, "nobody is watching");
  assert.equal(detached.alive, true, "and it is still alive");
  first.write("echo phase32-while-away\n");
  await new Promise((r) => setTimeout(r, 700));

  // Reopening reattaches: the same shell, and the backlog comes with it.
  let replay = "";
  const again = attachSession(kernel.cell, sandbox.id, { id: first.id }, (d) => { replay += d.toString(); }, () => {});
  assert.equal(again.id, first.id, "the same session, not a new one");
  await until(() => replay.includes("phase32-alpha") && replay.includes("phase32-while-away"),
    "the scrollback to replay what happened while the window was closed");
  again.detach();
  killSession(sandbox.id, first.id);
});

test("ending a session is a different thing from closing a window", async () => {
  const s = attachSession(kernel.cell, sandbox.id, { name: "ends" }, () => {}, () => {});
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), true);
  s.detach();
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), true, "detaching keeps it");
  s.kill();
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), false, "killing does not");
});

test("sessions are named, listed and endable as tools, so an agent sees them too", async () => {
  const s = attachSession(kernel.cell, sandbox.id, { name: "build" }, () => {}, () => {});
  const listed = await ok("proc", "sessions", {});
  const mine = listed.sessions.find((x) => x.id === s.id);
  assert.ok(mine, "the session is in the catalogue");
  assert.equal(mine.name, "build");
  assert.ok(!("scrollback" in mine) && !("handle" in mine), "a view, not the machinery");

  await ok("proc", "sessionRename", { id: s.id, name: "the build" });
  assert.equal(getSession(sandbox.id, s.id).name, "the build");
  assert.equal(renameSession(sandbox.id, "nope", "x"), null);

  const killed = await ok("proc", "sessionKill", { id: s.id });
  assert.equal(killed.killed, true);
  assert.equal((await ok("proc", "sessions", {})).sessions.some((x) => x.id === s.id), false);
});

test("a session that dies tells the people watching it", async () => {
  let closed = false;
  const s = attachSession(kernel.cell, sandbox.id, { name: "exits" }, () => {}, () => { closed = true; });
  s.write("exit\n");
  await until(() => closed, "the close callback");
  assert.equal(getSession(sandbox.id, s.id)?.alive ?? false, false);
  killSession(sandbox.id, s.id);
});

test("stopping a Sandbox's processes stops its shells", async () => {
  attachSession(kernel.cell, sandbox.id, { name: "a" }, () => {}, () => {});
  attachSession(kernel.cell, sandbox.id, { name: "b" }, () => {}, () => {});
  assert.ok(listSessions(sandbox.id).length >= 2);
  killAllSessions(sandbox.id);
  assert.equal(listSessions(sandbox.id).length, 0);
});

// ── T1.1–T1.7 · the machine's own work has a home on the desktop ────────────

test("the desktop ships an app for every thing you actually do with a machine", () => {
  const ids = new Set(BUILTIN_APPS.map((a) => a.id));
  for (const id of ["jobs", "ports", "agents", "secrets", "sync", "access", "audit"]) {
    assert.ok(ids.has(id), `the desktop has no ${id} app — Command Central would still be needed`);
  }
});

test("every built-in declares the capabilities it needs, and they are real tools", async () => {
  const catalog = await ok("kernel", "tools", {});
  const known = new Set(catalog.tools.map((t) => t.name));
  const servers = new Set(catalog.servers);
  for (const app of BUILTIN_APPS) {
    for (const need of app.needs ?? []) {
      const [server, tool] = need.split(".");
      const okNeed = tool === "*" ? servers.has(server) : known.has(need);
      assert.ok(okNeed, `${app.id} declares ${need}, which no server serves`);
    }
  }
});

test("the built-ins are wired into the shell, not just listed", () => {
  const ops = readSource(new URL("../apps/gateway/public/js/os/ops.js", import.meta.url));
  const builtins = readSource(new URL("../apps/gateway/public/js/os/builtins.js", import.meta.url));
  const exported = ops.split("export const OPS_APPS")[1] ?? "";
  for (const id of ["jobs", "ports", "agents", "secrets", "sync", "access", "audit"]) {
    assert.ok(new RegExp(`^const ${id} = \\{`, "m").test(ops), `ops.js has no app called ${id}`);
    assert.ok(new RegExp(`\\b${id}\\b`).test(exported), `${id} is not in OPS_APPS`);
  }
  assert.ok(builtins.includes("...OPS_APPS"), "builtins.js does not mount the ops apps");
});

test("a session killed while it is still starting does not survive its own birth", async () => {
  // The shell exists a tick after the call on some backends. Killing into that
  // gap used to leave a live Cell process nobody had a handle to — invisible in
  // the session list, and enough to keep the whole process from ever exiting.
  const s = attachSession(kernel.cell, sandbox.id, { name: "born-dying" }, () => {}, () => {});
  s.kill();
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), false, "it is gone from the list");
  await new Promise((r) => setTimeout(r, 900)); // long enough for the handle to arrive
  const live = process.getActiveResourcesInfo().filter((k) => k === "ProcessWrap").length;
  assert.equal(live, 0, `no child process is left behind (${live})`);
});
