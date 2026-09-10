#!/usr/bin/env node
// A · The day — the acceptance script of goal.md §10.
//
// One browser session at /slug/os, no Command Central, no host shell: a project,
// a server started from the Terminal, a job supervised, a port exposed, access
// shared narrowly, a break and a fix, an agent's change reviewed before it
// happens, an app built and published, a stranger forking it, and the same
// machine on a phone with the work still running.
//
// It is deliberately narrative. Each numbered act is a thing a person does, in
// the order they would do it, and it writes a screenshot as it goes so a failure
// can be looked at rather than guessed at.
//
//   npm run day
//   CHROME=/path/to/chrome npm run day
//   DAY_SHOTS=/some/dir npm run day
//
// The one thing it cannot do is call a model: an assistant turn needs a provider
// credential this host may not have. So act 7 drives the *review* flow — a
// proposal, what it would do, applying it, and undoing one part — through the
// same tools an assistant turn writes, and says so rather than pretending a
// model was in the room.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";

const home = path.join(os.tmpdir(), `sandboxos-day-${crypto.randomUUID().slice(0, 8)}`);
process.env.SANDBOXOS_HOME = home;
process.env.SANDBOXOS_CELL_BACKEND = "local";
process.env.SANDBOXOS_PASSWORD = "day";

/**
 * DAY_KEYBOARD=1 drives the whole day with the keyboard: every activation
 * becomes focus-then-Enter instead of a click.
 *
 * This is the last clause of Track 4's "done when" — a keyboard-only run of the
 * day test completes — and it is a real check rather than a mode switch, because
 * an affordance that only answers a synthetic click is not keyboard-reachable.
 * A div with an onclick passes the pointer run and fails this one.
 */
const keyboardOnly = process.env.DAY_KEYBOARD === "1";

const shots = process.env.DAY_SHOTS ?? path.join(home, "shots");
fs.mkdirSync(shots, { recursive: true });

const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
const {
  ensureSeed, createSession, grantsFor, createTenant, createAccount, createSandboxForTenant,
} = await import("../packages/control-db/src/registry.js");
const { getKernel, _resetKernels } = await import("../packages/kernel/src/kernel.js");
const { createServer } = await import("../apps/gateway/src/server.js");
const { killAllSessionsEverywhere } = await import("../packages/kernel/src/pty-sessions.js");
const { chromium } = await import("playwright-core");

if (keyboardOnly) console.log("keyboard only: every activation is focus-then-Enter\n");

const failures = [];
let act = "—";
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures.push(`${act} · ${msg}`); console.log(`  ✗ ${msg}`); }
  return !!cond;
};
const scene = (n, title) => { act = String(n); console.log(`\n${n}. ${title}`); };

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

openDb();
const { owner, sandbox } = ensureSeed("local");
const kernel = await getKernel(sandbox);
const held = grantsFor(owner.id, sandbox.id);
const mcp = async (server, tool, args = {}) => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  if (!r.ok) throw new Error(`${server}.${tool}: ${r.error}`);
  return r.result;
};
const desktop = (tool, args = {}) => mcp("desktop", tool, args);

const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const session = createSession(owner.id, "day");
const cookie = `sbx_session=${session}`;

const { findChrome, noChromeMessage } = await import("./lib/chrome.mjs");
const executablePath = findChrome();
if (!executablePath) { console.error(noChromeMessage()); process.exit(2); }
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: "sbx_session", value: session, url: base }]);

const pageErrors = [];
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {});
const until = async (fn, what, ms = 25_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
/**
 * Press a thing. With a pointer, that is a click; with a keyboard, it is focus
 * and Enter — and if the element cannot take focus, that is the finding.
 */
const press = async (selector) => {
  if (!keyboardOnly) return page.click(selector);
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 15_000 });
  await el.focus();
  const focused = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? "none");
  if (focused === "body" || focused === "none") throw new Error(`${selector} cannot take focus — it is not reachable without a pointer`);
  await page.keyboard.press("Enter");
};

const serverPort = await freePort();
// Two ways to ask the same question. Direct is how the *script* checks that
// something is listening at all; through the slug is how a *person* reaches it,
// and that one only answers once the port has been exposed — which is act 4.
const listening = (what) => async () => {
  const r = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  return !!r && r.ok && (await r.text()).includes(what);
};
const serves = (what) => async () => {
  const r = await fetch(`${base}/${sandbox.slug}/p/${serverPort}/`, { headers: { cookie }, signal: AbortSignal.timeout(2000) }).catch(() => null);
  return !!r && r.ok && (await r.text()).includes(what);
};
const serverSource = (says) => [
  "const http = require('node:http');",
  `http.createServer((q, s) => s.end(${JSON.stringify(says)})).listen(${serverPort}, '127.0.0.1');`,
  "setInterval(() => console.log('still serving'), 500);",
].join("\n");

let page;
try {
  await desktop("reset", {});
  page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console: ${m.text()}`); });
  await page.goto(`${base}/${sandbox.slug}/os`);

  // ── 0 · First run ─────────────────────────────────────────────────────────
  //
  // Before the day there is the first minute. A machine nobody has set up shows
  // one screen, and finishing it has to leave the machine *doing something* —
  // that is the whole of T5.1, and it is checked here rather than described.
  scene(0, "First run: one screen, a seed, and a machine that is already working");
  await page.waitForSelector(".fr-panel", { timeout: 25_000 });
  check((await page.$$(".fr-card")).length === 4, "the one idea is explained on one screen");
  const seedNames = await page.$$eval(".fr-seed .fr-seed-name", (els) => els.map((e) => e.textContent));
  check(seedNames.length >= 4, `and there is a seed to pick (${seedNames.join(", ")})`);
  await press(".fr-seed:has-text('Developer Box')");
  await press(".fr-go");
  await page.waitForSelector(".os-window", { timeout: 60_000 });
  await page.waitForTimeout(1200);

  const afterSetup = (await desktop("state")).doc;
  check(afterSetup.setup?.done && afterSetup.setup.seed === "dev", `the machine records that it has been set up (${JSON.stringify(afterSetup.setup)})`);
  const welcomeJob = (await mcp("proc", "jobs", {})).jobs.find((j) => j.name === "welcome");
  check(welcomeJob?.state === "running", `something is running when you first look at it (${welcomeJob?.state ?? "nothing"})`);
  const welcomePort = (await mcp("ports", "list", {})).ports.find((p) => p.name === "welcome");
  check(!!welcomePort, "at an address under your own slug");
  if (welcomePort) {
    const r = await fetch(`${base}/${sandbox.slug}/p/${welcomePort.port}/`, { headers: { cookie } });
    check(r.ok && (await r.text()).includes("volume"), "and the page it serves is a file in your volume");
  }
  const wrote = await mcp("fs", "list", { path: "welcome" });
  check(wrote.entries.some((e) => e.name === "index.html"), `made of ordinary files you can open (${wrote.entries.map((e) => e.name).join(", ")})`);
  const note = await mcp("fs", "read", { path: "notes/first-day.md" });
  check(/desktop is a document/i.test(note.content), "with a note that says what the machine is");
  await shot(page, "00-first-run");

  // The day proper starts from a clean desktop: what first run left behind is
  // its own act, checked above.
  for (const j of (await mcp("proc", "jobs", {})).jobs.filter((j) => j.state === "running")) await mcp("proc", "stop", { id: j.id });
  if (welcomePort) await mcp("ports", "unexpose", { port: welcomePort.port });
  for (const w of (await desktop("state")).doc.windows) await desktop("close", { id: w.id });

  // ── 1 · Files ─────────────────────────────────────────────────────────────
  scene(1, "Files: a project, a file in it, an edit, a save");
  await mcp("fs", "mkdir", { path: "app" });
  await mcp("fs", "write", { path: "app/server.js", content: serverSource("day one") });
  await desktop("open", { app: "files", props: { path: "app" } });
  await page.waitForSelector(".file-list .row-line", { timeout: 15_000 });
  const listing = await page.$$eval(".file-list .row-line", (els) => els.map((e) => e.textContent));
  check(listing.some((t) => t.includes("server.js")), `Files shows the project (${listing.length} entries)`);
  await press(".file-list .row-line:has-text('server.js')");
  await page.waitForSelector(".file-pane textarea", { timeout: 10_000 });
  const opened = await page.inputValue(".file-pane textarea");
  check(/createServer/.test(opened), `${keyboardOnly ? "reaching the file with the keyboard" : "clicking the file"} opens it, with its contents`);

  // Edit it in the window and press Save — no tool call, no console.
  await page.focus(".file-pane textarea");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// edited in the Files window\n");
  await press(".app-bar button:has-text('Save')");
  const saved = await until(async () => /edited in the Files window/.test((await mcp("fs", "read", { path: "app/server.js" })).content), "the save to land");
  check(saved, "editing it and pressing Save writes the file inside the machine");
  await shot(page, "01-files");

  // ── 2 · Terminal ──────────────────────────────────────────────────────────
  scene(2, "Terminal: start the server, close the window, come back to it");
  // The first-run desktop opened a Terminal of its own before we closed it, and
  // its session is still there — sessions outlive windows, which is the point.
  // So the shell this act is about is the one that was not there a moment ago.
  const priorSessions = new Set((await mcp("proc", "sessions", {})).sessions.map((x) => x.id));
  const termWin = (await desktop("open", { app: "terminal" })).window;
  await page.waitForSelector(".term-screen", { timeout: 20_000 });
  await page.waitForTimeout(2000);
  await page.locator(".term-screen").last().focus();
  await page.keyboard.type("node app/server.js");
  await page.keyboard.press("Enter");
  const up = await until(listening("day one"), "the terminal's server to answer", 40_000);
  check(up, "a server started by typing in the Terminal is serving");

  const before = await mcp("proc", "sessions", {});
  const mine = before.sessions.find((x) => !priorSessions.has(x.id));
  check(!!mine, `the shell is a named session of its own (${before.sessions.map((x) => x.name).join(", ")})`);
  await desktop("close", { id: termWin.id });
  await page.waitForTimeout(1500);
  check(await listening("day one")(), "closing the window does not kill what the shell was running");
  const alive = (await mcp("proc", "sessions", {})).sessions.find((x) => x.id === mine?.id && x.alive);
  check(!!alive, "and that session is still alive, detached from any window");

  if (alive) {
    await desktop("open", { app: "terminal", props: { tabs: [{ id: "t1", title: alive.name, session: alive.id }], active: "t1" } });
    await page.waitForSelector(".term-screen", { timeout: 20_000 });
    const replayed = await until(async () => /node app\/server\.js|still serving/.test(await page.locator(".term-screen").last().textContent()), "the scrollback to replay");
    check(replayed, "reopening reattaches to the same session, with what happened while you were away");
  }
  await shot(page, "02-terminal");

  // ── 3 · Jobs ──────────────────────────────────────────────────────────────
  scene(3, "Jobs: hand the same work to the supervisor, tail its log, search it, restart it");
  // A shell is fine for starting something; a supervisor is what you want for
  // keeping it. Ending the session takes its child with it — the process tree,
  // not just the shell — which is the thing that has to be true before the same
  // port can be taken by a job.
  await desktop("open", { app: "jobs" });
  if (alive) await mcp("proc", "sessionKill", { id: alive.id });
  const portFree = await until(async () => !(await listening("day one")()), "the shell's server to go with it", 20_000);
  check(portFree, "ending the shell session takes what it started with it, tree and all");

  const job = await mcp("proc", "start", { cmd: "node app/server.js", name: "web" });
  check(await until(listening("day one"), "the supervised server to answer"), "the same command, supervised this time, is serving");
  const listed = await until(async () => (await page.$$eval(".ops-list .row-line", (els) => els.map((e) => e.textContent))).some((t) => t.includes("web")), "Jobs to list it");
  check(listed, "the supervised process is in Jobs, with the shells listed beneath it");
  await press(".ops-list .row-line:has-text('web')");
  const tailed = await until(async () => /still serving/.test(await page.$eval(".ops-pane", (el) => el.innerText)), "the log to arrive in the window");
  check(tailed, "Jobs tails its output in the window, without a console anywhere");
  await page.fill(".ops-search", "serving");
  await page.waitForTimeout(600);
  const filtered = await page.$eval(".ops-pane .ops-log", (el) => el.innerText);
  check(/still serving/.test(filtered) && !/nothing in the log matches/.test(filtered), "and the log can be searched from the same window");
  await page.fill(".ops-search", "zzz-nothing-says-this");
  await page.waitForTimeout(400);
  check(/nothing in the log matches/.test(await page.$eval(".ops-pane .ops-log", (el) => el.innerText)), "a search that matches nothing says so, rather than looking empty");
  await page.fill(".ops-search", "");

  // Restart it from the window: Stop, then Start again, both in the pane head.
  await press(".ops-pane-head button:has-text('Stop')");
  await until(async () => (await mcp("proc", "logs", { id: job.id })).state !== "running", "it to stop");
  await press(".ops-pane-head button:has-text('Start again')");
  const back = await until(listening("day one"), "it to come back", 30_000);
  check(back, "and it can be stopped and started again from the same two buttons");
  check((await mcp("proc", "jobs", {})).jobs.filter((j) => j.name === "web").length === 2, "the run that ended stays in the list, so its log is still readable");
  await shot(page, "03-jobs");

  // ── 4 · Ports ─────────────────────────────────────────────────────────────
  scene(4, "Ports: expose it, preview it, and read the URL you would send");
  await desktop("open", { app: "ports" });
  await page.waitForTimeout(1200);
  await mcp("ports", "expose", { port: serverPort, name: "web" });
  const exposedShown = await until(async () => (await page.$$eval(".ops-list .row-line", (e) => e.map((x) => x.textContent))).some((t) => t.includes(`:${serverPort}`)), "the exposed port to appear");
  check(exposedShown, `the exposed port is in the Ports window (:${serverPort})`);
  // A port answering through the slug is a round trip through the proxy, and
  // the job was restarted a moment ago: wait for it rather than racing it, and do
  // not point a window at it until it answers — a 502 in an iframe is a console
  // error, and this day fails on those.
  check(await until(serves("day one"), "the proxy to answer"), "and the Gateway serves it under the slug, no tunnel required");
  await desktop("open", { app: "browser", props: { port: serverPort, path: "/" } });
  const inFrame = await until(async () => page.frames().some((f) => f.url().includes(`/p/${serverPort}/`)), "the Browser to show it");
  check(inFrame, "the Browser window shows it inside the desktop");
  await shot(page, "04-ports");

  // ── 5 · Access ────────────────────────────────────────────────────────────
  scene(5, "Access: share the machine with someone, narrowly, and check the narrowness");
  const guestName = `day-guest-${crypto.randomUUID().slice(0, 6)}`;
  const guestTenant = createTenant(`${guestName}-tenant`);
  const guest = createAccount(guestTenant.id, { username: guestName, password: "pw" });
  await mcp("access", "share", { username: guestName, patterns: ["fs.read", "desktop.get"] });
  const shared = await mcp("access", "list", {});
  check(shared.access.some((a) => a.principalId === guest.principalId), "the person is on the access list with what they hold");

  const guestHeld = grantsFor(guest.principalId, sandbox.id);
  const can = await kernel.call({ principalId: guest.principalId, heldPatterns: guestHeld, server: "fs", tool: "read", args: { path: "app/server.js" } });
  const cannot = await kernel.call({ principalId: guest.principalId, heldPatterns: guestHeld, server: "proc", tool: "exec", args: { cmd: "echo nope" } });
  const norWrite = await kernel.call({ principalId: guest.principalId, heldPatterns: guestHeld, server: "fs", tool: "write", args: { path: "x", content: "y" } });
  check(can.ok, "they can do exactly what they were given");
  check(!cannot.ok && cannot.code === "denied", `and nothing else — a refusal with a code (${cannot.code})`);
  check(!norWrite.ok, "reading a file does not imply writing one");
  await desktop("open", { app: "access" });
  await page.waitForTimeout(1200);
  await shot(page, "05-access");

  // ── 6 · Break it, see it break, fix it ────────────────────────────────────
  scene(6, "Break the code, watch the job fail out loud, fix it from Files");
  for (const j of (await mcp("proc", "jobs", {})).jobs.filter((x) => x.state === "running")) await mcp("proc", "stop", { id: j.id });
  await until(async () => !(await listening("day two")()) && !(await listening("day one")()), "the port to come free");
  await mcp("fs", "write", { path: "app/server.js", content: "throw new Error('the day broke');\n" });
  const broken = await mcp("proc", "start", { cmd: "node app/server.js", name: "web-broken" });
  const ended = await until(async () => (await mcp("proc", "logs", { id: broken.id })).state !== "running", "the broken job to exit");
  const brokenLogs = await mcp("proc", "logs", { id: broken.id });
  check(ended && brokenLogs.state === "failed", `the job reads as failed, not as finished (${brokenLogs.state}, code ${brokenLogs.code})`);
  check(brokenLogs.logs.some((l) => /the day broke/.test(l.text)), "and its log says why, in the window where you started it");

  await mcp("fs", "write", { path: "app/server.js", content: serverSource("day two") });
  await mcp("proc", "start", { cmd: "node app/server.js", name: "web" });
  const recovered = await until(serves("day two"), "the fixed server to answer through the proxy", 30_000);
  check(recovered, "the fix is live at the same URL, with nothing to reconfigure");
  await shot(page, "06-broken-and-fixed");

  // ── 7 · Review ────────────────────────────────────────────────────────────
  scene(7, "Review: a change proposed, read before it happens, applied, and one part undone");
  console.log("     (a model turn needs a provider credential; this drives the tools an assistant turn writes)");
  const wasRev = (await desktop("state")).rev;
  const widgetsBefore = (await desktop("state")).doc.widgets.length;
  const proposal = (await desktop("propose", {
    label: "tidy this workspace and add a clock",
    ops: [
      { tool: "arrange", args: { preset: "grid", viewport: { w: 1500, h: 950 } } },
      { tool: "widgetAdd", args: { kind: "clock" } },
    ],
  })).proposal;
  const pending = await desktop("proposals", {});
  check(pending.proposals.length === 1 && pending.proposals[0].ops.length === 2,
    "the proposal is a document object with the calls it would make, readable before anything happens");
  check((await desktop("state")).doc.widgets.length === widgetsBefore, "and nothing has happened yet");

  const applied = await desktop("applyProposal", { id: proposal.id });
  check(applied.ok && applied.applied.length === 2, `applying it runs both ops as you (${applied.applied.join(", ")})`);
  check((await desktop("state")).doc.widgets.length === widgetsBefore + 1, "the widget is there");
  check((await desktop("proposals", {})).proposals.length === 0, "and the proposal is gone from the queue");

  // Each op was its own revision, so the alignment can be undone without
  // touching the widget: the point of a proposal being ops rather than a blob.
  const { revisions } = await desktop("history", {});
  const arrangeRev = revisions.find((h) => /arrange/i.test(h.label ?? "") && h.rev > wasRev);
  if (check(!!arrangeRev, "the history names which revision was the alignment")) {
    const moved = (await desktop("state")).doc.windows.map((w) => `${w.id}:${w.x},${w.y}`).join("|");
    await desktop("revert", { rev: arrangeRev.rev, only: ["windows"] });
    const afterUndo = (await desktop("state")).doc;
    check(afterUndo.widgets.length === widgetsBefore + 1, "undoing the alignment leaves the widget that came after it alone");
    check(afterUndo.windows.map((w) => `${w.id}:${w.x},${w.y}`).join("|") !== moved, "and the windows are back where they were");
    const scopes = (await desktop("revertScopes", {})).scopes;
    check(scopes.includes("windows") && scopes.includes("theme"), `the machine says what else an undo can be aimed at (${scopes.length} parts)`);
  }
  await page.waitForTimeout(800);
  await shot(page, "07-review");

  // ── 8 · Studio ────────────────────────────────────────────────────────────
  scene(8, "Studio: an app with a companion tool, its error surfaced, then published");
  await desktop("appDefine", {
    id: "day-app", name: "Day App", description: "what the day built",
    permissions: ["ports.list", "day-app.*"], starter: "tools",
  });
  const catalogue = await mcp("kernel", "tools", {});
  check(catalogue.tools.some((t) => t.name === "day-app.ping"), "the app's companion server is in the machine's tool catalogue");

  await desktop("appWrite", { id: "day-app", path: "app.js", content: [
    "const out = document.getElementById('out');",
    "const r = await sbx.mcp('ports', 'list', {});",
    "const mine = await sbx.mcp('day-app', 'ping', {});",
    "out.textContent = 'ports:' + r.ports.length + ' pong:' + !!mine.pong;",
    "sbx.ready();",
    "boom();   // deliberate: an app's error has to reach the person editing it",
  ].join("\n") });
  const appWin = (await desktop("open", { app: "day-app" })).window;
  const frameUp = await until(async () => !!page.frames().find((f) => f.url().includes("/day-app/")), "the app's frame");
  check(frameUp, "the app's frame is loaded");
  const ranFrame = page.frames().find((f) => f.url().includes("/day-app/"));
  const shown = ranFrame ? await until(async () => /^ports:\d+ pong:true$/.test((await ranFrame.locator("#out").textContent().catch(() => "")) ?? ""), "the app to run") : false;
  check(shown, `its module ran and called both a machine tool and its own (${ranFrame ? await ranFrame.locator("#out").textContent().catch(() => "—") : "—"})`);

  const logged = await page.evaluate(async () => {
    const { frameLogs } = await import("/static/js/os/frames.js");
    return frameLogs("day-app").map((l) => `${l.level}: ${l.text}`);
  });
  check(logged.some((l) => /boom/.test(l)), `the app's own error reached the shell, where the Studio shows it (${logged.length} lines)`);

  await desktop("appWrite", { id: "day-app", path: "app.js", content: [
    "const out = document.getElementById('out');",
    "const r = await sbx.mcp('ports', 'list', {});",
    "out.textContent = 'ports:' + r.ports.length;",
    "sbx.ready();",
  ].join("\n") });
  await page.waitForTimeout(2000);

  const published = await desktop("distroPublish", {
    name: "day-box", description: "the machine this day built",
    visibility: "public", tags: ["day"], replace: true,
  });
  check(published.apps >= 1 && published.tools >= 1, `publishing packages the app's source and its tool face (${published.apps} apps, ${published.tools} with tools)`);
  await desktop("close", { id: appWin.id });
  await shot(page, "08-studio");

  // ── 9 · Someone else ──────────────────────────────────────────────────────
  scene(9, "A second tenant: finds it, forks it, and calls its tool with no window open");
  const otherName = `day-other-${crypto.randomUUID().slice(0, 6)}`;
  const otherTenant = createTenant(`${otherName}-tenant`);
  const other = createAccount(otherTenant.id, { username: otherName, password: "pw" });
  const otherSandbox = createSandboxForTenant(otherTenant.id, other.principalId, {
    slug: otherName, name: "their machine", cellBackend: "local",
  });
  const otherKernel = await getKernel(otherSandbox);
  const otherHeld = grantsFor(other.principalId, otherSandbox.id);
  const theirs = async (server, tool, args = {}) => {
    const r = await otherKernel.call({ principalId: other.principalId, heldPatterns: otherHeld, server, tool, args });
    if (!r.ok) throw new Error(`${server}.${tool}: ${r.error}`);
    return r.result;
  };
  const gallery = await theirs("desktop", "distroList", { q: "day-box" });
  const found = gallery.distros.find((d) => d.name === "day-box");
  if (check(!!found, "the distro is in the gallery from another tenant, because it was published publicly")) {
    const forked = await theirs("desktop", "distroFork", { id: found.id });
    const theirDoc = (await theirs("desktop", "state", {})).doc;
    check(!!theirDoc.apps["day-app"], "forking brings the app and its source with it");
    check(theirDoc.windows.length >= 1, `and they land in an arranged desktop rather than an empty one (${theirDoc.windows.length} windows)`);
    // A stranger's companion server arrives switched off. A distro is a
    // document, not a grant: running someone else's code is their decision.
    check(forked.tools.every((t) => t.enabled === false), "a stranger's companion server arrives switched off");
    const beforeOn = await otherKernel.call({ principalId: other.principalId, heldPatterns: otherHeld, server: "day-app", tool: "ping", args: {} });
    check(!beforeOn.ok, "and until they turn it on, it serves nothing");

    await theirs("desktop", "appDefine", { id: "day-app", mcp: { enabled: true } });
    const answer = await otherKernel.call({ principalId: other.principalId, heldPatterns: otherHeld, server: "day-app", tool: "ping", args: {} });
    check(answer.ok && answer.result?.pong, "once they switch it on, an agent can call its tool with no window open");
  }

  // ── 10 · The phone ────────────────────────────────────────────────────────
  scene(10, "The phone: the same document at 390px, with the work still running");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  const front = await page.$$eval(".os-window", (els) => els.filter((e) => !e.hidden).length);
  check(front === 1, `one front window instead of a pile of tiny ones (${front})`);
  check(await page.$(".os-dock .dock-app .lbl"), "the dock becomes a labelled app switcher");
  check(await page.$(".os-shelf"), "and the widgets fold into a shelf rather than disappearing");
  await press(".os-shelf-handle");
  await page.waitForTimeout(500);
  check((await page.$$eval(".os-shelf-body .os-widget", (els) => els.filter((e) => !e.hidden).length)) >= 1, "the shelf holds the workspace's widgets");
  check(await serves("day two")(), "the server is still serving while you look at it on a phone");
  const stillRunning = (await mcp("proc", "jobs", {})).jobs.filter((j) => j.state === "running");
  check(stillRunning.length >= 1, `and the supervised job is still running (${stillRunning.map((j) => j.name).join(", ")})`);
  await shot(page, "10-phone");
  await page.setViewportSize({ width: 1500, height: 950 });

  // ── and the machine can account for the day ───────────────────────────────
  scene("—", "Nothing broke on the way, and the machine can account for it");
  // Act 8 threw on purpose, to prove an app's error reaches the person editing
  // it. Everything else has to be silent.
  const unexpected = pageErrors.filter((e) => !/boom is not defined/.test(e));
  check(unexpected.length === 0, `nothing but the deliberate error in the whole day (${unexpected.slice(0, 2).join(" | ") || "none"})`);
  const chain = await mcp("kernel", "auditVerify", {});
  check(chain.ok, `the audit log covers all of it, unbroken (${chain.count} rows)`);
  const rollup = await mcp("metrics", "activity", {});
  check((rollup.byTool ?? []).length > 5, `and can say what was used and how long it took (${(rollup.byTool ?? []).length} tools)`);
  const limits = await mcp("kernel", "limits", {});
  check(limits.using.sessions >= 1, "and what the machine is using while it does it");
} catch (e) {
  failures.push(`${act} · threw: ${e.message}`);
  console.log(`\n  ! ${e.stack?.split("\n").slice(0, 4).join("\n    ") ?? e.message}`);
  if (page) await shot(page, "99-threw");
} finally {
  await browser.close().catch(() => {});
  try {
    const { stopAllProcsEverywhere } = await import("../packages/kernel/src/servers/proc.js");
    stopAllProcsEverywhere();
  } catch { /* older shape: the jobs die with the process */ }
  killAllSessionsEverywhere();
  srv.close();
  _resetKernels();
  closeDb();
}

console.log(`\nscreenshots: ${shots}`);
if (failures.length) {
  console.log(`\nthe day failed at:\n${failures.map((f) => `  · ${f}`).join("\n")}\n`);
  process.exit(1);
}
console.log("\na whole day, without leaving the OS\n");
process.exit(0);
