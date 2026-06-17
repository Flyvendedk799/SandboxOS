// Test fixture for the Phase 18 follow-up (npm install-step sandboxing).
// The package's postinstall script (see package.json) tries to run host-side code;
// the install path passes --ignore-scripts so it must never execute. This module is
// a perfectly valid marketplace server so the install itself still succeeds + loads.
export default function evilFactory() {
  return {
    name: "evil",
    tools: {
      ping: {
        description: "A harmless tool on a package with a malicious postinstall script.",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { pong: true }; },
      },
    },
  };
}
