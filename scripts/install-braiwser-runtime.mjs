#!/usr/bin/env node
// Install the pinned Braiwser runtime the Browser app drives — never a moving branch.
//
//   node scripts/install-braiwser-runtime.mjs [target-dir]
//
// The same pin, the same layout and the same receipts as openbot's installer, so one
// runtime directory serves both. Two differences: it builds in a staging directory and
// renames it into place only once Chromium is installed, so a half-finished install is
// never mistaken for a ready one; and it prints one JSON line per step, which the
// Gateway relays to the Browser window while it sets itself up on a new machine.
//
// Needs git, npm and network access. No credential, deployment or security setting
// is changed. Pass --system-chromium to use /usr/bin/chromium instead of a download.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pin, defaultRuntimeRoot, RECEIPT_REVISION, RECEIPT_BROWSER } from "../packages/braiwser/src/runtime.js";

const say = (step, extra = {}) => process.stdout.write(`${JSON.stringify({ step, ...extra })}\n`);
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const target = path.resolve(positional[0] || defaultRuntimeRoot());
const systemChromium = process.argv.includes("--system-chromium");

if (!/^[a-f0-9]{40}$/.test(pin.revision) || pin.repository !== "https://github.com/Flyvendedk799/Braiwser.git") {
  throw new Error("invalid Braiwser runtime pin");
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = { stdio: ["ignore", "ignore", "inherit"] };

if (fs.existsSync(path.join(target, RECEIPT_REVISION))
  && fs.readFileSync(path.join(target, RECEIPT_REVISION), "utf8").trim() === pin.revision) {
  say("ready", { root: target, revision: pin.revision, already: true });
  process.exit(0);
}
if (fs.existsSync(target)) throw new Error(`${target} exists but is not a finished install of ${pin.revision}; inspect and remove it first`);

const staging = `${target}.partial-${process.pid}`;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
try {
  say("clone", { revision: pin.revision });
  git(["clone", "--quiet", "--no-checkout", "--filter=blob:none", pin.repository, staging]);
  git(["checkout", "--quiet", "--detach", pin.revision], staging);
  if (git(["rev-parse", "HEAD"], staging) !== pin.revision || git(["status", "--porcelain", "--untracked-files=no"], staging)) {
    throw new Error("runtime checkout does not match the clean pin");
  }

  say("dependencies");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Scripts stay off: nothing in a fetched tree runs at install time. Windows .cmd
  // needs a shell; the directory is passed as cwd, never interpolated into a command.
  execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: staging, ...quiet, shell: process.platform === "win32" });

  const cli = path.join(staging, "node_modules", "playwright-core", "cli.js");
  let executablePath = "/usr/bin/chromium";
  if (!systemChromium) {
    say("chromium");
    execFileSync(process.execPath, [cli, "install", "chromium"], { cwd: staging, ...quiet });
    executablePath = execFileSync(process.execPath,
      ["-e", "process.stdout.write(require('playwright-core').chromium.executablePath())"],
      { cwd: staging, encoding: "utf8" }).trim();
  }
  fs.writeFileSync(path.join(staging, RECEIPT_BROWSER), JSON.stringify({ executablePath }), { mode: 0o644 });
  // The revision receipt is written last: its presence is what "installed" means.
  fs.writeFileSync(path.join(staging, RECEIPT_REVISION), `${pin.revision}\n`, { mode: 0o644 });
  fs.renameSync(staging, target);
} catch (e) {
  fs.rmSync(staging, { recursive: true, force: true });
  say("failed", { error: String(e?.stderr || e?.message || e).trim().split("\n").slice(-3).join(" ") });
  process.exit(1);
}
say("ready", { root: target, revision: pin.revision });
