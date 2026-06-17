// The Kernel — the MCP router that lives at the heart of every Sandbox.
//
// It is the ONLY way to act on a Sandbox. Every call goes:
//   authenticate (caller already resolved) → authorize (capabilities, default-deny)
//   → route (to a server's tool) → execute → audit (one event, hash-chained).
//
// This is the Phase-0 realization of docs/03-mcp-kernel.md. The tool interface is
// MCP-shaped (name + JSON inputSchema + handler) so adopting the official MCP SDK
// transport later is mechanical. Phase-0 simplification: the Kernel is hosted
// host-side by the Gateway and drives the Cell through the Cell interface; Phase 1
// moves it inside the Cell.

import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { authorize } from "./capabilities.js";
import { appendAudit } from "../../control-db/src/registry.js";
import { getCell } from "../../cell/src/cell.js";
import { CATALOG, availableServers } from "./catalog.js";
import { loadManifest, enabledServers } from "../../manifest/src/manifest.js";

export class DeniedError extends Error {
  constructor(target) { super(`denied: ${target}`); this.name = "DeniedError"; this.code = "denied"; }
}
export class UnknownToolError extends Error {
  constructor(target) { super(`unknown tool: ${target}`); this.name = "UnknownToolError"; this.code = "unknown_tool"; }
}

export class Kernel {
  constructor(sandbox, cell) {
    this.sandbox = sandbox;
    this.cell = cell;
    this.servers = new Map();
    /** Marketplace server factories loaded at runtime via mcp-registry.install. */
    this._marketplaceFactories = new Map();
    /** Live event bus: emits 'audit' for every call so the console can tail it. */
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  register(server) {
    this.servers.set(server.name, server);
    return this;
  }

  /** (Re)build the enabled server set from the Sandbox manifest. Called on boot and
   *  whenever mcp-registry / kernel.manifestSet changes the composition. */
  rebuild() {
    this.servers.clear();
    const manifest = loadManifest(this.sandbox);
    const deps = {
      cell: this.cell, sandbox: this.sandbox, kernel: this, manifest,
      availableServers: availableServers(),
    };
    for (const name of enabledServers(manifest)) {
      const factory = CATALOG[name] ?? this._marketplaceFactories.get(name);
      // Use the manifest key as the server name so marketplace servers installed
      // under an alias (e.g. "hello2") are routed correctly.
      if (factory) this.servers.set(name, factory(deps));
    }
    return this;
  }

  /** The unified tool catalog — the union of every enabled server, namespaced. */
  listTools() {
    const out = [];
    for (const [sName, server] of this.servers) {
      for (const [tName, tool] of Object.entries(server.tools)) {
        out.push({ name: `${sName}.${tName}`, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
    return out;
  }

  /**
   * The one entry point. Authorizes against the caller's held capability
   * patterns, routes to the tool, executes, and writes exactly one audit event.
   * @returns {Promise<{ok:true,result:any}|{ok:false,error:string,code:string}>}
   */
  async call({ principalId, heldPatterns = [], server, tool, args = {}, onBehalfOf = null }) {
    const target = `${server}.${tool}`;
    const base = {
      sandboxId: this.sandbox.id, principalId, onBehalfOf, server, tool, args,
    };

    // 1. Authorize (default-deny).
    const capability = authorize(heldPatterns, server, tool);
    if (!capability) {
      const ev = appendAudit({ ...base, resultKind: "denied", error: "no capability", capability: null });
      this._emit({ ...base, resultKind: "denied", error: "no capability", ...ev });
      return { ok: false, code: "denied", error: `denied: ${target}` };
    }

    // 2. Route.
    const srv = this.servers.get(server);
    const t = srv?.tools?.[tool];
    if (!t) {
      const ev = appendAudit({ ...base, resultKind: "error", error: "unknown_tool", capability });
      this._emit({ ...base, resultKind: "error", error: "unknown_tool", capability, ...ev });
      return { ok: false, code: "unknown_tool", error: `unknown tool: ${target}` };
    }

    // 3. Execute + 4. Audit.
    try {
      const result = await t.handler({ kernel: this, cell: this.cell, sandbox: this.sandbox, principalId }, args);
      const ev = appendAudit({ ...base, resultKind: "ok", capability });
      this._emit({ ...base, resultKind: "ok", capability, ...ev });
      return { ok: true, result };
    } catch (err) {
      const message = err?.message ?? String(err);
      const ev = appendAudit({ ...base, resultKind: "error", error: message, capability });
      this._emit({ ...base, resultKind: "error", error: message, capability, ...ev });
      return { ok: false, code: "error", error: message };
    }
  }

  _emit(ev) {
    // Redaction for the live stream mirrors the audit store's policy.
    this.events.emit("audit", {
      ts: ev.ts, server: ev.server, tool: ev.tool,
      resultKind: ev.resultKind, error: ev.error ?? null, capability: ev.capability ?? null,
    });
  }
}

// ---- Per-Sandbox Kernel factory ------------------------------------------

const _kernels = new Map(); // sandboxId -> Promise<Kernel>

/** Build (and cache) the Kernel for a Sandbox, with manifest-enabled servers.
 *  Async because marketplace servers may need dynamic import() to load their factory. */
export async function getKernel(sandbox) {
  if (_kernels.has(sandbox.id)) return _kernels.get(sandbox.id);
  const p = (async () => {
    const cell = getCell(sandbox);
    const kernel = new Kernel(sandbox, cell);
    // Pre-load any marketplace factories persisted in manifest.installed.
    const manifest = loadManifest(sandbox);
    for (const [name, source] of Object.entries(manifest.installed ?? {})) {
      try {
        const url = source.startsWith("file://") ? source : pathToFileURL(source).href;
        const mod = await import(url);
        const factory = mod.default ?? mod.createServer;
        if (factory) kernel._marketplaceFactories.set(name, factory);
      } catch { /* skip unresolvable sources on boot */ }
    }
    return kernel.rebuild();
  })();
  _kernels.set(sandbox.id, p);
  return p;
}

/** For tests: drop cached kernels. */
export function _resetKernels() {
  _kernels.clear();
}

/** Drop the cached Kernel for a specific Sandbox (call before deleting it). */
export function _dropKernel(sandboxId) {
  _kernels.delete(sandboxId);
}
