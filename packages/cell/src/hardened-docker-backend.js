// Hardened Docker Cell backend — L1 isolation with defense-in-depth (docs/04).
//
// Tightens the plain DockerBackend with:
//   - capability model: drop-all + minimal re-add
//   - no privilege escalation (no-new-privileges seccomp anchor)
//   - isolated network namespace (--network=none); outbound goes via net.fetch MCP
//   - process count cap (--pids-limit)
//   - resource limits from tenant quota (mem_mb, cpu_shares)
//   - no swap (--memory-swap == --memory)
//
// This is the default backend when Docker is available. The Cell interface is
// identical to DockerBackend, so the Kernel and all MCP servers are unaware of
// the difference.

import fs from "node:fs";
import { newMarker as ptyMarker, ptyWrapper, resizeScript, cleanupScript } from "./pty.js";
import { execFile, spawnSync } from "node:child_process";
import { safeSpawn, detachedSpawn } from "./spawn.js";
import config from "../../config/src/config.js";
import { remoteHandle, newMarker, recordingScript } from "./handles.js";

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
      (err, stdout, stderr) => resolve({
        stdout: stdout ?? "", stderr: stderr ?? "",
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      }));
  });
}

export class HardenedDockerBackend {
  constructor(sandbox, { memMb = 512, cpuShares = 1.0 } = {}) {
    this.sandbox = sandbox;
    this.backend = "hardened-docker";
    this.root = sandbox.volume_path;
    this.container = `sandboxos-hdc-${sandbox.id}`;
    this.memMb = memMb;
    this.cpuShares = cpuShares;
  }

  /**
   * Build the docker-run argument list. Extracted so the security configuration
   * can be unit-tested without needing a running Docker daemon.
   */
  _buildRunArgs() {
    return [
      "run", "-d",
      "--name", this.container,
      "-v", `${this.root}:${WORKDIR}`,
      "-w", WORKDIR,

      // ── Resource limits (from tenant quota) ──────────────────────────────
      "--memory",      `${this.memMb}m`,
      "--memory-swap", `${this.memMb}m`,    // disable swap
      "--cpus",        String(this.cpuShares),
      "--pids-limit",  "256",

      // ── Security: no privilege escalation ────────────────────────────────
      "--security-opt=no-new-privileges",

      // ── Capabilities: drop all, add back the minimum a Linux process needs.
      // Explicitly absent (among the Docker defaults): NET_RAW, NET_ADMIN,
      // SYS_ADMIN, SYS_PTRACE, SYS_MODULE, SYS_BOOT, SYS_RAWIO, DAC_READ_SEARCH.
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=DAC_OVERRIDE",
      "--cap-add=FOWNER",
      "--cap-add=FSETID",
      "--cap-add=KILL",
      "--cap-add=SETGID",
      "--cap-add=SETUID",
      "--cap-add=SETPCAP",
      "--cap-add=NET_BIND_SERVICE",
      "--cap-add=MKNOD",
      "--cap-add=AUDIT_WRITE",
      "--cap-add=SETFCAP",

      // ── Network: isolated namespace with no external route.
      // MCP net.fetch tool provides controlled outbound through the Gateway proxy.
      "--network=none",

      config.cellImage,
      "tail", "-f", "/dev/null",
    ];
  }

  async _state() {
    const r = await docker(["inspect", "-f", "{{.State.Running}}", this.container]);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "running" : "stopped";
  }

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
    const run = await docker(this._buildRunArgs());
    if (run.code !== 0) {
      if (/already in use/i.test(run.stderr)) {
        await docker(["start", this.container]);
        return { state: "running" };
      }
      throw new Error(`hardened cell boot failed: ${run.stderr.trim()}`);
    }
    return { state: "running" };
  }

  async exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return docker(["exec", "-w", WORKDIR, ...envFlags, this.container, "/bin/sh", "-c", command], { timeoutMs });
  }

  async execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
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

  /** Spawn an interactive shell in the container under a real pty (pty.js:
   *  `script` inside the image; `docker exec -t` would need a TTY on our side)
   *  and bridge stdio via callbacks. Resize is `stty` on the recorded tty. */
  async execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    await this.ensureRunning();
    const envFlags = Object.entries({ ...env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) })
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

  /** Hardened Cells run with --network=none, so nothing inside them is reachable
   *  over the network. Port preview is deliberately unavailable at this tier. */
  async endpoint() {
    throw new Error("hardened Cells run with --network=none; port preview is unavailable");
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
