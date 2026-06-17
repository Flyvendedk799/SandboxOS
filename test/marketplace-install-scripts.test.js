// Phase 18 follow-up: npm install-step sandboxing.
// Even with out-of-process server execution, `npm install` runs a package's lifecycle
// scripts (preinstall/install/postinstall) HOST-SIDE. mcp-registry.install now passes
// --ignore-scripts by default, so installing a marketplace package can't run host code
// at install time. SANDBOXOS_MCP_ALLOW_SCRIPTS=1 is the deliberate opt-out.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";

// A fixture package whose postinstall writes a marker file (if SBX_PWN_MARKER is set)
// — stands in for a malicious install script.
const EVIL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/evil-install");

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

// npm skips re-running scripts when a package is already up to date, so wipe the
// install dir before each case to force a fresh install (and thus a real script run).
const cleanPackages = () =>
  fs.rmSync(path.join(sandbox.volume_path, ".mcp-packages"), { recursive: true, force: true });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => { _resetKernels(); closeDb(); });

test("install passes --ignore-scripts by default: malicious postinstall does NOT run", async () => {
  cleanPackages();
  const marker = path.join(os.tmpdir(), `sbx-pwn-${crypto.randomUUID().slice(0, 8)}`);
  process.env.SBX_PWN_MARKER = marker;
  delete process.env.SANDBOXOS_MCP_ALLOW_SCRIPTS;
  try {
    const r = await call("mcp-registry", "install", { name: "evil-default", source: `npm:file:${EVIL_DIR}` });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!fs.existsSync(marker), "postinstall must NOT have executed host-side");
    // The package still installed and the server is reachable (out-of-process).
    const ping = await call("evil-default", "ping", {});
    assert.ok(ping.ok, JSON.stringify(ping));
    assert.equal(ping.result.pong, true);
  } finally {
    await call("mcp-registry", "uninstall", { name: "evil-default" }).catch(() => {});
    delete process.env.SBX_PWN_MARKER;
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

test("SANDBOXOS_MCP_ALLOW_SCRIPTS=1 opts back in (confirms the flag is load-bearing)", async () => {
  cleanPackages();
  const marker = path.join(os.tmpdir(), `sbx-pwn-${crypto.randomUUID().slice(0, 8)}`);
  process.env.SBX_PWN_MARKER = marker;
  process.env.SANDBOXOS_MCP_ALLOW_SCRIPTS = "1";
  try {
    const r = await call("mcp-registry", "install", { name: "evil-optin", source: `npm:file:${EVIL_DIR}` });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(fs.existsSync(marker), "with scripts allowed the postinstall SHOULD run — proves the default flag is what blocks it");
  } finally {
    await call("mcp-registry", "uninstall", { name: "evil-optin" }).catch(() => {});
    delete process.env.SANDBOXOS_MCP_ALLOW_SCRIPTS;
    delete process.env.SBX_PWN_MARKER;
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});
