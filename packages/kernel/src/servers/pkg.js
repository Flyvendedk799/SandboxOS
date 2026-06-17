// The `pkg` core MCP server — software install as tools.
//
// Phase 1 wraps the Cell image's package manager (Alpine `apk` by default). It is
// image-dependent by design; the interface (install/remove/list) is the stable
// contract, the backing command is swappable per distro. Names are validated to a
// safe charset before reaching the shell.

const SAFE = /^[a-zA-Z0-9._+-]+$/;

export function pkgServer(deps) {
  const { cell } = deps;
  const mgr = deps.manifest?.servers?.pkg?.manager ?? "apk"; // future: apt, etc.

  const cmd = {
    apk: { install: (n) => `apk add --no-cache ${n}`, remove: (n) => `apk del ${n}`, list: () => `apk info` },
  }[mgr];

  return {
    name: "pkg",
    tools: {
      install: {
        description: "Install a package into the Sandbox.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) {
          if (!SAFE.test(a.name)) throw new Error(`invalid package name: ${a.name}`);
          const r = await cell.exec(cmd.install(a.name), { timeoutMs: 120_000 });
          return { name: a.name, code: r.code, stdout: r.stdout, stderr: r.stderr };
        },
      },
      remove: {
        description: "Remove a package from the Sandbox.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) {
          if (!SAFE.test(a.name)) throw new Error(`invalid package name: ${a.name}`);
          const r = await cell.exec(cmd.remove(a.name), { timeoutMs: 60_000 });
          return { name: a.name, code: r.code, stdout: r.stdout, stderr: r.stderr };
        },
      },
      list: {
        description: "List installed packages.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const r = await cell.exec(cmd.list(), { timeoutMs: 30_000 });
          return { packages: r.stdout.split("\n").filter(Boolean) };
        },
      },
    },
  };
}
