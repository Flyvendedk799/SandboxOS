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
