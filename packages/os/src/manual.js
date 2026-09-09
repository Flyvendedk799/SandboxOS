// The manual, which is the repository's own documentation — goal.md T5.2.
//
// The Help app does not carry a copy of the docs. It reads the files that ship
// with the build, so documentation cannot drift from the thing it documents: if
// a page here is wrong, the file in `docs/` is wrong, and one edit fixes both.
//
// Only these files are readable, by name, with no path joining from user input:
// a manual route that could be talked into reading `../../.env` would be a very
// well-documented hole.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The pages, in reading order. `id` is what a URL and a window prop carry;
 * `file` is repo-relative and never built from anything a caller sent.
 */
export const MANUAL_PAGES = Object.freeze([
  { id: "experience", title: "The desktop", file: "docs/15-os-experience.md",
    blurb: "What the OS is, how the document works, and every part of the shell." },
  { id: "surface", title: "Every surface", file: "docs/14-surface-map.md",
    blurb: "Each route, each server, each tool — the whole machine on one page." },
  { id: "architecture", title: "How it is built", file: "docs/02-architecture.md",
    blurb: "Gateway → Cell → Kernel, and why the seams are where they are." },
  { id: "kernel", title: "The Kernel", file: "docs/03-mcp-kernel.md",
    blurb: "Capabilities, attenuation, the audit chain: how a call is allowed." },
  { id: "security", title: "What is safe", file: "docs/09-security-model.md",
    blurb: "The threat model, in the words of someone who has to trust it." },
  { id: "distros", title: "Sharing a machine", file: "docs/08-customization-distros.md",
    blurb: "Apps, widgets, themes, distros — making one and handing it over." },
  { id: "glossary", title: "Words used here", file: "docs/01-glossary.md",
    blurb: "Sandbox, Cell, slug, distro, Tide — what each one means." },
  { id: "goal", title: "What finished means", file: "goal.md",
    blurb: "The promises this build is measured against, and how they are checked." },
]);

const byId = new Map(MANUAL_PAGES.map((p) => [p.id, p]));

/** The table of contents: ids, titles, blurbs, sizes. Never the bodies. */
export function manualIndex() {
  return MANUAL_PAGES.map((p) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(ROOT, p.file)).size; } catch { /* not shipped in this build */ }
    return { id: p.id, title: p.title, blurb: p.blurb, file: p.file, bytes, present: bytes > 0 };
  });
}

/**
 * One page, as the markdown that ships. Returns null for an unknown id — the
 * caller turns that into a 404 rather than a path.
 */
export function manualPage(id) {
  const page = byId.get(String(id));
  if (!page) return null;
  const file = path.join(ROOT, page.file);
  // Belt and braces: the id came from a fixed table, so this can only fail if
  // the table itself is wrong, and it should fail loudly if it ever is.
  if (!file.startsWith(ROOT + path.sep)) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { ...page, missing: true, text: `# ${page.title}\n\nThis build does not ship \`${page.file}\`.\n` }; }
  return { ...page, text };
}

/**
 * The headings of every page, for a search that can land you in the right part
 * of the right page. Cheap enough to build per request and always current.
 */
export function manualHeadings() {
  const out = [];
  for (const p of MANUAL_PAGES) {
    const page = manualPage(p.id);
    if (!page || page.missing) continue;
    let inFence = false;
    for (const line of page.text.split("\n")) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      out.push({ page: p.id, pageTitle: p.title, level: m[1].length, text: m[2].replace(/[`*_]/g, "") });
    }
  }
  return out;
}
