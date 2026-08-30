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
      metrics: {},
      desktop: {},
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

/**
 * Servers introduced after a manifest may have been written. Each is enabled
 * exactly once, and the fact that we did it is recorded — so a machine that has
 * deliberately removed one does not get it back on every boot. Adding a new core
 * server to SandboxOS should not require every existing Sandbox to be rebuilt.
 */
const LATE_SERVERS = { desktop: {} };

function migrateManifest(sandbox, m) {
  let changed = false;
  m.migrated ??= {};
  for (const [name, cfg] of Object.entries(LATE_SERVERS)) {
    if (m.migrated[name]) continue;
    m.servers ??= {};
    m.servers[name] ??= cfg;
    m.migrated[name] = true;
    changed = true;
  }
  if (changed) saveManifest(sandbox, m);
  return m;
}

export function loadManifest(sandbox) {
  const file = manifestPath(sandbox);
  try {
    return migrateManifest(sandbox, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    const m = defaultManifest(sandbox.name);
    m.migrated = Object.fromEntries(Object.keys(LATE_SERVERS).map((k) => [k, true]));
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
