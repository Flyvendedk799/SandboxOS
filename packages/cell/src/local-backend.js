// Local Cell backend: a host directory + child_process.
//
// No isolation — this exists so the spine runs and tests anywhere, including with
// no Docker. The volume directory IS the Sandbox filesystem root; commands run
// with that directory as cwd.

import fs from "node:fs";
import { execFile, spawn } from "node:child_process";

export class LocalBackend {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.backend = "local";
    this.root = sandbox.volume_path; // host-side filesystem root for the Sandbox
  }

  /**
   * Backlog #7 (local backend env hardening): build a MINIMAL, explicit env for
   * sandboxed commands instead of inheriting the full host process.env. The old
   * `{ ...process.env, ...env }` leaked every host secret/config var (API keys,
   * tokens, etc.) into shell commands run inside the Cell. We deliberately keep
   * only PATH (so /bin/sh can find echo/ls/etc — without it everything breaks),
   * pin HOME to the volume dir, and layer the caller-passed env on top. Any extra
   * keys (e.g. TERM) are merged in by the caller via `extra`.
   */
  _minimalEnv(env = {}, extra = {}) {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin", // required: locate shell builtins/binaries
      HOME: this.root,                            // sane HOME, scoped to the Cell volume
      ...extra,
      ...env,                                     // caller-passed env wins last
    };
  }

  /** Ensure the volume exists. "Waking" a local Cell is just making the dir. */
  async ensureRunning() {
    fs.mkdirSync(this.root, { recursive: true });
    return { state: "running" };
  }

  /** Run a shell command inside the Cell (cwd = volume root), with optional env. */
  exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    fs.mkdirSync(this.root, { recursive: true }); // cwd must exist (docker waits on ensureRunning; local mirrors that)
    return new Promise((resolve) => {
      execFile("/bin/sh", ["-c", command],
        { cwd: this.root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: this._minimalEnv(env) },
        (err, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          });
        });
    });
  }

  /** Stream a command's output: callback receives {type,chunk|code} objects.
   *  Returns the child process so the caller can kill it (e.g. on client disconnect). */
  execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd: this.root,
      env: this._minimalEnv(env), // Backlog #7: minimal env, no host secret leak
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => callback({ type: "stdout", chunk: d.toString() }));
    proc.stderr.on("data", (d) => callback({ type: "stderr", chunk: d.toString() }));
    proc.on("close", (code) => { clearTimeout(timer); callback({ type: "done", code: code ?? 1 }); });
    return proc;
  }

  /** Spawn an interactive shell and bridge stdio via callbacks.
   *  Returns a { write(data), kill(), resize(cols,rows) } handle.
   *  Note: without a real PTY, ncurses programs (vim, top) won't render correctly. */
  execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    const shell = process.env.SHELL || "/bin/sh";
    const proc = spawn(shell, ["-i"], {
      cwd: this.root,
      // Backlog #7: minimal env (PATH+HOME) plus the terminal vars an interactive
      // shell needs; no host process.env spread.
      env: this._minimalEnv(env, { TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) }),
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

  /** Reach a service listening inside the Cell. A local Cell shares the host's
   *  loopback, so an in-Cell listener is simply a localhost port. */
  async endpoint(port) {
    return { host: "127.0.0.1", port: Number(port) };
  }

  async stop() { return { state: "stopped" }; }
  async destroy() { fs.rmSync(this.root, { recursive: true, force: true }); }
}
