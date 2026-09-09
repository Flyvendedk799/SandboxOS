#!/usr/bin/env node
// The release check — goal.md T5.5.
//
// One command, one page. Shipping is that page being green.
//
// It runs the things that decide whether a build is finished — the suite, the
// bench, the smoke, the day and the container — on *this* host, and prints what the host
// actually is, because "it passes" without "on what" is half a sentence. The
// matrix in `.github/workflows/release-check.yml` runs this same command on
// Linux, macOS and Windows, with and without Docker; §10 of goal.md is only
// satisfied when all of those pages are green.
//
//   npm run release-check                 # the whole page
//   npm run release-check -- --quick      # suite + bench only (no browser, no container)
//   RELEASE_JSON=1 npm run release-check  # the same page as JSON, for CI to keep
//
// Every stage runs even when an earlier one failed: a release check that stops
// at the first red tells you one thing when you wanted four.

import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const jsonOut = !!process.env.RELEASE_JSON;

// ── what this host is ───────────────────────────────────────────────────────
//
// Read before anything runs, so a failure page says what it failed on.

const { hostReport } = await import("../packages/cell/src/shell.js");
const { findChrome } = await import("./lib/chrome.mjs");

const host = hostReport();
let dockerVersion = null;
try {
  dockerVersion = await new Promise((res) => {
    const p = spawn("docker", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => res(null));
    p.on("exit", (code) => res(code === 0 ? out.trim() : null));
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } res(null); }, 4000);
  });
} catch { /* no docker, which is a fact, not a failure */ }

const chrome = findChrome();

const facts = [
  ["platform", `${process.platform} ${os.release()} (${process.arch})`],
  ["node", process.version],
  ["cpus", `${os.cpus().length} × ${os.cpus()[0]?.model?.trim() ?? "unknown"}`],
  ["memory", `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`],
  ["shell", host.shell.ok ? `${host.shell.bin}${host.shell.pty ? " (pty)" : " (line mode)"}` : `none — ${host.shell.why}`],
  ["docker", dockerVersion ?? "not present — the local Cell backend is what runs"],
  ["browser", chrome ?? "none — the smoke and the day cannot run here"],
];

// ── the stages ──────────────────────────────────────────────────────────────

const stages = [
  { key: "suite", label: "the suite", cmd: ["--test", "--no-warnings"], what: "every unit and integration test" },
  { key: "bench", label: "the bench", cmd: ["scripts/bench.mjs"], what: "the T4.1 budgets, D of the acceptance suite" },
  { key: "smoke", label: "the smoke", cmd: ["scripts/browser-smoke.mjs"], what: "the OS and the Studio in a real browser", browser: true },
  { key: "day", label: "the day", cmd: ["scripts/day.mjs"], what: "A of the acceptance suite — ten acts, no console", browser: true },
  // The same day with no pointer at all. goal.md Track 4 is done "when the bench
  // passes, the hostile test passes, and a keyboard-only run of the day
  // completes", and the only way to know is to run it.
  { key: "keyboard", label: "the keyboard", cmd: ["scripts/day.mjs"], what: "the same day, driven with nothing but the keyboard", browser: true, env: { DAY_KEYBOARD: "1" } },
  { key: "docker", label: "the container", cmd: ["scripts/docker-check.mjs"], what: "the same machine on the Docker backend", docker: true },
];

const run = (cmd, extraEnv = null) => new Promise((res) => {
  const started = Date.now();
  const p = spawn(process.execPath, cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; if (!jsonOut) process.stdout.write(dim(d.toString())); });
  p.stderr.on("data", (d) => { out += d; });
  p.on("error", (e) => res({ code: 127, ms: Date.now() - started, out: `${out}\n${e.message}`, neverRan: true }));
  p.on("exit", (code) => res({ code: code ?? 1, ms: Date.now() - started, out }));
});

const dim = (s) => s.split("\n").map((l) => (l ? `    \x1b[2m${l}\x1b[0m` : l)).join("\n");
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The one line each stage is remembered by: counts, not scrollback. */
function headline(key, out) {
  if (key === "suite") {
    const pass = out.match(/^# pass (\d+)$/m)?.[1] ?? out.match(/ℹ pass (\d+)/)?.[1];
    const fail = out.match(/^# fail (\d+)$/m)?.[1] ?? out.match(/ℹ fail (\d+)/)?.[1];
    const skip = out.match(/ℹ skipped (\d+)/)?.[1];
    return pass ? `${pass} passing, ${fail ?? "?"} failing${Number(skip) ? `, ${skip} skipped` : ""}` : "no counts reported";
  }
  if (key === "bench") {
    const n = (out.match(/^\s+[✓✗] /gm) ?? []).length;
    const over = out.match(/(\d+) budgets? exceeded/)?.[1];
    return over ? `${over} of ${n} budgets exceeded` : `${n} budgets met`;
  }
  if (key === "smoke") {
    const bad = (out.match(/^\s+✗ /gm) ?? []).length;
    const good = (out.match(/^\s+✓ /gm) ?? []).length;
    return bad ? `${bad} of ${good + bad} checks failed` : `${good} checks passed`;
  }
  if (key === "docker") {
    const bad = (out.match(/^\s+✗ /gm) ?? []).length;
    const good = (out.match(/^\s+✓ /gm) ?? []).length;
    return bad ? `${bad} of ${good + bad} checks failed` : `${good} checks passed in a container`;
  }
  if (key === "day" || key === "keyboard") {
    const acts = (out.match(/^\d+\. /gm) ?? []).length;
    const bad = (out.match(/^\s+✗ /gm) ?? []).length;
    const good = (out.match(/^\s+✓ /gm) ?? []).length;
    return bad ? `${bad} of ${good + bad} checks failed across ${acts} acts` : `${acts} acts, ${good} checks passed`;
  }
  return "";
}

const results = [];
for (const stage of stages) {
  if (quick && (stage.browser || stage.docker)) { results.push({ ...stage, skipped: "--quick" }); continue; }
  if (stage.browser && !chrome) { results.push({ ...stage, skipped: "no browser on this host" }); continue; }
  if (stage.docker && !dockerVersion) { results.push({ ...stage, skipped: "no Docker here — which is a supported way to run" }); continue; }
  if (!jsonOut) console.log(`\n\x1b[1m${stage.label}\x1b[0m — ${stage.what}`);
  const r = await run(stage.cmd, stage.env ?? null);
  results.push({ ...stage, ...r, headline: headline(stage.key, r.out) });
}

// ── the page ────────────────────────────────────────────────────────────────

const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const green = failed.length === 0 && ran.length > 0;

if (jsonOut) {
  console.log(JSON.stringify({
    at: Date.now(),
    green,
    host: Object.fromEntries(facts),
    stages: results.map((r) => ({ key: r.key, code: r.code ?? null, ms: r.ms ?? null, skipped: r.skipped ?? null, headline: r.headline ?? null })),
  }, null, 2));
  process.exit(green ? 0 : 1);
}

const w = 74;
const rule = (ch = "─") => ch.repeat(w);
console.log(`\n${rule("═")}`);
console.log("  SandboxOS · release check");
console.log(rule("═"));
for (const [k, v] of facts) console.log(`  ${k.padEnd(9)} ${v}`);
console.log(rule());
for (const r of results) {
  if (r.skipped) { console.log(`  ○  ${r.label.padEnd(12)} skipped — ${r.skipped}`); continue; }
  const mark = r.code === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const time = secs(r.ms).padStart(7);
  console.log(`  ${mark}  ${r.label.padEnd(12)} ${time}   ${r.headline}${r.neverRan ? "  (never ran)" : ""}`);
}
console.log(rule());

if (green && skipped.length === 0) {
  console.log("  green — this host is shippable.");
  console.log("  goal.md §10 wants this page green on Linux, macOS and Windows.");
} else if (green) {
  console.log(`  green as far as it went — ${skipped.length} stage${skipped.length === 1 ? "" : "s"} did not run here.`);
} else {
  console.log(`  \x1b[31mnot shippable\x1b[0m — ${failed.length} stage${failed.length === 1 ? "" : "s"} failed:`);
  for (const f of failed) {
    const lines = f.out.split("\n").filter((l) => /✗|not ok|Error|failed at|budgets? exceeded/.test(l)).slice(0, 4);
    console.log(`    ${f.label}: ${f.headline}`);
    for (const l of lines) console.log(`      ${l.trim().slice(0, 100)}`);
  }
}
console.log(`${rule("═")}\n`);
process.exit(green ? 0 : 1);
