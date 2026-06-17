// Minimal MCP server used as a local npm-install fixture in phase13.test.js.
export default function createServer() {
  return {
    name: "mcp-test-server",
    tools: {
      ping: {
        description: "Returns pong.",
        inputSchema: { type: "object", properties: {} },
        async handler() { return { pong: true }; },
      },
    },
  };
}
