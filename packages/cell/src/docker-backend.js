// Docker Cell backend: a real Linux container per Sandbox.
//
// The Sandbox's volume (a host dir) is bind-mounted to /sandbox in the container.
// "Wake" = start the container if not running (cold-boot on slug access);
// "hibernate"/stop = stop the container while the volume persists on disk. This is
// the Phase-0 form of the hibernate/wake lifecycle in docs/04-execution-substrate.md.

import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import config from "../../config/src/config.js";
import { remoteHandle, newMarker, recordingScript } from "./handles.js";

const WORKDIR = "/sandbox";

function docker(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        });
      });
  });
}

export class DockerBackend {
  // Backlog #13 (docker backend honors tenant quota): accept { memMb, cpuShares }
  // like HardenedDockerBackend instead of hardcoding 512m/1cpu at create time, so
  // the tenant's resource quota is actually enforced. Defaults (512/1) preserve
  // the prior behavior when no quota is supplied.
  constructor(sandbox, { memMb = 512, cpuShares = 1.0 } = {}) {
    this.sandbox = sandbox;
    this.backend = "docker";
    this.root = sandbox.volume_path;               // host-side fs root (bind mount)
    this.container = `sandboxos-cell-${sandbox.id}`;
    this.memMb = memMb;
    this.cpuShares = cpuShares;
  }

  async _state() {
    const r = await docker(["inspect", "-f", "{{.State.Running}}", this.container]);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "running" : "stopped";
  }

  /**
   * Cold-boot (or resume) the container, attaching the persistent volume.
   * Concurrent callers share one in-flight boot (a slug-open and the first exec
   * race to wake the same Cell) — without this lock they'd both `docker run` the
   * same name and collide.
   */
  ensureRunning() {
    if (this._boot) return this._boot;
    this._boot = this._doEnsure().finally(() => { this._boot = null; });
    return this._boot;
  }

  async _doEnsure() {
    fs.mkdirSync(this.root, { recursive: true });
    const state = await this._state();
    if (state === "running") return { state: "running" };
    if (state === "stopped") {
      await docker(["start", this.container]);
      return { state: "running" };
    }
    // absent → create. `tail -f /dev/null` keeps the container alive cheaply.
    const run = await docker([
      "run", "-d",
      "--name", this.container,
      "-v", `${this.root}:${WORKDIR}`,
      "-w", WORKDIR,
      // Backlog #13: resource caps from the tenant quota (default 512m/1cpu).
      "--memory", `${this.memMb}m`, "--cpus", String(this.cpuShares),
      config.cellImage,
      "tail", "-f", "/dev/null",
    ]);
    if (run.code !== 0) {
      // Lost a create race with another process holding the same name → resume it.
      if (/already in use/i.test(run.stderr)) {
        await docker(["start", this.container]);
        return { state: "running" };
      }
      throw new Error(`cell boot failed: ${run.stderr.trim()}`);
    }
    return { state: "running" };
  }

  /** Run a command inside the container, rooted at the volume, with optional env.
   *  Env passed via `docker exec -e` is ephemeral (not stored in container config /
   *  `docker inspect`) — suitable for injecting resolved secrets. */
  async exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const r = await docker(["exec", "-w", WORKDIR, ...envFlags, this.container, "/bin/sh", "-c", command], { timeoutMs });
    return r;
  }

  /** Streaming exec via `docker exec`. Callback receives {type,chunk|code} objects. */
  async execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // Killing `docker exec` locally does not kill the process inside the
    // container, so the in-container shell records its pid before becoming the
    // command; the handle signals *that*. The command travels as $0, so no
    // quoting is needed at any layer.
    const marker = newMarker();
    const proc = spawn("docker", [
      "exec", "-w", WORKDIR, ...envFlags, this.container,
      "/bin/sh", "-c", recordingScript(marker), command,
    ]);
    const handle = remoteHandle(proc, marker, (script) =>
      docker(["exec", this.container, "/bin/sh", "-c", script], { timeoutMs: 10_000 }));
    const timer = setTimeout(() => handle.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => callback({ type: "stdout", chunk: d.toString() }));
    proc.stderr.on("data", (d) => callback({ type: "stderr", chunk: d.toString() }));
    proc.on("close", (code) => { clearTimeout(timer); callback({ type: "done", code: code ?? 1 }); });
    proc.on("error", () => { clearTimeout(timer); callback({ type: "done", code: 1 }); });
    return handle;
  }

  /** Spawn an interactive shell in the container and bridge stdio via callbacks. */
  async execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries({ ...env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) })
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const proc = spawn("docker", ["exec", "-i", ...envFlags, this.container, "/bin/sh", "-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", onClose);
    return {
      write(data) { try { proc.stdin.write(data); } catch {} },
      kill()      { try { proc.kill("SIGKILL"); } catch {} },
      resize()    { /* no-op without a real PTY */ },
    };
  }

  /** Reach a service listening inside the container: resolve its network IP.
   *  The container port is used as-is — no host port publishing is needed because
   *  the Gateway dials the container network directly. */
  async endpoint(port) {
    await this.ensureRunning();
    const r = await docker(["inspect", "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", this.container]);
    const ip = (r.stdout ?? "").trim().split(/\s+/).filter(Boolean)[0];
    if (!ip) throw new Error("container has no reachable IP address");
    return { host: ip, port: Number(port) };
  }

  async stop() {
    this._boot = null;
    await docker(["stop", this.container]);
    return { state: "stopped" };
  }

  async destroy() {
    this._boot = null;
    await docker(["rm", "-f", this.container]);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
