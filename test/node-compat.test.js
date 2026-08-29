// The Node floor, and why it is where it is.
//
// The floor used to read "Node 24", which was a good deal stricter than the truth and
// turned away anyone on the 22 LTS line. The only thing that ever needed a newer Node
// was `node:sqlite`, and that stops needing a flag at 22.13 — so that is the number, and
// these tests pin the comparison that enforces it.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_NODE, assertSupportedNode, atLeast, quietSqliteWarning } from "../packages/config/src/node-compat.js";

test("the version comparison handles every shape a Node version comes in", () => {
  assert.ok(atLeast("22.13.0"));
  assert.ok(atLeast("v22.13.0"), "process.version carries a leading v");
  assert.ok(atLeast("22.22.2"));
  assert.ok(atLeast("24.0.0"));
  assert.ok(atLeast("100.0.0"), "a two-digit major must not compare as a string");
  assert.ok(!atLeast("22.12.0"), "22.12 needs --experimental-sqlite");
  assert.ok(!atLeast("22.5.0"));
  assert.ok(!atLeast("20.18.1"));
  assert.ok(atLeast("22.13"), "a missing patch reads as 0, not as unsupported");
});

test("an unsupported Node is refused with all three ways out", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.13.0"));
  assert.doesNotThrow(() => assertSupportedNode(), "the Node running this suite must be supported");
  assert.throws(() => assertSupportedNode("20.11.0"), (e) => {
    assert.match(e.message, /Node 20\.11\.0/);
    assert.match(e.message, /--experimental-sqlite/);
    assert.match(e.message, /better-sqlite3/);
    return true;
  });
});

test("package.json declares the same floor the code enforces", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // A drifting engines field is worse than none: it is the first thing anyone checks and
  // the last thing anyone updates.
  assert.equal(pkg.engines.node, `>=${MIN_NODE}`);
});

test("the control DB opens on this Node, whatever it is", async () => {
  const { openDb, closeDb } = await import("../packages/control-db/src/db.js");
  const db = openDb();
  assert.equal(db.prepare("SELECT 1 AS one").get().one, 1);
  closeDb();
});

test("the SQLite experimental notice is dropped and every other warning survives", () => {
  // Run last in this file: it takes Node's own warning printer off the process, which
  // is the only way to stop the line appearing at all — adding a listener beside the
  // default one filters nothing.
  quietSqliteWarning();
  quietSqliteWarning(); // idempotent: several entry points import this

  const printed = [];
  const realError = console.error;
  console.error = (...args) => printed.push(args.join(" "));
  try {
    process.emit("warning", Object.assign(new Error("SQLite is an experimental feature"), { name: "ExperimentalWarning" }));
    process.emit("warning", Object.assign(new Error("something worth knowing"), { name: "DeprecationWarning" }));
  } finally {
    console.error = realError;
  }

  assert.ok(!printed.some((line) => /SQLite/.test(line)), "the notice nobody can act on is dropped");
  assert.ok(printed.some((line) => /DeprecationWarning: something worth knowing/.test(line)),
    "a blanket --no-warnings would hide this one too, which is the opposite of the goal");
});
