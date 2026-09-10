// Docker Cell backend: a real Linux container per Sandbox.
//
// The Sandbox's volume (a host dir) is bind-mounted to /sandbox in the container.
// "Wake" = start the container if not running (cold-boot on slug access);
// "hibernate"/stop = stop the container while the volume persists on disk. This is
// the Phase-0 form of the hibernate/wake lifecycle in docs/04-execution-substrate.md.

import fs from "node:fs";
import { newMarker as ptyMarker, ptyWrapper, resizeScript, cleanupScript } from "./pty.js";
import { execFile, spawnSync } from "node:child_process";
import { safeSpawn, detachedSpawn } from "./spawn.js";
import config from "../../config/src/config.js";
import { remoteHandle, newMarker, recordingScript } from "./handles.js";
import { bootEnv, reapOrphans } from "./orphans.js";

const WORKDIR = "/sandbox";

/** `docker`, synchronously. Used only where the caller cannot wait for a promise —
 *  the process is about to exit and a fire-and-forget kill would never land. */
function dockerSync(args, { timeoutMs = 10_000 } = {}) {
  try { return spawnSync("docker", args, { timeout: timeoutMs, stdio: "ignore" }); }
  catch { return null; }
}
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

  /** The image this container was actually created from, or null if it is gone. */
  async _image() {
    const r = await docker(["inspect", "-f", "{{.Config.Image}}", this.container]);
    return r.code === 0 ? r.stdout.trim() : null;
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
    let state = await this._state();

    // Changing SANDBOXOS_CELL_IMAGE used to do nothing at all: an existing
    // container was started whatever it had been built from, so the setting
    // looked broken and the old image's limitations survived every restart.
    // A container is a cache of an image; the volume is a bind mount and is the
    // part that must not be thrown away, and it is untouched by this.
    if (state !== "absent") {
      const was = await this._image();
      if (was && was !== config.cellImage) {
        this.recreatedFrom = was;
        await docker(["rm", "-f", this.container]);
        state = "absent";
      }
    }

    if (state === "running") return { state: "running", reaped: await this._reap() };
    if (state === "stopped") {
      // Everything inside a container dies with `docker stop`, so a Cell we are
      // resuming is empty by construction and there is nothing to reap.
      await docker(["start", this.container]);
      return { state: "running" };
    }
    // absent → create. `tail -f /dev/null` keeps the container alive cheaply.
    const run = await docker([
      "run", "-d",
      // `tail -f /dev/null` is a fine way to keep a container alive and a poor
      // pid 1: it never calls wait(), so every process re-parented to it stays a
      // zombie. A Cell re-parents them constantly — each `docker exec` job whose
      // shell outlives its client — and a live deployment had six of them sitting
      // in the process table holding pid slots. `--init` puts tini in front, whose
      // entire job is to reap.
      "--init",
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
    if (this.recreatedFrom) {
      const from = this.recreatedFrom;
      this.recreatedFrom = null;
      return { state: "running", recreated: { from, to: config.cellImage } };
    }
    return { state: "running" };
  }

  /** Run a command inside the container, rooted at the volume, with optional env.
   *  Env passed via `docker exec -e` is ephemeral (not stored in container config /
   *  `docker inspect`) — suitable for injecting resolved secrets. */
  /** Kill anything left inside by a Gateway that is no longer running. Once per
   *  backend instance, because a new instance means a new Gateway boot — which is
   *  exactly when everything still running in here belongs to somebody dead. */
  async _reap() {
    if (this._reaped) return 0;
    this._reaped = true;
    return reapOrphans((script) => docker(["exec", this.container, "/bin/sh", "-c", script], { timeoutMs: 20_000 }),
      `cell ${this.sandbox.id}`);
  }

  async exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries({ ...bootEnv(), ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const r = await docker(["exec", "-w", WORKDIR, ...envFlags, this.container, "/bin/sh", "-c", command], { timeoutMs });
    return r;
  }

  /** Streaming exec via `docker exec`. Callback receives {type,chunk|code} objects. */
  async execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries({ ...bootEnv(), ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // Killing `docker exec` locally does not kill the process inside the
    // container, so the in-container shell records its pid before becoming the
    // command; the handle signals *that*. The command travels as $0, so no
    // quoting is needed at any layer.
    const marker = newMarker();
    const proc = safeSpawn("docker", [
      "exec", "-w", WORKDIR, ...envFlags, this.container,
      "/bin/sh", "-c", recordingScript(marker), command,
    ], {}, (err) => callback({ type: "stderr", chunk: `sandboxos: could not run docker: ${err.code ?? err.message}
` }));
    const handle = remoteHandle(proc, marker,
      (script) => docker(["exec", this.container, "/bin/sh", "-c", script], { timeoutMs: 10_000 }),
      // …and the same thing synchronously, for the shutdown path: it calls this
      // and then exits, so a promise here is a kill that never happens.
      { runInCellSync: (script) => dockerSync(["exec", this.container, "/bin/sh", "-c", script]) });
    const timer = setTimeout(() => handle.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => callback({ type: "stdout", chunk: d.toString() }));
    proc.stderr.on("data", (d) => callback({ type: "stderr", chunk: d.toString() }));
    proc.on("close", (code) => { clearTimeout(timer); callback({ type: "done", code: code ?? 1 }); });
    proc.on("error", () => { clearTimeout(timer); callback({ type: "done", code: 1 }); });
    return handle;
  }

  /** Spawn an interactive shell in the container and bridge stdio via callbacks. */
  /** Spawn an interactive shell in the container under a real pty (pty.js:
   *  `script` inside the image; `docker exec -t` would need a TTY on our side)
   *  and bridge stdio via callbacks. Resize is `stty` on the recorded tty. */
  async execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries({ ...bootEnv(), ...env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) })
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const marker = ptyMarker();
    const proc = safeSpawn("docker", ["exec", "-i", "-w", WORKDIR, ...envFlags, this.container, "/bin/sh", "-c", ptyWrapper("/bin/sh -i"), "sh", marker], {
      stdio: ["pipe", "pipe", "pipe"],
    }, (err) => onData(`
[31msandboxos:[0m could not run docker: ${err.code ?? err.message}
`));
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    const container = this.container;
    const resize = (c, r) => detachedSpawn("docker", ["exec", container, "/bin/sh", "-c", resizeScript(marker, c, r)]);
    const first = setTimeout(() => resize(cols, rows), 400);
    // Killing `docker exec` locally leaves the shell alive in the container:
    // the cleanup script kills the recorded shell's process group in there.
    const cleanup = () => detachedSpawn("docker", ["exec", container, "/bin/sh", "-c", cleanupScript(marker)], { detached: true });
    let closed = false;
    proc.on("exit", () => { clearTimeout(first); cleanup(); if (!closed) { closed = true; onClose(); } });
    proc.on("error", () => { if (!closed) { closed = true; onClose(); } });
    return {
      write(data) { try { proc.stdin.write(data); } catch {} },
      kill()      { cleanup(); try { proc.kill("SIGKILL"); } catch {} },
      resize,
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
