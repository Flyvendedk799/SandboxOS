// The catalog of available core MCP servers, keyed by name.
//
// A Sandbox's manifest names which of these to enable; the Kernel instantiates only
// those. Each entry is a factory (deps) => serverDef. This is the seam through which
// "everything is a swappable MCP server" (docs/08) is realized — and where Phase 3's
// marketplace-installed servers will join the built-ins.

import { fsServer } from "./servers/fs.js";
import { procServer } from "./servers/proc.js";
import { cronServer } from "./servers/cron.js";
import { netServer } from "./servers/net.js";
import { secretsServer } from "./servers/secrets.js";
import { pkgServer } from "./servers/pkg.js";
import { registryServer } from "./servers/registry.js";
import { kernelServer } from "./servers/kernel.js";
import { tideServer } from "./servers/tide.js";
import { agentsServer } from "../../agents/src/server.js";
import { llmServer } from "../../llm/src/server.js";
import { appsServer } from "./servers/apps.js";

export const CATALOG = {
  fs: (d) => fsServer(d.cell),
  proc: (d) => procServer(d.cell),
  cron: (d) => cronServer(d),
  net: (d) => netServer(d),
  secrets: (d) => secretsServer(d),
  pkg: (d) => pkgServer(d),
  tide: (d) => tideServer(d),
  agents: (d) => agentsServer(d),
  llm: (d) => llmServer(d),
  apps: (d) => appsServer(d),
  "mcp-registry": (d) => registryServer(d),
  kernel: (d) => kernelServer(d),
};

export const availableServers = () => Object.keys(CATALOG);
