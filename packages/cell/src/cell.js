// The Cell: the isolation boundary that executes one Sandbox.
//
// This is the abstraction from docs/04-execution-substrate.md. Ships four
// backends behind one interface, resolved in order:
//   firecracker  — L2 microVM via KVM (Linux only; strongest isolation)
//   hardened-docker — L1 container with capabilities dropped + network=none
//   docker       — plain L1 container (Phase-0 default)
//   local        — host child_process (no isolation; for tests & CI)
//
// All backends expose the same shape, so the Kernel's fs/proc servers don't
// know or care which one they're driving.

import { DockerBackend }          from "./docker-backend.js";
import { HardenedDockerBackend }  from "./hardened-docker-backend.js";
import { FirecrackerBackend }     from "./firecracker-backend.js";
import { LocalBackend }           from "./local-backend.js";
import config from "../../config/src/config.js";
import { execFile } from "node:child_process";
import fs from "node:fs";

// ── Backend resolution ────────────────────────────────────────────────────────

/** Decide which backend to use given config + host capabilities.
 *  Returns one of: 'firecracker' | 'hardened-docker' | 'docker' | 'local'
 */
export async function resolveBackend() {
  const override = config.cellBackend;
  if (override === "local")           return "local";
  if (override === "docker")          return "docker";
  if (override === "hardened-docker") return "hardened-docker";
  if (override === "firecracker")     return "firecracker";

  // Auto: pick the strongest available tier.
  if (await _fcAvailable())           return "firecracker";
  if (await _dockerAvailable())       return "hardened-docker";
  return "local";
}

function _dockerAvailable() {
  return new Promise((resolve) => {
    const p = execFile("docker", ["version", "--format", "{{.Server.Version}}"], (err) => resolve(!err));
    p.on("error", () => resolve(false));
  });
}

function _fcAvailable() {
  if (process.platform !== "linux") return Promise.resolve(false);
  if (!fs.existsSync("/dev/kvm"))    return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = execFile("firecracker", ["--version"], (err) => resolve(!err));
    p.on("error", () => resolve(false));
  });
}

// ── Cell factory ──────────────────────────────────────────────────────────────

const _cells = new Map(); // sandboxId -> Cell

/**
 * Get (and cache) the Cell for a Sandbox row.
 * @param {object} sandbox  - Sandbox row from registry
 * @param {object} [quota]  - Optional resource quota { memMb, cpuShares }
 */
export function getCell(sandbox, { memMb = 512, cpuShares = 1.0 } = {}) {
  if (_cells.has(sandbox.id)) return _cells.get(sandbox.id);
  const cell = _makeCell(sandbox, { memMb, cpuShares });
  _cells.set(sandbox.id, cell);
  return cell;
}

function _makeCell(sandbox, { memMb, cpuShares }) {
  const tier = sandbox.cell_backend;
  switch (tier) {
    case "firecracker":     return new FirecrackerBackend(sandbox, { memMb, vcpus: Math.ceil(cpuShares) });
    case "hardened-docker": return new HardenedDockerBackend(sandbox, { memMb, cpuShares });
    // Backlog #13: plain docker must honor the tenant quota too (not just
    // firecracker/hardened). DockerBackend now accepts { memMb, cpuShares }.
    case "docker":          return new DockerBackend(sandbox, { memMb, cpuShares });
    default:                return new LocalBackend(sandbox);
  }
}

/** For tests: drop cached cells so a fresh backend is picked up. */
export function _resetCells() {
  _cells.clear();
}
