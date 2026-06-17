// Parent-side manager for out-of-process marketplace servers (backlog #12).
//
// Each installed marketplace server runs in its own forked child (marketplace-host.js).
// This module owns the child lifecycle and the request/response correlation, exposing
// a tiny RPC surface (describe + call) that the Kernel uses to build an in-process
// PROXY server. The proxy's tool handlers run inside the Kernel's normal authorize ->
// audit path; only the untrusted computation is shipped across the process boundary.
//
// Children are unref()'d so a forgotten one never blocks process exit, and they exit
// themselves on parent disconnect. They are killed explicitly on uninstall / kernel drop.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "marketplace-host.js");

const CALL_TIMEOUT_MS = 30_000;
const DESCRIBE_TIMEOUT_MS = 15_000;

class HostedServer {
  constructor(name, source) {
    this.name = name;
    this.source = source;
    this.child = null;
    this._seq = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
  }

  _ensure() {
    if (this.child && this.child.connected) return;
    const child = fork(HOST_SCRIPT, [this.source], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("message", (msg) => {
      const p = this._pending.get(msg?.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "marketplace error"));
    });
    child.on("exit", () => {
      for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error("marketplace server exited")); }
      this._pending.clear();
      this.child = null;
    });
    // Don't let an idle marketplace child keep the host process alive.
    child.unref();
    if (child.channel) child.channel.unref();
    this.child = child;
  }

  _send(op, tool, args, timeoutMs) {
    this._ensure();
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`marketplace ${op}${tool ? " " + tool : ""} timed out`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this.child.send({ id, op, tool, args }); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); reject(new Error(`marketplace send failed: ${e.message}`)); }
    });
  }

  describe() { return this._send("describe", null, null, DESCRIBE_TIMEOUT_MS); }
  call(tool, args) { return this._send("call", tool, args, CALL_TIMEOUT_MS); }

  kill() {
    if (this.child) { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } this.child = null; }
    for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error("marketplace server killed")); }
    this._pending.clear();
  }
}

const _pool = new Map(); // `${sandboxId}::${name}` -> HostedServer
const key = (sandboxId, name) => `${sandboxId}::${name}`;

/** Get (or create) the hosted child for a sandbox+server. Respawns if the source changed. */
export function hostedServer(sandboxId, name, source) {
  const k = key(sandboxId, name);
  let h = _pool.get(k);
  if (!h || h.source !== source) {
    if (h) h.kill();
    h = new HostedServer(name, source);
    _pool.set(k, h);
  }
  return h;
}

/** Kill + forget one hosted server (called on uninstall). */
export function killHosted(sandboxId, name) {
  const k = key(sandboxId, name);
  const h = _pool.get(k);
  if (h) { h.kill(); _pool.delete(k); }
}

/** Kill all hosted servers for a sandbox (call before dropping its Kernel), or all if no arg. */
export function killAllHosted(sandboxId) {
  for (const [k, h] of [..._pool]) {
    if (sandboxId == null || k.startsWith(`${sandboxId}::`)) { h.kill(); _pool.delete(k); }
  }
}
