// Phase 38: the manual is the machine's own.
//
// T5.2 of goal.md. The Help app does not carry a copy of the documentation: it
// reads the files this build ships and the tool catalogue this machine actually
// serves, so neither half can drift from the thing it describes.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createSession } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { MANUAL_PAGES, manualIndex, manualPage, manualHeadings } from "../packages/os/src/manual.js";
import { BUILTIN_APPS } from "../packages/os/src/catalog.js";

let kernel, owner, sandbox, held, srv, base, session;
const ok = async (server, tool, args = {}) => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
  return r.result;
};
const get = (p, cookie = null) => fetch(`${base}${p}`, { headers: { cookie: cookie ?? `sbx_session=${session}` } });
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  session = createSession(owner.id, "phase38");
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}/${sandbox.slug}`;
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); });

// ── the pages are the repository's, not a copy ──────────────────────────────

test("every page in the manual is a file this build ships", () => {
  const root = new URL("../", import.meta.url);
  for (const p of MANUAL_PAGES) {
    assert.ok(fs.existsSync(new URL(p.file, root)), `${p.file} is missing`);
    assert.ok(p.title && p.blurb, `${p.id} says what it is`);
  }
  const index = manualIndex();
  assert.equal(index.length, MANUAL_PAGES.length);
  assert.ok(index.every((p) => p.present && p.bytes > 500), "and each one has something in it");
});

test("a page is the file, byte for byte", () => {
  const page = manualPage("experience");
  assert.equal(page.text, read("../docs/15-os-experience.md"), "the manual serves the file, not a rendering of it");
  assert.equal(manualPage("nope"), null, "and an unknown page is nothing, not a path");
});

test("the page id cannot become a path", async () => {
  for (const bad of ["../package.json", "../../package.json", "/etc/passwd", "experience/../../.git/config"]) {
    const r = await get(`/os/manual/${encodeURIComponent(bad)}`);
    assert.equal(r.status, 404, `${bad} is not a page`);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(/BEGIN |devDependencies|password/i.test(JSON.stringify(body)), false, "and nothing leaks in the refusal");
  }
});

test("the headings index can find a section in a page", () => {
  const headings = manualHeadings();
  assert.ok(headings.length > 50, `enough to search (${headings.length})`);
  assert.ok(headings.every((x) => x.page && x.text && x.level >= 1 && x.level <= 4));
  assert.ok(headings.some((x) => /Reviewable, not just revertible/.test(x.text)), "a real section is in there");
  // A `#` inside a fenced block is a shell comment, not a heading.
  assert.equal(headings.some((x) => /^(npm|node|git|curl) /.test(x.text)), false, "code fences are not headings");
});

// ── and it is served, to whoever may look at the desktop ────────────────────

test("the manual is served under the slug, contents first", async () => {
  const r = await get("/os/manual");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.ok);
  assert.equal(body.pages.length, MANUAL_PAGES.length);
  assert.ok(body.headings.length > 50);
  assert.ok(JSON.stringify(body).length < 40_000, "the contents do not carry the bodies");

  const page = await (await get("/os/manual/surface")).json();
  assert.ok(page.ok);
  assert.equal(page.page.file, "docs/14-surface-map.md");
  assert.match(page.page.text, /desktop/);
});

test("reading the manual needs the same right as reading the desktop", async () => {
  const { createTenant, createAccount, grant } = await import("../packages/control-db/src/registry.js");
  const t = createTenant("phase38-tenant");
  const guest = createAccount(t.id, { username: "phase38-guest", password: "pw" });
  grant(guest.principalId, sandbox.id, "fs.read");
  const guestSession = createSession(guest.principalId, "phase38-guest");
  const r = await get("/os/manual", `sbx_session=${guestSession}`);
  assert.equal(r.status, 403, "someone who cannot see the desktop cannot read its manual");
});

// ── the catalogue is the machine's answer, not a list somebody maintains ────

test("the tool catalogue is live: a companion server appears when it is switched on", async () => {
  const before = (await ok("kernel", "tools", {})).tools;
  assert.equal(before.some((t) => t.name.startsWith("manual-app.")), false);

  await ok("desktop", "appDefine", { id: "manual-app", name: "Manual App", starter: "tools" });
  const on = (await ok("kernel", "tools", {})).tools;
  assert.ok(on.some((t) => t.name === "manual-app.ping"), "the app's tools are in the catalogue");
  const ping = on.find((t) => t.name === "manual-app.ping");
  assert.ok(ping.description, "with what it does");
  assert.ok(ping.inputSchema, "and what it takes");

  await ok("desktop", "appDefine", { id: "manual-app", mcp: { enabled: false } });
  const off = (await ok("kernel", "tools", {})).tools;
  assert.equal(off.some((t) => t.name.startsWith("manual-app.")), false, "and gone again when it is switched off");
});

test("every tool in the catalogue can be described to someone", async () => {
  const { tools } = await ok("kernel", "tools", {});
  assert.deepEqual(tools.filter((t) => !t.description).map((t) => t.name), [], "a tool with no description cannot be documented");
  assert.deepEqual(tools.filter((t) => !t.inputSchema).map((t) => t.name), [], "nor one that will not say what it takes");
});

// ── the app itself ──────────────────────────────────────────────────────────

test("the Manual is a built-in app that needs nothing", () => {
  const app = BUILTIN_APPS.find((a) => a.id === "help");
  assert.ok(app, "it is in the catalog");
  assert.deepEqual(app.needs, [], "a machine you cannot read about is worse than one you cannot use");
  const builtins = read("../apps/gateway/public/js/os/builtins.js");
  assert.match(builtins, /import \{ HELP_APP \} from "\.\/help\.js";/);
  assert.match(builtins, /\.\.\.HELP_APP,/);
});

test("Try it hands you to Spotlight rather than running it for you", () => {
  const help = read("../apps/gateway/public/js/os/help.js");
  assert.match(help, /function tryIt\(name\)/);
  assert.match(help, /ctx\.spotlight\(name\)/, "the button fills Spotlight");
  assert.match(help, /if \(needs\.length\) \{ tryIt\(tool\.name\); return; \}/, "a tool with required arguments is never fired blind");
  const shell = read("../apps/gateway/public/js/os/shell.js");
  assert.match(shell, /spotlight: \(q = ""\) => showOverlay\("spotlight", \(\) => spotlight\(q\)\)/, "the shell can be opened with something typed in it");
  assert.match(shell, /async function indexTools\(\)/, "and Spotlight knows the machine's tools");
});

test("the renderer cannot hang the window it draws into", () => {
  const help = read("../apps/gateway/public/js/os/help.js");
  assert.match(help, /\.replace\(\/\\r\\n\?\/g, "\\n"\)/, "CRLF is normalised — a line matching nothing is a line never consumed");
  assert.match(help, /if \(!para\.length\)/, "and a line that matches nothing anyway is taken as text");
});
