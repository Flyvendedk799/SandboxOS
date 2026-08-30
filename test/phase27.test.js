// Phase 27: the OS experience — a desktop that is a document, and a builder for it.
//
// What these tests pin is the contract the whole feature rests on: every change
// to the desktop is a `desktop.*` Kernel call, the document that comes back is
// always valid whatever was written at it, custom apps are served as untrusted
// content with attenuated capabilities, and a whole machine can be packaged and
// forked without losing the code behind its windows.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, mintMachineToken,
  createTenant, createAccount, createSandboxForTenant,
} from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { normalizeDoc, defaultDoc, LIMITS, safeRelPath, cleanAssociations } from "../packages/os/src/schema.js";
import { hasOs, notifyOs, notifyJobEnded, notifyAgentEnded } from "../packages/os/src/notify.js";
import { resolveTheme, themeCss, isWallpaper } from "../packages/os/src/themes.js";
import { cleanAnimation, resolveAnimation, animationCss } from "../packages/os/src/animations.js";
import { effectivePermissions, withheldPermissions } from "../packages/os/src/apps.js";
import { exportPayload, importPayload, firstRunDoc } from "../packages/os/src/distro.js";
import { loadOs, osEvents } from "../packages/os/src/store.js";

let kernel, owner, sandbox, held, srv, port, token;

const call = (tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });

const ok = async (tool, args) => {
  const r = await call(tool, args);
  assert.ok(r.ok, `desktop.${tool}: ${r.error}`);
  return r.result;
};

const http = (p, init = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p27" }).token;
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); });

// ── The document is always valid ────────────────────────────────────────────

test("normalizeDoc turns anything into a renderable desktop", () => {
  const doc = normalizeDoc({
    windows: [{ app: "files", x: "left", w: -20, ws: 99 }, { nonsense: true }],
    widgets: [{ kind: "clock", h: 1e9 }],
    theme: { base: "does-not-exist", tokens: { accent: "javascript:alert(1)" } },
    animation: { preset: "../../etc/passwd" },
    activeWorkspace: 42,
    zTop: "high",
  });
  assert.equal(doc.windows.length, 1, "a window with no app is not a window");
  assert.equal(doc.windows[0].x, 60, "an unparseable coordinate falls back, it does not become NaN");
  assert.equal(doc.windows[0].ws, 1, "a window cannot live on a workspace that does not exist");
  assert.ok(doc.widgets[0].h <= 3000, "sizes are clamped");
  assert.equal(doc.theme.base, "midnight", "an unknown theme falls back rather than rendering nothing");
  assert.deepEqual(doc.theme.tokens, {}, "a non-colour never reaches the stylesheet");
  assert.equal(doc.animation.preset, "spring");
  assert.equal(doc.activeWorkspace, 1);
});

test("the theme compiler only ever emits colours and gradients", () => {
  assert.ok(!isWallpaper("url(https://evil.example/x.png)"), "url() is not a wallpaper");
  assert.ok(!isWallpaper("#fff; } body { display:none"), "a closing brace cannot escape the rule");
  assert.ok(isWallpaper("linear-gradient(160deg,#06131d,#0a2233)"));

  const css = themeCss(resolveTheme(defaultDoc()));
  assert.match(css, /--os-accent: #35d6c4;/);
  assert.ok(!css.includes("javascript:"));
});

test("motion presets are numbers in, keyframes out", () => {
  const cleaned = cleanAnimation({
    name: "Wild", duration: 99_999, easing: "'; drop table",
    open: { from: { opacity: 5, scale: 400, blur: "8" } },
  });
  assert.equal(cleaned.duration, 2000, "duration is clamped");
  assert.equal(cleaned.easing, "smooth", "an unknown easing falls back to a known one");
  assert.equal(cleaned.open.from.opacity, 1);
  assert.equal(cleaned.open.from.scale, 3);

  const css = animationCss(resolveAnimation(defaultDoc()));
  assert.match(css, /@keyframes os-open/);
  assert.ok(!css.includes("drop table"));
});

test("bundle paths cannot climb out of their bundle", () => {
  assert.equal(safeRelPath("../../etc/passwd"), null);
  assert.equal(safeRelPath("/etc/passwd"), null);
  assert.equal(safeRelPath("a//b"), null);
  assert.equal(safeRelPath("./index.html"), "index.html");
  assert.equal(safeRelPath("ui/panel.js"), "ui/panel.js");
});

// ── A machine wakes up with a desktop ───────────────────────────────────────

test("a Sandbox that has never been opened still has an OS", async () => {
  const snap = await ok("get");
  assert.ok(snap.doc.windows.length > 0, "first run seeds an arranged desktop, not an empty one");
  assert.ok(snap.apps.length >= 8, "the built-in app catalog is there");
  assert.ok(snap.themes.some((t) => t.key === "midnight"));
  assert.ok(snap.distros.some((d) => d.id === "dev"), "the built-in distros are forkable from the start");
  assert.equal(snap.doc.rev, snap.rev);
});

test("first-run seeding is idempotent — a reload does not reset your desktop", async () => {
  const before = loadOs(sandbox);
  const after = loadOs(sandbox);
  assert.equal(before.id, after.id);
  assert.equal(before.rev, after.rev);
});

// ── Windows, widgets, workspaces ────────────────────────────────────────────

test("opening, moving and closing a window are ordinary tool calls", async () => {
  const { window: win } = await ok("open", { app: "metrics", x: 100, y: 80 });
  assert.equal(win.app, "metrics");

  const moved = await ok("move", { id: win.id, x: 300, y: 220 });
  assert.equal(moved.window.x, 300);

  const sized = await ok("resize", { id: win.id, w: 500, h: 320 });
  assert.equal(sized.window.w, 500);

  await ok("close", { id: win.id });
  const { windows } = await ok("windowList");
  assert.ok(!windows.some((w) => w.id === win.id));
});

test("a window cannot be opened for an app that does not exist", async () => {
  const r = await call("open", { app: "definitely-not-an-app" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such app/);
});

test("removing a workspace re-homes what was on it rather than orphaning it", async () => {
  const { workspace } = await ok("workspaceAdd", { name: "Scratch" });
  const { window: win } = await ok("open", { app: "notes", ws: workspace.n });
  await ok("workspaceRemove", { n: workspace.n });

  const { windows } = await ok("windowList");
  const survivor = windows.find((w) => w.id === win.id);
  assert.ok(survivor, "the window survives its workspace");
  assert.equal(survivor.ws, 1, "and lands somewhere reachable");
});

test("widgets are placed, moved and removed the same way", async () => {
  const { widget } = await ok("widgetAdd", { kind: "weather", x: 20, y: 20 });
  await ok("widgetSet", { id: widget.id, x: 240, props: { place: "Aarhus" } });
  const { widgets } = await ok("widgetList");
  const w = widgets.find((g) => g.id === widget.id);
  assert.equal(w.x, 240);
  assert.equal(w.props.place, "Aarhus");
  await ok("widgetRemove", { id: widget.id });
});

test("arrange lays a workspace out without the server knowing the screen", async () => {
  await ok("open", { app: "files" });
  await ok("open", { app: "terminal" });
  const r = await ok("arrange", { preset: "grid", viewport: { w: 1200, h: 800 } });
  assert.ok(r.windows.length >= 2);
  assert.ok(r.windows.every((w) => w.x >= 0 && w.y >= 0));
});

test("snapping puts a window in a half, and says so in one call", async () => {
  const { window: win } = await ok("open", { app: "notes" });
  const r = await ok("snap", { id: win.id, region: "right", viewport: { w: 1000, h: 600 } });
  assert.ok(r.window.x > 400, "the right half starts past the middle");
  assert.ok(r.window.w < 520, "and is about half wide");
  assert.equal(r.window.max, false, "snapping is not maximizing");

  const full = await ok("snap", { id: win.id, region: "full", viewport: { w: 1000, h: 600 } });
  assert.equal(full.window.x, 12);
  assert.equal(full.window.w, 976);
  await ok("close", { id: win.id });
});

test("cycling focus raises the window underneath", async () => {
  const a = (await ok("open", { app: "files" })).window;
  const b = (await ok("open", { app: "media" })).window;
  const first = await ok("cycleFocus", {});
  assert.ok(first.window, "something took focus");
  const second = await ok("cycleFocus", {});
  assert.notEqual(first.window.id, second.window.id, "cycling twice does not land on the same window");
  await ok("close", { id: a.id });
  await ok("close", { id: b.id });
});

test("show desktop minimizes everything and restores it", async () => {
  await ok("open", { app: "files" });
  await ok("minimizeAll", {});
  let d = (await ok("state")).doc;
  assert.ok(d.windows.filter((w) => w.ws === d.activeWorkspace).every((w) => w.min));
  await ok("minimizeAll", { restore: true });
  d = (await ok("state")).doc;
  assert.ok(d.windows.filter((w) => w.ws === d.activeWorkspace).every((w) => !w.min));
});

test("file associations decide which app opens what", async () => {
  const d = (await ok("get")).doc;
  assert.equal(d.shell.associations[".md"], "notes", "a fresh machine already opens markdown sensibly");

  const set = await ok("associate", { ext: "log", app: "files" });
  assert.equal(set.associations[".log"], "files", "an extension is normalized with its dot");

  const cleared = await ok("associate", { ext: ".log" });
  assert.equal(cleared.associations[".log"], undefined);

  const bad = await call("associate", { ext: ".zz", app: "not-an-app" });
  assert.equal(bad.ok, false, "you cannot associate a file with an app that does not exist");
});

test("associations are validated, not trusted", () => {
  const clean = cleanAssociations({ ".md": "notes", "md": "notes", ".exe": "../../evil", ".ok": "files" });
  assert.deepEqual(clean, { ".md": "notes", ".ok": "files" });
});

// ── System notifications ────────────────────────────────────────────────────

test("a finished job earns a notification", async () => {
  const before = (await ok("state")).doc.notifications.length;
  const delivered = notifyJobEnded(sandbox, { id: "p1", name: "build", state: "exited", code: 0 });
  assert.equal(delivered, true);
  const after = (await ok("state")).doc.notifications;
  assert.equal(after.length, before + 1);
  assert.match(after.at(-1).title, /build finished/);
  assert.equal(after.at(-1).kind, "ok");

  notifyJobEnded(sandbox, { id: "p2", name: "tests", state: "failed", code: 1 });
  const failed = (await ok("state")).doc.notifications.at(-1);
  assert.equal(failed.kind, "err");
  assert.match(failed.body, /code 1/);
});

test("an agent that comes back says so", async () => {
  notifyAgentEnded(sandbox, { name: "scout", result: "found three things" }, "done");
  const note = (await ok("state")).doc.notifications.at(-1);
  assert.equal(note.app, "Agents");
  assert.match(note.body, /found three things/);
});

test("notifying never creates a desktop for a machine that has none", () => {
  const tenant = createTenant(`notify-${Date.now()}`);
  const acc = createAccount(tenant.id, { username: `notify-${Date.now()}`, password: "password123" });
  const fresh = createSandboxForTenant(tenant.id, acc.principalId, {
    slug: `notify-${Date.now()}`, name: "headless", cellBackend: "local",
  });

  assert.equal(hasOs(fresh), false, "a Sandbox nobody has opened as an OS has no document");
  assert.equal(notifyOs(fresh, { title: "hello" }), false, "and a notification does not conjure one");
  assert.equal(hasOs(fresh), false);
  assert.ok(!fs.existsSync(path.join(path.dirname(fresh.volume_path), "os")),
    "no desktop state was written to disk");
});

test("notifications respect the switch that turns them off", async () => {
  await ok("shellSet", { notifications: { enabled: false } });
  const before = (await ok("state")).doc.notifications.length;
  notifyOs(sandbox, { title: "should not arrive" });
  assert.equal((await ok("state")).doc.notifications.length, before);
  await ok("shellSet", { notifications: { enabled: true } });
});

// ── Theme, motion, chrome ───────────────────────────────────────────────────

test("a theme change is one write and rebinds everything", async () => {
  const r = await ok("themeSet", { theme: "aurora", tokens: { accent: "#ff00aa" } });
  assert.equal(r.theme.key, "aurora");
  assert.equal(r.theme.accent, "#ff00aa", "a token override wins over the base theme");

  const bad = await call("themeSet", { theme: "nope" });
  assert.equal(bad.ok, false, "an unknown theme is refused loudly, not applied quietly");
});

test("custom themes and motion presets are first-class", async () => {
  await ok("themeDefine", { key: "deep", name: "Deep Water", base: "tide", tokens: { accent: "#00b4ff" } });
  const listed = await ok("themeList");
  assert.ok(listed.themes.some((t) => t.key === "deep" && !t.builtin));

  await ok("themeSet", { theme: "deep" });
  await ok("animationDefine", { key: "swoop", name: "Swoop", duration: 300, easing: "spring", open: { from: { y: 60, opacity: 0 } } });
  const anim = await ok("animationSet", { preset: "swoop" });
  assert.equal(anim.animation.name, "Swoop");
});

test("the dock refuses to pin an app the machine does not have", async () => {
  const r = await call("dockPin", { app: "ghost-app" });
  assert.equal(r.ok, false);
  const good = await ok("dockPin", { app: "media", pinned: true });
  assert.ok(good.pinned.includes("media"));
});

// ── Undo ────────────────────────────────────────────────────────────────────

test("every change is revertible", async () => {
  const before = (await ok("get")).doc;
  await ok("rename", { name: "renamed-by-test" });
  const hist = await ok("history");
  assert.ok(hist.revisions.length > 0);

  await ok("revert", { rev: before.rev });
  const now = (await ok("get")).doc;
  assert.equal(now.name, before.name, "reverting restores the earlier document");
  assert.ok(now.rev > hist.current, "and does so by moving forward, so the undo is itself undoable");
});

// ── Custom apps: definition, source, capabilities ───────────────────────────

test("defining an app seeds runnable source", async () => {
  const r = await ok("appDefine", {
    id: "port-monitor", name: "Port Monitor",
    permissions: ["ports.list", "fs.read"],
    window: { w: 380, h: 260 },
  });
  assert.equal(r.app.kind, "bundle");
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["app.css", "app.js", "index.html"]);

  const { apps } = await ok("appList");
  assert.ok(apps.some((a) => a.id === "port-monitor" && !a.builtin));
});

test("an app's source is written through the Kernel, not the filesystem", async () => {
  await ok("appWrite", { id: "port-monitor", path: "index.html", content: "<h1>ports</h1>" });
  const read = await ok("appRead", { id: "port-monitor", path: "index.html" });
  assert.equal(read.content, "<h1>ports</h1>");

  const escape = await call("appWrite", { id: "port-monitor", path: "../../../etc/evil", content: "x" });
  assert.equal(escape.ok, false, "a bundle write cannot escape its bundle");

  const wrongType = await call("appWrite", { id: "port-monitor", path: "payload.sh", content: "rm -rf /" });
  assert.equal(wrongType.ok, false, "and cannot smuggle in a file type the OS will not serve");
});

test("app capabilities are attenuated against the opener, never widened", () => {
  const requested = ["fs.read", "proc.exec", "secrets.list"];
  const opener = ["fs.*", "proc.exec"];
  assert.deepEqual(effectivePermissions(requested, opener), ["fs.read", "proc.exec"]);
  assert.deepEqual(withheldPermissions(requested, opener), ["secrets.list"]);
  assert.deepEqual(effectivePermissions(["*"], ["fs.read"]), [], "an app asking for everything gets what its opener holds, not everything");
});

// ── Distros: a whole machine, packaged ──────────────────────────────────────

test("publishing packages the document and the code behind it", async () => {
  const r = await ok("distroPublish", { name: "test-distro", description: "for the suite", replace: true });
  assert.equal(r.apps, 1, "the custom app's source travels with the distro");

  const { distros } = await ok("distroList");
  assert.ok(distros.some((d) => d.name === "test-distro" && !d.builtin));
});

test("forking a built-in distro replaces the desktop wholesale", async () => {
  const r = await ok("distroFork", { id: "minimal" });
  assert.equal(r.distro.id, "minimal");
  const doc = (await ok("get")).doc;
  assert.equal(doc.theme.base, "mono");
  assert.equal(doc.windows.length, 1, "Minimal means minimal");
});

test("forking your own distro restores its custom apps, source and all", async () => {
  await ok("distroFork", { name: "test-distro" });
  const doc = (await ok("get")).doc;
  assert.ok(doc.apps["port-monitor"], "the app definition came back");
  const file = await ok("appRead", { id: "port-monitor", path: "index.html" });
  assert.equal(file.content, "<h1>ports</h1>", "and so did its source");
});

test("an oversized distro payload is refused before it becomes disk", async () => {
  const r = await call("distroImport", {
    payload: { os: {}, bundles: { apps: { fat: { "a.txt": { content: "x".repeat(9 * 1024 * 1024) } } } } },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/);
});

test("export and import round-trip a machine", () => {
  const doc = firstRunDoc("round-trip");
  const payload = exportPayload(doc, { apps: { demo: { "index.html": { content: "<b>hi</b>" } } } });
  const { doc: back, bundles } = importPayload(payload, { name: "copy" });
  assert.equal(back.name, "copy");
  assert.notEqual(back.id, doc.id, "a fork is a new machine, not the same one twice");
  assert.equal(back.windows.length, doc.windows.length);
  assert.deepEqual(Object.keys(bundles.apps), []);
  assert.ok(payload.os.notifications.length === 0, "a distro does not carry someone else's notifications");
});

// ── Live stream ─────────────────────────────────────────────────────────────

test("a change announces itself on the OS event bus", async () => {
  const seen = [];
  const bus = osEvents(sandbox.id);
  const onChange = (ev) => seen.push(ev);
  bus.on("change", onChange);
  await ok("notify", { title: "hello from the tests" });
  bus.off("change", onChange);
  assert.ok(seen.length > 0, "the desktop is told about its own changes");
  assert.equal(seen.at(-1).op, "notify");
  assert.ok(seen.at(-1).doc.notifications.some((n) => n.title === "hello from the tests"));
});

// ── The HTTP surface ────────────────────────────────────────────────────────

test("GET /:slug/os serves the OS shell", async () => {
  const r = await http(`/${sandbox.slug}/os`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /os-root/);
});

test("GET /:slug/os/doc returns the document and the catalogs", async () => {
  const r = await http(`/${sandbox.slug}/os/doc`);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.doc.workspaces.length >= 1);
  assert.ok(body.apps.length >= 8);
});

test("GET /:slug/os/theme.css is a stylesheet, not JSON", async () => {
  const r = await http(`/${sandbox.slug}/os/theme.css`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/css/);
  const css = await r.text();
  assert.match(css, /--os-bg-0:/);
  assert.match(css, /@keyframes os-open/);
});

test("a custom app is served as untrusted content, with the bridge injected", async () => {
  await ok("appWrite", { id: "port-monitor", path: "index.html", content: "<html><head></head><body>ok</body></html>" });
  const r = await http(`/${sandbox.slug}/os/apps/port-monitor/`);
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/, "an app frame cannot call the network itself");
  const html = await r.text();
  assert.match(html, /js\/os\/bridge\.js/, "every app frame gets the bridge whether it asked or not");
});

test("the bundle route will not serve a path outside the bundle", async () => {
  const r = await http(`/${sandbox.slug}/os/apps/port-monitor/../../../../package.json`);
  assert.ok(r.status === 400 || r.status === 404, `expected a refusal, got ${r.status}`);
});

test("an app session hands back only the capabilities its opener holds", async () => {
  const limited = mintMachineToken(owner.id, sandbox.id, ["desktop.*", "fs.read"], { label: "p27-limited" }).token;
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/os/apps/port-monitor/session`, {
    method: "POST", headers: { Authorization: `Bearer ${limited}` },
  });
  const body = await r.json();
  assert.deepEqual(body.patterns, ["fs.read"], "ports.list was requested but the opener does not hold it");
  assert.deepEqual(body.withheld, ["ports.list"]);
  assert.ok(body.token, "and a token is minted for what did survive");
});

test("an app that would be granted nothing gets no token at all", async () => {
  await ok("appDefine", { id: "quiet-app", name: "Quiet", permissions: [] });
  const r = await http(`/${sandbox.slug}/os/apps/quiet-app/session`, { method: "POST" });
  const body = await r.json();
  assert.equal(body.token, null, "there is no credential to steal from an app that needs none");
  assert.deepEqual(body.patterns, []);
});

// ── Limits ──────────────────────────────────────────────────────────────────

test("the document has ceilings a runaway agent cannot climb", () => {
  const doc = normalizeDoc({
    workspaces: Array.from({ length: 100 }, (_, i) => ({ name: `w${i}` })),
    windows: Array.from({ length: 500 }, () => ({ app: "files" })),
    notifications: Array.from({ length: 500 }, () => ({ title: "spam" })),
  });
  assert.equal(doc.workspaces.length, LIMITS.workspaces);
  assert.equal(doc.windows.length, LIMITS.windows);
  assert.equal(doc.notifications.length, LIMITS.notifications);
});

test("the OS document lives beside the volume, not inside it", () => {
  const dir = path.dirname(sandbox.volume_path);
  assert.ok(fs.existsSync(path.join(dir, "os", "os.json")));
  assert.ok(!fs.existsSync(path.join(sandbox.volume_path, "os")),
    "a process inside the Cell cannot rewrite the desktop by writing a file");
});
