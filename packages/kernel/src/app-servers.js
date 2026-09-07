// app-servers.js — the second face of a custom app: its tools.
//
// docs/08 promised that an app is a GUI for humans *and* an MCP server for
// agents. The GUI half is a bundle in a sandboxed frame (packages/os). This is
// the other half, and it comes in two honest shapes (ADR-0004):
//
//   · a FAÇADE: `mcp.tools[].proxy` names an existing Kernel tool. The app's
//     tool is an attenuated alias — it runs the underlying tool with the
//     caller's grants ∩ the app's declared permissions, and audits both hops.
//     Good for dashboards; no code runs anywhere new.
//   · a COMPANION: `mcp.entrypoint` names a module in the bundle. It runs in
//     the same out-of-process host marketplace servers use, with an empty deps
//     object — no Cell, no Kernel handle — and the Kernel registers a proxy.
//
// Either way the server is registered under the app's `mcp.name`, appears in
// `kernel.tools`, and is governed by the same authorize → route → audit path as
// everything else. The document is the source of truth: this module reads it
// and reconciles the Kernel's server set to it, on boot and on every change.

import { pathToFileURL } from "node:url";
import { loadOs, hasOs, bundleDir, effectivePermissions, RESERVED_SERVER_NAMES } from "../../os/src/index.js";
import path from "node:path";

/** A stable string for "which app servers should exist" — cheap to compare. */
export function appServerSignature(doc) {
  return Object.values(doc?.apps ?? {})
    .filter((a) => a.mcp)
    .map((a) => `${a.id}:${a.mcp.name}:${a.mcp.enabled ? 1 : 0}:${a.mcp.entrypoint ?? ""}:${a.updatedAt}:${JSON.stringify(a.mcp.tools)}`)
    .sort()
    .join("|");
}

/** Build the in-process façade server for an app. */
function facadeServer(app) {
  const tools = {};
  for (const t of app.mcp.tools) {
    if (!t.proxy) continue;
    const { server, tool, args: fixed } = t.proxy;
    tools[t.name] = {
      description: t.description || `${app.name}: ${server}.${tool}`,
      inputSchema: t.inputSchema,
      // Attenuation at the door: the inner call holds what the CALLER holds,
      // narrowed to what the APP declared. An app cannot lend a capability its
      // opener lacks, and cannot use one it never asked for.
      async handler(ctx, args) {
        const held = effectivePermissions(app.permissions ?? [], ctx.heldPatterns ?? []);
        const r = await ctx.kernel.call({
          principalId: ctx.principalId, heldPatterns: held, onBehalfOf: `app:${app.id}`,
          server, tool, args: { ...(fixed ?? {}), ...(args ?? {}) },
        });
        if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
        return r.result;
      },
    };
  }
  return { name: app.mcp.name, tools, _app: app.id, _facade: true };
}

/**
 * Reconcile the Kernel's app servers with the OS document. Idempotent; safe to
 * call often. A companion that fails to load is skipped and reported, never
 * fatal — one broken app must not take the machine's tool catalog down.
 */
export async function syncAppServers(kernel) {
  const sandbox = kernel.sandbox;
  if (!hasOs(sandbox)) return { registered: [], skipped: [] };
  const doc = loadOs(sandbox);
  const want = new Map();
  const skipped = [];
  for (const app of Object.values(doc.apps ?? {})) {
    const m = app.mcp;
    if (!m || !m.enabled) continue;
    if (RESERVED_SERVER_NAMES.has(m.name)) { skipped.push({ app: app.id, reason: "reserved name" }); continue; }
    if (kernel.isCoreServer?.(m.name)) { skipped.push({ app: app.id, reason: "collides with an installed server" }); continue; }
    want.set(m.name, app);
  }

  // Drop what is no longer wanted (or whose definition changed).
  for (const [name, entry] of kernel._appServers) {
    const app = want.get(name);
    if (!app || entry.signature !== signatureOf(app)) kernel.unregisterAppServer(name);
  }

  // Add what is new.
  for (const [name, app] of want) {
    if (kernel._appServers.has(name)) continue;
    const signature = signatureOf(app);
    if (app.mcp.entrypoint && app.origin === "store") {
      const file = path.join(bundleDir(sandbox, "app", app.id), app.mcp.entrypoint);
      try {
        await kernel.loadMarketplaceServer(name, pathToFileURL(file).href);
        kernel._appServers.set(name, { kind: "hosted", app: app.id, signature });
      } catch (e) {
        skipped.push({ app: app.id, reason: `companion failed to load: ${e.message}` });
      }
    } else if (app.mcp.entrypoint) {
      skipped.push({ app: app.id, reason: "a companion server must live in the OS store, not the Cell volume" });
    } else {
      kernel._appServers.set(name, { kind: "facade", app: app.id, signature, server: facadeServer(app) });
    }
  }
  kernel.rebuild();
  return { registered: [...kernel._appServers.keys()], skipped };
}

const signatureOf = (app) => `${app.mcp.entrypoint ?? ""}:${app.updatedAt}:${JSON.stringify(app.mcp.tools)}:${JSON.stringify(app.permissions)}`;
