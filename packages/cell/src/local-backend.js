// Local Cell backend: a host directory + child_process.
//
// No isolation — this exists so the spine runs and tests anywhere, including with
// no Docker. The volume directory IS the Sandbox filesystem root; commands run
// with that directory as cwd.
//
// It also runs on whatever shell the host actually has (shell.js), because the
// person developing this is on Windows and a backend that assumes `/bin/sh` is
// not a backend, it is a note saying "works on my machine". When there is no
// shell at all, every entry point here says so — with a code and a fix — instead
// of returning an empty string and exit code 1.

import fs from "node:fs";
import { groupHandle } from "./handles.js";
import { newMarker, ptyWrapper, resizeScript, cleanupScript } from "./pty.js";
import { safeSpawn, detachedSpawn, execFileSafe, killTree } from "./spawn.js";
import { resolveShell, baseEnv, shellTmp, toShellPath, unsupportedHost } from "./shell.js";

const isWin = process.platform === "win32";

export class LocalBackend {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.backend = "local";
    this.root = sandbox.volume_path; // host-side filesystem root for the Sandbox
  }

  get shell() { return resolveShell(); }

  /**
   * Backlog #7 (local backend env hardening): build a MINIMAL, explicit env for
   * sandboxed commands instead of inheriting the full host process.env. The old
   * `{ ...process.env, ...env }` leaked every host secret/config var (API keys,
   * tokens, etc.) into shell commands run inside the Cell. `baseEnv` keeps PATH
   * (without it the shell finds nothing), pins HOME to the volume, adds the few
   * variables a Windows shell cannot start without, and layers the caller's env
   * on top.
   */
  _minimalEnv(env = {}, extra = {}) {
    return baseEnv(this.root, env, extra);
  }

  /** Ensure the volume exists. "Waking" a local Cell is just making the dir. */
  async ensureRunning() {
    fs.mkdirSync(this.root, { recursive: true });
    return { state: "running" };
  }

  /** Run a shell command inside the Cell (cwd = volume root), with optional env.
   *
   *  Three outcomes, and they are not the same thing: it ran (`code`), it ran and
   *  failed (`code` non-zero, `stderr`), or it never started (`failure`). Folding
   *  the third into the second is what made a shell-less host look like an empty
   *  machine rather than a broken one. */
  async exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    const sh = this.shell;
    if (!sh.ok) return failedExec(command, sh.why);
    fs.mkdirSync(this.root, { recursive: true }); // cwd must exist (docker waits on ensureRunning; local mirrors that)
    const r = await execFileSafe(sh.bin, sh.argv(command), {
      cwd: this.root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: this._minimalEnv(env),
    });
    if (r.spawnError) return failedExec(command, `${sh.bin}: ${r.spawnError.code ?? r.spawnError.message}`);
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  }

  /** Stream a command's output: callback receives {type,chunk|code} objects.
   *  Returns a handle the caller can kill (on client disconnect, or proc.stop).
   *
   *  `detached` matters on POSIX: it makes the shell a process-group leader, so
   *  killing the group takes down the command it started. Without it, stopping a
   *  supervised dev server kills only the wrapping shell and leaves the server
   *  running — holding its port until the host reboots. On Windows the same
   *  intention is `taskkill /T` (see spawn.js). */
  execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    const sh = this.shell;
    if (!sh.ok) {
      queueMicrotask(() => {
        callback({ type: "stderr", chunk: `sandboxos: cannot run commands — ${sh.why}\n` });
        callback({ type: "done", code: 127, failure: { code: "unsupported_host", message: sh.why } });
      });
      return { pid: null, kill() { return false; } };
    }
    fs.mkdirSync(this.root, { recursive: true });
    let done = false;
    const finish = (code, failure) => { if (!done) { done = true; clearTimeout(timer); callback({ type: "done", code, ...(failure ? { failure } : {}) }); } };
    const proc = safeSpawn(sh.bin, sh.argv(command), {
      cwd: this.root,
      env: this._minimalEnv(env), // Backlog #7: minimal env, no host secret leak
      detached: process.platform !== "win32",
    }, (err) => {
      callback({ type: "stderr", chunk: `sandboxos: could not start ${sh.bin}: ${err.code ?? err.message}\n` });
      finish(127, { code: "spawn_failed", message: `${sh.bin}: ${err.code ?? err.message}` });
    });
    const handle = groupHandle(proc);
    const timer = setTimeout(() => handle.kill("SIGKILL"), timeoutMs);
    proc.stdout?.on("data", (d) => callback({ type: "stdout", chunk: d.toString() }));
    proc.stderr?.on("data", (d) => callback({ type: "stderr", chunk: d.toString() }));
    proc.on("close", (code) => finish(code ?? 1));
    return handle;
  }

  /** Spawn an interactive shell under a real pty (see pty.js) and bridge stdio
   *  via callbacks. Returns a { write(data), kill(), resize(cols,rows) } handle.
   *
   *  A host with no shell gets one honest line and a closed session rather than
   *  a blank rectangle — and, before this was fixed, rather than a dead Gateway. */
  execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    const sh = this.shell;
    if (!sh.ok) {
      queueMicrotask(() => {
        onData(`\r\n\x1b[31msandboxos:\x1b[0m ${sh.why}\r\n`);
        onClose();
      });
      return { write() {}, kill() {}, resize() {} };
    }
    fs.mkdirSync(this.root, { recursive: true });
    const marker = newMarker();
    const tmp = shellTmp(sh);
    const fullEnv = this._minimalEnv(env, { TERM: sh.pty ? "xterm-256color" : "dumb", COLUMNS: String(cols), LINES: String(rows) });
    let closed = false;
    const close = () => { if (!closed) { closed = true; onClose(); } };

    // Only a POSIX shell can host the `script(1)` wrapper. Anything else runs in
    // line mode, and the terminal is told so on its first line.
    // The interactive shell is named in *shell* terms — the script it is
    // interpolated into is shell text, and a Windows path full of backslashes
    // would be eaten by it one escape at a time.
    const interactive = toShellPath(process.env.SHELL && !isWin ? process.env.SHELL : sh.bin, sh);
    // With a pty the shell runs under `script` (pty.js); without one it is our
    // direct child in line mode — which is also the only way we can reliably end
    // it, because a wrapper that exec's a grandchild leaves an orphan holding the
    // pipes open long after the process we spawned is gone.
    const argv = sh.interactiveArgv(ptyWrapper(`"${interactive}" -i`, tmp), marker);

    const proc = safeSpawn(sh.bin, argv, {
      cwd: this.root,
      env: fullEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Detached: the shell and everything it started form one group we can end
      // together, so a closed tab never leaves a pty holding the Gateway open.
      detached: process.platform !== "win32",
    }, (err) => {
      onData(`\r\n\x1b[31msandboxos:\x1b[0m could not start ${sh.bin}: ${err.code ?? err.message}\r\n`);
      close();
    });

    if (!sh.pty) {
      queueMicrotask(() => onData(
        `\x1b[2m(line mode: ${sh.label} has no \`script\` for a pseudo-terminal — full-screen programs and job control are unavailable)\x1b[0m\r\n`,
      ));
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    const resize = sh.pty
      ? (c, r) => detachedSpawn(sh.bin, sh.argv(resizeScript(marker, c, r, tmp)), { env: fullEnv })
      : () => {};
    // The pty starts unsized (our stdin is a pipe): size it once the shell is up.
    const first = sh.pty ? setTimeout(() => resize(cols, rows), 250) : null;
    const cleanup = () => {
      if (sh.pty) detachedSpawn(sh.bin, sh.argv(cleanupScript(marker, tmp)), { detached: process.platform !== "win32" });
      killTree(proc.pid, "SIGKILL", proc);
    };
    proc.on("exit", () => { clearTimeout(first); cleanup(); close(); });
    return {
      write(data) { try { proc.stdin?.write(data); } catch { /* the session is going away */ } },
      kill()      { cleanup(); try { proc.kill("SIGKILL"); } catch { /* already gone */ } },
      resize,
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

/** The shape `exec` returns when the command never ran. `code: 127` is the
 *  shell's own "command not found", which is what this is. */
function failedExec(command, why) {
  return {
    stdout: "",
    stderr: `sandboxos: cannot run commands — ${why}\n`,
    code: 127,
    failure: { code: "unsupported_host", message: why, command },
  };
}

