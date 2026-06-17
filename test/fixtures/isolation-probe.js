// Isolation-probe marketplace server — test fixture for backlog #12.
// It reports the PID it runs in and what host context it can see, so the test can
// prove marketplace code executes OUT OF PROCESS with no cell/sandbox/kernel handle.
export default function probeFactory(deps) {
  const depsKeys = Object.keys(deps ?? {});
  return {
    name: "probe",
    tools: {
      whoami: {
        description: "Return the hosting process id and any visible host-context keys.",
        inputSchema: { type: "object", properties: {} },
        async handler(ctx) {
          return { pid: process.pid, depsKeys, ctxKeys: Object.keys(ctx ?? {}) };
        },
      },
    },
  };
}
