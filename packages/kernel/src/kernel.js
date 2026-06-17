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
import { authorize } from "./capabilities.js";
import { appendAudit } from "../../control-db/src/registry.js";
import { getCell } from "../../cell/src/cell.js";
import { CATALOG, availableServers } from "./catalog.js";
import { loadManifest, enabledServers } from "../../manifest/src/manifest.js";
import { hostedServer, killHosted, killAllHosted } from "./marketplace-pool.js";

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
    /** Marketplace servers loaded via mcp-registry.install, keyed by name →
     *  { source, descriptors }. Backlog #12: their code runs OUT OF PROCESS
     *  (marketplace-pool.js); we cache only the tool descriptors here so the
     *  synchronous rebuild() can register a proxy without re-spawning anything. */
    this._marketplaceServers = new Map();
    /** Live event bus: emits 'audit' for every call so the console can tail it. */
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  register(server) {
    this.servers.set(server.name, server);
    return this;
  }

  /** Spawn (or reuse) the out-of-process host for a marketplace server, fetch its
   *  tool descriptors, and cache them so rebuild() can register the proxy. Async
   *  because the describe handshake crosses the process boundary. */
  async loadMarketplaceServer(name, source) {
    const desc = await hostedServer(this.sandbox.id, name, source).describe();
    this._marketplaceServers.set(name, { source, descriptors: desc.tools ?? [] });
    return desc;
  }

  /** Forget a marketplace server and kill its child process. */
  unloadMarketplaceServer(name) {
    this._marketplaceServers.delete(name);
    killHosted(this.sandbox.id, name);
  }

  /** Build an in-process PROXY server for a marketplace entry. Each tool handler
   *  forwards (args only) to the isolated child; the Kernel's authorize+audit path
   *  around it is unchanged, so out-of-process servers are governed identically. */
  _marketplaceProxy(name, { source, descriptors }) {
    const sandboxId = this.sandbox.id;
    const tools = {};
    for (const d of descriptors) {
      tools[d.name] = {
        description: d.description, inputSchema: d.inputSchema,
        handler: (_ctx, args) => hostedServer(sandboxId, name, source).call(d.name, args),
      };
    }
    return { name, tools, _marketplace: true };
  }

  /** (Re)build the enabled server set from the Sandbox manifest. Called on boot and
   *  whenever mcp-registry / kernel.manifestSet changes the composition. Synchronous:
   *  core servers are in-process factories; marketplace servers use cached descriptors. */
  rebuild() {
    this.servers.clear();
    const manifest = loadManifest(this.sandbox);
    const deps = {
      cell: this.cell, sandbox: this.sandbox, kernel: this, manifest,
      availableServers: availableServers(),
    };
    for (const name of enabledServers(manifest)) {
      const factory = CATALOG[name];
      if (factory) { this.servers.set(name, factory(deps)); continue; }
      // Use the manifest key as the server name so marketplace servers installed
      // under an alias (e.g. "hello2") are routed correctly.
      const mk = this._marketplaceServers.get(name);
      if (mk) this.servers.set(name, this._marketplaceProxy(name, mk));
    }
    return this;
  }

  /** Tear down: kill every out-of-process marketplace child for this Sandbox. */
  dispose() {
    killAllHosted(this.sandbox.id);
    this._marketplaceServers.clear();
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
    // Pre-load marketplace servers persisted in manifest.installed — out of process
    // (backlog #12), so their code never imports into the control plane. A failed
    // load (bad source) is skipped so one broken install can't block boot.
    const manifest = loadManifest(sandbox);
    for (const [name, source] of Object.entries(manifest.installed ?? {})) {
      try { await kernel.loadMarketplaceServer(name, source); }
      catch { /* skip unresolvable sources on boot */ }
    }
    return kernel.rebuild();
  })();
  _kernels.set(sandbox.id, p);
  return p;
}

/** For tests: drop cached kernels and kill all out-of-process marketplace children. */
export function _resetKernels() {
  for (const p of _kernels.values()) Promise.resolve(p).then((k) => k.dispose()).catch(() => {});
  _kernels.clear();
  killAllHosted(); // belt-and-suspenders: reap any orphaned children
}

/** Drop the cached Kernel for a specific Sandbox (call before deleting it). */
export function _dropKernel(sandboxId) {
  const p = _kernels.get(sandboxId);
  if (p) Promise.resolve(p).then((k) => k.dispose()).catch(() => {});
  _kernels.delete(sandboxId);
}
