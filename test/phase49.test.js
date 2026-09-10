// Phase 49: nothing outlives the Gateway that started it.
//
// Phase 48 made the in-Cell kill synchronous, so the shutdown handler really
// reaches inside a container before the process exits. It was verified against
// the live deployment and the job survived anyway. The reason turned out to be
// worth writing down, because it is not a bug in the handler:
//
//   The PaaS this project is deployed on stops a service by sending SIGTERM to
//   the process group and then, in the very next statement, SIGKILL to the same
//   group. The handler is entered and killed about a microsecond later. A direct
//   SIGTERM to the Gateway reaps correctly; a restart through the supervisor
//   reaps nothing, every time.
//
// That is not a thing to work around — it is a thing to stop depending on. A
// shutdown handler is a courtesy the machine is not obliged to extend: SIGKILL
// runs none, and neither does a host reboot, an OOM kill, or a power cut. Any
// design where the only cleanup happens on the way out has a hole in it that no
// amount of care on the way out can close.
//
// So the rule moved to the other end. A Cell outlives its Gateway on purpose —
// the container is stopped only on hibernate — which makes adoption the moment
// when a total statement is available for free: *anything running in here was
// started by a Gateway that is gone.* Not a heuristic about ports or process
// names. A fact about who is alive.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { BOOT_ID, bootEnv, reapScript } from "../packages/cell/src/orphans.js";
import { ptyWrapper, cleanupScript } from "../packages/cell/src/pty.js";

const read = (rel) => readSource(new URL(rel, import.meta.url));
const REMOTE = ["docker-backend.js", "hardened-docker-backend.js", "firecracker-backend.js"];

// ── the stamp ──────────────────────────────────────────────────────────────

test("a Gateway boot has an identity, and it is new every time", async () => {
  assert.match(BOOT_ID, /^[0-9a-f]{16}$/, "hex, so it can be pasted into a shell script unquoted");
  assert.deepEqual(bootEnv(), { SANDBOXOS_BOOT: BOOT_ID });

  // Re-importing gives the same one — it identifies the process, not the call.
  const again = await import("../packages/cell/src/orphans.js");
  assert.equal(again.BOOT_ID, BOOT_ID);
});

test("every command a backend runs in a Cell carries the stamp", () => {
  for (const f of REMOTE) {
    const src = read(`../packages/cell/src/${f}`);
    assert.match(src, /import \{[^}]*bootEnv[^}]*\} from "\.\/orphans\.js"/, `${f} imports it`);
    // exec, execStream and execInteractive — a job the reaper cannot see is a
    // job that becomes immortal, so there is no path that may skip this.
    const stamped = src.match(/\{ \.\.\.bootEnv\(\), \.\.\.env/g) ?? [];
    assert.ok(stamped.length >= 2, `${f} stamps its exec paths (found ${stamped.length})`);
  }
});

test("the Sandbox cannot unset the stamp by naming the variable itself", () => {
  for (const f of REMOTE) {
    const src = read(`../packages/cell/src/${f}`);
    // bootEnv() spreads *first*, so a caller's env would win — which is exactly
    // backwards. Assert the order that cannot be overridden into invisibility.
    assert.doesNotMatch(src, /\{ \.\.\.env, \.\.\.bootEnv\(\)/,
      `${f} must spread bootEnv() before env, not after`);
  }
});

// ── the reaper ─────────────────────────────────────────────────────────────

test("the reap script kills other boots and leaves everything else alone", () => {
  const s = reapScript("aaaabbbbccccdddd");
  assert.match(s, /me=aaaabbbbccccdddd/);
  // Ours is skipped by value, not by absence.
  assert.match(s, /\[ "\$\(boot_of "\$q"\)" = "\$me" \] && return 0/);
  // No stamp at all means not ours to kill: the container's own init, or
  // something a person started by hand in a shell we do not own.
  assert.match(s, /\[ -n "\$\(boot_of "\$q"\)" \] && claim "\$q"/);
  // The group holds the port, so the group goes first.
  assert.match(s, /kill -TERM -"\$q".*kill -TERM "\$q"/);
  assert.match(s, /kill -KILL -"\$q".*kill -KILL "\$q"/);
  // Grace, then insistence.
  assert.ok(s.indexOf("kill -TERM") < s.indexOf("sleep 1"), "TERM comes before the wait");
  assert.ok(s.indexOf("sleep 1") < s.indexOf("kill -KILL"), "and KILL after it");
});

test("the reap script is POSIX sh, because the image is the user's choice", () => {
  const s = reapScript(BOOT_ID);
  assert.doesNotMatch(s, /\[\[|\bfunction \w+\(|\$\(\(|\blocal\b|\bpkill\b|\bpgrep\b/,
    "no bashisms and no tools a slim image may not carry");
  // environ is NUL-separated; sed alone reads it as one line.
  assert.match(s, /tr "\\0" "\\n" < "\/proc\/\$1\/environ"/);
  // A process can exit between the glob and the read, and then it is the *shell*
  // that fails to open the redirect — so the group is silenced, not just `tr`.
  assert.match(s, /\{ tr .* \} 2>\/dev\/null/);
});

test("a boot id is never interpolated into the script unsanitised", () => {
  // The boot id goes into a shell script unquoted, so the filter has to be a
  // whitelist rather than an escape: what survives is hex and only hex, whatever
  // was handed in. (Hex letters scattered through an injection do survive — the
  // `f` of `rf` below — which is fine, because a hex string is inert.)
  const s = reapScript('abc"; rm -rf /; #');
  assert.match(s, /^me=[0-9a-f]*; victims=$/m, "the assignment is hex and nothing else");
  assert.doesNotMatch(s, /rm -rf/, "and the rest of the injection is gone, not quoted");
  for (const hostile of ["$(id)", "`id`", "a b", "a\nkill -9 -1", ";reboot"]) {
    const line = reapScript(hostile).split("\n")[0];
    assert.match(line, /^me=[0-9a-f]*; victims=$/, `no shell survives \`${hostile}\``);
  }
});

test("the marker files are swept too, so a Cell older than the stamp still empties", () => {
  const s = reapScript(BOOT_ID);
  // /tmp/.sbx-* is written by nothing but this project, so a live pid named by
  // one is ours by provenance even when it carries no boot id — which is the
  // case for everything already running when this shipped.
  assert.match(s, /for f in \/tmp\/\.sbx-\*\.pid; do .*claim "\$\(head -n1 "\$f"/);
  assert.match(s, /for f in \/tmp\/\.sbx-tty-\*; do .*claim "\$\(sed -n 2p "\$f"/);
  // …and the environment check still runs on those pids, so a marker whose
  // number has since been reused by a job of *this* boot is not killed on the
  // strength of a stale file.
  assert.ok(s.indexOf("claim() {") < s.indexOf("/tmp/.sbx-"), "both sweeps go through claim()");
  // Stale files name pids that are free to be reused; a later kill aimed at one
  // would hit a stranger.
  assert.match(s, /rm -f \/tmp\/\.sbx-\*\.pid \/tmp\/\.sbx-tty-\*/);
});

test("a pid is claimed once, is a number, and is never the reaper itself", () => {
  const s = reapScript(BOOT_ID);
  assert.match(s, /case "\$q" in "" \| \*\[!0-9\]\*\) return 0;; esac/, "a marker file can hold anything");
  assert.match(s, /\[ "\$q" = "\$\$" \] && return 0/);
  assert.match(s, /\[ -d "\/proc\/\$q" \] \|\| return 0/, "and it has to still exist");
  assert.match(s, /case " \$victims " in \*" \$q "\*\) return 0;; esac/, "both sweeps can name the same pid");
});

// ── where it runs ──────────────────────────────────────────────────────────

test("adoption reaps; creating a Cell does not, and neither does resuming one", () => {
  for (const f of ["docker-backend.js", "hardened-docker-backend.js"]) {
    const src = read(`../packages/cell/src/${f}`);
    assert.match(src, /if \(state === "running"\) return \{ state: "running", reaped: await this\._reap\(\) \};/,
      `${f} reaps exactly when it finds a Cell already up`);
    assert.match(src, /if \(this\._reaped\) return 0;\s*\n\s*this\._reaped = true;/,
      `${f} reaps once per Gateway boot, not once per exec`);
  }
  // A container that was stopped had everything in it killed by `docker stop`,
  // so the resume path has nothing to do and should not pay for a sweep.
  const docker = read("../packages/cell/src/docker-backend.js");
  assert.match(docker, /is empty by construction and there is nothing to reap/);
});

test("a microVM inherits the same rule, because it survives the same way", () => {
  const fc = read("../packages/cell/src/firecracker-backend.js");
  assert.match(fc, /return \{ state: "running", reaped: await this\._reap\(\) \};/,
    "an adopted VM is adopted, whatever the substrate");
  // An assignment prefixed to `cd` is not exported, so the interactive shell has
  // to be told in as many words or an abandoned terminal is invisible.
  assert.match(fc, /export SANDBOXOS_BOOT=\$\{BOOT_ID\}/);
});

test("a Cell that cannot run a shell is not a boot failure", () => {
  const src = read("../packages/cell/src/orphans.js");
  assert.match(src, /try \{ r = await run\(reapScript\(BOOT_ID\)\); \} catch \{ return 0; \}/,
    "refusing to boot over a failed cleanup turns tidying into an outage");
});

// ── the terminal had the same hole ─────────────────────────────────────────

test("closing a terminal ends the shell inside the Cell", () => {
  // cleanupScript has always signalled the pid on line 2 of the marker file.
  // Nothing ever wrote line 2, so `sed -n 2p` returned nothing, the kill was a
  // no-op, and every closed terminal left a live shell in the container.
  assert.match(cleanupScript("abc"), /sed -n 2p/);
  const w = ptyWrapper("/bin/sh -i");
  assert.match(w, /echo \$\$ >> \\"\$M\\"/, "the pty branch records it");
  assert.match(w, /printf '\\n%s\\n' "\$\$" > "\$M"/, "and so does line mode, with an empty tty line first");
});

test("there are two programs called script, and the wrapper knows which it has", () => {
  // util-linux: script -qfc "<command>" <file>
  // BSD:        script -q <file> <command> [args…]
  //
  // Emitting only the first is not a pty that fails to allocate — it is a
  // `script` that prints its usage and exits, so the shell never starts. Every
  // Terminal on a Mac died at birth with "script -p [-deq]…" where a prompt
  // should have been, and CI's macOS leg had been red for it.
  const w = ptyWrapper("/bin/sh -i");
  assert.match(w, /if script -qfc true \/dev\/null >\/dev\/null 2>&1; then/,
    "the probe is the command itself, which is the only thing that answers this");
  assert.match(w, /exec script -qfc ".*" \/dev\/null/, "util-linux form");
  assert.match(w, /exec script -q \/dev\/null \/bin\/sh -c ".*"/, "BSD form: file first, command as argv");
  // Both branches record the tty and the pid, or cleanup works on one platform.
  for (const branch of w.split("\n").filter((l) => l.includes("exec script "))) {
    assert.match(branch, /tty > \\"\$M\\"/, branch);
    assert.match(branch, /echo \$\$ >> \\"\$M\\"/, branch);
  }
});

test("the recorded pid is the one that takes the session down", () => {
  const w = ptyWrapper("/bin/sh -i");
  // `$$` inside the argument to `script -qfc` is expanded by *this* shell before
  // it is replaced, so the number is the shell docker/ssh started: the process
  // group leader. Recording the inner shell's pid instead would kill the shell
  // and leave `script` holding the pty.
  const inner = w.match(/exec script -qfc "(.*)" \/dev\/null/)?.[1];
  assert.ok(inner, "the script branch is still shaped like this");
  assert.match(inner, /echo \$\$ >>/);
  assert.doesNotMatch(inner, /\\\$\\\$/, "not escaped, or it would be the pty's own shell");
  assert.ok(inner.indexOf("tty >") < inner.indexOf("echo $$"), "tty is line 1, pid is line 2");
});

// ── pid 1 ──────────────────────────────────────────────────────────────────

test("a Cell has a pid 1 that reaps its zombies", () => {
  for (const f of ["docker-backend.js", "hardened-docker-backend.js"]) {
    const src = read(`../packages/cell/src/${f}`);
    assert.match(src, /"--init",/, `${f} runs the container under an init`);
    assert.match(src, /tail -f \/dev\/null. is a fine way to keep a container alive and a poor/,
      `${f} says why, since the flag looks optional`);
  }
});
