#!/usr/bin/env node
// Browser smoke for the OS and the Studio — the part unit tests cannot reach.
//
// Boots a throwaway Gateway on a temp home (the same isolation the test suite
// uses), drives a headless Chromium through the real pages, and fails on any
// page error or console error. Not part of `npm test`: it needs a browser. Run
// it with `npm run smoke`; CHROME=/path/to/chrome overrides the binary.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const home = path.join(os.tmpdir(), `sandboxos-smoke-${crypto.randomUUID().slice(0, 8)}`);
process.env.SANDBOXOS_HOME = home;
process.env.SANDBOXOS_CELL_BACKEND = "local";
process.env.SANDBOXOS_PASSWORD = "test";

const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
const { ensureSeed, createSession, grantsFor } = await import("../packages/control-db/src/registry.js");
const { getKernel, _resetKernels } = await import("../packages/kernel/src/kernel.js");
const { createServer } = await import("../apps/gateway/src/server.js");
const { chromium } = await import("playwright-core");

const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

openDb();
const { owner, sandbox } = ensureSeed("local");
const kernel = await getKernel(sandbox);
const held = grantsFor(owner.id, sandbox.id);
const desktop = async (tool, args = {}) => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
  if (!r.ok) throw new Error(`desktop.${tool}: ${r.error}`);
  return r.result;
};
const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;
const session = createSession(owner.id, "session");

const { findChrome, noChromeMessage } = await import("./lib/chrome.mjs");
const executablePath = findChrome();
if (!executablePath) { console.error(noChromeMessage()); process.exit(2); }
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addCookies([{ name: "sbx_session", value: session, url: base }]);

const errors = [];
function watch(page, label) {
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${label}] console: ${m.text()}`); });
}

try {
  // ── The OS ────────────────────────────────────────────────────────────────
  console.log("OS");
  await desktop("reset", {});

  // A machine nobody has set up shows the welcome screen first (goal.md T5.1),
  // so the smoke sees that, then skips it. `npm run day` drives the real setup.
  const firstPage = await ctx.newPage();
  watch(firstPage, "first-run");
  await firstPage.goto(`${base}/${sandbox.slug}/os`);
  await firstPage.waitForSelector(".fr-panel", { timeout: 15_000 });
  check((await firstPage.$$(".fr-seed")).length >= 4, "a new machine asks what it should start as");
  check((await firstPage.$$(".fr-card")).length === 4, "and explains the document model on one screen");
  check(!!(await firstPage.$(".fr-skip")), "with a way to skip it");
  await firstPage.close();
  await desktop("setup", { skip: true });

  const page = await ctx.newPage();
  watch(page, "os");
  await page.goto(`${base}/${sandbox.slug}/os`);
  await page.waitForSelector(".os-window", { timeout: 15_000 });
  check((await page.$$(".os-window")).length >= 2, "the first-run desktop paints its windows");
  check(await page.$(".os-menubar .status"), "menubar carries real status readings");
  check(await page.$(".os-dock .dock-app"), "the dock is there");

  // A window move costs a window move (goal.md T0.5). The stylesheet is linked by
  // appearance, so ten agent moves ask for nothing; a theme change asks once.
  let cssAsks = 0;
  page.on("request", (r) => { if (r.url().includes("/os/theme.css")) cssAsks += 1; });
  await page.waitForTimeout(400);
  const movee = (await desktop("state")).doc.windows[0].id;
  cssAsks = 0;
  for (let i = 0; i < 10; i += 1) await desktop("move", { id: movee, x: 60 + i * 4, y: 60 });
  await page.waitForTimeout(900);
  check(cssAsks === 0, `ten agent moves cost no stylesheet requests (${cssAsks})`);
  await desktop("themeSet", { theme: "aurora" });
  await page.waitForTimeout(900);
  check(cssAsks === 1, `and a theme change costs exactly one (${cssAsks})`);
  await desktop("themeSet", { theme: "midnight" });
  await page.waitForTimeout(500);

  await desktop("layoutSet", { mode: "tiling", preset: "master-stack" });
  await page.waitForSelector(".os-sash", { timeout: 8_000 });
  const sashes = await page.$$(".os-sash");
  check(sashes.length >= 1, "tiling paints sashes between siblings");
  const before = (await desktop("state")).doc;
  const wsB = before.workspaces.find((w) => w.n === before.activeWorkspace);
  const sash = sashes[0];
  const box = await sash.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = (await desktop("state")).doc;
  const wsA = after.workspaces.find((w) => w.n === after.activeWorkspace);
  check(wsA.layout.ratio !== wsB.layout.ratio, `dragging a sash commits one desktop.tile (ratio ${wsB.layout.ratio} → ${wsA.layout.ratio})`);
  check(after.rev === before.rev + 1, "and it is exactly one revision");
  check(await page.$(".os-window.front"), "the front leaf wears a focus ring");
  await desktop("layoutSet", { mode: "floating" });

  // A stale write from the shell: move a window under it, then drag.
  const win = (await desktop("state")).doc.windows[0];
  const title = await page.$(`.os-window[data-id="${win.id}"] .os-titlebar`);
  const tb = await title.boundingBox();
  await page.mouse.move(tb.x + 80, tb.y + 10);
  await page.mouse.down();
  await page.mouse.move(tb.x + 140, tb.y + 60, { steps: 6 });
  await desktop("move", { id: win.id, x: 5, y: 5 }); // the agent wins the race
  await page.mouse.up();
  await page.waitForTimeout(900);
  const raced = (await desktop("state")).doc.windows.find((w) => w.id === win.id);
  check(raced.x === 5 && raced.y === 5, "a drag that lost the race does not overwrite the agent's move");
  check(await page.$(".toast"), "and the shell says so");

  // Spotlight opens and lists layout presets.
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".os-spotlight input");
  await page.type(".os-spotlight input", "master");
  await page.waitForTimeout(150);
  check((await page.textContent(".os-spotlight .results")).includes("Master and stack"), "spotlight offers the tree presets");
  await page.keyboard.press("Escape");

  // A real shell in the Terminal window: a prompt on a pty, no tty complaint.
  await desktop("open", { app: "terminal" });
  await page.waitForSelector(".term-screen", { timeout: 8_000 });
  await page.waitForTimeout(1500);
  const termText = await page.$eval(".term-screen", (el) => el.textContent);
  check(!/can't access tty/.test(termText), "the shell does not complain about a missing tty");
  check(/[$#] ?$/m.test(termText.trim()) || /\$|#/.test(termText), `the shell shows a prompt (${JSON.stringify(termText.slice(-60))})`);
  check(await page.$(".term-tab"), "the Terminal has tabs");

  // Browser quick access: a service that is merely listening shows up, and one click opens it.
  const http = await import("node:http");
  const svc = http.createServer((_req, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<h1 id=hello>hello from the cell</h1>"); });
  await new Promise((r) => svc.listen(0, "127.0.0.1", r));
  const svcPort = svc.address().port;
  await desktop("open", { app: "browser" });
  await page.waitForSelector(".browser-empty", { timeout: 8_000 });
  await page.waitForFunction((p) => [...document.querySelectorAll(".browser-empty .app-btn")].some((b) => b.textContent.includes(`:${p}`)), svcPort, { timeout: 10_000 });
  check(true, "a listening port appears in quick access without being exposed first");
  await page.click(`.browser-empty .app-btn:has-text(":${svcPort} — open")`);
  await page.waitForSelector(`.os-window iframe[title="port ${svcPort}"]`, { timeout: 8_000 });
  await page.waitForTimeout(800);
  const exposedNow = (await page.evaluate(async () => (await fetch(`/${location.pathname.split("/")[1]}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "ports", tool: "list", args: {} }) }).then((r) => r.json())).result.ports.map((p) => p.port)));
  check(exposedNow.includes(svcPort), "one click exposed the port through ports.expose");
  const frameOk = await page.frames().some((f) => f.url().includes(`/p/${svcPort}/`));
  check(frameOk, "and the window shows the service through the Gateway proxy");
  // Tidy: the service goes away, so the window pointing at it goes too.
  for (const w of (await desktop("state")).doc.windows.filter((x) => x.app === "browser" || x.app === "terminal")) await desktop("close", { id: w.id });
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "ports", tool: "unexpose", args: { port: svcPort } });
  svc.close();

  // A custom app actually RUNS. This is the assertion whose absence hid a real
  // bug for a whole phase: the frame runs at an opaque origin, so its module
  // scripts were CORS-blocked and every app's JavaScript silently never
  // executed. Writing files and serving them is not the same as an app working.
  await desktop("appDefine", { id: "runs-app", name: "Runs", permissions: ["ports.list"] });
  await desktop("appWrite", {
    id: "runs-app", path: "app.js",
    content: [
      "const el = document.createElement('div');",
      "el.id = 'ran';",
      "document.body.append(el);",
      "const r = await sbx.mcp('ports', 'list', {});",
      "el.textContent = 'ports:' + (r.ports ? r.ports.length : '?');",
      "sbx.ready();",
      // A warning rather than an error: the smoke fails on console errors, and
      // this one is on purpose. Both travel to the shell.
      "console.warn('runs-app says hello from the frame');",
    ].join("\n"),
  });
  await desktop("open", { app: "runs-app" });
  await page.waitForTimeout(2500);
  const appFrame = page.frames().find((f) => f.url().includes("/runs-app/"));
  check(!!appFrame, "a custom app's frame is loaded");
  const ranText = appFrame ? await appFrame.locator("#ran").textContent().catch(() => null) : null;
  check(/^ports:\d+$/.test(ranText ?? ""), `its module ran and called through the broker (${ranText})`);

  // …and what it printed reaches the shell, so the Studio can show it.
  const reported = await page.evaluate(async () => {
    const { frameLogs } = await import("/static/js/os/frames.js");
    return frameLogs("runs-app").map((l) => l.text);
  });
  check(reported.some((t) => t.includes("hello from the frame")), "and its console output is collected for the Studio");
  for (const w of (await desktop("state")).doc.windows.filter((x) => x.app === "runs-app")) await desktop("close", { id: w.id });
  await desktop("appRemove", { id: "runs-app" });

  // The Manual: the repository's own documentation, rendered, and the machine's
  // own tool catalogue. Both halves are read at open time, so this is the check
  // that would have caught a renderer that never returns (goal.md T5.2).
  await desktop("open", { app: "help" });
  await page.waitForSelector(".help-list .row-line", { timeout: 10_000 });
  const manualRows = await page.$$eval(".help-list .row-line", (els) => els.map((e) => e.textContent));
  check(manualRows.some((t) => t.includes("The desktop")), `the manual lists the pages this build ships (${manualRows.length} rows)`);
  await page.click(".help-list .row-line:has-text('The desktop')");
  await page.waitForSelector(".md .md-h", { timeout: 10_000 });
  const rendered = await page.$$eval(".md .md-h", (els) => els.map((e) => e.textContent));
  check(rendered.length > 10, `a page renders its headings (${rendered.length})`);
  check((await page.$$(".md .md-code")).length >= 1 && (await page.$$(".md .md-table")).length >= 1, "with its code blocks and tables");
  check((await page.textContent(".help-source")).includes("docs/15-os-experience.md"), "and says which file it is");

  await page.fill(".app-bar .ops-search", "revert");
  await page.waitForTimeout(400);
  const hits = await page.$$eval(".help-list .row-line", (els) => els.map((e) => e.textContent));
  check(hits.some((t) => t.includes("desktop.revert")), "search finds tools as well as headings");
  await page.click(".help-list .row-line:has-text('desktop.revert')");
  await page.waitForTimeout(300);
  const toolPane = await page.textContent(".help-pane");
  check(/Arguments/.test(toolPane) && /rev/.test(toolPane), "a tool page says what it takes");
  await page.click(".help-pane .app-btn:has-text('Try it')");
  await page.waitForSelector(".os-spotlight input", { timeout: 6_000 });
  check(await page.inputValue(".os-spotlight input") === "desktop.revert", "Try it hands you to Spotlight with the tool typed in");
  const spotRows = await page.$$eval(".os-spotlight .spot-row", (els) => els.map((e) => e.textContent));
  check(spotRows.some((t) => t.includes("desktop.revert")), "and Spotlight knows the machine's tools");
  await page.keyboard.press("Escape");
  for (const w of (await desktop("state")).doc.windows.filter((x) => x.app === "help")) await desktop("close", { id: w.id });

  // The terminal screen: cursor addressing, an alternate buffer, scroll regions.
  const term = await page.evaluate(async () => {
    const { createScreen } = await import("/static/js/os/ansi.js");
    const host = document.createElement("div");
    document.body.append(host);
    const s = createScreen(host, { cols: 20, rows: 4 });
    const text = () => [...host.querySelectorAll(".t-line")].map((l) => l.textContent.replace(/\s+$/, ""));
    s.write("one\r\ntwo\r\n");
    s.write("\x1b[1;1Hzap");                       // overwrite at row 1, col 1
    await new Promise((r) => requestAnimationFrame(r));
    const main = text();
    s.write("\x1b[?1049h\x1b[2J\x1b[3;5HALT");    // alternate screen, cursor to 3,5
    await new Promise((r) => requestAnimationFrame(r));
    const alt = text();
    const altMode = s.alt;
    s.write("\x1b[?1049l");                        // back to main
    await new Promise((r) => requestAnimationFrame(r));
    const back = text();
    s.write("\x1b[2;3r\x1b[3;1Ha\nb\nc");          // scroll region rows 2-3
    await new Promise((r) => requestAnimationFrame(r));
    const region = text();
    host.remove();
    return { main, alt, altMode, back, region };
  });
  check(term.main[0] === "zap" && term.main[1] === "two", `cursor addressing overwrites in place (${JSON.stringify(term.main)})`);
  check(term.altMode && term.alt.length === 4 && term.alt[2] === "    ALT", `the alternate buffer is exactly the screen (${JSON.stringify(term.alt)})`);
  check(term.back[0] === "zap", "leaving the alternate buffer restores the main one");
  check(term.region[0] === "zap" && !term.region.includes("a"), `a scroll region scrolls only its rows (${JSON.stringify(term.region)})`);

  // Notifications: a deep link and a per-item dismiss.
  const noteWin = (await desktop("state")).doc.windows[0];
  await desktop("notify", { title: "smoke says hi", action: { window: noteWin.id } });
  await page.waitForTimeout(400);
  await page.click(".os-menubar .icon-btn[title='Notifications']");
  await page.waitForSelector(".os-notifs .notif");
  check((await page.textContent(".os-notifs")).includes("smoke says hi"), "the notification centre groups and lists");
  await page.click(".os-notifs .notif .dismiss");
  await page.waitForTimeout(400);
  check(!(await desktop("state")).doc.notifications.some((n) => n.title === "smoke says hi"), "dismissing one is one notificationsClear{id}");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+?");
  await page.waitForSelector(".os-keys", { timeout: 4000 });
  check(true, "⌘? shows the cheat sheet");
  await page.keyboard.press("Escape");

  // ── Keyboard only, and named ──────────────────────────────────────────────
  //
  // An OS you can only drive with a mouse is a mock-up of one (goal.md T4.5).
  // This drives the real thing with the keyboard and checks that the chrome
  // announces itself.
  const roles = await page.evaluate(() => ({
    menubar: document.querySelector('.os-menubar')?.getAttribute('role'),
    dock: document.querySelector('.os-dock')?.getAttribute('role'),
    dockLabel: document.querySelector('.os-dock')?.getAttribute('aria-label'),
    desktop: document.querySelector('.os-desktop')?.getAttribute('role'),
    window: document.querySelector('.os-window')?.getAttribute('aria-label'),
    titlebar: document.querySelector('.os-window .os-titlebar')?.getAttribute('tabindex'),
  }));
  check(roles.menubar === 'menubar' && roles.dock === 'toolbar' && roles.desktop === 'main',
    `the chrome has roles (${roles.menubar}/${roles.dock}/${roles.desktop})`);
  check(!!roles.window && !!roles.dockLabel, 'and names a screen reader can read');
  check(roles.titlebar === '0', 'a window title bar is focusable');

  // Move a window with the keyboard alone, through its title bar.
  await desktop('layoutSet', { mode: 'floating' });
  const kbWin = (await desktop('state')).doc.windows[0];
  await page.focus(`.os-window[data-id="${kbWin.id}"] .os-titlebar`);
  const kbBefore = (await desktop('state')).doc.windows.find((w) => w.id === kbWin.id);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const kbAfter = (await desktop('state')).doc.windows.find((w) => w.id === kbWin.id);
  check(kbAfter.x === kbBefore.x + 8, `arrow keys move the focused window (${kbBefore.x} → ${kbAfter.x})`);
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Alt');
  await page.waitForTimeout(500);
  const kbSized = (await desktop('state')).doc.windows.find((w) => w.id === kbWin.id);
  check(kbSized.h === kbAfter.h + 8, `alt+arrow resizes it (${kbAfter.h} → ${kbSized.h})`);

  // A sash is a separator you can move without a pointer.
  await desktop('layoutSet', { mode: 'tiling', preset: 'master-stack' });
  await page.waitForSelector('.os-sash', { timeout: 8_000 });
  const sashRatio = () => desktop('state').then((s) => s.doc.workspaces.find((w) => w.n === s.doc.activeWorkspace).layout.ratio);
  const ratioBefore = await sashRatio();
  check(await page.$eval('.os-sash', (el) => el.getAttribute('role') === 'separator' && el.getAttribute('tabindex') === '0'),
    'a sash is a focusable separator');
  await page.focus('.os-sash');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  check((await sashRatio()) > ratioBefore, `and arrow keys resize the split (${ratioBefore} → ${await sashRatio()})`);
  await desktop('layoutSet', { mode: 'floating' });

  // An overlay takes focus, so Escape and typing mean what they look like.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.os-spotlight input');
  const focused = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
  check(focused === 'input', `an overlay takes focus (${focused})`);
  check(await page.$eval('.os-spotlight', (el) => el.getAttribute('aria-modal') === 'true'), 'and says it is a dialog');
  await page.keyboard.press('Escape');


  // Compact: 390px wide.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  const visible = await page.$$eval(".os-window", (els) => els.filter((e) => !e.hidden).length);
  check(visible === 1, `phone width shows one front window (${visible})`);
  check(await page.$(".os-dock"), "the dock stays reachable on a phone");
  check(await page.$(".os-shelf"), "widgets go into a shelf instead of vanishing");
  await page.click(".os-shelf-handle");
  await page.waitForTimeout(400);
  check((await page.$$eval(".os-shelf-body .os-widget", (els) => els.filter((e) => !e.hidden).length)) >= 1, "the shelf holds the workspace's widgets");
  check((await page.$$eval(".os-dock .dock-app .lbl", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length)) >= 1, "dock icons carry labels on a phone");
  await desktop("workspaceAdd", { name: "Two", switchTo: false });
  await page.waitForTimeout(400);
  check((await page.$$(".os-ws-dots button")).length === 2, "workspace dots appear with a second workspace");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.close();

  // ── The Studio ────────────────────────────────────────────────────────────
  console.log("Studio");
  await desktop("appDefine", { id: "smoke-app", name: "Smoke", permissions: ["fs.read"] });
  const studio = await ctx.newPage();
  watch(studio, "studio");
  await studio.goto(`${base}/${sandbox.slug}/studio`);
  await studio.waitForSelector(".stx-builder", { timeout: 15_000 });
  await studio.waitForSelector(".stx-viewport .os-window", { timeout: 10_000 });
  check(true, "the Studio boots with the live OS as its stage");

  // The stage renders a *machine*, not the pane it happens to sit in: a narrow
  // split view used to fold the desktop into a phone, which is the wrong answer
  // to "design my desktop" (goal.md T2.1).
  const staged = await studio.$eval(".stx-viewport .os-screen", (el) => ({
    w: el.offsetWidth, painted: Math.round(el.getBoundingClientRect().width),
  }));
  check(staged.w >= 1440, `the stage is a desktop-sized viewport (${staged.w}px)`);
  check(staged.painted < staged.w, `and it is scaled to fit the pane (${staged.painted}px painted)`);
  check(!(await studio.$eval(".stx-viewport .os-desktop", (el) => el.classList.contains("compact"))),
    "so the builder is not showing a phone");
  check((await studio.$$(".stx-viewport .os-window:not([hidden])")).length >= 2,
    "every window on the workspace is visible on the stage");
  await studio.click(".stx-stage-bar .seg:has-text('Phone')");
  await studio.waitForTimeout(600);
  check(await studio.$eval(".stx-viewport .os-desktop", (el) => el.classList.contains("compact")),
    "and the Phone preset renders the fold on purpose");
  await studio.click(".stx-stage-bar .seg:has-text('Desktop')");
  await studio.waitForTimeout(600);

  await studio.click(".stx-tabs .seg:has-text('Code')");
  await studio.waitForSelector(".code-pane .ed-input", { timeout: 8_000 });
  check((await studio.$$(".code-file")).length >= 3, "the Code tab lists the starter's files");
  await studio.click(".code-file:has-text('app.css')");
  await studio.waitForSelector(".code-tab.on .name:has-text('app.css')", { timeout: 5_000 });
  await studio.waitForTimeout(300);
  await studio.focus(".code-pane .ed-input");
  await studio.keyboard.press("Control+End");
  await studio.keyboard.type("\n.smoke { color: red; }\n");
  await studio.keyboard.press("Control+s");
  await studio.waitForTimeout(600);
  const css = await desktop("appRead", { id: "smoke-app", path: "app.css" });
  check(css.content.includes(".smoke { color: red; }"), "⌘S in the editor is desktop.appWrite");

  await desktop("appWrite", { id: "smoke-app", path: "app.js", content: "// written by an agent\nsbx.ready();\n" });
  await studio.waitForTimeout(800);
  check((await studio.textContent(".code-status")).includes("written by another editor") || (await studio.$(".code-tab.on .name:has-text('app.js')")),
    "an agent's appWrite lands in the open editor");

  // Settings reshapes the desktop without the Studio.
  await desktop("open", { app: "settings" });
  await studio.waitForSelector(".stx-viewport .os-window .kv", { timeout: 8_000 });
  check((await studio.$$(".stx-viewport .os-window .kv")).length >= 12, "Settings has a full Desktop section");
  // Scheduled snapshots live in Settings beside the checkpoints they make
  // (goal.md T3.4). The button is the whole feature: a cron job that calls
  // desktop.checkpoint, which is why there is nothing else to check here.
  check(await studio.$(".stx-viewport .os-window .app-btn:has-text('Snapshot on a schedule…')"),
    "and a way to snapshot the desktop on a schedule");

  await studio.click(".stx-tabs .seg:has-text('Theme')");
  await studio.waitForSelector(".token-row", { timeout: 5_000 });
  // Every colour token the compiler emits, including the status colours a job
  // list and an audit row are painted with — the panel follows THEME_TOKENS
  // rather than a hardcoded list, so this counts what the grammar has.
  const tokenRows = await studio.$$eval(".token-row", (els) => els.map((e) => e.textContent.trim().split(/\s+/)[0]));
  check(tokenRows.length >= 15, `the theme studio edits every colour token (${tokenRows.length})`);
  check(["ok", "warn", "err"].every((t) => tokenRows.some((r) => r.startsWith(t))), "including the status colours");
  check(await studio.$(".wall-builder"), "and has a wallpaper builder");

  await studio.click(".stx-tabs .seg:has-text('Motion')");
  await studio.waitForSelector(".lib-row", { timeout: 5_000 });
  await studio.click(".lib-row:has-text('Spring') .rail-btn.sm");
  await studio.waitForSelector(".motion-sample", { timeout: 5_000 });
  check((await studio.$$(".motion-row")).length >= 12, "the motion designer exposes the number grammar");

  await studio.keyboard.press("Control+Shift+p");
  await studio.waitForSelector(".stx-palette input", { timeout: 5_000 });
  check(true, "⌘⇧P opens the Studio palette");
  await studio.keyboard.press("Escape");

  // Wave C/D: a "UI + tools" app from the Library, and the gallery.
  await studio.click(".stx-tabs .seg:has-text('Library')");
  await studio.waitForSelector(".card-grid");
  await desktop("appDefine", { id: "toolful", name: "Toolful", starter: "tools" });
  await studio.waitForTimeout(700);
  check((await studio.textContent(".card-grid")).includes("3 tools"), "the Library shows how many tools an app serves");
  await studio.click(".chip:has-text('Distros')");
  await studio.waitForSelector(".distro-card", { timeout: 8_000 });
  check((await studio.$$(".distro-card .distro-thumb svg")).length >= 5, "gallery cards carry silhouettes, not screenshots");
  await desktop("distroPublish", { name: "Smoke Box", tags: ["smoke"], visibility: "public", replace: true });
  await studio.fill(".stx-scroll input[placeholder^='Search']", "smoke");
  await studio.waitForTimeout(600);
  check((await studio.textContent(".stx-scroll")).includes("Smoke Box"), "the gallery searches by tag");
  check(await studio.$(".distro-card .vis.public"), "and shows who can see a distro");
  await studio.fill(".stx-scroll input[placeholder^='Search']", "");
  await studio.waitForTimeout(500);

  // Multi-select two windows on the stage in design mode and align them.
  await studio.click(".stx-tabs .seg:has-text('Layers')");
  await studio.waitForSelector(".layer-row");
  // Selecting re-renders the panel, so query afresh for the second click.
  await studio.locator(".layer-line .layer-row").nth(0).click();
  await studio.waitForTimeout(150);
  await studio.locator(".layer-line .layer-row").nth(1).click({ modifiers: ["Shift"] });
  await studio.waitForTimeout(200);
  check(await studio.$(".align-grid"), "shift-click builds a multi-selection with align tools");
  const revBefore = (await desktop("state")).rev;
  await studio.click(".align-grid .ghost[title='Left edges']");
  await studio.waitForTimeout(700);
  const st = (await desktop("state")).doc;
  // Layers lists windows front-most first, so the two rows clicked are the two highest z.
  const sel = st.windows.filter((w) => w.ws === st.activeWorkspace).sort((p, q) => q.z - p.z).slice(0, 2);
  check(sel.length === 2 && sel[0].x === sel[1].x, "align left puts both windows on one edge");
  check((await desktop("state")).rev === revBefore + 1, "as one revision");
  await studio.close();
} catch (e) {
  failures.push(`threw: ${e.stack ?? e.message}`);
} finally {
  await browser.close();
  srv.close();
  _resetKernels();
  closeDb();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
}

for (const e of errors) { console.log(`  ! ${e}`); }
for (const f of failures) if (f.startsWith("threw")) console.log(`  ! ${f}`);
if (errors.length) failures.push(`${errors.length} browser errors`);
console.log(failures.length ? `\nFAILED: ${failures.length}` : "\nall good");
process.exit(failures.length ? 1 : 0);
