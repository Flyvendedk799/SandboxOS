// pty.js — a real terminal for the interactive shell, without node-pty.
//
// Node cannot allocate a pseudo-terminal by itself, and `docker exec -t` needs
// a TTY on *our* side. Both problems have the same answer: `script`, which
// every Linux (util-linux) and every busybox image ships, allocates a pty for
// the command it runs. So the shell runs under `script`, records the path of
// its tty in a marker file, and resizing is `stty` against that path — which
// also delivers SIGWINCH to whatever is in the foreground. Job control works,
// vim paints, and "can't access tty" is gone.
//
// If `script` is missing in an image, the shell still runs, over pipes, and
// says so once, honestly, at the top.

import crypto from "node:crypto";

export const newMarker = () => crypto.randomBytes(6).toString("hex");
export const markerPath = (marker, tmp = "/tmp") => `${tmp}/.sbx-tty-${marker}`;

/**
 * A `sh -c` script that runs `shellCmd` under a pty when `script` exists.
 * Pass it as: sh -c <this> sh <marker>   (marker arrives as $1).
 */
export function ptyWrapper(shellCmd = "/bin/sh -i", tmp = "/tmp") {
  return [
    `M="${tmp}/.sbx-tty-$1"`,
    'if command -v script >/dev/null 2>&1; then',
    // The inner command runs via the pty's own shell: record the tty, then exec.
    `  exec script -qfc "tty > \\"$M\\" 2>/dev/null; exec ${shellCmd}" /dev/null`,
    "else",
    `  printf '%s\\n' '(no pseudo-terminal: install util-linux or busybox "script" in this image for job control and full-screen programs)'`,
    `  exec ${shellCmd}`,
    "fi",
  ].join("\n");
}

/** A `sh -c` script that resizes the pty recorded for `marker` (Linux `-F`, BSD `-f`). */
export function resizeScript(marker, cols, rows, tmp = "/tmp") {
  const c = Math.max(20, Math.min(500, Number(cols) | 0)), r = Math.max(4, Math.min(300, Number(rows) | 0));
  return `T=$(head -n1 "${markerPath(marker, tmp)}" 2>/dev/null); [ -n "$T" ] || exit 0; stty -F "$T" cols ${c} rows ${r} 2>/dev/null || stty -f "$T" cols ${c} rows ${r} 2>/dev/null || true`;
}

/** End the session: kill the shell's process group (it is a session leader
 *  under `script`, so this takes its children too), then drop the marker. */
export const cleanupScript = (marker, tmp = "/tmp") =>
  `P=$(sed -n 2p "${markerPath(marker, tmp)}" 2>/dev/null); if [ -n "$P" ]; then kill -9 -- -"$P" 2>/dev/null; kill -9 "$P" 2>/dev/null; fi; rm -f "${markerPath(marker, tmp)}"`;
