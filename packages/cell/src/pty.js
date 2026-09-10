// pty.js — a real terminal for the interactive shell, without node-pty.
//
// Node cannot allocate a pseudo-terminal by itself, and `docker exec -t` needs
// a TTY on *our* side. Both problems have the same answer: `script`, which
// allocates a pty for the command it runs. So the shell runs under `script`,
// records the path of its tty in a marker file, and resizing is `stty` against
// that path — which also delivers SIGWINCH to whatever is in the foreground.
// Job control works, vim paints, and "can't access tty" is gone.
//
// `script` is not everywhere, whatever this comment used to claim. On Debian it
// comes from `bsdutils`, which is Essential, so every Debian image has it. On
// Alpine it is in `util-linux`, which is not installed by default, and Alpine's
// busybox is built without the `script` applet — so `alpine:latest`, which was
// this project's default cell image, handed every Docker deployment a line-mode
// terminal and a message most people read as a bug in the terminal rather than
// as a fact about their image.
//
// Where it is missing the shell still runs, over pipes, and says so once at the
// top — naming the package, not the symptom.

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
    //
    // Line 2 is the pid `cleanupScript` signals, and it has to be written here
    // rather than inside the pty: `$$` is expanded by *this* shell, before it is
    // replaced by `script`, so the number is the shell docker/ssh started — the
    // process-group leader, which is what takes the whole session down. Without
    // it `sed -n 2p` read an empty line, the kill was a no-op, and every closed
    // terminal left a live shell behind in the Cell.
    `  exec script -qfc "tty > \\"$M\\" 2>/dev/null; echo $$ >> \\"$M\\" 2>/dev/null; exec ${shellCmd}" /dev/null`,
    "else",
    // No pty, so no tty on line 1 — but the pid on line 2 still has to be there,
    // or a line-mode session is the one thing cleanup cannot end.
    `  printf '\\n%s\\n' "$$" > "$M" 2>/dev/null`,
    `  printf '%s\\n' '(line mode: this image has no script, so job control and full-screen'`,
    `  printf '%s\\n' ' programs are unavailable. Alpine: apk add util-linux. Debian: already there.'`,
    `  printf '%s\\n' ' Or point SANDBOXOS_CELL_IMAGE at an image that has it.)'`,
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
