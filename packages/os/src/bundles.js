// App bundles — the files a custom app or widget is actually made of.
//
// A built-in app is drawn by code we shipped. A custom app is drawn by code the
// USER (or their agent) wrote: an index.html and whatever it pulls in. Those files
// live here, beside the Sandbox rather than inside its volume, for one reason —
// the volume is the Cell's own filesystem, and anything a process in the Cell can
// rewrite at will is the wrong place to keep the code that renders the trusted
// desktop. Writing an app is an audited MCP call, not a stray `fs.write`.
//
// Bundles are served from `/:slug/os/apps/<id>/…` under a strict CSP into a
// sandboxed iframe, so what is in here is untrusted content by construction. The
// limits below are the second half of that posture: bounded count, bounded size,
// a closed extension set, and no path that can climb out of its own directory.

import fs from "node:fs";
import path from "node:path";
import { safeRelPath } from "./schema.js";

export const BUNDLE_LIMITS = {
  fileBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024,
  files: 80,
};

/** Extension → content type. An extension that is not here cannot be stored. */
export const BUNDLE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Files whose bytes are text (and so can round-trip through JSON as strings). */
const TEXT_EXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".txt", ".md", ".svg"]);

export const isTextFile = (rel) => TEXT_EXT.has(path.extname(rel).toLowerCase());
export const bundleType = (rel) => BUNDLE_TYPES[path.extname(rel).toLowerCase()] ?? null;

/** Where a Sandbox keeps everything the OS owns (siblings of the Cell volume). */
export const osDir = (sandbox) => path.join(path.dirname(sandbox.volume_path), "os");
export const bundlesRoot = (sandbox, kind) => path.join(osDir(sandbox), kind === "widget" ? "widgets" : "apps");
export const bundleDir = (sandbox, kind, id) => path.join(bundlesRoot(sandbox, kind), id);

export class BundleError extends Error {
  constructor(message) { super(message); this.name = "BundleError"; }
}

/** Resolve a bundle-relative path to an absolute one, or throw. Traversal-proof
 *  twice over: the grammar in safeRelPath, then a realpath containment check. */
export function resolveInBundle(sandbox, kind, id, rel) {
  const clean = safeRelPath(rel);
  if (!clean) throw new BundleError(`invalid path: ${rel}`);
  if (!bundleType(clean)) throw new BundleError(`unsupported file type: ${path.extname(clean) || clean}`);
  const dir = bundleDir(sandbox, kind, id);
  const abs = path.resolve(dir, clean);
  const rooted = path.resolve(dir) + path.sep;
  if (abs !== path.resolve(dir) && !abs.startsWith(rooted)) throw new BundleError(`path escapes bundle: ${rel}`);
  return { abs, rel: clean };
}

function walk(dir, prefix = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export function listBundleFiles(sandbox, kind, id) {
  const dir = bundleDir(sandbox, kind, id);
  return walk(dir).sort().map((rel) => {
    const st = fs.statSync(path.join(dir, rel));
    return { path: rel, size: st.size, updatedAt: st.mtimeMs, type: bundleType(rel) };
  });
}

export function bundleSize(sandbox, kind, id) {
  return listBundleFiles(sandbox, kind, id).reduce((n, f) => n + f.size, 0);
}

export function readBundleFile(sandbox, kind, id, rel, { encoding = "utf8" } = {}) {
  const { abs, rel: clean } = resolveInBundle(sandbox, kind, id, rel);
  const buf = fs.readFileSync(abs);
  return { path: clean, type: bundleType(clean), bytes: buf.length, content: encoding === null ? buf : buf.toString(encoding) };
}

/**
 * Write one file into a bundle. `content` is a string (text files) or base64
 * (anything else). Limits are checked against what the bundle would become, not
 * what it is, so a write can never take it over the ceiling.
 */
export function writeBundleFile(sandbox, kind, id, rel, content, { base64 = false } = {}) {
  const { abs, rel: clean } = resolveInBundle(sandbox, kind, id, rel);
  const buf = base64 ? Buffer.from(String(content ?? ""), "base64") : Buffer.from(String(content ?? ""), "utf8");
  if (buf.length > BUNDLE_LIMITS.fileBytes) {
    throw new BundleError(`file too large: ${buf.length} bytes (max ${BUNDLE_LIMITS.fileBytes})`);
  }
  const existing = listBundleFiles(sandbox, kind, id);
  const prior = existing.find((f) => f.path === clean);
  if (!prior && existing.length >= BUNDLE_LIMITS.files) {
    throw new BundleError(`too many files in bundle (max ${BUNDLE_LIMITS.files})`);
  }
  const nextTotal = existing.reduce((n, f) => n + f.size, 0) - (prior?.size ?? 0) + buf.length;
  if (nextTotal > BUNDLE_LIMITS.totalBytes) {
    throw new BundleError(`bundle too large: ${nextTotal} bytes (max ${BUNDLE_LIMITS.totalBytes})`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { path: clean, bytes: buf.length };
}

export function removeBundleFile(sandbox, kind, id, rel) {
  const { abs, rel: clean } = resolveInBundle(sandbox, kind, id, rel);
  try { fs.unlinkSync(abs); return { path: clean, removed: true }; }
  catch { return { path: clean, removed: false }; }
}

export function removeBundle(sandbox, kind, id) {
  const dir = bundleDir(sandbox, kind, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

/** Read a whole bundle into a portable {path: {content, base64}} map (for distros). */
export function exportBundle(sandbox, kind, id) {
  const out = {};
  for (const f of listBundleFiles(sandbox, kind, id)) {
    const text = isTextFile(f.path);
    const { content } = readBundleFile(sandbox, kind, id, f.path, { encoding: text ? "utf8" : "base64" });
    out[f.path] = text ? { content } : { content, base64: true };
  }
  return out;
}

/** Write a portable bundle map back out. Replaces whatever was there. */
export function importBundle(sandbox, kind, id, files) {
  removeBundle(sandbox, kind, id);
  const written = [];
  for (const [rel, entry] of Object.entries(files ?? {})) {
    try {
      written.push(writeBundleFile(sandbox, kind, id, rel, entry?.content ?? "", { base64: !!entry?.base64 }));
    } catch { /* a bad file in an imported distro is skipped, not fatal */ }
  }
  return written;
}

/** The HTML a freshly-defined app starts life as: real, runnable, and a template
 *  the agent (or the user) edits rather than a lorem-ipsum placeholder. */
export function starterApp({ name = "New App", kind = "app" } = {}) {
  const title = String(name).replace(/[<>&]/g, "");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${title}</title>`,
    '<link rel="stylesheet" href="./app.css" />',
    "</head>",
    "<body>",
    `  <h1>${title}</h1>`,
    `  <p class="dim">A ${kind} in your OS. Everything below runs against the real machine.</p>`,
    '  <button id="run">List files</button>',
    '  <pre id="out">—</pre>',
    '  <script type="module" src="./app.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function starterAppCss() {
  return [
    ":root { color-scheme: var(--os-scheme, dark); }",
    "body {",
    "  margin: 0; padding: 16px;",
    "  font: 13px/1.5 ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif;",
    "  color: var(--os-text, #e6edf3);",
    "  background: transparent;",
    "}",
    "h1 { font-size: 15px; margin: 0 0 4px; }",
    ".dim { color: var(--os-text-2, #9fb0c0); margin: 0 0 12px; }",
    "button {",
    "  height: 28px; padding: 0 12px; border: 0; border-radius: 8px; cursor: pointer;",
    "  background: var(--os-accent, #35d6c4); color: #04211e; font-weight: 600;",
    "}",
    "pre {",
    "  margin-top: 12px; padding: 10px; border-radius: 8px; overflow: auto;",
    "  background: var(--os-chip, rgba(255,255,255,.06));",
    "  font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
    "}",
    "",
  ].join("\n");
}

export function starterAppJs() {
  return [
    "// The OS injects `sbx` into every app frame. Anything the app was granted in",
    "// its `permissions` is callable here; anything else is denied by the Kernel.",
    "const out = document.getElementById('out');",
    "document.getElementById('run').addEventListener('click', async () => {",
    "  out.textContent = 'working…';",
    "  try {",
    "    const r = await sbx.mcp('fs', 'list', { path: '.' });",
    "    out.textContent = r.entries.map((e) => (e.type === 'dir' ? e.name + '/' : e.name)).join('\\n');",
    "  } catch (err) {",
    "    out.textContent = 'error: ' + err.message;",
    "  }",
    "});",
    "sbx.ready();",
    "",
  ].join("\n");
}

export function starterWidget({ name = "New Widget" } = {}) {
  const title = String(name).replace(/[<>&]/g, "");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    "<style>",
    "  body { margin:0; padding:14px; background:transparent;",
    "    font:13px/1.5 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;",
    "    color:var(--os-text,#e6edf3); }",
    "  .label { font-size:10px; text-transform:uppercase; letter-spacing:.07em;",
    "    color:var(--os-text-3,#6b7f92); font-weight:700; }",
    "  .value { font-size:30px; font-weight:300; margin-top:8px; }",
    "</style>",
    "</head>",
    "<body>",
    `  <div class="label">${title}</div>`,
    '  <div class="value" id="v">—</div>',
    "  <script type=\"module\">",
    "    const v = document.getElementById('v');",
    "    async function tick() {",
    "      try {",
    "        const m = await sbx.mcp('metrics', 'snapshot', {});",
    "        v.textContent = Math.round((m.cpu?.load1 ?? 0) * 100) / 100;",
    "      } catch { v.textContent = '—'; }",
    "    }",
    "    tick(); setInterval(tick, 5000); sbx.ready();",
    "  </script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
