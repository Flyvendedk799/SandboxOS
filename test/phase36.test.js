// Phase 36: craft, and the keyboard.
//
// T2.5, T2.6 and T4.5 of goal.md. A theme that cannot be read is refused rather
// than shipped into every window; the inspector edits the fields an agent can
// write, with the ceilings printed; publishing says what travels and what does
// not; and the whole OS is reachable without a pointer.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import {
  BUILTIN_THEMES, checkContrast, contrastRatio, luminance, resolveTheme, CONTRAST_RULES,
} from "../packages/os/src/themes.js";
import { KEY_ACTIONS } from "../packages/os/src/keys.js";

let kernel, owner, sandbox, held;
const call = (tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
const ok = async (tool, args) => { const r = await call(tool, args); assert.ok(r.ok, `desktop.${tool}: ${r.error}`); return r.result; };

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── T4.5 · a theme has to be readable ───────────────────────────────────────

test("contrast is measured, not asserted", () => {
  assert.equal(Math.round(contrastRatio("#ffffff", "#000000")), 21, "white on black is the maximum");
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1, "and a colour on itself is the minimum");
  assert.equal(contrastRatio("not a colour", "#000000"), null, "a non-colour has no ratio");
  assert.ok(luminance("#000000") === 0);
  assert.ok(CONTRAST_RULES.every((r) => r.what && r.min >= 3), "every rule says what it is for");
});

test("every built-in theme passes its own check", () => {
  for (const key of Object.keys(BUILTIN_THEMES)) {
    const verdict = checkContrast(resolveTheme({ theme: { base: key } }));
    assert.equal(verdict.ok, true, `${key}: ${verdict.warnings.map((w) => w.text).join("; ")}`);
  }
});

test("a theme with a dim accent is warned about, not refused", async () => {
  const r = await ok("themeDefine", { key: "dim-accent", name: "Dim", base: "midnight", tokens: { accent: "#111418" } });
  assert.ok(r.warnings?.length, "the warning comes back with the result");
  assert.match(r.warnings[0].text, /accent on a panel is 1\.\d+:1 \(wants 3:1\)/);
  // It is your machine: the theme is there, and now switchable.
  assert.ok((await ok("state", {})).doc.theme.custom["dim-accent"], "and the theme exists");
});

test("a theme whose text cannot be read is refused, and not left behind", async () => {
  const r = await call("themeDefine", { key: "unreadable", name: "Nope", base: "midnight", tokens: { text: "#0e1319" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unreadable_theme");
  assert.match(r.error, /body text on a panel/);
  const doc = (await ok("state", {})).doc;
  assert.equal(doc.theme.custom.unreadable, undefined, "the refused theme is rolled back, not stored");
});

// ── T4.5 · reachable without a pointer ──────────────────────────────────────

test("the chrome carries roles and names", () => {
  const shell = read("../apps/gateway/public/js/os/shell.js");
  assert.match(shell, /h\("div\.os-menubar", \{ role: "menubar"/);
  assert.match(shell, /h\("div\.os-dock", \{ role: "toolbar", "aria-label": "Dock" \}\)/);
  assert.match(shell, /h\("div\.os-desktop", \{ role: "main"/);
  assert.match(shell, /panel\.setAttribute\("aria-modal", "true"\)/, "an overlay announces itself as a dialog");
  assert.match(shell, /\(first \?\? panel\)\.focus\?\.\(\)/, "and takes focus so the keyboard can answer it");
});

test("a window and a sash can be driven from the keyboard", () => {
  const wm = read("../apps/gateway/public/js/os/wm.js");
  assert.match(wm, /tabindex: "0",\s*\n\s*role: "toolbar",/, "the title bar is focusable");
  assert.match(wm, /role: "group",/, "and the window is a named group");
  assert.match(wm, /role: "separator",/, "a sash is a separator");
  assert.match(wm, /"aria-orientation": s\.dir === "row" \? "vertical" : "horizontal"/);
  assert.match(wm, /const forward = s\.dir === "row" \? "ArrowRight" : "ArrowDown";/, "with arrow keys that move it");
});

test("focus is never trapped inside an app", () => {
  const bridge = read("../apps/gateway/public/js/os/bridge.js");
  assert.match(bridge, /type: "focusOut"/, "Escape inside a frame asks to leave");
  assert.match(bridge, /e\.defaultPrevented/, "unless the app claimed the key itself");
  const frames = read("../apps/gateway/public/js/os/frames.js");
  assert.match(frames, /case "focusOut":/);
  const wm = read("../apps/gateway/public/js/os/wm.js");
  assert.match(wm, /onFocusOut: \(\) => wins\.get\(win\.id\)\?\.bar\?\.focus\?\.\(\)/, "and focus lands on the window's chrome");
});

test("every keyboard action the shell honours has a handler", () => {
  const shell = read("../apps/gateway/public/js/os/shell.js");
  const handlers = shell.split("const ACTIONS = {")[1].split("};")[0];
  for (const action of Object.keys(KEY_ACTIONS)) {
    assert.match(handlers, new RegExp(`\\b${action}:`), `${action} is bound to something`);
  }
});

// ── T2.5 · the inspector edits the definition ───────────────────────────────

test("the inspector edits the fields an agent can write", () => {
  const builder = read("../apps/gateway/public/js/os/builder.js");
  const section = builder.split("function appSection(")[1].split("\n  function render()")[0];
  for (const field of ["name", "icon", "hue", "description", "permissions"]) {
    assert.match(section, new RegExp(`\\b${field}\\b`), `${field} is editable`);
  }
  assert.match(section, /refreshMs/, "a widget's clock");
  assert.match(section, /singleton/, "an app's window rule");
  assert.match(section, /alias/, "and where an alias points");
  // The ceilings are printed rather than discovered by hitting them.
  assert.match(section, /64 characters/);
  assert.match(section, /300 characters/);
  assert.match(section, /up to 32/);
  assert.match(section, /appSuspend/, "and the suspend switch is here too");
});

test("the fields it writes are the fields the tool accepts", async () => {
  await ok("appDefine", { id: "field-test", name: "Field Test" });
  // Exactly what the inspector sends, one field at a time.
  await ok("appDefine", { id: "field-test", name: "Renamed" });
  await ok("appDefine", { id: "field-test", icon: "network" });
  await ok("appDefine", { id: "field-test", hue: "#7be3d0" });
  await ok("appDefine", { id: "field-test", description: "what it is for" });
  await ok("appDefine", { id: "field-test", permissions: ["fs.read", "ports.list"] });
  await ok("appDefine", { id: "field-test", window: { singleton: true } });
  const app = (await ok("state", {})).doc.apps["field-test"];
  assert.equal(app.name, "Renamed");
  assert.equal(app.icon, "network");
  assert.equal(app.hue, "#7be3d0");
  assert.equal(app.description, "what it is for");
  assert.deepEqual(app.permissions, ["fs.read", "ports.list"]);
  assert.equal(app.window.singleton, true);
  // And the refusals are the tool's, so the inspector cannot invent a way round.
  const bad = await call("appDefine", { id: "field-test", hue: "rebeccapurple; drop table" });
  assert.ok(bad.ok, "a bad colour is dropped rather than fatal");
  assert.equal((await ok("state", {})).doc.apps["field-test"].hue, "#7be3d0", "and the old one stands");
});

// ── T2.6 · publishing that reassures ────────────────────────────────────────

test("the publish dialog says what travels and what stays behind", () => {
  const builder = read("../apps/gateway/public/js/os/builder.js");
  const dialog = builder.split("async function publish()")[1].split("confirmLabel: \"Publish\"")[0];
  assert.match(dialog, /What travels/);
  assert.match(dialog, /What stays behind/);
  assert.match(dialog, /Secrets/, "and names the thing people worry about");
  assert.match(dialog, /never travel/);
  assert.match(dialog, /SHA-256 per bundle/, "with the integrity story");
  assert.match(dialog, /distroExport/, "counted from a real export, not a description of one");
});

test("what the dialog promises is what the payload does", async () => {
  await ok("appDefine", { id: "travelling", name: "Travelling", permissions: ["fs.read"] });
  const { payload } = await ok("distroExport", {});
  assert.ok(payload.bundles.apps.travelling, "the app's source travels");
  assert.ok(payload.integrity, "with a hash per bundle");
  assert.equal(JSON.stringify(payload).includes("sbx_session"), false, "and no credential does");
  const asText = JSON.stringify(payload);
  assert.equal(asText.includes("\"secrets\":{\"") && asText.includes("value"), false, "nor a secret value");
});
