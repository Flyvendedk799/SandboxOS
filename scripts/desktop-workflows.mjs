// Exercise the desktop workflows against a disposable gateway in real Chromium.
// Set SANDBOXOS_BRAIWSER_ROOT to the installed runtime to verify remote JS frames.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright-core";
import { findChrome } from "./lib/chrome.mjs";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-desktop-"));
Object.assign(process.env, { SANDBOXOS_HOME: home, SANDBOXOS_CELL_BACKEND: "local", SANDBOXOS_BRAIWSER_AUTOINSTALL: "0", SANDBOXOS_PASSWORD: "test" });
const { createServer, braiwser } = await import("../apps/gateway/src/server.js");
const { ensureSeed, createSession, appendConversationMessages, createConversation, getSandboxBySlug } = await import("../packages/control-db/src/registry.js");
const { killAllSessionsEverywhere } = await import("../packages/kernel/src/pty-sessions.js");
const { stopAllProcsEverywhere } = await import("../packages/kernel/src/servers/proc.js");
const { closeDb } = await import("../packages/control-db/src/db.js");
const { owner, sandbox } = ensureSeed("local");
const srv = createServer();
await new Promise(resolve => srv.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + srv.address().port;
const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await ctx.addCookies([{ name: "sbx_session", value: createSession(owner.id, "session"), url: base }]);
const page = await ctx.newPage();
page.setDefaultTimeout(45000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.error(e.message); });
const origin = base + "/" + sandbox.slug;
const call = async (server, tool, args = {}) => {
  const r = await (await ctx.request.post(origin + "/mcp", { data: { server, tool, args } })).json();
  assert(r.ok, r.error);
  return r.result;
};
const button = (root, name) => root.getByRole("button", { name, exact: true });
const files = page.locator(".os-window.front");
const editor = files.locator("textarea.note-editor");
const row = name => files.locator(".file-list").first().getByRole("button", { name: new RegExp(name) });
const menuItem = name => button(page.locator("body > .menu"), name);
const waitFor = async fn => {
  const end = Date.now() + 45000;
  while (!await fn()) {
    if (Date.now() > end) throw new Error("Expected desktop state did not arrive");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
try {
  await page.goto(origin + "/os", { waitUntil: "domcontentloaded" });
  await button(page, "Edit my first page").click();
  await editor.waitFor();
  const before = await editor.inputValue();
  assert.match(before, /<h1>/);
  const frame = files.frameLocator("iframe.project-preview");
  await frame.locator("h1").waitFor();
  assert.equal(await frame.locator("h1").evaluate(el => getComputedStyle(el).fontSize), "26px", "the preview loads project CSS");
  await editor.fill(before.replace(/<h1>.*?<\/h1>/, "<h1>My first edit</h1>"));
  await button(files, "Save").click();
  await frame.getByRole("heading", { name: "My first edit" }).waitFor();
  const live = !!process.env.SANDBOXOS_BRAIWSER_ROOT;
  const previewPage = color => before.replace(/<h1>.*?<\/h1>/, "<h1>My first edit</h1>").replace("</body>", `
    <script>
      const surface = document.createElement('button');
      surface.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:${color}';
      surface.onclick = () => { surface.style.backgroundColor = '#20c020'; };
      document.body.append(surface);
    </script></body>`);
  if (live) {
    await editor.fill(previewPage("#d02020"));
    await button(files, "Save").click();
  }
  await button(files, "Run JavaScript").click();
  await files.locator(".interactive-preview .braiwser").waitFor();
  if (live) {
    const image = files.locator(".interactive-preview .braiwser-frame");
    // Sample the displayed JPEG. This exercises JavaScript in the remote
    // browser, its input coordinates, and the frame shown beside the editor.
    async function expectColor(red, green, blue) {
      // Cold Chromium launch can take longer than a frame update.
      await image.waitFor({ state: "visible", timeout: 120000 });
      await waitFor(() => image.evaluate((img, rgb) => {
        if (!img.complete || !img.naturalWidth) return false;
        const context = document.createElement("canvas").getContext("2d");
        context.drawImage(img, Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return rgb.every((channel, i) => Math.abs(channel - pixel[i]) < 10);
      }, [red, green, blue]));
    }
    await expectColor(208, 32, 32);
    await image.click();
    await expectColor(32, 192, 32);
    await editor.fill(previewPage("#2020d0"));
    await button(files, "Save").click();
    await expectColor(32, 32, 208);
    console.log("Braiwser rendered the script, delivered a click and reloaded the saved edit");
  }
  await button(files, "Static preview").click();
  await frame.getByRole("heading", { name: "My first edit" }).waitFor();
  console.log("1–2 Welcome editor and live save");

  await editor.fill("unfinished draft");
  await row("style.css").click();
  await row("index.html").click();
  await waitFor(async () => await editor.inputValue() === "unfinished draft");
  await page.reload();
  await waitFor(async () => await editor.inputValue() === "unfinished draft");
  assert.match((await call("fs", "read", { path: "welcome/index.html" })).content, /My first edit/);
  console.log("3 Draft recovery after switching and reloading");

  const folder = path.join(home, "sample");
  await fs.mkdir(path.join(folder, "nested"), { recursive: true });
  await fs.writeFile(path.join(folder, "nested", "note.txt"), "First line\nA phrase worth finding\nLast line");
  await files.getByTitle("Files menu").click();
  let failUpload = true;
  await page.route("**/file?*", async route => {
    if (!failUpload || route.request().method() !== "PUT") return route.continue();
    failUpload = false;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary upload failure" }) });
  });
  const chooser = page.waitForEvent("filechooser");
  await menuItem("Upload folder…").click();
  await (await chooser).setFiles(folder);
  await button(files, "Retry 1 failed").click();
  await row("sample/").click();
  await page.unroute("**/file?*");
  await waitFor(async () => (await call("fs", "read", { path: "welcome/sample/nested/note.txt" })).content.includes("worth finding"));
  console.log("4 Folder import and retry after a failed upload");

  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await files.getByTitle("Files menu").click();
  await menuItem("Configure this project…").click();
  const dlg = page.locator(".dialog");
  await dlg.locator("input").nth(0).fill("node -e 'require(\"http\").createServer((q,s)=>s.end(\"sample ready\")).listen(" + port + ",\"127.0.0.1\")'");
  await dlg.locator("input").nth(1).fill(String(port));
  await button(dlg, "Save settings").click();
  await button(files, "Run").click();
  await button(files, "Open preview").click();
  await frame.getByText("sample ready").waitFor();
  await button(files, "Logs").click();
  await page.locator(".os-window.front .ops-pane").waitFor();
  console.log("5 Run, Preview and Logs");

  await page.locator(".os-menubar [title^='Search']").click();
  await page.locator(".os-spotlight input").fill("phrase worth finding");
  await page.locator(".spot-row").filter({ hasText: "line 2" }).click();
  await waitFor(async () => await editor.evaluate(ta => ta.value.substring(ta.selectionStart, ta.selectionEnd)) === "A phrase worth finding");
  console.log("6 Content search opens the matching line");

  const chat = createConversation(sandbox.id, owner.id, "Notes conversation");
  appendConversationMessages(chat.id, [
    { role: "assistant", tool_calls: [{ id: "write", function: { name: "fs__write", arguments: JSON.stringify({ path: "welcome/sample/nested/note.txt" }) } }] },
    { role: "tool", tool_call_id: "write", content: "saved" },
  ]);
  await call("desktop", "open", { app: "assistant" });
  const picker = files.getByLabel("Recent chats");
  await picker.selectOption(chat.id);
  await button(files, "Open file").waitFor();
  const win = (await call("desktop", "state")).doc.windows.findLast(w => w.app === "assistant");
  await call("desktop", "close", { id: win.id });
  await picker.waitFor({ state: "detached" });
  await call("desktop", "open", { app: "assistant" });
  await button(files, "Open file").click();
  await editor.waitFor();
  console.log("7 Assistant restores chat and opens its result");

  await row("note.txt").click({ button: "right" });
  await menuItem("Move to Trash").click();
  await button(page.locator("#toasts"), "Undo").click();
  await row("note.txt").waitFor();
  await row("note.txt").click({ button: "right" });
  await menuItem("Move to Trash").click();
  await files.getByTitle("Files menu").click();
  await menuItem("Open Trash…").click();
  await button(dlg, "Restore").click();
  await row("note.txt").waitFor();
  console.log("8 Trash, Undo and Restore");

  await page.goto(origin + "/studio", { waitUntil: "domcontentloaded" });
  await page.locator(".stx-tabs .seg").filter({ hasText: "Layers" }).click();
  await page.locator(".layer-row").filter({ hasText: /Clock/i }).first().click();
  await page.getByLabel("Time zone", { exact: true }).selectOption("UTC");
  await waitFor(async () => (await call("desktop", "state")).doc.widgets.some(g => g.props.timeZone === "UTC"));
  await page.waitForFunction(() => {
    const clock = document.querySelector('.w-clock[title="UTC"]');
    return clock?.textContent === new Intl.DateTimeFormat([], {
      timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date());
  });
  console.log("9 Live widget inspector");

  async function startTrial() {
    await page.locator(".stx-tabs .seg").filter({ hasText: "Library" }).click();
    await page.locator(".chip").filter({ hasText: "Distros" }).first().click();
    await button(page.locator(".distro-card").first(), "Try this desktop").click();
    await page.locator(".trial-bar:visible").waitFor();
    return new URL(page.url()).pathname.split("/")[1];
  }
  const trial = await startTrial();
  await page.locator(".dock-app").first().click();
  await button(page, "Back to mine").click();
  await page.waitForURL(origin + "/studio");
  assert.equal(getSandboxBySlug(trial), null);
  const kept = await startTrial();
  await button(page, "Keep this desktop").click();
  await page.locator(".trial-bar:visible").waitFor({ state: "hidden" });
  assert.ok(getSandboxBySlug(kept));
  assert.ok(getSandboxBySlug(sandbox.slug));
  console.log("10 Discarding and keeping gallery trials");
  assert.deepEqual(errors, []);
} catch (error) {
  const preview = files.locator(".interactive-preview");
  if (await preview.isVisible().catch(() => false)) {
    console.error("Preview status", await preview.innerText().catch(() => ""), braiwser.list(sandbox.id));
    const image = preview.locator(".braiwser-frame");
    console.error("Displayed frame", await image.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight })).catch(() => null));
  }
  throw error;
} finally {
  await browser.close();
  await braiwser.closeAll();
  stopAllProcsEverywhere();
  killAllSessionsEverywhere();
  srv.closeAllConnections();
  srv.close();
  closeDb();
  await fs.rm(home, { recursive: true, force: true });
}
