// Finding a browser to drive, on whatever host is running the script.
//
// The browser checks (`smoke`, `day`) need a real Chromium and playwright-core
// does not ship one. Rather than making every host set CHROME by hand, look in
// the places a Chromium actually lands: Playwright's own cache (newest build
// first, on all three platforms), then the browsers people already have.
//
// If nothing turns up, the caller gets null and can say so in one sentence
// instead of dying inside playwright with a message about `npx playwright
// install` that is only true on some hosts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

/** Playwright's download cache, newest chromium build first. */
function fromPlaywrightCache() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "ms-playwright") : null,
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright") : null,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    "/opt/pw-browsers",
  ].filter(Boolean);

  const out = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      // Newest build number wins; a full chromium is preferred over the
      // headless shell, which cannot show a window when you want to watch.
      .sort((a, b) => (Number(b.split("-")[1]) - Number(a.split("-")[1])) || (a.includes("headless") ? 1 : -1));
    for (const b of builds) {
      out.push(
        path.join(root, b, "chrome-win64", "chrome.exe"),
        path.join(root, b, "chrome-win", "chrome.exe"),
        path.join(root, b, "chrome-linux", "chrome"),
        path.join(root, b, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        path.join(root, b, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        path.join(root, b, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        path.join(root, b, "chrome-headless-shell-mac", "chrome-headless-shell"),
      );
    }
  }
  return out;
}

/** Browsers already installed on the host, per platform. */
function fromHost() {
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [
      path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(r, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/snap/bin/chromium",
  ];
}

/** The first browser this host can drive, or null. CHROME always wins. */
export function findChrome() {
  const tried = [process.env.CHROME, ...fromPlaywrightCache(), ...fromHost()].filter(Boolean);
  return tried.find(exists) ?? null;
}

/** What to tell someone when there is none — one sentence, and true here. */
export function noChromeMessage() {
  return process.platform === "win32"
    ? "no Chromium found: install Chrome, or run `npx playwright install chromium`, or set CHROME=<path to chrome.exe>"
    : "no Chromium found: install chromium/google-chrome, or run `npx playwright install chromium`, or set CHROME=<path>";
}
