// Phase 39: ten minutes to useful.
//
// T5.1 of goal.md. A machine nobody has set up says so, gets set up once, and
// what setup leaves behind is a machine *doing work* — a folder of ordinary
// files, served by a supervised job, at an address under its own slug — with
// every step reported, including the ones this host could not do.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { stopAllProcsEverywhere } from "../packages/kernel/src/servers/proc.js";
import { normalizeDoc } from "../packages/os/src/schema.js";
import {
  firstRunFiles, firstRunServer, firstRunPort, firstRunServeJs, FIRST_RUN_PORTS,
} from "../packages/os/src/first-run.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };
const doc = async () => (await ok("desktop", "state", {})).doc;
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => { stopAllProcsEverywhere(); _resetKernels(); closeDb(); });

// ── the document knows whether it has been set up ──────────────────────────

test("a machine that has never been set up says so, in the document", async () => {
  const d = await doc();
  assert.deepEqual(d.setup, { done: false, seed: null, at: null });
  // Not a browser flag: "have I set this machine up" is a fact about the
  // machine, so a second tab and a phone agree about it.
  const older = normalizeDoc({ name: "from before this field existed" });
  assert.equal(older.setup.done, false, "a document that predates the field is treated as unset");
  const hostile = normalizeDoc({ setup: { done: "yes", seed: 42, at: "now" } });
  assert.equal(hostile.setup.done, false, "and a hostile value cannot fake it");
  assert.equal(hostile.setup.seed, null);
});

test("the seeds are offered before anything is chosen", async () => {
  const r = await ok("desktop", "setupSeeds", {});
  assert.ok(r.seeds.length >= 4, `enough to choose from (${r.seeds.length})`);
  assert.ok(r.seeds.every((s) => s.id && s.name && s.description), "each says what it is");
  assert.equal(r.setup.done, false, "and it reports where this machine stands");
});

test("skipping is a real answer, and changes nothing else", async () => {
  const before = await doc();
  const r = await ok("desktop", "setup", { skip: true });
  assert.equal(r.skipped, true);
  const after = await doc();
  assert.equal(after.setup.done, true, "the machine is set up");
  assert.equal(after.setup.seed, null, "from no seed");
  assert.equal(after.windows.length, before.windows.length, "and nothing was opened");
  assert.equal((await call("fs", "list", { path: "welcome" })).ok, false, "nor written");
});

// ── setting it up leaves a machine doing work ──────────────────────────────

test("setup adopts a seed, writes a project, serves it, and opens it", async () => {
  const r = await ok("desktop", "setup", { seed: "minimal" });
  assert.equal(r.seed, "minimal");
  assert.ok(r.steps.length >= 2, "it reports its steps");
  assert.ok(r.steps.every((s) => typeof s.what === "string" && typeof s.ok === "boolean"), "each one saying what and whether");
  for (const s of r.steps) if (!s.ok) assert.ok(s.why, `a step that failed says why: ${s.what}`);

  const d = await doc();
  assert.equal(d.setup.done, true);
  assert.equal(d.setup.seed, "minimal");
  assert.ok(d.setup.at > 0, "and when");

  // The project is ordinary files, in the volume, not a fixture anywhere.
  const listing = await ok("fs", "list", { path: "welcome" });
  assert.deepEqual(
    listing.entries.map((e) => e.name).sort(),
    ["index.html", "serve.cjs", "style.css"],
    "a page, its style, and the server that serves it",
  );
  const page = await ok("fs", "read", { path: "welcome/index.html" });
  assert.match(page.content, /welcome\//, "the page tells you where it lives");
  const note = await ok("fs", "read", { path: "notes/first-day.md" });
  assert.match(note.content, /desktop is a document/i, "and the note explains the one idea");

  // The window it opens is the Manual, plus the Browser when a server started.
  assert.ok(d.windows.some((w) => w.app === "help"), "the Manual is open");
  if (r.port) {
    assert.ok(d.windows.some((w) => w.app === "browser" && w.props.port === r.port), "and the Browser points at the served page");
    const job = (await ok("proc", "jobs", {})).jobs.find((j) => j.name === "welcome");
    assert.equal(job?.state, "running", "the server is a supervised job, still running");
    const exposed = (await ok("ports", "list", {})).ports.find((p) => Number(p.port) === r.port);
    assert.ok(exposed, "and its port is exposed under the slug");
    assert.equal(r.url, `/${sandbox.slug}/p/${r.port}/`);
  } else {
    // A host with nothing that can serve a folder is a supported host. It has to
    // say so rather than leave a spinner.
    const serving = r.steps.find((s) => /serve the project/.test(s.what));
    assert.equal(serving.ok, false);
    assert.ok(serving.why, "and says what it could not do");
  }
});

test("a second setup is not a second first run", async () => {
  const d = await doc();
  assert.equal(d.setup.done, true);
  // Nothing stops you calling it again — it is your machine — but the reset path
  // is what a person actually reaches for, and that keeps the fact.
  await ok("desktop", "reset", {});
  const after = await doc();
  assert.equal(after.setup.done, true, "clearing the desktop does not make you a new user again");
  assert.equal(after.windows.length > 0, true, "and the seed's windows come back");
});

test("an unknown seed is refused by name, with the ones that exist", async () => {
  const r = await call("desktop", "setup", { seed: "not-a-seed" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such seed: not-a-seed/);
  assert.match(r.error, /dev/, "and lists what there is");
});

// ── the pieces, on their own ───────────────────────────────────────────────

test("the welcome project is files, and the server is one of them", () => {
  const files = firstRunFiles("demo-box", { name: "Developer Box" });
  assert.deepEqual(Object.keys(files).sort(), ["notes/first-day.md", "welcome/index.html", "welcome/serve.cjs", "welcome/style.css"]);
  assert.match(files["welcome/index.html"], /demo-box/, "the page wears the machine's name");
  assert.match(files["notes/first-day.md"], /Developer Box/, "the note remembers the seed");
  // .cjs on purpose: a volume under a package.json with "type": "module" would
  // otherwise turn require() into an error nobody asked for.
  assert.match(files["welcome/serve.cjs"], /require\('node:http'\)/);
  assert.match(firstRunServeJs(), /if \(!file\.startsWith\(root\)\)/, "and it will not serve outside its folder");
  // A machine named with markup cannot put markup in its own welcome page.
  const nasty = firstRunFiles("<script>alert(1)</script>", null);
  assert.equal(nasty["welcome/index.html"].includes("<script>alert"), false);
});

/**
 * A shell that answers the way a real one would.
 *
 * The previous version of this fake returned 0 for any command that *started
 * with* the name of a binary the image was supposed to have — which is not how
 * any of these commands behave, and is why it passed while first run was silently
 * broken on Alpine. `busybox --help` prints the applet list and exits **1**; the
 * probe read that as "no busybox", concluded the image had nothing that could
 * serve a folder, and left a freshly set-up machine with nothing listening.
 *
 * So this one models the actual contracts: `command -v X` succeeds iff X is on
 * the path, `busybox --list` prints the applets it was built with and exits 0,
 * and `busybox --help` exits 1 whatever is installed.
 */
const shellWith = (binaries, { busyboxApplets = ["sh", "httpd", "wget"] } = {}) => {
  const asked = [];
  const run = async (_server, _tool, args) => {
    const cmd = String(args.cmd);
    asked.push(cmd);
    const ok = (stdout = "") => ({ ok: true, result: { code: 0, stdout, stderr: "" } });
    const no = () => ({ ok: true, result: { code: 1, stdout: "", stderr: "" } });

    const which = /^command -v (\S+)/.exec(cmd);
    if (which) return binaries.includes(which[1]) ? ok(`/usr/bin/${which[1]}`) : no();
    if (cmd.startsWith("busybox --list")) {
      if (!binaries.includes("busybox")) return no();
      // The pipeline's exit code is grep's: does the list contain that applet?
      const wanted = /grep -qx (\S+)/.exec(cmd)?.[1];
      return busyboxApplets.includes(wanted) ? ok() : no();
    }
    if (cmd.startsWith("busybox --help")) return no();   // whatever is installed
    return no();
  };
  run.asked = asked;
  return run;
};

test("the server is chosen by asking the host, not by assuming", async () => {
  const node = shellWith(["node", "sh"]);
  assert.equal((await firstRunServer(node)).label, "node");
  assert.ok(node.asked.length >= 1, "it actually asked");
  assert.equal((await firstRunServer(shellWith(["python3", "sh"]))).label, "python3");
  assert.equal((await firstRunServer(shellWith(["python", "sh"]))).label, "python");

  // Alpine: busybox is there, and `--help` exits 1. This is the case that was
  // broken, on the default image, for every Docker deployment.
  const alpine = shellWith(["busybox", "sh"]);
  assert.equal((await firstRunServer(alpine)).label, "busybox httpd");
  assert.ok(alpine.asked.some((c) => c.startsWith("busybox --list")),
    "it asks which applets this busybox was built with, not whether busybox can print a usage message");

  // A busybox built without httpd is not a server, and saying so is the point.
  const noHttpd = shellWith(["busybox", "sh"], { busyboxApplets: ["sh", "wget"] });
  assert.equal((await firstRunServer(noHttpd)).cmd, null);

  // A standalone httpd (Debian, BSD) counts too.
  assert.equal((await firstRunServer(shellWith(["httpd", "sh"]))).label, "httpd");

  // An image with none of them: named, not guessed at.
  const none = await firstRunServer(shellWith(["sh"]));
  assert.equal(none.cmd, null);
  assert.match(none.why, /this image has none of: node, python3, python, busybox httpd, httpd/);

  // A Cell that cannot run anything at all stops after the first question.
  const dead = await firstRunServer(async () => ({ ok: false, error: "no shell on this host" }));
  assert.equal(dead.cmd, null);
  assert.match(dead.why, /nothing can run in this Cell: no shell on this host/);
});

test("a port is picked because nothing answered on it", async () => {
  const upOn = (busy) => async (_s, _t, args) => ({ ok: true, result: { port: args.port, up: busy.includes(args.port) } });
  assert.equal(await firstRunPort(upOn([])), FIRST_RUN_PORTS[0]);
  assert.equal(await firstRunPort(upOn([8080])), FIRST_RUN_PORTS[1]);
  // Every friendly number taken is an ordinary developer machine: go quieter
  // rather than hand back a port the server would die on.
  const busyEverywhere = await firstRunPort(upOn([...FIRST_RUN_PORTS]));
  assert.ok(busyEverywhere === null || (busyEverywhere >= 8200 && busyEverywhere < 8900), `somewhere else, or nothing (${busyEverywhere})`);
  const allBusy = await firstRunPort(async () => ({ ok: true, result: { up: true } }));
  assert.equal(allBusy, null, "and when everything is busy it says none rather than lying");
  // A Cell that cannot probe cannot tell us anything: take the port and let the
  // server's own failure be the reading.
  assert.equal(await firstRunPort(async () => ({ ok: false, error: "cannot probe" })), FIRST_RUN_PORTS[0]);
});

// ── the screen, and the one thing it must not do ───────────────────────────

test("the welcome screen prints what happened rather than a tick", () => {
  const fr = read("../apps/gateway/public/js/os/first-run.js");
  assert.match(fr, /\(r\.steps \?\? \[\]\)\.map/, "it renders the steps the tool reported");
  assert.match(fr, /st\.why \? h\("span\.fr-why"/, "including why one did not happen");
  assert.match(fr, /Take me to the desktop anyway/, "and a partial setup is not a wall");
  assert.match(fr, /skip: true/, "skipping is offered");
});

test("the desktop does not paint behind the welcome screen", () => {
  const boot = read("../apps/gateway/public/js/os/os.js");
  const after = boot.split("if (needsFirstRun(os.doc))")[1] ?? "";
  assert.match(after, /onOs\(\(\) => screen\.render\(\)\)/, "the render subscription starts after first run");
  const before = boot.split("if (needsFirstRun(os.doc))")[0];
  assert.equal(/onOs\(\(\) => screen\.render\(\)\)/.test(before), false,
    "because mounting the seed's apps under the panel makes them write against a document about to be replaced");
});

test("stopping something means it is stopped when the call returns", () => {
  const spawn = read("../packages/cell/src/spawn.js");
  assert.match(spawn, /spawnSync\("taskkill"/, "the Windows kill is synchronous");
  assert.match(spawn, /import \{ spawn, spawnSync, execFile \}/);
  // An asynchronous taskkill plus process.exit left dev servers holding ports.
  assert.match(spawn, /Handing the kill\n    \/\/ to a detached process and then exiting left dev servers holding their/);
});
