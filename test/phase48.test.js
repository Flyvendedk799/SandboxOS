// Phase 48: what the image is, and what it has in it.
//
// A live Docker deployment showed two things at once: a Terminal saying it had
// no pseudo-terminal, and a Browser saying nothing was listening. Neither was a
// stale build — both were this project's own defaults and probes being wrong
// about the container they were running in.
//
//   · `alpine:latest` was the default cell image. It has no `script`, so every
//     Terminal ran in line mode; no Node and no Python, so nothing could serve a
//     folder. Eight megabytes bought a machine that could not do the two things
//     people open a machine to do.
//   · Changing `SANDBOXOS_CELL_IMAGE` did nothing, because an existing container
//     was reused whatever it had been built from.
//   · `pkg` hardcoded `apk`, so on any other image its first call died with
//     "cannot read properties of undefined".
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import config from "../packages/config/src/config.js";
import { ptyWrapper } from "../packages/cell/src/pty.js";
import { pkgServer } from "../packages/kernel/src/servers/pkg.js";

const read = (rel) => readSource(new URL(rel, import.meta.url));

// ── the default image can be a machine ─────────────────────────────────────

test("the default cell image is one that has a pty and a runtime", () => {
  assert.equal(config.cellImage, "node:22-slim");
  // Debian, so `script` comes from bsdutils (Essential) — and Node is there for
  // a dev server and for the page first run puts up.
  const cfg = read("../packages/config/src/config.js");
  assert.match(cfg, /alpine:latest.*was the default for a long time and it is the wrong one/s,
    "and the comment says why it changed, since somebody will wonder");
  assert.match(cfg, /SANDBOXOS_CELL_IMAGE/, "the env var is still how you choose otherwise");
});

test("there is a small image for people who would rather have the megabytes", () => {
  const df = read("../docker/cell.Dockerfile");
  assert.match(df, /FROM alpine/);
  assert.match(df, /util-linux/, "which is where Alpine keeps script");
  assert.match(df, /nodejs/);
  assert.match(df, /SANDBOXOS_CELL_IMAGE=/, "with the line that puts it to use");
});

test("the terminal's fallback names the fix rather than the symptom", () => {
  const wrapper = ptyWrapper("/bin/sh -i", "/tmp");
  assert.match(wrapper, /command -v script/, "it asks the shell, not the image's name");
  assert.match(wrapper, /apk add util-linux/, "Alpine's answer");
  assert.match(wrapper, /Debian: already there/);
  assert.match(wrapper, /SANDBOXOS_CELL_IMAGE/, "and the way out of the question entirely");
  // The comment that sent everyone down the wrong path is gone.
  const pty = read("../packages/cell/src/pty.js");
  assert.equal(/every busybox image ships/.test(pty), false);
  assert.match(pty, /busybox is built without the .script. applet/, "and the truth is written down");
});

// ── a cell notices when its image changed ──────────────────────────────────

test("a container built from another image is rebuilt, not reused", () => {
  const backend = read("../packages/cell/src/docker-backend.js");
  assert.match(backend, /async _image\(\)/, "it can say what a container was made from");
  assert.match(backend, /\{\{\.Config\.Image\}\}/);
  assert.match(backend, /if \(was && was !== config\.cellImage\)/, "and compares it to the setting");
  assert.match(backend, /docker\(\["rm", "-f", this\.container\]\)/, "then replaces it");
  assert.match(backend, /the volume is a bind mount and is the\s*\n\s*\/\/ part that must not be thrown away/,
    "the part that matters survives, and the comment says so");
  assert.match(backend, /recreated: \{ from, to: config\.cellImage \}/, "and the boot says it happened");
});

// ── pkg asks which package manager it is talking to ────────────────────────

/** A fake Cell that has the binaries you name and nothing else. */
const cellWith = (binaries) => {
  const ran = [];
  return {
    ran,
    async exec(cmd) {
      ran.push(cmd);
      const which = /^command -v (\S+)/.exec(cmd);
      if (which) return { stdout: "", stderr: "", code: binaries.includes(which[1]) ? 0 : 1 };
      return { stdout: "done", stderr: "", code: 0 };
    },
  };
};

test("the manager is whichever one this image actually has", async () => {
  for (const [bin, expected] of [["apk", "apk"], ["apt-get", "apt"], ["dnf", "dnf"]]) {
    const cell = cellWith([bin]);
    const r = await pkgServer({ cell }).tools.install.handler({}, { name: "curl" });
    assert.equal(r.manager, expected, `${bin} → ${expected}`);
    assert.ok(cell.ran.some((c) => c.includes("curl")), "and it installed with that manager's words");
  }
});

test("an image with no package manager says so instead of throwing at a shape", async () => {
  const cell = cellWith([]);
  await assert.rejects(
    () => pkgServer({ cell }).tools.install.handler({}, { name: "curl" }),
    (e) => {
      assert.match(e.message, /no package manager in this image/);
      assert.match(e.message, /apk, apt, dnf/, "it says what it looked for");
      assert.match(e.message, /SANDBOXOS_CELL_IMAGE/, "and what to do about it");
      // The old failure: `cmd` was undefined and this read
      // "Cannot read properties of undefined (reading 'install')".
      assert.equal(/undefined/.test(e.message), false);
      return true;
    },
  );
});

test("a manifest naming a manager this build does not know is a sentence", async () => {
  const cell = cellWith(["apk"]);
  const server = pkgServer({ cell, manifest: { servers: { pkg: { manager: "pacman" } } } });
  await assert.rejects(
    () => server.tools.list.handler({}, {}),
    (e) => {
      assert.match(e.message, /asks for the 'pacman' package manager/);
      assert.match(e.message, /it knows apk, apt, dnf/);
      return true;
    },
  );
});

test("apt is asked non-interactively, because nobody is there to answer", async () => {
  const cell = cellWith(["apt-get"]);
  await pkgServer({ cell }).tools.install.handler({}, { name: "util-linux" });
  const install = cell.ran.find((c) => c.includes("util-linux"));
  assert.match(install, /DEBIAN_FRONTEND=noninteractive/,
    "a package that stops to ask a question in a container nobody is watching is a hung job");
  assert.match(install, /--no-install-recommends/);
});

test("the manager is resolved once, not on every call", async () => {
  const cell = cellWith(["apk"]);
  const server = pkgServer({ cell });
  await server.tools.install.handler({}, { name: "a" });
  await server.tools.install.handler({}, { name: "b" });
  const probes = cell.ran.filter((c) => c.startsWith("command -v"));
  assert.equal(probes.length, 1, `asked once (${probes.length})`);
});

// ── where a welcome server binds ───────────────────────────────────────────
//
// A deployment showed the shape of this one whole: the page was written, the
// server was running, the port was exposed — and the page did not load, because
// the server had bound the *container's* loopback and the Gateway reaches a
// container by its IP. Running, exposed, unreachable: the hardest failure to
// read, because every part of it reports success.

test("the bind address is the other end of cell.endpoint()", async () => {
  const { firstRunBindHost } = await import("../packages/os/src/first-run.js");
  // The local Cell shares the host's loopback, and the Gateway connects there.
  assert.equal(firstRunBindHost("local"), "127.0.0.1");
  // A container is reached by its own IP, so loopback inside it is invisible.
  assert.equal(firstRunBindHost("docker"), "0.0.0.0");
  assert.equal(firstRunBindHost("hardened-docker"), "0.0.0.0");
  assert.equal(firstRunBindHost("firecracker"), "0.0.0.0");
  assert.equal(firstRunBindHost(undefined), "0.0.0.0", "an unknown backend is not assumed to be local");
});

test("every server it can start takes the address, not just the port", async () => {
  const { firstRunServer } = await import("../packages/os/src/first-run.js");
  const shell = (binaries, applets = ["httpd"]) => async (_s, _t, a) => {
    const cmd = String(a.cmd);
    const which = /^command -v (\S+)/.exec(cmd);
    if (which) return { ok: true, result: { code: binaries.includes(which[1]) ? 0 : 1 } };
    if (cmd.startsWith("busybox --list")) {
      const wanted = /grep -qx (\S+)/.exec(cmd)?.[1];
      return { ok: true, result: { code: binaries.includes("busybox") && applets.includes(wanted) ? 0 : 1 } };
    }
    return { ok: true, result: { code: 1 } };
  };

  const node = await firstRunServer(shell(["node"]));
  assert.equal(node.cmd(8080, "0.0.0.0"), "node welcome/serve.cjs 8080 0.0.0.0");
  const py = await firstRunServer(shell(["python3"]));
  assert.match(py.cmd(8080, "0.0.0.0"), /--bind 0\.0\.0\.0/);
  const bb = await firstRunServer(shell(["busybox"]));
  assert.match(bb.cmd(8080, "0.0.0.0"), /-p 0\.0\.0\.0:8080/);
  const hd = await firstRunServer(shell(["httpd"]));
  assert.match(hd.cmd(8080, "127.0.0.1"), /-p 127\.0\.0\.1:8080/);

  // Every one of them, on a local Cell, keeps to loopback rather than the LAN.
  for (const bins of [["node"], ["python3"], ["busybox"], ["httpd"]]) {
    const s = await firstRunServer(shell(bins));
    assert.match(s.cmd(8080, "127.0.0.1"), /127\.0\.0\.1/, `${bins[0]} binds what it is told`);
    assert.equal(/0\.0\.0\.0/.test(s.cmd(8080, "127.0.0.1")), false);
  }
});

test("the node server binds what it is given and says where it listened", async () => {
  const { firstRunServeJs } = await import("../packages/os/src/first-run.js");
  const src = firstRunServeJs();
  assert.match(src, /const host = process\.argv\[3\] \|\| '127\.0\.0\.1';/,
    "the address is an argument, and the safe one is the default");
  assert.match(src, /\.listen\(port, host,/);
  assert.equal(/listen\(port, '127\.0\.0\.1'/.test(src), false, "not hardcoded any more");
  assert.match(src, /welcome on ' \+ host \+ ':' \+ port/, "and the log says which address it got");
});

test("setup asks the Cell where to bind rather than assuming", () => {
  const desktop = readSource(new URL("../packages/kernel/src/servers/desktop.js", import.meta.url));
  assert.match(desktop, /const bind = firstRunBindHost\(kernel\?\.cell\?\.backend \?\? "local"\);/);
  assert.match(desktop, /found\.cmd\(port, bind\)/);
});

test("a job that died reports the line that says why, not the last line printed", () => {
  const desktop = readSource(new URL("../packages/kernel/src/servers/desktop.js", import.meta.url));
  assert.match(desktop, /said\.find\(\(t\) => \/error\|EADDRINUSE\|EACCES\|not found\|denied\|refused\/i\.test\(t\)\)/);
  // The failure that prompted this reported "Node.js v22.23.2" as the reason a
  // server could not start, which is Node's sign-off line after a stack.
  assert.match(desktop, /a crashed Node process signs off with its own version/);
});

// ── stopping something inside a Cell we reach indirectly ───────────────────
//
// A Docker deployment restarted its Gateway and the dev server inside the
// container carried on, holding its port, with nothing left running that knew it
// existed. `stopAllProcs` had "stopped" it: the kill was a promise, the shutdown
// path called it and then `process.exit`, and the `docker exec` never left the
// starting line. The same mistake killTree made on Windows, in another file.

test("an in-Cell kill happens before the call returns, when it can", async () => {
  const { remoteHandle } = await import("../packages/cell/src/handles.js");
  const order = [];
  const client = { pid: 1234, kill: () => order.push("client") };

  const sync = remoteHandle(client, "abc", () => { order.push("async"); return Promise.resolve(); }, {
    runInCellSync: (script) => { order.push(`sync:${/kill -KILL/.test(script) ? "KILL" : "TERM"}`); },
  });
  assert.equal(sync.kill("SIGKILL"), true);
  assert.deepEqual(order, ["sync:KILL", "client"],
    "the process inside the Cell dies first, and it has already died by the time this returns");

  // The signal reaches the script, not just the fact of a kill.
  order.length = 0;
  sync.kill();
  assert.deepEqual(order, ["sync:TERM", "client"]);
});

test("a backend with no synchronous path still kills, asynchronously", async () => {
  const { remoteHandle } = await import("../packages/cell/src/handles.js");
  let asked = null;
  const h = remoteHandle({ pid: 1, kill: () => {} }, "xyz", (script) => { asked = script; return Promise.resolve(); });
  h.kill("SIGTERM");
  assert.match(asked, /kill -TERM/, "the old path is still there for anything that cannot offer a sync one");
  assert.match(asked, /\.xyz\.pid|xyz/, "aimed at the pid the in-Cell shell recorded");
});

test("every backend that reaches a Cell indirectly offers the synchronous path", () => {
  for (const f of ["docker-backend.js", "hardened-docker-backend.js", "firecracker-backend.js"]) {
    const src = readSource(new URL(`../packages/cell/src/${f}`, import.meta.url));
    assert.match(src, /remoteHandle\(proc, marker,/, `${f} builds a remote handle`);
    assert.match(src, /runInCellSync:/, `${f} gives it a synchronous killer`);
    assert.match(src, /spawnSync/, `${f} imports one`);
  }
});

test("the shutdown path is the reason this has to be synchronous", () => {
  const index = readSource(new URL("../apps/gateway/src/index.js", import.meta.url));
  // stopAllProcs is called and then the process exits. Anything the kill left
  // for later does not happen.
  assert.match(index, /const procs = stopAllProcsEverywhere\(\);/);
  assert.match(index, /if \(signal\) process\.exit\(0\);/);
  const handles = readSource(new URL("../packages/cell/src/handles.js", import.meta.url));
  assert.match(handles, /the exec never left the starting line/);
});
