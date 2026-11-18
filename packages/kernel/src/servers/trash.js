import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const trashFolder = ".sandboxos-trash";

// Each entry owns its metadata and payload. Renaming an entry into Trash stays
// on the volume's filesystem and also works for directories and symbolic links.
export function trashTools(cell, canonicalContained, safeResolve) {
  async function root() {
    await cell.ensureRunning();
    const volume = await fs.realpath(cell.root);
    const dir = path.join(volume, trashFolder);
    try { await fs.mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    if ((await fs.realpath(dir)) !== dir) throw new Error("Invalid Trash directory");
    return dir;
  }
  function relative(value) {
    if (typeof value !== "string") throw new Error("A file or folder is required");
    const rel = path.relative(cell.root, safeResolve(cell.root, value));
    if (!rel || rel.split(path.sep)[0] === trashFolder) throw new Error("Choose an item outside Trash");
    return rel;
  }
  async function metadata(dir, id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error("Invalid Trash entry");
    const entry = path.join(dir, id);
    if ((await fs.realpath(entry)) !== entry) throw new Error("Invalid Trash entry");
    const file = path.join(entry, "info.json");
    if (!(await fs.lstat(file)).isFile()) throw new Error("Invalid Trash metadata");
    const info = JSON.parse(await fs.readFile(file, "utf8"));
    return { id, path: relative(info.path), deletedAt: info.deletedAt };
  }
  const schema = key => ({ type: "object", required: [key], properties: { [key]: { type: "string" } } });
  // Serialize restores of duplicate paths within this Cell.
  let restoring = Promise.resolve();
  async function restore(id) {
    const dir = await root();
    const info = await metadata(dir, id);
    const parentPath = path.dirname(info.path);
    // Recreate a missing parent one component at a time under its verified parent.
    let parent = await fs.realpath(cell.root);
    let walked = ".";
    for (const part of parentPath.split(path.sep).filter(p => p !== ".")) {
      const next = path.join(parent, part);
      try { await fs.mkdir(next); } catch (e) { if (e.code !== "EEXIST") throw e; }
      walked = path.join(walked, part);
      parent = await canonicalContained(cell.root, walked);
      if (parent === dir || parent.startsWith(dir + path.sep)) throw new Error("Invalid restore destination");
    }
    const dest = path.join(parent, path.basename(info.path));
    const entry = path.join(dir, id);
    const payload = path.join(entry, "item");
    const item = await fs.lstat(payload);
    try {
      if (item.isDirectory()) {
        // Reserve the destination before renaming. A competing create loses
        // mkdir, and rename refuses a directory that acquired children.
        await fs.mkdir(dest);
        try { await fs.rename(payload, dest); }
        catch (err) { await fs.rmdir(dest).catch(() => {}); throw err; }
      } else {
        // link creates the destination exclusively, including for a symlink.
        await fs.link(payload, dest);
      }
    } catch (err) {
      if (err.code === "EEXIST") throw new Error("That path is occupied. Rename the existing item before restoring.");
      throw err;
    }
    await fs.rm(entry, { recursive: true, force: true });
    return info;
  }
  return {
    trash: { description: "Move a file or folder to Trash.", inputSchema: schema("path"), async handler(_, args) {
      const dir = await root();
      const rel = relative(args.path);
      const parent = await canonicalContained(cell.root, path.dirname(rel));
      const source = path.join(parent, path.basename(rel));
      if (source === dir || source.startsWith(dir + path.sep)) throw new Error("Choose an item outside Trash");
      const info = { id: randomUUID(), path: rel, deletedAt: Date.now() };
      const entry = path.join(dir, info.id);
      await fs.mkdir(entry);
      try {
        await fs.writeFile(path.join(entry, "info.json"), JSON.stringify(info), { flag: "wx" });
        await fs.rename(source, path.join(entry, "item"));
      } catch (e) { await fs.rm(entry, { recursive: true, force: true }); throw e; }
      return info;
    } },
    trashList: { description: "List recoverable items and their original paths.", inputSchema: { type: "object", properties: {} }, async handler() {
      const dir = await root(), items = [];
      for (const id of await fs.readdir(dir)) {
        if (!/^[a-f\d-]{36}$/.test(id)) continue;
        try {
          const info = await metadata(dir, id);
          await fs.lstat(path.join(dir, id, "item"));
          items.push(info);
        } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      return { items: items.sort((a, b) => b.deletedAt - a.deletedAt) };
    } },
    restore: { description: "Restore a Trash entry to its original folder.", inputSchema: schema("id"), handler(_, { id }) {
      const result = restoring.then(() => restore(id));
      restoring = result.catch(() => {});
      return result;
    } },
  };
}
