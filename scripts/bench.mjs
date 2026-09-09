#!/usr/bin/env node
// The budgets, measured. goal.md T4.1 and acceptance suite D.
//
// A performance claim nobody measures becomes a performance regression nobody
// notices. This prints one table and exits non-zero when a number crosses its
// budget, so "a window move costs a window move" is a property the suite keeps
// rather than a sentence in a phase note.
//
// It boots a throwaway Gateway on a temp home (the same isolation the tests use)
// and drives the real Kernel — no browser, so it can run anywhere `npm test`
// does. The browser-side budgets (stylesheet requests per gesture, dropped
// frames) live in `npm run smoke`, which already has a browser.
//
//   npm run bench            # print the table, fail on a regression
//   BENCH_JSON=1 npm run bench   # emit JSON for CI to keep

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const home = path.join(os.tmpdir(), `sandboxos-bench-${crypto.randomUUID().slice(0, 8)}`);
process.env.SANDBOXOS_HOME = home;
process.env.SANDBOXOS_CELL_BACKEND = "local";
process.env.SANDBOXOS_PASSWORD = "bench";

const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
const { ensureSeed, grantsFor, createSession } = await import("../packages/control-db/src/registry.js");
const { getKernel, _resetKernels } = await import("../packages/kernel/src/kernel.js");
const { createServer } = await import("../apps/gateway/src/server.js");
const { osEvents, osPath } = await import("../packages/os/src/store.js");

openDb();
const { owner, sandbox } = ensureSeed("local");
const held = grantsFor(owner.id, sandbox.id);
const kernel = await getKernel(sandbox);
const session = createSession(owner.id, "bench");
const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

const desktop = async (tool, args = {}) => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
  if (!r.ok) throw new Error(`desktop.${tool}: ${r.error}`);
  return r.result;
};

// ── the budgets ─────────────────────────────────────────────────────────────
//
// Each is a ceiling with a reason, not a wish. Raise one deliberately, with the
// reason in the commit, or fix what made it grow.

const results = [];
let failed = 0;

function record({ name, value, budget, unit, note }) {
  const ok = value <= budget;
  if (!ok) failed += 1;
  results.push({ name, value, budget, unit, ok, note });
  const num = Number.isInteger(value) ? String(value) : value.toFixed(2);
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${num.padStart(9)} ${unit.padEnd(6)} (budget ${budget})${note ? `  ${note}` : ""}`);
}

/** Bytes written under a directory, so "what did this write cost" is answerable. */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
    }
  };
  try { walk(dir); } catch { /* nothing there yet */ }
  return total;
}

const osDir = path.dirname(osPath(sandbox));

console.log("\nSandboxOS budgets\n");

// ── a desktop with real furniture in it ─────────────────────────────────────
await desktop("reset", {});
for (let i = 0; i < 40; i += 1) await desktop("open", { app: i % 2 ? "files" : "notes" });
for (let i = 0; i < 20; i += 1) await desktop("widgetAdd", { kind: i % 2 ? "clock" : "load" });
const doc = (await desktop("state", {})).doc;
record({
  name: "document at 40 windows + 20 widgets",
  value: JSON.stringify(doc).length / 1024, budget: 96, unit: "KB",
  note: `rev ${doc.rev}`,
});

// ── what one gesture costs ──────────────────────────────────────────────────
const bus = osEvents(sandbox.id);
let wireBytes = 0, events = 0;
const onChange = (ev) => { wireBytes += JSON.stringify(ev).length; events += 1; };
bus.on("change", onChange);

const target = doc.windows[0].id;
const before = dirBytes(osDir);
const t0 = performance.now();
const MOVES = 20;
for (let i = 0; i < MOVES; i += 1) await desktop("move", { id: target, x: 40 + i * 3, y: 40 });
const elapsed = performance.now() - t0;
const after = dirBytes(osDir);
bus.off("change", onChange);

record({ name: "events on the wire per desktop write", value: events / MOVES, budget: 1, unit: "ev" });
record({ name: "bytes on the wire per desktop write", value: wireBytes / MOVES / 1024, budget: 96, unit: "KB" });
record({ name: "time per desktop write", value: elapsed / MOVES, budget: 40, unit: "ms" });
record({
  name: "disk growth per revision",
  value: Math.max(0, after - before) / MOVES / 1024, budget: 96, unit: "KB",
  note: "history is append-only (T0.5)",
});

// ── reading the machine ─────────────────────────────────────────────────────
const readStart = performance.now();
const res = await fetch(`${base}/${sandbox.slug}/os/doc`, { headers: { cookie: `sbx_session=${session}` } });
const payload = await res.text();
record({ name: "GET /os/doc — first paint's one round trip", value: performance.now() - readStart, budget: 400, unit: "ms" });
record({ name: "…and what it carries", value: payload.length / 1024, budget: 192, unit: "KB" });

// A theme change is one stylesheet; a window move is none. The ETag is what
// makes the second ask free, so measure the second ask.
const themeUrl = `${base}/${sandbox.slug}/os/theme.css`;
const first = await fetch(themeUrl, { headers: { cookie: `sbx_session=${session}` } });
const etag = first.headers.get("etag");
const cssBytes = (await first.text()).length;
const again = await fetch(themeUrl, { headers: { cookie: `sbx_session=${session}`, "if-none-match": etag } });
record({ name: "theme.css", value: cssBytes / 1024, budget: 32, unit: "KB" });
record({ name: "…re-asked with its ETag", value: again.status === 304 ? 0 : cssBytes / 1024, budget: 0, unit: "KB", note: `HTTP ${again.status}` });

// ── what an agent reads ─────────────────────────────────────────────────────
const map = (await desktop("summarize", {})).map;
record({
  name: "desktop map for a model's context",
  value: map.length / 1024, budget: 8, unit: "KB",
  note: `${map.split("\n").length} lines`,
});

// ── the audit log, under load ───────────────────────────────────────────────
const auditStart = performance.now();
const rows = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "kernel", tool: "auditQuery", args: { limit: 200 } });
record({
  name: "auditQuery of 200 rows",
  value: performance.now() - auditStart, budget: 250, unit: "ms",
  note: `${rows.result.events.length} rows`,
});

// ── a terminal session's memory ceiling ─────────────────────────────────────
const { attachSession, killAllSessions } = await import("../packages/kernel/src/pty-sessions.js");
let got = 0;
const s = attachSession(kernel.cell, sandbox.id, { name: "bench" }, (d) => { got += d.length; }, () => {});
s.write("for i in $(seq 1 400); do echo \"line $i of bench output\"; done\n");
await new Promise((r) => setTimeout(r, 1500));
const live = (await kernel.call({ principalId: owner.id, heldPatterns: held, server: "proc", tool: "sessions", args: {} })).result.sessions[0];
record({
  name: "session scrollback held for a detached shell",
  value: (live?.bytes ?? 0) / 1024, budget: 256, unit: "KB",
  note: `${(got / 1024).toFixed(1)} KB seen`,
});
killAllSessions(sandbox.id);

// ── out ─────────────────────────────────────────────────────────────────────
console.log("");
if (process.env.BENCH_JSON) console.log(JSON.stringify({ at: Date.now(), results }, null, 2));
console.log(failed ? `${failed} budget${failed === 1 ? "" : "s"} exceeded\n` : "every budget met\n");

// The wire row is the one that decides T4.2 of goal.md. A delta protocol —
// `{op, rev, patch}` for geometry-only writes, whole documents for structural
// ones — is held in reserve for the day the document stops fitting comfortably.
// While it fits, a second representation of the desktop would be a second thing
// for every client to reconcile and a new class of bug where the patch and the
// document disagree, to save bytes that are not scarce. This line is where that
// stops being true, so the decision can be revisited on a number rather than on
// a memory of one.
const wire = results.find((r) => r.name.startsWith("bytes on the wire"));
if (wire) {
  const share = Math.round((wire.value / wire.budget) * 100);
  console.log(`the wire is at ${share}% of its budget. Deltas (goal.md T4.2) are deliberately not`);
  console.log("built while that stays low: they would be a second desktop to reconcile.\n");
}

srv.close();
_resetKernels();
closeDb();
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
