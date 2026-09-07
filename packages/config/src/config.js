// Central configuration for the SandboxOS spine.
//
// Everything that varies by environment funnels through here so the rest of the
// code never reads process.env directly. Tests point SANDBOXOS_HOME at a temp dir
// and force the `local` Cell backend so they never touch real runtime state
// (the survhub lesson: tests must not pollute the real home/DB).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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


/**
 * What code this process is running: the git commit of the checkout (read from
 * .git without spawning git), or SANDBOXOS_BUILD when a deploy sets it, plus the
 * moment the process started. Reported by /health and shown in Settings, so a
 * deploy that did not restart the Gateway is visible instead of mysterious.
 */
let _build = null;
export function buildInfo() {
  if (_build) return _build;
  let commit = process.env.SANDBOXOS_BUILD ?? null;
  if (!commit) {
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
      const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5);
        try { commit = fs.readFileSync(path.join(root, ".git", ref), "utf8").trim(); }
        catch {
          const packed = fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf8");
          commit = packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
        }
      } else commit = head;
    } catch { commit = null; }
  }
  _build = { commit: commit ? commit.slice(0, 12) : null, startedAt: Date.now() };
  return _build;
}
