// Phase 44: the two halves of T2.2 that were still missing.
//
// goal.md's editor clause asked for four things: search and replace across a
// bundle, the frame's errors coming back, a symbol jump within a file, and a
// diff against the last saved version. The first two shipped with Track 2. These
// are the other two, and the interesting part of both is what they deliberately
// are not.
//
// The symbol list is not a parser. It is the shapes a definition takes in the
// four languages a bundle is made of, matched line by line — enough to answer
// "where is that defined" in a file of a few hundred lines, and honest about
// being a list of lines. A JavaScript parser in the Studio would cost more than
// the question is worth.
//
// The diff is against `tab.saved`, which every tab already holds. It answers
// "what am I about to write" before you press save — including after an agent
// wrote the file underneath you.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const code = fs.readFileSync(new URL("../apps/gateway/public/js/os/code.js", import.meta.url), "utf8");

/** Run one of the editor's own pure helpers, lifted out of the module. */
function lift(name, extra = "") {
  const start = code.indexOf(`  function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  // Take from the declaration to the closing brace at the same indentation.
  const end = code.indexOf("\n  }\n", start);
  assert.ok(end > start, `${name} is a block`);
  const body = code.slice(start, end + 4);
  // eslint-disable-next-line no-new-func
  return new Function(`${extra}\n${body}\nreturn ${name};`)();
}

const SYMBOL_RULES_SRC = (() => {
  const start = code.indexOf("  const SYMBOL_RULES = [");
  const end = code.indexOf("  ];", start);
  return code.slice(start, end + 4);
})();

// ── the symbol list ─────────────────────────────────────────────────────────

test("it finds the shapes a definition takes in a bundle", () => {
  const symbolsIn = lift("symbolsIn", SYMBOL_RULES_SRC);
  const js = [
    "// a comment that mentions function nothing",
    "export function greet(name) { return name; }",
    "async function load() {}",
    "export class Thing {}",
    "const later = async () => 42;",
    "const COUNT = 12;",
    "let mut = 3;",
    "function* gen() {}",
    "  method(a, b) {",
    "  handler: async () => {},",
  ].join("\n");
  const found = symbolsIn(js, "js");
  const byName = Object.fromEntries(found.map((s) => [s.name, s]));

  assert.equal(byName.greet?.kind, "fn");
  assert.equal(byName.greet?.line, 2, "and where it is");
  assert.equal(byName.load?.kind, "fn");
  assert.equal(byName.Thing?.kind, "class");
  assert.equal(byName.later?.kind, "fn", "an arrow assigned to a name is a function, not a constant");
  assert.equal(byName.COUNT?.kind, "const");
  assert.equal(byName.mut?.kind, "const");
  assert.equal(byName.gen?.kind, "fn");
  assert.ok(byName.method || byName.handler, "and a method inside an object or class");
  assert.equal(found.some((s) => s.name === "nothing"), false, "a comment is not a definition");
});

test("a CSS selector and an HTML id are definitions in their own languages", () => {
  const symbolsIn = lift("symbolsIn", SYMBOL_RULES_SRC);
  const css = symbolsIn(".card { color: red; }\n#main { padding: 0; }\nbody { margin: 0 }", "css");
  assert.deepEqual(css.map((s) => s.name), [".card", "#main"], "classes and ids, not bare tags");
  assert.ok(css.every((s) => s.kind === "css"));

  const html = symbolsIn('<div id="out"></div>\n<p class="x">hi</p>\n<span id="run"/>', "html");
  assert.deepEqual(html.map((s) => s.name), ["out", "run"], "the ids a script would reach for");

  // And the rules do not cross languages: a CSS rule in a JS file is not a hit.
  assert.deepEqual(symbolsIn(".card { color: red; }", "js"), []);
});

test("an empty or comment-only file says so rather than guessing", () => {
  const symbolsIn = lift("symbolsIn", SYMBOL_RULES_SRC);
  assert.deepEqual(symbolsIn("", "js"), []);
  assert.deepEqual(symbolsIn("// nothing here\n/* nor here */\n", "js"), []);
  assert.match(code, /no definitions found in this file/, "and the panel says it");
});

// ── the diff against the last save ──────────────────────────────────────────

test("the diff is a line diff, and an unchanged file has none", () => {
  const lineDiff = lift("lineDiff");
  const same = lineDiff("a\nb\nc", "a\nb\nc");
  assert.deepEqual(same.map((r) => r.kind), [" ", " ", " "], "nothing added, nothing removed");
  assert.equal(same.every((r) => r.line), true, "and every kept line knows where it is now");
});

test("it says what was added, removed and moved", () => {
  const lineDiff = lift("lineDiff");
  const rows = lineDiff("one\ntwo\nthree", "one\ntwo and a half\nthree\nfour");
  const added = rows.filter((r) => r.kind === "+").map((r) => r.text);
  const removed = rows.filter((r) => r.kind === "-").map((r) => r.text);
  assert.deepEqual(removed, ["two"]);
  assert.deepEqual(added, ["two and a half", "four"]);
  assert.deepEqual(rows.filter((r) => r.kind === " ").map((r) => r.text), ["one", "three"], "the rest is context");

  // A file written from nothing is all additions; a file emptied is all removals.
  assert.equal(lineDiff("", "a\nb").filter((r) => r.kind === "+").length, 2);
  assert.equal(lineDiff("a\nb", "").filter((r) => r.kind === "-").length, 2);
});

test("a new line's number is where it will be, and a removed one has none", () => {
  const lineDiff = lift("lineDiff");
  const rows = lineDiff("keep", "keep\nadded");
  const add = rows.find((r) => r.kind === "+");
  assert.equal(add.line, 2, "the added line's number is its number in the new file");
  const gone = lineDiff("keep\ngone", "keep").find((r) => r.kind === "-");
  assert.equal(gone.line, null, "a removed line has no number in the new file");
});

// ── and both are reachable ──────────────────────────────────────────────────

test("both panels are in the editor's rail, with a keyboard path", () => {
  assert.match(code, /title: "Jump to a definition in this file \(⌘⇧O\)"/);
  assert.match(code, /title: "What has changed since the last save"/);
  assert.match(code, /e\.shiftKey && e\.key\.toLowerCase\(\) === "o"/, "the chord opens the symbol list");
  assert.match(code, /if \(e\.key === "Escape" && !symbolsEl\.hidden\)/, "and Escape closes it");
  assert.match(code, /if \(e\.key === "Escape" && !diffEl\.hidden\)/);
  // They are exclusive: two panels stacked above the editor would leave no editor.
  assert.match(code, /symbolsEl\.hidden = !show;[\s\S]{0,200}diffEl\.hidden = true;/);
  assert.match(code, /diffEl\.hidden = !show;[\s\S]{0,200}symbolsEl\.hidden = true;/);
});

test("the diff reads against what was last written, not against the file on disk", () => {
  // `tab.saved` is set when a file is opened and when it is saved, which is
  // exactly "the last version this editor wrote or read".
  assert.match(code, /tab = \{ path, editor, host, dirty: false, saved: content \}/);
  assert.match(code, /tab\.saved = value;/);
  assert.match(code, /lineDiff\(tab\.saved \?\? "", tab\.editor\.getValue\(\)\)/);
});
