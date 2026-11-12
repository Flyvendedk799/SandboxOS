// Where the Braiwser runtime lives, whether it is there, and getting it there.
//
// SandboxOS does not vendor Braiwser: it pins one revision (../runtime.json) and
// installs that exact tree once per host, the way openbot does. The Gateway then
// drives Braiwser's own Playwright driver — the same code Braiwser's agent runtime
// uses — so the Browser app is Braiwser, not a look-alike.
//
// A new machine has no runtime yet. Rather than send its first Browser window to a
// README, the Gateway installs the pin in the background the first time anyone asks
// (SANDBOXOS_BRAIWSER_AUTOINSTALL=0 turns that off) and the window shows progress.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import config from "../../config/src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
export const pin = JSON.parse(fs.readFileSync(path.join(HERE, "..", "runtime.json"), "utf8"));

/** Receipts the installer writes; the revision one last, so it means "finished". */
export const RECEIPT_REVISION = "runtime-revision";
export const RECEIPT_BROWSER = "runtime-browser.json";

/** The runtime directory. BRAIWSER_RUNTIME_ROOT is openbot's name for the same thing,
 *  so one installed runtime can serve both on a shared host. */
export function defaultRuntimeRoot(env = process.env) {
  return path.resolve(env.SANDBOXOS_BRAIWSER_ROOT || env.BRAIWSER_RUNTIME_ROOT
    || path.join(config.home, "runtimes", `braiwser-${pin.revision}`));
}

/** Is the pinned runtime installed at `root`? Reads receipts only; starts nothing. */
export function inspectRuntime(root = defaultRuntimeRoot()) {
  let revision = null;
  try { revision = fs.readFileSync(path.join(root, RECEIPT_REVISION), "utf8").trim(); } catch {}
  if (!revision) return { ready: false, root, reason: "not-installed" };
  if (revision !== pin.revision) return { ready: false, root, reason: "wrong-revision", revision };
  let executablePath;
  try { executablePath = JSON.parse(fs.readFileSync(path.join(root, RECEIPT_BROWSER), "utf8")).executablePath; } catch {}
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath || !fs.existsSync(executablePath)) return { ready: false, root, reason: "no-chromium", revision };
  return { ready: true, root, revision, executablePath };
}

// ── install supervision ─────────────────────────────────────────────────────
// One install per process, whoever asks. Its progress is kept so every window
// polling status sees the same story.

let installing = null;      // { promise, step, error, startedAt }
let lastFailure = null;     // { error, at }

export function autoInstallEnabled(env = process.env) {
  return env.SANDBOXOS_BRAIWSER_AUTOINSTALL !== "0";
}

export function installState() {
  if (installing) return { installing: true, step: installing.step, startedAt: installing.startedAt };
  if (lastFailure) return { installing: false, failed: true, error: lastFailure.error, at: lastFailure.at };
  return { installing: false };
}

/** Start (or join) the background install. Resolves with the runtime's status. */
export function installRuntime({ root = defaultRuntimeRoot(), script = path.join(REPO, "scripts", "install-braiwser-runtime.mjs") } = {}) {
  if (installing) return installing.promise;
  const state = { step: "starting", startedAt: Date.now(), promise: null };
  lastFailure = null;
  state.promise = new Promise((resolve) => {
    const child = spawn(process.execPath, [script, root], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let tail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        try { const msg = JSON.parse(line); if (msg.step) state.step = msg.step; if (msg.error) tail = msg.error; } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-600); });
    const done = (error) => {
      installing = null;
      const status = inspectRuntime(root);
      if (!status.ready) lastFailure = { error: error || tail.trim() || "install did not finish", at: Date.now() };
      resolve(status);
    };
    child.on("error", (e) => done(e.message));
    child.on("exit", (code) => done(code === 0 ? null : (tail.trim() || `installer exited with ${code}`)));
  });
  installing = state;
  return state.promise;
}

// ── loading the driver ──────────────────────────────────────────────────────

let warnedNoSandbox = false;

/**
 * Braiwser's Playwright driver, loaded from the installed runtime, configured for a
 * server: headless, a standard user agent (headless Chromium's own is refused by
 * many sites), and service workers blocked — their requests would bypass the
 * per-request destination policy the session installs.
 */
export function loadDriver(status = inspectRuntime()) {
  if (!status.ready) throw Object.assign(new Error(`Braiwser runtime is not installed (${status.reason})`), { code: "BRAIWSER_UNAVAILABLE" });
  const req = createRequire(path.join(status.root, "package.json"));
  const { createPlaywrightDriver } = req(`./${pin.driver}`);
  const real = req("playwright-core");
  const chromium = {
    launch: async (options) => {
      let browser;
      try {
        browser = await real.chromium.launch(options);
      } catch (e) {
        // Many Linux hosts (Ubuntu 23.10+ AppArmor, unprivileged containers) do not let
        // Chromium build its own sandbox. Playwright's own default is to run without it;
        // do that rather than leave the Browser unable to start, and say so once.
        if (!options?.chromiumSandbox || !/sandbox/i.test(String(e?.message))) throw e;
        if (!warnedNoSandbox) {
          warnedNoSandbox = true;
          console.warn("braiwser: this host cannot run Chromium's own sandbox; running without it (set SANDBOXOS_BRAIWSER_NO_SANDBOX=1 to say so explicitly)");
        }
        browser = await real.chromium.launch({ ...options, chromiumSandbox: false, args: [...(options.args ?? []), "--disable-dev-shm-usage"] });
      }
      const newContext = browser.newContext.bind(browser);
      browser.newContext = (o = {}) => newContext({ ...o, serviceWorkers: "block" });
      return browser;
    },
  };
  // Chromium cannot build its own sandbox as root inside a container; there the
  // container is the boundary, and the operator says so explicitly.
  const chromiumSandbox = process.env.SANDBOXOS_BRAIWSER_NO_SANDBOX !== "1"
    && !(typeof process.getuid === "function" && process.getuid() === 0);
  return createPlaywrightDriver({
    playwright: { ...real, chromium }, executablePath: status.executablePath,
    standardUserAgent: true, chromiumSandbox, navigationTimeoutMs: 20000,
  });
}
