// The `proc` core MCP server — processes as tools.
//
// In Phase 0 this is request/response: run a command in the Cell, return its
// stdout/stderr/exit code. Crucially, this runs *inside the Cell* (the container
// for the docker backend), and it goes through the Kernel — so even "run a shell
// command" is an authorized, audited MCP call, not a raw PTY bypass. Interactive
// PTY streaming (xterm.js) is a Phase 1 upgrade.

export function procServer(cell) {
  return {
    name: "proc",
    tools: {
      exec: {
        description: "Run a shell command inside the Sandbox and return its output.",
        inputSchema: {
          type: "object", required: ["cmd"],
          properties: { cmd: { type: "string" }, timeoutMs: { type: "number" } },
        },
        async handler(_ctx, args) {
          const r = await cell.exec(args.cmd, { timeoutMs: args.timeoutMs ?? 30_000 });
          return { cmd: args.cmd, stdout: r.stdout, stderr: r.stderr, code: r.code };
        },
      },
      list: {
        description: "List processes running inside the Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          // `ps` flavors differ (busybox vs coreutils); fall back gracefully.
          const r = await cell.exec("ps -ef 2>/dev/null || ps aux 2>/dev/null || ps");
          return { processes: r.stdout };
        },
      },
    },
  };
}
