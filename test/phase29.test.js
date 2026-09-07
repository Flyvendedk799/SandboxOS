// Phase 29: apps as dual beings, and distros as an ecosystem.
//
// An app now has two faces — a window and a server — and the second is
// governed exactly like the first: registered from the document, attenuated at
// the door, audited on every hop, and switched off when it arrives from a
// stranger. Distros carry both faces, a hash of every bundle, and the Cell's
// composition, and a gallery decides who can see what.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, createTenant, createAccount, createSandboxForTenant, getDistroByName,
} from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { loadManifest, saveManifest } from "../packages/manifest/src/manifest.js";
import { exportPayload, importPayload, verifyIntegrity, bundleHash } from "../packages/os/src/distro.js";
import { normalizeDoc, RESERVED_SERVER_NAMES } from "../packages/os/src/schema.js";
import { hasOs } from "../packages/os/src/notify.js";

let kernel, owner, sandbox, held;
let kernel2, owner2, sandbox2, held2;

const callAs = (k, principal, patterns, server, tool, args = {}) =>
  k.call({ principalId: principal.id, heldPatterns: patterns, server, tool, args });
const call = (tool, args = {}) => callAs(kernel, owner, held, "desktop", tool, args);
const ok = async (tool, args) => {
  const r = await call(tool, args);
  assert.ok(r.ok, `desktop.${tool}: ${r.error}`);
  return r.result;
};
const ok2 = async (tool, args) => {
  const r = await callAs(kernel2, owner2, held2, "desktop", tool, args);
  assert.ok(r.ok, `desktop.${tool} (tenant 2): ${r.error}`);
  return r.result;
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("reset", {});

  const tenant = createTenant(`gallery-${Date.now()}`);
  const acc = createAccount(tenant.id, { username: `gallery-${Date.now()}`, password: "password123" });
  sandbox2 = createSandboxForTenant(tenant.id, acc.principalId, { slug: `gal-${Date.now().toString(36)}`, name: "second", cellBackend: "local" });
  owner2 = { id: acc.principalId };
  held2 = grantsFor(owner2.id, sandbox2.id);
  kernel2 = await getKernel(sandbox2);
});
test.after(() => { _resetKernels(); closeDb(); });

// ── C1/C2 · façades ─────────────────────────────────────────────────────────

test("a façade tool is an attenuated alias of a Kernel tool, registered from the document", async () => {
  const r = await ok("appDefine", {
    id: "port-monitor", name: "Port Monitor", permissions: ["ports.list"],
    mcp: { tools: [{ name: "list", description: "Exposed ports", proxy: { server: "ports", tool: "list" } }] },
  });
  assert.equal(r.server.name, "port-monitor");
  assert.equal(r.server.live, true, "the server is callable as soon as appDefine returns");
  assert.ok(kernel.listTools().some((t) => t.name === "port-monitor.list"), "kernel.tools lists the app's tool");

  const direct = await callAs(kernel, owner, held, "port-monitor", "list", {});
  assert.ok(direct.ok, direct.error);
  assert.ok(Array.isArray(direct.result.ports), "the façade returned what ports.list returns");

  // The caller holds the app's tool but not the underlying one: attenuation refuses the inner hop.
  const narrow = await callAs(kernel, owner, ["port-monitor.*"], "port-monitor", "list", {});
  assert.equal(narrow.ok, false);
  assert.match(narrow.error, /denied: ports\.list/);

  const listed = (await ok("appList")).apps.find((a) => a.id === "port-monitor");
  assert.deepEqual(listed.mcp.tools, ["list"]);
  assert.equal(listed.mcp.live, true);
});

test("an app cannot use a capability it did not declare, even through its own façade", async () => {
  await ok("appDefine", {
    id: "sneaky", name: "Sneaky", permissions: [],
    mcp: { tools: [{ name: "ls", proxy: { server: "fs", tool: "list", args: { path: "." } } }] },
  });
  const r = await callAs(kernel, owner, held, "sneaky", "ls", {});
  assert.equal(r.ok, false, "the opener holds fs.list, but the app never asked for it");
  assert.match(r.error, /denied: fs\.list/);
  await ok("appRemove", { id: "sneaky" });
});

test("server names are closed: no app may call itself fs, and no two apps share a name", async () => {
  assert.ok(RESERVED_SERVER_NAMES.has("fs"));
  const r = await call("appDefine", { id: "evil", name: "Evil", mcp: { name: "fs", tools: [{ name: "read", proxy: { server: "fs", tool: "read" } }] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /reserved/);
  const dup = await call("appDefine", { id: "other", name: "Other", mcp: { name: "port-monitor", tools: [{ name: "x", proxy: { server: "ports", tool: "list" } }] } });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already serves/);
  // And a hostile document loses the block before the Kernel ever sees it.
  const doc = normalizeDoc({ apps: { evil: { id: "evil", mcp: { name: "kernel", entrypoint: "server.js" } } } });
  assert.equal(doc.apps.evil.mcp, undefined);
});

// ── C2 · companions ─────────────────────────────────────────────────────────

test("a 'UI + tools' app ships a companion server that runs out of process", async () => {
  const r = await ok("appDefine", { id: "counter", name: "Counter", starter: "tools" });
  assert.ok(r.files.some((f) => f.path === "server.js"), "the starter includes a server");
  assert.equal(r.server.entrypoint ?? r.app.source.entry, r.server.entrypoint ?? "index.html");
  assert.equal(r.server.live, true, r.server.problem ?? "the companion is hosted");
  const app = (await ok("state")).doc.apps.counter;
  assert.equal(app.mcp.entrypoint, "server.js");
  assert.ok(app.permissions.includes("counter.*"), "the UI half may call its own tools through the broker");

  const ping = await callAs(kernel, owner, held, "counter", "ping", {});
  assert.ok(ping.ok, ping.error);
  assert.equal(ping.result.pong, true);
  await callAs(kernel, owner, held, "counter", "add", { text: "hello" });
  const list = await callAs(kernel, owner, held, "counter", "list", {});
  assert.deepEqual(list.result.notes, ["hello"], "the companion keeps state across calls");

  const denied = await callAs(kernel, owner, ["fs.read"], "counter", "ping", {});
  assert.equal(denied.ok, false, "the app's tools sit behind Kernel grants like any other");
});

test("rewriting the companion's source restarts it with the new tools", async () => {
  await ok("appWrite", {
    id: "counter", path: "server.js",
    content: "export default () => ({ name: 'counter', tools: { twice: { description: 'x2', inputSchema: { type: 'object' }, async handler(_c, { n }) { return { result: n * 2 }; } } } });\n",
  });
  const r = await callAs(kernel, owner, held, "counter", "twice", { n: 21 });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.result, 42);
  assert.ok(!kernel.listTools().some((t) => t.name === "counter.ping"), "the old tool is gone");
});

test("removing the app deregisters its server", async () => {
  await ok("appDefine", { id: "gone", name: "Gone", starter: "tools" });
  assert.ok(kernel.servers.has("gone"));
  await ok("appRemove", { id: "gone" });
  assert.ok(!kernel.servers.has("gone"));
  const r = await callAs(kernel, owner, held, "gone", "ping", {});
  assert.equal(r.code, "unknown_tool");
});

test("a broken companion is reported, not fatal", async () => {
  const r = await ok("appDefine", { id: "broken", name: "Broken", mcp: { entrypoint: "server.js" }, files: { "index.html": "<b>x</b>", "server.js": "export default 42;" } });
  assert.equal(r.server.live, false);
  assert.match(r.server.problem, /failed to load/);
  assert.ok(kernel.servers.has("desktop"), "the rest of the machine is fine");
  await ok("appRemove", { id: "broken" });
});

test("revert re-registers what the reverted document declares", async () => {
  const before = (await ok("state")).rev;
  // keepFiles: revert restores the document, not deleted source — that is a
  // document contract, and a companion with no server.js cannot come back.
  await ok("appRemove", { id: "counter", keepFiles: true });
  assert.ok(!kernel.servers.has("counter"));
  await ok("revert", { rev: before });
  // The bus-driven sync is asynchronous; give it a beat.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok((await ok("state")).doc.apps.counter, "the definition is back");
  assert.ok(kernel.servers.has("counter") || (await kernel.syncAppServers()).registered.includes("counter"), "and so is its server");
});

// ── C4 · integrity ──────────────────────────────────────────────────────────

test("a payload carries a hash of every bundle, and a modified bundle is refused", async () => {
  const { payload } = await ok("distroExport", { name: "hashed" });
  assert.equal(payload.integrity.algorithm, "sha256");
  assert.ok(payload.integrity.apps["port-monitor"]);
  assert.equal(payload.integrity.apps["port-monitor"], bundleHash(payload.bundles.apps["port-monitor"]));
  assert.deepEqual(verifyIntegrity(payload), { verified: true });

  const tampered = structuredClone(payload);
  tampered.bundles.apps["port-monitor"]["index.html"] = { content: "<script>evil()</script>" };
  const r = await call("distroImport", { payload: tampered });
  assert.equal(r.ok, false);
  assert.match(r.error, /integrity/);
  const smuggled = structuredClone(payload);
  smuggled.bundles.apps.extra = { "index.html": { content: "hi" } };
  assert.throws(() => verifyIntegrity(smuggled), /not in the manifest/);
  const legacy = importPayload({ os: normalizeDoc({}), bundles: { apps: {} } });
  assert.ok(legacy.doc, "a version-1 payload without a block still imports");
});

// ── D1 · one snapshot: desktop + composition ────────────────────────────────

test("publishing packages the desktop, the tools and the Cell's composition", async () => {
  const m = loadManifest(sandbox);
  delete m.servers.cron; // a machine deliberately without cron
  saveManifest(sandbox, m);
  kernel.rebuild();
  const r = await ok("distroPublish", { name: "Toolful Box", description: "apps with tools", tags: ["Dev", "TOOLS"], visibility: "public", replace: true });
  assert.equal(r.visibility, "public");
  assert.ok(r.tools >= 2, "both apps with a tool face are counted");
  assert.ok(r.servers > 0);
  const row = getDistroByName(sandbox.tenant_id, "Toolful Box");
  assert.deepEqual(row.tags, ["dev", "tools"]);
  assert.ok(row.preview.windows, "a preview silhouette is stored, not a screenshot");
  assert.equal(row.os.manifest.servers.cron, undefined, "the composition says what the machine had");
  assert.ok(row.os.manifest.servers.desktop);
  assert.equal(row.manifest.os, true);
  assert.ok(row.manifest.servers, "the row's manifest can instantiate a Cell");
  m.servers.cron = {};
  saveManifest(sandbox, m);
  kernel.rebuild();
});

// ── D2 · the gallery ────────────────────────────────────────────────────────

test("another tenant finds the public distro, forks it, and gets tools it must switch on", async () => {
  const { distros } = await ok2("distroList", { scope: "public" });
  const found = distros.find((d) => d.name === "Toolful Box");
  assert.ok(found, "public distros cross tenants");
  assert.equal(found.mine, false);
  assert.ok(found.preview.theme.accent);
  assert.deepEqual(found.tags, ["dev", "tools"]);
  const searched = await ok2("distroList", { q: "tools" });
  assert.ok(searched.distros.some((d) => d.id === found.id), "search covers tags");
  assert.ok(!(await ok2("distroList", { q: "zzzz" })).distros.length);

  const fork = await ok2("distroFork", { id: found.id });
  assert.equal(fork.distro.visibility, "public");
  const doc = (await ok2("state")).doc;
  assert.equal(doc.distro.id, found.id, "lineage is recorded");
  assert.equal(doc.distro.tenant, sandbox.tenant_id);
  assert.ok(doc.apps["port-monitor"], "the façade app came along");
  assert.equal(doc.apps["port-monitor"].mcp.enabled, true, "a façade carries no code, so it stays on");
  assert.ok(doc.apps.counter, "and the companion app");
  assert.equal(doc.apps.counter.mcp.enabled, false, "but a stranger's server arrives switched off");
  assert.ok(!kernel2.servers.has("counter"));
  assert.ok(kernel2.servers.has("port-monitor"), "façades are callable straight after the fork");
  assert.equal(loadManifest(sandbox2).servers.cron, undefined, "the Cell's composition followed the distro");
  assert.ok(loadManifest(sandbox2).servers.kernel, "without ever removing the servers that keep the machine reachable");

  await ok2("appDefine", { id: "counter", mcp: { enabled: true } });
  const twice = await callAs(kernel2, owner2, held2, "counter", "twice", { n: 4 });
  assert.ok(twice.ok, twice.error);
  assert.equal(twice.result.result, 8, "once enabled, the forked companion runs on the other machine");
  const src = await ok2("appRead", { id: "counter", path: "server.js" });
  assert.match(src.content, /twice/, "its source travelled with the distro");
});

test("visibility is enforced: private distros are invisible and unforkable to other tenants", async () => {
  await ok("distroSet", { name: "Toolful Box", visibility: "private" });
  const { distros } = await ok2("distroList", {});
  assert.ok(!distros.some((d) => d.name === "Toolful Box"));
  const row = getDistroByName(sandbox.tenant_id, "Toolful Box");
  const r = await callAs(kernel2, owner2, held2, "desktop", "distroFork", { id: row.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such distro/);
  assert.ok((await ok("distroList", { scope: "mine" })).distros.some((d) => d.name === "Toolful Box"), "the owner still sees it");
  await ok("distroSet", { name: "Toolful Box", visibility: "tenant" });
  const bad = await call("distroSet", { name: "nope", visibility: "public" });
  assert.equal(bad.ok, false);
});

test("a machine that has never been opened as an OS has no app servers", async () => {
  const tenant = createTenant(`headless-${Date.now()}`);
  const acc = createAccount(tenant.id, { username: `headless-${Date.now()}`, password: "password123" });
  const fresh = createSandboxForTenant(tenant.id, acc.principalId, { slug: `hl-${Date.now().toString(36)}`, name: "headless", cellBackend: "local" });
  const k = await getKernel(fresh);
  assert.equal(hasOs(fresh), false);
  assert.equal(k._appServers.size, 0);
  assert.ok(k.servers.has("fs"));
});

test("export round-trips the manifest and tags", () => {
  const doc = normalizeDoc({ name: "rt" });
  const payload = exportPayload(doc, { manifest: { servers: { fs: {}, net: { egress: "deny" } }, installedMeta: { hello: { source: "npm:hello" } } }, tags: ["A", "b"] });
  assert.deepEqual(payload.manifest.servers.net, { egress: "deny" });
  assert.deepEqual(payload.manifest.installed.hello, { source: "npm:hello" }, "installed servers travel as names, not as code");
  assert.deepEqual(payload.tags, ["a", "b"]);
  assert.equal(payload.payloadVersion, 2);
  const back = importPayload(payload);
  assert.deepEqual(back.manifest.servers.fs, {});
});

// ── D3 · the Workshop seed: an app whose source is in the volume ────────────

test("forking Workshop writes the Notebook's source into the Cell and pins it", async () => {
  const r = await ok("distroFork", { id: "workshop" });
  assert.ok(r.seeded.includes("apps/notebook/index.html"), "the app's files are written through fs.write");
  const doc = (await ok("state")).doc;
  assert.equal(doc.apps.notebook.origin, "volume");
  assert.equal(doc.apps.notebook.volumePath, "apps/notebook");
  assert.ok(doc.shell.dock.pinned.includes("notebook"));
  assert.ok(doc.windows.some((w) => w.app === "notebook"), "it opens arranged, like every seed");
  const read = await callAs(kernel, owner, held, "fs", "read", { path: "apps/notebook/app.js" });
  assert.ok(read.ok && /sbx\.write/.test(read.result.content), "the source is ordinary files in the machine");
  const written = await call("appWrite", { id: "notebook", path: "index.html", content: "x" });
  assert.equal(written.ok, false, "and desktop.appWrite says to use fs.write instead");
  assert.match(written.error, /fs\.write/);
});

// ── F1 · the desktop as a map ───────────────────────────────────────────────

test("summarize gives an agent the desktop without pixels", async () => {
  await ok("layoutSet", { mode: "tiling", preset: "master-stack" });
  const r = await ok("summarize", {});
  assert.equal(r.rev, (await ok("state")).rev);
  assert.match(r.map, /workspace 1 "Main" \(active\)/);
  assert.match(r.map, /tiles: ⇔60%/, "the tiling tree is described, not drawn");
  assert.match(r.map, /notebook \(bundle\)/);
  assert.match(r.map, /forked from Workshop/);
  await ok("layoutSet", { mode: "floating" });
});

test("silhouette is shapes in the theme's colours and nothing else", async () => {
  await ok("open", { app: "notes", title: "my secret diary" });
  const r = await ok("silhouette", { width: 300, height: 180 });
  assert.match(r.svg, /^<svg /);
  assert.ok(!r.svg.includes("secret"), "no title, no content — a shape, not a screenshot");
  assert.ok((r.svg.match(/<rect/g) ?? []).length >= 4);
  const huge = await ok("silhouette", { width: 99999 });
  assert.match(huge.svg, /width="1600"/, "size is clamped");
});

// ── D1/D4 · a new machine can wake up wearing a distro, or a chosen seed ────

test("POST /api/sandboxes with a distro instantiates the Cell composition and the desktop", async () => {
  const { createServer } = await import("../apps/gateway/src/server.js");
  const { mintMachineToken, getSandboxBySlug } = await import("../packages/control-db/src/registry.js");
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p29" }).token;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    await ok("distroPublish", { name: "Toolful Box", replace: true, visibility: "tenant" });
    const slug = `wear-${Date.now().toString(36)}`;
    const r = await fetch(`http://127.0.0.1:${port}/api/sandboxes`, { method: "POST", headers, body: JSON.stringify({ slug, name: "worn", distro: "Toolful Box" }) });
    const body = await r.json();
    assert.equal(body.ok, true, body.error);
    assert.equal(body.wearing, "Toolful Box");
    const sb = getSandboxBySlug(slug);
    assert.equal(hasOs(sb), true, "the desktop exists before anyone opens it — it was asked for");
    const d = await import("../packages/os/src/store.js").then((m) => m.loadOs(sb));
    assert.ok(d.apps.notebook, "custom apps came along (the desktop was wearing Workshop when it was published)");
    assert.equal(d.distro.name, "Toolful Box");

    const slug2 = `seed-${Date.now().toString(36)}`;
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sandboxes`, { method: "POST", headers, body: JSON.stringify({ slug: slug2, name: "seeded", seed: "minimal" }) });
    const body2 = await r2.json();
    assert.equal(body2.wearing, "Minimal");
    const d2 = await import("../packages/os/src/store.js").then((m) => m.loadOs(getSandboxBySlug(slug2)));
    assert.equal(d2.theme.base, "mono");
    assert.equal(d2.windows.length, 1, "a chosen seed, not Developer Box");
  } finally { srv.close(); }
});
