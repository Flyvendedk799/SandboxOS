// The `kernel` core MCP server — Sandbox self-administration (docs/03).
//
// The reflexive surface: who am I, what may I do, what has happened, and the
// machine's own definition. This is what lets an agent reason about and reshape its
// own machine within its capabilities. Tool names are dotless (whoami, capabilities,
// auditQuery, manifestGet, manifestSet) to fit the "<server>.<tool>" address grammar.

import { getPrincipal, grantsFor, queryAudit, verifyAuditChain } from "../../../control-db/src/registry.js";
import { loadManifest, saveManifest } from "../../../manifest/src/manifest.js";

export function kernelServer(deps) {
  const { sandbox, kernel } = deps;
  return {
    name: "kernel",
    tools: {
      whoami: {
        description: "Identify the calling principal.",
        inputSchema: { type: "object", properties: {} },
        async handler(ctx) {
          const p = getPrincipal(ctx.principalId);
          return { id: p?.id, kind: p?.kind, name: p?.name, tenant: p?.tenant_id, sandbox: sandbox.slug };
        },
      },
      capabilities: {
        description: "What the caller may invoke in this Sandbox right now.",
        inputSchema: { type: "object", properties: {} },
        async handler(ctx) {
          return { capabilities: grantsFor(ctx.principalId, sandbox.id) };
        },
      },
      tools: {
        description: "The unified tool catalog of this Sandbox — every tool of every enabled server.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return { tools: kernel.listTools(), servers: [...kernel.servers.keys()] };
        },
      },
      auditQuery: {
        description: "Audit events for this Sandbox, filtered. Every call the machine has served — by whom, with what capability, and what it answered.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number" },
            resultKind: { type: "string", description: "ok | error | denied" },
            server: { type: "string" },
            tool: { type: "string" },
            principalId: { type: "string" },
            after: { type: "number", description: "Only events newer than this epoch-ms." },
            cursor: { type: "number", description: "Forward pagination from an event id." },
          },
        },
        async handler(_ctx, a) {
          // The store can filter in SQL; doing it here would page in a whole log
          // to throw most of it away, and would silently cap what a filter finds.
          const events = queryAudit(sandbox.id, {
            server: a.server || undefined,
            tool: a.tool || undefined,
            principalId: a.principalId || undefined,
            resultKind: a.resultKind || undefined,
            after: a.after != null ? Number(a.after) : undefined,
            cursor: a.cursor != null ? Number(a.cursor) : undefined,
            limit: a.limit ?? 50,
          });
          return { events, nextCursor: events.length ? events.at(-1).id : null };
        },
      },

      auditVerify: {
        description: "Verify the audit log's hash chain. Tamper-evidence is only assurance if it is actually checked.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return verifyAuditChain();
        },
      },
      manifestGet: {
        description: "Get this Sandbox's manifest (its declarative definition).",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { manifest: loadManifest(sandbox) }; },
      },
      manifestSet: {
        description: "Replace this Sandbox's manifest and rebuild the Kernel.",
        inputSchema: { type: "object", required: ["manifest"], properties: { manifest: { type: "object" } } },
        async handler(_ctx, a) {
          if (!a.manifest || typeof a.manifest !== "object" || !a.manifest.servers) {
            throw new Error("invalid manifest: missing servers");
          }
          if (!a.manifest.servers.kernel || !a.manifest.servers["mcp-registry"]) {
            throw new Error("manifest must keep kernel + mcp-registry enabled");
          }
          saveManifest(sandbox, a.manifest);
          kernel.rebuild();
          return { ok: true, enabled: Object.keys(a.manifest.servers) };
        },
      },
    },
  };
}
