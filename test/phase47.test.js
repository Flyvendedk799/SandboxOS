// Phase 47: the chrome, and one lie it used to tell.
//
// Two kinds of thing here, both found by looking at the OS rather than at the
// code: a conditional-write rule that surfaced as an accusation, and a set of
// layout rules that were quietly wrong in every list the machine has.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => readSource(new URL(rel, import.meta.url));
const client = read("../apps/gateway/public/js/os/client.js");
const css = read("../apps/gateway/public/os.css");
const ops = read("../apps/gateway/public/js/os/ops.js");

// ── an app recording itself is not a place ─────────────────────────────────

test("only a write that describes a place is conditional", () => {
  const fn = client.split("function describesAPlace(tool, args)")[1].split("\n}")[0];
  assert.match(fn, /if \(tool !== "windowSet" && tool !== "widgetSet"\) return true;/,
    "every other conditional tool is unambiguously about a place");
  assert.match(fn, /PLACE_KEYS\.some\(\(k\) => args\[k\] !== undefined\)/);
  assert.match(client, /const PLACE_KEYS = \["x", "y", "w", "h", "ws", "min", "max", "pin", "z"\];/);
  assert.match(client, /const guard = conditional && describesAPlace\(tool, args\);/,
    "and the guard is what decides whether expectRev is sent");
});

test("the rule sorts the calls the way the apps actually make them", () => {
  // Lifted out of the module so the logic itself is exercised, not just its text.
  const src = client.slice(client.indexOf("const PLACE_KEYS"), client.indexOf("export async function call"));
  // eslint-disable-next-line no-new-func
  const describesAPlace = new Function(`${src}\nreturn describesAPlace;`)();

  // A drag, an inspector field, a tiling change: places.
  assert.equal(describesAPlace("windowSet", { id: "w1", x: 10, y: 20 }), true);
  assert.equal(describesAPlace("windowSet", { id: "w1", min: true }), true);
  assert.equal(describesAPlace("widgetSet", { id: "g1", pin: "right" }), true);
  assert.equal(describesAPlace("move", { id: "w1" }), true, "move is always a place");
  assert.equal(describesAPlace("arrange", { preset: "grid" }), true);

  // An app storing what it is showing: not a place, and not in competition with
  // anyone. Two of these in one tick used to collide with each other.
  assert.equal(describesAPlace("windowSet", { id: "w1", title: "Terminal" }), false);
  assert.equal(describesAPlace("windowSet", { id: "w1", props: { session: "pty_1" } }), false);
  assert.equal(describesAPlace("windowSet", { id: "w1", props: { path: "src" } }), false);
  assert.equal(describesAPlace("widgetSet", { id: "g1", props: { tick: 3 } }), false);
});

// ── a row is a row ─────────────────────────────────────────────────────────

test("a list row aligns its columns and keeps its pills small", () => {
  const row = css.split(".row-line {")[1].split("}")[0];
  assert.match(row, /align-items: center/, "children sit on the row, they do not stretch to fill it");
  assert.match(css, /\.row-line > span:first-child \{ flex: 1 1 auto; min-width: 0;/,
    "the label takes the slack, so what follows it lines up down the list");
  assert.match(css, /\.row-line > :not\(:first-child\) \{ flex: none; \}/);
  assert.match(css, /\.row-line \.sz \{[^}]*text-align: right/, "a number column is right-aligned");
  assert.match(css, /\.row-line \.sz \{[^}]*tabular-nums/, "with figures that line up");

  const pill = css.split(".ops-pill {")[1].split("}")[0];
  assert.match(pill, /flex: none/, "a status pill keeps its size");
  assert.match(pill, /align-self: center/, "…and its shape: a stretched 999px radius is an oval blob");
  assert.match(pill, /line-height: 15px/);
});

test("a row whose second half is a sentence still gets to be one", () => {
  assert.match(css, /\.row-line\.wrap > span:first-child \{ white-space: normal;/,
    "ellipsis is right for a log and wrong for a table of contents");
  const help = read("../apps/gateway/public/js/os/help.js");
  assert.match(help, /button\.row-line\.wrap/, "the manual's contents wrap");
  assert.equal((help.match(/button\.row-line\.wrap/g) ?? []).length >= 3, true,
    "and so do its search hits and its per-server tool lists");
});

test("a split pane gives the list the room the window has", () => {
  const list = css.split(".ops-list {")[1].split("}")[0];
  assert.match(list, /width: 34%/, "proportional, not a fixed 260px beside an acre of paragraph");
  assert.match(list, /min-width: 240px/);
  assert.match(list, /max-width: 380px/, "and it stops before it becomes a page of its own");
  assert.match(css, /@media \(max-width: 720px\) \{\s*\n\s*\.ops-list, \.ops-list\.wide \{ width: 100%/,
    "under a certain width there is not room for two panes");
});

test("Settings is a form, not a spreadsheet", () => {
  assert.match(css, /\.settings-col \{ max-width: 620px; \}/, "a label and its control keep each other's company");
  assert.match(css, /\.settings-col \.kv \{ display: grid; grid-template-columns: 170px minmax\(0, 1fr\);/,
    "two columns, so the controls share a left edge");
  const builtins = read("../apps/gateway/public/js/os/builtins.js");
  assert.match(builtins, /h\("div\.settings-col", null, \.\.\.\(section === "machine" \? machineSection : desktopSection\)\)/);
});

// ── Ports answers the question it was opened for ───────────────────────────

test("Ports puts what is exposed above what is merely listening", () => {
  const paint = ops.split("const ports = {")[1].split("const agents = {")[0];
  const exposedAt = paint.indexOf('h("div.ops-head", `Exposed');
  const listeningAt = paint.indexOf('h("div.ops-head", `Listening inside the machine');
  assert.ok(exposedAt > 0 && listeningAt > 0, "both sections exist");
  assert.ok(exposedAt < listeningAt, "and the short, useful one comes first");
  assert.match(paint, /const unexposed = listening\.filter\(\(p\) => !exposedPorts\.has\(p\.port\)\)/,
    "a port that is already exposed is not also listed as merely listening");
  assert.match(paint, /h\("span\.ops-pill\.ok", "open"\)/, "an exposed port reads as open at a glance");
});

test("the audit reads down its columns", () => {
  const audit = ops.split("const audit = {")[1];
  assert.match(audit, /h\("span\.sz\.when", clock\(e\.ts\)\)/, "the time is its own column");
  assert.match(audit, /class: e\.result_kind === "ok" \? "" : "bad"/, "and a refusal is visible before it is read");
  assert.match(css, /\.row-line \.sz\.when \{ min-width: 76px; \}/, "wide enough for the longest time it holds");
  assert.match(css, /\.row-line\.bad \{ border-left-color:/);
});
