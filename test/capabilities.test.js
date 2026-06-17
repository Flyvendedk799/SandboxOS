import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { patternMatches, authorize, patternCovers, canDelegate } from "../packages/kernel/src/capabilities.js";

test("wildcard '*' matches anything", () => {
  assert.ok(patternMatches("*", "fs", "read"));
  assert.ok(patternMatches("*", "proc", "exec"));
});

test("server wildcard 'fs.*' matches only that server", () => {
  assert.ok(patternMatches("fs.*", "fs", "write"));
  assert.ok(!patternMatches("fs.*", "proc", "exec"));
});

test("exact 'proc.exec' matches only that tool", () => {
  assert.ok(patternMatches("proc.exec", "proc", "exec"));
  assert.ok(!patternMatches("proc.exec", "proc", "list"));
});

test("authorize is default-deny and returns the matching pattern", () => {
  assert.equal(authorize(["fs.read"], "fs", "read"), "fs.read");
  assert.equal(authorize(["fs.read"], "fs", "write"), null); // denied
  assert.equal(authorize([], "fs", "read"), null);           // nothing granted
  assert.equal(authorize(["*"], "anything", "goes"), "*");
});

test("patternCovers: delegation only attenuates", () => {
  assert.ok(patternCovers("*", "fs.read"));        // * covers anything
  assert.ok(patternCovers("fs.*", "fs.read"));     // fs.* covers fs.read
  assert.ok(patternCovers("fs.read", "fs.read"));  // exact
  assert.ok(!patternCovers("fs.read", "fs.write")); // can't widen
  assert.ok(!patternCovers("fs.*", "proc.exec"));   // wrong server
  assert.ok(!patternCovers("fs.read", "*"));        // can't escalate to *
});

test("canDelegate: holder can only grant a subset of what it holds", () => {
  assert.ok(canDelegate(["fs.*"], "fs.read"));
  assert.ok(canDelegate(["*"], "proc.exec"));
  assert.ok(!canDelegate(["fs.read"], "fs.write"));
  assert.ok(!canDelegate(["fs.*"], "*"));
});
