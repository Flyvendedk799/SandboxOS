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

/** Directories never worth walking for a content search or tree render. */
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "dist", "build", ".next", "__pycache__", ".venv"]);
/** Files larger than this are skipped by fs.search (they are almost never source). */
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;

/** Cheap binary sniff: a NUL byte in the first few KB means "not text". */
function looksBinary(text) {
  return text.slice(0, 4096).indexOf("\u0000") !== -1;
}

/** Translate a simple shell glob (`*`, `?`) into an anchored RegExp over a basename. */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function fsServer(cell) {
  return {
    name: "fs",
    tools: {
      list: {
        description: "List directory entries at a Sandbox path, with size and mtime.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // #3: canonicalize + assert containment (follows symlinks, blocks escapes).
          const dir = await canonicalContained(cell.root, args.path ?? ".");
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const out = [];
          for (const e of entries) {
            // stat is best-effort: a broken symlink must still be listable.
            let size = 0, mtime = 0;
            try {
              const st = await fs.lstat(path.join(dir, e.name));
              size = st.size; mtime = st.mtimeMs;
            } catch { /* broken link or racing delete — report zeroes */ }
            out.push({
              name: e.name,
              type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
              size, mtime,
            });
          }
          out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
          return { path: args.path ?? ".", entries: out };
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
      mkdir: {
        description: "Create a directory (and any missing parents) in the Sandbox.",
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const lexical = safeResolve(cell.root, args.path);
          await fs.mkdir(path.dirname(lexical), { recursive: true });
          const { target } = await canonicalLeafContained(cell.root, args.path);
          await fs.mkdir(target, { recursive: true });
          return { path: args.path, created: true };
        },
      },
      remove: {
        description: "Delete a file or directory in the Sandbox. Directories need recursive:true.",
        inputSchema: {
          type: "object", required: ["path"],
          properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          // The root itself has no contained parent, so check it before the guard runs.
          if (safeResolve(cell.root, args.path) === path.resolve(cell.root))
            throw new Error("refusing to remove the Sandbox root");
          const { target } = await canonicalLeafContained(cell.root, args.path);
          const canonRoot = await _canonRoot(cell.root);
          if (target === canonRoot) throw new Error("refusing to remove the Sandbox root");
          let st;
          try { st = await fs.lstat(target); } catch { return { path: args.path, removed: false }; }
          if (st.isDirectory() && !args.recursive) {
            const kids = await fs.readdir(target);
            if (kids.length) throw new Error(`directory not empty: ${args.path} (pass recursive:true)`);
          }
          await fs.rm(target, { recursive: !!args.recursive, force: true });
          return { path: args.path, removed: true };
        },
      },
      move: {
        description: "Move or rename a path inside the Sandbox.",
        inputSchema: {
          type: "object", required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const from = await canonicalContained(cell.root, args.from);
          const lexTo = safeResolve(cell.root, args.to);
          await fs.mkdir(path.dirname(lexTo), { recursive: true });
          const { target: to } = await canonicalLeafContained(cell.root, args.to);
          await fs.rename(from, to);
          return { from: args.from, to: args.to, moved: true };
        },
      },
      copy: {
        description: "Copy a file or directory inside the Sandbox.",
        inputSchema: {
          type: "object", required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const from = await canonicalContained(cell.root, args.from);
          const lexTo = safeResolve(cell.root, args.to);
          await fs.mkdir(path.dirname(lexTo), { recursive: true });
          const { target: to } = await canonicalLeafContained(cell.root, args.to);
          await fs.cp(from, to, { recursive: true, force: true });
          return { from: args.from, to: args.to, copied: true };
        },
      },
      append: {
        description: "Append UTF-8 text to a file in the Sandbox (creating it if absent).",
        inputSchema: {
          type: "object", required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const lexical = safeResolve(cell.root, args.path);
          await fs.mkdir(path.dirname(lexical), { recursive: true });
          const { target } = await canonicalLeafContained(cell.root, args.path);
          const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
          const fh = await fs.open(target, flags, 0o644);
          try { await fh.write(args.content ?? "", null, "utf8"); } finally { await fh.close(); }
          return { path: args.path, bytes: Buffer.byteLength(args.content ?? "") };
        },
      },
      tree: {
        description: "Walk the Sandbox filesystem and return a nested tree, bounded by depth and node count.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            depth: { type: "number", description: "Max depth (default 3)." },
            limit: { type: "number", description: "Max nodes (default 2000)." },
          },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const rootDir = await canonicalContained(cell.root, args.path ?? ".");
          const maxDepth = Math.min(Number(args.depth ?? 3), 12);
          const limit = Math.min(Number(args.limit ?? 2000), 20000);
          let count = 0;
          let truncated = false;
          const base = args.path ?? ".";

          async function walk(dir, rel, depth) {
            if (depth > maxDepth) return [];
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
            entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
            const out = [];
            for (const e of entries) {
              if (count >= limit) { truncated = true; break; }
              count += 1;
              const childRel = rel ? `${rel}/${e.name}` : e.name;
              if (e.isDirectory()) {
                out.push({ name: e.name, path: childRel, type: "dir", children: await walk(path.join(dir, e.name), childRel, depth + 1) });
              } else {
                let size = 0;
                try { size = (await fs.lstat(path.join(dir, e.name))).size; } catch { /* racing delete */ }
                out.push({ name: e.name, path: childRel, type: e.isSymbolicLink() ? "link" : "file", size });
              }
            }
            return out;
          }

          const relBase = base === "." ? "" : base.replace(/^\.?\/*/, "").replace(/\/+$/, "");
          const tree = await walk(rootDir, relBase, 1);
          return { path: base, nodes: count, truncated, tree };
        },
      },
      search: {
        description: "Search file contents under a Sandbox path and return matching lines.",
        inputSchema: {
          type: "object", required: ["query"],
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            regex: { type: "boolean", description: "Treat query as a regular expression." },
            caseSensitive: { type: "boolean" },
            include: { type: "string", description: "Only search files whose name matches this glob, e.g. *.js" },
            limit: { type: "number", description: "Max matches (default 100)." },
          },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const rootDir = await canonicalContained(cell.root, args.path ?? ".");
          const limit = Math.min(Number(args.limit ?? 100), 1000);
          const flags = args.caseSensitive ? "" : "i";
          const re = args.regex
            ? new RegExp(args.query, flags)
            : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
          const includeRe = args.include ? globToRegExp(args.include) : null;
          const matches = [];
          let scanned = 0;

          async function walk(dir, rel, depth) {
            if (matches.length >= limit || depth > 12) return;
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              if (matches.length >= limit) return;
              if (SKIP_DIRS.has(e.name)) continue;
              const childRel = rel ? `${rel}/${e.name}` : e.name;
              const abs = path.join(dir, e.name);
              if (e.isDirectory()) { await walk(abs, childRel, depth + 1); continue; }
              if (!e.isFile()) continue;
              if (includeRe && !includeRe.test(e.name)) continue;
              let st;
              try { st = await fs.stat(abs); } catch { continue; }
              if (st.size > MAX_SEARCH_BYTES) continue;
              let text;
              try { text = await fs.readFile(abs, "utf8"); } catch { continue; }
              if (looksBinary(text)) continue;
              scanned += 1;
              const lines = text.split("\n");
              for (let i = 0; i < lines.length; i += 1) {
                if (matches.length >= limit) return;
                if (re.test(lines[i])) {
                  matches.push({ path: childRel, line: i + 1, text: lines[i].slice(0, 400) });
                }
              }
            }
          }

          const base = args.path ?? ".";
          const relBase = base === "." ? "" : base.replace(/^\.?\/*/, "").replace(/\/+$/, "");
          await walk(rootDir, relBase, 1);
          return { query: args.query, scanned, matches, truncated: matches.length >= limit };
        },
      },
      readBytes: {
        description: "Read any file (including binary) as base64.",
        inputSchema: {
          type: "object", required: ["path"],
          properties: { path: { type: "string" }, maxBytes: { type: "number" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const file = await canonicalContained(cell.root, args.path);
          const max = Math.min(Number(args.maxBytes ?? 8 * 1024 * 1024), 32 * 1024 * 1024);
          const st = await fs.stat(file);
          if (st.size > max) throw new Error(`file too large: ${st.size} bytes (max ${max})`);
          const buf = await fs.readFile(file);
          return { path: args.path, bytes: buf.length, base64: buf.toString("base64") };
        },
      },
      writeBytes: {
        description: "Write a base64 payload to a file (binary-safe upload).",
        inputSchema: {
          type: "object", required: ["path", "base64"],
          properties: { path: { type: "string" }, base64: { type: "string" } },
        },
        async handler(_ctx, args) {
          await cell.ensureRunning();
          const lexical = safeResolve(cell.root, args.path);
          await fs.mkdir(path.dirname(lexical), { recursive: true });
          const { target } = await canonicalLeafContained(cell.root, args.path);
          const buf = Buffer.from(args.base64 ?? "", "base64");
          const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
          const fh = await fs.open(target, flags, 0o644);
          try { await fh.write(buf); } finally { await fh.close(); }
          return { path: args.path, bytes: buf.length };
        },
      },
    },
  };
}

export { safeResolve, canonicalContained, canonicalLeafContained };
