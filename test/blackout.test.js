// B · The blackout test — acceptance suite, goal.md §10.
//
// Start a job. Close the tab. Drop the stream. Restart the Gateway's listener.
// Have an agent write three times in between. Then: the job is still running,
// its logs are intact, the terminal reattaches to its session, the document
// converges with no user action, and nothing was lost or invented.
//
// The one thing this test also pins is a *limit*, honestly: supervised
// processes and terminal sessions are children of the host process. They
// survive a closed tab, a dropped stream and a new listener; they do not
// survive `kill -9` on the Gateway, and the code kills them deliberately on
// shutdown rather than orphaning them. A test that pretended otherwise would be
// worse than no test.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createSession } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { attachSession, listSessions, killAllSessions } from "../packages/kernel/src/pty-sessions.js";
import { stopAllProcs } from "../packages/kernel/src/servers/proc.js";
import { loadOs, forgetOs } from "../packages/os/src/store.js";
import net from "node:net";

/** A port nothing is on, asked of the operating system rather than guessed.
 *  A random number in a range collides eventually, and when it does the failure
 *  looks like the blackout test being flaky rather than like a port clash. */
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

let kernel, owner, sandbox, held, session, srv, port;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };

const listen = async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { s, port: s.address().port };
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  session = createSession(owner.id, "blackout");
  ({ s: srv, port } = await listen());
  await ok("desktop", "reset", {});
});
test.after(() => {
  killAllSessions(sandbox.id);
  stopAllProcs(sandbox.id);
  srv?.close();
  _resetKernels();
  closeDb();
});

/** Read an SSE stream until `count` document events arrive, then let go. */
async function watchDoc(atPort, count, { signal } = {}) {
  const res = await fetch(`http://127.0.0.1:${atPort}/${sandbox.slug}/os/events`, {
    headers: { cookie: `sbx_session=${session}` }, signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const revs = [];
  let hello = null;
  let buf = "";
  // Always read at least once: `hello` arrives immediately and is the whole
  // point of reconnecting, even when the caller wants no document events.
  while (hello === null || revs.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const isHello = f.includes("event: hello");
      const data = f.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (isHello) { hello = ev; continue; }
      if (ev.doc) revs.push(ev.doc.rev);
    }
  }
  await reader.cancel().catch(() => {});
  return { revs, hello };
}

const until = async (fn, what, ms = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("the blackout: a job, a shell, three agent writes, and a new listener", async () => {
  // ── 1 · start work, and watch it ─────────────────────────────────────────
  const listener = await freePort();
  const server = `require('http').createServer((q,s)=>s.end('ok')).listen(${listener},'127.0.0.1');setInterval(()=>console.log('alive'),300)`;
  const job = await ok("proc", "start", {
    cmd: `"${process.execPath}" -e "${server.replace(/"/g, '\\"')}"`,
    name: "blackout-job",
  });
  const reachable = () => fetch(`http://127.0.0.1:${listener}/`, { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false);
  await until(reachable, `the job to bind :${listener}`, 20_000);

  let seen = "";
  const shell = attachSession(kernel.cell, sandbox.id, { name: "blackout-shell" }, (d) => { seen += d.toString(); }, () => {});
  shell.write("echo before-the-blackout\n");
  await until(() => seen.includes("before-the-blackout"), "the shell to answer");

  // ── 2 · the tab closes: the stream goes, the session detaches ────────────
  const ac = new AbortController();
  const watching = watchDoc(port, 1, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 150));
  await ok("desktop", "open", { app: "notes" });         // one write the tab sees
  const beforeDark = (await watching).revs.at(-1);
  ac.abort();                                            // the tab is gone
  shell.detach();                                        // …and so is the window

  // ── 3 · the dark: an agent works while nobody is watching ────────────────
  const filesBefore = (await ok("desktop", "state", {})).doc.windows.filter((w) => w.app === "files").length;
  await ok("desktop", "themeSet", { theme: "tide" });
  await ok("desktop", "open", { app: "files" });
  await ok("desktop", "widgetAdd", { kind: "clock" });
  const afterDark = (await ok("desktop", "state", {})).rev;
  assert.equal(afterDark, beforeDark + 3, "three writes happened, and each was one revision");

  // The work carried on regardless.
  assert.equal(await reachable(), true, "the job kept running with nobody watching");
  const logs = await ok("proc", "logs", { id: job.id });
  assert.equal(logs.state, "running");
  assert.ok(logs.logs.length >= 1, "and its output was captured while the tab was closed");

  // ── 4 · a new listener, as after a restart ───────────────────────────────
  srv.close();
  ({ s: srv, port } = await listen());

  // ── 5 · coming back: hello says where the document is, and the shell is there
  const { hello } = await watchDoc(port, 0, {});
  assert.equal(hello.rev, afterDark, "the stream's hello carries the revision a client must catch up to");
  assert.notEqual(hello.rev, beforeDark, "which is not where the tab left off — that is the point");

  // Reattaching is the same shell, with the scrollback of what happened away.
  const sessions = listSessions(sandbox.id);
  const mine = sessions.find((s) => s.name === "blackout-shell");
  assert.ok(mine, "the session outlived the window");
  assert.equal(mine.alive, true);
  let replay = "";
  const again = attachSession(kernel.cell, sandbox.id, { id: mine.id }, (d) => { replay += d.toString(); }, () => {});
  assert.equal(again.id, mine.id, "the same session, not a new one");
  await until(() => replay.includes("before-the-blackout"), "the scrollback to come back with it");

  // The document a returning client reads is the document that exists — read
  // from disk, so a fresh process would see exactly this too.
  forgetOs(sandbox.id);
  const onDisk = loadOs(sandbox);
  assert.equal(onDisk.rev, afterDark, "nothing was lost");
  assert.equal(onDisk.theme.base, "tide", "and nothing was invented");
  assert.equal(onDisk.windows.filter((w) => w.app === "files").length, filesBefore + 1,
    "the window the agent opened is there, exactly once");

  again.detach();
  await ok("proc", "stop", { id: job.id });
  await until(async () => !(await reachable()), "the job to stop when asked");
});

test("what a blackout cannot save is said, not pretended", async () => {
  // Sessions and supervised processes are children of the host process. The
  // Gateway kills them on shutdown *on purpose* — an orphaned dev server keeps
  // its port and nothing records what is holding it. So: they survive a tab, a
  // stream and a listener; they do not survive the process, and the code says so
  // by killing them itself.
  const s = attachSession(kernel.cell, sandbox.id, { name: "doomed" }, () => {}, () => {});
  s.detach();
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), true);

  const killed = stopAllProcs(sandbox.id);   // what shutdown() calls
  assert.ok(killed >= 1, "shutdown stops the machine's own children");
  assert.equal(listSessions(sandbox.id).some((x) => x.id === s.id), false, "shells included");

  // And the desktop — the part that is *not* host state — is untouched by any of
  // it, because it was never in the process to begin with.
  forgetOs(sandbox.id);
  assert.ok(loadOs(sandbox).rev > 0, "the document is on disk, where a restart finds it");
});
