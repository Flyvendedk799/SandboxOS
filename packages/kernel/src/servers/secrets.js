// The `secrets` core MCP server — reference-not-value secret handling (docs/09).
//
// Callers can put/list/remove secrets and *use* them (inject into a command's env),
// but can never read a value back. `useInEnv` resolves values internally, runs the
// command in the Cell with the secrets as env vars, and returns only the output.

import { putSecret, listSecrets, removeSecret, resolveSecretEnv } from "../../../secrets/src/store.js";

export function secretsServer(deps) {
  const { sandbox, cell } = deps;
  return {
    name: "secrets",
    tools: {
      put: {
        description: "Store a secret. Returns a reference; the value is never returned.",
        inputSchema: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } },
        async handler(_ctx, a) { return putSecret(sandbox.id, a.name, a.value); },
      },
      list: {
        description: "List secret names + references (never values).",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { secrets: listSecrets(sandbox.id) }; },
      },
      remove: {
        description: "Delete a secret by name.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) { return removeSecret(sandbox.id, a.name); },
      },
      useInEnv: {
        description: "Run a command in the Sandbox with secrets injected as env vars. Returns output only.",
        inputSchema: {
          type: "object", required: ["refs", "cmd"],
          properties: { refs: { type: "array", items: { type: "string" } }, cmd: { type: "string" }, timeoutMs: { type: "number" } },
        },
        async handler(_ctx, a) {
          const env = resolveSecretEnv(sandbox.id, a.refs); // values stay server-side
          const r = await cell.exec(a.cmd, { env, timeoutMs: a.timeoutMs ?? 30_000 });
          return { stdout: r.stdout, stderr: r.stderr, code: r.code };
        },
      },
    },
  };
}
