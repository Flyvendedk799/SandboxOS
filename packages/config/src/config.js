// Central configuration for the SandboxOS spine.
//
// Everything that varies by environment funnels through here so the rest of the
// code never reads process.env directly. Tests point SANDBOXOS_HOME at a temp dir
// and force the `local` Cell backend so they never touch real runtime state
// (the survhub lesson: tests must not pollute the real home/DB).

import os from "node:os";
import path from "node:path";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// The root of all runtime state: control DB + per-Sandbox Cell volumes.
const HOME = path.resolve(env("SANDBOXOS_HOME", path.join(os.homedir(), ".sandboxos")));

export const config = {
  /** Root dir for runtime state. */
  home: HOME,
  /** Control-plane SQLite DB file. */
  dbPath: path.join(HOME, "control.sqlite"),
  /** Where per-Sandbox Cell volumes live: <home>/sandboxes/<id>/volume */
  sandboxesDir: path.join(HOME, "sandboxes"),

  /** HTTP port for the Gateway. */
  port: Number(env("SANDBOXOS_PORT", "3939")),
  host: env("SANDBOXOS_HOST", "127.0.0.1"),

  /** Phase-0 single-operator login password (humans). */
  password: env("SANDBOXOS_PASSWORD", "dev"),

  /** Cell backend: "docker" | "local" | "auto". */
  cellBackend: env("SANDBOXOS_CELL_BACKEND", "auto"),
  /** Container image for the docker backend. */
  cellImage: env("SANDBOXOS_CELL_IMAGE", "alpine:latest"),

  /** The seed tenant + Sandbox created on first boot. */
  seed: {
    tenantName: env("SANDBOXOS_SEED_TENANT", "tobias"),
    slug: env("SANDBOXOS_SEED_SLUG", "tobias"),
    sandboxName: env("SANDBOXOS_SEED_SANDBOX", "primary"),
  },
};

export default config;
