// Tide — the live-mirror daemon. Keeps a local working dir and a Sandbox workspace
// in lockstep: local edits are marked + pushed; remote marks are pulled + checked
// out. Divergence resolves via the client's 3-way merge. This is "edit on your
// laptop and it appears in your Sandbox, with full history" (docs/05).

import fs from "node:fs";
import { IGNORE } from "./objects.js";

function isIgnored(name) {
  if (!name) return false;
  const parts = String(name).split(/[/\\]/);
  return parts.some((p) => IGNORE.has(p) || p.startsWith(".tide"));
}

export async function runDaemon({ client, repo, workspace, dir, intervalMs = 2000, log = console.error }) {
  let busy = false, queued = false, stopped = false;
  let poll = null, debounce = null, watcher = null;

  async function sync() {
    if (stopped) return;
    if (busy) { queued = true; return; }
    busy = true;
    try {
      if (repo.status(workspace).length) repo.mark(workspace, { message: "live", author: "tide" });
      let r = await client.push(repo, workspace);
      if (r && r.applied === false && r.reason === "non-fast-forward") {
        await client.pull(repo, workspace);     // merge divergence locally
        r = await client.push(repo, workspace); // then fast-forward
      }
      await client.pull(repo, workspace);        // adopt any remote marks
    } catch (e) {
      log("tide sync error:", e.message);
    } finally {
      busy = false;
      if (!stopped && queued) {
        queued = false;
        setTimeout(sync, 50);
      }
    }
  }

  await sync();

  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (stopped) return;
      if (isIgnored(name)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (!stopped) sync(); }, 400);
    });
    watcher.on?.("error", (e) => {
      log("tide watcher error:", e.message);
    });
  } catch (err) {
    log("tide watcher unavailable, falling back to interval polling:", err.message);
  }

  poll = setInterval(() => { if (!stopped) sync(); }, intervalMs);
  log(`tide live · ${dir} ⇌ ${client.slug}/${workspace}  (ctrl-c to stop)`);

  return {
    sync,
    isRunning: () => !stopped,
    stop() {
      stopped = true;
      if (watcher) { try { watcher.close(); } catch {} }
      if (poll) clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    },
  };
}
