// Tide — the live-mirror daemon. Keeps a local working dir and a Sandbox workspace
// in lockstep: local edits are marked + pushed; remote marks are pulled + checked
// out. Divergence resolves via the client's 3-way merge. This is "edit on your
// laptop and it appears in your Sandbox, with full history" (docs/05).

import fs from "node:fs";

export async function runDaemon({ client, repo, workspace, dir, intervalMs = 2000, log = console.error }) {
  let busy = false, queued = false;

  async function sync() {
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
      if (queued) { queued = false; setTimeout(sync, 50); }
    }
  }

  await sync();

  let debounce = null;
  const watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
    if (name && String(name).startsWith(".tide")) return;
    clearTimeout(debounce);
    debounce = setTimeout(sync, 400);
  });
  const poll = setInterval(sync, intervalMs);
  log(`tide live · ${dir} ⇌ ${client.slug}/${workspace}  (ctrl-c to stop)`);

  return { stop() { watcher.close(); clearInterval(poll); clearTimeout(debounce); } };
}
