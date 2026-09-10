// Orphan reaping — what to do about jobs that outlived the Gateway that started
// them.
//
// The shutdown path (proc.js `stopAllProcsEverywhere`, called from the Gateway's
// SIGTERM handler) kills every supervised process before exiting, and since the
// remote handles became synchronous it really does reach inside a Cell. But a
// shutdown handler is a courtesy the machine is not obliged to extend:
//
//   • SIGKILL runs no handler, by definition.
//   • Nor does a host reboot, an OOM kill, or a hypervisor pulling the plug.
//   • Nor does a supervisor that means well and is racing itself. The PaaS this
//     project is deployed on sends SIGTERM to the process group and then, in the
//     next statement, SIGKILL to the same group — so the handler is dead about a
//     microsecond after it is entered. A welcome server survived every restart
//     that way, holding port 8080, with nothing left running that knew it
//     existed, which is exactly the orphan the shutdown path was written to
//     prevent.
//
// A Cell outlives the Gateway on purpose — the container is stopped only on
// hibernate, so the volume and the boot cost are preserved. That makes the rule
// simple and total: when a Gateway adopts a Cell that is already running,
// anything inside it that a *different* Gateway started is an orphan. Not a
// heuristic about ports or process names — a fact about who is alive.
//
// So every command this Gateway runs in a Cell carries its boot id in the
// environment, and adoption kills everything carrying anybody else's. The
// environment is the right place to stamp it: it is inherited by children, it
// survives `exec` (which is how a recorded pid stays the command's pid), and
// unlike a pid file it cannot be claimed by an unrelated process that happened
// to be handed the same number.

import crypto from "node:crypto";

/** This Gateway process's identity, as seen from inside a Cell. New on every
 *  boot, which is the whole point: it is what makes "somebody else's" decidable. */
export const BOOT_ID = crypto.randomBytes(8).toString("hex");

/** The env every in-Cell command is stamped with. Spread it *before* the
 *  caller's env so a Sandbox cannot overwrite it and hide from the reaper. */
export const bootEnv = () => ({ SANDBOXOS_BOOT: BOOT_ID });

/**
 * A POSIX `sh` one-liner that kills everything in a Cell stamped with a boot id
 * other than `bootId`, and prints one pid per line for what it signalled.
 *
 * Written for busybox ash and dash as well as bash, because the image is the
 * user's choice and this has to work in all of them:
 *
 *   • `/proc/<pid>/environ` is NUL-separated, so `tr` before `sed`.
 *   • A process with no `SANDBOXOS_BOOT` is not ours — the container's own init,
 *     or something the user started by hand in a terminal we do not own — and is
 *     left alone.
 *   • The shell running this script is skipped explicitly, in case a future
 *     caller starts passing it the boot env.
 *   • Group first, then the pid: a supervised job is `sh -c` and whatever it
 *     started, and the group is what holds the port.
 *   • TERM, a second's grace, then KILL. These belong to a Gateway that is gone,
 *     so nothing is waiting to hear how they took the news — but a dev server
 *     gets its chance to close its listener politely before we insist.
 *
 * The marker files get a second sweep for one reason: a Cell that has been up
 * since before this stamp existed is full of processes carrying no boot id at
 * all, and they would be immortal under the environment rule alone. `/tmp/.sbx-*`
 * is written by nothing but this project, so a live pid named by one is ours by
 * provenance — and the environment check still runs on it, so a marker whose pid
 * has since been reused by a job of *this* boot is left alone rather than killed
 * on the strength of a stale number.
 */
export function reapScript(bootId) {
  const me = String(bootId).replace(/[^a-f0-9]/gi, "");
  return [
    `me=${me}; victims=`,
    // The whole group is silenced, not just `tr`: a process that exits between
    // the glob and the read makes the *shell* fail to open the redirect, and that
    // complaint belongs to the shell rather than to the command it was opening
    // for. Reaping races exiting processes by nature, so this is the normal case.
    'boot_of() { { tr "\\0" "\\n" < "/proc/$1/environ" | sed -n "s/^SANDBOXOS_BOOT=//p" | head -n1; } 2>/dev/null; }',
    // One place where a pid becomes a victim, so both sweeps agree on the rules.
    'claim() {',
    '  q=$1',
    '  case "$q" in "" | *[!0-9]*) return 0;; esac',
    '  [ "$q" = "$$" ] && return 0',
    '  [ -d "/proc/$q" ] || return 0',
    '  [ "$(boot_of "$q")" = "$me" ] && return 0',
    '  case " $victims " in *" $q "*) return 0;; esac',
    '  victims="$victims $q"',
    '  kill -TERM -"$q" 2>/dev/null; kill -TERM "$q" 2>/dev/null',
    '  return 0',
    '}',
    // Sweep one: anybody else's boot id.
    'for p in /proc/[0-9]*; do',
    '  q=${p#/proc/}',
    '  [ -n "$(boot_of "$q")" ] && claim "$q"',
    'done',
    // Sweep two: our own marker files, which outlive the stamp.
    'for f in /tmp/.sbx-*.pid; do [ -f "$f" ] && claim "$(head -n1 "$f" 2>/dev/null)"; done',
    'for f in /tmp/.sbx-tty-*; do [ -f "$f" ] && claim "$(sed -n 2p "$f" 2>/dev/null)"; done',
    '[ -n "$victims" ] || exit 0',
    'sleep 1',
    'for q in $victims; do kill -KILL -"$q" 2>/dev/null; kill -KILL "$q" 2>/dev/null; done',
    // Those files name pids that are now free to be reused; leaving them would
    // let a later kill signal an innocent process.
    'rm -f /tmp/.sbx-*.pid /tmp/.sbx-tty-* 2>/dev/null',
    'for q in $victims; do echo "$q"; done',
  ].join("\n");
}

/**
 * Reap once, for a backend that has just adopted a running Cell.
 *
 * `run` is the backend's own "execute this shell script in the Cell" — a promise
 * of `{ stdout, code }`. Failure is deliberately quiet: a Cell that cannot run a
 * shell has no orphans worth reporting, and refusing to boot over it would turn
 * a cleanup into an outage.
 */
export async function reapOrphans(run, label = "cell") {
  let r;
  try { r = await run(reapScript(BOOT_ID)); } catch { return 0; }
  const pids = String(r?.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (pids.length) {
    console.log(`${label}: reaped ${pids.length} orphaned process${pids.length === 1 ? "" : "es"} from a previous boot`);
  }
  return pids.length;
}
