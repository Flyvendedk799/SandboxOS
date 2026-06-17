// The `fs` core MCP server — filesystem as tools.
//
// Operates on the Cell's host-side volume root. Every path is resolved *within*
// the root; attempts to escape (via .. or absolute paths) are rejected. This is a
// core server: its interface (read/write/list/stat) is the contract — the backing
// store could later be an object store or Tide objects without callers changing.

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/** Resolve a Sandbox-relative path safely inside the volume root.
 *
 *  LEXICAL guard only: rejects `..`/absolute escapes via string math. This is the
 *  first gate, but on its own it is insufficient — a symlink living *inside* the
 *  volume can point outside it, and lexical resolution never follows links. The
 *  canonicalizing guards below (canonicalContained / canonicalLeafContained) are
 *  what actually enforce containment for real I/O. (Backlog item #3.) */
function safeResolve(root, p) {
  const rel = p ?? ".";
  const resolved = path.resolve(root, "." + path.sep + rel.replace(/^[/\\]+/, ""));
  const normRoot = path.resolve(root);
  if (resolved !== normRoot && !resolved.startsWith(normRoot + path.sep)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return resolved;
}

/** True iff canonical path `c` is the canonical root itself or nested under it.
 *  Both arguments MUST already be canonical (symlink-free) absolute paths. */
function _within(canonRoot, c) {
  return c === canonRoot || c.startsWith(canonRoot + path.sep);
}

/** Canonical (symlink-resolved) root for the volume.
 *
 *  The volume_path itself frequently lives under a symlinked ancestor (e.g. macOS
 *  `/var` → `/private/var`, `/tmp` → `/private/tmp`), so we must compare canonical
 *  target vs canonical root or legitimate in-volume paths would be misjudged as
 *  escapes. The caller guarantees the root exists (cell.ensureRunning()). */
async function _canonRoot(root) {
  return fs.realpath(path.resolve(root));
}

/** Backlog #3 — containment guard for paths that MUST already exist
 *  (read / list / stat). Canonicalizes the *whole* target with realpath (which
 *  follows every symlink component) and asserts it stays within the canonical
 *  root. An in-volume symlink pointing outside (e.g. `ln -s /etc escape`) is
 *  thereby rejected, closing the lexical-only hole. Returns the canonical path. */
async function canonicalContained(root, p) {
  const lexical = safeResolve(root, p); // lexical pre-gate (cheap, rejects obvious `..`)
  const canonRoot = await _canonRoot(root);
  const canon = await fs.realpath(lexical); // throws ENOENT if missing — correct for read/list/stat
  if (!_within(canonRoot, canon)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return canon;
}

/** Backlog #3 — containment guard for a *leaf* that may not exist yet
 *  (write / mkdir). Strategy:
 *    1. Canonicalize the PARENT dir (must exist after our mkdir) and assert it is
 *       contained — this rejects a symlinked ancestor that escapes the volume.
 *    2. If the leaf already exists, lstat it: should it be a symlink, follow it
 *       with realpath and assert the *resolved* target is still contained, so we
 *       never write *through* a symlink that escapes the root.
 *  Returns { parent, leaf, target } canonical-ish path (target = parent/leafName). */
async function canonicalLeafContained(root, p) {
  const lexical = safeResolve(root, p); // lexical pre-gate
  const canonRoot = await _canonRoot(root);
  const parent = path.dirname(lexical);
  const leafName = path.basename(lexical);

  const canonParent = await fs.realpath(parent); // parent exists (write/mkdir create it first)
  if (!_within(canonRoot, canonParent)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  const target = path.join(canonParent, leafName);

  // If the leaf is itself a symlink, refuse to let it redirect us outside the root.
  let lst = null;
  try {
    lst = await fs.lstat(target);
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // leaf simply doesn't exist yet → fine
  }
  if (lst && lst.isSymbolicLink()) {
    const canonLeaf = await fs.realpath(target);
    if (!_within(canonRoot, canonLeaf)) {
      throw new Error(`path escapes sandbox: ${p}`);
    }
  }
  return { parent: canonParent, leaf: leafName, target };
}

export function fsServer(cell) {
  return {
    name: "fs",
    tools: {
      list: {
        description: "List directory entries at a Sandbox path.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // #3: canonicalize + assert containment (follows symlinks, blocks escapes).
          const dir = await canonicalContained(cell.root, args.path ?? ".");
          const entries = await fs.readdir(dir, { withFileTypes: true });
          return {
            path: args.path ?? ".",
            entries: entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
            })),
          };
        },
      },
      read: {
        description: "Read a UTF-8 text file from the Sandbox.",
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // #3: canonicalize + assert containment before opening (no symlink escape).
          const file = await canonicalContained(cell.root, args.path);
          const content = await fs.readFile(file, "utf8");
          return { path: args.path, content };
        },
      },
      write: {
        description: "Write a UTF-8 text file in the Sandbox (creating parent dirs).",
        inputSchema: {
          type: "object", required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // Lexical pre-gate first so an obviously-escaping path never causes mkdir.
          const lexical = safeResolve(cell.root, args.path);
          await fs.mkdir(path.dirname(lexical), { recursive: true });
          // #3: canonicalize parent + reject a symlinked leaf that escapes the root.
          const { target } = await canonicalLeafContained(cell.root, args.path);
          // O_NOFOLLOW on the leaf: if the final component is a symlink, the open
          // fails (ELOOP) rather than writing *through* it — belt-and-braces with
          // the lstat check above against TOCTOU on the final component.
          const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
          const fh = await fs.open(target, flags, 0o644);
          try {
            await fh.writeFile(args.content ?? "", "utf8");
          } finally {
            await fh.close();
          }
          return { path: args.path, bytes: Buffer.byteLength(args.content ?? "") };
        },
      },
      stat: {
        description: "Stat a Sandbox path.",
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // #3: canonicalize + assert containment (target must exist to stat it).
          const target = await canonicalContained(cell.root, args.path);
          const st = await fs.stat(target);
          return {
            path: args.path,
            type: st.isDirectory() ? "dir" : "file",
            size: st.size,
            mtime: st.mtimeMs,
          };
        },
      },
    },
  };
}

export { safeResolve, canonicalContained, canonicalLeafContained };
