// The `access` core MCP server — who can reach this machine, as tools.
//
// Sharing, revoking and minting device tokens were HTTP routes on the Gateway,
// which meant Command Central could do something the desktop and an agent could
// not (goal.md invariant 1: no privileged path). They are tools now. The routes
// stay for the CLI; both go through the same registry functions, and every call
// is audited like any other.
//
// Two rules make this safe to hand to an agent:
//
//   • Attenuation. You can only share what you hold, and a token can only carry
//     the intersection of what you asked for and what you have. `shareSandbox`
//     and `mintMachineToken` enforce that; this server does not reimplement it.
//   • Never your own access. Revoking yourself is how a machine becomes
//     unreachable, so it is refused here rather than explained afterwards.

import {
  listSandboxAccess, shareSandbox, revokeSandboxAccess,
  listMachineTokens, mintMachineToken,
} from "../../../control-db/src/registry.js";

const S = { type: "string" };

export function accessServer(sandbox) {
  return {
    name: "access",
    tools: {
      list: {
        description: "Every principal that can reach this Sandbox, and the capability patterns they hold.",
        inputSchema: { type: "object", properties: {} },
        async handler(ctx) {
          return { access: listSandboxAccess(sandbox.id), you: ctx?.principalId ?? null };
        },
      },

      share: {
        description: "Give another account access to this Sandbox, attenuated against what you hold. Omit patterns to share everything you have.",
        inputSchema: {
          type: "object", required: ["username"],
          properties: { username: S, patterns: { type: "array", items: S } },
        },
        async handler(ctx, a) {
          if (!ctx?.principalId) throw new Error("sharing needs a principal");
          return shareSandbox(ctx.principalId, sandbox.id, String(a.username).trim(), a.patterns);
        },
      },

      revoke: {
        description: "Revoke a principal's access to this Sandbox, taking any machine token minted for it.",
        inputSchema: { type: "object", required: ["principalId"], properties: { principalId: S } },
        async handler(ctx, a) {
          const target = String(a.principalId);
          if (target === ctx?.principalId) {
            const err = new Error("you cannot revoke your own access — a machine nobody can reach is not a machine");
            err.code = "refused";
            throw err;
          }
          const result = revokeSandboxAccess(sandbox.id, target);
          if (!result.removed && !result.tokensRevoked) throw new Error("no grants to revoke");
          return result;
        },
      },

      tokens: {
        description: "The machine tokens minted against this Sandbox — labels and patterns, never the token itself.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return { tokens: listMachineTokens(sandbox.id) };
        },
      },

      mint: {
        description: "Mint a machine token for a device or a CI job, attenuated against what you hold. The token is returned exactly once.",
        inputSchema: {
          type: "object",
          properties: { label: S, patterns: { type: "array", items: S } },
        },
        async handler(ctx, a) {
          if (!ctx?.principalId) throw new Error("minting needs a principal");
          const minted = mintMachineToken(ctx.principalId, sandbox.id, a.patterns, { label: a.label ?? "device" });
          // The value is shown once, on purpose: after this it exists only as a
          // hash, and "show me my token again" has no honest answer.
          return { token: minted.token, patterns: minted.patterns, label: a.label ?? "device", shownOnce: true };
        },
      },
    },
  };
}
