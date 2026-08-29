// core.js — the small runtime every panel is built on.
//
// No framework. What a UI of this size actually needs is four things: a typed
// way to talk to the Gateway, a place to keep shared state, a way to build DOM
// without string-concatenating HTML, and a consistent set of overlays. That is
// all this file is.

export const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean)[0] ?? "");

// ── DOM ──────────────────────────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. `h("div.card", { onclick }, "text", child)`.
 * The tag accepts `tag#id.class.class` shorthand; props starting with `on` are
 * listeners, everything else is an attribute (except `class`, `style`, `html`).
 */
export function h(spec, props = null, ...children) {
  const [, tag = "div", id, cls] = spec.match(/^([a-z0-9-]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i) ?? [];
  const el = document.createElement(tag || "div");
  if (id) el.id = id;
  if (cls) el.className = cls.slice(1).split(".").join(" ");

  // The second argument is props only when it is a plain object. Anything else —
  // a string, a number, a node, an array — is the first child. (Getting this
  // wrong silently swallows numeric children, which is a miserable bug to find.)
  const isProps = props !== null && typeof props === "object" && !props.nodeType && !Array.isArray(props);
  if (!isProps) {
    if (props !== null && props !== undefined) children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = [el.className, v].filter(Boolean).join(" ");
    else if (k === "style") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

/** An <svg><use href="#i-name"> icon. */
export function icon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const fill = (el, ...children) => { clear(el); add(el, children); return el; };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Event bus ────────────────────────────────────────────────────────────────

const _bus = new EventTarget();
export const bus = {
  on: (name, fn) => { _bus.addEventListener(name, fn); return () => _bus.removeEventListener(name, fn); },
  emit: (name, detail) => _bus.dispatchEvent(new CustomEvent(name, { detail })),
};

// ── Shared state ─────────────────────────────────────────────────────────────

/** Anything a panel might need to know about the machine it is looking at. */
export const state = {
  slug,
  cell: "connecting",
  backend: null,
  user: null,
  tenant: null,
  profile: null,
  sandboxes: [],
  servers: [],       // enabled MCP servers
  capabilities: [],  // capability patterns this session holds
  procs: [],
  ports: [],
};

export function setState(patch) {
  Object.assign(state, patch);
  bus.emit("state", patch);
}

// ── API ──────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = "ApiError"; this.status = status; }
}

async function json(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(data?.error ?? text?.slice(0, 200) ?? res.statusText, res.status);
  return data;
}

export const api = {
  /** One raw MCP call. Throws on transport failure; returns the Kernel envelope. */
  async mcp(server, tool, args = {}) {
    const res = await fetch(`/${slug}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, tool, args }),
    });
    const env = await json(res);
    if (!env.ok) throw new ApiError(env.error ?? `${server}.${tool} failed`, 200);
    return env.result;
  },

  /** MCP call that returns null instead of throwing — for optional/probing calls. */
  async tryMcp(server, tool, args = {}) {
    try { return await api.mcp(server, tool, args); } catch { return null; }
  },

  get: (path) => fetch(path.startsWith("/") ? path : `/${slug}/${path}`).then(json),
  post: (path, body) => fetch(path.startsWith("/") ? path : `/${slug}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  }).then(json),
  del: (path) => fetch(path.startsWith("/") ? path : `/${slug}/${path}`, { method: "DELETE" }).then(json),

  /** Download a file's bytes from the Cell. */
  fileUrl: (p, download) => `/${slug}/file?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`,
  async readFile(p) {
    const res = await fetch(api.fileUrl(p));
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? res.statusText, res.status);
    return res.text();
  },
  async uploadFile(p, blob) {
    const res = await fetch(api.fileUrl(p), { method: "PUT", body: blob });
    return json(res);
  },
};

// ── Formatting ───────────────────────────────────────────────────────────────

export function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "—");

export function fmtAgo(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

/** Split a path into its trail: [{name, path}] including the root. */
export function pathTrail(p) {
  const parts = String(p ?? "").split("/").filter((x) => x && x !== ".");
  const out = [{ name: "/", path: "." }];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ name: part, path: acc });
  }
  return out;
}

export const dirname = (p) => {
  const i = String(p).lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i) || ".";
};
export const basename = (p) => String(p).split("/").filter(Boolean).pop() ?? "";
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i).toLowerCase();
};

// ── Toasts ───────────────────────────────────────────────────────────────────

export function toast(title, { body, kind = "", timeout = 4500 } = {}) {
  const host = $("#toasts");
  if (!host) return;
  const el = h("div.toast", { class: kind },
    h("div.msg", h("strong", title), body ? h("span", body) : null),
    h("button.x", { onclick: () => el.remove(), title: "Dismiss" }, "✕"),
  );
  host.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

export const toastError = (title, err) =>
  toast(title, { body: err?.message ?? String(err ?? ""), kind: "err", timeout: 8000 });

// ── Overlays: dialogs, prompts, menus ────────────────────────────────────────

/**
 * Show a modal. `fields` renders a small form; the resolved value is a
 * {name: value} object, or null when dismissed.
 */
export function dialog({ title, message, fields = [], confirmLabel = "OK", danger = false, wide = false, render }) {
  return new Promise((resolve) => {
    const inputs = new Map();
    const body = h("div.body");
    if (message) body.append(h("p", message));
    if (render) body.append(render());
    for (const f of fields) {
      const input = f.type === "textarea"
        ? h("textarea", { rows: f.rows ?? 4, placeholder: f.placeholder ?? "" })
        : f.type === "select"
          ? h("select", null, ...(f.options ?? []).map((o) =>
              h("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)))
          : h("input", { type: f.type ?? "text", placeholder: f.placeholder ?? "", value: f.value ?? "" });
      if (f.value != null && f.type !== "select") input.value = f.value;
      inputs.set(f.name, input);
      body.append(h("div.field", null, h("label", f.label ?? f.name), input, f.hint ? h("span.dim", { style: { fontSize: "var(--fs-xs)" } }, f.hint) : null));
    }

    const close = (value) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const submit = () => {
      const out = {};
      for (const [name, input] of inputs) out[name] = input.value;
      close(fields.length ? out : true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault(); submit();
      }
    };

    const box = h("div.dialog", { class: wide ? "wide" : "" },
      h("h2", title),
      body,
      h("div.actions", null,
        h("button.ghost", { onclick: () => close(null) }, "Cancel"),
        h("button", { class: danger ? "danger" : "", onclick: submit }, confirmLabel),
      ),
    );
    const backdrop = h("div.backdrop.center", { onmousedown: (e) => { if (e.target === backdrop) close(null); } }, box);
    $("#overlays").append(backdrop);
    document.addEventListener("keydown", onKey);
    (inputs.values().next().value ?? box.querySelector("button:not(.ghost)"))?.focus();
  });
}

export const confirmDialog = (title, message, { confirmLabel = "Confirm", danger = true } = {}) =>
  dialog({ title, message, confirmLabel, danger }).then((v) => v === true);

/** A context menu anchored to an element or a {x,y} point. */
export function menu(anchor, items) {
  const el = h("div.menu");
  for (const it of items) {
    if (it === "-") { el.append(h("div.menu-sep")); continue; }
    el.append(h("button.menu-item", {
      class: it.danger ? "danger" : "",
      disabled: it.disabled,
      onclick: () => { close(); it.run?.(); },
    }, it.icon ? icon(it.icon) : null, h("span", it.label), it.key ? h("span.k", it.key) : null));
  }
  const close = () => { el.remove(); document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onEsc); };
  const onDoc = (e) => { if (!el.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };

  document.body.append(el);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.min(r.left, window.innerWidth - box.width - 8)}px`;
  el.style.top = `${Math.min(r.bottom + 4, window.innerHeight - box.height - 8)}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onEsc);
  });
  return close;
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function emptyState(glyph, title, message, action) {
  return h("div.empty", null,
    h("div.glyph", glyph),
    h("h3", title),
    message ? h("p", message) : null,
    action ? h("button.ghost", { onclick: action.run }, action.label) : null,
  );
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
export const mod = isMac ? "⌘" : "Ctrl";
