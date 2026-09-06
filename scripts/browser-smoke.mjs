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

const candidates = [process.env.CHROME, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
const executablePath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
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
  const page = await ctx.newPage();
  watch(page, "os");
  await page.goto(`${base}/${sandbox.slug}/os`);
  await page.waitForSelector(".os-window", { timeout: 15_000 });
  check((await page.$$(".os-window")).length >= 2, "the first-run desktop paints its windows");
  check(await page.$(".os-menubar .status"), "menubar carries real status readings");
  check(await page.$(".os-dock .dock-app"), "the dock is there");

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

  // Compact: 390px wide.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  const visible = await page.$$eval(".os-window", (els) => els.filter((e) => !e.hidden).length);
  check(visible === 1, `phone width shows one front window (${visible})`);
  check(await page.$(".os-dock"), "the dock stays reachable on a phone");
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

  await studio.click(".stx-tabs .seg:has-text('Code')");
  await studio.waitForSelector(".code-pane .ed-input", { timeout: 8_000 });
  check((await studio.$$(".code-file")).length >= 3, "the Code tab lists the starter's files");
  await studio.click(".code-file:has-text('app.css')");
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

  await studio.click(".stx-tabs .seg:has-text('Theme')");
  await studio.waitForSelector(".token-row", { timeout: 5_000 });
  check((await studio.$$(".token-row")).length === 12, "the theme studio edits every colour token");
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
