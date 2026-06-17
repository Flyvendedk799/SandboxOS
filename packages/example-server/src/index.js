// Example marketplace server — used in Phase-7 tests.
// Demonstrates the minimal SDK usage: one tool that greets someone.
import { createMcpServer } from "../../sdk/src/index.js";

export default createMcpServer({
  name: "hello",
  tools: {
    greet: {
      description: "Return a greeting message.",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      async handler(_ctx, { name = "world" } = {}) {
        return { message: `Hello, ${name}!` };
      },
    },
  },
});
