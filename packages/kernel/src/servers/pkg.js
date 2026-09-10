// The `pkg` core MCP server — software install as tools.
//
// Phase 1 wraps the Cell image's package manager (Alpine `apk` by default). It is
// image-dependent by design; the interface (install/remove/list) is the stable
// contract, the backing command is swappable per distro. Names are validated to a
// safe charset before reaching the shell.

import { raiseFailure } from "../../../cell/src/shell.js";

const SAFE = /^[a-zA-Z0-9._+-]+$/;

/**
 * What each package manager calls the same three ideas.
 *
 * `apk` was hardcoded, and the manifest could name another one — at which point
 * `cmd` was `undefined` and the first install died with "cannot read properties
 * of undefined", which tells a caller nothing about their machine. Now the set is
 * real, and a manager nobody here knows is a sentence rather than a crash.
 */
const MANAGERS = {
  apk: {
    probe: "command -v apk",
    install: (n) => `apk add --no-cache ${n}`,
    remove: (n) => `apk del ${n}`,
    list: () => "apk info",
  },
  apt: {
    probe: "command -v apt-get",
    // Non-interactive on purpose: a package that stops to ask a question in a
    // container nobody is looking at is a hung job, not a prompt.
    install: (n) => `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends ${n}`,
    remove: (n) => `export DEBIAN_FRONTEND=noninteractive; apt-get remove -y ${n}`,
    list: () => "dpkg-query -W -f='${Package} ${Version}\\n'",
  },
  dnf: {
    probe: "command -v dnf",
    install: (n) => `dnf install -y ${n}`,
    remove: (n) => `dnf remove -y ${n}`,
    list: () => "dnf list --installed",
  },
};

export function pkgServer(deps) {
  const { cell } = deps;
  const named = deps.manifest?.servers?.pkg?.manager ?? null;

  /**
   * Which manager this Cell actually has. The manifest wins when it names one
   * this build knows; otherwise the image is asked, once, and the answer is
   * remembered. Asking beats assuming: the default image is Debian now, it used
   * to be Alpine, and a distro can be anything.
   */
  let resolved = named && MANAGERS[named] ? { name: named, ...MANAGERS[named] } : null;
  let asking = null;
  async function manager() {
    if (resolved) return resolved;
    if (named && !MANAGERS[named]) {
      throw new Error(`this machine's manifest asks for the '${named}' package manager, which this build does not know (it knows ${Object.keys(MANAGERS).join(", ")})`);
    }
    asking ??= (async () => {
      for (const [name, m] of Object.entries(MANAGERS)) {
        const r = await cell.exec(m.probe, { timeoutMs: 15_000 }).catch(() => null);
        if (r && r.code === 0) return { name, ...m };
      }
      return null;
    })().finally(() => { asking = null; });
    resolved = await asking;
    if (!resolved) {
      throw new Error(`no package manager in this image — looked for ${Object.keys(MANAGERS).join(", ")}. Install what you need in the image itself (SANDBOXOS_CELL_IMAGE), or pick one that has one.`);
    }
    return resolved;
  }

  return {
    name: "pkg",
    tools: {
      install: {
        description: "Install a package into the Sandbox.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) {
          if (!SAFE.test(a.name)) throw new Error(`invalid package name: ${a.name}`);
          const m = await manager();
          const r = raiseFailure(await cell.exec(m.install(a.name), { timeoutMs: 300_000 }), "install packages");
          return { name: a.name, manager: m.name, code: r.code, stdout: r.stdout, stderr: r.stderr };
        },
      },
      remove: {
        description: "Remove a package from the Sandbox.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) {
          if (!SAFE.test(a.name)) throw new Error(`invalid package name: ${a.name}`);
          const m = await manager();
          const r = raiseFailure(await cell.exec(m.remove(a.name), { timeoutMs: 120_000 }), "install packages");
          return { name: a.name, manager: m.name, code: r.code, stdout: r.stdout, stderr: r.stderr };
        },
      },
      list: {
        description: "List installed packages.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const m = await manager();
          const r = raiseFailure(await cell.exec(m.list(), { timeoutMs: 60_000 }), "install packages");
          return { manager: m.name, packages: r.stdout.split("\n").filter(Boolean) };
        },
      },
    },
  };
}
