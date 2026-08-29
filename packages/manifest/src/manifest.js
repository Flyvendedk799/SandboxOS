// The Sandbox manifest (the `Sandboxfile`).
//
// Declarative description of a Sandbox: which MCP servers are enabled and how
// configured. "Reproducible by description" (docs/08) starts here. In Phase 1 the
// manifest is a JSON file alongside the Cell volume; Phase 2 versions it as a Tide
// `State` object. Format is provisional (JSON now, TOML is the documented target).

import fs from "node:fs";
import path from "node:path";

/** The default machine: all Phase-1/2/3 core servers enabled; llm is opt-in (needs API key). */
export function defaultManifest(name = "primary") {
  return {
    name,
    servers: {
      fs: {},
      proc: {},
      cron: {},
      net: { egress: "allow", allow: [], deny: [] },
      secrets: {},
      pkg: {},
      tide: {},
      agents: {},
      apps: {},
      ports: {},
      "mcp-registry": {},
      kernel: {},
    },
    installed: {},
  };
}

/** The manifest lives at <home>/sandboxes/<id>/Sandboxfile.json (beside the volume). */
export function manifestPath(sandbox) {
  return path.join(path.dirname(sandbox.volume_path), "Sandboxfile.json");
}

export function loadManifest(sandbox) {
  const file = manifestPath(sandbox);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    const m = defaultManifest(sandbox.name);
    saveManifest(sandbox, m);
    return m;
  }
}

export function saveManifest(sandbox, manifest) {
  const file = manifestPath(sandbox);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function enabledServers(manifest) {
  return Object.keys(manifest.servers ?? {});
}
