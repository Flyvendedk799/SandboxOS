// The `mcp-registry` core MCP server — MCP managing MCP (docs/03).
//
// Enable/disable/configure built-in servers, and install/uninstall marketplace
// servers (Phase 7). Mutates the manifest and rebuilds the live Kernel so changes
// take effect immediately.

import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadManifest, saveManifest } from "../../../manifest/src/manifest.js";

const PROTECTED = new Set(["kernel", "mcp-registry"]); // disabling these would lock you out

// ── Backlog item #12: marketplace install provenance + allowlist (INTERIM) ──
// RESIDUAL RISK: install() still does an in-process dynamic import() of
// third-party code into the control plane, so a permitted package can run
// arbitrary host code. This is gated by holding mcp-registry.install and is
// the deferred Phase-1 concern; the proper fix is out-of-process server
// hosting (separate process / sandboxed worker), which is intentionally NOT
// attempted here. The hardening below only narrows the attack surface:
//   1. an install-source allowlist (refuse unexpected source schemes), and
//   2. recorded provenance (sha256 of the imported entry file) so installs are
//      auditable and a later integrity check can detect tampering.

// Sources we know how to handle today. When SANDBOXOS_MCP_ALLOWLIST is unset we
// fall back to permitting exactly these, so existing behavior/tests are intact.
const DEFAULT_ALLOWED_PREFIXES = ["npm:", "file:"];

/** Parse SANDBOXOS_MCP_ALLOWLIST (comma-separated prefixes). Empty/unset -> defaults. */
function allowedPrefixes() {
  const raw = process.env.SANDBOXOS_MCP_ALLOWLIST;
  if (raw == null || raw.trim() === "") return DEFAULT_ALLOWED_PREFIXES;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Throw unless `source` matches one of the configured allowed prefixes.
 *  A bare absolute path or a file:// URL is a local-FILE source and counts as
 *  the "file:" class (this is the original supported form — e.g. installing the
 *  example-server by path), so it passes whenever "file:" is allowed. */
function assertSourceAllowed(source) {
  const prefixes = allowedPrefixes();
  const isLocalFile = source.startsWith("file://") || source.startsWith("/") || source.startsWith("./");
  const ok = prefixes.some((p) => source.startsWith(p)) ||
             (isLocalFile && prefixes.includes("file:"));
  if (!ok) {
    throw new Error(
      `install source not permitted by SANDBOXOS_MCP_ALLOWLIST: ${source} ` +
      `(allowed prefixes: ${prefixes.join(", ")})`
    );
  }
}

/** sha256 of the resolved entry file referenced by a file:// URL; null if unreadable. */
function hashEntryFile(fileUrl) {
  try {
    const p = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

export function registryServer(deps) {
  const { sandbox, kernel } = deps;
  const available = deps.availableServers ?? [];

  return {
    name: "mcp-registry",
    tools: {
      list: {
        description: "List available, installed, and enabled MCP servers.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const m = loadManifest(sandbox);
          return {
            available,
            installed: Object.keys(m.installed ?? {}),
            enabled: Object.keys(m.servers ?? {}),
          };
        },
      },
      enable: {
        description: "Enable an MCP server in this Sandbox.",
        inputSchema: { type: "object", required: ["server"], properties: { server: { type: "string" }, config: { type: "object" } } },
        async handler(_ctx, a) {
          const m = loadManifest(sandbox);
          const isBuiltin = available.includes(a.server);
          const isInstalled = !!(m.installed ?? {})[a.server];
          if (!isBuiltin && !isInstalled) throw new Error(`unknown server: ${a.server}`);
          m.servers[a.server] = a.config ?? m.servers[a.server] ?? {};
          saveManifest(sandbox, m);
          kernel.rebuild();
          return { enabled: Object.keys(m.servers) };
        },
      },
      disable: {
        description: "Disable an MCP server in this Sandbox.",
        inputSchema: { type: "object", required: ["server"], properties: { server: { type: "string" } } },
        async handler(_ctx, a) {
          if (PROTECTED.has(a.server)) throw new Error(`cannot disable protected server: ${a.server}`);
          const m = loadManifest(sandbox);
          delete m.servers[a.server];
          saveManifest(sandbox, m);
          kernel.rebuild();
          return { enabled: Object.keys(m.servers) };
        },
      },
      configure: {
        description: "Merge config into an enabled server (e.g. net egress policy).",
        inputSchema: { type: "object", required: ["server", "config"], properties: { server: { type: "string" }, config: { type: "object" } } },
        async handler(_ctx, a) {
          const m = loadManifest(sandbox);
          if (!m.servers[a.server]) throw new Error(`server not enabled: ${a.server}`);
          m.servers[a.server] = { ...m.servers[a.server], ...a.config };
          saveManifest(sandbox, m);
          kernel.rebuild();
          return { server: a.server, config: m.servers[a.server] };
        },
      },
      install: {
        description: "Install a marketplace MCP server from a file path or npm package (npm:<package>). Auto-enables it.",
        inputSchema: {
          type: "object", required: ["name", "source"],
          properties: { name: { type: "string" }, source: { type: "string" } },
        },
        async handler(_ctx, a) {
          // Item #12: refuse install sources outside the configured allowlist
          // before we spawn npm or import anything (default-deny-flavored gate).
          assertSourceAllowed(a.source);
          let url;
          if (a.source.startsWith("npm:")) {
            // npm:<pkg-spec> — install via npm, then import the entry point.
            const pkg = a.source.slice(4);
            const installDir = path.join(sandbox.volume_path, ".mcp-packages");
            fs.mkdirSync(installDir, { recursive: true });
            await new Promise((res, rej) => {
              const proc = spawn("npm", ["install", "--prefix", installDir, pkg], { stdio: "pipe" });
              let errOut = "";
              proc.stderr.on("data", (d) => (errOut += d));
              proc.on("close", (code) => code === 0 ? res() : rej(new Error(`npm install failed: ${errOut.slice(0, 300)}`)));
            });
            // Derive the node_modules directory name for the installed package.
            let basePkg;
            if (pkg.startsWith("file:")) {
              // Local path install: directory name = "name" from the package's own package.json.
              const localPath = pkg.slice(5); // strip "file:" prefix
              const lpj = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf8"));
              basePkg = lpj.name;
            } else {
              // Registry install: strip version suffix, keep scope prefix.
              basePkg = pkg.startsWith("@")
                ? "@" + pkg.slice(1).split("@")[0]
                : pkg.split("@")[0];
            }
            const pkgDir = path.join(installDir, "node_modules", basePkg);
            let main = "index.js";
            try {
              const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
              const exp = pj.exports?.["."];
              main = (typeof exp === "string" ? exp : exp?.import ?? exp?.default) ?? pj.module ?? pj.main ?? "index.js";
            } catch {}
            url = pathToFileURL(path.join(pkgDir, String(main))).href;
          } else {
            url = a.source.startsWith("file://") ? a.source : pathToFileURL(a.source).href;
          }
          const mod = await import(url);
          const factory = mod.default ?? mod.createServer;
          if (!factory) throw new Error(`${a.source} has no default or createServer export`);
          kernel._marketplaceFactories.set(a.name, factory);
          const m = loadManifest(sandbox);
          if (!m.installed) m.installed = {};
          // Store the resolved file URL so the kernel can re-import on restart without npm.
          // NOTE: kept as a plain string URL on purpose — the kernel boot loop
          // (kernel.js) reads these values as string URLs. Provenance is recorded
          // in a parallel `installedMeta` map so the shape stays backward-compatible.
          m.installed[a.name] = url;
          // Item #12: record provenance for auditability + future integrity checks.
          // Additive field only; hash is sha256 of the entry file we just imported
          // (null if it couldn't be read — we still install).
          const resolvedPath = url.startsWith("file://") ? fileURLToPath(url) : url;
          if (!m.installedMeta) m.installedMeta = {};
          m.installedMeta[a.name] = {
            source: a.source,
            resolvedPath,
            hash: hashEntryFile(url),
            installedAt: new Date().toISOString(),
          };
          m.servers[a.name] = {};
          saveManifest(sandbox, m);
          kernel.rebuild();
          return { installed: a.name, source: a.source, enabled: Object.keys(m.servers) };
        },
      },
      uninstall: {
        description: "Uninstall a marketplace MCP server and disable it.",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        async handler(_ctx, a) {
          const m = loadManifest(sandbox);
          if (!(m.installed ?? {})[a.name]) throw new Error(`not installed: ${a.name}`);
          delete m.installed[a.name];
          if (m.installedMeta) delete m.installedMeta[a.name]; // item #12: drop provenance too
          delete m.servers[a.name];
          saveManifest(sandbox, m);
          kernel._marketplaceFactories.delete(a.name);
          kernel.rebuild();
          return { uninstalled: a.name, enabled: Object.keys(m.servers) };
        },
      },
    },
  };
}
