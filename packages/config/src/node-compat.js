// What this codebase needs from the Node it is running on, and where the line is.
//
// The floor used to be Node 24 for one reason: `node:sqlite`. It is worth being
// precise about that reason, because "requires Node 24" turned out to be a good
// deal stricter than the truth and sent anyone on an LTS 22 away at the door.
//
//   22.5.0   node:sqlite lands, behind --experimental-sqlite. Importing it
//            without the flag throws ERR_UNKNOWN_BUILTIN_MODULE at module load —
//            i.e. before any of our code runs, as an error naming a module the
//            reader never typed.
//   22.13.0  the flag requirement goes away on the 22 LTS line. Everything the
//            control plane does works from here with no flags at all.
//
// So 22.13 is the floor, not 24. Nothing else in the tree needs anything newer:
// the whole spine is Node built-ins, and the suite passes on 22 unchanged.

/** The oldest Node this runs on unassisted. See the note above for why this number. */
export const MIN_NODE = "22.13.0";

/** [major, minor, patch] of a version string, missing parts read as 0. */
function parts(version) {
  return String(version).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/** True when `version` is at least `minimum`. Plain numeric compare, no semver dep. */
export function atLeast(version, minimum = MIN_NODE) {
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/**
 * Node's SQLite is still marked experimental, so every boot prints a warning about
 * a choice the operator did not make and cannot act on. Drop that one line and
 * re-emit everything else.
 *
 * The removeAllListeners is load-bearing and is the part that is easy to get wrong:
 * adding a "warning" listener does NOT replace Node's own, so filtering by adding
 * one leaves the default printer in place and the line still appears. Node's
 * handler has to be taken off first, which is why the replacement below re-prints
 * everything it does not drop — a blanket --no-warnings would hide the warnings
 * that matter, which is the opposite of the goal.
 *
 * Idempotent: several entry points import this and only the first call installs.
 */
let filtered = false;
export function quietSqliteWarning() {
  if (filtered) return;
  filtered = true;
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message)) return;
    console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`);
    if (warning.stack) console.error(warning.stack.split("\n").slice(1).join("\n"));
  });
}

/**
 * Refuse to start on a Node that cannot run this, with a sentence that says what
 * to do about it. Called from the entry points rather than from a library module:
 * a process that is about to fail should say so at the top, once.
 */
export function assertSupportedNode(version = process.versions.node) {
  if (atLeast(version)) return;
  throw new Error(
    `SandboxOS needs Node ${MIN_NODE} or newer — this is Node ${version}.\n` +
    `  · Node 22.13+ or any 24/25 works with no flags.\n` +
    `  · On Node 22.5–22.12, start it with --experimental-sqlite.\n` +
    `  · Or set SANDBOXOS_DB_DRIVER=better-sqlite3 and install the optional dependency.`
  );
}
