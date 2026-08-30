// frames.js — hosting code we did not write.
//
// A custom app runs in an iframe with `allow-scripts` and NOT `allow-same-origin`,
// which gives it an opaque origin: no access to our cookies, our storage, or the
// parent DOM. Its CSP forbids connect-src, so it cannot call the Gateway at all.
// Everything it wants goes through the broker below.
//
// The broker holds a machine token minted server-side for exactly the patterns
// the app declared INTERSECTED with what the person opening it holds. The frame
// never sees that token. The client-side pattern check here is a courtesy that
// gives the app a clean error instead of an audit-log denial — the real boundary
// is the Kernel, which will refuse anything outside the token's grants no matter
// what this file does.

import { h, slug } from "../core.js";

const sessions = new Map(); // appId → Promise<{token, patterns, withheld}>
const frames = new Set();   // {id, kind, el, onTitle, onResize, onClose}

export function appSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, fetch(`/${slug}/os/apps/${encodeURIComponent(id)}/session`, { method: "POST" })
      .then((r) => r.json())
      .then((r) => (r.ok ? r : { token: null, patterns: [], withheld: [] }))
      .catch(() => ({ token: null, patterns: [], withheld: [] })));
  }
  return sessions.get(id);
}

/** Forget a session — after an app's permissions change, or it is removed. */
export function dropSession(id) { sessions.delete(id); }

const covers = (held, wanted) => {
  if (held === "*" || held === wanted) return true;
  const [hs, ht] = held.split(".");
  const [ws, wt] = wanted.split(".");
  return hs === ws && (ht === "*" || ht === wt);
};

/**
 * Create a frame for a custom app or widget.
 * @param opts.id      app id / widget kind
 * @param opts.kind    "app" | "widget"
 * @param opts.onTitle called when the app renames its own window
 * @param opts.onResize called when the app asks for a size
 * @param opts.onClose  called when the app closes itself
 */
export function createFrame({ id, kind = "app", onTitle, onResize, onClose }) {
  const path = kind === "widget" ? "widgets" : "apps";
  const frame = h("iframe", {
    src: `/${slug}/os/${path}/${encodeURIComponent(id)}/`,
    sandbox: "allow-scripts allow-forms allow-popups allow-modals",
    referrerpolicy: "no-referrer",
    title: id,
  });
  // Registered by ELEMENT, not by contentWindow: an app's first message can beat
  // the iframe's load event, and a frame whose very first call is dropped as
  // "not one of ours" is a bug that only shows up on fast machines.
  frames.add({ id, kind, el: frame, onTitle, onResize, onClose });
  appSession(id); // warm the token before the first call
  return frame;
}

/** Which registered frame sent this message, if any. */
function frameFor(source) {
  for (const entry of frames) {
    if (entry.el.contentWindow === source) return entry;
  }
  return null;
}

export function destroyFrame(frame) {
  for (const entry of frames) if (entry.el === frame) frames.delete(entry);
  frame?.remove();
}

/**
 * Reload every frame running a given app or widget. Called when its source
 * changes — which is how "the agent just rewrote my app" becomes something you
 * see rather than something you have to go and refresh.
 */
export function reloadFramesFor(id) {
  if (!id) return;
  dropSession(id); // its permissions may have changed with its definition
  for (const entry of frames) {
    if (entry.id !== id) continue;
    const el = entry.el;
    // Re-assigning src with a cache-buster is the only reliable reload for an
    // opaque-origin frame: we cannot reach into it to call location.reload().
    const base = el.src.split("#")[0].replace(/([?&])r=\d+/, "");
    el.src = `${base}${base.includes("?") ? "&" : "?"}r=${Date.now()}`;
    delete el.dataset.ready;
  }
}

/** Push an event into every live frame (theme changes, focus). */
export function broadcast(event, detail) {
  for (const entry of frames) {
    try { entry.el.contentWindow?.postMessage({ __sbx: 1, id: "event", type: "event", event, detail }, "*"); }
    catch { /* frame gone */ }
  }
}

let started = false;

/** Start the broker. Idempotent; both the OS and the Studio call it. */
export function startBroker({ notify, closeWindowForFrame } = {}) {
  if (started) return;
  started = true;

  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || m.__sbx !== 1) return;
    const entry = frameFor(e.source);
    if (!entry) return; // not one of ours — ignore silently

    const reply = (payload) => {
      if (!m.id) return;
      try { e.source.postMessage({ __sbx: 1, id: m.id, ...payload }, "*"); } catch { /* frame gone */ }
    };

    // An app may only ever speak for itself: the message must name the frame we
    // registered, not a neighbour it would rather be.
    if (m.app && m.app !== entry.id) return reply({ ok: false, error: "identity mismatch" });

    const session = await appSession(entry.id);

    switch (m.type) {
      case "ready":
        entry.el.dataset.ready = "1";
        return;

      case "permissions":
        return reply({ ok: true, result: { patterns: session.patterns ?? [], withheld: session.withheld ?? [] } });

      case "mcp": {
        const target = `${m.server}.${m.tool}`;
        if (!session.token || !(session.patterns ?? []).some((p) => covers(p, target))) {
          return reply({ ok: false, code: "denied", error: `${entry.id} was not granted ${target}` });
        }
        try {
          const res = await fetch(`/${slug}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
            body: JSON.stringify({ server: m.server, tool: m.tool, args: m.args ?? {} }),
          });
          const env = await res.json();
          return reply(env.ok
            ? { ok: true, result: env.result }
            : { ok: false, code: env.code, error: env.error });
        } catch (err) {
          return reply({ ok: false, error: err.message });
        }
      }

      case "title":
        entry.onTitle?.(String(m.title ?? "").slice(0, 120));
        return reply({ ok: true, result: true });

      case "resize":
        entry.onResize?.(Number(m.w) || null, Number(m.h) || null);
        return reply({ ok: true, result: true });

      case "close":
        (entry.onClose ?? closeWindowForFrame)?.(entry);
        return reply({ ok: true, result: true });

      case "notify":
        await notify?.({ title: m.title, body: m.body, kind: m.noteKind, app: entry.id });
        return reply({ ok: true, result: true });

      default:
        return reply({ ok: false, error: `unknown request: ${m.type}` });
    }
  });
}

