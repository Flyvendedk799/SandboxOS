// Which shell this host actually has — and how to talk to it.
//
// The Cell backends were written against `/bin/sh` because every Linux and every
// container has one. The machine this project is developed on does not, and the
// result was not a degraded terminal: it was a Gateway that exited on `spawn
// /bin/sh ENOENT` and took every tenant's session with it (goal.md §1).
//
// So the shell is resolved once, explicitly, at startup: an operator override
// first, then a POSIX shell (including the one Git for Windows ships, which
// keeps every recorded script in this package working unchanged), then
// PowerShell, then `cmd`. What we found — and what we did not — is printed at
// boot and reported by tools that need it, rather than discovered as an empty
// string at 2 a.m.
//
// Resolution is filesystem-only: no probe spawns a process, because the whole
// point of this file is that spawning is the thing that can fail.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const isWin = process.platform === "win32";

/** Look for `name` on PATH without spawning anything (PATHEXT-aware on Windows). */
export function which(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Where Git for Windows usually puts the POSIX shell it ships. */
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\sh.exe",
  "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files (x86)\\Git\\bin\\sh.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
];

/**
 * A resolved shell.
 *
 *   kind        "posix" | "powershell" | "cmd" — which grammar its scripts speak
 *   bin         absolute path to the interpreter
 *   argv(cmd)   the argument vector that runs one command string
 *   posix       true when recorded shell scripts (pty.js, handles.js) will run
 *   pty         whether a pseudo-terminal can be allocated for it
 *   why         one line for the boot banner and for `unsupported_host` errors
 */
function describe(bin, kind, { source = "found" } = {}) {
  const posix = kind === "posix";
  return {
    ok: true,
    kind,
    bin,
    posix,
    source,
    label: `${path.basename(bin)} (${kind})`,
    argv: (command) =>
      kind === "posix" ? ["-c", command]
      : kind === "powershell" ? ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", command]
      : ["/d", "/s", "/c", command],
    // Only a POSIX shell can run the `script(1)` wrapper in pty.js. Everything
    // else gets a line-mode terminal, and says so instead of pretending.
    pty: posix,
  };
}

let _cached = null;

/** The host's shell, resolved once. `SANDBOXOS_SHELL` overrides everything. */
export function resolveShell({ refresh = false } = {}) {
  if (_cached && !refresh) return _cached;

  const override = process.env.SANDBOXOS_SHELL;
  if (override) {
    const base = path.basename(override).toLowerCase();
    const kind = /^(pwsh|powershell)/.test(base) ? "powershell" : base.startsWith("cmd") ? "cmd" : "posix";
    if (exists(override) || which(override)) {
      _cached = describe(exists(override) ? override : which(override), kind, { source: "SANDBOXOS_SHELL" });
      return _cached;
    }
    _cached = missing(`SANDBOXOS_SHELL is set to "${override}", which is not an executable file`);
    return _cached;
  }

  const posix = [
    !isWin && exists("/bin/sh") ? "/bin/sh" : null,
    !isWin && exists("/usr/bin/sh") ? "/usr/bin/sh" : null,
    !isWin ? which("sh") : null,
    !isWin ? which("bash") : null,
    isWin ? GIT_BASH_CANDIDATES.find(exists) : null,
    isWin ? which("sh") : null,
    isWin ? which("bash") : null,
  ].find(Boolean);
  if (posix) { _cached = describe(posix, "posix"); return _cached; }

  if (isWin) {
    const ps = which("pwsh") ?? which("powershell");
    if (ps) { _cached = describe(ps, "powershell"); return _cached; }
    const cmd = process.env.COMSPEC && exists(process.env.COMSPEC) ? process.env.COMSPEC : which("cmd");
    if (cmd) { _cached = describe(cmd, "cmd"); return _cached; }
  }

  _cached = missing(
    isWin
      ? "no shell found: install Git for Windows (its bash is enough) or set SANDBOXOS_SHELL"
      : "no shell found: /bin/sh is missing and neither sh nor bash is on PATH",
  );
  return _cached;
}

function missing(why) {
  return {
    ok: false, kind: null, bin: null, posix: false, pty: false, source: "none",
    label: "none", why,
    argv: () => [],
  };
}

/** Reset the cache. Tests change PATH and expect to be believed. */
export function _resetShell() { _cached = null; }

/**
 * The error every tool raises when the host cannot run commands at all. Carries
 * a code the Kernel propagates, so a caller sees `unsupported_host` and a
 * sentence naming the fix — not an empty stdout and exit code 1.
 */
export function unsupportedHost(what = "run commands") {
  const sh = resolveShell();
  const err = new Error(`this host cannot ${what}: ${sh.why ?? "no shell"}`);
  err.code = "unsupported_host";
  return err;
}

/**
 * Raise what `cell.exec` reported as a *failure to run*, rather than letting a
 * caller mistake it for a command that ran and said nothing. Callers that can
 * degrade honestly (a port scan, a metrics probe) skip this and read
 * `result.failure` themselves; callers whose whole purpose was to run the
 * command use it.
 */
export function raiseFailure(result, what = "run commands") {
  if (result?.failure) {
    const err = result.failure.code === "unsupported_host"
      ? unsupportedHost(what)
      : Object.assign(new Error(result.failure.message), { code: result.failure.code });
    throw err;
  }
  return result;
}

/**
 * A host path as the resolved shell sees it. Git for Windows' bash understands
 * `/c/Users/...`, not `C:\Users\...`, and every recorded script in pty.js and
 * handles.js interpolates paths into shell text.
 */
export function toShellPath(p, shell = resolveShell()) {
  if (!isWin || shell.kind !== "posix") return p;
  const win = String(p).replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(win);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : win;
}

/** A temp directory both Node and the shell can name. */
export function shellTmp(shell = resolveShell()) {
  return toShellPath(os.tmpdir(), shell);
}

/**
 * The environment a Cell command runs with: explicitly built, never inherited
 * wholesale (backlog #7 — the host's API keys are not the Cell's business).
 * Windows shells need a few variables to function at all; those are named here
 * rather than smuggled in by `...process.env`.
 */
export function baseEnv(home, env = {}, extra = {}) {
  const keep = { PATH: process.env.PATH ?? (isWin ? "" : "/usr/bin:/bin"), HOME: home };
  if (isWin) {
    for (const k of ["SystemRoot", "windir", "COMSPEC", "PATHEXT", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      if (process.env[k] != null) keep[k] = process.env[k];
    }
    keep.USERPROFILE = home;
    keep.TEMP = keep.TMP = os.tmpdir();
  }
  return { ...keep, ...extra, ...env };
}

/**
 * How to run npm on this host.
 *
 * Windows ships npm as `npm.cmd`, which `spawn` will not resolve on its own and
 * — since Node 20 closed CVE-2024-27980 — refuses to execute directly at all
 * (`spawn EINVAL`). The reliable answer on every platform is to skip the wrapper
 * and run npm's own entry point with the Node we are already running.
 */
export function resolveNpm() {
  const dir = path.dirname(process.execPath);
  const cli = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),          // Windows layout
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // POSIX layout
  ].find(exists);
  if (cli) return { ok: true, bin: process.execPath, prefix: [cli], via: "npm-cli.js" };

  const npm = which("npm");
  if (!npm) return { ok: false, bin: null, prefix: [], why: "npm is not on PATH" };
  if (isWin && /\.(cmd|bat)$/i.test(npm)) {
    const comspec = process.env.COMSPEC && exists(process.env.COMSPEC) ? process.env.COMSPEC : which("cmd");
    if (comspec) return { ok: true, bin: comspec, prefix: ["/d", "/s", "/c", npm], via: "cmd" };
  }
  return { ok: true, bin: npm, prefix: [], via: "path" };
}

/** What the operator should know at boot, and what it costs them. */
export function hostReport() {
  const sh = resolveShell();
  const notes = [];
  if (!sh.ok) {
    notes.push({ level: "error", text: `shell     none — ${sh.why}`, disables: "processes, terminal, package install, secrets in env" });
  } else {
    notes.push({ level: "info", text: `shell     ${sh.bin}${sh.source === "SANDBOXOS_SHELL" ? "  (SANDBOXOS_SHELL)" : ""}` });
    if (!sh.pty) {
      notes.push({ level: "warn", text: "terminal  line mode — no pseudo-terminal on this shell", disables: "full-screen programs and job control in the Terminal" });
    }
  }
  return { shell: sh, notes };
}
