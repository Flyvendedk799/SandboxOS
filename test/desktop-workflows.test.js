import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fsServer } from "../packages/kernel/src/servers/fs.js";
import { droppedPaths } from "../apps/gateway/public/js/os/folder-upload.js";

test("Trash restores nested folders, preserves replacements and excludes deleted content from search", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-trash-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { tools } = fsServer({ root, ensureRunning: async () => {} });
  const call = (tool, args = {}) => tools[tool].handler({}, args);
  const file = "nested/project/old.txt";
  await call("write", { path: file, content: "one\nFind this line" });
  const original = await call("trash", { path: "nested/project" });
  await call("write", { path: file, content: "replacement" });
  await assert.rejects(call("restore", { id: original.id }), /occupied/);
  const replacement = await call("trash", { path: "nested/project" });
  assert.equal((await call("trashList")).items.length, 2);
  assert.deepEqual((await call("search", { query: "find", paths: true })).matches, []);
  await fs.rmdir(path.join(root, "nested"));
  await call("restore", { id: original.id });
  assert.equal((await call("read", { path: file })).content, "one\nFind this line");
  assert.deepEqual((await call("search", { query: "Find" })).matches, [{ path: file, line: 2, text: "Find this line" }]);
  assert.deepEqual((await call("search", { query: "old.txt", paths: true })).paths, [file]);
  assert.deepEqual((await call("trashList")).items.map(i => i.id), [replacement.id]);
  assert.deepEqual((await call("list")).entries.map(i => i.name), ["nested"]);
  await assert.rejects(call("trash", { path: "." }));
  await assert.rejects(call("restore", { id: "../nested" }));
});

test("folder drop reads every directory batch and retains empty folders", async () => {
  const file = { name: "note.txt" };
  const entry = { name: file.name, isFile: true, file: cb => cb(file) };
  const dir = (name, batches) => ({ name, createReader() {
    let i = 0;
    return { readEntries: cb => cb(batches[i++] ?? []) };
  } });
  const tree = dir("project", [[dir("empty", [])], [dir("notes", [[entry]])]]);
  const result = await droppedPaths({ items: [{ webkitGetAsEntry: () => tree }] });
  assert.deepEqual(result, [{ path: "project" }, { path: "project/empty" }, { path: "project/notes" }, { path: "project/notes/note.txt", file }]);
});
