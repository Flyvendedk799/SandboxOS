// Phase 30: presence, and the second surface.
//
// The document renders on a phone, in a terminal, and as a map for an agent —
// and the same tests that pin the contract pin the craft: every built-in theme
// reads, motion respects the viewer, and two clients plus an agent converge on
// one revision with the loser of a race told, not overwritten.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, mintMachineToken } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { BUILTIN_THEMES, cleanTokens, themeCss, resolveTheme } from "../packages/os/src/themes.js";
import { normalizeDoc } from "../packages/os/src/schema.js";
import { summarizeDoc, silhouetteSvg } from "../packages/os/src/summary.js";

let kernel, owner, sandbox, held, srv, port, token;
const call = (tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
const ok = async (tool, args) => { const r = await call(tool, args); assert.ok(r.ok, `desktop.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p30" }).token;
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  await ok("reset", {});
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); });

// ── E3 · craft you can measure ──────────────────────────────────────────────

/** WCAG relative luminance and contrast ratio, for hex colours. */
function luminance(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
const contrast = (a, b) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

test("every built-in theme reads: body text passes AA on panels, muted text passes AA-large", () => {
  for (const [key, t] of Object.entries(BUILTIN_THEMES)) {
    assert.ok(contrast(t.text, t.bg1) >= 4.5, `${key}: text on bg1 is ${contrast(t.text, t.bg1).toFixed(2)}`);
    assert.ok(contrast(t.text2, t.bg1) >= 4.5, `${key}: text2 on bg1 is ${contrast(t.text2, t.bg1).toFixed(2)}`);
    assert.ok(contrast(t.text3, t.bg1) >= 3, `${key}: text3 on bg1 is ${contrast(t.text3, t.bg1).toFixed(2)}`);
    assert.ok(contrast(t.accent, t.bg1) >= 3, `${key}: accent on bg1 is ${contrast(t.accent, t.bg1).toFixed(2)}`);
  }
});

test("grain is a clamped number compiled into a custom property, never an image", () => {
  assert.deepEqual(cleanTokens({ grain: 9 }), { grain: 0.4 });
  assert.deepEqual(cleanTokens({ grain: "url(x)" }), {});
  assert.deepEqual(cleanTokens({ grain: 0.123 }), { grain: 0.12 });
  const css = themeCss(resolveTheme(normalizeDoc({ theme: { base: "midnight", tokens: { grain: 0.2 } } })));
  assert.match(css, /--os-grain: 0\.2;/);
  assert.ok(!css.includes("url("));
});

test("reduced motion is a document choice with a closed vocabulary", async () => {
  assert.equal(normalizeDoc({}).animation.reducedMotion, "auto");
  assert.equal(normalizeDoc({ animation: { reducedMotion: "yes please" } }).animation.reducedMotion, "auto");
  await ok("patch", { patch: { animation: { reducedMotion: "ignore" } } });
  assert.equal((await ok("state")).doc.animation.reducedMotion, "ignore");
  await ok("patch", { patch: { animation: { reducedMotion: "auto" } } });
});

test("a notification's action is validated like everything else", () => {
  const doc = normalizeDoc({ notifications: [
    { title: "a", action: { app: "metrics", window: "not an id!", props: { x: 1 } } },
    { title: "b", action: { nothing: true } },
  ] });
  assert.deepEqual(doc.notifications[0].action, { app: "metrics", window: null, props: { x: 1 } });
  assert.equal(doc.notifications[1].action, undefined, "an action that points nowhere is dropped");
});

// ── F1 · the map and the silhouette are pure ────────────────────────────────

test("summarizeDoc and silhouetteSvg run on a bare document, no Kernel needed", () => {
  const doc = normalizeDoc({ name: "bare", windows: [{ app: "files", title: "<script>" }], wm: { mode: "tiling" } });
  const map = summarizeDoc(doc);
  assert.match(map, /bare · rev 0/);
  assert.match(map, /tiles: /);
  const svg = silhouetteSvg(doc);
  assert.ok(!svg.includes("<script>"), "nothing from the document's strings reaches the SVG unescaped");
  assert.match(svg, /<svg /);
});

// ── F3 · two clients, one agent, one revision ───────────────────────────────

/** Read an SSE stream into a list of parsed events until `count` documents arrive. */
async function collect(count, signal) {
  const res = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/os/events`, { headers: { Authorization: `Bearer ${token}` }, signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const revs = [];
  let buf = "";
  while (revs.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const data = f.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.doc) revs.push(ev.doc.rev);
    }
  }
  return revs;
}

test("two event-stream clients and an agent converge on the same revision, in order", async () => {
  const ac = new AbortController();
  const a = collect(3, ac.signal);
  const b = collect(3, ac.signal);
  await new Promise((r) => setTimeout(r, 150)); // let both streams say hello
  const w = (await ok("open", { app: "notes" })).window;
  await ok("move", { id: w.id, x: 10, y: 10 });
  await ok("themeSet", { theme: "tide" });
  const [ra, rb] = await Promise.all([a, b]);
  ac.abort();
  assert.deepEqual(ra, rb, "both clients saw the same revisions");
  assert.deepEqual(ra, [...ra].sort((x, y) => x - y), "in ascending order");
  assert.equal(ra.at(-1), (await ok("state")).rev, "ending at the current document");
  await ok("close", { id: w.id });
  await ok("themeSet", { theme: "midnight" });
});

test("a gesture and an agent race: the conditional write loses honestly, the other lands", async () => {
  const w = (await ok("open", { app: "files" })).window;
  const { rev } = await ok("state");
  // Both were painted against `rev`. The agent commits first.
  const agent = call("move", { id: w.id, x: 300, y: 300, expectRev: rev });
  const gesture = call("move", { id: w.id, x: 20, y: 20, expectRev: rev });
  const [ra, rg] = await Promise.all([agent, gesture]);
  const winners = [ra, rg].filter((r) => r.ok);
  const losers = [ra, rg].filter((r) => !r.ok);
  assert.equal(winners.length, 1, "exactly one write lands");
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "stale_rev", "the other is told it lost, with a code it can act on");
  const now = (await ok("state")).doc.windows.find((x) => x.id === w.id);
  assert.ok((now.x === 300 && now.y === 300) || (now.x === 20 && now.y === 20));
  // Unconditional writes are last-write-wins, by design and by name.
  await call("move", { id: w.id, x: 1, y: 1 });
  await call("move", { id: w.id, x: 2, y: 2 });
  assert.equal((await ok("state")).doc.windows.find((x) => x.id === w.id).x, 2);
  await ok("close", { id: w.id });
});

test("an out-of-order event can never rewind the desktop (the client rule, pinned server-side)", async () => {
  // The server only ever emits ascending revisions from one bus; the client
  // additionally drops anything older than what it holds. Pin the first half.
  const ac = new AbortController();
  const p = collect(4, ac.signal);
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 4; i += 1) await ok("layoutSet", { gap: 8 + i });
  const revs = await p;
  ac.abort();
  for (let i = 1; i < revs.length; i += 1) assert.ok(revs[i] > revs[i - 1]);
  await ok("layoutSet", { gap: 12 });
});
