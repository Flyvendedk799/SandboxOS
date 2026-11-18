// Capture entry handles during the drop event, before the browser releases them.
export async function droppedPaths(transfer) {
  const entries = Array.from(transfer.items ?? [], item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(transfer.files, file => ({ path: file.name, file }));
  const paths = [];
  async function visit(entry, parent) {
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      paths.push({ path, file });
      return;
    }
    paths.push({ path });
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await visit(child, path + "/");
    }
  }
  for (const entry of entries) await visit(entry, "");
  return paths;
}
