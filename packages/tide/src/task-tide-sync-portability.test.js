// task-tide-sync-portability.test.js
// Acceptance test suite for Tide Protocol Sync Primitives and Workspace Portability.
//
// Covers:
//  - C1: Tide bidirectional sync, working tree marks, revision tracking, structural diffs.
//  - C2: Workspace state serialization/deserialization, volume export/restore without corruption or path traversal.
//  - C3: Tide core primitives, branch/mark tracking, and full workspace export and restore without data loss.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  writeBlob, writeTree, buildTreeFromDir, diffTrees, diffTreesDetailed, summarizeDiff,
  assertSafePath, exportVolume, restoreVolume,
} from "./objects.js";
import { Repo } from "./repo.js";
import { TideClient } from "./client.js";
import { runDaemon } from "./daemon.js";

const tmp = (tag = "tide-p") => path.join(os.tmpdir(), `${tag}-${crypto.randomUUID().slice(0, 8)}`);
const write = (dir, relPath, content) => {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

// ═════════════════════════════════════════════════════════════════════════════
// C1: Tide Bidirectional Sync, Revisions & Structural Diffs
// ═════════════════════════════════════════════════════════════════════════════

test("[C1] working tree changes are detected, marked, and track revisions", () => {
  const store = tmp("store");
  const workdir = tmp("work");
  const repo = new Repo(store);
  repo.init("dev", workdir);

  // Initial state: empty
  assert.equal(repo.status("dev").length, 0);

  // Add files
  write(workdir, "src/index.js", "console.log('v1');");
  write(workdir, "README.md", "# Dev Workspace");

  const st1 = repo.status("dev");
  assert.equal(st1.length, 2);
  const byPath1 = Object.fromEntries(st1.map((c) => [c.path, c.status]));
  assert.equal(byPath1["src/index.js"], "added");
  assert.equal(byPath1["README.md"], "added");

  // Mark revision 1
  const rev1 = repo.mark("dev", { message: "Initial commit", author: "alice" });
  assert.ok(rev1);
  assert.equal(repo.head("dev"), rev1);
  assert.equal(repo.status("dev").length, 0);

  // Modify one file, delete one, add one
  write(workdir, "src/index.js", "console.log('v2');");
  fs.unlinkSync(path.join(workdir, "README.md"));
  write(workdir, "config.json", '{"port": 8080}');

  const st2 = repo.status("dev");
  const byPath2 = Object.fromEntries(st2.map((c) => [c.path, c.status]));
  assert.equal(byPath2["src/index.js"], "modified");
  assert.equal(byPath2["README.md"], "deleted");
  assert.equal(byPath2["config.json"], "added");

  // Mark revision 2
  const rev2 = repo.mark("dev", { message: "Update app config", author: "bob" });
  assert.ok(rev2);
  assert.equal(repo.head("dev"), rev2);

  // Revision log tracks history in newest-first order
  const log = repo.log("dev");
  assert.equal(log.length, 2);
  assert.equal(log[0].hash, rev2);
  assert.equal(log[0].parents[0], rev1);
  assert.equal(log[0].message, "Update app config");
  assert.equal(log[1].hash, rev1);
  assert.deepEqual(log[1].parents, []);

  // Numeric limit and object options are both honored
  const logLimitNum = repo.log("dev", 1);
  assert.equal(logLimitNum.length, 1);
  assert.equal(logLimitNum[0].hash, rev2);

  const logLimitObj = repo.log("dev", { limit: 1 });
  assert.equal(logLimitObj.length, 1);
  assert.equal(logLimitObj[0].hash, rev2);
});

test("[C1] structural diffs accurately report added, modified, deleted and type conversions", () => {
  const store = tmp("store");
  const workdir = tmp("work");
  const repo = new Repo(store);
  repo.init("diff-ws", workdir);

  write(workdir, "file.txt", "content v1");
  write(workdir, "nested/sub.txt", "sub content");
  write(workdir, "todelete.txt", "goodbye");
  const revA = repo.mark("diff-ws", { message: "Rev A" });

  // Make modifications
  write(workdir, "file.txt", "content v2");
  fs.unlinkSync(path.join(workdir, "todelete.txt"));
  write(workdir, "newfile.txt", "brand new");

  // Default diff between working tree and revA returns plain {path, status}
  const diffA = repo.diff("diff-ws", revA);
  assert.equal(diffA.stats, undefined, "default diff has no stats property");
  for (const entry of diffA) {
    assert.deepEqual(Object.keys(entry).sort(), ["path", "status"]);
  }

  // Default status also returns plain {path, status}
  const statusA = repo.status("diff-ws");
  assert.equal(statusA.stats, undefined, "default status has no stats property");
  for (const entry of statusA) {
    assert.deepEqual(Object.keys(entry).sort(), ["path", "status"]);
  }

  // Summary statistics are computed via summarizeDiff helper or repo.summarizeDiff
  const statsA = summarizeDiff(diffA);
  assert.equal(statsA.added, 1);
  assert.equal(statsA.modified, 1);
  assert.equal(statsA.deleted, 1);
  assert.equal(statsA.files, 3);
  assert.deepEqual(repo.summarizeDiff(diffA), statsA);

  const byPath = Object.fromEntries(diffA.map((d) => [d.path, d.status]));
  assert.equal(byPath["file.txt"], "modified");
  assert.equal(byPath["newfile.txt"], "added");
  assert.equal(byPath["todelete.txt"], "deleted");

  const revB = repo.mark("diff-ws", { message: "Rev B" });

  // Direct diff between two revisions
  const diffBetween = repo.diff("diff-ws", revA, revB);
  assert.equal(diffBetween.length, 3);
  assert.equal(summarizeDiff(diffBetween).files, 3);
  assert.equal(diffBetween.stats, undefined);

  // Detailed diff carries oldHash and newHash
  const diffDetail = repo.diff("diff-ws", revA, null, { detail: true });
  for (const entry of diffDetail) {
    assert.deepEqual(Object.keys(entry).sort(), ["newHash", "oldHash", "path", "status"]);
  }
  const detailByPath = Object.fromEntries(diffDetail.map((d) => [d.path, d]));
  assert.equal(detailByPath["newfile.txt"].oldHash, null);
  assert.ok(detailByPath["newfile.txt"].newHash);
  assert.ok(detailByPath["todelete.txt"].oldHash);
  assert.equal(detailByPath["todelete.txt"].newHash, null);
  assert.ok(detailByPath["file.txt"].oldHash);
  assert.ok(detailByPath["file.txt"].newHash);

  // Structural diff handles directory replaced by file
  const tree1 = buildTreeFromDir(store, workdir);
  // Replace nested directory with a file named 'nested'
  fs.rmSync(path.join(workdir, "nested"), { recursive: true, force: true });
  write(workdir, "nested", "now a single file");
  const tree2 = buildTreeFromDir(store, workdir);

  const diffReplaced = diffTrees(store, tree1, tree2);
  const repPaths = Object.fromEntries(diffReplaced.map((d) => [d.path, d.status]));
  assert.equal(repPaths["nested/sub.txt"], "deleted");
  assert.equal(repPaths["nested"], "added");

  // Detailed type-change diff: file replacing directory gets null oldHash and file blob newHash;
  // deleted children get child blob oldHash and null newHash
  const diffReplacedDetail = diffTreesDetailed(store, tree1, tree2);
  const repDetail = Object.fromEntries(diffReplacedDetail.map((d) => [d.path, d]));
  assert.ok(repDetail["nested/sub.txt"].oldHash);
  assert.equal(repDetail["nested/sub.txt"].newHash, null);
  assert.equal(repDetail["nested"].oldHash, null);
  assert.ok(repDetail["nested"].newHash);

  // Symmetric case: file replaced by directory
  const diffReplacedReverse = diffTreesDetailed(store, tree2, tree1);
  const repRev = Object.fromEntries(diffReplacedReverse.map((d) => [d.path, d]));
  assert.ok(repRev["nested"].oldHash);
  assert.equal(repRev["nested"].newHash, null);
  assert.equal(repRev["nested/sub.txt"].oldHash, null);
  assert.ok(repRev["nested/sub.txt"].newHash);
});

test("[C1] bidirectional sync between two repos fast-forwards and merges divergence", async () => {
  // Simulate two repos communicating via TideClient mock
  const serverStore = tmp("server-store");
  const serverWork = tmp("server-work");
  const serverRepo = new Repo(serverStore);
  serverRepo.init("main", serverWork);

  const clientStore = tmp("client-store");
  const clientWork = tmp("client-work");
  const clientRepo = new Repo(clientStore);
  clientRepo.init("main", clientWork);

  // Client creates v1 and pushes to server
  write(clientWork, "shared.txt", "line1\nline2\nline3");
  const cRev1 = clientRepo.mark("main", { message: "client v1" });
  assert.ok(cRev1);

  // Mock TideClient that delegates to serverRepo
  const mockClient = {
    slug: "test-slug",
    async remoteHead() { return serverRepo.head("main"); },
    async mcp(server, tool, args) {
      if (server === "tide" && tool === "refs") return { head: serverRepo.head(args.workspace) };
      if (server === "tide" && tool === "fetchObjects") {
        if (!serverRepo.has(args.workspace)) return { head: null, objects: [] };
        return serverRepo.bundle(args.workspace, args.have ?? []);
      }
      if (server === "tide" && tool === "receiveObjects") {
        if (!serverRepo.has(args.workspace)) serverRepo.init(args.workspace, serverWork);
        serverRepo.ingest(args.objects);
        if (!serverRepo.canFastForward(args.workspace, args.head)) {
          return { applied: false, reason: "non-fast-forward", head: serverRepo.head(args.workspace) };
        }
        serverRepo.checkout(args.workspace, args.head);
        return { applied: true, head: args.head };
      }
      throw new Error(`unmocked: ${server}.${tool}`);
    },
  };
  Object.setPrototypeOf(mockClient, TideClient.prototype);

  // Push v1 to server
  const push1 = await mockClient.push(clientRepo, "main");
  assert.ok(push1.applied);
  assert.equal(serverRepo.head("main"), cRev1);
  assert.equal(fs.readFileSync(path.join(serverWork, "shared.txt"), "utf8"), "line1\nline2\nline3");

  // Server makes independent change at bottom line
  write(serverWork, "shared.txt", "line1\nline2\nserver-edit");
  const sRev2 = serverRepo.mark("main", { message: "server v2" });
  assert.ok(sRev2);

  // Client makes disjoint independent change at top line
  write(clientWork, "shared.txt", "client-edit\nline2\nline3");
  const cRev2 = clientRepo.mark("main", { message: "client v2" });
  assert.ok(cRev2);

  // Client pushes, encounters non-fast-forward, pulls (merges) and re-pushes
  let push2 = await mockClient.push(clientRepo, "main");
  assert.equal(push2.applied, false);
  assert.equal(push2.reason, "non-fast-forward");

  const pullRes = await mockClient.pull(clientRepo, "main");
  assert.ok(pullRes.changed);
  assert.ok(pullRes.merged);

  // Merged file contains both non-conflicting edits
  const clientMerged = fs.readFileSync(path.join(clientWork, "shared.txt"), "utf8");
  assert.equal(clientMerged, "client-edit\nline2\nserver-edit");

  // Fast-forward push succeeds after local merge
  const push3 = await mockClient.push(clientRepo, "main");
  assert.ok(push3.applied);
  assert.equal(serverRepo.head("main"), clientRepo.head("main"));
  assert.equal(fs.readFileSync(path.join(serverWork, "shared.txt"), "utf8"), clientMerged);
});

// ═════════════════════════════════════════════════════════════════════════════
// C2: Workspace State Serialization & Volume Security
// ═════════════════════════════════════════════════════════════════════════════

test("[C2] workspace state serialization round-trips environment, manifest, and server states", () => {
  const store = tmp("state-store");
  const workdir = tmp("state-work");
  const repo = new Repo(store);
  repo.init("ws-state", workdir);

  const envData = {
    NODE_ENV: "production",
    PORT: "3000",
    DATABASE_URL: "file:/tmp/app.db",
  };
  const manifestData = {
    version: 1,
    servers: {
      fs: { enabled: true },
      proc: { enabled: true },
      llm: { provider: "anthropic", model: "claude-sonnet-4-6" },
    },
  };
  const serversData = {
    web: { pid: 412, listening: 3000, uptime: 120 },
    worker: { status: "running", queue: "default" },
  };

  // Write individual states
  repo.putState("ws-state", "env", envData);
  repo.putState("ws-state", "manifest", manifestData);
  repo.putState("ws-state", "servers", serversData);

  // Read back individual states
  assert.deepEqual(repo.getState("ws-state", "env"), envData);
  assert.deepEqual(repo.getState("ws-state", "manifest"), manifestData);
  assert.deepEqual(repo.getState("ws-state", "servers"), serversData);

  // Read all states
  const all = repo.getAllStates("ws-state");
  assert.deepEqual(all.env, envData);
  assert.deepEqual(all.manifest, manifestData);
  assert.deepEqual(all.servers, serversData);

  // State objects survive disk reload
  const repo2 = new Repo(store);
  assert.deepEqual(repo2.getState("ws-state", "manifest"), manifestData);
});

test("[C2] volume export and restore operates without data corruption or loss", () => {
  const srcDir = tmp("vol-src");
  write(srcDir, "app.js", "const http = require('http');");
  write(srcDir, "public/index.html", "<h1>Hello World</h1>");
  write(srcDir, "public/style.css", "body { margin: 0; }");
  write(srcDir, "data/records.json", JSON.stringify([{ id: 1, text: "entry" }]));

  // Export volume
  const volumePayload = exportVolume(srcDir);
  assert.equal(volumePayload.kind, "volume");
  assert.equal(volumePayload.files.length, 4);

  // Restore into a fresh target
  const destDir = tmp("vol-dest");
  const res = restoreVolume(destDir, volumePayload, { clean: true });
  assert.equal(res.restored, 4);

  // Check each restored file
  assert.equal(fs.readFileSync(path.join(destDir, "app.js"), "utf8"), "const http = require('http');");
  assert.equal(fs.readFileSync(path.join(destDir, "public/index.html"), "utf8"), "<h1>Hello World</h1>");
  assert.equal(fs.readFileSync(path.join(destDir, "public/style.css"), "utf8"), "body { margin: 0; }");
  assert.equal(fs.readFileSync(path.join(destDir, "data/records.json"), "utf8"), JSON.stringify([{ id: 1, text: "entry" }]));
});

test("[C2] volume restore detects and refuses corrupted file payloads", () => {
  const srcDir = tmp("vol-corrupt-src");
  write(srcDir, "safe.txt", "safe original content");
  const payload = exportVolume(srcDir);

  // Tamper with the payload data without updating the sha256 checksum
  payload.files[0].payload = Buffer.from("tampered altered content").toString("base64");

  const destDir = tmp("vol-corrupt-dest");
  assert.throws(
    () => restoreVolume(destDir, payload),
    /volume file corrupted: sha256 mismatch/i,
  );
  // Ensure the corrupted file was not written to disk
  assert.equal(fs.existsSync(path.join(destDir, "safe.txt")), false);
});

test("[C2] path traversal attempts in volume restore and checkout are rejected", () => {
  const destDir = tmp("traversal-dest");
  fs.mkdirSync(destDir, { recursive: true });

  // 1. Volume payload attempting parent directory traversal
  const evilPayload1 = {
    kind: "volume",
    files: [
      {
        path: "../../../evil.txt",
        payload: Buffer.from("escape").toString("base64"),
      },
    ],
  };
  assert.throws(
    () => restoreVolume(destDir, evilPayload1),
    /path traversal forbidden/i,
  );

  // 2. Volume payload attempting absolute path traversal
  const evilPayload2 = {
    kind: "volume",
    files: [
      {
        path: "/etc/passwd",
        payload: Buffer.from("fake root file").toString("base64"),
      },
    ],
  };
  assert.throws(
    () => restoreVolume(destDir, evilPayload2),
    /path traversal forbidden/i,
  );

  // 3. Tree entry containing unsafe characters in tree checkout
  const store = tmp("tree-traversal-store");
  const blobHash = writeBlob(store, Buffer.from("malicious payload"));
  // writeTree validates entry names
  assert.throws(
    () => writeTree(store, [{ name: "../escape.txt", type: "blob", hash: blobHash }]),
    /path traversal forbidden/i,
  );
  assert.throws(
    () => writeTree(store, [{ name: "sub/escape.txt", type: "blob", hash: blobHash }]),
    /path traversal forbidden/i,
  );
  assert.throws(
    () => writeTree(store, [{ name: "null\0byte.txt", type: "blob", hash: blobHash }]),
    /path traversal forbidden/i,
  );

  // 4. assertSafePath throws on any escaping paths
  assert.throws(() => assertSafePath(destDir, "../outside.txt"), /path traversal forbidden/i);
  assert.throws(() => assertSafePath(destDir, "foo/../../outside.txt"), /path traversal forbidden/i);
  assert.throws(() => assertSafePath(destDir, "file\0name"), /path traversal forbidden/i);
});

// ═════════════════════════════════════════════════════════════════════════════
// C3: Tide Core Primitives, Branch/Mark Tracking & Full Portability
// ═════════════════════════════════════════════════════════════════════════════

test("[C3] branch tracking allows creating, listing, checking out and branching marks", () => {
  const store = tmp("branch-store");
  const workdir = tmp("branch-work");
  const repo = new Repo(store);
  repo.init("project", workdir);

  write(workdir, "main.txt", "version 1");
  const m1 = repo.mark("project", { message: "Initial commit on main" });
  assert.equal(repo.currentBranch("project"), "main");

  // Create a new feature branch pointing to current head
  const fb = repo.branch("project", "feature-x");
  assert.equal(fb.name, "feature-x");
  assert.equal(fb.head, m1);

  // List branches shows both main (current) and feature-x
  const list1 = repo.listBranches("project");
  assert.equal(list1.length, 2);
  const mainB = list1.find((b) => b.name === "main");
  const featB = list1.find((b) => b.name === "feature-x");
  assert.equal(mainB.current, true);
  assert.equal(featB.current, false);

  // Checkout feature branch
  repo.checkout("project", "feature-x");
  assert.equal(repo.currentBranch("project"), "feature-x");

  // Make changes on feature branch
  write(workdir, "feature.txt", "feature-x work");
  const m2 = repo.mark("project", { message: "Work on feature" });
  assert.notEqual(m2, m1);
  assert.equal(repo.head("project"), m2);

  // Switch back to main: working tree restores to main state
  repo.checkout("project", "main");
  assert.equal(repo.currentBranch("project"), "main");
  assert.equal(repo.head("project"), m1);
  assert.equal(fs.existsSync(path.join(workdir, "feature.txt")), false);
  assert.equal(fs.readFileSync(path.join(workdir, "main.txt"), "utf8"), "version 1");

  // Switch back to feature branch: working tree brings back feature file
  repo.checkout("project", "feature-x");
  assert.equal(repo.head("project"), m2);
  assert.equal(fs.existsSync(path.join(workdir, "feature.txt")), true);
});

test("[C3] full machine workspace export and restore preserves files, DAG, branches, and states without data loss", () => {
  const origStore = tmp("full-orig-store");
  const origWork = tmp("full-orig-work");
  const repoOrig = new Repo(origStore);
  repoOrig.init("mysandbox", origWork);

  // 1. Commit history on main
  write(origWork, "index.js", "console.log('SandboxOS');");
  write(origWork, "package.json", '{"name": "my-app"}');
  const h1 = repoOrig.mark("mysandbox", { message: "c1" });

  write(origWork, "index.js", "console.log('SandboxOS 2.0');");
  const h2 = repoOrig.mark("mysandbox", { message: "c2" });

  // 2. Branch and feature commit
  repoOrig.branch("mysandbox", "staging");
  repoOrig.checkout("mysandbox", "staging");
  write(origWork, "staging.env", "STAGING=1");
  const hStaging = repoOrig.mark("mysandbox", { message: "staging mark" });

  // Switch back to main
  repoOrig.checkout("mysandbox", "main");

  // 3. Typed machine state objects (env, manifest, servers, agents)
  repoOrig.putState("mysandbox", "env", { PORT: 8080, HOST: "0.0.0.0" });
  repoOrig.putState("mysandbox", "manifest", { servers: { fs: {}, proc: {}, tide: {} } });
  repoOrig.putState("mysandbox", "servers", { active: ["http", "ws"] });

  // 4. Export complete workspace snapshot
  const snapshot = repoOrig.exportWorkspace("mysandbox");
  assert.equal(snapshot.kind, "workspace-snapshot");
  assert.equal(snapshot.workspace, "mysandbox");
  assert.equal(snapshot.head, h2);
  assert.equal(snapshot.currentBranch, "main");
  assert.ok(snapshot.branches["staging"]);
  assert.equal(snapshot.branches["staging"], hStaging);
  assert.ok(snapshot.integrity, "integrity checksum is present");
  assert.ok(snapshot.objects.length >= 4, "all reachable objects packaged");
  assert.ok(snapshot.states.env, "env state packaged");
  assert.ok(snapshot.states.manifest, "manifest state packaged");
  assert.ok(snapshot.states.servers, "servers state packaged");

  // 5. Restore into a completely fresh, isolated store and directory
  const destStore = tmp("full-dest-store");
  const destWork = tmp("full-dest-work");
  const repoDest = new Repo(destStore);

  const restoredInfo = repoDest.restoreWorkspace("mysandbox", snapshot, { workdir: destWork });
  assert.equal(restoredInfo.restored, true);
  assert.equal(restoredInfo.head, h2);
  assert.equal(restoredInfo.currentBranch, "main");

  // 6. Verify restored files (zero data loss)
  assert.equal(fs.readFileSync(path.join(destWork, "index.js"), "utf8"), "console.log('SandboxOS 2.0');");
  assert.equal(fs.readFileSync(path.join(destWork, "package.json"), "utf8"), '{"name": "my-app"}');

  // Working tree matches HEAD exactly (clean status)
  assert.equal(repoDest.status("mysandbox").length, 0);

  // 7. Verify restored history & log
  const logDest = repoDest.log("mysandbox");
  assert.equal(logDest.length, 2);
  assert.equal(logDest[0].hash, h2);
  assert.equal(logDest[1].hash, h1);

  // 8. Verify branches survived and can be checked out
  const branchList = repoDest.listBranches("mysandbox");
  assert.ok(branchList.some((b) => b.name === "staging" && b.head === hStaging));
  repoDest.checkout("mysandbox", "staging");
  assert.equal(repoDest.head("mysandbox"), hStaging);
  assert.equal(fs.readFileSync(path.join(destWork, "staging.env"), "utf8"), "STAGING=1");

  // 9. Verify all typed state objects survived identically
  assert.deepEqual(repoDest.getState("mysandbox", "env"), { PORT: 8080, HOST: "0.0.0.0" });
  assert.deepEqual(repoDest.getState("mysandbox", "manifest"), { servers: { fs: {}, proc: {}, tide: {} } });
  assert.deepEqual(repoDest.getState("mysandbox", "servers"), { active: ["http", "ws"] });
});

test("[C3] branch validates target refs against object store", () => {
  const store = tmp("branch-ref-store");
  const workdir = tmp("branch-ref-work");
  const repo = new Repo(store);
  repo.init("ref-ws", workdir);

  write(workdir, "a.txt", "initial");
  const c1 = repo.mark("ref-ws", { message: "c1" });

  // 1. Valid branch pointing to existing commit succeeds
  const bValid = repo.branch("ref-ws", "valid-b", c1);
  assert.equal(bValid.head, c1);

  // 2. Non-existent commit ref throws clear error
  assert.throws(
    () => repo.branch("ref-ws", "bad-ref", "0000000000000000000000000000000000000000"),
    /cannot branch from "0000000000000000000000000000000000000000": commit does not exist/,
  );

  // 3. Object ref pointing to a blob (not a commit) throws clear error
  const blobHash = writeBlob(store, Buffer.from("just a blob"));
  assert.throws(
    () => repo.branch("ref-ws", "blob-ref", blobHash),
    /cannot branch from ".*": object is a blob, not a commit/,
  );
});

test("[C3] workspace restore enforces overwrite protection and integrity verification", () => {
  const store = tmp("protect-store");
  const workdir = tmp("protect-work");
  const repo = new Repo(store);
  repo.init("protect-ws", workdir);

  write(workdir, "file.txt", "v1 content");
  repo.mark("protect-ws", { message: "mark 1" });
  repo.putState("protect-ws", "env", { ENV: "prod" });

  const snapshot = repo.exportWorkspace("protect-ws");

  // 1. Rejects tampered snapshot payload (integrity mismatch) or missing integrity
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.states.env = { ENV: "hacked" };
  const destStoreTampered = tmp("dest-store-tampered");
  const repoTampered = new Repo(destStoreTampered);
  assert.throws(
    () => repoTampered.restoreWorkspace("protect-ws", tampered),
    /snapshot corrupted: integrity check failed/i,
  );
  assert.equal(repoTampered.has("protect-ws"), false);

  const missingIntegrity = JSON.parse(JSON.stringify(snapshot));
  delete missingIntegrity.integrity;
  assert.throws(
    () => repoTampered.restoreWorkspace("no-integrity-ws", missingIntegrity),
    /snapshot corrupted: missing integrity/i,
  );
  assert.equal(repoTampered.has("no-integrity-ws"), false);

  // 2. Refuses to restore over an existing workspace without overwrite: true
  assert.throws(
    () => repo.restoreWorkspace("protect-ws", snapshot),
    /cannot restore workspace "protect-ws": workspace already exists \(use overwrite: true\)/,
  );

  // 3. Refuses to restore into a non-empty directory without overwrite: true
  const destStore2 = tmp("dest-store-2");
  const destWork2 = tmp("dest-work-2");
  const repo2 = new Repo(destStore2);
  write(destWork2, "uncommitted.txt", "should not be deleted silently");
  assert.throws(
    () => repo2.restoreWorkspace("fresh-ws", snapshot, { workdir: destWork2, overwrite: false }),
    /cannot restore into non-empty directory ".*" \(use overwrite: true\)/,
  );
  assert.equal(fs.existsSync(path.join(destWork2, "uncommitted.txt")), true);

  // 4. Overwrite: true successfully replaces existing workspace
  const resOverwriteWs = repo.restoreWorkspace("protect-ws", snapshot, { overwrite: true });
  assert.equal(resOverwriteWs.restored, true);

  // 5. Overwrite: true successfully restores into non-empty directory
  const resOverwriteDir = repo2.restoreWorkspace("fresh-ws", snapshot, { workdir: destWork2, overwrite: true });
  assert.equal(resOverwriteDir.restored, true);
  assert.equal(fs.existsSync(path.join(destWork2, "file.txt")), true);
});

test("[C3] workspace restore validates commit refs and leaves no workspace registered on failure", () => {
  const store = tmp("validate-refs-store");
  const workdir = tmp("validate-refs-work");
  const repo = new Repo(store);
  repo.init("valid-ws", workdir);

  write(workdir, "app.js", "console.log('test');");
  const commitHash = repo.mark("valid-ws", { message: "initial commit" });
  repo.branch("valid-ws", "staging", commitHash);

  const snapshot = repo.exportWorkspace("valid-ws");

  const sign = (s) => {
    const copy = { ...s };
    delete copy.integrity;
    s.integrity = crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
    return s;
  };

  const destStore = tmp("dest-validate-store");
  const repoDest = new Repo(destStore);

  // 1. Snapshot with head pointing to non-existent commit hash
  const badHead = sign({
    ...JSON.parse(JSON.stringify(snapshot)),
    head: "0000000000000000000000000000000000000000",
  });
  assert.throws(
    () => repoDest.restoreWorkspace("bad-head-ws", badHead),
    /snapshot invalid: ref "0000000000000000000000000000000000000000" is not a commit in the snapshot/,
  );
  assert.equal(repoDest.has("bad-head-ws"), false, "workspace was not registered after head failure");

  // 2. Snapshot with a branch pointing to non-existent commit hash
  const badBranch = sign({
    ...JSON.parse(JSON.stringify(snapshot)),
    branches: { staging: "1111111111111111111111111111111111111111" },
  });
  assert.throws(
    () => repoDest.restoreWorkspace("bad-branch-ws", badBranch),
    /snapshot invalid: ref "1111111111111111111111111111111111111111" is not a commit in the snapshot/,
  );
  assert.equal(repoDest.has("bad-branch-ws"), false, "workspace was not registered after branch failure");

  // 3. Snapshot with head pointing to a blob instead of a commit
  const blobObj = snapshot.objects.find((o) => o.type === "blob");
  assert.ok(blobObj, "snapshot contains a blob object");
  const badType = sign({
    ...JSON.parse(JSON.stringify(snapshot)),
    head: blobObj.hash,
  });
  assert.throws(
    () => repoDest.restoreWorkspace("bad-type-ws", badType),
    new RegExp(`snapshot invalid: ref "${blobObj.hash}" is not a commit in the snapshot`),
  );
  assert.equal(repoDest.has("bad-type-ws"), false, "workspace was not registered after type failure");
});

// ═════════════════════════════════════════════════════════════════════════════
// Live Mirror Daemon Stability
// ═════════════════════════════════════════════════════════════════════════════

test("live mirror daemon starts, executes sync, responds to lifecycle stop cleanly", async () => {
  const store = tmp("daemon-store");
  const workdir = tmp("daemon-work");
  fs.mkdirSync(workdir, { recursive: true });
  write(workdir, "initial.txt", "v1");

  const repo = new Repo(store);
  repo.init("daemon-ws", workdir);

  let pushed = 0, pulled = 0;
  const mockClient = {
    slug: "daemon-slug",
    async push() { pushed += 1; return { applied: true, head: "fakehead" }; },
    async pull() { pulled += 1; return { head: "fakehead", changed: false }; },
  };

  const logs = [];
  const daemon = await runDaemon({
    client: mockClient,
    repo,
    workspace: "daemon-ws",
    dir: workdir,
    intervalMs: 100,
    log: (msg) => logs.push(msg),
  });

  assert.equal(daemon.isRunning(), true);
  assert.ok(pushed >= 1, "initial push executed on daemon startup");
  assert.ok(pulled >= 1, "initial pull executed on daemon startup");

  // Test manual sync execution through daemon handle
  await daemon.sync();
  assert.ok(pushed >= 2);

  // Graceful stop
  daemon.stop();
  assert.equal(daemon.isRunning(), false);

  // Calling sync after stop is a no-op
  const pushCountBefore = pushed;
  await daemon.sync();
  assert.equal(pushed, pushCountBefore);
});
