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
import { stopAllProcs } from "./servers/proc.js";
import { syncAppServers, appServerSignature } from "./app-servers.js";
import { osEvents, hasOs, loadOs } from "../../os/src/index.js";

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
    /** Servers that custom apps in the OS document declare (app-servers.js):
     *  name → { kind: "facade"|"hosted", app, signature, server? }. */
    this._appServers = new Map();
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

  /** Is `name` a core or installed server — something an app may not shadow? */
  isCoreServer(name) {
    if (CATALOG[name]) return true;
    const m = loadManifest(this.sandbox);
    return !!(m.servers?.[name] || m.installed?.[name]);
  }

  /** Drop an app's server (façade or hosted companion). */
  unregisterAppServer(name) {
    const entry = this._appServers.get(name);
    if (!entry) return;
    this._appServers.delete(name);
    if (entry.kind === "hosted") this.unloadMarketplaceServer(name);
  }

  /** Reconcile app servers with the OS document. See app-servers.js. */
  syncAppServers() { return syncAppServers(this); }

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
    // Apps' servers come after the manifest so a core name always wins.
    for (const [name, entry] of this._appServers) {
      if (this.servers.has(name)) continue;
      if (entry.kind === "facade") this.servers.set(name, entry.server);
      else {
        const mk = this._marketplaceServers.get(name);
        if (mk) this.servers.set(name, { ...this._marketplaceProxy(name, mk), _app: entry.app });
      }
    }
    return this;
  }

  /** Tear down: kill every out-of-process marketplace child for this Sandbox. */
  dispose() {
    this._offOs?.();
    killAllHosted(this.sandbox.id);
    stopAllProcs(this.sandbox.id);
    this._marketplaceServers.clear();
    this._appServers.clear();
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
    // 0. Shape. A call with no server or no tool is not a denied call or an
    //    unknown tool — it is not a call at all, and it must not reach the audit
    //    insert, where it used to surface to the user as a SQLite binding error.
    const named = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(v);
    if (!named(server) || !named(tool)) {
      return { ok: false, code: "bad_request", error: `malformed call: ${!named(server) ? "server" : "tool"} must be a name` };
    }
    if (args !== null && (typeof args !== "object" || Array.isArray(args))) {
      return { ok: false, code: "bad_request", error: "malformed call: args must be an object" };
    }
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
    //
    // The clock starts here: how long a tool took is part of what happened, and
    // an operator asking "what is slow" should not have to infer it from
    // timestamps two rows apart.
    const startedAt = performance.now();
    try {
      const result = await t.handler({ kernel: this, cell: this.cell, sandbox: this.sandbox, principalId, heldPatterns, onBehalfOf }, args);
      const ms = performance.now() - startedAt;
      const ev = appendAudit({ ...base, resultKind: "ok", capability, ms });
      this._emit({ ...base, resultKind: "ok", capability, ms, ...ev });
      return { ok: true, result };
    } catch (err) {
      const message = err?.message ?? String(err);
      const ms = performance.now() - startedAt;
      const ev = appendAudit({ ...base, resultKind: "error", error: message, capability, ms });
      this._emit({ ...base, resultKind: "error", error: message, capability, ms, ...ev });
      // A tool that knows *what kind* of failure this was says so, and the code
      // travels to the caller: a conditional write that lost its race refreshes
      // and retries (`stale_rev`), a host that cannot run commands is not a
      // transient error (`unsupported_host`), and neither is "error".
      const code = typeof err?.code === "string" && /^[a-z][a-z0-9_]{2,31}$/.test(err.code) ? err.code : "error";
      return { ok: false, code, error: message };
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
    kernel.rebuild();
    // The OS document may declare app servers. Register them now, and keep the
    // set reconciled with every desktop write (define, remove, fork, revert…).
    // A machine with no desktop has no app servers — notifying and now serving
    // never create one.
    if (hasOs(sandbox)) {
      try { await kernel.syncAppServers(); } catch { /* one broken app is not a boot failure */ }
    }
    let lastSig = hasOs(sandbox) ? appServerSignature(loadOs(sandbox)) : "";
    const onChange = (ev) => {
      if (!ev?.doc) return;
      const sig = appServerSignature(ev.doc);
      if (sig === lastSig) return;
      lastSig = sig;
      kernel.syncAppServers().catch(() => {});
    };
    osEvents(sandbox.id).on("change", onChange);
    kernel._offOs = () => osEvents(sandbox.id).off("change", onChange);
    return kernel;
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
