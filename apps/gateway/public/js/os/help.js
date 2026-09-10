// help.js — the manual, as an app. goal.md T5.2.
//
// Two halves, one search box.
//
// The **manual** is the repository's own documentation, fetched from
// `/:slug/os/manual` and rendered here. Nothing is copied: if a sentence in this
// window is wrong, `docs/…` is wrong, and one edit fixes both. Documentation
// that ships with the distro cannot drift from the build.
//
// The **catalogue** is `kernel.tools` — every tool of every enabled server on
// *this* machine, with its description and the arguments it takes, read live. A
// custom app's companion server appears in it the moment it is switched on, and
// a server that is off is simply not there, because the catalogue is the
// machine's answer rather than a list someone maintained.
//
// Every tool has a **Try it**, which fills Spotlight with its name. That is the
// point of the button: the manual hands you to the thing that runs it, in the
// place you would have reached for anyway, instead of running something on your
// behalf that you did not read first.

import { h, fill, icon, api, slug, toast, toastError } from "../core.js";

// ── a very small markdown renderer ──────────────────────────────────────────
//
// Deliberately small: headings, paragraphs, lists, tables, fenced code, inline
// code, emphasis, links and rules. It renders our own docs, not the internet's,
// and everything it emits is built with `textContent`, so a document can never
// become markup here.

const inline = (text) => {
  const out = [];
  // `code` first: nothing inside a span of code is markup.
  const parts = String(text).split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      out.push(h("code", part.slice(1, -1)));
      continue;
    }
    // Links, then bold, then italic — one pass each, left to right.
    let rest = part;
    const push = (s) => { if (s) out.push(document.createTextNode(s)); };
    const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(?<![*\w])\*([^*]+)\*(?!\w)/g;
    let last = 0, m;
    while ((m = re.exec(rest))) {
      push(rest.slice(last, m.index));
      if (m[1]) {
        const href = m[2];
        // Only outward links are clickable. A relative link into the repo has
        // nowhere to go from a browser, so it reads as text.
        out.push(/^https?:/.test(href)
          ? h("a", { href, target: "_blank", rel: "noreferrer noopener" }, m[1])
          : h("span.md-ref", m[1]));
      } else if (m[3]) out.push(h("b", m[3]));
      else if (m[4]) out.push(h("i", m[4]));
      last = m.index + m[0].length;
    }
    push(rest.slice(last));
  }
  return out;
};

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function renderMarkdown(text) {
  const nodes = [];
  // Normalise the line ending first. A file checked out on Windows arrives with
  // CRLF, and every `$`-anchored rule below would then miss by one character —
  // which is not a rendering glitch but a hang, because a line that matches
  // nothing is a line the loop never consumes.
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let list = null;
  const endList = () => { if (list) { nodes.push(list); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      endList();
      const lang = line.replace(/^\s*```/, "").trim();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      nodes.push(h("pre.md-code", { "data-lang": lang || null }, h("code", body.join("\n"))));
      continue;
    }

    const head = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (head) {
      endList();
      const level = Math.min(head[1].length, 4);
      nodes.push(h(`h${level}.md-h`, { id: `md-${slugify(head[2])}` }, ...inline(head[2])));
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) { endList(); nodes.push(h("hr.md-rule")); i += 1; continue; }

    // A table: a header row, a separator of dashes, then rows.
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      endList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      nodes.push(h("div.md-table-wrap", null, h("table.md-table", null,
        h("thead", null, h("tr", null, ...header.map((c) => h("th", null, ...inline(c))))),
        h("tbody", null, ...rows.map((r) => h("tr", null, ...r.map((c) => h("td", null, ...inline(c)))))))));
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const want = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== want) { endList(); list = h(`${want}.md-list`); }
      list.append(h("li", null, ...inline(bullet ? bullet[1] : numbered[2])));
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      endList();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      nodes.push(h("blockquote.md-quote", null, ...inline(quote.join(" "))));
      continue;
    }

    if (!line.trim()) { endList(); i += 1; continue; }

    // A paragraph runs until a blank line or something that starts a block.
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    endList();
    // A line that started a paragraph and then matched a block rule on its own
    // first pass would leave `para` empty and `i` where it was. Belt and braces:
    // take the line as text and move on. A renderer that can freeze the window it
    // is drawing into is worse than one that renders a line plainly.
    if (!para.length) { nodes.push(h("p.md-p", null, ...inline(line))); i += 1; continue; }
    nodes.push(h("p.md-p", null, ...inline(para.join(" "))));
  }
  endList();
  return nodes;
}

// ── the app ─────────────────────────────────────────────────────────────────

/** The arguments a tool takes, from its own schema — required ones first. */
function fields(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(props)
    .map(([name, spec]) => ({
      name,
      required: required.has(name),
      type: Array.isArray(spec?.type) ? spec.type.join(" | ") : (spec?.type ?? (spec?.enum ? "enum" : "any")),
      enumOf: spec?.enum ?? null,
      description: spec?.description ?? "",
    }))
    .sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));
}

/** A skeleton call for a tool: the required arguments, with empty values. */
function sampleArgs(schema) {
  const out = {};
  for (const f of fields(schema).filter((x) => x.required)) {
    out[f.name] = f.enumOf ? f.enumOf[0]
      : f.type.includes("number") ? 0
        : f.type.includes("boolean") ? false
          : f.type.includes("array") ? []
            : f.type.includes("object") ? {} : "";
  }
  return out;
}

const help = {
  mount(host, win, ctx) {
    let pages = [];
    let headings = [];
    let tools = [];
    let servers = [];
    let error = null;
    let query = win.props?.q ?? "";
    let view = win.props?.page ? { kind: "page", id: win.props.page } : { kind: "welcome" };
    const pageCache = new Map();

    // The search box is the app's main control, so it takes the room the bar has
    // rather than a fixed 90px that truncates its own placeholder.
    const search = h("input.ops-search.grow", { value: query, placeholder: "Search the manual and every tool" });
    const listEl = h("div.ops-list.help-list");
    const paneEl = h("div.ops-pane.help-pane");
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => { view = { kind: "welcome" }; save(); paint(); } }, icon("apps", 12), "Contents"),
      search,
      h("span.spacer"),
      h("button.app-btn", { title: "Every tool on this machine", onclick: () => { view = { kind: "tools" }; save(); paint(); } }, icon("play", 12), "Tools"),
    );
    fill(host, h("div.app", null, bar, h("div.app-body.ops-split", null, listEl, paneEl)));

    const save = () => api.mcp("desktop", "windowSet", {
      id: win.id, props: { q: query, page: view.kind === "page" ? view.id : null },
    }).catch(() => {});

    search.addEventListener("input", () => { query = search.value; paint(); });

    async function load() {
      try {
        const [manual, catalog] = await Promise.all([
          fetch(`/${slug}/os/manual`, { headers: { accept: "application/json" } }).then((r) => r.json()),
          api.mcp("kernel", "tools", {}),
        ]);
        if (!manual.ok) throw new Error(manual.error ?? "the manual could not be read");
        pages = manual.pages ?? [];
        headings = manual.headings ?? [];
        tools = catalog.tools ?? [];
        servers = catalog.servers ?? [];
        error = null;
      } catch (e) { error = e; }
      paint();
    }

    async function pageText(id) {
      if (pageCache.has(id)) return pageCache.get(id);
      const r = await fetch(`/${slug}/os/manual/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "no such page");
      pageCache.set(id, r.page);
      return r.page;
    }

    // ── the left column ───────────────────────────────────────────────────
    function paintList() {
      const q = query.trim().toLowerCase();
      if (!q) {
        fill(listEl,
          error ? h("div.ops-error", null, icon("bell", 14), h("span", error.message)) : null,
          h("div.ops-head", "The manual"),
          ...pages.map((p) => h("button.row-line.wrap", {
            class: view.kind === "page" && view.id === p.id ? "on" : "",
            onclick: () => { view = { kind: "page", id: p.id }; save(); paint(); },
          }, h("span", null, h("b", p.title), h("span.dim", ` ${p.blurb}`)),
            h("span.sz", p.present ? `${Math.round(p.bytes / 1024)}k` : "—"))),
          h("div.ops-head", `Tools · ${tools.length} on ${servers.length} servers`),
          ...servers.map((s) => {
            const n = tools.filter((t) => t.name.startsWith(`${s}.`)).length;
            return h("button.row-line", {
              class: view.kind === "server" && view.id === s ? "on" : "",
              onclick: () => { view = { kind: "server", id: s }; paint(); },
            }, h("span", null, h("b", s)), h("span.sz", `${n}`));
          }));
        return;
      }

      const hits = [
        ...headings.filter((x) => x.text.toLowerCase().includes(q)).slice(0, 24).map((x) => ({
          kind: "heading", label: x.text, sub: x.pageTitle,
          run: () => { view = { kind: "page", id: x.page, at: `md-${slugify(x.text)}` }; save(); paint(); },
        })),
        ...tools.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
          .slice(0, 40).map((t) => ({
            kind: "tool", label: t.name, sub: (t.description ?? "").slice(0, 60),
            run: () => { view = { kind: "tool", id: t.name }; paint(); },
          })),
      ];
      fill(listEl,
        h("div.ops-head", `${hits.length} match${hits.length === 1 ? "" : "es"}`),
        ...(hits.length ? hits.map((x) => h("button.row-line.wrap", { onclick: x.run },
          h("span", null, h("b", x.label), h("span.dim", ` ${x.sub}`)),
          h("span.sz", x.kind === "tool" ? "tool" : "manual")))
          : [h("div.dim.ops-none", "nothing in the manual or the catalogue says that")]));
    }

    // ── the right column ──────────────────────────────────────────────────
    function tryIt(name) {
      // Fill Spotlight rather than run it: the manual should hand you the thing,
      // not press it for you.
      if (ctx.spotlight) { ctx.spotlight(name); return; }
      toast("Press ⌘K and type the tool's name", { body: name, timeout: 3000 });
    }

    async function runIt(tool) {
      const [server, name] = tool.name.split(".");
      const needs = fields(tool.inputSchema).filter((f) => f.required);
      if (needs.length) { tryIt(tool.name); return; }
      try {
        const r = await api.mcp(server, name, {});
        toast(tool.name, { body: JSON.stringify(r).slice(0, 240), kind: "ok", timeout: 7000 });
      } catch (e) { toastError(`${tool.name} said no`, e); }
    }

    function paintTool(name) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) { fill(paneEl, h("div.dim.ops-none", `${name} is not on this machine`)); return; }
      const args = fields(tool.inputSchema);
      const [server] = tool.name.split(".");
      fill(paneEl,
        h("div.ops-pane-head", null,
          h("b", tool.name),
          h("span.dim", server),
          h("span.spacer"),
          h("button.app-btn", { onclick: () => tryIt(tool.name) }, icon("search", 12), "Try it"),
          args.some((a) => a.required)
            ? null
            : h("button.app-btn", { title: "It takes no arguments, so it can be run from here", onclick: () => runIt(tool) }, icon("play", 12), "Run"),
        ),
        h("p.md-p", tool.description || "No description — which is a bug in the server, not in you."),
        h("div.ops-head", args.length ? "Arguments" : "No arguments"),
        ...(args.length
          ? args.map((a) => h("div.kv", null,
              h("span.k", null, h("code", a.name), a.required ? h("span.req", " required") : null),
              h("span.v", null, h("span.dim", a.type), a.enumOf ? h("span.dim", ` · ${a.enumOf.join(", ")}`) : null,
                a.description ? h("div", a.description) : null)))
          : [h("div.dim", { style: { fontSize: "11px" } }, "It can be called with an empty object.")]),
        h("div.ops-head", "As a call"),
        h("pre.md-code", null, h("code", `${tool.name} ${JSON.stringify(sampleArgs(tool.inputSchema))}`)),
        h("div.dim", { style: { fontSize: "10.5px", marginTop: "8px" } },
          "Every call here is the same call an agent makes, authorized against what you hold and written to the audit log."),
      );
    }

    function paintServer(name) {
      const mine = tools.filter((t) => t.name.startsWith(`${name}.`));
      fill(paneEl,
        h("div.ops-pane-head", null, h("b", name), h("span.dim", `${mine.length} tools`)),
        ...mine.map((t) => h("button.row-line.wrap", { onclick: () => { view = { kind: "tool", id: t.name }; paint(); } },
          h("span", null, h("b", t.name.split(".")[1]), h("span.dim", ` ${(t.description ?? "").slice(0, 80)}`)),
          h("span.sz", "open"))));
    }

    async function paintPage(id, at) {
      fill(paneEl, h("div.dim.ops-none", "reading…"));
      try {
        const page = await pageText(id);
        fill(paneEl, h("article.md", null, ...renderMarkdown(page.text)),
          h("div.dim.help-source", `${page.file} — the file this build ships, not a copy of it`));
        if (at) paneEl.querySelector(`#${CSS.escape(at)}`)?.scrollIntoView({ block: "start" });
        else paneEl.scrollTop = 0;
      } catch (e) {
        fill(paneEl, h("div.ops-error", null, icon("bell", 14), h("span", e.message)));
      }
    }

    function paintWelcome() {
      fill(paneEl,
        h("h2.md-h", "The manual is the machine's own"),
        h("p.md-p", null, ...inline(
          "Everything on the left is read from this build: the pages are the files in `docs/`, and the tool list is `kernel.tools` — what this machine can actually do right now, including any companion server you switched on a minute ago.")),
        h("p.md-p", null, ...inline(
          "Search finds headings and tools together. Open a tool to see what it takes and what it does; **Try it** fills Spotlight with its name so you run it yourself, in the place you would have reached for anyway.")),
        h("div.ops-head", "Where to start"),
        ...pages.slice(0, 3).map((p) => h("button.row-line", { onclick: () => { view = { kind: "page", id: p.id }; save(); paint(); } },
          h("span", null, h("b", p.title), h("span.dim", ` ${p.blurb}`)), h("span.sz", "read"))),
        h("div.ops-head", "The shortest useful path"),
        h("ul.md-list", null,
          h("li", null, ...inline("`desktop.open` puts an app on the screen; `desktop.arrange` tidies it.")),
          h("li", null, ...inline("`proc.start` runs something that outlives the window; `proc.logs` tails it.")),
          h("li", null, ...inline("`ports.expose` makes it reachable under your slug.")),
          h("li", null, ...inline("`kernel.capabilities` says what you hold; `kernel.auditQuery` says what has been done.")),
        ));
    }

    function paint() {
      paintList();
      if (view.kind === "page") paintPage(view.id, view.at);
      else if (view.kind === "tool") paintTool(view.id);
      else if (view.kind === "server") paintServer(view.id);
      else if (view.kind === "tools") {
        fill(paneEl, h("div.ops-pane-head", null, h("b", "Every tool on this machine"), h("span.dim", `${tools.length} on ${servers.length} servers`)),
          ...tools.map((t) => h("button.row-line", { onclick: () => { view = { kind: "tool", id: t.name }; paint(); } },
            h("span", null, h("b", t.name), h("span.dim", ` ${(t.description ?? "").slice(0, 70)}`)),
            h("span.sz", "open"))));
      } else paintWelcome();
    }

    load();
    return () => {};
  },
};

export const HELP_APP = { help };
